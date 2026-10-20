import { describe, expect, it } from "vitest";
import { findOverlapPairs, haversineM, nameTokens, overlapNames, partnersToCandidates, tokenSetRatio } from "../src/index";
import { makePartners } from "./helpers";

describe("tokenSetRatio", () => {
  it("is 1 for reordered tokens, case, punctuation and a leading 'the'", () => {
    expect(tokenSetRatio("The Sample Spins", "spins, sample")).toBe(1);
    expect(tokenSetRatio("Joe's Bar & Grill", "joes bar and grill")).toBe(1);
  });

  it("is 1 when one token set contains the other", () => {
    expect(tokenSetRatio("Example Records", "Example Records East")).toBe(1);
  });

  it("is low for different names", () => {
    expect(tokenSetRatio("Example Records", "Fixture Tavern")).toBeLessThan(0.5);
  });

  it("handles small spelling differences above 0.85", () => {
    expect(tokenSetRatio("Exampleton Records", "Examplton Records")).toBeGreaterThanOrEqual(0.85);
  });

  it("is 0 for empty names", () => {
    expect(tokenSetRatio("", "Example")).toBe(0);
    expect(nameTokens("The")).toEqual([]);
  });
});

describe("haversineM", () => {
  it("measures about 111 m per 0.001 degree of latitude", () => {
    expect(haversineM({ lat: 36, lon: -86 }, { lat: 36.001, lon: -86 })).toBeCloseTo(111.2, 0);
  });
});

describe("findOverlapPairs", () => {
  const control = [
    { placeId: "gp-1", name: "Example Records", location: { lat: 36.1102, lon: -86.7101 } }, // ~11 m
    { placeId: "gp-2", name: "Placeholder Barbers", location: { lat: 36.1235, lon: -86.7201 } }, // ~380 m
    { placeId: "gp-3", name: "Unrelated Cafe", location: { lat: 36.1101, lon: -86.7101 } },
  ];

  it("matches only within 150 m and at similarity >= 0.85", () => {
    const pairs = findOverlapPairs(partnersToCandidates(makePartners()), control);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ qlooName: "Example Records", placeId: "gp-1", entityId: "E-P1" });
    expect(pairs[0]!.distanceM).toBeLessThan(150);
  });

  it("matches one-to-one and skips points without a location", () => {
    const qloo = [
      { name: "Example Records", location: { lat: 36.1101, lon: -86.7101 } },
      { name: "Example Records", location: { lat: 36.1101, lon: -86.7101 } },
      { name: "Unrelated Cafe" },
    ];
    expect(findOverlapPairs(qloo, control)).toHaveLength(1);
    expect(overlapNames(qloo, control)).toEqual(["Example Records"]);
  });
});
