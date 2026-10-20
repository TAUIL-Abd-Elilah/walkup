import { describe, expect, it } from "vitest";
import type { HeatCell, LiftTile } from "@walkup/contracts";
import {
  compareLiftTiles,
  computeLift,
  computeLiftAll,
  computeLiftMap,
  LIFT_DEFAULTS,
  liftBounds,
  liftDiagnostics,
  liftMethod,
  liftScore,
  liftVsOwnHeat,
  selectTopTiles,
  splitHalfAgreement,
  splitHalves,
} from "../src/lift";
import { shuffleInPlace } from "../src/rng";
import { cell, child7, gridGeohash6, heatMap, rng } from "./helpers";

function byGh(tiles: LiftTile[]): Map<string, LiftTile> {
  return new Map(tiles.map((t) => [t.geohash, t]));
}

function randomMap(tiles: string[], seed: number, opts: { popLow?: boolean } = {}): HeatCell[] {
  const r = rng(seed);
  return tiles.map((t, i) => cell(child7(t, i), Math.round(r() * 20) / 20, opts.popLow ? r() * 0.3 : r()));
}

const TRIALS = 60;

describe("computeLift: edge cases", () => {
  it("empty maps", () => {
    expect(computeLiftAll([], [])).toEqual([]);
    expect(computeLift([], [])).toEqual([]);
    const m = computeLiftMap([], []);
    expect(m.all).toEqual([]);
    expect(m.top).toEqual([]);
    expect(m.diagnostics).toMatchObject({ spearmanLiftVsHeat: null, liftWeak: false, insufficient: true, n: 0 });
    expect(m.coverage).toEqual({ billCells: 0, houseCells: 0, billTiles: 0, houseTiles: 0, joinedTiles: 0 });
  });
  it("one side empty or disjoint maps give no tiles", () => {
    const tiles = gridGeohash6(6);
    const bill = heatMap(tiles.slice(0, 3), (i) => i / 3);
    const house = heatMap(tiles.slice(3), (i) => i / 3);
    expect(computeLiftAll(bill, [])).toEqual([]);
    expect(computeLiftAll(bill, house)).toEqual([]);
  });
  it("a single joined cell has lift 1 and is never a top tile", () => {
    const [g] = gridGeohash6(1) as [string];
    const all = computeLiftAll([cell(g + "0", 0.9)], [cell(g + "1", 0.1)]);
    expect(all).toHaveLength(1);
    expect(all[0]!.lift).toBe(1);
    expect(all[0]!.billPct).toBe(1);
    expect(computeLift([cell(g + "0", 0.9)], [cell(g + "1", 0.1)])).toEqual([]);
  });
  it("NaN cells are ignored rather than poisoning ranks", () => {
    const tiles = gridGeohash6(4);
    const bill = [...heatMap(tiles, (i) => i / 4), cell(child7(tiles[0] as string, 9), Number.NaN)];
    const house = heatMap(tiles, () => 0.5);
    const all = computeLiftAll(bill, house);
    expect(all).toHaveLength(4);
    for (const t of all) expect(Number.isFinite(t.lift)).toBe(true);
  });
});

describe("computeLift: worked example", () => {
  const tiles = gridGeohash6(4);
  const bill = heatMap(tiles, (i) => [0.1, 0.2, 0.3, 0.4][i] as number, () => 0.9);
  const house = heatMap(tiles, (i) => [0.4, 0.3, 0.2, 0.1][i] as number, () => 0.9);

  it("lift = (billPct + 0.5) / (housePct + 0.5) when popularity is high", () => {
    const m = byGh(computeLiftAll(bill, house));
    expect(m.get(tiles[0] as string)!.lift).toBeCloseTo(0.75 / 1.5);
    expect(m.get(tiles[1] as string)!.lift).toBeCloseTo(1 / 1.25);
    expect(m.get(tiles[2] as string)!.lift).toBeCloseTo(1.25 / 1);
    expect(m.get(tiles[3] as string)!.lift).toBeCloseTo(1.5 / 0.75);
    expect(m.get(tiles[3] as string)!.billPct).toBe(1);
    expect(m.get(tiles[3] as string)!.housePct).toBe(0.25);
  });
  it("sorted by lift descending; top tiles use minLift 1.3 and the 0.7 bill floor", () => {
    const all = computeLiftAll(bill, house);
    expect(all.map((t) => t.geohash)).toEqual([tiles[3], tiles[2], tiles[1], tiles[0]]);
    expect(computeLift(bill, house).map((t) => t.geohash)).toEqual([tiles[3]]);
    expect(computeLift(bill, house, { minLift: 2 }).map((t) => t.geohash)).toEqual([tiles[3]]);
    expect(computeLift(bill, house, { minLift: 1.2 }).map((t) => t.geohash)).toEqual([tiles[3], tiles[2]]);
  });
  it("smoothing sets how far the ratio can go", () => {
    const m = byGh(computeLiftAll(bill, house, { smoothing: 0.25 }));
    expect(m.get(tiles[3] as string)!.lift).toBeCloseTo(1.25 / 0.5);
    expect(m.get(tiles[0] as string)!.lift).toBeCloseTo(0.5 / 1.25);
    expect(liftBounds(0.5).min).toBeCloseTo(1 / 3, 12);
    expect(liftBounds(0.5).max).toBeCloseTo(3, 12);
  });
});

