/**
 * Round 5 follow-up: true lines the new number and split checks must keep ("leans most strongly toward", two named
 * areas that do split equally, "the other three close-in city areas", a threshold figure, "part of the same rough
 * split", another area's figure written before its name), each next to the wrong line still caught. Synthetic data.
 */
import type { Envelope, LiftTile, QlooEntity, StreetSheet } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import { vetNarration, vetSheetHooks, type Narration } from "../src/index";
import { makeBill } from "./helpers";

function env<T>(results: T): Envelope<T> {
  return { status: "ok", summary: "synthetic", results, provenance: [], limits: [] };
}

function ent(id: string, name: string): QlooEntity {
  return { entityId: id, name, subtype: "urn:entity:place", popularity: 0.5, affinity: 0.5, tags: [], properties: {} };
}

// Venue at (36.1, -86.7). Five numbered areas; Hilltop stands out most, Fifth Ward least.
function tiles(): LiftTile[] {
  return [
    { geohash: "dn6t00", lat: 36.2, lon: -86.7, lift: 2.2448, billPct: 0.82, housePct: 0.09, popularityPct: 0.7, name: "Hilltop" },
    { geohash: "dn6t01", lat: 36.1, lon: -86.6, lift: 2.0406, billPct: 0.85, housePct: 0.16, popularityPct: 0.6, name: "Riverbend" },
    { geohash: "dn6t02", lat: 36.1, lon: -86.8, lift: 1.9, billPct: 0.73, housePct: 0.15, popularityPct: 0.5, name: "Oak Park" },
    { geohash: "dn6t03", lat: 36.0, lon: -86.7, lift: 1.7657, billPct: 0.8049, housePct: 0.239, popularityPct: 0.5, name: "Kenilworth" },
    { geohash: "dn6t04", lat: 36.0, lon: -86.6, lift: 1.38, billPct: 0.9, housePct: 0.4, popularityPct: 0.5, name: "Fifth Ward" },
  ];
}

function sheet(n: Partial<Narration>, shares: number[]): StreetSheet {
  const ts = tiles();
  return {
    planId: "synthetic-integrator",
    createdAt: "2026-10-29T00:00:00.000Z",
    mode: "live",
    hypothetical: false,
    bill: makeBill(),
    operator: { seatsLeft: null, capacity: null, mediaBudgetUsd: 5000, streetTeamDays: ["thursday"], radiusKm: 40, declaredPartners: [] },
    cards: {
      resolution: env([]),
      liftMap: env({ tiles: ts, diagnostics: { spearmanLiftVsHeat: null, baseline: "house" as const } }),
      partners: env([
        { entity: ent("E-C1", "Sample Coffeehouse"), tileGeohash: "dn6t00", tileName: "Hilltop", category: "cafe", score: 0.8, qlooRank: 3, chips: [], hoursOnDay: null },
      ]),
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
    budgetSplit: ts.map((t, i) => ({ geohash: t.geohash, share: shares[i]!, label: "heuristic, not a forecast" })),
    limits: [],
  };
}

const TOP_TWO = [0.238, 0.238, 0.206, 0.206, 0.112];
const FOUR_EVEN = [0.224, 0.224, 0.224, 0.224, 0.104];
const ONE_BIG = [0.427, 0.143, 0.143, 0.143, 0.144];
const replaced = (s: StreetSheet) => vetNarration(s).replaced;
const summary = (text: string, shares = TOP_TWO) => replaced(sheet({ summary: `Test Headliner at Sample Hall. ${text}` }, shares));
const area = (geohash: string, text: string, shares = TOP_TWO) => replaced(sheet({ tileWhy: [{ geohash, text }] }, shares));
const partnerLine = (text: string) => replaced(sheet({ partnerLines: [{ entityId: "E-C1", text }] }, TOP_TWO));

describe("'most strongly' is about lift only before a list of areas", () => {
  it("keeps 'leans most strongly toward' and 'ranks most strongly among', and still checks a list", () => {
    expect(summary("This crowd leans most strongly toward empowerment and rhythm and blues.")).toEqual([]);
    expect(partnerLine("Coffeehouse near Hilltop, a kind of place this crowd ranks most strongly among cafes.")).toEqual([]);
    expect(summary("This crowd stands out in five areas, most strongly in Hilltop and Riverbend.")).toEqual([]);
    expect(summary("This crowd stands out in five areas, most strongly in Hilltop and Kenilworth.")[0]).toMatch(/most strongly.*Riverbend stands out more/);
  });
});

describe("an equal split is checked against the areas it names", () => {
  it("compares only the areas a summary says split equally", () => {
    expect(summary("Hilltop and Riverbend split the top of the budget equally, at 23.8% each.")).toEqual([]);
    expect(summary("Hilltop, Riverbend, Oak Park and Kenilworth split most of the budget equally, with less for Fifth Ward.", FOUR_EVEN)).toEqual([]);
    expect(summary("Hilltop and Oak Park split the top of the budget equally.")[0]).toMatch(/equal budget split/);
    expect(summary("The budget is split evenly across five areas.", FOUR_EVEN)[0]).toMatch(/equal budget split/);
  });

  it("reads 'the other three <more words> areas' as the rest, and 'part of the same rough split' as the sheet's one split", () => {
    expect(area("dn6t00", "Hilltop gets 22.4% of the rough split of the budget, the same as the other three close-in city areas.", FOUR_EVEN)).toEqual([]);
    expect(area("dn6t02", "Oak Park shows about 1.9 times the room's usual crowd and is part of the same rough split of the budget.")).toEqual([]);
    expect(area("dn6t02", "Oak Park is part of the same rough split of the budget as Hilltop.")[0]).toMatch(/equal budget split/);
    expect(area("dn6t02", "Oak Park gets the same rough split of the budget as Kenilworth.")).toEqual([]);
  });
});

describe("a figure that is not the area's own is skipped", () => {
  it("skips a threshold and another area's figure written before its name, and still checks the area's own", () => {
    expect(area("dn6t04", "Fifth Ward shows about 1.4 times the room's usual crowd and clears the 1.3x cutoff.")).toEqual([]);
    expect(area("dn6t04", "Fifth Ward sits just over the 1.3x line for a numbered area.")).toEqual([]);
    expect(area("dn6t04", "Fifth Ward shows about 1.9 times the room's usual crowd.")[0]).toMatch(/says about 1\.9 times, the area's lift is about 1\.4 times/);
    expect(area("dn6t01", "Riverbend gets 14.3% of the budget, against 42.7% for Hilltop.", ONE_BIG)).toEqual([]);
    expect(area("dn6t01", "Riverbend gets 42.7% of the budget.", ONE_BIG)[0]).toMatch(/says 42\.7% of the budget, the area's share is 14\.3%/);
  });
});

describe("vetSheetHooks", () => {
  it("gives the reason narrate()'s guard writes for each line it drops", () => {
    const s = sheet({}, TOP_TWO);
    const hooks = ["Test Headliner at Sample Hall: country and folk.", "Test Headliner at Sample Hall: folk with a cozy room."].map((text) => ({ text, tagIds: [] }));
    const r = vetSheetHooks(s, hooks);
    expect(r.hooks.map((h) => h.text)).toEqual(["Test Headliner at Sample Hall: country and folk."]);
    expect(r.reasons).toEqual(['copyHooks[1]: a room size from a taste tag ("cozy room")']);
  });
});
