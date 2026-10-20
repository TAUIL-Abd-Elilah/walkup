import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryLedger } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import { QlooClient } from "../src/client";
import { noLimiter } from "../src/limiter";
import { toEnvelope } from "../src/envelope";
import { QlooConfigError, QlooHostRefusedError } from "../src/errors";
import { createMemoryFixtureStore } from "../src/fixtures";
import { liveClient, liveConfig, mockFetch, okFetch } from "./helpers";
import * as S from "./synthetic";

const P = { lat: 36.1612, lon: -86.7785 };

describe("client methods -> endpoints", () => {
  it("heatmap", async () => {
    const { fetch, calls } = okFetch(S.heatmap);
    const { client } = liveClient(fetch);
    const r = await client.heatmap({ signalEntities: [S.ID.actA, S.ID.actB], point: P, radiusM: 40000 });
    const q = calls[0]!.url.searchParams;
    expect(calls[0]!.url.pathname).toBe("/v2/insights");
    expect(q.get("filter.type")).toBe("urn:heatmap");
    expect(q.get("filter.location")).toBe("POINT(-86.7785 36.1612)");
    expect(q.get("filter.location.radius")).toBe("40000");
    expect(q.get("signal.interests.entities")).toBe(`${S.ID.actA},${S.ID.actB}`);
    expect(r.value).toHaveLength(4);
    expect(r.status).toBe("ok");
    // Live heatmaps have no response-level query block (no localities) and no warnings.
    expect(r.meta).toEqual({ skipped: 1 });
    expect(r.reason).toMatch(/missing/);
  });

  it("demographics", async () => {
    const { fetch, calls } = okFetch(S.demographics);
    const { client } = liveClient(fetch);
    const r = await client.demographics([S.ID.actA, S.ID.houseA]);
    expect(calls[0]!.url.searchParams.get("filter.type")).toBe("urn:demographics");
    expect(r.value.map((b) => b.entityId)).toEqual([S.ID.actA, S.ID.houseA, "urn:tag:genre:music:country"]);
  });

  it("placeInsights with explainability meta", async () => {
    const { fetch, calls } = okFetch(S.placeInsights);
    const { client } = liveClient(fetch);
    const r = await client.placeInsights({
      signalEntities: [S.ID.actA],
      point: P,
      radiusM: 2000,
      tags: ["urn:tag:category:place:bar"],
      operator: "union",
      hours: "thursday",
      priceMax: 3,
      explainability: true,
      take: 50,
    });
    const q = calls[0]!.url.searchParams;
    expect(q.get("filter.type")).toBe("urn:entity:place");
    expect(q.get("filter.hours")).toBe("thursday");
    expect(q.get("feature.explainability")).toBe("true");
    expect(q.get("operator.filter.tags")).toBe("union");
    expect(r.value[0]!.explainability![0]).toEqual({ entityId: S.ID.actA, score: 0.71 });
    expect(r.meta?.explainability).toBeDefined();
    expect(r.meta?.droppedSignals).toBeUndefined();
  });

  it("entityInsights (podcast with signal.location)", async () => {
    const { fetch, calls } = okFetch(S.placeInsights);
    const { client } = liveClient(fetch);
    await client.entityInsights("podcast", { signalEntities: [S.ID.actA], signalLocationPoint: P, take: 15 });
    const q = calls[0]!.url.searchParams;
    expect(q.get("filter.type")).toBe("urn:entity:podcast");
    expect(q.get("signal.location")).toBe("POINT(-86.7785 36.1612)");
    expect(q.get("take")).toBe("15");
  });

  it("tagProfile, compare, tagsSearch", async () => {
    const { fetch, calls } = mockFetch((c) => {
      switch (c.url.pathname) {
        case "/v2/analysis/compare":
          return { body: S.compare };
        case "/v2/tags":
          return { body: S.tagsSearch };
        default:
          return { body: S.tagProfile };
      }
    });
    const { client } = liveClient(fetch);
    const tp = await client.tagProfile({ signalEntities: [S.ID.actA], tagTypes: ["urn:tag:genre:music"], diversifyBySubtype: true, take: 30 });
    expect(tp.value[0]!.name).toBe("Americana");
    expect(calls[0]!.url.searchParams.get("diversify.by")).toBe("subtype");

    const cmp = await client.compare([S.ID.actA], [S.ID.houseA], 30);
    expect(cmp.value.a).toHaveLength(2);
    expect(cmp.status).toBe("ok");
    expect(calls[1]!.url.searchParams.get("a.signal.interests.entities")).toBe(S.ID.actA);

    const tags = await client.tagsSearch("record store", { parentsTypes: ["place"], semantic: true });
    expect(tags.value[0]!.id).toBe("urn:tag:category:place:record_store");
    expect(calls[2]!.url.searchParams.get("feature.semantic_search")).toBe("true");

    expect("audiences" in client).toBe(false);
  });

  it("compare with no tags is empty, not an error", async () => {
    const { client } = liveClient(okFetch({ results: { tags: [], a: [], b: [] } }).fetch);
    const r = await client.compare(["a"], ["b"]);
    expect(r.status).toBe("empty");
    expect(r.reason).toBeUndefined();
  });

  it("generic insights detects the result kind; unknown shapes are empty with a reason", async () => {
    const { client } = liveClient(mockFetch((_c, i) => ({ body: i === 0 ? S.placeInsights : S.unknownShape })).fetch);
    const ok = await client.insights({ "filter.type": "brand", "signal.interests.entities": [S.ID.actA] });
    expect(ok.value.kind).toBe("entities");
    const odd = await client.insights({ "filter.type": "brand", "signal.interests.entities": [S.ID.actB] });
    expect(odd).toMatchObject({ status: "empty", reason: expect.stringMatching(/unexpected shape/) });
  });

  it("entitiesByIds batches and merges", async () => {
    const { fetch, calls } = okFetch(S.entitiesBySpotify);
    const { client } = liveClient(fetch);
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    const r = await client.entitiesByIds(ids);
    expect(calls).toHaveLength(2);
    expect(r.ledgerRefs).toEqual(["Q1", "Q2"]);
    expect(r.value).toHaveLength(2);
    const none = await client.entitiesByIds([]);
    expect(none).toMatchObject({ status: "empty", reason: "no ids given", ledgerRefs: [] });
  });

  it("entitiesByExternal matches spotify ids back to entities", async () => {
    const { fetch, calls } = okFetch(S.entitiesBySpotify);
    const { client } = liveClient(fetch);
    const r = await client.entitiesByExternal("spotify", ["1SyntheticSpotifyId001", "missingSpotifyId000000"]);
    expect(calls[0]!.url.searchParams.get("external.spotify.ids")).toBe("1SyntheticSpotifyId001,missingSpotifyId000000");
    expect(r.value.matches).toEqual([{ externalId: "1SyntheticSpotifyId001", entityId: S.ID.actA }]);
    expect(r.value.missing).toEqual(["missingSpotifyId000000"]);
  });

  it("every insights call is a GET with plain ids (POST weights returned 400 on Oct 15 and were removed)", async () => {
    const { fetch, calls } = okFetch(S.heatmap);
    const { client, ledger } = liveClient(fetch);
    await client.heatmap({ signalEntities: [S.ID.actA, S.ID.actB, S.ID.actA], point: P });
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body ?? null).toBeNull();
    expect(calls[0]!.url.searchParams.get("signal.interests.entities")).toBe(`${S.ID.actA},${S.ID.actB}`);
    expect(ledger.entries()[0]!.method).toBe("GET");
    expect("allowPost" in client).toBe(false);
  });

  it("dedupes identical in-flight requests (one call, two ledger entries)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fetch, calls } = mockFetch(async () => {
      await gate;
      return { body: S.heatmap };
    });
    const { client, ledger } = liveClient(fetch, { cache: null });
    const opts = { signalEntities: [S.ID.actA], point: P };
    const a = client.heatmap(opts);
    const b = client.heatmap(opts);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(calls).toHaveLength(1);
    expect(ra.source).toBe("live");
    expect(rb.source).toBe("inflight");
    expect(ledger.entries()).toHaveLength(2);
    expect(ledger.entries()[1]!.note).toContain("in-flight");
  });

  it("toEnvelope carries status, reason and provenance", async () => {
    const { client } = liveClient(okFetch(S.heatmap).fetch);
    const r = await client.heatmap({ signalEntities: [S.ID.actA], point: P });
    const env = toEnvelope(r, "Bill heat", ["Percentiles within one response."]);
    expect(env).toMatchObject({ status: "ok", summary: "Bill heat", provenance: ["Q1"], limits: ["Percentiles within one response."] });
    expect(env.reason).toMatch(/missing/);
  });
});