describe("computeLift: the bounded score and the bill floor", () => {
  it("a tile the house barely ranks no longer dwarfs one where both crowds are strong", () => {
    // The raw ratio with a 0.05 floor gave 0.55/0.08 = 6.9 against 0.98/0.60 = 1.6.
    const thin = liftScore(0.55, 0.08);
    const strong = liftScore(0.98, 0.6);
    expect(thin).toBeCloseTo(1.05 / 0.58, 10);
    expect(strong).toBeCloseTo(1.48 / 1.1, 10);
    expect(thin / strong).toBeLessThan(1.5);
    expect(0.55 / 0.08 / (0.98 / 0.6)).toBeGreaterThan(4);
  });
  it("the bill floor keeps the thin tile off the top list and keeps the strong one", () => {
    const mk = (geohash: string, b: number, h: number): LiftTile => ({ geohash, lat: 0, lon: 0, lift: liftScore(b, h), billPct: b, housePct: h, popularityPct: 0.9 });
    const tiles = [mk("thin00", 0.55, 0.08), mk("strong", 0.98, 0.6)];
    expect(selectTopTiles(tiles).map((t) => t.geohash)).toEqual(["strong"]);
    expect(LIFT_DEFAULTS.billFloor).toBe(0.7);
    expect(selectTopTiles(tiles, { minBillPct: 0 }).map((t) => t.geohash)).toEqual(["thin00", "strong"]);
    expect(selectTopTiles(tiles, { minBillPct: 0.99 })).toEqual([]);
  });
  it("liftScore is monotone: up in billPct, down in housePct, and 1 when they match", () => {
    for (let b = 0.05; b <= 1; b += 0.05) {
      expect(liftScore(b, b)).toBeCloseTo(1, 12);
      expect(liftScore(b, 0.5)).toBeGreaterThan(liftScore(b - 0.04, 0.5));
      expect(liftScore(0.5, b)).toBeLessThan(liftScore(0.5, b - 0.04));
    }
    expect(liftScore(0.9, 0.3, { weight: 0 })).toBe(1);
    expect(Number.isNaN(liftScore(Number.NaN, 0.3))).toBe(true);
  });
  it("describes the method in one plain line with the thresholds", () => {
    const m = liftMethod();
    // Same 0-100 scale as the percentiles the sheet prints: (91 + 50) / (27 + 50) is the 1.83 shown for 0.91 vs 0.27.
    expect(m).toContain("(this crowd's percentile + 50) / (the usual crowd's percentile + 50)");
    expect(liftScore(0.91, 0.27)).toBeCloseTo((91 + 50) / (27 + 50), 12);
    expect(m).toContain("percentile 70 or higher");
    expect(m).toContain("1.3");
    expect(liftMethod({ minBillPct: 0.8, smoothing: 0.25 })).toContain("percentile 80 or higher");
    expect(liftMethod({ minBillPct: 0.8, smoothing: 0.25 })).toContain("percentile + 25)");
  });
});

