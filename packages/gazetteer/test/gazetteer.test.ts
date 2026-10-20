import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiftTile } from "@walkup/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GAZETTEER_DIR,
  GazetteerError,
  adultsNear,
  adultsNearDetail,
  annotateTile,
  clearGazetteerCache,
  listMetros,
  loadAllMetros,
  loadMetro,
  metroForPoint,
  nameForPoint,
  nearestZcta,
  parseMetro,
  zctasNear,
} from "../src/index";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const opts = { dir };

beforeEach(() => clearGazetteerCache());

describe("loadMetro", () => {
  it("loads a metro file and drops unnamed records", () => {
    const m = loadMetro("testville", opts);
    expect(m.metro).toBe("testville");
    expect(m.synthetic).toBe(true);
    expect(m.neighbourhoods.map((n) => n.name)).toEqual(["Lantern Row", "Millbrook", "Ferry Quarter"]);
    expect(m.places).toHaveLength(3);
    expect(m.zctas).toHaveLength(5);
    expect(m.zctas.find((z) => z.zcta === "99903")?.adults21).toBeNull();
    expect(m.attribution.osm).toContain("OpenStreetMap");
  });

  it("caches per directory until cleared", () => {
    const a = loadMetro("testville", opts);
    expect(loadMetro("testville", opts)).toBe(a);
    clearGazetteerCache();
    expect(loadMetro("testville", opts)).not.toBe(a);
  });

  it("names the available metros when one is missing", () => {
    expect(() => loadMetro("atlantis", opts)).toThrow(GazetteerError);
    expect(() => loadMetro("atlantis", opts)).toThrow(/testville/);
  });

  it("rejects path-like names", () => {
    expect(() => loadMetro("../out/nashville", opts)).toThrow(/invalid metro name/);
  });

  it("rejects malformed files", () => {
    expect(() => loadMetro("broken", opts)).toThrow(GazetteerError);
  });

  it("lists metros without the manifest and skips broken files when loading all, with one warning", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      expect(listMetros(opts)).toEqual(["broken", "testville", "twinburg"]);
      expect(loadAllMetros(opts).map((m) => m.metro)).toEqual(["testville", "twinburg"]);
      loadAllMetros(opts);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/skipped metro "broken"/);
    } finally {
      warn.mockRestore();
    }
  });

  it("honours WALKUP_GAZETTEER_DIR", () => {
    const prev = process.env.WALKUP_GAZETTEER_DIR;
    process.env.WALKUP_GAZETTEER_DIR = dir;
    try {
      expect(loadMetro("twinburg").metro).toBe("twinburg");
    } finally {
      if (prev === undefined) delete process.env.WALKUP_GAZETTEER_DIR;
      else process.env.WALKUP_GAZETTEER_DIR = prev;
    }
  });

  it("validates documents", () => {
    expect(() => parseMetro(null)).toThrow(GazetteerError);
    expect(() => parseMetro({ metro: "x", bbox: { south: 2, west: 0, north: 1, east: 1 } })).toThrow(/inverted/);
    const m = parseMetro({ metro: "x", bbox: { south: 0, west: 0, north: 2, east: 4 } });
    expect(m.center).toEqual({ lat: 1, lon: 2 });
    expect(m.neighbourhoods).toEqual([]);
  });
});

