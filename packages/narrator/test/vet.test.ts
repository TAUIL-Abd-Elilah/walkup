/**
 * The narration and fan-copy guard (src/vet.ts). Every sheet, name, tag and line below is synthetic.
 */
import { readFileSync } from "node:fs";
import type { CompareTag, CopyHook, Envelope, LiftTile, Partner, QlooEntity, StreetSheet } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import {
  compassIndex,
  geohashCenter,
  isAudienceTag,
  narrate,
  templateNarrate,
  templatePartnerLine,
  templateTileWhy,
  vetCopyHooks,
  vetNarration,
  vetWhatsDifferent,
  type Narration,
} from "../src/index";
import * as vetEntry from "../src/vet";
import { fakeMessage, makeBill, makeInput, mockClient } from "./helpers";

function env<T>(results: T): Envelope<T> {
  return { status: "ok", summary: "synthetic", results, provenance: [], limits: [] };
}

function ent(id: string, name: string): QlooEntity {
  return { entityId: id, name, subtype: "urn:entity:place", popularity: 0.5, affinity: 0.5, tags: [], properties: {} };
}

const FOLK = { id: "urn:tag:genre:music:test_folk", name: "Folk" };
const COUNTRY = { id: "urn:tag:genre:music:test_country", name: "Country" };
const HERITAGE = { id: "urn:tag:theme:qloo:test_heritage", name: "Heritage" };
const SUPPORTIVE = { id: "urn:tag:audience:qloo:test_supportive", name: "Supportive" };
const MALE = { id: "urn:tag:gender:qloo:test_male", name: "Male" };
const CASUAL = { id: "urn:tag:ambience:qloo:test_casual", name: "Casual" };

// Venue at (36.1, -86.7): Hilltop lies north, Riverbend east, Oak Park west.
function tiles(): LiftTile[] {
  return [
    { geohash: "dn6t00", lat: 36.2, lon: -86.7, lift: 2.2, billPct: 0.91, housePct: 0.4, popularityPct: 0.7, name: "Hilltop", adultPopulation: 5000 },
    { geohash: "dn6t01", lat: 36.1, lon: -86.6, lift: 1.8, billPct: 0.95, housePct: 0.5, popularityPct: 0.6, name: "Riverbend", adultPopulation: 9000 },
    { geohash: "dn6t02", lat: 36.1, lon: -86.8, lift: 1.5, billPct: 0.8, housePct: 0.6, popularityPct: 0.5, name: "Oak Park", adultPopulation: 3000 },
  ];
}

function partners(): Partner[] {
  return [
    {
      entity: ent("E-P1", "Example Records"),
      tileGeohash: "dn6t00",
      tileName: "Hilltop",
      category: "record_store",
      score: 0.9,
      qlooRank: 1,
      chips: [],
      explain: { tags: [FOLK], activation: "Ask to leave flyers.", confidence: "high", confidenceWhy: "Synthetic.", ledgerRefs: [] },
    },
    {
      entity: ent("E-P2", "Placeholder Kitchen"),
      tileGeohash: "dn6t01",
      tileName: "Riverbend",
      category: "restaurant",
      score: 0.8,
      qlooRank: 2,
      chips: [],
      explain: { tags: [CASUAL], activation: "Ask to leave flyers.", confidence: "high", confidenceWhy: "Synthetic.", ledgerRefs: [] },
    },
  ];
}

function narration(over: Partial<Narration> = {}): Narration {
  return {
    summary: "Test Headliner at Sample Hall stands out in three areas; Hilltop leads at about 2.2 times the room's usual crowd.",
    tileWhy: [
      { geohash: "dn6t00", text: "Hilltop, north of the venue, shows about 2.2 times the room's usual crowd." },
      { geohash: "dn6t01", text: "Riverbend shows about 1.8 times the room's usual crowd." },
      { geohash: "dn6t02", text: "Oak Park shows about 1.5 times the room's usual crowd." },
    ],
    partnerLines: [
      { entityId: "E-P1", text: "Record store in Hilltop that shares the bill's folk tag; open Thursday 10:00 to 20:00." },
      { entityId: "E-P2", text: "Restaurant in Riverbend, a casual place to leave flyers." },
    ],
    templated: false,
    ...over,
  };
}

