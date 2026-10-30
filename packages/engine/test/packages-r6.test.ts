/**
 * Round 6, engine: "Why this one" says "national chains aside" when a chain the rule skipped would have qualified
 * ahead of the pick; a partner on a run with no lift map is "near the venue", never "not in a top area"; the Summary
 * step counts fan copy lines only when a full set was kept. Synthetic data.
 */
import { describe, expect, it } from "vitest";
import type { LiftTile, Partner } from "@walkup/contracts";
import { CHAINS_ASIDE, chainSkippedAhead, narrateStep, partnerConfidence, partnerDiscovery, type ConfidenceInput } from "../src/index";
import { place } from "./helpers";

function tile(geohash: string, lift: number, name: string): LiftTile {
  return { geohash, lat: 38.9, lon: -77.0, lift, billPct: 0.9, housePct: 0.3, popularityPct: 0.5, name };
}

const NUMBERED = [tile("dqcjr0", 2.4, "Laurel"), tile("dqcjr1", 2.2, "Bowie")];
const [AREA1, AREA2] = NUMBERED.map((t) => t.geohash) as [string, string];

function partner(name: string, qlooRank: number, houseRank: number | null, tileGeohash: string, chain = false): Partner {
  const p: Partner = {
    entity: place(name, { id: `E-${name}`, category: "restaurant" }),
    tileGeohash,
    category: "restaurant",
    score: 1 - qlooRank / 100,
    qlooRank,
    houseRank,
    chips: [{ label: "over-indexes for this bill", ledgerRef: "Q17" }],
  };
  if (chain) p.chain = true;
  return p;
}

describe("Why this one: national chains aside", () => {
  it("says so when a chain the rule skipped ranks higher in the pick's area and would have qualified", () => {
    const partners = [partner("Smoothie Chain", 10, 31, AREA1, true), partner("Corner Deli", 12, 29, AREA1)];
    const d = partnerDiscovery({ partners, baseline: "house", numbered: NUMBERED });
    expect(d?.entityId).toBe("E-Corner Deli");
    expect(d?.why).toBe("the highest-ranked place for this crowd in area 1, national chains aside, that the room's usual crowd ranks 17 places lower");
    expect(chainSkippedAhead({ partners, pick: partners[1]!, areasBefore: [] })).toBe(true);
  });

  it("leaves the line as it was when the chain ranks lower or the usual crowd ranks it about as high", () => {
    const below = [partner("Corner Deli", 12, 29, AREA1), partner("Smoothie Chain", 14, 40, AREA1, true)];
    expect(partnerDiscovery({ partners: below, baseline: "house", numbered: NUMBERED })?.why).not.toContain(CHAINS_ASIDE);
    const usual = [partner("Coffee Chain", 1, 2, AREA1, true), partner("Corner Deli", 4, 9, AREA1)];
    expect(partnerDiscovery({ partners: usual, baseline: "house", numbered: NUMBERED })?.why).toBe(
      "the highest-ranked place for this crowd in area 1 that the room's usual crowd ranks 5 places lower",
    );
  });

  it("counts a chain in an earlier area: no local place there qualified, but the chain would have", () => {
    const partners = [partner("Smoothie Chain", 3, 30, AREA1, true), partner("Tavern One", 1, 2, AREA1), partner("Bowie Grill", 6, 14, AREA2)];
    expect(partnerDiscovery({ partners, baseline: "house", numbered: NUMBERED })?.why).toBe(
      "the highest-ranked place for this crowd in area 2 (no place in area 1 qualified), national chains aside, that the room's usual crowd ranks 8 places lower",
    );
  });
});

describe("partner confidence on a run with no lift map", () => {
  const base: ConfidenceInput = { qlooRank: 1, poolSize: 8, inTopArea: false, widenedRadiusM: null, widenedCategories: false, hoursKnown: true, day: "thursday", thinSignal: true };
  it("says near the venue, with the same confidence", () => {
    const withMap = partnerConfidence(base);
    const none = partnerConfidence({ ...base, noLiftMap: true });
    expect(withMap.why).toBe("Rank 1 of 8 near the venue, not in a top area, but the list was short and this bill's signal is thin.");
    expect(none.why).toBe("Rank 1 of 8 near the venue, but the list was short and this bill's signal is thin.");
    expect(none.confidence).toBe(withMap.confidence);
  });
});

describe("Summary step: kept copy lines are not counted as written", () => {
  it("leaves the count to the cause when the checks kept fewer than a full set", () => {
    const s = narrateStep({ templated: false, hooks: 2, hooksStatus: "partial", summaryReplaced: true, ledgerRefs: [] });
    expect(s.decision).toBe("Claude wrote a draft summary and fan copy lines from this run's results; fixed wording replaced the summary (see Checks).");
    expect(s.cause).toBe("Only 2 copy lines passed the tag allowlist and the checks.");
    expect(narrateStep({ templated: false, hooks: 3, hooksStatus: "ok", ledgerRefs: [] }).decision).toBe("Claude wrote the summary and 3 fan copy lines from this run's results.");
    // The template writes the lines it keeps, so it still counts them.
    expect(narrateStep({ templated: true, hooks: 1, hooksStatus: "partial", ledgerRefs: [] }).decision).toBe(
      "Wrote the summary and 1 fan copy line from a fixed template; no model was called.",
    );
  });
});
