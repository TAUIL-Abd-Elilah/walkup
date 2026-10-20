import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCompare,
  buildDemographics,
  buildEntitiesByExternal,
  buildEntitiesByIds,
  buildEntityInsights,
  buildHeatmap,
  buildInsights,
  buildPlaceInsights,
  buildSearch,
  buildTagProfile,
  buildTagsSearch,
  insightsTypeUrn,
  searchTypeUrn,
  wktPoint,
} from "../src/builders";
import { DEFAULT_MONTH_GUARD_FLOOR, assertAllowedBaseUrl, envValue, loadConfig, walkupModeValue } from "../src/config";
import { QlooConfigError, QlooHostRefusedError } from "../src/errors";

const P = { lat: 36.1612, lon: -86.7785 };

describe("builders", () => {
  it("WKT is POINT(lon lat) and rejects impossible points", () => {
    expect(wktPoint(P)).toBe("POINT(-86.7785 36.1612)");
    expect(() => wktPoint({ lat: -86.7785, lon: 36.1612 })).not.toThrow(); // valid but swapped: caller's job
    expect(() => wktPoint({ lat: 136, lon: 0 })).toThrow(RangeError);
    expect(() => wktPoint({ lat: Number.NaN, lon: 0 })).toThrow(RangeError);
  });

  it("maps video game types per endpoint", () => {
    expect(searchTypeUrn("video_game")).toBe("urn:entity:videogame");
    expect(searchTypeUrn("urn:entity:video_game")).toBe("urn:entity:videogame");
    expect(insightsTypeUrn("videogame")).toBe("urn:entity:video_game");
    expect(insightsTypeUrn("urn:entity:videogame")).toBe("urn:entity:video_game");
    expect(insightsTypeUrn("podcast")).toBe("urn:entity:podcast");
    expect(insightsTypeUrn("urn:heatmap")).toBe("urn:heatmap");
    expect(insightsTypeUrn("tag")).toBe("urn:tag");
    expect(buildSearch("x", ["video_game", "artist"]).params.types).toEqual(["urn:entity:videogame", "urn:entity:artist"]);
    expect(buildEntityInsights("video_game", { signalEntities: ["a"] }).params["filter.type"]).toBe("urn:entity:video_game");
  });

  it("search: lat,lon location, radius in miles capped at 100, take default 10", () => {
    const r = buildSearch(" Hall ", ["place"], { location: P, radiusMiles: 500 });
    expect(r).toMatchObject({ method: "GET", path: "/search", cls: "search" });
    expect(r.params).toMatchObject({ query: "Hall", "filter.location": "36.1612,-86.7785", "filter.radius": 100, take: 10 });
    expect(() => buildSearch("  ", ["place"])).toThrow(TypeError);
  });

  it("entities batch by 50 and validate the external namespace", () => {
    const ids = Array.from({ length: 120 }, (_, i) => `id-${i}`);
    const reqs = buildEntitiesByIds([...ids, "id-0"]);
    expect(reqs).toHaveLength(3);
    expect((reqs[2]!.params.entity_ids as string[]).length).toBe(20);
    expect(buildEntitiesByExternal("spotify", ["s1", "s2"])[0]!.params).toEqual({ "external.spotify.ids": ["s1", "s2"] });
    expect(() => buildEntitiesByExternal("myspace", ["x"])).toThrow(TypeError);
    expect(buildEntitiesByIds([])).toEqual([]);
  });

  it("heatmap: needs a signal, metres radius, GET by default", () => {
    const r = buildHeatmap({ signalEntities: ["a", "b", "a"], point: P, radiusM: 40000.4 });
    expect(r).toMatchObject({ method: "GET", path: "/v2/insights", cls: "heatmap" });
    expect(r.params).toMatchObject({
      "filter.type": "urn:heatmap",
      "filter.location": "POINT(-86.7785 36.1612)",
      "filter.location.radius": 40000,
      "signal.interests.entities": ["a", "b"],
    });
    expect(buildHeatmap({ signalTags: ["urn:tag:genre:place:restaurant"], point: P }).params["signal.interests.tags"]).toEqual([
      "urn:tag:genre:place:restaurant",
    ]);
    expect(() => buildHeatmap({ point: P })).toThrow(TypeError);
    expect(() => buildHeatmap({ signalTags: ["restaurant"], point: P })).toThrow(/urn:tag/);
  });

  it("signals are plain GET ids, de-duplicated in order (no POST path)", () => {
    const r = buildHeatmap({ signalEntities: ["head", " co ", "support", "head"], point: P });
    expect(r.method).toBe("GET");
    expect(r.params["signal.interests.entities"]).toEqual(["head", "co", "support"]);
    expect(r).not.toHaveProperty("body");
    expect(r.note).toBeUndefined();
  });

  it("refuses heatmap boundary city/neighborhood and caps take at 50", () => {
    expect(() => buildInsights({ "filter.type": "urn:heatmap", "output.heatmap.boundary": "city" })).toThrow(/boundary/);
    expect(() => buildInsights({ "filter.type": "urn:heatmap", "output.heatmap.boundary": "Neighborhood" })).toThrow(/boundary/);
    expect(buildInsights({ "filter.type": "urn:entity:place", take: 500 }).params.take).toBe(50);
    expect(() => buildInsights({ take: 5 })).toThrow(/filter.type/);
  });

  it("place insights: stacked constraints", () => {
    const r = buildPlaceInsights({
      signalEntities: ["act"],
      point: P,
      radiusM: 2000,
      tags: ["urn:tag:category:place:bar", "urn:tag:category:place:record_store"],
      operator: "union",
      hours: "Thursday",
      priceMax: 7,
      excludeTags: ["urn:tag:category:place:night_club"],
      excludeEntities: ["venue"],
      take: 80,
      explainability: true,
      resultsEntities: ["p1", "p2"],
    });
    expect(r.params).toEqual({
      "filter.type": "urn:entity:place",
      "filter.location": "POINT(-86.7785 36.1612)",
      "filter.location.radius": 2000,
      "filter.tags": ["urn:tag:category:place:bar", "urn:tag:category:place:record_store"],
      "operator.filter.tags": "union",
      "filter.hours": "thursday",
      "filter.price_level.max": 4,
      "filter.exclude.tags": ["urn:tag:category:place:night_club"],
      "filter.exclude.entities": ["venue"],
      "filter.results.entities": ["p1", "p2"],
      "feature.explainability": true,
      take: 50,
      "signal.interests.entities": ["act"],
    });
    expect(() => buildPlaceInsights({ tags: ["bar"] })).toThrow(/urn:tag/);
  });

  it("entity insights use signal.location (not filter.location)", () => {
    const r = buildEntityInsights("podcast", { signalEntities: ["act"], signalLocationPoint: P, take: 15, explainability: true });
    expect(r.params).toMatchObject({ "filter.type": "urn:entity:podcast", "signal.location": "POINT(-86.7785 36.1612)", take: 15 });
    expect(r.params["filter.location"]).toBeUndefined();
    expect(() => buildEntityInsights("urn:heatmap", {})).toThrow(TypeError);
  });

  it("tag profile, demographics, compare, tags search", () => {
    expect(
      buildTagProfile({ signalEntities: ["act"], tagTypes: ["urn:tag:genre:music", "urn:tag:theme:qloo"], diversifyBySubtype: true, take: 30 }).params,
    ).toEqual({
      "filter.type": "urn:tag",
      "filter.tag.types": ["urn:tag:genre:music", "urn:tag:theme:qloo"],
      "diversify.by": "subtype",
      take: 30,
      "signal.interests.entities": ["act"],
    });
    expect(buildDemographics(["a", "b"]).params).toMatchObject({ "filter.type": "urn:demographics", "signal.interests.entities": ["a", "b"] });
    expect(() => buildDemographics([])).toThrow(TypeError);
    const c = buildCompare(["a"], ["b1", "b2"], 30);
    expect(c).toMatchObject({ method: "GET", path: "/v2/analysis/compare", cls: "compare" });
    expect(c.params).toMatchObject({ "a.signal.interests.entities": ["a"], "b.signal.interests.entities": ["b1", "b2"], take: 30 });
    expect(() => buildCompare([], ["b"])).toThrow(TypeError);
    expect(buildTagsSearch("record store", { parentsTypes: ["place"], semantic: true }).params).toMatchObject({
      "filter.query": "record store",
      "filter.parents.types": ["urn:entity:place"],
      "feature.semantic_search": true,
    });
  });
});