function makeSheet(n: Narration | undefined = narration(), hooks: CopyHook[] = []): StreetSheet {
  const wd: { shared: CompareTag[]; a: CompareTag[]; b: CompareTag[]; fromTagDiff: boolean } = {
    shared: [],
    a: [COUNTRY, FOLK, SUPPORTIVE, MALE, { ...COUNTRY }, HERITAGE],
    b: [],
    fromTagDiff: false,
  };
  return {
    planId: "synthetic-plan",
    createdAt: "2026-10-21T00:00:00.000Z",
    mode: "fixture",
    hypothetical: true,
    bill: makeBill(),
    operator: { seatsLeft: null, capacity: null, mediaBudgetUsd: null, streetTeamDays: ["thursday"], radiusKm: 40, declaredPartners: [] },
    cards: {
      resolution: env([]),
      liftMap: env({ tiles: tiles(), diagnostics: { spearmanLiftVsHeat: null, baseline: "house" as const } }),
      partners: env(partners()),
      declared: env([]),
      prePost: env([]),
      media: env([]),
      demographics: env({ bill: [], house: [] }),
      whatsDifferent: env(wd),
      copyHooks: env(hooks),
    },
    ...(n ? { narration: n } : {}),
    ledger: [],
    guard: { dropped: 0, reasons: [], deniedTagCount: 0 },
    budgetSplit: [
      { geohash: "dn6t00", share: 0.5, label: "heuristic, not a forecast" },
      { geohash: "dn6t01", share: 0.3, label: "heuristic, not a forecast" },
      { geohash: "dn6t02", share: 0.2, label: "heuristic, not a forecast" },
    ],
    limits: [],
  };
}

const tileLine = (i: number, text: string): Narration => {
  const n = narration();
  n.tileWhy[i] = { ...n.tileWhy[i]!, text };
  return n;
};

describe("geometry", () => {
  it("decodes a geohash to its cell centre and gives 8-point bearings", () => {
    const c = geohashCenter("u4pruydqqvj")!;
    expect(c.lat).toBeCloseTo(57.64911, 4);
    expect(c.lon).toBeCloseTo(10.40744, 4);
    expect(geohashCenter("not-a-hash")).toBeNull();
    const v = { lat: 36.1, lon: -86.7 };
    expect(compassIndex(v, { lat: 36.2, lon: -86.7 })).toBe(0); // north
    expect(compassIndex(v, { lat: 36.1, lon: -86.6 })).toBe(2); // east
    expect(compassIndex(v, { lat: 36.0, lon: -86.7 })).toBe(4); // south
    expect(compassIndex(v, { lat: 36.1, lon: -86.8 })).toBe(6); // west
    expect(compassIndex(v, v)).toBeNull();
  });
});

