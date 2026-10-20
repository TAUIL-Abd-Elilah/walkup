/**
 * The fixture world answers with the field names and placement of the live API
 * (shape audit, Oct 15), including the scripted not_found case. Raw bodies are read
 * here on purpose: these tests pin the world's shapes, not the client's view of them.
 */
import { describe, expect, it } from "vitest";
import { createMemoryLedger } from "@walkup/contracts";
import { createMemoryFixtureStore, createSqliteCache, isSignalNotFoundError, noLimiter, QlooClient } from "@walkup/qloo";
import { catalogByKey, createWorld, NOT_FOUND_PAIR, WORLD_TAG_PINS, WORLD_VENUES, type World } from "../src/index";

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

type Rec = Record<string, unknown>;

async function raw(world: World, path: string, params: Record<string, string>): Promise<{ status: number; body: Rec }> {
  const res = await world.qlooFetch(`https://hackathon.api.qloo.com${path}?${new URLSearchParams(params).toString()}`, { method: "GET" });
  return { status: res.status, body: (await res.json()) as Rec };
}

const truth = WORLD_VENUES.truth;
const POINT = `POINT(${truth.lon} ${truth.lat})`;
const hollis = catalogByKey("hollis_creek");
const solo = catalogByKey("wade_corley");
const band = catalogByKey("wade_corley_low_ten");
const rows = (b: Rec): Rec[] => (Array.isArray(b.results) ? b.results : ((b.results as Rec).entities as Rec[])) as Rec[];

describe("live field placement", () => {
  it("/search and /entities rows: types[], properties.external.<ns> = {id}, tag refs {tag_id, name, type, value}", async () => {
    const world = createWorld();
    for (const r of [
      await raw(world, "/search", { query: hollis.name, types: "urn:entity:artist" }),
      await raw(world, "/entities", { entity_ids: hollis.id }),
      await raw(world, "/entities", { "external.spotify.ids": hollis.spotifyId as string }),
    ]) {
      const row = rows(r.body)[0]!;
      expect(row.types).toEqual(["urn:entity:artist"]);
      expect(row).not.toHaveProperty("subtype");
      expect(row).not.toHaveProperty("external");
      expect((row.properties as Rec).external).toEqual({ spotify: { id: hollis.spotifyId } });
      const tag = (row.tags as Rec[])[0]!;
      expect(Object.keys(tag).sort()).toEqual(["name", "tag_id", "type", "value"]);
      expect(tag.value).toBe(tag.tag_id);
    }
    // The client reads the nested ids, so lookup by Spotify id matches.
    const r = await client(world).entitiesByExternal("spotify", [hollis.spotifyId as string]);
    expect(r.value.matches).toEqual([{ externalId: hollis.spotifyId, entityId: hollis.id }]);
  });

  it("/search places: location {lat, lon} only", async () => {
    const world = createWorld();
    const r = await raw(world, "/search", { query: "Bellhop Records", types: "urn:entity:place", "filter.location": `${truth.lat},${truth.lon}`, "filter.radius": "10" });
    const row = rows(r.body)[0]!;
    expect(Object.keys(row.location as Rec).sort()).toEqual(["lat", "lon"]);
  });

  it("insights place rows: subtype, 12-char geohash, null neighborhood, localities with a ZCTA row, numeric rating, flagged hours, {id, name, type, weight} tags", async () => {
    const world = createWorld({ scenario: { noHoursRate: 0 } });
    const r = await raw(world, "/v2/insights", { "filter.type": "urn:entity:place", "filter.location": POINT, "filter.location.radius": "3000", "signal.interests.entities": hollis.id, take: "10" });
    expect(r.status).toBe(200);
    for (const row of rows(r.body)) {
      expect(row.subtype).toBe("urn:entity:place");
      expect(((row.location as Rec).geohash as string).length).toBe(12);
      const props = row.properties as Rec;
      expect(props.neighborhood).toBeNull();
      expect(typeof props.business_rating).toBe("number");
      const locs = props.localities as Rec[];
      expect(locs.some((l) => l.place === "ZCTA" && /^\d{5}$/.test(String(l.name)))).toBe(true);
      const hours = props.hours as Record<string, Rec[]>;
      expect(Object.keys(hours).every((k) => k === k.toLowerCase())).toBe(true);
      for (const slots of Object.values(hours)) for (const x of slots) expect(typeof x.closed).toBe("boolean");
      expect(Object.keys((row.tags as Rec[])[0]!).sort()).toEqual(["id", "name", "type", "weight"]);
    }
    // ZIP reaches the entity through the normalizer.
    const q = await client(world).placeInsights({ signalEntities: [hollis.id], point: truth, radiusM: 3000, take: 10 });
    expect(q.value.every((e) => typeof e.properties.zip === "string")).toBe(true);
  });

  it("insights artist rows carry top-level external.<ns> = [{id}]", async () => {
    const world = createWorld();
    const r = await raw(world, "/v2/insights", { "filter.type": "urn:entity:artist", "filter.results.entities": hollis.id, "signal.interests.entities": catalogByKey("marla_vane").id });
    expect(rows(r.body)[0]!.external).toEqual({ spotify: [{ id: hollis.spotifyId }] });
  });

  it("heatmaps carry only success and results; demographics blocks are keyed by entity_id (tags too)", async () => {
    const world = createWorld();
    const h = await raw(world, "/v2/insights", { "filter.type": "urn:heatmap", "filter.location": POINT, "filter.location.radius": "20000", "signal.interests.entities": hollis.id });
    expect(Object.keys(h.body).sort()).toEqual(["results", "success", "synthetic"]);
    const tag = WORLD_TAG_PINS.baselineTags.default as string;
    const d = await raw(world, "/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": hollis.id, "signal.interests.tags": tag });
    const blocks = (d.body.results as Rec).demographics as Rec[];
    expect(blocks.map((b) => b.entity_id)).toEqual([hollis.id, tag]);
    expect(blocks.every((b) => !("tag_id" in b))).toBe(true);
  });

  it("4xx bodies are {errors: [{message, path?}]}", async () => {
    const world = createWorld();
    const r = await raw(world, "/v2/insights", { "filter.type": "urn:entity:locality", "signal.interests.entities": hollis.id });
    expect(r.status).toBe(403);
    expect(Array.isArray(r.body.errors)).toBe(true);
    expect((r.body.errors as Rec[])[0]).toMatchObject({ path: "filter.type" });
    expect(r.body).not.toHaveProperty("error");
  });
});

