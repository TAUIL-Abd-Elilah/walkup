import { describe, expect, it } from "vitest";
import { RateLimiter, CallBudget, BudgetExceededError } from "../lib/probe/limiter.js";
import { isExactName, nameSimilarity, normalizeName } from "../lib/probe/names.js";
import {
  buildUrl,
  canonicalKey,
  heatmapRequest,
  insightsType,
  placeInsights,
  redactSecrets,
  searchRequest,
  searchType,
  toCurl,
  typedInsights,
  weightedHeatmapPost,
  wktPoint,
} from "../lib/probe/requests.js";
import { aggregateTiles, computeLift, topFraction } from "../lib/probe/heat.js";
import { derbyPairs, kg1Gate, kg1Venue, kg4Gate } from "../lib/probe/verdicts.js";
import { dayState } from "../lib/probe/extract.js";
import { backoffMs } from "../lib/probe/client.js";

const RYMAN = { lat: 36.1612473, lon: -86.7784951 };

describe("WKT and coordinates", () => {
  it("writes POINT(lon lat), longitude first", () => {
    expect(wktPoint(RYMAN)).toBe("POINT(-86.7784951 36.1612473)");
  });
  it("rejects out-of-range points (a swapped pair outside the lat range fails)", () => {
    expect(() => wktPoint({ lat: -122.4, lon: 47.2 })).toThrow(RangeError);
  });
  it("/search filter.location is lat,lon with a radius in miles", () => {
    const s = searchRequest({ query: "Ryman Auditorium", kinds: ["place"], near: { ...RYMAN, radiusMiles: 1 } });
    expect(s.params["filter.location"]).toBe("36.1612473,-86.7784951");
    expect(s.params["filter.radius"]).toBe(1);
  });
});

describe("type spelling", () => {
  it("insights filter.type uses video_game; /search types uses videogame", () => {
    expect(insightsType("video_game")).toBe("urn:entity:video_game");
    expect(searchType("video_game")).toBe("urn:entity:videogame");
    expect(searchType("tv_show")).toBe("urn:entity:tv_show");
  });
  it("search requests carry `types`, never filter.type", () => {
    const s = searchRequest({ query: "Zelda", kinds: ["video_game", "movie"] });
    expect(s.path).toBe("/search");
    expect(s.params.types).toBe("urn:entity:videogame,urn:entity:movie");
    expect(s.params["filter.type"]).toBeUndefined();
  });
});

describe("insights builders", () => {
  it("place insights stack filters and cap take at 50", () => {
    const r = placeInsights({
      point: RYMAN,
      radiusM: 1500,
      signalEntities: ["e1", "e2"],
      tags: ["t1", "t2"],
      tagsOperator: "union",
      resultsEntities: ["p1"],
      hours: "thursday",
      explainability: true,
      take: 30,
      label: "x",
    });
    expect(r.params).toMatchObject({
      "filter.type": "urn:entity:place",
      "signal.interests.entities": "e1,e2",
      "filter.location": "POINT(-86.7784951 36.1612473)",
      "filter.location.radius": 1500,
      "filter.tags": "t1,t2",
      "operator.filter.tags": "union",
      "filter.results.entities": "p1",
      "filter.hours": "thursday",
      "feature.explainability": true,
      take: 30,
    });
    expect(() => placeInsights({ take: 51, label: "x" })).toThrow(RangeError);
  });
  it("typed insights put location in signal.location, never filter.location", () => {
    const r = typedInsights({ kind: "brand", signalEntities: ["e"], signalLocation: RYMAN, excludeTags: ["a", "b"], take: 15, label: "x" });
    expect(r.params["signal.location"]).toBe("POINT(-86.7784951 36.1612473)");
    expect(r.params["filter.location"]).toBeUndefined();
    expect(r.params["filter.exclude.tags"]).toBe("a,b");
  });
  it("heatmaps send no take and no boundary, and need a signal", () => {
    const h = heatmapRequest({ point: RYMAN, radiusM: 40000, signalTags: ["urn:tag:genre:place:restaurant"], label: "x" });
    expect(h.params.take).toBeUndefined();
    expect(h.params["output.heatmap.boundary"]).toBeUndefined();
    expect(h.params["filter.type"]).toBe("urn:heatmap");
    expect(() => heatmapRequest({ point: RYMAN, radiusM: 1, label: "x" })).toThrow();
  });
  it("weighted heatmaps POST {entity, weight} objects", () => {
    const p = weightedHeatmapPost({ point: RYMAN, radiusM: 40000, weighted: [{ entity: "a", weight: 10 }], label: "x" });
    expect(p.method).toBe("POST");
    expect(p.body?.["signal.interests.entities"]).toEqual([{ entity: "a", weight: 10 }]);
    expect(p.body?.["filter.location"]).toBe("POINT(-86.7784951 36.1612473)");
  });
});

