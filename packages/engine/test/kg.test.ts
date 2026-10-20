import { describe, expect, it } from "vitest";
import { evaluateKG1, evaluateKG2, KG1_THRESHOLDS, KG2_THRESHOLDS } from "../src/kg";
import { gridGeohash6, heatMap } from "./helpers";

const ids = Array.from({ length: 30 }, (_, i) => `P${String(i).padStart(2, "0")}`);
const reversed = [...ids].reverse();
const popularity = [...ids.slice(10, 18), ...ids.slice(0, 10), ...ids.slice(18)];

describe("evaluateKG1", () => {
  it("passes when bills reorder the pool and differ from popularity", () => {
    const r = evaluateKG1([{ venue: "Room A", billA: ids, billB: reversed, popularity }]);
    expect(r.pass).toBe(true);
    expect(r.venues[0]).toMatchObject({ kendallTauBills: -1, topOverlapBills: 0, topOverlapAVsPop: 0, topOverlapBVsPop: 0, commonItems: 30, failures: [] });
    expect(r.thresholds).toEqual({ ...KG1_THRESHOLDS, requireAll: true });
  });
  it("fails when the bills produce the same order", () => {
    const r = evaluateKG1([{ venue: "Room A", billA: ids, billB: ids, popularity }]);
    expect(r.pass).toBe(false);
    expect(r.venues[0]!.failures).toEqual(["Kendall tau 1.000 >= 0.8", "top-8 overlap between bills 8/8 > 5"]);
  });
  it("fails when a bill just reproduces popularity", () => {
    const r = evaluateKG1([{ venue: "Room A", billA: ids, billB: reversed, popularity: ids }]);
    expect(r.pass).toBe(false);
    expect(r.venues[0]!.failures).toEqual(["top-8 overlap bill A vs popularity 8/8 > 5"]);
  });
  it("boundary: overlap exactly 5/8 passes, 6/8 fails", () => {
    const b5 = [...ids.slice(0, 5), ...ids.slice(20, 23), ...ids.slice(5, 20), ...ids.slice(23)];
    const b6 = [...ids.slice(0, 6), ...ids.slice(20, 22), ...ids.slice(6, 20), ...ids.slice(22)];
    const scramble = (xs: string[]) => [...xs.slice(15), ...xs.slice(0, 15)].reverse();
    expect(evaluateKG1([{ venue: "v", billA: ids, billB: scramble(b5), popularity: reversed }]).venues[0]!.topOverlapBills).toBeLessThanOrEqual(8);
    const r5 = evaluateKG1([{ venue: "v", billA: ids, billB: b5, popularity: reversed }], { maxTau: 1.01 });
    const r6 = evaluateKG1([{ venue: "v", billA: ids, billB: b6, popularity: reversed }], { maxTau: 1.01 });
    expect(r5.venues[0]!.topOverlapBills).toBe(5);
    expect(r5.pass).toBe(true);
    expect(r6.venues[0]!.topOverlapBills).toBe(6);
    expect(r6.pass).toBe(false);
  });
  it("requireAll vs majority; empty input; short lists; no shared items", () => {
    const good = { venue: "g", billA: ids, billB: reversed, popularity };
    const bad = { venue: "b", billA: ids, billB: ids, popularity };
    expect(evaluateKG1([good, good, bad]).pass).toBe(false);
    expect(evaluateKG1([good, good, bad], { requireAll: false }).pass).toBe(true);
    expect(evaluateKG1([good, good, bad]).venuesPassed).toBe(2);
    expect(evaluateKG1([]).pass).toBe(false);
    const short = evaluateKG1([{ venue: "s", billA: ["a", "b", "c"], billB: ["c", "b", "a"], popularity: ["x"] }]);
    expect(short.venues[0]!.failures).toContain("fewer than 8 ranked items");
    const disjoint = evaluateKG1([{ venue: "d", billA: ids.slice(0, 10), billB: ids.slice(10, 20), popularity: ids.slice(20) }]);
    expect(disjoint.venues[0]!.kendallTauBills).toBeNull();
    expect(disjoint.pass).toBe(false);
  });
});

