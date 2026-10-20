import { describe, expect, it } from "vitest";
import { buildHeatmap, buildSearch } from "../src/builders";
import { DEFAULT_TTL_MS, createSqliteCache } from "../src/cache";
import { canonicalKey, encodeQuery } from "../src/canonical";
import { QlooHttpError } from "../src/errors";
import { KEY_PLACEHOLDER, buildCurl, ledgerParams, redactParams, redactString } from "../src/ledger";
import { TEST_KEY, liveClient, mockFetch, okFetch } from "./helpers";
import * as S from "./synthetic";

const DAY = 24 * 60 * 60 * 1000;

describe("canonical keys", () => {
  it("ignores param order and drops empty values", () => {
    const a = canonicalKey({ method: "GET", path: "/v2/insights", params: { "filter.type": "urn:heatmap", take: 5, x: undefined, y: [] } });
    const b = canonicalKey({ method: "GET", path: "/v2/insights", params: { take: 5, "filter.type": "urn:heatmap", z: null, w: "" } });
    expect(a).toBe(b);
    expect(a).toBe("GET /v2/insights?filter.type=urn:heatmap&take=5");
  });

  it("joins arrays with commas in the given order", () => {
    const k = canonicalKey({ method: "GET", path: "/entities", params: { entity_ids: ["b", "a"] } });
    expect(k).toBe("GET /entities?entity_ids=b,a");
  });

  it("encodes the query readably", () => {
    expect(encodeQuery({ "filter.location": "POINT(-86.7785 36.1612)", "filter.type": "urn:heatmap", q: "Panic! & co" })).toBe(
      "filter.location=POINT(-86.7785%2036.1612)&filter.type=urn:heatmap&q=Panic%21%20%26%20co",
    );
  });
});

describe("SQLite cache", () => {
  it("serves the second identical request from cache", async () => {
    const { fetch, calls } = okFetch(S.searchVenue);
    const { client, ledger } = liveClient(fetch);
    const first = await client.search("The Example Hall", ["place"]);
    const second = await client.search("The Example Hall", ["urn:entity:place"]);
    expect(calls).toHaveLength(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.source).toBe("cache");
    expect(second.value[0]!.entityId).toBe(S.ID.venue);
    const [e1, e2] = ledger.entries();
    expect(e1!.cacheHit).toBe(false);
    expect(e2!.cacheHit).toBe(true);
    expect(e2!.note).toContain("cache hit");
    expect(e2!.bytes).toBeGreaterThan(0);
  });

  it("expires search after 30 days and heatmaps after 7 days", async () => {
    let now = Date.parse("2026-10-13T12:00:00Z");
    const { fetch, calls } = mockFetch((c) => ({ body: c.url.pathname === "/search" ? S.searchVenue : S.heatmap }));
    const { client } = liveClient(fetch, { now: () => now });
    const heat = { signalEntities: [S.ID.actA], point: { lat: 36.1612, lon: -86.7785 }, radiusM: 40000 };
    await client.search("v", ["place"]);
    await client.heatmap(heat);
    expect(calls).toHaveLength(2);

    now += 6 * DAY;
    await client.search("v", ["place"]);
    await client.heatmap(heat);
    expect(calls).toHaveLength(2);

    now += 2 * DAY; // day 8: heatmap expired, search still fresh
    await client.search("v", ["place"]);
    await client.heatmap(heat);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.url.searchParams.get("filter.type")).toBe("urn:heatmap");

    now += 23 * DAY; // day 31: search expired
    await client.search("v", ["place"]);
    expect(calls).toHaveLength(4);
  });

  it("fresh: true skips the cache read but refreshes the row", async () => {
    const { fetch, calls } = okFetch(S.searchVenue);
    const { client } = liveClient(fetch);
    const req = buildSearch("v", ["place"]);
    await client.request(req);
    await client.request(req, { fresh: true });
    expect(calls).toHaveLength(2);
    const third = await client.request(req);
    expect(third.cacheHit).toBe(true);
  });

  it("caches a /search 404 as an empty answer", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 404, body: { error: "not found" } }));
    const { client, ledger } = liveClient(fetch);
    const r = await client.search("Nobody At All", ["artist"]);
    expect(r.status).toBe("empty");
    expect(r.value).toEqual([]);
    await client.search("Nobody At All", ["artist"]);
    expect(calls).toHaveLength(1);
    expect(ledger.entries()[0]!.envelopeStatus).toBe("empty");
  });

  it("does not cache errors", async () => {
    const { fetch, calls } = mockFetch((_c, i) => (i === 0 ? { status: 400, body: "bad" } : { body: S.heatmap }));
    const { client } = liveClient(fetch);
    const opts = { signalEntities: [S.ID.actA], point: { lat: 36.1, lon: -86.7 } };
    await expect(client.heatmap(opts)).rejects.toBeInstanceOf(QlooHttpError);
    const r = await client.heatmap(opts);
    expect(r.status).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("raw cache API: TTL per class, meta, prune", () => {
    const cache = createSqliteCache(":memory:");
    cache.set("k1", "insights", { body: "{}", status: 200 }, 0);
    expect(cache.get("k1", DEFAULT_TTL_MS.insights - 1)).not.toBeNull();
    expect(cache.get("k1", DEFAULT_TTL_MS.insights)).toBeNull();
    cache.set("k2", "search", { body: "{}", status: 200 }, 0);
    expect(cache.prune(DEFAULT_TTL_MS.insights)).toBe(1);
    cache.setMeta("m", "v");
    expect(cache.getMeta("m")).toBe("v");
    expect(cache.getMeta("nope")).toBeNull();
    cache.close();
  });
});

