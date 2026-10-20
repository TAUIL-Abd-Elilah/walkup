import { describe, expect, it } from "vitest";
import { haversineKm } from "../src/index";

describe("haversineKm", () => {
  it("is zero for the same point", () => {
    expect(haversineKm(36.16, -86.78, 36.16, -86.78)).toBe(0);
  });

  it("gives ~111.2 km for one degree of latitude", () => {
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.195, 2);
  });

  it("shrinks longitude degrees with latitude", () => {
    const atEquator = haversineKm(0, 0, 0, 1);
    const at60 = haversineKm(60, 0, 60, 1);
    expect(at60 / atEquator).toBeCloseTo(0.5, 2);
  });

  it("is symmetric", () => {
    const a = haversineKm(36.12, -86.67, 33.94, -118.4);
    const b = haversineKm(33.94, -118.4, 36.12, -86.67);
    expect(a).toBeCloseTo(b, 9);
  });

  it("matches the textbook BNA to LAX distance (~2886 km)", () => {
    expect(haversineKm(36.12, -86.67, 33.94, -118.4)).toBeGreaterThan(2884);
    expect(haversineKm(36.12, -86.67, 33.94, -118.4)).toBeLessThan(2889);
  });

  it("handles the antimeridian", () => {
    expect(haversineKm(0, 179.5, 0, -179.5)).toBeCloseTo(111.195, 2);
  });
});
