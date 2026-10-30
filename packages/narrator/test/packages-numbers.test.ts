/**
 * Round 5: an area line's own numbers (percentiles, lift, budget share, an equal split), "stands out most" lists, a
 * partner called a before-show stop, and the two text-only fixes ("an 82nd", "about 2.0 times"). Then the true lines
 * those rules must keep (another area's figure, "more than 2 times", "about evenly", "2nd for lift"), and fan copy that
 * calls the room small from a taste tag. Synthetic data only.
 */
import type { Envelope, LiftTile, Partner, PrePostSpot, QlooEntity, StreetSheet } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import {
  anBeforeNumber,
  diffSummary,
  liftFigureStyle,
  narrate,
  templatePartnerLine,
  templateSummary,
  templateTileWhy,
  vetCopyHooks,
  vetNarration,
  type Narration,
} from "../src/index";
import { fakeMessage, makeBill, makeInput, mockClient } from "./helpers";

function env<T>(results: T): Envelope<T> {
  return { status: "ok", summary: "synthetic", results, provenance: [], limits: [] };
}

function ent(id: string, name: string): QlooEntity {
  return { entityId: id, name, subtype: "urn:entity:place", popularity: 0.5, affinity: 0.5, tags: [], properties: {} };
}

// Venue at (36.1, -86.7). Five numbered areas and one unnumbered square (Side Yard) that outranks Fifth Ward.
function tiles(): LiftTile[] {
  return [
    { geohash: "dn6t00", lat: 36.2, lon: -86.7, lift: 2.2448, billPct: 0.82, housePct: 0.09, popularityPct: 0.7, name: "Hilltop" },
    { geohash: "dn6t01", lat: 36.1, lon: -86.6, lift: 2.0406, billPct: 0.85, housePct: 0.16, popularityPct: 0.6, name: "Riverbend" },
    { geohash: "dn6t02", lat: 36.1, lon: -86.8, lift: 1.9, billPct: 0.73, housePct: 0.15, popularityPct: 0.5, name: "Oak Park" },
    { geohash: "dn6t03", lat: 36.0, lon: -86.7, lift: 1.7657, billPct: 0.8049, housePct: 0.239, popularityPct: 0.5, name: "Kenilworth" },
    { geohash: "dn6t04", lat: 36.0, lon: -86.6, lift: 1.6, billPct: 0.9, housePct: 0.4, popularityPct: 0.5, name: "Fifth Ward" },
    { geohash: "dn6t05", lat: 36.0, lon: -86.8, lift: 1.7, billPct: 0.88, housePct: 0.3, popularityPct: 0.5, name: "Side Yard" },
  ];
}

function partner(id: string, name: string, tile: string, tileName: string): Partner {
  return { entity: ent(id, name), tileGeohash: tile, tileName, category: "cafe", score: 0.8, qlooRank: 3, chips: [], hoursOnDay: "07:00:00-15:00:00" };
}

function spot(id: string, name: string): PrePostSpot {
  return { entity: ent(id, name), deltaRank: 2, expectedShare: 0.1, assumedCapacity: 60, fanFacingAllowed: true, chips: [] };
}

const SHARES = [0.212, 0.212, 0.192, 0.192, 0.192];

function sheet(n: Partial<Narration>, shares: number[] = SHARES): StreetSheet {
  const ts = tiles();
  return {
    planId: "synthetic-r5",
    createdAt: "2026-10-29T00:00:00.000Z",
    mode: "live",
    hypothetical: false,
    bill: makeBill(),
    operator: { seatsLeft: null, capacity: null, mediaBudgetUsd: 5000, streetTeamDays: ["thursday"], radiusKm: 40, declaredPartners: [] },
    cards: {
      resolution: env([]),
      liftMap: env({ tiles: ts, diagnostics: { spearmanLiftVsHeat: null, baseline: "house" as const } }),
      partners: env([partner("E-C1", "Sample Coffeehouse", "dn6t00", "Hilltop"), partner("E-C2", "Example Diner", "dn6t00", "Hilltop")]),
      declared: env([]),
      prePost: env([spot("E-C2", "Example Diner"), spot("E-S9", "Fixture Grill")]),
      media: env([]),
      demographics: env({ bill: [], house: [] }),
      whatsDifferent: env({ shared: [], a: [], b: [], fromTagDiff: false }),
      copyHooks: env([]),
    },
    narration: { summary: "Test Headliner at Sample Hall.", tileWhy: [], partnerLines: [], templated: false, ...n },
    ledger: [],
    guard: { dropped: 0, reasons: [], deniedTagCount: 0 },
    budgetSplit: ts.slice(0, 5).map((t, i) => ({ geohash: t.geohash, share: shares[i]!, label: "heuristic, not a forecast" })),
    limits: [],
  };
}