describe("scripted not_found case", () => {
  it("is a test-only pair: /search lists both, insights never offer them unasked", async () => {
    expect(NOT_FOUND_PAIR.map((e) => e.key)).toEqual(["wade_corley", "wade_corley_low_ten"]);
    const world = createWorld();
    const s = await raw(world, "/search", { query: "Wade Corley", types: "urn:entity:artist,urn:entity:person" });
    expect(rows(s.body).map((r) => r.entity_id)).toEqual([solo.id, band.id]);
    const artists = await raw(world, "/v2/insights", { "filter.type": "urn:entity:artist", "signal.interests.entities": hollis.id, take: "50" });
    expect(rows(artists.body).some((r) => r.entity_id === solo.id || r.entity_id === band.id)).toBe(false);
  });

  it("entity insights drop the id with the live warning; heatmaps drop it silently, still 200 with cells when nothing usable is left", async () => {
    const world = createWorld();
    const place = await raw(world, "/v2/insights", { "filter.type": "urn:entity:place", "filter.location": POINT, "filter.location.radius": "1500", "signal.interests.entities": `${solo.id},${band.id}`, take: "1" });
    expect(place.status).toBe(200);
    expect(place.body.warnings).toEqual([{ type: "not_found", "signal.interests.entities": [solo.id] }]);

    const mixed = await raw(world, "/v2/insights", { "filter.type": "urn:heatmap", "filter.location": POINT, "filter.location.radius": "20000", "signal.interests.entities": `${solo.id},${band.id}` });
    const bandOnly = await raw(world, "/v2/insights", { "filter.type": "urn:heatmap", "filter.location": POINT, "filter.location.radius": "20000", "signal.interests.entities": band.id });
    expect(mixed.status).toBe(200);
    expect(mixed.body).not.toHaveProperty("warnings");
    expect(((mixed.body.results as Rec).heatmap as Rec[]).length).toBe(((bandOnly.body.results as Rec).heatmap as Rec[]).length);

    // Live probe 2 (Oct 15): the not_found id alone still gave a 200 with cells; only a malformed id gave a 400.
    const none = await raw(world, "/v2/insights", { "filter.type": "urn:heatmap", "filter.location": POINT, "signal.interests.entities": solo.id });
    expect(none.status).toBe(200);
    expect(none.body).not.toHaveProperty("warnings");
    expect(((none.body.results as Rec).heatmap as Rec[]).length).toBeGreaterThan(0);
    const malformed = await raw(world, "/v2/insights", { "filter.type": "urn:heatmap", "filter.location": POINT, "signal.interests.entities": "not-an-entity-id" });
    expect(malformed.status).toBe(400);
    expect((malformed.body.errors as Rec[])[0]).toMatchObject({ path: "signal.interests.entities" });
  });

  it("brands: only the unknown id and nothing else is a 400; with signal.location it is a 200 with the warning", async () => {
    const world = createWorld();
    const bare = await raw(world, "/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": solo.id, take: "5" });
    expect(bare.status).toBe(400);
    expect((bare.body.errors as Rec[])[0]).toMatchObject({ path: "signal.interests.entities" });
    const located = await raw(world, "/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": solo.id, "signal.location": POINT, take: "5" });
    expect(located.status).toBe(200);
    expect(located.body.warnings).toEqual([{ type: "not_found", "signal.interests.entities": [solo.id] }]);
  });

  it("demographics still answer a block for the id; tag profiles drop it without a warning", async () => {
    const world = createWorld();
    const d = await raw(world, "/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": `${solo.id},${band.id}` });
    expect(((d.body.results as Rec).demographics as Rec[]).map((b) => b.entity_id)).toEqual([solo.id, band.id]);
    expect(d.body).not.toHaveProperty("warnings");
    const t = await raw(world, "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": `${solo.id},${band.id}`, take: "5" });
    expect(t.status).toBe(200);
    expect(t.body).not.toHaveProperty("warnings");
  });

  it("the client surfaces it end to end: ledger note, droppedSignals, a silent heatmap, a typed 400 and the resolver's fallback", async () => {
    const world = createWorld();
    const q = client(world);
    const r = await q.placeInsights({ signalEntities: [solo.id, hollis.id], point: truth, radiusM: 1500, take: 3 });
    expect(r.meta?.droppedSignals).toEqual([solo.id]);
    expect(q.ledger.entries().at(-1)!.envelopeStatus).toBe("partial");
    // A heatmap of only the not_found id is a 200 with cells and says nothing: it can never tell a seed is unusable.
    const heat = await q.heatmap({ signalEntities: [solo.id], point: truth, radiusM: 20000 });
    expect(heat.value.length).toBeGreaterThan(0);
    expect(heat.meta?.droppedSignals).toBeUndefined();
    // Entity insights with only that id and nothing else to rank by are the typed 400.
    const err = await q.entityInsights("brand", { signalEntities: [solo.id], take: 5 }).catch((e: unknown) => e);
    expect(isSignalNotFoundError(err)).toBe(true);

    const res = await q.resolveExact("Wade Corley", ["artist", "person"], { take: 5, checkSignalAt: truth });
    expect(res.status).toBe("exact");
    expect(res.entity?.entityId).toBe(band.id);
    expect(res.replaced).toMatchObject({ entityId: solo.id, reason: "not_found" });
    expect(res.reason).toContain("billed under a different name");
    const check = await q.checkSignals([solo.id, band.id], truth);
    expect(check).toMatchObject({ usable: [band.id], dropped: [solo.id], cacheHit: true });
    expect(check.ledgerRefById[solo.id]).toBe(check.ledgerRefs[0]);
  });
});