describe("nameForPoint", () => {
  it("returns the neighbourhood under the point", () => {
    expect(nameForPoint(10, -30, "testville", opts)).toEqual({
      name: "Lantern Row",
      source: "neighbourhood",
      distanceKm: 0,
      ref: "node/1",
      insideMetro: true,
    });
  });

  it("picks the nearest neighbourhood", () => {
    const n = nameForPoint(10.02, -30, "testville", opts);
    expect(n?.name).toBe("Millbrook");
    expect(n?.distanceKm).toBeCloseTo(1.112, 2);
  });

  it("falls back to a Census place beyond 2.5 km", () => {
    const n = nameForPoint(10.0, -30.03, "testville", opts); // Lantern Row is ~3.3 km away
    expect(n?.source).toBe("place");
    expect(n?.name).toBe("Big City");
    expect(n?.ref).toBe("9900001");
  });

  it("accepts a wider neighbourhood radius", () => {
    expect(nameForPoint(10.0, -30.03, "testville", { ...opts, neighbourhoodRadiusKm: 5 })?.name).toBe("Lantern Row");
  });

  it("prefers the place whose area contains the point (area-aware) over a nearer centroid", () => {
    // ~4.7 km from Small Town's centroid (outside its ~2 km circle), ~10 km inside Big City's ~17 km circle.
    expect(nameForPoint(10.07, -30.07, "testville", opts)?.name).toBe("Big City");
    expect(nameForPoint(10.07, -30.07, "testville", { ...opts, placeStrategy: "nearest" })?.name).toBe("Small Town");
  });

  it("picks the smallest containing place", () => {
    expect(nameForPoint(10.1, -30.09, "testville", opts)?.name).toBe("Small Town");
  });

  it("flags points outside the metro box", () => {
    const n = nameForPoint(11, -30, "testville", opts);
    expect(n?.insideMetro).toBe(false);
    expect(n?.name).toBe("Big City");
    expect(n?.distanceKm).toBeGreaterThan(100);
  });

  it("accepts a loaded gazetteer and returns null when it has nothing to name with", () => {
    const empty = parseMetro({ metro: "empty", bbox: { south: 0, west: 0, north: 1, east: 1 } });
    expect(nameForPoint(0.5, 0.5, empty)).toBeNull();
    expect(nameForPoint(10, -30, loadMetro("testville", opts))?.name).toBe("Lantern Row");
  });

  it("rejects invalid points", () => {
    expect(() => nameForPoint(Number.NaN, 0, "testville", opts)).toThrow(RangeError);
    expect(() => nameForPoint(91, 0, "testville", opts)).toThrow(RangeError);
  });
});

describe("zctasNear / nearestZcta", () => {
  it("returns ZCTAs by internal-point inclusion, nearest first", () => {
    expect(zctasNear(10, -30, 3, "testville", opts).map((z) => z.zcta)).toEqual(["99901", "99902"]);
    const wide = zctasNear(10, -30, 5, "testville", opts);
    expect(wide.map((z) => z.zcta)).toEqual(["99901", "99902", "99903"]);
    expect(wide[1]?.distanceKm).toBeCloseTo(2.224, 2);
  });

  it("includes a ZCTA exactly at the point for radius 0", () => {
    expect(zctasNear(10, -30, 0, "testville", opts).map((z) => z.zcta)).toEqual(["99901"]);
  });

  it("rejects a negative radius", () => {
    expect(() => zctasNear(10, -30, -1, "testville", opts)).toThrow(RangeError);
  });

  it("finds the nearest ZCTA at any distance", () => {
    expect(nearestZcta(10.05, -29.95, "testville", opts)?.zcta).toBe("99902");
  });
});

