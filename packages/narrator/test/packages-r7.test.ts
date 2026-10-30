/**
 * Round 7, narrator: the rules read "only within 10 km" (a bare "only" left by the split is filler) and "only 10 km";
 * a comedy bill offers no music genre to fan copy. Synthetic names only.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_BAR_CATEGORIES } from "@walkup/engine";
import { comedyBill, readRevisionByRules, type ReviseSummary } from "../src/index";

function summary(): ReviseSummary {
  const cats = ["bar", "restaurant", "cafe", ...DEFAULT_BAR_CATEGORIES];
  return {
    show: { acts: ["Test Headliner"], venue: "Sample Hall", city: "Exampleton", date: "2026-11-28", weekday: "saturday", agePolicy: "21+" },
    settings: { allAges: false, streetTeamDays: ["thursday", "saturday"], radiusKm: 40, excludeCategories: [], excludeAreas: [] },
    areas: [{ name: "North Example", geohash: "dn6m9q", partners: 6 }],
    categories: [...new Set(cats)].map((key) => ({ key, partners: key === "bar" ? 4 : 0, spots: 0 })),
    partners: 15,
    spots: 8,
  };
}

describe("rules reader: only within N km", () => {
  const read = (note: string) => readRevisionByRules(summary(), note);
  it("reads the radius however 'only' is put", () => {
    for (const note of ["only within 10 km please", "Only within 10 km", "only 10 km", "within 10 km", "just within 10 km"]) {
      const r = read(note);
      expect(r.calls).toEqual([{ tool: "set_radius", input: { km: 10 } }]);
      expect(r.question ?? null).toBeNull();
    }
  });
  it("still reads 'only Saturday' as the street-team day", () => {
    expect(read("only Saturday").calls).toEqual([{ tool: "set_street_team_days", input: { days: ["saturday"] } }]);
  });
});

describe("comedyBill", () => {
  it("is true only when every act is a comedian", () => {
    expect(comedyBill({ acts: [{ isComedian: true }, { isComedian: true }] })).toBe(true);
    expect(comedyBill({ acts: [{ isComedian: true }, {}] })).toBe(false);
    expect(comedyBill({ acts: [] })).toBe(false);
  });
});
