import { describe, expect, it } from "vitest";
import type { QlooEntity } from "@walkup/contracts";
import { chanceTopKOverlap, groundingRates, listDistance, meanPairwiseJaccard, stabilityAboveChance, tasteDependence } from "../src/p2";
import { compareArms, matchPlaces, nameSimilarity, normalizePlaceName } from "../src/arms";
import { balanceCheck, mergeRankedLists, seedInfluence } from "../src/balance";
import { place } from "./helpers";

describe("P2 metrics", () => {
  it("meanPairwiseJaccard and listDistance", () => {
    expect(meanPairwiseJaccard([["a", "b"], ["a", "b"], ["c", "d"]], 2)).toBeCloseTo(1 / 3);
    expect(meanPairwiseJaccard([["a"]])).toBeNull();
    expect(listDistance(["a", "b", "c"], ["a", "b", "c"])).toBe(0);
    expect(listDistance(["a", "b"], ["c", "d"])).toBe(1);
    expect(listDistance(["a", "b", "x"], ["a", "b", "y"], 2)).toBe(0);
  });
  it("chanceTopKOverlap = k^2/N", () => {
    expect(chanceTopKOverlap(8, 30)).toBeCloseTo(64 / 30);
    expect(chanceTopKOverlap(8, 0)).toBe(0);
    expect(chanceTopKOverlap(8, 4)).toBe(4);
  });
  it("tasteDependence: decorative when Q-S distances look like Q-Q distances", () => {
    const qq = [0.2, 0.25, 0.3, 0.2, 0.35, 0.25, 0.3, 0.2];
    const qsBig = [0.8, 0.75, 0.9, 0.85, 0.7, 0.8, 0.95, 0.9];
    const informative = tasteDependence(qsBig, qq, { seed: 4, iterations: 2000 });
    expect(informative.decorative).toBe(false);
    expect(informative.pValue).toBeLessThan(0.01);
    const decorative = tasteDependence(qq, [...qq].reverse(), { seed: 4, iterations: 2000 });
    expect(decorative.decorative).toBe(true);
    expect(tasteDependence([], qq).decorative).toBe(true);
  });
  it("stabilityAboveChance", () => {
    expect(stabilityAboveChance([5, 6, 4], 8, 30)).toEqual({ meanOverlap: 5, chance: 64 / 30, aboveChance: true });
    expect(stabilityAboveChance([], 8, 30).aboveChance).toBe(false);
  });
  it("groundingRates skip unchecked criteria", () => {
    const g = groundingRates([
      { exists: true, openOnNight: true, withinRadius: true, rightCategory: true },
      { exists: true, openOnNight: false, withinRadius: true, rightCategory: null },
      { exists: false, openOnNight: null, withinRadius: null, rightCategory: null },
      { exists: null, openOnNight: null, withinRadius: null, rightCategory: null },
    ]);
    expect(g.n).toBe(4);
    expect(g.exists).toBeCloseTo(2 / 3);
    expect(g.openOnNight).toBe(0.5);
    expect(g.rightCategory).toBe(1);
    expect(g.allPass).toBeCloseTo(1 / 3);
    expect(groundingRates([]).allPass).toBeNull();
  });
});

