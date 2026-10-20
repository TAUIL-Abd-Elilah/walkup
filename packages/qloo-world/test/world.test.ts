/**
 * The fixture world: shapes match what @walkup/qloo, tm and places read,
 * numbers are deterministic, filters are honoured and the scenario knobs work.
 * Nothing here reaches the network.
 */
import { describe, expect, it } from "vitest";
import { createMemoryLedger } from "@walkup/contracts";
import { annotateTile, metroForPoint } from "@walkup/gazetteer";
import { createMemoryFixtureStore, createSqliteCache, noLimiter, QlooClient } from "@walkup/qloo";
import { createPlacesClient } from "@walkup/places";
import { createTmClient, toBill } from "@walkup/tm";
import {
  catalogByKey,
  createWorld,
  DEFAULT_WORLD_SEED,
  generatedPlaceId,
  isWorldTransport,
  parseGeneratedPlaceId,
  placesWithin,
  WORLD_EVENT_IDS,
  WORLD_TAG_PINS,
  WORLD_VENUES,
  type World,
} from "../src/index";

function client(world: World): QlooClient {
  return new QlooClient({
    config: {
      apiKey: "world-test-key",
      baseUrl: "https://hackathon.api.qloo.com",
      allowHost: false,
      dataDir: "/nonexistent",
      fixturesDir: "/nonexistent",
      requestedMode: "live",
      mode: "live",
      record: false,
      monthGuardFloor: 1500,
    },
    fetch: world.qlooFetch,
    cache: createSqliteCache(":memory:"),
    fixtures: createMemoryFixtureStore(),
    limiter: noLimiter,
    ledger: createMemoryLedger(),
    sleep: async () => {},
    random: () => 0.5,
  });
}

const truth = { lat: WORLD_VENUES.truth.lat, lon: WORLD_VENUES.truth.lon };
const billA = ["hollis_creek", "marla_vane"].map((k) => catalogByKey(k).id);
const billB = ["neon_orchard", "sable_sun"].map((k) => catalogByKey(k).id);
const cat = (k: string) => WORLD_TAG_PINS.categories[k] as string;