describe("computeLift: shrinkage toward 1", () => {
  const tiles = gridGeohash6(8);
  // bill rises, house falls; popularity distinct so popPct = (i+1)/8
  const bill = heatMap(tiles, (i) => i, (i) => (i + 1) / 10);
  const house = heatMap(tiles, (i) => 8 - i, (i) => (i + 1) / 10);

  it("w = min(1, popPct / tau), applied to the log score", () => {
    const shrunk = byGh(computeLiftAll(bill, house, { shrinkTau: 0.25 }));
    const raw = byGh(computeLiftAll(bill, house, { shrinkTau: 0 }));
    const g0 = tiles[0] as string; // popPct 1/8 -> w = 0.5
    const g1 = tiles[1] as string; // popPct 2/8 -> w = 1
    expect(shrunk.get(g0)!.popularityPct).toBeCloseTo(0.125);
    expect(shrunk.get(g0)!.lift).toBeCloseTo(raw.get(g0)!.lift ** 0.5);
    expect(shrunk.get(g1)!.lift).toBeCloseTo(raw.get(g1)!.lift);
  });
  it("popularitySource picks which map drives the shrink", () => {
    const flatHouse = heatMap(tiles, (i) => 8 - i, () => 0.9);
    const viaBill = byGh(computeLiftAll(bill, flatHouse, { popularitySource: "bill" }));
    const viaHouse = byGh(computeLiftAll(bill, flatHouse, { popularitySource: "house" }));
    const viaMin = byGh(computeLiftAll(bill, flatHouse, { popularitySource: "min" }));
    const viaMean = byGh(computeLiftAll(bill, flatHouse, { popularitySource: "mean" }));
    const g0 = tiles[0] as string;
    expect(viaBill.get(g0)!.popularityPct).toBeCloseTo(0.125);
    expect(viaHouse.get(g0)!.popularityPct).toBeCloseTo(4.5 / 8);
    expect(viaMin.get(g0)!.popularityPct).toBeCloseTo(0.125);
    expect(viaMean.get(g0)!.popularityPct).toBeCloseTo(0.125);
  });
  it("missing popularity counts as the thinnest signal", () => {
    const noPop = tiles.map((t, i) => ({ ...cell(child7(t, i), i), popularity: Number.NaN }));
    const all = computeLiftAll(noPop, heatMap(tiles, (i) => 8 - i, () => Number.NaN));
    for (const t of all) expect(t.popularityPct).toBeCloseTo(4.5 / 8);
  });
});

describe("computeLift: properties (seeded random maps)", () => {
  it("identical bill and house give lift 1 everywhere and no top tiles", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const tiles = gridGeohash6(5 + (s % 30));
      const m = randomMap(tiles, s);
      const all = computeLiftAll(m, m);
      for (const t of all) expect(t.lift).toBeCloseTo(1, 12);
      expect(computeLift(m, m)).toEqual([]);
    }
  });
  it("shrunk lift lies between 1 and the raw lift, and inside [a / (1 + a), (1 + a) / a]", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const tiles = gridGeohash6(3 + (s % 40));
      const bill = randomMap(tiles, s);
      const house = randomMap(tiles, s + 1000, { popLow: s % 2 === 0 });
      const smoothing = [0.1, 0.5, 1][s % 3] as number;
      const { min, max } = liftBounds(smoothing);
      const shrunk = byGh(computeLiftAll(bill, house, { smoothing }));
      for (const t of computeLiftAll(bill, house, { smoothing, shrinkTau: 0 })) {
        const sh = shrunk.get(t.geohash)!.lift;
        expect(sh).toBeGreaterThanOrEqual(Math.min(1, t.lift) - 1e-12);
        expect(sh).toBeLessThanOrEqual(Math.max(1, t.lift) + 1e-12);
        expect(t.lift).toBeLessThanOrEqual(max + 1e-9);
        expect(t.lift).toBeGreaterThanOrEqual(min - 1e-9);
      }
    }
  });
  it("a larger tau never moves lift further from 1", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const tiles = gridGeohash6(10 + (s % 20));
      const bill = randomMap(tiles, s);
      const house = randomMap(tiles, s + 77);
      const a = byGh(computeLiftAll(bill, house, { shrinkTau: 0.1 }));
      for (const t of computeLiftAll(bill, house, { shrinkTau: 0.6 })) {
        expect(Math.abs(t.lift - 1)).toBeLessThanOrEqual(Math.abs(a.get(t.geohash)!.lift - 1) + 1e-12);
      }
    }
  });
  it("invariant to input order and to monotone transforms of affinity", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const tiles = gridGeohash6(4 + (s % 25));
      const bill = randomMap(tiles, s);
      const house = randomMap(tiles, s + 5);
      const base = computeLiftAll(bill, house);
      const shuffled = computeLiftAll(shuffleInPlace([...bill], rng(s)), shuffleInPlace([...house], rng(s + 1)));
      expect(shuffled).toEqual(base);
      const transformed = computeLiftAll(
        bill.map((c) => ({ ...c, affinity: Math.exp(3 * c.affinity) + 10 })),
        house,
      );
      expect(transformed.map((t) => [t.geohash, t.lift])).toEqual(base.map((t) => [t.geohash, t.lift]));
    }
  });
  it("output is sorted by compareLiftTiles with geohash as the last tie-break", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const tiles = gridGeohash6(6 + (s % 30));
      const all = computeLiftAll(randomMap(tiles, s), randomMap(tiles, s + 9));
      for (let i = 1; i < all.length; i++) expect(compareLiftTiles(all[i - 1]!, all[i]!)).toBeLessThan(0);
    }
  });
  it("ties are broken deterministically by geohash", () => {
    const tiles = gridGeohash6(6);
    const flat = heatMap(tiles, () => 0.5, () => 0.5);
    const all = computeLiftAll(flat, flat);
    expect(all.map((t) => t.geohash)).toEqual([...tiles].sort());
  });
  it("swapping bill and house inverts the ordering of raw lift", () => {
    for (let s = 1; s <= 20; s++) {
      const tiles = gridGeohash6(12);
      const bill = tiles.map((t, i) => cell(child7(t, i), (i * 7 + s) % 12, 0.9));
      const house = tiles.map((t, i) => cell(child7(t, i), (i * 5 + 2 * s) % 12, 0.9));
      const ab = byGh(computeLiftAll(bill, house, { shrinkTau: 0 }));
      for (const t of computeLiftAll(house, bill, { shrinkTau: 0 })) {
        expect(t.lift * ab.get(t.geohash)!.lift).toBeCloseTo(1, 10);
      }
    }
  });
});