describe("adultsNear", () => {
  it("sums adults 21+ over ZCTAs in range", () => {
    expect(adultsNear(10, -30, 3, { ...opts, metro: "testville" })).toBe(15000);
  });

  it("skips ZCTAs without ACS and reports them", () => {
    const d = adultsNearDetail(10, -30, 5, { ...opts, metro: "testville" });
    expect(d).toEqual({ adults21: 15000, zctas: ["99901", "99902", "99903"], missing: ["99903"], metro: "testville" });
  });

  it("returns null when every ZCTA in range lacks ACS", () => {
    expect(adultsNear(10, -30.04, 0.5, { ...opts, metro: "testville" })).toBeNull();
  });

  it("returns 0 for a covered point with no ZCTA in range, or the nearest ZCTA on request", () => {
    expect(adultsNear(10.05, -29.95, 1, { ...opts, metro: "testville" })).toBe(0);
    expect(adultsNear(10.05, -29.95, 1, { ...opts, metro: "testville", ensureNearest: true })).toBe(5000);
  });

  it("searches every metro when none is given, counting shared ZCTAs once", () => {
    expect(adultsNear(10.1, -30.1, 1, opts)).toBe(2000);
    const d = adultsNearDetail(10.3, -30, 1, opts);
    expect(d.adults21).toBe(7000);
    expect(d.metro).toBe("twinburg");
  });

  it("returns null outside every metro", () => {
    expect(adultsNear(40, 40, 5, opts)).toBeNull();
  });

  it("does not borrow a far-away nearest ZCTA for a point outside the metro boxes", () => {
    expect(adultsNear(40, 40, 5, { ...opts, ensureNearest: true })).toBeNull();
    expect(adultsNearDetail(40, 40, 5, { ...opts, metro: "testville", ensureNearest: true })).toEqual({
      adults21: null,
      zctas: [],
      missing: [],
      metro: "testville",
    });
  });
});

describe("metroForPoint", () => {
  it("finds the containing metro", () => {
    expect(metroForPoint(10, -30, opts)).toBe("testville");
    expect(metroForPoint(10.4, -30, opts)).toBe("twinburg");
  });

  it("breaks overlaps by the nearest centre", () => {
    expect(metroForPoint(10.12, -30, opts)).toBe("testville");
    expect(metroForPoint(10.24, -30, opts)).toBe("twinburg");
  });

  it("returns null outside every metro", () => {
    expect(metroForPoint(0, 0, opts)).toBeNull();
  });

  it("accepts an explicit metro list", () => {
    expect(metroForPoint(10.24, -30, { metros: [loadMetro("testville", opts)] })).toBe("testville");
  });
});

describe("annotateTile", () => {
  const tile: LiftTile = { geohash: "synthetic", lat: 10, lon: -30, lift: 1.6, billPct: 0.9, housePct: 0.56, popularityPct: 0.5 };

  it("fills name, zctas and adultPopulation and keeps the rest", () => {
    const t = annotateTile(tile, opts);
    expect(t).toMatchObject({ geohash: "synthetic", lift: 1.6, name: "Lantern Row", zctas: ["99901", "99902"], adultPopulation: 15000 });
  });

  it("uses the nearest ZCTA when none is inside the radius", () => {
    const t = annotateTile({ ...tile, lat: 10.05, lon: -29.95 }, opts);
    expect(t.name).toBe("Big City");
    expect(t.zctas).toEqual(["99902"]);
    expect(t.adultPopulation).toBe(5000);
  });

  it("leaves tiles outside every metro unnamed with unknown adults", () => {
    const t = annotateTile({ ...tile, lat: 0, lon: 0 }, opts);
    expect(t.name).toBeUndefined();
    expect(t.adultPopulation).toBeNull();
  });

  it("leaves a tile outside an explicitly chosen metro unnamed with unknown adults", () => {
    const t = annotateTile({ ...tile, lat: 40, lon: 40 }, { ...opts, metro: "testville" });
    expect(t.name).toBeUndefined();
    expect(t.zctas).toBeUndefined();
    expect(t.adultPopulation).toBeNull();
  });
});

describe("built outputs (data/gazetteer/out)", () => {
  const built = existsSync(join(DEFAULT_GAZETTEER_DIR, "nashville.json"));

  it.skipIf(!built)("load with the default directory and name downtown Nashville", () => {
    const m = loadMetro("nashville", { dir: DEFAULT_GAZETTEER_DIR });
    expect(m.metro).toBe("nashville");
    expect(m.attribution.census).toContain("Census");
    expect(metroForPoint(36.1627, -86.7816, { dir: DEFAULT_GAZETTEER_DIR })).toBe("nashville");
    if (m.places.length + m.neighbourhoods.length > 0) {
      expect(nameForPoint(36.1627, -86.7816, m)).not.toBeNull();
    }
  });
});