describe("place insights with no signal", () => {
  // Live (probe 1 / KG1, Oct 15): the same place request without signal.interests.entities comes back in popularity
  // order. The partner popularity twin relies on it.
  const params = {
    "filter.type": "urn:entity:place",
    "filter.location": POINT,
    "filter.location.radius": "2000",
    "filter.tags": Object.values(WORLD_TAG_PINS.categories).slice(0, 4).join(","),
    "operator.filter.tags": "union",
    "filter.hours": "thursday",
    "filter.price_level.max": "3",
    take: "50",
  };

  it("answers 200 in popularity order, with no affinity and no warning", async () => {
    const r = await raw(createWorld(), "/v2/insights", params);
    expect(r.status).toBe(200);
    const list = rows(r.body);
    expect(list.length).toBeGreaterThan(10);
    const pops = list.map((row) => row.popularity as number);
    for (let i = 1; i < pops.length; i++) expect(pops[i - 1]!).toBeGreaterThanOrEqual(pops[i]!);
    expect(list.every((row) => (row.query as Rec | undefined)?.affinity === undefined)).toBe(true);
    expect(r.body.warnings).toBeUndefined();
  });

  it("is deterministic: the same request on a fresh world gives the same list", async () => {
    const a = rows((await raw(createWorld(), "/v2/insights", params)).body).map((row) => row.entity_id);
    const b = rows((await raw(createWorld(), "/v2/insights", params)).body).map((row) => row.entity_id);
    expect(a).toEqual(b);
  });

  it("ranks the same places as the bill's request, in another order", async () => {
    // A radius small enough that every candidate fits in one page.
    const world = createWorld();
    const small = { ...params, "filter.location.radius": "700" };
    const plain = rows((await raw(world, "/v2/insights", small)).body).map((row) => row.entity_id as string);
    const withBill = rows((await raw(world, "/v2/insights", { ...small, "signal.interests.entities": hollis.id })).body).map((row) => row.entity_id as string);
    expect(plain.length).toBeGreaterThan(5);
    expect(plain.length).toBeLessThan(50);
    expect(new Set(plain)).toEqual(new Set(withBill));
    expect(plain).not.toEqual(withBill);
  });
});
