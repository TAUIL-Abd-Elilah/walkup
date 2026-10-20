import { createMemoryLedger } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import {
  createMemoryCacheStore,
  createPlacesClient,
  MAX_CACHE_TTL_MS,
  pacificDayKey,
  PLACES_FIELD_MASK,
  PlacesError,
  PlacesQuotaError,
  type GoogleTextSearchResponse,
} from "../src/index";
import { fakeClock, fakeFetch, json, loadSynthetic } from "./helpers";

// Not a real key: a placeholder that must never reach the ledger or curl.
const KEY = "unit-test-placeholder-key";
const body = loadSynthetic<GoogleTextSearchResponse>("text-search.synthetic.json");
const center = { lat: 36.16, lon: -86.77 };

function setup(extra: Parameters<typeof createPlacesClient>[0] = {}) {
  const clock = fakeClock();
  const ledger = createMemoryLedger();
  const f = fakeFetch(() => json(body), clock);
  const client = createPlacesClient({ apiKey: KEY, fetch: f.fn, ledger, now: clock.now, sleep: clock.sleep, ...extra });
  return { clock, ledger, f, client };
}

describe("searchText", () => {
  it("sends the fixed field mask and a clamped body", async () => {
    const { f, client } = setup();
    await client.searchText({ textQuery: "record store", center, radiusM: 80_000, maxResultCount: 50, includedType: "store" });
    const call = f.calls[0]!;
    expect(call.url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(call.init?.method).toBe("POST");
    const headers = call.init?.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe(KEY);
    expect(headers["X-Goog-FieldMask"]).toBe(PLACES_FIELD_MASK);
    expect(PLACES_FIELD_MASK).not.toMatch(/phone|website|Uri/i);
    expect(JSON.parse(String(call.init?.body))).toEqual({
      textQuery: "record store",
      maxResultCount: 20,
      locationBias: { circle: { center: { latitude: 36.16, longitude: -86.77 }, radius: 50_000 } },
      includedType: "store",
    });
  });

  it("maps results to PlaceRecord and ControlPlace and drops nameless rows", async () => {
    const { client } = setup();
    const res = await client.searchText({ textQuery: "bars near the hall", center });
    expect(res.places.map((p) => p.placeId)).toEqual(["SynPlace_TapRoom", "SynPlace_Records", "SynPlace_Diner", "SynPlace_Corner"]);
    expect(res.control[0]).toEqual({
      placeId: "SynPlace_TapRoom",
      name: "Marlow's Tap Room",
      address: "12 Example St, Riverton, TN 37000, USA",
      rating: 4.6,
      userRatingCount: 812,
      businessStatus: "OPERATIONAL",
      location: { lat: 36.1612, lon: -86.7705 },
      query: "bars near the hall",
    });
    expect(res.control[3]).toEqual({
      placeId: "SynPlace_Corner",
      name: "Lantern Corner Bar",
      rating: null,
      userRatingCount: null,
      businessStatus: null,
      location: { lat: 36.17, lon: -86.76 },
      query: "bars near the hall",
    });
    expect(res.places[0]!.types).toContain("bar");
    expect(res.places[0]!.regularOpeningHours?.periods).toHaveLength(6);
    expect(res.places[3]!.regularOpeningHours).toBeNull();
    expect(res.cacheHit).toBe(false);
  });

  it("writes a redacted ledger entry with a runnable curl", async () => {
    const { ledger, client } = setup();
    const res = await client.searchText({ textQuery: "Marlow's bar", center, radiusM: 1500 });
    expect(res.ledgerRef).toBe("P1");
    const [e] = ledger.entries();
    expect(e).toMatchObject({
      id: "P1",
      kind: "places",
      method: "POST",
      endpoint: "/v1/places:searchText",
      httpStatus: 200,
      envelopeStatus: "ok",
      resultCount: 4,
      cacheHit: false,
    });
    expect(e!.params).toMatchObject({
      textQuery: "Marlow's bar",
      "locationBias.circle.radius": 1500,
      "X-Goog-Api-Key": "$GOOGLE_PLACES_API_KEY",
      "X-Goog-FieldMask": PLACES_FIELD_MASK,
    });
    expect(e!.curl).toContain('-H "X-Goog-Api-Key: $GOOGLE_PLACES_API_KEY"');
    expect(e!.curl).toContain(`"textQuery":"Marlow'\\''s bar"`);
    expect(JSON.stringify(ledger.entries())).not.toContain(KEY);
  });

  it("serves repeats from cache without spending quota, until 30 days pass", async () => {
    const { clock, ledger, f, client } = setup({ cacheTtlMs: 90 * 24 * 3600 * 1000 }); // clamped to 30 days
    await client.searchText({ textQuery: "bar", center });
    const again = await client.searchText({ textQuery: "bar", center });
    expect(f.calls).toHaveLength(1);
    expect(again.cacheHit).toBe(true);
    expect(again.places).toHaveLength(4);
    expect(again.ledgerRef).toBe("P2");
    expect(ledger.entries()[1]).toMatchObject({ cacheHit: true, httpStatus: 200, bytes: 0 });
    expect((await client.usage()).used).toBe(1);

    clock.t += MAX_CACHE_TTL_MS - 1;
    await client.searchText({ textQuery: "bar", center });
    expect(f.calls).toHaveLength(1);

    clock.t += 2;
    const fresh = await client.searchText({ textQuery: "bar", center });
    expect(fresh.cacheHit).toBe(false);
    expect(f.calls).toHaveLength(2);
  });

  it("does not cache when the TTL is 0", async () => {
    const { f, client } = setup({ cacheTtlMs: 0 });
    await client.searchText({ textQuery: "bar" });
    await client.searchText({ textQuery: "bar" });
    expect(f.calls).toHaveLength(2);
  });

  it("purges expired cache entries", async () => {
    const cache = createMemoryCacheStore();
    const { clock, client } = setup({ cache });
    await client.searchText({ textQuery: "a" });
    await client.searchText({ textQuery: "b" });
    expect(cache.size()).toBe(2);
    clock.t += MAX_CACHE_TTL_MS + 1;
    expect(await client.purgeExpired()).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it("refuses past the daily cap but still serves cached results", async () => {
    const { ledger, f, client } = setup({ dailyCap: 2 });
    await client.searchText({ textQuery: "one" });
    await client.searchText({ textQuery: "two" });
    const err = await client.searchText({ textQuery: "three" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesQuotaError);
    expect(f.calls).toHaveLength(2);
    expect(ledger.entries().at(-1)).toMatchObject({ httpStatus: null, envelopeStatus: "error" });
    expect(ledger.entries().at(-1)!.note).toMatch(/not sent: daily cap 2 reached/);
    const cached = await client.searchText({ textQuery: "one" });
    expect(cached.cacheHit).toBe(true);
  });

  it("holds the daily cap when searches run concurrently", async () => {
    const { ledger, f, client } = setup({ dailyCap: 2 });
    const settled = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => client.searchText({ textQuery: `q${i}` })));
    expect(f.calls).toHaveLength(2);
    expect(settled.filter((s) => s.status === "rejected" && s.reason instanceof PlacesQuotaError)).toHaveLength(4);
    expect((await client.usage()).used).toBe(2);
    expect(ledger.entries()).toHaveLength(6);
  });

  it("defaults to a 300/day cap on the Pacific calendar", async () => {
    const { client } = setup();
    expect(await client.usage()).toEqual({ day: "2026-10-13", used: 0, cap: 300 });
    // 06:00 UTC on Oct 14 is still Oct 13 in Los Angeles (UTC-7 in October).
    expect(pacificDayKey(Date.UTC(2026, 9, 14, 6, 0))).toBe("2026-10-13");
    expect(pacificDayKey(Date.UTC(2026, 9, 14, 8, 0))).toBe("2026-10-14");
  });

  it("reports Google errors and does not cache them", async () => {
    const clock = fakeClock();
    const ledger = createMemoryLedger();
    const f = fakeFetch(() => json({ error: { code: 400, message: "Invalid radius", status: "INVALID_ARGUMENT" } }, 400), clock);
    const client = createPlacesClient({ apiKey: KEY, fetch: f.fn, ledger, now: clock.now });
    const err = (await client.searchText({ textQuery: "x" }).catch((e: unknown) => e)) as PlacesError;
    expect(err).toBeInstanceOf(PlacesError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("INVALID_ARGUMENT: Invalid radius");
    expect(ledger.entries()[0]).toMatchObject({ envelopeStatus: "error", httpStatus: 400 });
    await client.searchText({ textQuery: "x" }).catch(() => undefined);
    expect(f.calls).toHaveLength(2);
  });

  it("retries one 429", async () => {
    const clock = fakeClock();
    const ledger = createMemoryLedger();
    const f = fakeFetch((_u, _i, n) => (n === 1 ? json({ error: { status: "RESOURCE_EXHAUSTED" } }, 429) : json(body)), clock);
    const client = createPlacesClient({ apiKey: KEY, fetch: f.fn, ledger, now: clock.now, sleep: clock.sleep });
    const res = await client.searchText({ textQuery: "x" });
    expect(res.places).toHaveLength(4);
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]!.note).toBe("retried 1x");
    expect((await client.usage()).used).toBe(2);
  });

  it("treats an empty body as empty, and needs a key to send", async () => {
    const ledger = createMemoryLedger();
    const client = createPlacesClient({ apiKey: KEY, ledger, fetch: async () => json({}) });
    const res = await client.searchText({ textQuery: "nothing here" });
    expect(res.places).toEqual([]);
    expect(ledger.entries()[0]!.envelopeStatus).toBe("empty");

    // A 200 with no body at all is a failure: raised, and not cached as "no results".
    const cache = createMemoryCacheStore();
    const blank = createPlacesClient({ apiKey: KEY, cache, fetch: async () => new Response("", { status: 200 }) });
    await expect(blank.searchText({ textQuery: "blank" })).rejects.toBeInstanceOf(PlacesError);
    expect(cache.size()).toBe(0);

    const f = fakeFetch(() => json(body));
    const noKey = createPlacesClient({ apiKey: "", fetch: f.fn });
    await expect(noKey.searchText({ textQuery: "x" })).rejects.toThrow(/GOOGLE_PLACES_API_KEY is not set/);
    expect(f.calls).toHaveLength(0);
  });

  it("rejects bad input before sending", async () => {
    const { f, client } = setup();
    await expect(client.searchText({ textQuery: "  " })).rejects.toThrow(RangeError);
    await expect(client.searchText({ textQuery: "x", center: { lat: 120, lon: 0 } })).rejects.toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });
});
