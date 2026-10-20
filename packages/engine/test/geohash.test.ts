import ngeohash from "ngeohash";
import { describe, expect, it } from "vitest";
import {
  aggregateToGeohash6,
  geohashCenter,
  geohashPolygon,
  haversineM,
  isValidGeohash,
  pctRankMap,
  toGeohash6,
  toGeohashPrecision,
} from "../src/geohash";
import { cell, child7, gridGeohash6 } from "./helpers";

describe("geohash helpers", () => {
  it("validates geohash strings", () => {
    expect(isValidGeohash("dn6m9p")).toBe(true);
    expect(isValidGeohash("dn6m9pa")).toBe(false); // "a" is not in the alphabet
    expect(isValidGeohash("")).toBe(false);
    expect(isValidGeohash(42)).toBe(false);
  });
  it("truncates precise geohashes and encodes coarse or missing ones", () => {
    expect(toGeohash6({ geohash: "dn6m9pq" })).toBe("dn6m9p");
    expect(toGeohash6({ geohash: "DN6M9PQ" })).toBe("dn6m9p");
    const enc = ngeohash.encode(36.16, -86.78, 6);
    expect(toGeohash6({ geohash: "dn6m", lat: 36.16, lon: -86.78 })).toBe(enc);
    expect(toGeohash6({ lat: 36.16, lon: -86.78 })).toBe(enc);
    expect(toGeohash6({ geohash: "bad!", lat: Number.NaN, lon: 1 })).toBeNull();
    expect(toGeohash6({ lat: 95, lon: 0 })).toBeNull();
    expect(toGeohashPrecision({ geohash: "dn6m9pq" }, 5)).toBe("dn6m9");
  });
  it("polygon is a closed ring around the centre", () => {
    const ring = geohashPolygon("dn6m9p");
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    const c = geohashCenter("dn6m9p");
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    expect(Math.min(...lons)).toBeLessThan(c.lon);
    expect(Math.max(...lats)).toBeGreaterThan(c.lat);
  });
  it("haversine is about right", () => {
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })).toBe(0);
    const d = haversineM({ lat: 36.16, lon: -86.78 }, { lat: 36.17, lon: -86.78 });
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1125);
  });
});

describe("aggregateToGeohash6", () => {
  it("returns [] for empty or junk input", () => {
    expect(aggregateToGeohash6([])).toEqual([]);
    expect(aggregateToGeohash6([{ geohash: "", lat: Number.NaN, lon: Number.NaN, affinity: 0.5, affinityRank: 0, popularity: 0 }])).toEqual([]);
  });
  it("means affinity/popularity, computes the centroid and counts members", () => {
    const [t] = gridGeohash6(1);
    const g = t as string;
    const a = cell(child7(g, 0), 0.2, 0.4);
    const b = cell(child7(g, 5), 0.6, 0.8);
    const out = aggregateToGeohash6([a, b]);
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.geohash).toBe(g);
    expect(o.affinity).toBeCloseTo(0.4);
    expect(o.popularity).toBeCloseTo(0.6);
    expect(o.cellCount).toBe(2);
    expect(o.lat).toBeCloseTo((a.lat + b.lat) / 2);
    expect(o.lon).toBeCloseTo((a.lon + b.lon) / 2);
  });
  it("drops NaN affinity, ignores NaN popularity, falls back to the tile centre for bad coordinates", () => {
    const [g] = gridGeohash6(1) as [string];
    const out = aggregateToGeohash6([
      cell(child7(g, 1), Number.NaN, 0.3),
      { geohash: child7(g, 2), lat: Number.NaN, lon: Number.NaN, affinity: 0.5, affinityRank: Number.NaN, popularity: Number.NaN },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.cellCount).toBe(1);
    expect(out[0]!.popularity).toBeNull();
    expect(out[0]!.affinityRank).toBeNull();
    const c = geohashCenter(g);
    expect(out[0]!.lat).toBeCloseTo(c.lat);
  });
  it("output order does not depend on input order", () => {
    const tiles = gridGeohash6(20);
    const cells = tiles.map((t, i) => cell(child7(t, i), (i * 7) % 11, 0.5));
    const a = aggregateToGeohash6(cells);
    const b = aggregateToGeohash6([...cells].reverse());
    expect(a).toEqual(b);
    expect(a.map((x) => x.geohash)).toEqual([...tiles].sort());
  });
  it("pctRankMap ranks within one map", () => {
    const tiles = gridGeohash6(4);
    const agg = aggregateToGeohash6(tiles.map((t, i) => cell(t + "0", [0.1, 0.9, 0.5, 0.5][i] as number)));
    const m = pctRankMap(agg);
    expect(m.get(tiles[1] as string)).toBe(1);
    expect(m.get(tiles[0] as string)).toBe(0.25);
    expect(m.get(tiles[2] as string)).toBe(m.get(tiles[3] as string));
    expect(pctRankMap([], "popularity").size).toBe(0);
  });
});