describe("ledger", () => {
  it("records one redacted entry per call; the key appears nowhere", async () => {
    const { fetch } = mockFetch((c) => {
      if (c.url.pathname === "/search") return { body: S.searchVenue, headers: { "x-month-ratelimit-remaining": "8000" } };
      if (c.url.pathname === "/v2/analysis/compare") return { status: 401, body: { error: `invalid key ${TEST_KEY}` } };
      return { body: S.heatmap };
    });
    const { client, ledger } = liveClient(fetch);
    await client.search("The Example Hall", ["place"], { location: { lat: 36.1612, lon: -86.7785 }, radiusMiles: 1 });
    await client.search("The Example Hall", ["place"], { location: { lat: 36.1612, lon: -86.7785 }, radiusMiles: 1 });
    await client.heatmap({ signalEntities: [S.ID.actA, S.ID.actB], point: { lat: 36.16, lon: -86.78 } });
    const err = await client.compare([S.ID.actA], [S.ID.houseA]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooHttpError);
    expect((err as QlooHttpError).bodySnippet).toContain(KEY_PLACEHOLDER);
    expect(String((err as Error).message)).not.toContain(TEST_KEY);

    const entries = ledger.entries();
    expect(entries.map((e) => e.id)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(JSON.stringify(entries)).not.toContain(TEST_KEY);
    for (const e of entries) {
      expect(e.kind).toBe("qloo");
      expect(e.curl).toContain('-H "X-Api-Key: $QLOO_API_KEY"');
      expect(e.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(e.latencyMs).toBeGreaterThanOrEqual(0);
    }
    const [search, hit, heat, failed] = entries;
    expect(search).toMatchObject({ method: "GET", endpoint: "/search", httpStatus: 200, envelopeStatus: "ok", cacheHit: false, resultCount: 1 });
    expect(search!.params).toMatchObject({ query: "The Example Hall", types: ["urn:entity:place"], "filter.location": "36.1612,-86.7785", "filter.radius": 1 });
    expect(search!.bytes).toBe(JSON.stringify(S.searchVenue).length);
    expect(search!.curl).toBe(
      'curl -sS "https://hackathon.api.qloo.com/search?filter.location=36.1612,-86.7785&filter.radius=1&query=The%20Example%20Hall&take=10&types=urn:entity:place" -H "X-Api-Key: $QLOO_API_KEY"',
    );
    expect(hit).toMatchObject({ cacheHit: true, resultCount: 1 });
    expect(heat).toMatchObject({ method: "GET", endpoint: "/v2/insights", resultCount: 5 });
    expect(heat!.params["signal.interests.entities"]).toEqual([S.ID.actA, S.ID.actB]);
    expect(heat!.curl).not.toContain("-X POST");
    expect(failed).toMatchObject({ endpoint: "/v2/analysis/compare", httpStatus: 401, envelopeStatus: "error", resultCount: 0 });
  });

  it("redacts the key before cutting an error body down to a snippet (no partial key leaks)", async () => {
    const { fetch } = mockFetch(() => ({ status: 401, body: `${"x".repeat(290)}${TEST_KEY}` }));
    const { client, ledger } = liveClient(fetch);
    const err = await client.search("x", ["place"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooHttpError);
    const prefix = TEST_KEY.slice(0, 8);
    expect((err as QlooHttpError).bodySnippet).not.toContain(prefix);
    expect((err as Error).message).not.toContain(prefix);
    expect(JSON.stringify(ledger.entries())).not.toContain(prefix);
  });

  it("redaction helpers replace the key in values, arrays and secret-named params", () => {
    expect(redactString(`a ${TEST_KEY} b`, [TEST_KEY])).toBe("a $QLOO_API_KEY b");
    expect(redactString("short", ["ab"])).toBe("short");
    expect(
      redactParams({ api_key: "whatever", q: `x${TEST_KEY}`, list: [TEST_KEY, "ok"], n: 3, nil: null }, [TEST_KEY]),
    ).toEqual({ api_key: KEY_PLACEHOLDER, q: `x${KEY_PLACEHOLDER}`, list: [KEY_PLACEHOLDER, "ok"], n: 3, nil: null });
  });

  it("ledgerParams and curl never include the key even if a caller put it in a param", () => {
    const req = buildSearch("x", ["artist"], { extra: { apikey: TEST_KEY } });
    expect(JSON.stringify(ledgerParams(req, [TEST_KEY]))).not.toContain(TEST_KEY);
    expect(buildCurl(req, "https://hackathon.api.qloo.com", [TEST_KEY])).not.toContain(TEST_KEY);
  });

  it("GET curl for a heatmap keeps WKT as POINT(lon lat)", () => {
    const req = buildHeatmap({ signalEntities: [S.ID.actA], point: { lat: 36.1612, lon: -86.7785 }, radiusM: 40000 });
    const curl = buildCurl(req, "https://hackathon.api.qloo.com");
    expect(curl).toContain("filter.location=POINT(-86.7785%2036.1612)");
    expect(curl).toContain("filter.location.radius=40000");
  });
});
