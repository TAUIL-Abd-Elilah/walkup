import { describe, expect, it } from "vitest";
import { jaccard, kendallTau, kendallTauFromOrders, pctRank, ranks, spearman, topKOverlap } from "../lib/stats.js";

// Reference values computed with scipy.stats (spearmanr, kendalltau = tau-b, rankdata).
describe("ranks / pctRank", () => {
  it("averages ties like scipy rankdata", () => {
    expect(ranks([3, 1, 4, 1, 5])).toEqual([3, 1.5, 4, 1.5, 5]);
  });
  it("pctRank gives the top value 1", () => {
    expect(pctRank([10, 20, 30, 40])).toEqual([0.25, 0.5, 0.75, 1]);
    expect(pctRank([])).toEqual([]);
  });
});

describe("spearman", () => {
  it("matches scipy on a small example", () => {
    expect(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7])).toBeCloseTo(0.8207826816681233, 12);
  });
  it("handles ties", () => {
    expect(spearman([3, 1, 4, 1, 5, 9, 2, 6], [2, 7, 1, 8, 2, 8, 1, 8])).toBeCloseTo(0.19885368120992467, 12);
  });
  it("is 1 and -1 for monotone data", () => {
    expect(spearman([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
  });
  it("is NaN when undefined", () => {
    expect(spearman([1], [1])).toBeNaN();
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNaN();
  });
  it("rejects mismatched lengths", () => {
    expect(() => spearman([1, 2], [1])).toThrow(RangeError);
  });
});

describe("kendallTau (tau-b)", () => {
  it("matches scipy without x ties", () => {
    expect(kendallTau([1, 2, 3, 4, 5], [5, 6, 7, 8, 7])).toBeCloseTo(0.7378647873726218, 12);
  });
  it("matches scipy with ties on both sides", () => {
    expect(kendallTau([1, 1, 2, 3, 4], [2, 1, 1, 4, 3])).toBeCloseTo(0.4444444444444444, 12);
    expect(kendallTau([3, 1, 4, 1, 5, 9, 2, 6], [2, 7, 1, 8, 2, 8, 1, 8])).toBeCloseTo(0.16051447078102563, 12);
  });
  it("is NaN for constant input", () => {
    expect(kendallTau([1, 1], [1, 2])).toBeNaN();
  });
});

describe("kendallTauFromOrders", () => {
  it("is 1 for identical orders and -1 for reversed", () => {
    const a = ["a", "b", "c", "d"];
    expect(kendallTauFromOrders(a, a)).toEqual({ tau: 1, n: 4 });
    expect(kendallTauFromOrders(a, [...a].reverse()).tau).toBeCloseTo(-1, 12);
  });
  it("uses only the ids both orders contain", () => {
    const r = kendallTauFromOrders(["a", "b", "x", "c"], ["c", "b", "a", "y"]);
    expect(r.n).toBe(3);
    expect(r.tau).toBeCloseTo(-1, 12);
  });
});

describe("topKOverlap", () => {
  it("counts shared ids in the two top-k lists", () => {
    expect(topKOverlap(["a", "b", "c", "d"], ["d", "c", "x", "a"], 3)).toBe(1);
    expect(topKOverlap(["a", "b"], ["a", "b"], 8)).toBe(2);
    expect(topKOverlap(["a"], ["a"], 0)).toBe(0);
  });
});

describe("jaccard", () => {
  it("computes |A n B| / |A u B|", () => {
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5, 12);
    expect(jaccard(new Set([1]), new Set([2]))).toBe(0);
  });
  it("is NaN for two empty sets", () => {
    expect(jaccard([], [])).toBeNaN();
  });
});