describe("rankOver", () => {
  it("joined ranks ignore tiles only one map has; full ranks use them", () => {
    const tiles = gridGeohash6(4);
    const bill = [...heatMap(tiles.slice(0, 2), (i) => [0.2, 0.4][i] as number), ...heatMap(tiles.slice(2), () => 0.9)];
    const house = heatMap(tiles.slice(0, 2), (i) => [0.4, 0.2][i] as number);
    const joined = byGh(computeLiftAll(bill, house));
    const full = byGh(computeLiftAll(bill, house, { rankOver: "full" }));
    expect(joined.get(tiles[1] as string)!.billPct).toBe(1);
    expect(full.get(tiles[1] as string)!.billPct).toBe(0.5);
  });
});

describe("selectTopTiles", () => {
  const tiles = gridGeohash6(5);
  const bill = heatMap(tiles, (i) => i, () => 0.9);
  const house = heatMap(tiles, (i) => 5 - i, () => 0.9);

  it("applies the adult-population floor through the injected lookup", () => {
    // lifts: tiles[4] = 1.5 / 0.7, tiles[3] = 1.3 / 0.9, tiles[2] = 1
    const a = new Map<string, number | null>([
      [tiles[4] as string, 100],
      [tiles[3] as string, 5000],
    ]);
    const lookupA = (t: { geohash: string }) => a.get(t.geohash);
    const keep = computeLift(bill, house, { adultPopulation: lookupA });
    expect(keep.map((t) => t.geohash)).toEqual([tiles[3]]);
    expect(keep[0]!.adultPopulation).toBe(5000);
    const low = computeLift(bill, house, { adultPopulation: lookupA, minAdults: 50 });
    expect(low.map((t) => t.geohash)).toEqual([tiles[4], tiles[3]]);

    const b = new Map<string, number | null>([
      [tiles[4] as string, null],
      [tiles[3] as string, 5000],
    ]);
    const lookupB = (t: { geohash: string }) => b.get(t.geohash);
    const unknownKept = computeLift(bill, house, { adultPopulation: lookupB });
    expect(unknownKept.map((t) => t.geohash)).toEqual([tiles[4], tiles[3]]);
    expect(unknownKept[0]!.adultPopulation).toBeNull();
    const unknownDropped = computeLift(bill, house, { adultPopulation: lookupB, unknownAdults: "drop" });
    expect(unknownDropped.map((t) => t.geohash)).toEqual([tiles[3]]);
    // tiles[2] has lift exactly 1, never a top tile
    expect(computeLift(bill, house, { adultPopulation: () => 1e6 }).map((t) => t.geohash)).toEqual([tiles[4], tiles[3]]);
  });
  it("a throwing lookup counts as unknown; no lookup means no floor", () => {
    const throwing = () => {
      throw new Error("lookup failed");
    };
    const t = computeLift(bill, house, { adultPopulation: throwing, minLift: 1.01 });
    expect(t.every((x) => x.adultPopulation === null)).toBe(true);
    const none = computeLift(bill, house, { minLift: 1.01 });
    expect(none.every((x) => x.adultPopulation === undefined)).toBe(true);
  });
  it("maxTiles and minBillPct", () => {
    const all = computeLiftAll(bill, house);
    expect(selectTopTiles(all, { minLift: 1.01, maxTiles: 1 })).toHaveLength(1);
    expect(selectTopTiles(all, { minLift: 1.01, maxTiles: 0 })).toHaveLength(0);
    const strict = selectTopTiles(all, { minLift: 1.01, minBillPct: 0.9 });
    expect(strict.every((x) => x.billPct >= 0.9)).toBe(true);
  });
  it("lookup supplied only at selection time is applied", () => {
    const all = computeLiftAll(bill, house);
    const sel = selectTopTiles(all, { minLift: 1.01, adultPopulation: () => 10 });
    expect(sel).toEqual([]);
  });
});