describe("urls, memo keys, curl and redaction", () => {
  it("canonical key ignores param order", () => {
    const a = { method: "GET" as const, path: "/v2/tags", params: { a: 1, b: "x" }, label: "1" };
    const b = { method: "GET" as const, path: "/v2/tags", params: { b: "x", a: 1 }, label: "2" };
    expect(canonicalKey(a)).toBe(canonicalKey(b));
  });
  it("curl references the key as an env var and the URL never holds it", () => {
    const s = searchRequest({ query: "SZA", kinds: ["artist"] });
    expect(buildUrl("https://example.test", s)).toBe("https://example.test/search?query=SZA&types=urn%3Aentity%3Aartist&take=5");
    expect(toCurl("https://example.test", s)).toContain('-H "X-Api-Key: $QLOO_API_KEY"');
  });
  it("quotes POST bodies safely for a POSIX shell", () => {
    const c = toCurl("https://example.test", { method: "POST", path: "/v2/insights", params: {}, body: { a: "O'Brien" }, label: "x" });
    expect(c).toContain(String.raw`--data '{"a":"O'\''Brien"}'`);
  });
  it("redacts secrets", () => {
    expect(redactSecrets("key=abcd1234 again abcd1234", ["abcd1234"])).toBe("key=[REDACTED] again [REDACTED]");
  });
});

describe("pacing and budget", () => {
  it("spaces request starts at 1000/rate ms", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const clock = { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)) };
    const lim = new RateLimiter(3, clock);
    for (let i = 0; i < 4; i++) await lim.acquire();
    expect(sleeps.map((s) => Math.round(s))).toEqual([333, 333, 333]);
    expect(Math.round(t)).toBe(1000);
  });
  it("budget throws at the cap", () => {
    const b = new CallBudget(2);
    b.take();
    b.take();
    expect(() => b.take()).toThrow(BudgetExceededError);
    expect(b.used).toBe(2);
  });
  it("backoff honours retry-after and grows otherwise", () => {
    expect(backoffMs(0, "2")).toBe(2000);
    expect(backoffMs(0, undefined)).toBe(1000);
    expect(backoffMs(1, undefined)).toBe(2000);
  });
});

describe("names", () => {
  it("normalizes club and act names", () => {
    expect(normalizeName("Arsenal F.C.")).toBe("arsenal fc");
    expect(normalizeName("The Late Shift Diner")).toBe("late shift diner");
    expect(isExactName("Arsenal FC", ["Arsenal F.C."])).toBe(true);
  });
  it("similarity is 1 for equal names and low for different ones", () => {
    expect(nameSimilarity("Tootsie's Orchid Lounge", "Tootsies Orchid Lounge")).toBe(1);
    expect(nameSimilarity("Ryman Auditorium", "Bridgestone Arena")).toBeLessThan(0.5);
  });
});

describe("hours parsing", () => {
  it("reads closed days from common shapes", () => {
    expect(dayState({ Thursday: [] }, "thursday")).toBe("closed");
    expect(dayState({ Thursday: [{ opens: "T11:00", closes: "T22:00" }] }, "thursday")).toBe("open");
    expect(dayState({ thu: "Closed" }, "thursday")).toBe("closed");
    expect(dayState(null, "thursday")).toBe("unknown");
  });
});