describe("config", () => {
  const cwd = resolve("/tmp/walkup-config-test");

  it("auto mode is fixture without a key and live with one", () => {
    const off = loadConfig({}, cwd);
    expect(off).toMatchObject({ mode: "fixture", requestedMode: "auto", apiKey: null, baseUrl: "https://hackathon.api.qloo.com" });
    expect(off.monthGuardFloor).toBe(DEFAULT_MONTH_GUARD_FLOOR);
    expect(off.dataDir).toBe(join(cwd, ".cache"));
    const on = loadConfig({ QLOO_API_KEY: "k-123456" }, cwd);
    expect(on.mode).toBe("live");
    expect(on.record).toBe(false);
  });

  it("explicit modes, inline comments and recording", () => {
    expect(loadConfig({ QLOO_API_KEY: "k-123456", WALKUP_MODE: "fixture" }, cwd).mode).toBe("fixture");
    expect(loadConfig({ WALKUP_MODE: "auto   # auto | live | fixture" }, cwd).mode).toBe("fixture");
    expect(() => loadConfig({ WALKUP_MODE: "live" }, cwd)).toThrow(QlooConfigError);
    expect(() => loadConfig({ WALKUP_MODE: "sometimes" }, cwd)).toThrow(QlooConfigError);
    // Recorded (Qloo no longer available): the client never calls Qloo, even with a key set.
    expect(loadConfig({ QLOO_API_KEY: "k-123456", WALKUP_MODE: "Recorded  # Qloo is off" }, cwd)).toMatchObject({ requestedMode: "recorded", mode: "fixture" });
    expect(walkupModeValue({ WALKUP_MODE: " FIXTURE # sample" })).toBe("fixture");
    expect(walkupModeValue({})).toBe("auto");
    expect(loadConfig({ WALKUP_RECORD: "1", QLOO_API_KEY: "k-123456" }, cwd).record).toBe(true);
    expect(loadConfig({ WALKUP_DATA_DIR: "/srv/data", WALKUP_FIXTURES_DIR: "fx" }, cwd)).toMatchObject({
      dataDir: resolve("/srv/data"),
      fixturesDir: join(cwd, "fx"),
    });
    expect(loadConfig({ QLOO_MONTH_GUARD_FLOOR: "200" }, cwd).monthGuardFloor).toBe(200);
  });

  it("refuses any host but the hackathon host unless QLOO_ALLOW_HOST=1", () => {
    expect(() => loadConfig({ QLOO_BASE_URL: "https://api.qloo.com" }, cwd)).toThrow(QlooHostRefusedError);
    expect(() => loadConfig({ QLOO_BASE_URL: "http://hackathon.api.qloo.com" }, cwd)).toThrow(QlooHostRefusedError);
    expect(() => loadConfig({ QLOO_BASE_URL: "not a url" }, cwd)).toThrow(QlooHostRefusedError);
    expect(loadConfig({ QLOO_BASE_URL: "https://hackathon.api.qloo.com/" }, cwd).baseUrl).toBe("https://hackathon.api.qloo.com");
    expect(loadConfig({ QLOO_BASE_URL: "http://localhost:8787", QLOO_ALLOW_HOST: "1" }, cwd)).toMatchObject({
      baseUrl: "http://localhost:8787",
      allowHost: true,
    });
    expect(() => assertAllowedBaseUrl("https://evil.example/hackathon.api.qloo.com", false)).toThrow(QlooHostRefusedError);
  });

  it("envValue trims and drops empty values", () => {
    expect(envValue({ A: "  x  " }, "A")).toBe("x");
    expect(envValue({ A: "" }, "A")).toBeUndefined();
    expect(envValue({}, "A")).toBeUndefined();
  });
});
