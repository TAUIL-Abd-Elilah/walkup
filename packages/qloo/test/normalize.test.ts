import { describe, expect, it } from "vitest";
import { decodeGeohash } from "../src/geohash";
import {
  countResults,
  normalizeCompare,
  normalizeDemographics,
  normalizeEntity,
  normalizeEntityList,
  normalizeHeatmap,
  normalizeInsights,
  normalizeTagList,
  normalizeTagRef,
  projectProperties,
  responseMeta,
  responseWarnings,
  droppedSignalIds,
  tagNamespace,
  zipOf,
} from "../src/normalize";
import * as S from "./synthetic";

describe("entities", () => {
  it("normalizes insights place entities with projected properties, distance and explainability", () => {
    const n = normalizeEntityList(S.placeInsights);
    expect(n.reason).toBeUndefined();
    expect(n.skipped).toBe(1);
    expect(n.value).toHaveLength(2);
    const bar = n.value[0]!;
    expect(bar).toMatchObject({
      entityId: S.ID.barA,
      name: "Synthetic Bar A",
      subtype: "urn:entity:place",
      popularity: 0.82,
      affinity: 0.973,
      distanceM: 812.4,
      location: { lat: 36.1701, lon: -86.7601, geohash: "dn6mb12x4k9q" },
    });
    // Per-row explainability scores are shares of the row's affinity (live rows sum to 1).
    expect(bar.explainability).toEqual([
      { entityId: S.ID.actA, score: 0.71 },
      { entityId: S.ID.actB, score: 0.29 },
    ]);
    expect(bar.tags.map((t) => t.id)).toEqual(["urn:tag:category:place:bar", "urn:tag:ambience:qloo:intimate"]);
    expect(bar.tags[1]!.type).toBe("urn:tag:ambience:qloo");
    expect(bar.properties).toEqual({
      address: "10 Sample Ave",
      phone: "+1 555 0100",
      website: "https://bar-a.example",
      price_level: 2,
      business_rating: 4.6,
      is_closed: false,
      hours: {
        thursday: [{ closed: false, opens: "T16:00:00", closes: "T02:00:00" }],
        monday: [{ closed: true, opens: null, closes: null }],
      },
      image: "https://img.example/bar-a.jpg",
      geocode: { city: "Nashville", admin1_region: "TN", country_code: "US", name: null },
      zip: "37999",
    });
    expect(bar.properties).not.toHaveProperty("akas");
    expect(bar.properties).not.toHaveProperty("menu_url");
    expect(bar.properties).not.toHaveProperty("localities");
    expect(bar.properties).not.toHaveProperty("neighborhood");
    // Insights rows keep their top-level external arrays.
    expect(bar.external).toEqual({
      google_place: [{ id: "synthetic-gp-a", place_id: "synthetic-gp-a" }],
      tripadvisor: [{ id: "000001", rating: 4.5, rating_count: 120 }],
    });
    const store = n.value[1]!;
    expect(store.explainability).toBeUndefined();
    expect(store.location).toEqual({ lat: 36.172, lon: -86.758 });
  });

  it("normalizes /search flat results (types[] -> subtype, affinity null, release year from date)", () => {
    const n = normalizeEntityList(S.searchSidecarMovie);
    const m = n.value[0]!;
    expect(m.subtype).toBe("urn:entity:movie");
    expect(m.affinity).toBeNull();
    expect(m.properties.release_year).toBe(1987);
    expect(m.distanceM).toBeUndefined();
    expect(m.external).toEqual({ imdb: { id: "tt0000001" } });
  });

  it("F1: reads /search and /entities external ids from properties.external (not top-level)", () => {
    const n = normalizeEntityList(S.entitiesBySpotify);
    expect(n.value[0]).toMatchObject({ entityId: S.ID.actA, subtype: "urn:entity:artist", popularity: 0.77 });
    expect(n.value[0]!.external).toEqual({
      spotify: { id: "1SyntheticSpotifyId001" },
      wikidata: { id: "Q100000002" },
      lastfm: { id: "synthetic-act-a", listeners: 1000, scrobbles: 5000 },
    });
    expect(n.value[0]!.properties).not.toHaveProperty("external");
    // A top-level external block wins over properties.external when both exist.
    const both = normalizeEntity({ entity_id: "x", name: "X", external: { spotify: [{ id: "top" }] }, properties: { external: { spotify: { id: "nested" } } } });
    expect(both!.external).toEqual({ spotify: [{ id: "top" }] });
  });

  it("F14: /search tag refs {tag_id, name, type, value} and places without geohash or distance", () => {
    const person = normalizeEntityList(S.searchSidecar).value[0]!;
    expect(person.tags[0]).toEqual({ id: "urn:tag:genre:person:comedian", name: "Comedian", type: "urn:tag:genre:person" });
    // /search sometimes gives a coarser type than the id's namespace; the id is the source of truth.
    const band = normalizeEntityList(S.searchSidecar).value[1]!;
    expect(band.tags[0]).toMatchObject({ id: "urn:tag:genre:music:rock", type: "urn:tag:genre" });
    const venue = normalizeEntityList(S.searchVenue).value[0]!;
    expect(venue.location).toEqual({ lat: 36.1612, lon: -86.7785 });
    expect(venue.distanceM).toBeUndefined();
    expect(venue.external).toEqual({ google_place: { id: "synthetic-gp-1", place_id: "synthetic-gp-1" } });
  });

  it("F12: ZIP from properties.localities (ZCTA row), never from neighborhood", () => {
    expect(zipOf({ localities: [{ name: "Nashville", place: "city" }, { name: "37203", place: "ZCTA" }] })).toBe("37203");
    expect(zipOf({ localities: [{ name: "Zone", boundary: "ZCTA", locality_id: "z37219" }] })).toBe("37219");
    expect(zipOf({ localities: [{ name: "Davidson County", place: "county" }] })).toBeUndefined();
    expect(zipOf({ neighborhood: "Somewhere" })).toBeUndefined();
    expect(projectProperties({ neighborhood: "Old", business_rating: 4.2, localities: [{ name: "37203", place: "ZCTA" }] })).toEqual({
      business_rating: 4.2,
      zip: "37203",
    });
  });

  it("never throws on missing optional fields", () => {
    const e = normalizeEntity({ entity_id: "x", name: "Bare" });
    expect(e).toEqual({ entityId: "x", name: "Bare", subtype: "urn:entity", popularity: null, affinity: null, tags: [], properties: {} });
    expect(normalizeEntity({ entity_id: "x" })).toBeNull();
    expect(normalizeEntity("nope")).toBeNull();
    expect(normalizeEntity({ entity_id: "y", name: "N", query: { distance: "far" }, tags: [null, {}, { id: "urn:tag:a:b:c" }] })).toMatchObject({
      distanceM: null,
      tags: [{ id: "urn:tag:a:b:c", name: "c", type: "urn:tag:a:b" }],
    });
  });

  it("returns empty + reason for unknown shapes", () => {
    for (const body of [null, 42, {}, { results: null }, S.unknownShape]) {
      const n = normalizeEntityList(body);
      expect(n.value).toEqual([]);
      expect(n.reason).toMatch(/unexpected shape/);
    }
  });

  it("projectProperties coerces types defensively", () => {
    expect(projectProperties({ price_level: "x", is_closed: "true", release_year: "2001", image: { nope: 1 } })).toEqual({
      is_closed: true,
      release_year: 2001,
    });
  });
});