describe("shared state", () => {
  it("withLedger views share cache and quota but write to their own ledger", async () => {
    const { fetch, calls } = okFetch(S.searchVenue, { "x-month-ratelimit-remaining": "4321" });
    const { client, ledger } = liveClient(fetch);
    const runLedger = createMemoryLedger();
    const run = client.withLedger(runLedger);
    await client.search("v", ["place"]);
    const r = await run.search("v", ["place"]);
    expect(calls).toHaveLength(1);
    expect(r.cacheHit).toBe(true);
    expect(r.ledgerRef).toBe("Q1");
    expect(ledger.entries()).toHaveLength(1);
    expect(runLedger.entries()).toHaveLength(1);
    expect(run.quota().remaining).toBe(4321);
    expect(run.ledger).toBe(runLedger);
    expect(client.ledger).toBe(ledger);
  });

  it("opens the default SQLite cache under WALKUP_DATA_DIR on first live call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "walkup-qloo-cache-"));
    try {
      const { fetch, calls } = okFetch(S.searchVenue);
      const client = new QlooClient({ config: liveConfig({ dataDir: dir }), fetch, limiter: noLimiter, fixtures: createMemoryFixtureStore() });
      expect(existsSync(join(dir, "qloo-cache.sqlite"))).toBe(false);
      await client.search("v", ["place"]);
      expect(existsSync(join(dir, "qloo-cache.sqlite"))).toBe(true);
      client.close();
      const again = new QlooClient({ config: liveConfig({ dataDir: dir }), fetch, limiter: noLimiter, fixtures: createMemoryFixtureStore() });
      expect((await again.search("v", ["place"])).cacheHit).toBe(true);
      again.close();
      expect(calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("client safety", () => {
  it("refuses to use the global fetch under the test runner", () => {
    expect(() => new QlooClient({ config: liveConfig(), cache: null, fixtures: createMemoryFixtureStore() })).toThrow(QlooConfigError);
  });

  it("refuses live mode without a key and a non-hackathon host", () => {
    expect(() => new QlooClient({ config: liveConfig({ apiKey: null }), fetch: okFetch({}).fetch, cache: null })).toThrow(QlooConfigError);
    expect(
      () => new QlooClient({ config: liveConfig({ baseUrl: "https://api.qloo.com" }), fetch: okFetch({}).fetch, cache: null }),
    ).toThrow(QlooHostRefusedError);
  });

  it("works with the cache disabled", async () => {
    const { fetch, calls } = okFetch(S.searchVenue);
    const { client } = liveClient(fetch, { cache: null });
    await client.search("v", ["place"]);
    await client.search("v", ["place"]);
    expect(calls).toHaveLength(2);
    expect(client.quota()).toEqual({ remaining: null, limit: null, updatedAt: null });
  });
});