describe("liftDiagnostics", () => {
  const tiles = gridGeohash6(30);
  it("flags lift weak when the house map is flat (lift is just bill heat)", () => {
    const bill = heatMap(tiles, (i) => i, () => 0.9);
    const house = heatMap(tiles, () => 0.5, () => 0.9);
    const m = computeLiftMap(bill, house);
    expect(m.diagnostics.spearmanLiftVsHeat).toBeCloseTo(1);
    expect(m.diagnostics.liftWeak).toBe(true);
    expect(m.diagnostics.heatSource).toBe("bill");
    expect(m.diagnostics.threshold).toBe(LIFT_DEFAULTS.weakThreshold);
  });
  it("does not flag when lift is a distinct pattern from the raw-heat baseline", () => {
    const gradient = (i: number) => i;
    const bump = (i: number) => ((i * 13) % 30) / 30; // scrambled, unrelated to the gradient
    const bill = heatMap(tiles, (i) => gradient(i) + 25 * bump(i), () => 0.9);
    const house = heatMap(tiles, gradient, () => 0.9);
    const generic = heatMap(tiles, gradient, () => 0.9);
    const m = computeLiftMap(bill, house, { rawHeat: generic });
    expect(m.diagnostics.heatSource).toBe("baseline");
    expect(m.diagnostics.n).toBe(30);
    expect(Math.abs(m.diagnostics.spearmanLiftVsHeat as number)).toBeLessThan(0.8);
    expect(m.diagnostics.liftWeak).toBe(false);
  });
  it("insufficient with fewer than 3 tiles; custom threshold", () => {
    const two = gridGeohash6(2);
    const d = liftDiagnostics(computeLiftAll(heatMap(two, (i) => i), heatMap(two, (i) => -i)));
    expect(d.insufficient).toBe(true);
    expect(d.spearmanLiftVsHeat).toBeNull();
    const bill = heatMap(tiles, (i) => i, () => 0.9);
    const house = heatMap(tiles, () => 0.5, () => 0.9);
    expect(computeLiftMap(bill, house, { weakThreshold: 1.1 }).diagnostics.liftWeak).toBe(false);
  });
  it("measures lift against the bill's own heat (KG2's statistic) even when a raw-heat baseline is given", () => {
    // Probe 6 (Oct 15): against the restaurant baseline, a comedian's lift ranked areas like his own map (0.98).
    const bill = heatMap(tiles, (i) => i, () => 0.9);
    const flatHouse = heatMap(tiles, () => 0.5, () => 0.9);
    const generic = heatMap(tiles, (i) => ((i * 13) % 30) / 30, () => 0.9);
    const own = computeLiftMap(bill, flatHouse, { rawHeat: generic });
    expect(own.diagnostics.heatSource).toBe("baseline");
    expect(own.diagnostics.spearmanLiftVsBillHeat).toBeCloseTo(1);
    expect(own.diagnostics.tracksOwnHeat).toBe(true);
    expect(liftVsOwnHeat(own.all)).toBeCloseTo(1);
    // A house map that follows the bill: lift no longer ranks areas like the bill's heat.
    const bump = (i: number) => ((i * 7) % 30) / 30;
    const distinct = computeLiftMap(heatMap(tiles, (i) => i + 25 * bump(i), () => 0.9), heatMap(tiles, (i) => i, () => 0.9));
    expect(distinct.diagnostics.tracksOwnHeat).toBe(false);
    expect(liftVsOwnHeat([])).toBeNull();
  });
  it("raw heat baseline without overlapping tiles yields null", () => {
    const other = gridGeohash6(3, 40.7, -74);
    const all = computeLiftAll(heatMap(tiles, (i) => i), heatMap(tiles, (i) => -i));
    const d = liftDiagnostics(all, heatMap(other, (i) => i));
    expect(d.n).toBe(0);
    expect(d.spearmanLiftVsHeat).toBeNull();
  });
});