describe("vetNarration", () => {
  it("keeps a clean narration as it is, and defaults to the sheet's own narration", () => {
    const sheet = makeSheet();
    const res = vetNarration(sheet);
    expect(res.replaced).toEqual([]);
    expect(res.narration).toEqual(sheet.narration);
    expect(vetNarration(sheet, null).narration).toEqual(sheet.narration);
    const bare = makeSheet();
    delete bare.narration;
    expect(vetNarration(bare)).toEqual({ narration: undefined, replaced: [] });
  });

  it("keeps a direction that matches the area's bearing (or the neighbouring point) and replaces a wrong one", () => {
    const right = vetNarration(makeSheet(tileLine(1, "Riverbend, east of the venue, shows about 1.8 times the room's usual crowd.")));
    expect(right.replaced).toEqual([]);
    const near = vetNarration(makeSheet(tileLine(1, "Riverbend, in the northeastern suburbs, shows about 1.8 times the room's usual crowd.")));
    expect(near.replaced).toEqual([]);

    const wrong = vetNarration(makeSheet(tileLine(1, "Riverbend, in the western suburbs, shows about 1.8 times the room's usual crowd.")));
    expect(wrong.replaced).toEqual(["tileWhy[1]: direction claim not backed by the map"]);
    expect(wrong.narration!.tileWhy[1]).toEqual({ geohash: "dn6t01", text: templateTileWhy(tiles()[1]!) });
    expect(wrong.narration!.tileWhy[0]).toEqual(narration().tileWhy[0]); // untouched
    expect(wrong.narration!.templated).toBe(false);
  });

  it("checks summary directions against the areas named in the same sentence, else most of the top areas", () => {
    const named = vetNarration(makeSheet(narration({ summary: "Start north of the venue in Hilltop. Then work Oak Park." })));
    expect(named.replaced).toEqual([]);
    const wrongNamed = vetNarration(makeSheet(narration({ summary: "Start with Hilltop and the western suburbs." })));
    expect(wrongNamed.replaced).toEqual(["summary: direction claim not backed by the map"]);
    expect(wrongNamed.narration!.summary).toContain("Test Headliner and Test Support at Sample Hall, Saturday, Nov 28.");
    // Top areas lie north, east and west: "the east side" matches only one of three.
    const unnamed = vetNarration(makeSheet(narration({ summary: "The crowd stands out on the east side." })));
    expect(unnamed.replaced).toEqual(["summary: direction claim not backed by the map"]);
  });

  it("replaces forecasts, 'concentrated' and 'most common area' lines with the template", () => {
    const sheet = makeSheet(
      narration({
        summary: "Start with Hilltop, where about 2.2 times the room's usual crowd is expected.",
        tileWhy: [
          { geohash: "dn6t00", text: "Hilltop is the most common area in the room's usual crowd." },
          { geohash: "dn6t01", text: "Riverbend is where the bill's crowd is most concentrated." },
          { geohash: "dn6t02", text: "Oak Park shows about 1.5 times the room's usual crowd." },
        ],
      }),
    );
    const res = vetNarration(sheet);
    expect(res.replaced).toHaveLength(3);
    expect(res.replaced[0]).toMatch(/^summary: forecast/);
    expect(res.replaced[1]).toMatch(/^tileWhy\[0\]: "most common"/);
    expect(res.replaced[2]).toMatch(/^tileWhy\[1\]: "concentrated"/);
    const n = res.narration!;
    expect(n.summary).not.toMatch(/expected/);
    expect(n.tileWhy.map((t) => t.text)).toEqual([templateTileWhy(tiles()[0]!), templateTileWhy(tiles()[1]!), "Oak Park shows about 1.5 times the room's usual crowd."]);
  });

  it("keeps a superlative only when the area really has the maximum", () => {
    const ok = [
      tileLine(0, "Hilltop has the strongest lift on the sheet, about 2.2 times the room's usual crowd."),
      tileLine(1, "Riverbend has the largest adult population on the sheet."),
      tileLine(1, "Riverbend has the highest percentile for this bill of any area on the sheet."),
      tileLine(0, "Hilltop holds the largest share of the rough split of the budget."),
      // About lift, the metric named first: Hilltop has the most lift, Riverbend the higher percentile.
      tileLine(0, "Hilltop has the largest lift on the sheet, about 2.2 times the room's usual crowd, at the 91st percentile for this bill."),
    ];
    for (const n of ok) expect(vetNarration(makeSheet(n)).replaced).toEqual([]);
    expect(vetNarration(makeSheet(tileLine(1, "Riverbend has the largest lift on the sheet, at the 95th percentile for this bill."))).replaced[0]).toMatch(/superlative "largest"/);
    const bad = [
      tileLine(2, "Oak Park has the strongest lift on the sheet."),
      tileLine(0, "Hilltop has the largest adult population on the sheet."),
      tileLine(2, "Oak Park has the highest bill share of any area on the sheet."),
      tileLine(1, "Riverbend holds the largest share of the rough split of the budget."),
      tileLine(1, "Riverbend has the most partners."),
    ];
    for (const n of bad) expect(vetNarration(makeSheet(n)).replaced[0]).toMatch(/superlative/);
  });

  it("replaces a partner line that cites a tag the place does not share, and keeps a correct one", () => {
    const n = narration({
      partnerLines: [
        { entityId: "E-P1", text: "Record store in Hilltop that shares the bill's folk tag; open Thursday 10:00 to 20:00." },
        { entityId: "E-P2", text: "Restaurant in Riverbend, open Thursday, that shares country and folk tags with the bill." },
      ],
    });
    const res = vetNarration(makeSheet(n));
    expect(res.replaced).toHaveLength(1);
    expect(res.replaced[0]).toMatch(/^partnerLines\[1\]: names "(country|folk)"/);
    expect(res.narration!.partnerLines[0]).toEqual(n.partnerLines[0]);
    expect(res.narration!.partnerLines[1]).toEqual({ entityId: "E-P2", text: templatePartnerLine(partners()[1]!) });
  });

  it("never turns a diet tag into the kind of place", () => {
    const line = (text: string) => vetNarration(makeSheet(narration({ partnerLines: [{ entityId: "E-P2", text }] }))).replaced;
    expect(line("Vegan restaurant in Riverbend, open Thursday 17:00 to 21:00.")[0]).toMatch(/vegan restaurant/);
    expect(line("Organic cafe in Riverbend.")[0]).toMatch(/organic cafe/);
    expect(line("Restaurant in Riverbend, open Thursday 17:00 to 21:00.")).toEqual([]);
  });

  it("catches a genre written another way, a tag phrase with no genre word, and a wrong weekday", () => {
    const line = (text: string) => vetNarration(makeSheet(narration({ partnerLines: [{ entityId: "E-P2", text }] }))).replaced;
    expect(line("Restaurant in Riverbend sharing the bill's rhythm & blues tag.")[0]).toMatch(/rhythm and blues/);
    expect(line("Restaurant in Riverbend that shares the heritage tag with the bill.")[0]).toMatch(/does not share/);
    expect(line("Restaurant in Riverbend that shares the casual tag with the bill.")).toEqual([]);
    expect(line("Restaurant in Riverbend, open Monday 17:00 to 21:00.")[0]).toMatch(/Monday/);
    expect(line("Restaurant in Riverbend, open Thursday 17:00 to 21:00, close to the Saturday show.")).toEqual([]);
    expect(line("Soul food restaurant in Riverbend.")).toEqual([]);
  });

  it("replaces area lines that name a genre, say 'house', or miscount the area's partners", () => {
    const genre = vetNarration(makeSheet(tileLine(1, "Riverbend shows about 1.8 times the room's usual crowd, a strong match to this bill's country listeners.")));
    expect(genre.replaced).toEqual([`tileWhy[1]: names "country" for an area, which the map doesn't measure`]);
    const house = vetNarration(makeSheet(tileLine(1, "Riverbend shows about 1.8 times the room's usual crowd, with a larger share of the house.")));
    expect(house.replaced[0]).toMatch(/^tileWhy\[1\]: "house" instead of the room's usual crowd/);
    const miscount = vetNarration(makeSheet(tileLine(1, "Riverbend shows about 1.8 times the room's usual crowd and has two partner places on the street team's route.")));
    expect(miscount.replaced).toEqual(["tileWhy[1]: says two partners, the sheet has 1 in this area"]);
    // The reason says "partner" for one, as the line did.
    const one = vetNarration(makeSheet(tileLine(2, "Oak Park shows about 1.5 times the room's usual crowd and has one partner on the sheet.")));
    expect(one.replaced).toEqual(["tileWhy[2]: says one partner, the sheet has 0 in this area"]);
    const right = vetNarration(makeSheet(tileLine(1, "Riverbend shows about 1.8 times the room's usual crowd and has one partner on the sheet.")));
    expect(right.replaced).toEqual([]);
    // The summary may not use "house" either.
    const summary = vetNarration(makeSheet(narration({ summary: "Start in Hilltop, where the bill's share is far above the house share." })));
    expect(summary.replaced[0]).toMatch(/^summary: "house"/);
  });

  it("replaces a percentile written as a share of the crowd, and what-if wording on a live sheet", () => {
    const share = vetNarration(makeSheet(narration({ summary: "Start in Hilltop, where the bill's share of the crowd is about 91% against 40% for the room's usual crowd." })));
    expect(share.replaced[0]).toMatch(/^summary: a share or percent/);
    const tile = vetNarration(makeSheet(tileLine(1, "Riverbend shows about 1.8 times the room's usual crowd, with a high popularity share.")));
    expect(tile.replaced[0]).toMatch(/^tileWhy\[1\]: a share or percent/);
    // The budget split is a share, and a percentile is said as one.
    expect(vetNarration(makeSheet(tileLine(1, "Riverbend shows about 1.8 times the room's usual crowd and gets 30% of the rough split of the budget."))).replaced).toEqual([]);
    expect(vetNarration(makeSheet(tileLine(1, "Riverbend is in the 95th percentile for this crowd."))).replaced).toEqual([]);
    // What-ifs: a live sheet's numbers are the operator's own; a sample sheet's may be called what-ifs.
    const whatIf = narration({ summary: "Start in Hilltop. Capacity figures are what-ifs from the operator." });
    const live = { ...makeSheet(whatIf), mode: "live" as const, hypothetical: true };
    expect(vetNarration(live).replaced[0]).toMatch(/what-ifs" on a live sheet/);
    const sample = { ...makeSheet(whatIf), mode: "fixture" as const, hypothetical: true };
    expect(vetNarration(sample).replaced).toEqual([]);
  });

  it("replaces a partner rank stated as a place on the sheet, and 'differs most' about the wrong areas", () => {
    const rank = vetNarration(makeSheet(tileLine(1, "Riverbend shows about 1.8 times the room's usual crowd, with a partner restaurant ranked first on the sheet.")));
    expect(rank.replaced[0]).toMatch(/a rank the sheet doesn't show/);
    const most = (summary: string) => vetNarration(makeSheet(narration({ summary }))).replaced;
    expect(most("Start in Hilltop, then work Riverbend and Oak Park, where the bill's crowd differs most from the room's usual crowd.")[0]).toMatch(/differs most/);
    expect(most("This crowd stands out most in Hilltop, at about 2.2 times the room's usual crowd.")).toEqual([]);
    expect(most("This crowd stands out most in Riverbend.")[0]).toMatch(/stands out most/);
  });

  it("drops a line for a partner or area the sheet does not have when it fails", () => {
    const n = narration({
      tileWhy: [{ geohash: "zzzzzz", text: "This area is where the crowd is concentrated." }],
      partnerLines: [{ entityId: "E-GONE", text: "Bar that shares the country tag." }],
    });
    const res = vetNarration(makeSheet(n));
    expect(res.narration!.tileWhy).toEqual([]);
    expect(res.narration!.partnerLines).toEqual([]);
    expect(res.replaced.every((r) => r.endsWith("(dropped)"))).toBe(true);
  });
});

describe("vetNarration: nearness, hours and where a crowd is", () => {
  const withPartner = (over: Partial<Partner>, text: string) => {
    const sheet = makeSheet(narration({ partnerLines: [{ entityId: "E-P2", text }] }));
    const p = sheet.cards.partners.results[1]!;
    Object.assign(p, over);
    return vetNarration(sheet);
  };
  const far = { tags: [CASUAL], activation: "Ask.", confidence: "high" as const, confidenceWhy: "Synthetic.", ledgerRefs: [], distanceKm: 35.1 };

  it("replaces 'close to the room' for a place the sheet puts 35 km away, and keeps it for one 1 km away", () => {
    const bad = withPartner({ explain: far }, "Restaurant in Riverbend, open Thursday, shares the casual tag and is close to the room.");
    expect(bad.replaced).toEqual(["partnerLines[0]: says the place is near the room; the sheet puts it 35.1 km away"]);
    expect(bad.narration!.partnerLines[0]!.text).toBe(templatePartnerLine(partners()[1]!));
    const ok = withPartner({ explain: { ...far, distanceKm: 1 } }, "Restaurant in Riverbend, shares the casual tag and is close to the room.");
    expect(ok.replaced).toEqual([]);
  });

  it("lets a place from the near-venue list (searched within 3.5 km) be near the venue, as the template says", () => {
    const nearList = (km: number) => {
      const sheet = makeSheet(narration({ partnerLines: [{ entityId: "E-P2", text: "Restaurant near the venue, shares the casual tag." }] }));
      const { tileName: _area, ...rest } = sheet.cards.partners.results[1]!;
      sheet.cards.partners.results[1] = { ...rest, tileGeohash: null, explain: { ...far, distanceKm: km } };
      return vetNarration(sheet).replaced;
    };
    expect(nearList(2.8)).toEqual([]);
    expect(nearList(3.9)).toEqual(["partnerLines[0]: says the place is near the room; the sheet puts it 3.9 km away"]);
    // A place from an area's search is held to 2 km.
    expect(withPartner({ explain: { ...far, distanceKm: 2.8 } }, "Restaurant near the venue, shares the casual tag.").replaced).toEqual([
      "partnerLines[0]: says the place is near the room; the sheet puts it 2.8 km away",
    ]);
  });

  it("replaces a line that merges split opening hours into one span, and keeps one span quoted as listed", () => {
    const split = { hoursOnDay: "10:00:00-14:00:00, 17:00:00-21:30:00" };
    expect(withPartner(split, "Restaurant in Riverbend, open Thursday 10:00 to 21:30.").replaced).toEqual(["partnerLines[0]: merges split opening hours into one span"]);
    expect(withPartner(split, "Restaurant in Riverbend, open Thursday 10:00 to 14:00.").replaced).toEqual([]);
  });

  it("replaces a summary that says where a crowd comes from, or puts the usual crowd in this crowd's lift areas", () => {
    const from = vetNarration(makeSheet(narration({ summary: "Test Headliner draws a crowd from outer suburbs, about 2.2 times the room's usual crowd in Hilltop." })));
    expect(from.replaced).toEqual(["summary: where the crowd lives or comes from is not on the sheet"]);
    const placed = vetNarration(makeSheet(narration({ summary: "Hilltop leads at about 2.2 times, while the room's usual crowd sits closer to Oak Park." })));
    expect(placed.replaced).toEqual(["summary: places the room's usual crowd in areas where this crowd stands out"]);
    const fine = vetNarration(makeSheet(narration({ summary: "This crowd stands out from the room's usual crowd in 3 areas; Hilltop leads at about 2.2 times." })));
    expect(fine.replaced).toEqual([]);
  });

  it("keeps a comparison with the usual crowd and a percentile, which place no one", () => {
    const keep = (summary: string) => vetNarration(makeSheet(narration({ summary }))).replaced;
    expect(keep("Test Headliner draws a different crowd from the room's usual one; Hilltop leads at about 2.2 times.")).toEqual([]);
    expect(keep("Test Headliner draws a crowd from the room's usual one in Hilltop, at about 2.2 times.")).toEqual([]);
    expect(keep("Test Headliner draws its crowd from the suburbs, about 2.2 times in Hilltop.")).toEqual(["summary: where the crowd lives or comes from is not on the sheet"]);
    expect(keep("Hilltop is in the 91st percentile for this crowd, while the room's usual crowd is in the 40th percentile.")).toEqual([]);
    const tile = vetNarration(makeSheet(tileLine(0, "Hilltop shows about 2.2 times the room's usual crowd and is in the 91st percentile for this crowd.")));
    expect(tile.replaced).toEqual([]);
    // Placed in this crowd's area, the usual crowd still fails.
    expect(keep("Hilltop leads at about 2.2 times, and the room's usual crowd is in Oak Park.")).toEqual([
      "summary: places the room's usual crowd in areas where this crowd stands out",
    ]);
    // In a relative clause the usual crowd is still the verb's subject.
    expect(keep("Hilltop leads at about 2.2 times, while the room's usual crowd that sits near Hilltop is smaller.")).toEqual([
      "summary: places the room's usual crowd in areas where this crowd stands out",
    ]);
    expect(keep("Hilltop leads at about 2.2 times; the room's usual crowd which is in Oak Park is smaller.")).toEqual([
      "summary: places the room's usual crowd in areas where this crowd stands out",
    ]);
  });

  it("replaces a summary that puts the areas on a side of the city", () => {
    // Hilltop lies north, so the direction check passes; the city's side is still not on the map.
    const sheet = makeSheet(narration({ summary: "This crowd stands out in Hilltop and other areas on the North Side of Sampleton." }));
    sheet.bill = { ...sheet.bill, venue: { ...sheet.bill.venue, city: "Sampleton" } };
    expect(vetNarration(sheet).replaced).toEqual(["summary: places the areas on a side of the city, which the map doesn't show"]);
  });
});

describe("isAudienceTag", () => {
  it("is true for audience and identity tags by namespace or name, false for genres and themes", () => {
    for (const t of [
      SUPPORTIVE,
      MALE,
      { id: "urn:tag:audience:qloo:test_engaged", name: "Engaged" },
      { id: "urn:tag:language:qloo:test_english", name: "English" },
      { id: "urn:tag:theme:qloo:test_justice", name: "Social justice" },
      { id: "urn:tag:theme:qloo:test_identity", name: "Identity" },
      "urn:tag:keyword:qloo:civic_minded",
      "News savvy",
      "Diverse",
      "Women",
      "LGBTQ",
    ]) {
      expect(isAudienceTag(t), JSON.stringify(t)).toBe(true);
    }
    for (const t of [FOLK, COUNTRY, HERITAGE, "Spirituals", "Soul", "urn:tag:genre:music:americana", "Americana"]) {
      expect(isAudienceTag(t), JSON.stringify(t)).toBe(false);
    }
  });
});

describe("vetCopyHooks", () => {
  const hooks: CopyHook[] = [
    { text: "Country and folk at Sample Hall, Saturday, Nov 28.", tagIds: [COUNTRY.id, FOLK.id] },
    { text: "A supportive crowd at Sample Hall on Saturday.", tagIds: [SUPPORTIVE.id] },
    { text: "Heritage night at Sample Hall, for a news savvy crowd.", tagIds: [HERITAGE.id] },
    { text: "Test Headliner brings heritage to Sample Hall.", tagIds: [HERITAGE.id] },
  ];

  it("drops audience lines and makes every remaining line name the act", () => {
    const out = vetCopyHooks(makeSheet(undefined, hooks));
    expect(out).toEqual([
      { text: "Test Headliner: Country and folk at Sample Hall, Saturday, Nov 28.", tagIds: [COUNTRY.id, FOLK.id] },
      { text: "Test Headliner brings heritage to Sample Hall.", tagIds: [HERITAGE.id] },
    ]);
    // Defaults to the copy card's lines.
    expect(vetCopyHooks(makeSheet(undefined, hooks))).toEqual(vetCopyHooks(makeSheet(undefined, []), hooks));
  });

  it("drops a line that claims what the sheet can't back (a return, scarce tickets)", () => {
    const out = vetCopyHooks(makeSheet(undefined, []), [
      { text: "Test Headliner returns to Sample Hall for country and folk.", tagIds: [COUNTRY.id, FOLK.id] },
      { text: "Test Headliner at Sample Hall: country and folk, selling fast.", tagIds: [COUNTRY.id, FOLK.id] },
      { text: "Test Headliner at Sample Hall: country and folk.", tagIds: [COUNTRY.id, FOLK.id] },
    ]);
    expect(out.map((h) => h.text)).toEqual(["Test Headliner at Sample Hall: country and folk."]);
  });

  it("accepts any act on the bill and falls back to act, venue and date when nothing is left", () => {
    expect(vetCopyHooks(makeSheet(undefined, []), [{ text: "Test Support and folk at Sample Hall.", tagIds: [FOLK.id] }])[0]!.text).toBe(
      "Test Support and folk at Sample Hall.",
    );
    expect(vetCopyHooks(makeSheet(undefined, []), [hooks[1]!])).toEqual([{ text: "Test Headliner at Sample Hall, Saturday, Nov 28.", tagIds: [] }]);
    // A line with a colon of its own gets the act as a sentence, never a second colon.
    const colon = vetCopyHooks(makeSheet(undefined, []), [{ text: "Saturday, Nov 28 at Sample Hall: country and folk.", tagIds: [COUNTRY.id, FOLK.id] }]);
    expect(colon.map((h) => h.text)).toEqual(["Test Headliner. Saturday, Nov 28 at Sample Hall: country and folk."]);
  });
});

describe("vetWhatsDifferent", () => {
  it("lists each tag once and drops audience and identity tags", () => {
    const out = vetWhatsDifferent([COUNTRY, FOLK, SUPPORTIVE, MALE, { ...COUNTRY }, { id: "urn:tag:genre:music:other_folk", name: "folk" }, HERITAGE]);
    expect(out).toEqual([COUNTRY, FOLK, HERITAGE]);
    expect(vetWhatsDifferent(null)).toEqual([]);
  });
});

describe("narrate() applies the guard", () => {
  it("replaces model lines the map does not back with the template's, and records why", async () => {
    const draft = {
      summary: "Start in the southern suburbs, where the crowd is most concentrated.",
      tileWhy: [
        { geohash: "dn6m9q", text: "North Example shows about 1.8 times the room's usual crowd." },
        { geohash: "dn6m9r", text: "This area, southeast of the venue, shows about 1.3 times the room's usual crowd." },
      ],
      partnerLines: [{ entityId: "E-P1", text: "Record store in North Example that shares the bill's test twang tag." }],
      copyHooks: [{ text: "Test folk at Sample Hall.", tagIds: ["urn:tag:genre:music:test_folk"] }],
    };
    const { client } = mockClient([fakeMessage({ content: JSON.stringify(draft) })]);
    const input = makeInput();
    const res = await narrate(input, { client });
    const t = templateNarrate(makeInput());
    expect(res.templated).toBe(false);
    expect(res.summary).toBe(t.summary);
    expect(res.tileWhy).toEqual([draft.tileWhy[0], t.tileWhy[1]]);
    expect(res.partnerLines).toEqual([t.partnerLines[0]]);
    expect(res.copyHooks.map((h) => h.text)).toEqual(["Test Headliner: Test folk at Sample Hall."]);
    const reasons = res.guard.reasons.join("\n");
    expect(reasons).toMatch(/summary: direction claim not backed by the map/);
    expect(reasons).toMatch(/tileWhy\[1\]: direction claim not backed by the map/);
    expect(reasons).toMatch(/partnerLines\[0\]: names "test twang"/);
    // Replaced lines are said in the reasons; they are not dropped claims (each slot keeps a checked line).
    expect(res.guard.reasons.filter((r) => r.startsWith("replaced by the template: "))).toHaveLength(3);
    expect(res.guard.dropped).toBe(0);
  });

  it("writes template hooks that name the act and never use audience tags", () => {
    const input = makeInput();
    input.allowlistTags.push({ id: "urn:tag:audience:qloo:test_supportive", name: "Supportive" });
    input.compareTags!.a.unshift({ id: "urn:tag:audience:qloo:test_supportive", name: "Supportive" });
    const res = templateNarrate(input);
    expect(res.copyHooks.length).toBeGreaterThan(0);
    for (const h of res.copyHooks) {
      expect(h.text).toContain("Test Headliner");
      expect(h.text.toLowerCase()).not.toContain("supportive");
      for (const id of h.tagIds) expect(isAudienceTag({ id })).toBe(false);
    }
    expect(res.summary.toLowerCase()).not.toContain("supportive");
  });
});

describe("the ./vet entry", () => {
  it("exports the guard and imports no SDK or network code", () => {
    expect(typeof vetEntry.vetNarration).toBe("function");
    expect(typeof vetEntry.vetCopyHooks).toBe("function");
    expect(typeof vetEntry.vetWhatsDifferent).toBe("function");
    expect(typeof vetEntry.isAudienceTag).toBe("function");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { exports: Record<string, string> };
    expect(pkg.exports["./vet"]).toBe("./src/vet.ts");
    for (const f of ["vet.ts", "audience.ts", "template.ts", "facts.ts", "policy.ts", "constants.ts"]) {
      const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/@anthropic-ai|from "\.\/(client|openrouter|narrate|spend)"|node:/);
    }
  });
});
