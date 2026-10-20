import { describe, expect, it } from "vitest";
import {
  averageRanks,
  commonPositions,
  jaccard,
  kendallTau,
  kendallTauRankings,
  pctRanks,
  pearson,
  permutationTest,
  spearman,
  spearmanRankings,
  topK,
  topKOverlap,
} from "../src/stats";
import { mulberry32, randInt, seedFromString, shuffleInPlace } from "../src/rng";
import { clamp, cmpNum, mean, roundTo, toFinite } from "../src/num";

describe("num helpers", () => {
  it("roundTo avoids binary artefacts and handles signs", () => {
    expect(roundTo(1.005, 2)).toBe(1.01);
    expect(roundTo(0.4127, 2)).toBe(0.41);
    expect(roundTo(-1.25, 1)).toBe(-1.3);
    expect(roundTo(1e-7, 2)).toBe(0);
    expect(roundTo(1850, 0)).toBe(1850);
    expect(Number.isNaN(roundTo(Number.NaN, 2))).toBe(true);
  });
  it("clamp maps NaN to the lower bound", () => {
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
  });
  it("mean ignores non-finite values", () => {
    expect(mean([1, Number.NaN, 3, Infinity])).toBe(2);
    expect(mean([])).toBeNull();
  });
  it("toFinite accepts numeric strings only", () => {
    expect(toFinite("2.5", 0)).toBe(2.5);
    expect(toFinite("abc", 7)).toBe(7);
    expect(toFinite(Number.NaN, 7)).toBe(7);
  });
  it("cmpNum sorts NaN last", () => {
    expect([3, Number.NaN, 1].sort(cmpNum)).toEqual([1, 3, Number.NaN]);
  });
});

describe("rng", () => {
  it("is reproducible per seed and in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
  it("different seeds diverge; seedFromString is stable", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    expect(seedFromString("plan-1")).toBe(seedFromString("plan-1"));
    expect(seedFromString("plan-1")).not.toBe(seedFromString("plan-2"));
  });
  it("shuffle is a permutation and randInt stays in range", () => {
    const r = mulberry32(7);
    const xs = Array.from({ length: 50 }, (_, i) => i);
    const s = shuffleInPlace([...xs], r);
    expect([...s].sort((a, b) => a - b)).toEqual(xs);
    for (let i = 0; i < 200; i++) {
      const v = randInt(r, 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(5);
    }
  });
});

describe("ranks", () => {
  it("averages ties", () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(averageRanks([])).toEqual([]);
  });
  it("pctRanks are in (0,1], never zero, NaN for non-finite", () => {
    const p = pctRanks([5, Number.NaN, 1, 3]);
    expect(p[0]).toBe(1);
    expect(p[2]).toBeCloseTo(1 / 3);
    expect(Number.isNaN(p[1] as number)).toBe(true);
    expect(pctRanks([7])).toEqual([1]);
    expect(pctRanks([2, 2, 2])).toEqual([2 / 3, 2 / 3, 2 / 3]);
  });
});

describe("correlations", () => {
  it("pearson/spearman basics", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1], [1])).toBeNull();
    expect(spearman([1, 2, 3, 4], [10, 100, 1000, 10000])).toBeCloseTo(1);
    expect(spearman([1, 2, Number.NaN, 4], [1, 2, 3, 4])).toBeCloseTo(1);
  });
  it("spearman matches a hand-computed value with ties", () => {
    // x ranks [1,2.5,2.5,4], y ranks [1,2,3,4] -> pearson of ranks
    expect(spearman([1, 2, 2, 3], [1, 2, 3, 4])).toBeCloseTo(0.9486833, 6);
  });
  it("kendall tau-b: perfect, reversed, ties, undefined", () => {
    expect(kendallTau([1, 2, 3, 4], [1, 2, 3, 4])).toBe(1);
    expect(kendallTau([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    // C=5, D=0... with one tie in x: n0=6, n1=1 -> 5/sqrt(5*6)
    expect(kendallTau([1, 1, 2, 3], [1, 2, 3, 4])).toBeCloseTo(5 / Math.sqrt(30), 10);
    expect(kendallTau([1, 1], [2, 2])).toBeNull();
    expect(kendallTau([], [])).toBeNull();
  });
  it("rankings variants work on shared ids only", () => {
    expect(kendallTauRankings(["a", "b", "c", "x"], ["a", "b", "c", "y"])).toBe(1);
    expect(kendallTauRankings(["a", "b", "c"], ["c", "b", "a"])).toBe(-1);
    expect(spearmanRankings(["a", "b", "c"], ["c", "b", "a"])).toBeCloseTo(-1);
    expect(commonPositions(["a", "a", "b"], ["b", "a"])).toEqual({ ids: ["a", "b"], posA: [0, 2], posB: [1, 0] });
    expect(kendallTauRankings(["a"], ["a"])).toBeNull();
  });
});

describe("sets", () => {
  it("jaccard", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a"], [])).toBe(0);
    expect(jaccard(["a", "a"], ["a"])).toBe(1);
  });
  it("topK / topKOverlap dedupe and cap", () => {
    expect(topK(["a", "a", "b", "c"], 2)).toEqual(["a", "b"]);
    expect(topK(["a"], -1)).toEqual([]);
    expect(topKOverlap(["a", "b", "c", "d"], ["d", "c", "x", "y"], 2)).toBe(0);
    expect(topKOverlap(["a", "b", "c", "d"], ["d", "c", "b", "a"], 4)).toBe(4);
    expect(topKOverlap(["a", "a", "b"], ["a", "b"], 2)).toBe(2);
  });
});

describe("permutationTest", () => {
  it("is seed-reproducible", () => {
    const a = [5, 6, 7, 8, 9];
    const b = [1, 2, 3, 4, 5];
    const r1 = permutationTest(a, b, { seed: 3, iterations: 500 });
    const r2 = permutationTest(a, b, { seed: 3, iterations: 500 });
    expect(r1).toEqual(r2);
  });
  it("detects a clear shift and not a null one", () => {
    const a = [10, 11, 12, 13, 14, 15, 16, 17];
    const b = [1, 2, 3, 4, 5, 6, 7, 8];
    const shifted = permutationTest(a, b, { seed: 1, iterations: 2000, alternative: "greater" });
    expect(shifted.observed).toBeCloseTo(9);
    expect(shifted.pValue).toBeLessThan(0.01);
    const same = permutationTest([1, 2, 3, 4], [1, 2, 3, 4], { seed: 1, iterations: 2000 });
    expect(same.pValue).toBeGreaterThan(0.5);
    const less = permutationTest(a, b, { seed: 1, iterations: 500, alternative: "less" });
    expect(less.pValue).toBeGreaterThan(0.9);
  });
  it("p-value is never zero and empty inputs are handled", () => {
    const r = permutationTest([100, 101], [0, 1], { seed: 1, iterations: 10, alternative: "greater" });
    expect(r.pValue).toBeGreaterThan(0);
    expect(permutationTest([], [1], {})).toEqual({ observed: null, pValue: 1, iterations: 0, alternative: "two-sided" });
    expect(permutationTest([Number.NaN], [1], {}).observed).toBeNull();
  });
  it("accepts a custom statistic", () => {
    const med = (xs: number[]) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)] as number;
    const r = permutationTest([9, 9, 9], [1, 1, 1], { seed: 2, iterations: 200, statistic: (a, b) => med(a) - med(b) });
    expect(r.observed).toBe(8);
  });
});
