/**
 * Round 7, narrator: Claude's "stands out in five areas" under a lift card that counts 66 areas passing both tests is
 * the template's old wrong count in other words. The guard replaces it when the count is not the card's; the
 * template's "in the sheet's top 5 areas" and "stands out most in A, B and C" are not counts of it. Synthetic data only.
 */
import type { Envelope, LiftTile, StreetSheet } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import { narrate, templateSummary, vetNarration, type Narration } from "../src/index";
import { fakeMessage, makeBill, makeInput, mockClient } from "./helpers";

function env<T>(results: T, summary = "synthetic"): Envelope<T> {
  return { status: "ok", summary, results, provenance: [], limits: [] };
}

function tiles(): LiftTile[] {
  return [
    { geohash: "dn6t00", lat: 36.2, lon: -86.7, lift: 2.2448, billPct: 0.82, housePct: 0.09, popularityPct: 0.7, name: "Hilltop" },
    { geohash: "dn6t01", lat: 36.1, lon: -86.6, lift: 2.0406, billPct: 0.85, housePct: 0.16, popularityPct: 0.6, name: "Riverbend" },
    { geohash: "dn6t02", lat: 36.1, lon: -86.8, lift: 1.9, billPct: 0.73, housePct: 0.15, popularityPct: 0.5, name: "Oak Park" },
    { geohash: "dn6t03", lat: 36.0, lon: -86.7, lift: 1.7657, billPct: 0.8049, housePct: 0.239, popularityPct: 0.5, name: "Kenilworth" },
    { geohash: "dn6t04", lat: 36.0, lon: -86.6, lift: 1.6, billPct: 0.9, housePct: 0.4, popularityPct: 0.5, name: "Fifth Ward" },
  ];
}

function sheet(summary: string, liftSummary: string, heatCause?: string): StreetSheet {
  const ts = tiles();
  return {
    planId: "synthetic-r7",
    createdAt: "2026-10-30T00:00:00.000Z",
    mode: "live",
    hypothetical: false,
    bill: makeBill(),
    operator: { seatsLeft: null, capacity: null, mediaBudgetUsd: 5000, streetTeamDays: ["thursday"], radiusKm: 40, declaredPartners: [] },
    cards: {
      resolution: env([]),
      liftMap: env({ tiles: ts, diagnostics: { spearmanLiftVsHeat: null, baseline: "house" as const } }, liftSummary),
      partners: env([]),
      declared: env([]),
      prePost: env([]),
      media: env([]),
      demographics: env({ bill: [], house: [] }),
      whatsDifferent: env({ shared: [], a: [], b: [], fromTagDiff: false }),
      copyHooks: env([]),
    },
    narration: { summary, tileWhy: [], partnerLines: [], templated: false } as Narration,
    ledger: [],
    guard: { dropped: 0, reasons: [], deniedTagCount: 0 },
    budgetSplit: ts.map((t) => ({ geohash: t.geohash, share: 0.2, label: "heuristic, not a forecast" })),
    limits: [],
    ...(heatCause ? { steps: [{ id: "heat", status: "ok", decision: "Put Hilltop first.", cause: heatCause, ledgerRefs: [] }] } : {}),
  } as StreetSheet;
}

const NOW = "66 areas pass both tests (lift 1.3 or more against the room's usual crowd, percentile 70 or higher for this crowd). The top 5 are in Hilltop.";
const BEFORE = "66 areas where this bill's crowd ranks higher than the room's usual crowd. The top 5 are in Hilltop.";
const CLAUDE = "Test Headliner at Sample Hall draws a crowd that stands out in five areas compared with the room's usual crowd, most strongly in Hilltop and Riverbend.";

describe("narration guard: the count of areas that stand out", () => {
  it("replaces a count that is not the lift card's", () => {
    for (const lift of [NOW, BEFORE]) {
      const res = vetNarration(sheet(CLAUDE, lift));
      expect(res.replaced).toEqual(["summary: says the crowd stands out in five areas; the lift card counts 66 that pass both tests"]);
      expect(res.narration!.summary).toMatch(/in the sheet's top 5 areas; the strongest, Hilltop, is about 2\.2 times/);
    }
    // The Lift map step's count, when the card says none.
    const step = vetNarration(sheet("This crowd stands out from the room's usual crowd in 5 areas; Hilltop leads.", "synthetic", "66 areas pass both tests: at least 1.3 times the room's usual crowd, and percentile 70 or higher for this crowd."));
    expect(step.replaced[0]).toMatch(/stands out in 5 areas; the lift card counts 66/);
  });

  it("keeps the card's own count, a top-N count, a list and a sheet that doesn't say", () => {
    expect(vetNarration(sheet("This crowd stands out in 66 areas; Hilltop leads at about 2.2 times.", NOW)).replaced).toEqual([]);
    expect(vetNarration(sheet("This crowd stands out from the room's usual crowd in the sheet's top 5 areas; the strongest, Hilltop, is about 2.2 times the room's usual crowd.", NOW)).replaced).toEqual([]);
    expect(vetNarration(sheet("This crowd stands out most in Hilltop, Riverbend and Oak Park, compared with the room's usual crowd.", NOW)).replaced).toEqual([]);
    expect(vetNarration(sheet(CLAUDE, "synthetic")).replaced).toEqual([]);
  });

  it("narrate() checks the count against the input's lift card count", async () => {
    const run = async (liftPassCount?: number) => {
      const input = { ...makeInput(), ...(liftPassCount !== undefined ? { liftPassCount } : {}) };
      const draft = { summary: "This crowd stands out in five areas compared with the room's usual crowd.", tileWhy: [], partnerLines: [], copyHooks: [] };
      const { client } = mockClient([fakeMessage({ content: JSON.stringify(draft) })]);
      return { input, res: await narrate(input, { client }) };
    };
    const wrong = await run(40);
    expect(wrong.res.summary).toBe(templateSummary(wrong.input));
    expect(wrong.res.guard.reasons).toContain("replaced by the template: summary: says the crowd stands out in five areas; the lift card counts 40 that pass both tests");
    expect((await run(5)).res.summary).toBe("This crowd stands out in five areas compared with the room's usual crowd.");
    expect((await run()).res.summary).toBe("This crowd stands out in five areas compared with the room's usual crowd.");
  });
});