describe("splitHalves", () => {
  it("splits distinct keys into two disjoint halves, the same way every time", () => {
    const ids = ["e", "a", "d", "b", "c", "a"];
    const [x, y] = splitHalves(ids, (v) => v);
    expect(x.length + y.length).toBe(5);
    expect(x.length).toBe(3);
    expect(x.filter((v) => y.includes(v))).toEqual([]);
    expect(splitHalves([...ids].reverse(), (v) => v)).toEqual([x, y]);
  });
  it("one key gives an empty second half; none gives two empty halves", () => {
    expect(splitHalves(["solo", "solo"], (v) => v)).toEqual([["solo"], []]);
    expect(splitHalves([] as string[], (v) => v)).toEqual([[], []]);
  });
  it("keeps the items, keyed by any field", () => {
    const seeds = [
      { id: "s1", w: 0.5 },
      { id: "s2", w: 0.3 },
      { id: "s3", w: 0.2 },
    ];
    const [x, y] = splitHalves(seeds, (v) => v.id);
    expect([...x, ...y].map((v) => v.id).sort()).toEqual(["s1", "s2", "s3"]);
  });
});

describe("splitHalfAgreement", () => {
  const tiles = gridGeohash6(80);
  // A real pattern: this crowd is strong where the house is not.
  const pattern = (i: number) => Math.sin(i / 6) + (i % 9) / 9;
  const housePattern = (i: number) => (i % 7) / 7;
  const noisy = (seed: number, f: (i: number) => number, amount: number) => {
    const r = rng(seed);
    return heatMap(tiles, (i) => f(i) + amount * (r() - 0.5), () => 0.9);
  };

  it("passes when both halves carry the same pattern with their own noise", () => {
    const r = splitHalfAgreement({
      billA: noisy(1, pattern, 0.4),
      billB: noisy(2, pattern, 0.4),
      houseA: noisy(3, housePattern, 0.2),
      houseB: noisy(4, housePattern, 0.2),
    });
    expect(r.n).toBe(80);
    expect(r.spearman as number).toBeGreaterThan(0.5);
    expect(r.pass).toBe(true);
    expect(r.threshold).toBe(LIFT_DEFAULTS.minSplitHalf);
  });
  it("fails when the halves are noise around a flat map", () => {
    const flat = () => 0;
    const r = splitHalfAgreement({
      billA: noisy(11, flat, 1),
      billB: noisy(12, flat, 1),
      houseA: noisy(13, flat, 1),
      houseB: noisy(14, flat, 1),
    });
    expect(Math.abs(r.spearman as number)).toBeLessThan(0.5);
    expect(r.pass).toBe(false);
  });
  it("is null with fewer than 3 shared tiles", () => {
    const few = gridGeohash6(2);
    const m = heatMap(few, (i) => i);
    const r = splitHalfAgreement({ billA: m, billB: m, houseA: m, houseB: m });
    expect(r.spearman).toBeNull();
    expect(r.pass).toBeNull();
    expect(r.n).toBe(2);
  });
  it("one shared house map does not make noise halves agree (partial Spearman)", () => {
    const flat = () => 0;
    let passes = 0;
    for (let k = 0; k < 30; k++) {
      const house = noisy(500 + k, flat, 1);
      const r = splitHalfAgreement({ billA: noisy(600 + k, flat, 1), billB: noisy(700 + k, flat, 1), houseA: house, houseB: house });
      if (r.pass) passes++;
      expect(Math.abs(r.spearman as number)).toBeLessThan(0.45);
    }
    expect(passes).toBe(0);
  });
  it("one house map for both halves still works (a genre-tag baseline cannot be split)", () => {
    const house = noisy(5, housePattern, 0.2);
    const r = splitHalfAgreement({ billA: noisy(6, pattern, 0.4), billB: noisy(7, pattern, 0.4), houseA: house, houseB: house });
    expect(r.pass).toBe(true);
  });
});