describe("arms", () => {
  it("compareArms", () => {
    const c = compareArms(["a", "b", "c", "d"], ["c", "a", "x"], 2);
    expect(c.overlap).toEqual(["a", "c"]);
    expect(c.onlyA).toEqual(["b", "d"]);
    expect(c.onlyB).toEqual(["x"]);
    expect(c.jaccard).toBeCloseTo(2 / 5);
    expect(c.topKOverlap).toBe(1);
    expect(c.kendallTauShared).toBe(-1);
  });
  it("name normalisation and similarity", () => {
    expect(normalizePlaceName("The Salt Shed")).toBe("salt shed");
    expect(normalizePlaceName("Grimey's New & Preloved Music")).toBe("grimeys new and preloved music");
    expect(nameSimilarity("Grimey's New & Preloved Music", "Grimeys New and Preloved Music")).toBe(1);
    expect(nameSimilarity("Caf\u00e9 Roze", "Cafe Roze")).toBe(1);
    expect(nameSimilarity("Roze Pony Cafe", "Cafe Roze Pony")).toBe(1);
    expect(nameSimilarity("The Salt Shed", "The Salt Shed Fairgrounds")).toBeLessThan(0.85);
    expect(nameSimilarity("", "")).toBe(0);
  });
  it("matchPlaces: similarity, 150 m radius, one-to-one", () => {
    const q = [
      { id: "q1", name: "Dino's Bar", lat: 36.1767, lon: -86.7541 },
      { id: "q2", name: "Three Crow Bar", lat: 36.1755, lon: -86.7515 },
      { id: "q3", name: "Far Away Dino's", lat: 36.25, lon: -86.7 },
    ];
    const f = [
      { id: "g1", name: "Dinos Bar", lat: 36.1768, lon: -86.7542 },
      { id: "g2", name: "3 Crow Bar", lat: 36.1755, lon: -86.7515 },
      { id: "g3", name: "Dino's Bar", lat: 36.3, lon: -86.6 },
      { id: "g4", name: "Dino's Bar" },
    ];
    const m = matchPlaces(q, f);
    // equal similarity: the coordinate-confirmed candidate (g1) beats the one without coordinates (g4)
    expect(m.map((x) => [x.a, x.b])).toEqual([["q1", "g1"]]);
    const noCoords = matchPlaces([{ id: "q1", name: "Dino's Bar" }], [{ id: "g4", name: "Dino's Bar" }]);
    expect(noCoords).toEqual([{ a: "q1", b: "g4", similarity: 1, distanceM: null }]);
    expect(matchPlaces([{ id: "q1", name: "Dino's Bar" }], [{ id: "g4", name: "Dino's Bar" }], { requireCoordinates: true })).toEqual([]);
    const strict = matchPlaces(q, f, { requireCoordinates: true });
    expect(strict.map((x) => [x.a, x.b])).toEqual([["q1", "g1"]]);
    expect(strict[0]!.distanceM).toBeLessThan(150);
    expect(matchPlaces(q, f, { minSimilarity: 0.5, requireCoordinates: true }).map((x) => x.a)).toContain("q2");
  });
});

function withExplain(id: string, contributions: [string, number][]): QlooEntity {
  return { ...place(id, { id }), explainability: contributions.map(([entityId, score]) => ({ entityId, score })) };
}

describe("balance check", () => {
  it("seedInfluence aggregates explainability mass", () => {
    const s = seedInfluence([withExplain("a", [["H", 0.9], ["C", 0.1]]), withExplain("b", [["H", 0.7], ["C", 0.3]])]);
    expect(s.informative).toBe(true);
    expect(s.influence.map((x) => [x.seedId, Number(x.share.toFixed(3))])).toEqual([
      ["H", 0.8],
      ["C", 0.2],
    ]);
  });
  it("not informative with one seed, equal shares or no data", () => {
    expect(seedInfluence([withExplain("a", [["H", 0.9]])]).informative).toBe(false);
    expect(seedInfluence([withExplain("a", [["H", 0.5], ["C", 0.5]])]).informative).toBe(false);
    expect(seedInfluence([place("x")]).informative).toBe(false);
    expect(seedInfluence([withExplain("a", [["H", Number.NaN], ["C", -1]])]).influence).toEqual([]);
  });
  it("triggers above 0.7 influence and on split-seed overlap", () => {
    const dominated = [withExplain("a", [["H", 0.9], ["C", 0.1]]), withExplain("b", [["H", 0.8], ["C", 0.05]])];
    const r = balanceCheck(dominated);
    expect(r.triggered).toBe(true);
    expect(r.dominantSeed).toBe("H");
    const balanced = [withExplain("a", [["H", 0.5], ["C", 0.4]])];
    expect(balanceCheck(balanced).triggered).toBe(false);
    const full = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const split = balanceCheck(balanced, { headlinerId: "H", splitSeed: { fullBill: full, headlinerOnly: [...full.slice(0, 7), "z"] } });
    expect(split.triggered).toBe(true);
    expect(split.splitSeedOverlap).toBe(7);
    expect(split.dominantSeed).toBe("H");
    expect(balanceCheck(balanced, { splitSeed: { fullBill: full, headlinerOnly: ["z", ...full.slice(0, 6)] } }).triggered).toBe(false);
  });
  it("mergeRankedLists is a weighted Borda merge with deterministic ties", () => {
    expect(mergeRankedLists([{ ids: ["a", "b", "c"], weight: 1 }])).toEqual(["a", "b", "c"]);
    expect(
      mergeRankedLists([
        { ids: ["a", "b"], weight: 1 },
        { ids: ["b", "a"], weight: 1 },
      ]),
    ).toEqual(["a", "b"]);
    expect(
      mergeRankedLists([
        { ids: ["h1", "h2", "x"], weight: 0.3 },
        { ids: ["c1", "x", "c2"], weight: 1 },
      ]),
    ).toEqual(["c1", "x", "c2", "h1", "h2"]);
    expect(mergeRankedLists([])).toEqual([]);
    expect(mergeRankedLists([{ ids: ["a", "a", "b"], weight: 1 }])).toEqual(["a", "b"]);
  });
});