const area = (geohash: string, text: string) => sheet({ tileWhy: [{ geohash, text }] });
const replaced = (s: StreetSheet) => vetNarration(s).replaced;

describe("an area line cites only its own numbers", () => {
  it("replaces a percentile that is not the area's own (81st for an area at 80.49) and keeps the right one", () => {
    const wrong = area("dn6t03", "Kenilworth shows about 1.8 times the room's usual crowd, at the 81st percentile for this bill, and has no partner places on the sheet yet.");
    const res = vetNarration(wrong);
    expect(res.replaced).toEqual(["tileWhy[0]: says the 81st percentile, the area's are 80th for this crowd and 24th for the room's usual crowd"]);
    expect(res.narration!.tileWhy[0]!.text).toBe(templateTileWhy(tiles()[3]!));
    expect(replaced(area("dn6t03", "Kenilworth shows about 1.8 times the room's usual crowd, at the 80th percentile for this bill."))).toEqual([]);
    // Both of the area's percentiles, each said for its own crowd.
    expect(replaced(area("dn6t03", "Kenilworth sits at the 80th percentile for this bill and the 24th for the usual crowd."))).toEqual([]);
    expect(replaced(area("dn6t03", "Kenilworth is at the 80th percentile for this bill against the 24th percentile for the room."))).toEqual([]);
    // The right number for the wrong crowd.
    expect(replaced(area("dn6t03", "Kenilworth sits at the 24th percentile for this bill."))[0]).toMatch(/says the 24th percentile/);
  });

  it("replaces a lift figure that is not the area's and keeps one that rounds to it", () => {
    expect(replaced(area("dn6t00", "Hilltop shows about 2.4 times the room's usual crowd."))[0]).toMatch(/says about 2\.4 times, the area's lift is about 2\.2 times/);
    expect(replaced(area("dn6t00", "Hilltop shows about 2.2 times the room's usual crowd."))).toEqual([]);
    expect(replaced(area("dn6t01", "Riverbend shows about 2 times the room's usual crowd."))).toEqual([]);
    expect(replaced(area("dn6t01", "Riverbend shows about 2.0 times the room's usual crowd."))).toEqual([]);
  });

  it("replaces a budget percent that is not the area's share and keeps one that rounds to it", () => {
    expect(replaced(area("dn6t02", "Oak Park gets a rough split of the budget of 19.2%."))).toEqual([]);
    expect(replaced(area("dn6t02", "Oak Park gets about 19% of the rough split of the budget."))).toEqual([]);
    expect(replaced(area("dn6t02", "Oak Park gets 21.2% of the rough split of the budget."))[0]).toMatch(/says 21\.2% of the budget, the area's share is 19\.2%/);
  });

  it("replaces an equal budget split the sheet doesn't show and keeps a true one", () => {
    const text = "Fifth Ward shows about 1.6 times the room's usual crowd and carries a rough split of the budget equal to the other Chicago-area tiles.";
    const res = vetNarration(area("dn6t04", text));
    expect(res.replaced).toEqual(["tileWhy[0]: claims an equal budget split the sheet doesn't show"]);
    expect(res.narration!.tileWhy[0]!.text).toBe(templateTileWhy(tiles()[4]!));
    expect(replaced(sheet({ tileWhy: [{ geohash: "dn6t04", text }] }, [0.2, 0.2, 0.2, 0.2, 0.2]))).toEqual([]);
    // The same share as the area it names.
    expect(replaced(area("dn6t04", "Fifth Ward gets the same rough split of the budget as Kenilworth."))).toEqual([]);
    expect(replaced(area("dn6t04", "Fifth Ward gets the same rough split of the budget as Hilltop."))[0]).toMatch(/equal budget split/);
    expect(replaced(sheet({ summary: "Test Headliner at Sample Hall. The budget is split evenly across five areas." }))[0]).toMatch(/^summary: claims an equal budget split/);
  });
});

describe("'stands out most' names the top of the map", () => {
  it("replaces a list that leaves out an area that stands out more, and keeps the true top", () => {
    const res = vetNarration(sheet({ summary: "This crowd stands out most in Hilltop, Riverbend, Oak Park and Fifth Ward, compared with the room's usual crowd." }));
    expect(res.replaced).toEqual(['summary: "stands out most" not backed by the sheet\'s numbers (Kenilworth stands out more)']);
    expect(replaced(sheet({ summary: "This crowd stands out most in the Hilltop, Riverbend and Oak Park areas, compared with the room's usual crowd." }))).toEqual([]);
    expect(replaced(sheet({ summary: "This crowd stands out in five areas, most strongly in Hilltop and Riverbend." }))).toEqual([]);
    expect(replaced(sheet({ summary: "This crowd stands out in five areas, most strongly in Hilltop and Oak Park." }))[0]).toMatch(/most strongly.*Riverbend stands out more/);
  });

  it("replaces a summary that calls an area's partners spots, and keeps the spots list named as such", () => {
    const bad = "Test Headliner at Sample Hall. Start with the Hilltop partners and the Riverbend and Oak Park spots.";
    expect(replaced(sheet({ summary: bad }))).toEqual(["summary: calls an area's places spots; the sheet's spots are near the room"]);
    expect(replaced(sheet({ summary: "Test Headliner at Sample Hall. Start with the Hilltop partners and the spots near the room." }))).toEqual([]);
  });

  it("checks the summary's numbers for the one area a sentence names", () => {
    expect(replaced(sheet({ summary: "Test Headliner at Sample Hall. The strongest, Hilltop, is about 2.6 times the room's usual crowd." }))[0]).toMatch(/^summary: says about 2\.6 times/);
    expect(replaced(sheet({ summary: "Test Headliner at Sample Hall. The strongest, Hilltop, is about 2.2 times the room's usual crowd." }))).toEqual([]);
  });
});

describe("a partner line calls a place a stop before the show only when it is on the spots list", () => {
  it("replaces the claim for a partner that is not a spot and keeps it for one that is", () => {
    const line = (entityId: string, text: string) => sheet({ partnerLines: [{ entityId, text }] });
    const not = vetNarration(line("E-C1", "Coffeehouse near Hilltop, open Thursday 07:00 to 15:00, a before-show stop."));
    expect(not.replaced).toEqual(["partnerLines[0]: calls the place a stop before or after the show; it is not on the sheet's spots list"]);
    expect(not.narration!.partnerLines[0]!.text).toBe(templatePartnerLine(partner("E-C1", "Sample Coffeehouse", "dn6t00", "Hilltop")));
    for (const text of ["Cafe near Hilltop, a good early stop before the show.", "Cafe near Hilltop, also a before-show spot with social tags.", "Cafe, a daytime before or after stop."]) {
      expect(replaced(line("E-C1", text)), text).toHaveLength(1);
    }
    expect(replaced(line("E-C2", "Diner near Hilltop, open Thursday 07:00 to 15:00, also a before-show spot."))).toEqual([]);
    expect(replaced(line("E-C1", "Cafe near Hilltop, open Thursday 07:00 to 15:00."))).toEqual([]);
  });
});

describe("no false alarms: figures that are not the area's own, true near-equal splits", () => {
  const AFC = [0.427, 0.143, 0.143, 0.143, 0.144];

  it("reads whose percentile it is from the words straight after it, and skips an ordinal that is not a percentile", () => {
    // True lines: the room's usual crowd is named later in the sentence, not as whose percentile it is.
    expect(replaced(area("dn6t00", "Hilltop sits at the 82nd percentile for this crowd compared with the room's usual crowd."))).toEqual([]);
    expect(replaced(area("dn6t00", "Hilltop is at the 82nd percentile for this bill versus the room's usual crowd."))).toEqual([]);
    expect(replaced(area("dn6t00", "Hilltop is at the 82nd percentile for this bill against the 9th percentile for the room."))).toEqual([]);
    expect(replaced(area("dn6t00", "Hilltop shows an 82nd percentile bill rank."))).toEqual([]);
    // "2nd for lift" is a rank, not a percentile.
    expect(replaced(area("dn6t01", "Riverbend is 2nd for lift, at the 85th percentile for this crowd."))).toEqual([]);
    // Still caught: the room's number said for this crowd, and a number that is neither.
    expect(replaced(area("dn6t00", "Hilltop sits at the 9th percentile for this crowd."))).toEqual([
      "tileWhy[0]: says the 9th percentile for this crowd, which is the room's usual crowd's; this crowd's is 82nd",
    ]);
    expect(replaced(area("dn6t00", "Hilltop sits at the 82nd percentile for the room's usual crowd."))[0]).toMatch(/says the 82nd percentile for the room's usual crowd, which is this crowd's; the room's is 9th/);
    expect(replaced(area("dn6t00", "Hilltop sits at the 85th percentile."))[0]).toMatch(/says the 85th percentile, the area's are 82nd for this crowd and 9th/);
  });

  it("keeps a near-equal split said as such, and an 'even' that is not about the split", () => {
    const rest = "Test Headliner at Sample Hall. Hilltop gets the largest share; the other four areas split the rest about evenly.";
    expect(replaced(sheet({ summary: rest }, AFC))).toEqual([]);
    expect(replaced(sheet({ summary: rest }))).toEqual(["summary: claims an equal budget split the sheet doesn't show"]);
    expect(replaced(sheet({ tileWhy: [{ geohash: "dn6t01", text: "Riverbend gets the same rough split of the budget as the other three areas." }] }, AFC))).toEqual([]);
    expect(replaced(area("dn6t04", "Fifth Ward shows about 1.6 times the room's usual crowd, and even a small part of the rough split of the budget reaches it."))).toEqual([]);
    // Still caught: an exact claim the shares don't show.
    expect(replaced(sheet({ summary: "Test Headliner at Sample Hall. The budget is split evenly across five areas." }, AFC))[0]).toMatch(/equal budget split/);
  });

  it("skips a figure that is another area's or set against another, and still checks the area's own", () => {
    const line = (geohash: string, text: string) => replaced(sheet({ tileWhy: [{ geohash, text }] }, AFC));
    expect(line("dn6t01", "Riverbend shows about 2.0 times the room's usual crowd, behind Hilltop at about 2.2 times.")).toEqual([]);
    expect(line("dn6t01", "Riverbend gets 14.3% of the rough split of the budget, while Hilltop gets 42.7%.")).toEqual([]);
    expect(line("dn6t00", "Hilltop shows more than 2 times the room's usual crowd.")).toEqual([]);
    expect(line("dn6t01", "Behind Hilltop, Riverbend shows about 2.4 times the room's usual crowd.")[0]).toMatch(/says about 2\.4 times/);
    expect(line("dn6t01", "Riverbend gets 42.7% of the rough split of the budget.")[0]).toMatch(/says 42\.7% of the budget, the area's share is 14\.3%/);
    // A summary sentence naming one area checks only the figures beside its name.
    expect(replaced(sheet({ summary: "Test Headliner at Sample Hall. Five areas sit at the 73rd percentile or higher for this crowd, led by Hilltop." }))).toEqual([]);
    expect(replaced(sheet({ summary: "Test Headliner at Sample Hall. The map's five areas run from about 1.6 times to about 2.2 times the room's usual crowd, and the street team starts in Hilltop." }))).toEqual([]);
  });
});

describe("fan copy never calls the room small from a taste tag", () => {
  const withHooks = (texts: string[]) => {
    const s = sheet({});
    return { ...s, cards: { ...s.cards, copyHooks: env(texts.map((text) => ({ text, tagIds: [] }))) } };
  };

  it("drops 'an intimate room' and 'a cozy room' and keeps other ambience lines", () => {
    const kept = [
      "Test Headliner at Sample Hall: empowerment and confidence, a lively room for your friends.",
      "Test Headliner at Sample Hall: country and folk, with a relaxing, welcoming room.",
      "Test Headliner at Sample Hall: bluegrass with a cozy, lively feel.",
      "Test Headliner at Sample Hall on Saturday. Intimate, welcoming and unique.",
    ];
    const dropped = [
      "Test Headliner, Saturday at Sample Hall: country, roots rock and an intimate room.",
      "Test Headliner at Sample Hall: country and folk, with a cozy room.",
      "Test Headliner at Sample Hall: a small, welcoming venue.",
    ];
    expect(vetCopyHooks(withHooks([...dropped, ...kept])).map((h) => h.text)).toEqual(kept);
  });

  it("narrate() drops such a line from the model's copy", async () => {
    const input = makeInput();
    const draft = {
      summary: templateSummary(input),
      tileWhy: [],
      partnerLines: [],
      copyHooks: [
        { text: "Test Headliner: test folk in an intimate room.", tagIds: ["urn:tag:genre:music:test_folk"] },
        { text: "Test Headliner: test twang in a lively room.", tagIds: ["urn:tag:genre:music:test_twang"] },
      ],
    };
    const { client } = mockClient([fakeMessage({ content: JSON.stringify(draft) })]);
    const res = await narrate(input, { client });
    expect(res.copyHooks.map((h) => h.text)).toEqual(["Test Headliner: test twang in a lively room."]);
    expect(res.guard.reasons).toContain('copyHooks[0]: a room size from a taste tag ("intimate room")');
  });
});

describe("text-only fixes for Claude's lines", () => {
  it("writes 'an' before a number said with a vowel sound, and nothing else", () => {
    expect(anBeforeNumber("with a 82nd percentile bill rank, with a 80th, and a 85th")).toBe("with an 82nd percentile bill rank, with an 80th, and an 85th");
    expect(anBeforeNumber("A 8 km walk, a 11th, a 18th")).toBe("An 8 km walk, an 11th, an 18th");
    expect(anBeforeNumber("a 98th percentile, a 110th, a 180th, a 1,800")).toBe("a 98th percentile, a 110th, a 180th, a 1,800");
  });

  it("writes a whole-number lift as the sheet's figure when that figure ends in .0", () => {
    expect(liftFigureStyle("Bethesda shows a lift of about 2 times the room's usual crowd.", 2.0406)).toBe("Bethesda shows a lift of about 2.0 times the room's usual crowd.");
    expect(liftFigureStyle("Shows about 2 times the room's usual crowd.", 2.2448)).toBe("Shows about 2 times the room's usual crowd.");
    expect(liftFigureStyle("Shows about 1.2 times and 12 times.", 2.0406)).toBe("Shows about 1.2 times and 12 times.");
  });

  it("narrate() writes both into the model's lines", async () => {
    const input = makeInput();
    input.tiles[0] = { ...input.tiles[0]!, lift: 2.0406, billPct: 0.82 };
    const draft = {
      summary: templateSummary(input),
      tileWhy: [{ geohash: "dn6m9q", text: "North Example shows about 2 times the room's usual crowd, with a 82nd percentile bill rank." }],
      partnerLines: [],
      copyHooks: [],
    };
    const { client } = mockClient([fakeMessage({ content: JSON.stringify(draft) })]);
    const res = await narrate(input, { client });
    expect(res.templated).toBe(false);
    expect(res.tileWhy[0]!.text).toBe("North Example shows about 2.0 times the room's usual crowd, with an 82nd percentile bill rank.");
  });
});

describe("diffSummary", () => {
  it("counts each lean column without the tags both crowds rank high", () => {
    const t = (id: string) => ({ id });
    const r = { a: [t("x"), t("y"), t("z")], b: [t("y"), t("w")], shared: [t("y")] };
    expect(diffSummary("15 tags rank higher for this bill, 15 for the room's usual crowd, and 6 rank high for both.", r)).toBe(
      "2 tags rank higher for this bill, 1 for the room's usual crowd, and 1 ranks high for both.",
    );
    expect(diffSummary("There is no usual crowd to compare this bill with.", r)).toBe("There is no usual crowd to compare this bill with.");
  });
});
