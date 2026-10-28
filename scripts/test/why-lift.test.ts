/**
 * "Why lift" (scripts/why-lift-lib.ts) on synthetic heat cells only.
 */
import { describe, expect, it } from "vitest";
import type { HeatCell, LiftTile } from "@walkup/contracts";
import { billVsBill, joinTiles, rawVsHouse, round, sameArea, sharedAreas, topLiftAreas, topRawAreas, type JoinedTile } from "../why-lift-lib";

// Two geohash-6 tiles about 1 km apart and two far from them (precision 7 cells aggregate into these).
const T = {
  a: { geohash: "dqcjqcp", lat: 38.9, lon: -77.03 },
  a2: { geohash: "dqcjqcr", lat: 38.9001, lon: -77.0299 },
  b: { geohash: "dqcjr1b", lat: 38.91, lon: -77.02 },
  c: { geohash: "dqcm21e", lat: 38.9, lon: -76.98 },
  d: { geohash: "dqchxyz", lat: 38.8, lon: -77.1 },
};

function cell(t: { geohash: string; lat: number; lon: number }, affinity: number, popularity = 0.5): HeatCell {
  return { geohash: t.geohash, lat: t.lat, lon: t.lon, affinity, affinityRank: 0, popularity };
}

function tile(geohash: string, lat: number, lon: number, bill: number, house = 0.5, popularity = 0.5): JoinedTile {
  return { geohash, lat, lon, bill, house, popularity };
}

describe("joinTiles", () => {
  it("averages cells per geohash-6 tile and keeps tiles in both maps", () => {
    const bill = [cell(T.a, 0.8), cell(T.a2, 0.6), cell(T.b, 0.4), cell(T.d, 0.9)];
    const house = [cell(T.a, 0.2), cell(T.b, 0.7), cell(T.c, 0.5)];
    const j = joinTiles(bill, house);
    expect(j.map((t) => t.geohash)).toEqual(["dqcjqc", "dqcjr1"]);
    expect(j[0]!.bill).toBeCloseTo(0.7);
    expect(j[0]!.house).toBeCloseTo(0.2);
  });
});

describe("top areas", () => {
  const none = () => ({});

  it("takes raw heat highest first, one per place, skipping small populations", () => {
    const tiles = [
      tile("t1", 38.9, -77.03, 0.95),
      tile("t2", 38.901, -77.031, 0.94), // within 3 km of t1: the same place
      tile("t3", 38.95, -77.0, 0.9),
      tile("t4", 38.8, -77.2, 0.8),
      tile("t5", 39.0, -76.9, 0.7),
    ];
    const small = (t: { lat: number }) => (t.lat === 38.8 ? { adultPopulation: 100 } : {});
    expect(topRawAreas(tiles, none, 5).map((t) => t.geohash)).toEqual(["t1", "t3", "t4", "t5"]);
    expect(topRawAreas(tiles, small, 5).map((t) => t.geohash)).toEqual(["t1", "t3", "t5"]);
    expect(topRawAreas(tiles, none, 2).map((t) => t.geohash)).toEqual(["t1", "t3"]);
  });

  it("treats a shared ZIP as the same place", () => {
    expect(sameArea({ lat: 38.9, lon: -77.0, zctas: ["20002"] }, { lat: 38.9, lon: -76.9, zctas: ["20019", "20002"] })).toBe(true);
    expect(sameArea({ lat: 38.9, lon: -77.0, zctas: ["20002"] }, { lat: 38.9, lon: -76.9, zctas: ["20019"] })).toBe(false);
  });

  it("numbers lift areas as the sheet does", () => {
    const lt = (geohash: string, lat: number, lon: number, lift: number): LiftTile => ({ geohash, lat, lon, lift, billPct: 0.9, housePct: 0.2, popularityPct: 0.5 });
    const tiles = [lt("l1", 38.9, -77.0, 2.0), lt("l2", 38.901, -77.0, 1.9), lt("l3", 39.0, -77.2, 1.5), lt("l4", 38.7, -77.3, 1.2)];
    expect(topLiftAreas(tiles).map((t) => t.geohash)).toEqual(["l1", "l3"]);
  });
});

describe("shared areas and correlations", () => {
  it("counts the same tile and the same place", () => {
    const a = [tile("x1", 38.9, -77.0, 1), tile("x2", 39.2, -77.4, 1)];
    const b = [tile("x1", 38.9, -77.0, 1), tile("y2", 39.201, -77.401, 1), tile("y3", 38.5, -76.5, 1)];
    expect(sharedAreas(a, b)).toEqual({ sameTile: 1, samePlace: 2 });
  });

  it("ranks raw heat against the usual crowd and against the other bill", () => {
    const tiles = [tile("a", 0, 0, 0.1, 0.2), tile("b", 0, 1, 0.5, 0.4), tile("c", 0, 2, 0.9, 0.9)];
    expect(rawVsHouse(tiles)).toEqual({ rho: 1, n: 3 });
    const other = [tile("a", 0, 0, 0.9), tile("b", 0, 1, 0.5), tile("c", 0, 2, 0.1), tile("z", 0, 3, 0.4)];
    const r = billVsBill(tiles, other);
    expect(r.n).toBe(3);
    expect(r.rho).toBeCloseTo(-1);
    expect(rawVsHouse(tiles.slice(0, 2))).toEqual({ rho: null, n: 2 });
    expect(round(0.45512)).toBe(0.455);
    expect(round(null)).toBeNull();
  });
});