describe("evaluateKG2", () => {
  const tiles = gridGeohash6(40);
  const gradient = (i: number) => i;
  const house = heatMap(tiles, gradient, () => 0.9);
  const generic = heatMap(tiles, gradient, () => 0.9);
  const bumpA = (i: number) => (i % 10 === 3 ? 100 : 0);
  const bumpB = (i: number) => (i % 10 === 7 ? 100 : 0);

  // Each half of a bill keeps the bill's bumps, with its own small jitter.
  const half = (bump: (i: number) => number, k: number) => heatMap(tiles, (i) => gradient(i) + bump(i) + ((i * 7 + k * 13) % 5) / 10, () => 0.9);
  const billWithHalves = (label: string, bump: (i: number) => number) => ({
    label,
    heat: heatMap(tiles, (i) => gradient(i) + bump(i), () => 0.9),
    halves: { billA: half(bump, 1), billB: half(bump, 2), houseA: house, houseB: house },
  });

  it("passes when each bill has its own over-indexing tiles that hold up in both halves", () => {
    const r = evaluateKG2({ house, generic, bills: [billWithHalves("bill A", bumpA), billWithHalves("bill B", bumpB)] });
    expect(r.failures).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.topDecileJaccard).toBe(0);
    expect(r.bills[0]!.topTiles).toHaveLength(4);
    expect(r.bills[0]!.splitHalfSpearman as number).toBeGreaterThan(0.5);
    expect(r.thresholds).toEqual(KG2_THRESHOLDS);
    expect(KG2_THRESHOLDS.minSplitHalf).toBe(0.5);
  });
  it("fails when the two halves disagree, or when the split-half check did not run", () => {
    const disagree = { ...billWithHalves("bill A", bumpA), halves: { billA: half(bumpA, 1), billB: half(bumpB, 2) } };
    const r = evaluateKG2({ house, generic, bills: [disagree, billWithHalves("bill B", bumpB)] });
    expect(r.pass).toBe(false);
    expect(r.bills[0]!.pass).toBe(false);
    expect(r.failures.some((f) => /^bill A: split-half Spearman -?\d\.\d{3} <= 0\.5$/.test(f))).toBe(true);
    const oneSeed = { label: "bill A", heat: heatMap(tiles, (i) => gradient(i) + bumpA(i), () => 0.9) };
    const r2 = evaluateKG2({ house, generic, bills: [oneSeed, billWithHalves("bill B", bumpB)] });
    expect(r2.pass).toBe(false);
    expect(r2.bills[0]!.splitHalfSpearman).toBeNull();
    expect(r2.failures).toContain("bill A: split-half check not run (needs two halves of seeds)");
    // Diagnostics without the requirement (e.g. reading an old probe output).
    expect(evaluateKG2({ house, generic, bills: [oneSeed, billWithHalves("bill B", bumpB)] }, { requireSplitHalf: false }).pass).toBe(true);
  });
  it("fails when lift tracks raw heat (flat house) and when both bills pick the same tiles", () => {
    const flatHouse = heatMap(tiles, () => 0.5, () => 0.9);
    const bill = heatMap(tiles, gradient, () => 0.9);
    const r = evaluateKG2({ house: flatHouse, generic, bills: [{ label: "A", heat: bill }, { label: "B", heat: bill }] }, { requireSplitHalf: false });
    expect(r.pass).toBe(false);
    expect(r.failures.some((f) => f.startsWith("A: Spearman(lift, raw heat)"))).toBe(true);
    expect(r.failures.some((f) => f.startsWith("top-decile tile Jaccard 1.000"))).toBe(true);
  });
  it("needs two bills and handles empty maps", () => {
    expect(evaluateKG2({ house, bills: [{ label: "A", heat: house }] }).failures).toContain("KG2 needs two bills");
    const empty = evaluateKG2({ house: [], bills: [{ label: "A", heat: [] }, { label: "B", heat: [] }] });
    expect(empty.pass).toBe(false);
    expect(empty.bills[0]!.tiles).toBe(0);
    expect(empty.topDecileJaccard).toBe(1);
  });
});