describe("lift math", () => {
  it("joins on geohash-6 and ranks within each heatmap", () => {
    const bill = [
      { geohash: "dn6m9aa", affinity: 0.9, popularity: 1 },
      { geohash: "dn6m9ab", affinity: 0.7, popularity: 1 },
      { geohash: "dn6m9b1", affinity: 0.1, popularity: 1 },
    ];
    const house = [
      { geohash: "dn6m9az", affinity: 0.1, popularity: 1 },
      { geohash: "dn6m9b2", affinity: 0.9, popularity: 1 },
    ];
    const bt = aggregateTiles(bill);
    expect(bt.get("dn6m9a")?.affinity).toBeCloseTo(0.8, 12);
    const rows = computeLift(bt, aggregateTiles(house), { shrinkBelow: 0 });
    const a = rows.find((r) => r.geohash === "dn6m9a")!;
    const b = rows.find((r) => r.geohash === "dn6m9b")!;
    expect(a.lift).toBeCloseTo(1 / 0.5, 12);
    expect(b.lift).toBeCloseTo(0.5 / 1, 12);
    expect([...topFraction(rows, 0.1)]).toEqual(["dn6m9a"]);
  });
  it("shrinks lift toward 1 in low-popularity tiles", () => {
    const rows = computeLift(
      aggregateTiles([
        { geohash: "aaaaaa", affinity: 1, popularity: 0.05 },
        { geohash: "bbbbbb", affinity: 0, popularity: 0.05 },
      ]),
      aggregateTiles([
        { geohash: "aaaaaa", affinity: 0, popularity: 0.05 },
        { geohash: "bbbbbb", affinity: 1, popularity: 0.05 },
      ]),
      { shrinkBelow: 0.2 },
    );
    const a = rows.find((r) => r.geohash === "aaaaaa")!;
    expect(a.lift).toBeCloseTo(1 + (1 / 0.5 - 1) * 0.25, 12);
  });
});

describe("gate arithmetic", () => {
  const pool = Array.from({ length: 30 }, (_, i) => `p${i}`);
  const t = { topK: 8, maxTau: 0.8, maxTopKOverlap: 5, minPool: 10, minCoverage: 0.8 };
  it("KG1 fails when both bills return the popularity order", () => {
    const m = kg1Venue(pool, pool, pool, t);
    expect(m.tauAB).toBeCloseTo(1, 12);
    expect(m.topKAB).toBe(8);
    expect(m.pass).toBe(false);
    expect(m.evaluable).toBe(true);
  });
  it("KG1 passes when the bills reorder the pool differently", () => {
    const a = [...pool].reverse();
    const b = [...pool.slice(15), ...pool.slice(0, 15)];
    const m = kg1Venue(pool, a, b, t);
    expect(m.pass).toBe(true);
  });
  it("KG1 is not evaluable when filter.results.entities is ignored", () => {
    const m = kg1Venue(pool, ["q1", "q2"], ["q3"], t);
    expect(m.evaluable).toBe(false);
    expect(m.reason).toMatch(/covered/);
  });
  it("KG1 gate needs enough evaluable rooms", () => {
    const pass = kg1Venue(pool, [...pool].reverse(), [...pool.slice(15), ...pool.slice(0, 15)], t);
    const fail = kg1Venue(pool, pool, pool, t);
    expect(kg1Gate([pass, pass], 2).status).toBe("pass");
    expect(kg1Gate([pass, fail], 2).status).toBe("fail");
    expect(kg1Gate([pass], 2).status).toBe("inconclusive");
  });
  it("KG4 thresholds and the derby pairs", () => {
    const rows = [
      { club: "a", metro: "m", barListed: true, resolved: true, rank: 3 },
      { club: "b", metro: "m", barListed: true, resolved: true, rank: null },
    ];
    expect(kg4Gate(rows, 6, 3).status).toBe("inconclusive");
    const lists = new Map<string, string[]>([
      ["a|m", ["x", "barA", "barB"]],
      ["b|m", ["barA", "y"]],
    ]);
    const bars = new Map([
      ["a|m", "barA"],
      ["b|m", "barB"],
    ]);
    expect(derbyPairs(lists, bars, ["a", "b"], ["m"])).toEqual({ correct: 1, total: 2 });
  });
});
