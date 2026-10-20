import { describe, expect, it } from "vitest";
import { layoutTileMap, LIFT_INK, liftAlpha, liftBand, liftFill, MAP_COLORS, niceKm } from "../src/map";
import { topTiles } from "../src/format";
import { makeSheet, TILES, VENUE } from "./helpers";

describe("layoutTileMap", () => {
  const sheet = makeSheet();
  const top = topTiles(sheet);
  const layout = layoutTileMap(TILES, top, VENUE, { width: 160, height: 120 });

  it("draws the top tiles last, rank 1 on top, with one label each", () => {
    const ranked = layout.rects.filter((r) => r.rank !== null);
    expect(ranked.map((r) => r.rank)).toEqual([5, 4, 3, 2, 1]);
    expect(layout.rects.at(-1)?.geohash).toBe(TILES[0]!.geohash);
    expect(layout.labels.map((l) => l.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps the top tiles and the venue inside the box", () => {
    for (const r of layout.rects.filter((x) => x.rank !== null)) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(160 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(120 + 1e-9);
    }
    expect(layout.venue).not.toBeNull();
    expect(layout.venue!.x).toBeGreaterThan(0);
    expect(layout.venue!.x).toBeLessThan(160);
    expect(layout.venue!.y).toBeGreaterThan(0);
    expect(layout.venue!.y).toBeLessThan(120);
  });

  it("preserves the cell shape (a geohash-6 cell is about twice as wide as tall at this latitude)", () => {
    const r = layout.rects.find((x) => x.rank === 1)!;
    const expected = (0.010986328125 * Math.cos((36.16 * Math.PI) / 180)) / 0.0054931640625;
    expect(r.w / r.h).toBeCloseTo(expected, 1);
  });

  it("places north up and east right", () => {
    const north = layout.rects.find((r) => r.geohash === TILES[4]!.geohash)!; // Inglewood, 36.21
    const south = layout.rects.find((r) => r.geohash === TILES[3]!.geohash)!; // Woodbine, 36.12
    expect(north.y).toBeLessThan(south.y);
    const west = layout.rects.find((r) => r.geohash === TILES[2]!.geohash)!; // -86.81
    const east = layout.rects.find((r) => r.geohash === TILES[0]!.geohash)!; // -86.75
    expect(west.x).toBeLessThan(east.x);
  });

  it("colours tiles by lift band", () => {
    expect(layout.rects.find((r) => r.rank === 1)!.band).toBe("top");
    expect(liftBand(1.3)).toBe("top");
    expect(liftBand(1.1)).toBe("mild");
    expect(liftBand(0.8)).toBe("under");
    expect(liftFill(1.3)).toBe(MAP_COLORS.topLow);
    expect(liftFill(2.2)).toBe(MAP_COLORS.topHigh);
    expect(liftFill(1.1)).toBe(MAP_COLORS.mild);
    expect(liftFill(0.5)).toBe(MAP_COLORS.under);
  });

  it("uses one ink at rising strength, the same steps as the web maps", () => {
    expect(MAP_COLORS.topHigh).toBe(LIFT_INK);
    expect(LIFT_INK).toBe("#b42318");
    expect(liftAlpha(0.5)).toBe(0.08);
    expect(liftAlpha(1.1)).toBe(0.22);
    expect(liftAlpha(1.3)).toBe(0.55);
    expect(liftAlpha(1.75)).toBe(0.78);
    expect(liftAlpha(5)).toBe(1);
    // Darker as lift rises: the red channel stays high while green and blue fall.
    const g = (hex: string) => (parseInt(hex.slice(1), 16) >> 8) & 255;
    expect(g(liftFill(0.5))).toBeGreaterThan(g(liftFill(1.1)));
    expect(g(liftFill(1.1))).toBeGreaterThan(g(liftFill(1.3)));
    expect(g(liftFill(1.3))).toBeGreaterThan(g(liftFill(2.2)));
  });

  it("reports map units per kilometre for the grid and scale bar", () => {
    expect(layout.unitsPerKm).toBeGreaterThan(0);
    // Woodbine (36.12) to Inglewood (36.21) is about 10 km north to south.
    const north = layout.rects.find((r) => r.geohash === TILES[4]!.geohash)!;
    const south = layout.rects.find((r) => r.geohash === TILES[3]!.geohash)!;
    expect((south.y - north.y) / layout.unitsPerKm).toBeCloseTo((36.21 - 36.12) * 110.57, 0);
    expect(niceKm(1.2)).toBe(1);
    expect(niceKm(4)).toBe(5);
    expect(niceKm(14)).toBe(10);
  });

  it("keeps list ranks on the map labels when a top tile has an invalid geohash", () => {
    const withBad = [top[0]!, { ...top[1]!, geohash: "!!bad" }, top[2]!];
    const l = layoutTileMap(TILES, withBad, VENUE, { width: 160, height: 120 });
    expect(l.labels.map((x) => x.rank)).toEqual([1, 3]);
    expect(l.rects.find((r) => r.geohash === top[2]!.geohash)?.rank).toBe(3);
  });

  it("handles empty and invalid input", () => {
    expect(layoutTileMap([], [], null, { width: 100, height: 80 }).rects).toEqual([]);
    expect(layoutTileMap([], [], null, { width: 100, height: 80 }).unitsPerKm).toBe(0);
    const onlyVenue = layoutTileMap([], [], VENUE, { width: 100, height: 80 });
    expect(onlyVenue.venue).toEqual({ x: 50, y: 40 });
    const bad = { ...TILES[0]!, geohash: "not-a-geohash!" };
    expect(layoutTileMap([bad], [bad], VENUE, { width: 100, height: 80 }).rects).toEqual([]);
  });
});
