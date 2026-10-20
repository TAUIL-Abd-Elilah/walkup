import { describe, expect, it } from "vitest";
import { bboxRing, cellSizeKm, decodeBbox, decodeCenter, encode, isGeohash, unionBbox } from "../lib/geohash";

describe("geohash", () => {
  it("decodes the classic reference cell ezs42", () => {
    const b = decodeBbox("ezs42");
    expect(b.minLat).toBeCloseTo(42.583, 3);
    expect(b.maxLat).toBeCloseTo(42.627, 3);
    expect(b.minLon).toBeCloseTo(-5.625, 3);
    expect(b.maxLon).toBeCloseTo(-5.581, 3);
    const c = decodeCenter("ezs42");
    expect(c.lat).toBeCloseTo(42.605, 2);
    expect(c.lon).toBeCloseTo(-5.603, 2);
  });

  it("encodes a known point (u4pruydqqvj, Jutland)", () => {
    expect(encode(57.64911, 10.40744, 11)).toBe("u4pruydqqvj");
    expect(encode(57.64911, 10.40744)).toBe("u4pruy");
  });

  it("round-trips: a point is inside the cell it encodes to, at precision 6", () => {
    const points = [
      { lat: 36.1612, lon: -86.7745 },
      { lat: 37.0447, lon: -76.3889 },
      { lat: 47.244, lon: -122.453 },
      { lat: -33.8688, lon: 151.2093 },
      { lat: 0.0001, lon: -0.0001 },
    ];
    for (const p of points) {
      const gh = encode(p.lat, p.lon, 6);
      expect(gh).toHaveLength(6);
      const b = decodeBbox(gh);
      expect(p.lat).toBeGreaterThanOrEqual(b.minLat);
      expect(p.lat).toBeLessThanOrEqual(b.maxLat);
      expect(p.lon).toBeGreaterThanOrEqual(b.minLon);
      expect(p.lon).toBeLessThanOrEqual(b.maxLon);
      // geohash-6 cells are about 1.2 km x 0.6 km
      expect(b.maxLat - b.minLat).toBeCloseTo(180 / 2 ** 15, 9);
      expect(b.maxLon - b.minLon).toBeCloseTo(360 / 2 ** 15, 9);
    }
  });

  it("is case-insensitive and rejects invalid characters", () => {
    expect(decodeBbox("DN6MCC")).toEqual(decodeBbox("dn6mcc"));
    expect(() => decodeBbox("dn6mca")).toThrow(/invalid geohash character/);
    expect(() => decodeBbox("")).toThrow();
    expect(isGeohash("dn6mcc")).toBe(true);
    expect(isGeohash("dn6mci")).toBe(false);
  });

  it("builds a closed counter-clockwise ring and a union box", () => {
    const b = decodeBbox("dn6mcc");
    const ring = bboxRing(b);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    // signed area > 0 means counter-clockwise in lon/lat
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[i + 1]!;
      area += x1 * y2 - x2 * y1;
    }
    expect(area).toBeGreaterThan(0);
    const u = unionBbox([decodeBbox("dn6mcc"), decodeBbox("dn6jxu")], [{ lat: 36.1612, lon: -86.7745 }]);
    expect(u).not.toBeNull();
    expect(u!.minLon).toBeLessThan(-86.83);
    expect(unionBbox([])).toBeNull();
  });

  it("measures a cell in km at its own latitude", () => {
    // Nashville: about 1.0 km wide and 0.6 km tall; Tacoma, further north, is narrower.
    const nash = cellSizeKm(encode(36.1612, -86.7745));
    expect(nash.widthKm).toBeCloseTo(0.99, 1);
    expect(nash.heightKm).toBeCloseTo(0.61, 1);
    const tacoma = cellSizeKm(encode(47.244, -122.453));
    expect(tacoma.widthKm).toBeLessThan(nash.widthKm);
    expect(tacoma.heightKm).toBeCloseTo(nash.heightKm, 3);
  });
});