async function rawJson(world: World, path: string, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const qs = new URLSearchParams(params).toString();
  const res = await world.qlooFetch(`https://hackathon.api.qloo.com${path}?${qs}`, { method: "GET" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

describe("Qloo transport", () => {
  it("labels every body synthetic and marks its transports", async () => {
    const world = createWorld();
    const r = await rawJson(world, "/search", { query: "Sidecar", types: "urn:entity:person,urn:entity:artist" });
    expect(r.body.synthetic).toBe(true);
    expect(r.headers.get("x-month-ratelimit-remaining")).not.toBeNull();
    expect(isWorldTransport(world.qlooFetch)).toBe(true);
    expect(isWorldTransport(globalThis.fetch)).toBe(false);
  });

  it("returns several exact matches for a one-word act name", async () => {
    const q = client(createWorld());
    const r = await q.search("Sidecar", ["artist", "person"], { take: 5 });
    expect(r.value.filter((e) => e.name === "Sidecar").length).toBeGreaterThanOrEqual(2);
    expect(r.value.map((e) => e.subtype)).toEqual(expect.arrayContaining(["urn:entity:person", "urn:entity:artist"]));
    const person = r.value.find((e) => e.subtype === "urn:entity:person");
    expect(person?.tags.some((t) => t.id === "urn:tag:genre:person:comedian")).toBe(true);
  });

  it("answers 404 (empty) for names it does not know, and resolves by Spotify id", async () => {
    const q = client(createWorld());
    expect((await q.search("Margo Vint", ["artist", "person"])).value).toEqual([]);
    const hollis = catalogByKey("hollis_creek");
    const ext = await q.entitiesByExternal("spotify", [hollis.spotifyId as string, "0SynNotInTheCatalog000"]);
    expect(ext.value.matches).toEqual([{ externalId: hollis.spotifyId, entityId: hollis.id }]);
    expect(ext.value.missing).toEqual(["0SynNotInTheCatalog000"]);
  });

  it("is deterministic: the same request gives the same body", async () => {
    const params = { "filter.type": "urn:heatmap", "filter.location": `POINT(${truth.lon} ${truth.lat})`, "filter.location.radius": "40000", "signal.interests.entities": billA.join(",") };
    const a = await rawJson(createWorld(), "/v2/insights", params);
    const b = await rawJson(createWorld(), "/v2/insights", params);
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    const c = await rawJson(createWorld({ seed: "another-seed" }), "/v2/insights", params);
    expect(JSON.stringify(c.body)).not.toBe(JSON.stringify(a.body));
  });

  it("puts heatmap cells inside the gazetteer metros, named by the gazetteer", async () => {
    const q = client(createWorld());
    const heat = await q.heatmap({ signalEntities: billA, point: truth, radiusM: 40000 });
    expect(heat.value.length).toBeGreaterThan(1000);
    for (const c of heat.value.slice(0, 50)) {
      expect(metroForPoint(c.lat, c.lon)).toBe("nashville");
      expect(annotateTile<{ lat: number; lon: number; name?: string }>({ lat: c.lat, lon: c.lon }).name).toBeTruthy();
      expect(c.affinity).toBeGreaterThan(0);
      expect(c.affinity).toBeLessThanOrEqual(1);
    }
  });

  it("gives different bills different heat (bill specificity)", async () => {
    const q = client(createWorld());
    const a = await q.heatmap({ signalEntities: billA, point: truth, radiusM: 40000 });
    const b = await q.heatmap({ signalEntities: billB, point: truth, radiusM: 40000 });
    const topA = a.value.slice(0, 100).map((c) => c.geohash);
    const topB = new Set(b.value.slice(0, 100).map((c) => c.geohash));
    expect(topA.filter((g) => topB.has(g)).length).toBeLessThan(100);
  });

  it("refuses a heatmap without a signal and the city boundary, and 403s unsupported types", async () => {
    const world = createWorld();
    expect((await rawJson(world, "/v2/insights", { "filter.type": "urn:heatmap", "filter.location": `POINT(${truth.lon} ${truth.lat})` })).status).toBe(400);
    expect(
      (await rawJson(world, "/v2/insights", { "filter.type": "urn:heatmap", "filter.location": `POINT(${truth.lon} ${truth.lat})`, "signal.interests.entities": billA[0] as string, "output.heatmap.boundary": "city" })).status,
    ).toBe(400);
    expect((await rawJson(world, "/v2/insights", { "filter.type": "urn:entity:locality", "signal.interests.entities": billA[0] as string })).status).toBe(403);
  });

  it("honours radius, tag union, hours, price, exclusions and results.entities on places", async () => {
    const q = client(createWorld());
    const tags = [cat("record_store"), cat("cafe")];
    const r = await q.placeInsights({ signalEntities: billA, point: truth, radiusM: 2000, tags, operator: "union", hours: "monday", priceMax: 2, take: 50 });
    expect(r.value.length).toBeGreaterThan(0);
    for (const e of r.value) {
      expect(e.distanceM ?? Infinity).toBeLessThanOrEqual(2000);
      expect(e.tags.some((t) => tags.includes(t.id))).toBe(true);
      expect(Number(e.properties.price_level)).toBeLessThanOrEqual(2);
      const hours = e.properties.hours as Record<string, unknown[]> | undefined;
      // Live hours shape: lowercase weekday keys, closed days flagged.
      if (hours) expect((hours.monday as { closed: boolean }[]).some((x) => x.closed === false)).toBe(true);
    }
    const first = r.value[0]!;
    const excluded = await q.placeInsights({ signalEntities: billA, point: truth, radiusM: 2000, tags, operator: "union", hours: "monday", priceMax: 2, take: 50, excludeEntities: [first.entityId] });
    expect(excluded.value.some((e) => e.entityId === first.entityId)).toBe(false);
    const noBars = await q.placeInsights({ signalEntities: billA, point: truth, radiusM: 2000, tags: [cat("bar"), cat("cafe")], operator: "union", excludeTags: [cat("bar")], take: 50 });
    expect(noBars.value.every((e) => !e.tags.some((t) => t.id === cat("bar")))).toBe(true);
    const shortlist = [catalogByKey("bellhop_records").id, catalogByKey("larkspur_cup").id, "0000dead-beef-4000-8000-000000000000"];
    const scored = await q.placeInsights({ signalEntities: billA, resultsEntities: shortlist, take: 10 });
    expect(scored.value.map((e) => e.entityId).sort()).toEqual(shortlist.slice(0, 2).sort());
  });

  it("ranks places differently for different bills", async () => {
    const q = client(createWorld());
    const opts = { point: truth, radiusM: 2500, tags: [cat("bar"), cat("cafe"), cat("record_store"), cat("restaurant")], operator: "union" as const, take: 20 };
    const a = await q.placeInsights({ ...opts, signalEntities: billA });
    const b = await q.placeInsights({ ...opts, signalEntities: billB });
    expect(a.value.map((e) => e.entityId)).not.toEqual(b.value.map((e) => e.entityId));
    expect(a.value[0]?.affinity).not.toBeNull();
    const pop = await q.placeInsights(opts);
    expect(pop.value[0]?.affinity).toBeNull();
  });

  it("moves brands with signal.location but not podcasts", async () => {
    const q = client(createWorld());
    const hampton = { lat: WORLD_VENUES.hampton.lat, lon: WORLD_VENUES.hampton.lon };
    const ids = [catalogByKey("pier_stand_up").id];
    const brandsHere = await q.entityInsights("brand", { signalEntities: ids, signalLocationPoint: hampton, take: 15 });
    const brandsNash = await q.entityInsights("brand", { signalEntities: ids, signalLocationPoint: truth, take: 15 });
    expect(brandsHere.value.map((e) => e.entityId)).not.toEqual(brandsNash.value.map((e) => e.entityId));
    const podHere = await q.entityInsights("podcast", { signalEntities: ids, signalLocationPoint: hampton, take: 15 });
    const podNash = await q.entityInsights("podcast", { signalEntities: ids, signalLocationPoint: truth, take: 15 });
    expect(podHere.value.map((e) => e.entityId)).toEqual(podNash.value.map((e) => e.entityId));
    const noAlcohol = await q.entityInsights("brand", { signalEntities: ids, excludeTags: [WORLD_TAG_PINS.sponsorExclusions.alcohol as string], take: 15 });
    expect(noAlcohol.value.every((e) => !e.tags.some((t) => t.id === WORLD_TAG_PINS.sponsorExclusions.alcohol))).toBe(true);
  });

  it("returns demographics blocks for titles and artists but not persons", async () => {
    const q = client(createWorld());
    const r = await q.demographics([catalogByKey("late_shift_diner").id, catalogByKey("dorian_pike").id, billA[0] as string]);
    expect(r.value.map((b) => b.entityId).sort()).toEqual([catalogByKey("late_shift_diner").id, billA[0]].sort());
    expect(Object.keys(r.value[0]!.age).length).toBe(6);
  });

  it("shapes compare like the live API (no success field, counts as strings) and honours the empty knob", async () => {
    const world = createWorld();
    const r = await rawJson(world, "/v2/analysis/compare", { "a.signal.interests.entities": billA.join(","), "b.signal.interests.entities": billB.join(","), take: "30" });
    expect(r.body.success).toBeUndefined();
    const results = r.body.results as { tags: unknown[]; a: { query: { count: unknown } }[]; b: unknown[] };
    expect(results.a.length).toBeGreaterThan(0);
    expect(typeof results.a[0]?.query.count).toBe("string");
    world.setScenario({ emptyCompare: true });
    const q = client(world);
    const empty = await q.compare(billA, billB, 30);
    expect(empty.status).toBe("empty");
  });

  it("scopes urn:tag profiles by namespace and includes a denied example when the knob is on", async () => {
    const q = client(createWorld());
    const types = ["urn:tag:keyword:media", "urn:tag:genre:music"];
    const r = await q.tagProfile({ signalEntities: billA, tagTypes: types, diversifyBySubtype: true, take: 30 });
    expect(r.value.every((t) => types.some((ns) => t.id.startsWith(`${ns}:`)))).toBe(true);
    expect(r.value.some((t) => /ethnic/i.test(t.name))).toBe(true);
    const off = createWorld({ scenario: { deniedTags: false } });
    const r2 = await client(off).tagProfile({ signalEntities: billA, tagTypes: types, take: 30 });
    expect(r2.value.some((t) => /ethnic/i.test(t.name))).toBe(false);
  });

  it("serves /v2/tags, and /v2/audiences answers a free-text query with nothing (as live)", async () => {
    const world = createWorld();
    const q = client(world);
    const tags = await q.tagsSearch("record store", { parentsTypes: ["place"] });
    expect(tags.value[0]?.id).toBe(cat("record_store"));
    // Live (probe 17): a free-text audience query returns nothing; the product never calls /v2/audiences.
    const aud = await rawJson(world, "/v2/audiences", { "filter.query": "live music" });
    expect(aud.status).toBe(200);
    expect(((aud.body as { results: { audiences: unknown[] } }).results.audiences)).toEqual([]);
  });
});

describe("scenario knobs", () => {
  it("thin heatmap: fewer than 200 cells inside 40 km, more at 60 km", async () => {
    const q = client(createWorld({ scenario: { thinHeatmap: true } }));
    const at40 = await q.heatmap({ signalEntities: billA, point: truth, radiusM: 40000 });
    const at60 = await q.heatmap({ signalEntities: billA, point: truth, radiusM: 60000 });
    expect(at40.value.length).toBeLessThan(200);
    expect(at60.value.length).toBeGreaterThanOrEqual(200);
  });

  it("quota header near the floor trips the client's month guard", async () => {
    const world = createWorld({ scenario: { quotaRemaining: 1400 } });
    const q = client(world);
    await q.search("Late Shift Diner", ["tv_show"]);
    expect(q.guardTripped()).toBe(true);
    await expect(q.search("Sidecar", ["person"])).rejects.toThrow(/quota/i);
  });

  it("without the knob, the quota header stays put however many calls are served", async () => {
    const world = createWorld();
    for (let i = 0; i < 25; i++) await rawJson(world, "/search", { query: `Late Shift Diner ${i}`, types: "urn:entity:tv_show" });
    const r = await rawJson(world, "/search", { query: "Late Shift Diner", types: "urn:entity:tv_show" });
    expect(r.headers.get("x-month-ratelimit-remaining")).toBe("9000");
    expect(world.stats().qloo).toBe(26);
  });

  it("429 then success: the client retries and records it", async () => {
    const world = createWorld({ scenario: { rateLimitOnce: true } });
    const ledger = createMemoryLedger();
    const q = client(world).withLedger(ledger);
    const r = await q.search("Late Shift Diner", ["tv_show"]);
    expect(r.value.length).toBeGreaterThan(0);
    expect(ledger.entries()[0]?.note).toMatch(/retry 1 after HTTP 429/);
  });

  it("closed places and places without hours appear at the configured rates", async () => {
    const q = client(createWorld({ scenario: { closedRate: 0.5, noHoursRate: 0.5 } }));
    const r = await q.placeInsights({ signalEntities: billA, point: truth, radiusM: 3000, take: 50 });
    expect(r.value.some((e) => e.properties.is_closed === true)).toBe(true);
    expect(r.value.some((e) => e.properties.hours === undefined)).toBe(true);
  });
});

describe("places and ids", () => {
  it("round-trips generated place ids", () => {
    const id = generatedPlaceId("dn6m9", 42);
    expect(parseGeneratedPlaceId(id)).toEqual({ gh5: "dn6m9", index: 42 });
    expect(parseGeneratedPlaceId(catalogByKey("bellhop_records").id)).toBeNull();
    const places = placesWithin(truth, 1500, DEFAULT_WORLD_SEED);
    expect(places.length).toBeGreaterThan(10);
    for (const p of places.slice(0, 20)) {
      expect(p.website).toMatch(/\.example$/);
      // A real area code with the reserved 555-01xx line numbers.
      expect(p.phone).toMatch(/^\+1 (615|629)-555-01\d\d$/);
    }
  });
});

describe("Ticketmaster and Places transports", () => {
  it("serves events and rosters that @walkup/tm maps to bills", async () => {
    const world = createWorld();
    const tm = createTmClient({ apiKey: "world", fetch: world.tmFetch, ledger: createMemoryLedger(), sleep: async () => {} });
    const ev = await tm.getEvent(WORLD_EVENT_IDS.g2);
    const bill = toBill(ev.data!);
    expect(bill.acts.map((a) => a.name)).toEqual(["Dorian Pike", "Sidecar", "Reggie Collier"]);
    expect(bill.date).toBe("2026-12-19");
    expect(bill.weekday).toBe("saturday");
    expect(bill.legalAgeEnforced).toBeNull();
    expect(bill.acts.every((a) => a.isComedian)).toBe(true);
    const a = toBill((await tm.getEvent(WORLD_EVENT_IDS.g1a)).data!);
    expect(a.legalAgeEnforced).toBe(true);
    expect(a.acts[0]?.spotifyId).toBe(catalogByKey("hollis_creek").spotifyId);
    const roster = await tm.eventsByVenue(WORLD_VENUES.truth.id, { startDateTime: "2026-10-30", size: 60 });
    expect(roster.data.length).toBeGreaterThan(20);
    expect(roster.data.every((e) => (e.dates?.start?.localDate ?? "") >= "2026-10-30")).toBe(true);
    expect((await tm.getEvent("syn-tm-ev-missing")).data).toBeNull();
  });

  it("serves Google-shaped text search results from the same businesses", async () => {
    const world = createWorld();
    const places = createPlacesClient({ apiKey: "world", fetch: world.placesFetch, ledger: createMemoryLedger() });
    const r = await places.searchText({ textQuery: "record store near Nashville", center: truth, radiusM: 5000 });
    expect(r.places.length).toBeGreaterThan(0);
    expect(r.places.every((p) => p.types.includes("store"))).toBe(true);
    expect(r.places[0]?.regularOpeningHours === null || Array.isArray(r.places[0]?.regularOpeningHours?.periods)).toBe(true);
  });
});