describe("heatmap", () => {
  it("maps cells, decodes missing lat/lon from geohash, skips cells without geohash", () => {
    const n = normalizeHeatmap(S.heatmap);
    expect(n.skipped).toBe(1);
    expect(n.value).toHaveLength(4);
    expect(n.value[0]).toEqual({ geohash: "dn6m9p", lat: 36.16, lon: -86.78, affinity: 1, affinityRank: 0.94, popularity: 0.99 });
    const decoded = n.value[2]!;
    expect(decoded.geohash).toBe("dn6m9n");
    expect(decoded.lat).toBeCloseTo(36.16, 1);
    expect(decoded.lon).toBeCloseTo(-86.79, 1);
    expect(n.value[3]).toMatchObject({ geohash: "dn6m3z", affinityRank: 0, popularity: 0 });
    expect(n.reason).toMatch(/1 cell\(s\) missing/);
  });

  it("empty + reason when results.heatmap is absent", () => {
    expect(normalizeHeatmap(S.placeInsights)).toMatchObject({ value: [], reason: expect.stringMatching(/heatmap/) });
  });

  it("geohash decoder is accurate", () => {
    const c = decodeGeohash("dn6m9p")!;
    expect(c.lat).toBeCloseTo(36.16, 1);
    expect(c.lon).toBeCloseTo(-86.78, 1);
    expect(decodeGeohash("a!")).toBeNull();
  });
});

