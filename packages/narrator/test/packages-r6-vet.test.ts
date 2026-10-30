/**
 * Round 6, narrator: "the area with the 96th percentile ... among the lifted areas" is a superlative about the
 * percentile, kept only for the area with the highest one; Ticketmaster's raw classification ("Music / R&B") is written
 * the way the sheet's header gives it. Synthetic data.
 */
import type { Envelope, LiftTile, StreetSheet } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import { classificationWording, vetNarration, type Narration } from "../src/index";
import { readableForPromoter } from "../src/narrate";
import { makeBill } from "./helpers";

function env<T>(results: T): Envelope<T> {
  return { status: "ok", summary: "synthetic", results, provenance: [], limits: [] };
}

// Kenilworth is at the 80th percentile for this crowd; Fifth Ward, at the 90th, is the highest of the five.
function tiles(): LiftTile[] {
  return [
    { geohash: "dn6t00", lat: 36.2, lon: -86.7, lift: 2.2448, billPct: 0.82, housePct: 0.09, popularityPct: 0.7, name: "Hilltop" },
    { geohash: "dn6t01", lat: 36.1, lon: -86.6, lift: 2.0406, billPct: 0.85, housePct: 0.16, popularityPct: 0.6, name: "Riverbend" },
    { geohash: "dn6t02", lat: 36.1, lon: -86.8, lift: 1.9, billPct: 0.73, housePct: 0.15, popularityPct: 0.5, name: "Oak Park" },
    { geohash: "dn6t03", lat: 36.0, lon: -86.7, lift: 1.7657, billPct: 0.8049, housePct: 0.239, popularityPct: 0.5, name: "Kenilworth" },
    { geohash: "dn6t04", lat: 36.0, lon: -86.6, lift: 1.38, billPct: 0.9, housePct: 0.4, popularityPct: 0.5, name: "Fifth Ward" },
  ];
}

function sheet(n: Partial<Narration>): StreetSheet {
  const ts = tiles();
  return {
    planId: "synthetic-r6",
    createdAt: "2026-10-30T00:00:00.000Z",
    mode: "live",
    hypothetical: false,
    bill: makeBill(),
    operator: { seatsLeft: null, capacity: null, mediaBudgetUsd: 5000, streetTeamDays: ["thursday"], radiusKm: 40, declaredPartners: [] },
    cards: {
      resolution: env([]),
      liftMap: env({ tiles: ts, diagnostics: { spearmanLiftVsHeat: null, baseline: "house" as const } }),
      partners: env([]),
      declared: env([]),
      prePost: env([]),
      media: env([]),
      demographics: env({ bill: [], house: [] }),
      whatsDifferent: env({ shared: [], a: [], b: [], fromTagDiff: false }),
      copyHooks: env([]),
    },
    narration: { summary: "Test Headliner at Sample Hall.", tileWhy: [], partnerLines: [], templated: false, ...n },
    ledger: [],
    guard: { dropped: 0, reasons: [], deniedTagCount: 0 },
    budgetSplit: ts.map((t) => ({ geohash: t.geohash, share: 0.2, label: "heuristic, not a forecast" })),
    limits: [],
  };
}

const AMONG = (name: string, times: string, pct: string) =>
  `${name} shows about ${times} times the room's usual crowd, and it is the area with the ${pct} percentile for this crowd among the lifted areas.`;

describe("the area with the Nth percentile among the areas", () => {
  it("is replaced when another numbered area has a higher percentile", () => {
    const v = vetNarration(sheet({ tileWhy: [{ geohash: "dn6t03", text: AMONG("Kenilworth", "1.8", "80th") }] }));
    expect(v.replaced).toEqual(['tileWhy[0]: superlative "the area with the 80th percentile among" not backed by the sheet\'s numbers']);
    expect(v.narration?.tileWhy[0]?.text).toBe("About 1.8 times the room's usual crowd. 80th percentile for this crowd, 24th for the room's usual crowd.");
  });

  it("is kept for the area with the highest percentile, and a plain percentile line is never caught", () => {
    expect(vetNarration(sheet({ tileWhy: [{ geohash: "dn6t04", text: AMONG("Fifth Ward", "1.4", "90th") }] })).replaced).toEqual([]);
    const plain = "Kenilworth shows about 1.8 times the room's usual crowd, at the 80th percentile for this crowd.";
    expect(vetNarration(sheet({ tileWhy: [{ geohash: "dn6t03", text: plain }] })).replaced).toEqual([]);
  });
});

describe("Ticketmaster's classification in prose", () => {
  it("is written as the header gives it", () => {
    expect(classificationWording("FLO's crowd for this Music / R&B show stands out most in Laurel.", "Music / R&B")).toBe("FLO's crowd for this R&B show stands out most in Laurel.");
    expect(classificationWording("A Music / Hip-Hop/Rap night.", "Music / Hip-Hop/Rap")).toBe("A Hip-Hop/Rap night.");
    expect(classificationWording("A comedy night.", "Comedy")).toBe("A comedy night.");
    expect(classificationWording("A Music / Other night.", "Music / Other")).toBe("A Music / Other night.");
    expect(readableForPromoter("This Music / Country show.", { classification: "Music / Country" })).toBe("This Country show.");
  });
});
