import { describe, expect, it } from "vitest";
import { HOUSE_SET_SIZE, isAncillaryEvent, rosterHeadliners, type TmEvent, type TmEventSearchResponse } from "../src/index";
import { loadSynthetic } from "./helpers";

const events = loadSynthetic<TmEventSearchResponse>("venue-roster.synthetic.json")._embedded!.events!;

describe("rosterHeadliners", () => {
  it("dedupes headliners and weights by recency x frequency", () => {
    const set = rosterHeadliners(events);
    expect(set.map((r) => r.key)).toEqual(["A1", "A2", "A5", "A3", "name:no-id collective"]);

    const [a1, a2, a5, a3, noId] = set;
    // Reference = earliest kept date 2026-11-20, half-life 60 days.
    expect(a1!.count).toBe(2);
    expect(a1!.eventIds).toEqual(["R01", "R02"]); // R03 (parking) skipped
    expect(a1!.score).toBeCloseTo(1 + 0.5 ** (1 / 60), 10);
    expect(a2!.score).toBeCloseTo(0.5 ** (5 / 60), 10);
    expect(a5!.score).toBeCloseTo(0.5, 10); // 2027-01-19 is 60 days out
    expect(a3!.score).toBeCloseTo(0.25, 10); // 2027-03-20 is 120 days out
    // Undated night takes the smallest dated weight.
    expect(noId!.score).toBeCloseTo(0.25, 10);
    expect(noId!.dates).toEqual([]);

    const total = set.reduce((s, r) => s + r.weight, 0);
    expect(total).toBeCloseTo(1, 12);
    expect(set.every((r) => r.act.role === "headliner")).toBe(true);
    expect(a2!.act.spotifyId).toBe("SynSpot000000000000003");
  });

  it("counts only headliner slots; support appearances do not count", () => {
    const dell = rosterHeadliners(events).find((r) => r.act.name === "Dell Ruiz")!;
    expect(dell.eventIds).toEqual(["R07"]);
  });

  it("skips canceled shows and no-attraction listings", () => {
    const keys = rosterHeadliners(events).map((r) => r.key);
    expect(keys).not.toContain("A4");
    expect(keys).toHaveLength(5);
    expect(rosterHeadliners(events, { skipCanceled: false }).map((r) => r.key)).toContain("A4");
  });

  it("excludes the bill being planned", () => {
    const set = rosterHeadliners(events, { excludeEventIds: ["R01"], excludeAttractionIds: ["A2"] });
    expect(set.find((r) => r.key === "A1")!.count).toBe(1);
    expect(set.map((r) => r.key)).not.toContain("A2");
  });

  it("returns the top 12 by default", () => {
    expect(HOUSE_SET_SIZE).toBe(12);
    const many: TmEvent[] = Array.from({ length: 20 }, (_, i) => ({
      id: `M${i}`,
      name: `Act ${i}`,
      dates: { start: { localDate: `2026-12-${String(i + 1).padStart(2, "0")}` } },
      _embedded: { attractions: [{ id: `X${i}`, name: `Act ${i}` }] },
    }));
    const set = rosterHeadliners(many);
    expect(set).toHaveLength(12);
    expect(set[0]!.key).toBe("X0");
    expect(set[11]!.key).toBe("X11");
    expect(rosterHeadliners(many, { top: 3 })).toHaveLength(3);
  });

  it("uses an explicit reference date", () => {
    const set = rosterHeadliners(events, { referenceDate: "2027-03-20" });
    expect(set[0]!.key).toBe("A3");
    expect(set[0]!.score).toBeCloseTo(1, 10);
  });

  it("recognises ancillary listings", () => {
    expect(isAncillaryEvent({ id: "1", name: "Premium Parking: Marlow Pines" })).toBe(true);
    expect(isAncillaryEvent({ id: "2", name: "VIP Package Upgrade" })).toBe(true);
    expect(isAncillaryEvent({ id: "3", name: "Marlow Pines" })).toBe(false);
  });
});