describe("demographics", () => {
  it("keeps the six age buckets and gender, one block per entity", () => {
    const n = normalizeDemographics(S.demographics);
    expect(n.skipped).toBe(1);
    expect(n.value).toEqual([
      {
        entityId: S.ID.actA,
        age: { "24_and_younger": -0.2, "25_to_29": 0.43, "30_to_34": 0.7, "35_to_44": 0.1, "45_to_54": -0.53, "55_and_older": -0.6 },
        gender: { male: -0.1, female: 0.12 },
      },
      { entityId: S.ID.houseA, age: { "55_and_older": 0.3 }, gender: {} },
      { entityId: "urn:tag:genre:music:country", age: { "24_and_younger": -0.3 }, gender: { male: 0.05, female: -0.05 } },
    ]);
  });

  it("F8: a signal tag's block is keyed by entity_id holding the tag URN; blocks are matched by id, not order", () => {
    const n = normalizeDemographics({ results: { demographics: [
      { entity_id: "urn:tag:genre:music:folk", query: { age: { "25_to_29": 0.2 } } },
      { entity_id: S.ID.actA, query: { gender: { male: 0.1, female: -0.1 } } },
    ] } });
    expect(n.value.find((b) => b.entityId === S.ID.actA)?.gender).toEqual({ male: 0.1, female: -0.1 });
    expect(n.value.find((b) => b.entityId === "urn:tag:genre:music:folk")?.age).toEqual({ "25_to_29": 0.2 });
  });

  it("empty + reason on unknown shape", () => {
    expect(normalizeDemographics({ results: {} }).reason).toMatch(/demographics/);
  });
});

describe("compare", () => {
  it("maps shared tags and a/b distinctive tags (count arrives as a string)", () => {
    const n = normalizeCompare(S.compare);
    expect(n.reason).toBeUndefined();
    expect(n.value.fromTagDiff).toBe(false);
    expect(n.value.shared).toEqual([
      { id: "urn:tag:genre:music:country", name: "Country", type: "urn:tag:genre:music", subtype: "urn:tag:genre:music", score: 0.91 },
    ]);
    expect(n.value.a.map((t) => [t.id, t.count])).toEqual([
      ["urn:tag:genre:music:americana", 12],
      ["urn:tag:theme:qloo:storytelling", 7],
    ]);
    expect(n.value.b[0]).toMatchObject({ id: "urn:tag:genre:music:pop", count: 9 });
  });

  it("does not need a success field and tolerates missing sides", () => {
    const n = normalizeCompare({ results: { a: [{ tag_id: "urn:tag:x:y:z", name: "Z" }] } });
    expect(n.value.shared).toEqual([]);
    expect(n.value.a).toHaveLength(1);
    expect(normalizeCompare({ results: {} }).reason).toMatch(/unexpected shape/);
    expect(normalizeCompare(null).value).toEqual({ shared: [], a: [], b: [], fromTagDiff: false });
  });
});

describe("tags", () => {
  it("normalizes urn:tag insights with rank and affinity", () => {
    const n = normalizeTagList(S.tagProfile);
    expect(n.skipped).toBe(1);
    expect(n.value[0]).toEqual({
      id: "urn:tag:genre:music:americana",
      name: "Americana",
      type: "urn:tag:genre:music",
      subtype: "urn:tag:genre:music",
      rank: 1,
      affinity: 0.992,
      popularity: null,
      parents: ["urn:entity:artist"],
    });
    expect(n.value[1]!.rank).toBe(2);
  });

  it("normalizes /v2/tags results", () => {
    const n = normalizeTagList(S.tagsSearch);
    expect(n.value[0]).toEqual({
      id: "urn:tag:category:place:record_store",
      name: "Record Store",
      type: "urn:tag:category:place",
      rank: 1,
      affinity: null,
      popularity: 0.31,
      parents: ["urn:entity:place"],
    });
  });

  it("tag helpers", () => {
    expect(tagNamespace("urn:tag:genre:music:americana")).toBe("urn:tag:genre:music");
    expect(tagNamespace("urn:entity:place")).toBeUndefined();
    expect(normalizeTagRef({ value: "urn:tag:a:b:c", name: "C" })).toEqual({ id: "urn:tag:a:b:c", name: "C", type: "urn:tag:a:b" });
    expect(normalizeTagList({ results: {} }).reason).toMatch(/tags/);
  });
});

describe("generic insights", () => {
  it("detects the insights result kind", () => {
    expect(normalizeInsights(S.placeInsights).value.kind).toBe("entities");
    expect(normalizeInsights(S.heatmap).value.kind).toBe("heatmap");
    expect(normalizeInsights(S.demographics).value.kind).toBe("demographics");
    expect(normalizeInsights(S.tagProfile).value.kind).toBe("tags");
    const u = normalizeInsights(S.unknownShape);
    expect(u.value.kind).toBe("unknown");
    expect(u.reason).toMatch(/unexpected shape/);
  });

  it("counts rows for the ledger", () => {
    expect(countResults(S.searchSidecar)).toBe(3);
    expect(countResults(S.placeInsights)).toBe(3);
    expect(countResults(S.heatmap)).toBe(5);
    expect(countResults(S.compare)).toBe(4);
    expect(countResults(S.audiences)).toBe(1);
    expect(countResults(null)).toBe(0);
  });
});
