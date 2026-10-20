import { describe, expect, it } from "vitest";
import {
  haversineM,
  isOpenAt,
  isOpenOn,
  isOperational,
  matchPlaces,
  overlapWithQloo,
  ratio,
  toPlaceRecord,
  tokenSetRatio,
  type GoogleTextSearchResponse,
  type PlaceRecord,
} from "../src/index";
import { loadSynthetic } from "./helpers";

const raw = loadSynthetic<GoogleTextSearchResponse>("text-search.synthetic.json").places!;
const rec = (i: number): PlaceRecord => toPlaceRecord(raw[i]!, "q")!;
const tapRoom = rec(0); // Tue-Sun 16:00-02:00, closed Monday
const records = rec(1); // Mon-Sat 10:00-18:00
const diner = rec(2); // 24/7, temporarily closed
const corner = rec(3); // no hours, no status

describe("opening hours", () => {
  it("isOpenOn counts days a period opens, not overnight spill", () => {
    expect(isOpenOn(tapRoom, "monday")).toBe(false); // Sunday's 02:00 spill does not count
    expect(isOpenOn(tapRoom, "tuesday")).toBe(true);
    expect(isOpenOn(tapRoom, "saturday")).toBe(true);
    expect(isOpenOn(tapRoom, "sunday")).toBe(true);
    expect(isOpenOn(records, "sunday")).toBe(false);
    expect(isOpenOn(records, "thursday")).toBe(true);
  });

  it("treats a single open-without-close period as 24/7", () => {
    expect(isOpenOn(diner, "wednesday")).toBe(true);
    expect(isOpenAt(diner, "wednesday", "03:00")).toBe(true);
  });

  it("returns null when hours are unknown", () => {
    expect(isOpenOn(corner, "friday")).toBeNull();
    expect(isOpenOn({ regularOpeningHours: { periods: [] } }, "friday")).toBeNull();
    expect(isOpenAt(corner, "friday", "20:00")).toBeNull();
  });

  it("isOpenAt handles overnight and week wrap", () => {
    expect(isOpenAt(tapRoom, "monday", "01:00")).toBe(true); // Sunday 16:00 -> Monday 02:00
    expect(isOpenAt(tapRoom, "monday", "02:00")).toBe(false);
    expect(isOpenAt(tapRoom, "sunday", "01:30")).toBe(true); // Saturday 16:00 -> Sunday 02:00 wraps the week
    expect(isOpenAt(tapRoom, "saturday", "15:59")).toBe(false);
    expect(isOpenAt(tapRoom, "saturday", "23:30")).toBe(true);
    expect(isOpenAt(records, "saturday", "18:00")).toBe(false);
    expect(() => isOpenAt(records, "saturday", "7pm")).toThrow(RangeError);
  });

  it("covers a multi-day period at noon", () => {
    const longWeekend = { regularOpeningHours: { periods: [{ open: { day: 5, hour: 18, minute: 0 }, close: { day: 0, hour: 4, minute: 0 } }] } };
    expect(isOpenOn(longWeekend, "saturday")).toBe(true);
    expect(isOpenOn(longWeekend, "sunday")).toBe(false);
    expect(isOpenOn(longWeekend, "thursday")).toBe(false);
  });

  it("reads businessStatus", () => {
    expect(isOperational(tapRoom)).toBe(true);
    expect(isOperational(diner)).toBe(false);
    expect(isOperational({ businessStatus: "CLOSED_PERMANENTLY" })).toBe(false);
    expect(isOperational(corner)).toBeNull();
  });
});

describe("name similarity and distance", () => {
  it("ratio is 2*LCS/(|a|+|b|)", () => {
    expect(ratio("abcd", "abcd")).toBe(1);
    expect(ratio("abcd", "abxd")).toBeCloseTo(0.75, 10);
    expect(ratio("", "")).toBe(1);
  });

  it("tokenSetRatio follows token-set semantics", () => {
    expect(tokenSetRatio("The Lantern Room", "Lantern Room")).toBe(1);
    expect(tokenSetRatio("Robert's Western World", "Roberts Western World")).toBe(1);
    expect(tokenSetRatio("Café Luna", "CAFE LUNA")).toBe(1);
    expect(tokenSetRatio("Bar & Grill", "bar and grill")).toBe(1);
    // "juniper record shop" vs "juniper records": LCS 15 over 34 chars.
    expect(tokenSetRatio("Juniper Record Shop", "Juniper Records")).toBeCloseTo(30 / 34, 10);
    expect(tokenSetRatio("Marlow's Tap Room", "Marlows Taproom")).toBeLessThan(0.85);
    expect(tokenSetRatio("Hollow Pines Diner", "Lantern Corner Bar")).toBeLessThan(0.5);
    expect(tokenSetRatio("", "x")).toBe(0);
  });

  it("haversine matches a degree of latitude", () => {
    expect(haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111_195.08, 1);
    expect(haversineM({ lat: 36.16, lon: -86.77 }, { lat: 36.16, lon: -86.77 })).toBe(0);
  });

  it("matches one-to-one within 0.85 similarity and 150 m", () => {
    const control = [
      { name: "Juniper Records", location: { lat: 36.1655, lon: -86.7801 } },
      { name: "Lantern Corner Bar", location: { lat: 36.17, lon: -86.76 } },
      { name: "Juniper Records", location: { lat: 36.1656, lon: -86.7801 } },
      { name: "Marlow's Tap Room" },
    ];
    const qloo = [
      { name: "Juniper Record Shop", location: { lat: 36.1659, lon: -86.7801 } }, // ~44 m
      { name: "Lantern Corner Bar", location: { lat: 36.1740, lon: -86.76 } }, // ~445 m: too far
      { name: "Marlow's Tap Room", location: { lat: 36.1612, lon: -86.7705 } }, // control has no location
    ];
    const m = matchPlaces(control, qloo);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ controlIndex: 2, qlooIndex: 0, qlooName: "Juniper Record Shop" });
    expect(m[0]!.distanceM).toBeLessThan(150);
    expect(overlapWithQloo(control, qloo)).toEqual(["Juniper Records"]);
    expect(overlapWithQloo(control, qloo, { maxDistanceM: 500 })).toEqual(["Lantern Corner Bar", "Juniper Records"]);
  });
});
