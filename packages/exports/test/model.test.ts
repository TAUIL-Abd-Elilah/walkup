import { describe, expect, it } from "vitest";
import { LIMITS_EVERY_SHEET } from "@walkup/contracts";
import { buildSheetModel, HOURS_NOT_LISTED, PHONE_NOT_LISTED, sheetModelText, THIN_SIGNAL_NOTE } from "../src/sheet-model";
import { formatHours, ledgerRanges, receiptGroup, tMinusDays, tMinusLabel } from "../src/format";
import { makeExplainedSheet, makeSheet, PARTNERS } from "./helpers";

describe("header", () => {
  it("reads like a day sheet: who on the left (headliner, then the rest), date, room and counts on the right", () => {
    const m = buildSheetModel(makeSheet());
    expect(m.kicker).toBe("Walkup street sheet");
    expect(m.sampleLabel).toBeNull();
    expect(m.title).toBe("Juniper Wire, The Lantern Choir, Mesa Static");
    expect(m.headliner).toBe("Juniper Wire");
    expect(m.support).toBe("with The Lantern Choir and Mesa Static");
    expect(m.dateLine).toBe("Fri Nov 20 2026");
    expect(m.placeLine).toBe("Example Hall, Nashville, TN");
    expect(m.subline).toBe("All ages · street team Thu and Sat · 40 km radius");
    expect(m.docTitle).toBe("Street sheet: Juniper Wire, The Lantern Choir, Mesa Static, Example Hall, Fri Nov 20 2026");
    expect(buildSheetModel(makeSheet(), { showName: "Harvest Night" }).dateLine).toBe("Fri Nov 20 2026 · Harvest Night");
    // Headliners first whatever the bill order; one act has no "with" line.
    const solo = makeSheet();
    solo.bill = { ...solo.bill, acts: [{ name: "Mesa Static", role: "support" }, { name: "Juniper Wire", role: "headliner" }] };
    expect(buildSheetModel(solo)).toMatchObject({ headliner: "Juniper Wire", support: "with Mesa Static" });
    solo.bill = { ...solo.bill, acts: [{ name: "Juniper Wire", role: "headliner" }] };
    expect(buildSheetModel(solo)).toMatchObject({ headliner: "Juniper Wire", support: "" });
  });

  it("says the operator's all-ages setting, which only ever adds restrictions", () => {
    const adult = makeSheet();
    adult.bill = { ...adult.bill, legalAgeEnforced: true };
    expect(buildSheetModel(adult).subline.startsWith("21+ ·")).toBe(true);
    adult.operator = { ...adult.operator, allAges: true };
    const m = buildSheetModel(adult);
    expect(m.subline.startsWith("21+ (no bars: operator setting)")).toBe(true);
    // Hooks are held to the stricter rule: the beer hook stays out.
    expect(m.panel6.hooks).not.toContain("Cold beer and banjo.");
    expect(buildSheetModel(adult, { audience: "fan" }).panel2.rows.map((r) => r.name)).not.toContain("Night Owl Taproom");
    const relaxed = makeSheet();
    relaxed.operator = { ...relaxed.operator, allAges: false };
    expect(buildSheetModel(relaxed).subline.startsWith("All ages ·")).toBe(true);
  });

  it("counts T-minus from the plan's creation date", () => {
    expect(tMinusDays("2026-10-09T15:00:00.000Z", "2026-11-20")).toBe(42);
    expect(buildSheetModel(makeSheet()).tMinus).toBe("42 days to the show");
    expect(buildSheetModel(makeSheet(), { asOf: "2026-11-08T09:00:00Z" }).tMinus).toBe("12 days to the show");
    expect(tMinusLabel(1)).toBe("1 day to the show");
    expect(tMinusLabel(0)).toBe("Show day");
    expect(tMinusLabel(-2)).toBe("2 days after the show");
    expect(tMinusLabel(null)).toBe("");
  });

  it("labels sample sheets and what-if counts, with one light watermark, and a live sheet with nothing", () => {
    const live = buildSheetModel(makeSheet());
    expect(live.watermarks).toEqual([]);
    expect(live.labels).toEqual([]);
    expect(live.footer.fixtureNote).toBeNull();
    // Counts as "n of m".
    expect(live.seatsLine).toBe("640 of 1,200 seats left");
    const capOnly = makeSheet();
    capOnly.operator = { ...capOnly.operator, seatsLeft: null };
    expect(buildSheetModel(capOnly).seatsLine).toBe("Capacity 1,200");
    const hyp = buildSheetModel(makeSheet({ hypothetical: true }));
    expect(hyp.watermarks).toEqual(["What-if counts"]);
    // The seats line already says "(assumed)", so no extra label.
    expect(hyp.labels).toEqual([]);
    const noCounts = makeSheet({ hypothetical: true });
    noCounts.operator = { ...noCounts.operator, seatsLeft: null, capacity: null };
    expect(buildSheetModel(noCounts).labels).toEqual(["Counts are what-ifs"]);
    expect(hyp.seatsLine).toBe("640 of 1,200 seats left (assumed)");
    expect(hyp.notes).toContain("Planning tool: Walkup has no sales data for this show.");
    const fx = buildSheetModel(makeSheet({ mode: "fixture", hypothetical: true }));
    expect(fx.sampleLabel).toBe("Sample data");
    expect(fx.labels).toEqual(["Sample data"]);
    // One watermark on a sample sheet, never two.
    expect(fx.watermarks).toEqual(["Sample data"]);
    expect(fx.docTitle.startsWith("Sample street sheet:")).toBe(true);
    expect(fx.footer.fixtureNote).toBe("Sample data: made-up places and numbers, not a live run.");
  });

  it("says when a live sheet was recorded once Qloo is unavailable, and never calls a sample sheet recorded", () => {
    const rec = buildSheetModel(makeSheet(), { recorded: true, printedAt: "2026-11-14T10:00:00Z" });
    expect(rec.labels).toEqual(["Recorded Fri Oct 9 2026"]);
    expect(rec.watermarks).toEqual([]);
    expect(rec.sampleLabel).toBeNull();
    expect(rec.footer.printLine).toMatch(/ · data from Fri Oct 9 2026$/);
    expect(sheetModelText(rec).join("\n")).not.toMatch(/Sample/);
    const fx = buildSheetModel(makeSheet({ mode: "fixture" }), { recorded: true });
    expect(fx.labels).toEqual(["Sample data"]);
    expect(sheetModelText(fx).join("\n")).not.toMatch(/Recorded/);
  });

  it("flags a thin signal in the web sheet's words, and says the planning-tool line once, in the header", () => {
    expect(THIN_SIGNAL_NOTE).toBe("The signal is thin here, so treat this as a starting list.");
    expect(buildSheetModel(makeSheet()).notes).toContain(THIN_SIGNAL_NOTE);
    const hyp = makeSheet({ hypothetical: true });
    expect(buildSheetModel(hyp).notes).toContain("Planning tool: Walkup has no sales data for this show.");
    hyp.limits = [...hyp.limits, "Planning tool; no sales data for this show is known or shown."];
    const m = buildSheetModel(hyp);
    expect(m.notes.filter((n) => /^Planning tool/.test(n))).toHaveLength(1);
    expect(m.footer.limits.some((l) => /^Planning tool/.test(l))).toBe(false);
  });

  it("keeps the real limits only: where the data came from is not a limit", () => {
    const fx = makeSheet({ mode: "fixture" });
    fx.limits = [
      ...LIMITS_EVERY_SHEET,
      "Sample data: made-up places and numbers; no live service was called.",
      "Venue points for rooms without a public map point are approximate in sample data.",
      // Older sheets only: how their Google Places list was searched.
      "The Google Places list used fixed searches because no model key is set.",
    ];
    const m = buildSheetModel(fx);
    expect(m.footer.limits).toEqual([...LIMITS_EVERY_SHEET]);
    expect(m.footer.attribution).toBe("Sample data shaped like Ticketmaster and Qloo answers. Map data © OpenStreetMap contributors.");
    expect(buildSheetModel(makeSheet()).footer.attribution).toMatch(/^Events: Ticketmaster\./);
  });

  it("has no discovery line when the sheet has no discovery", () => {
    expect(buildSheetModel(makeSheet()).discovery).toBeNull();
  });

  it("states the discovery in one line, with the rule that picked it and its receipts", () => {
    const d = buildSheetModel(makeExplainedSheet()).discovery;
    expect(d).toEqual({
      kind: "partner",
      label: "Start with this place",
      text: "Paper Lantern Books, 4.2 km out in Edgehill. A bookstore this crowd ranks highly that the list without Qloo does not have.",
      rule: "Why this one: the highest-ranked partner that is not a bar, more than 2 km from the venue and missing from the list without Qloo.",
      refs: "Q4, P1",
      entityId: "syn-place-4",
      geohash: null,
    });
  });
});

describe("panels", () => {
  const m = buildSheetModel(makeSheet());

  it("panel 1 lists the top 5 tiles with ZIPs and a why line", () => {
    expect(m.panel1.tiles.map((t) => t.name)).toEqual(["East Bank", "Edgehill", "Germantown North", "Woodbine", "Inglewood"]);
    expect(m.panel1.tiles[0]).toMatchObject({ rank: 1, lift: "2.10x", zips: "ZIP 37206" });
    expect(m.panel1.tiles[0]!.why).toContain("Lift 2.10");
    expect(m.panel1.tiles[3]!.zips).toBe("ZIP n/a");
    // Malformed ZCTAs are left out, as in zips.csv.
    expect(m.panel1.tiles[4]!.zips).toBe("ZIP 02134");
    expect(m.panel1.tiles[1]!.why).toBe("80th percentile for this crowd, 44th for the room's usual crowd.");
  });

  it("panel 2 renders chips as ledger refs and carries the not-affiliated footer", () => {
    expect(m.panel2.rows[0]).toMatchObject({
      n: "1",
      entityId: "syn-place-1",
      name: "Low Hum Records",
      category: "Record store",
      house: "",
      tileRank: 1,
      tile: "East Bank",
      tileLift: "2.10x",
      // The same receipts as the web sheet's Why cell: the pool's request, not the lift tile's heatmap.
      refs: "Q3",
      hours: "10 am to 7 pm",
      web: "example.com",
      activation: "",
      why: "Ranks 1st here for this crowd.",
      confidence: null,
    });
    expect(m.panel2.explained).toBe(false);
    expect(m.panel2.footer).toBe("Suggested, not affiliated: no partner has agreed to anything.");
    expect(m.panel2.hoursHeader).toBe("Open Thu");
    const noHours = makeSheet();
    noHours.cards.partners.results = [{ ...PARTNERS[0]!, hoursOnDay: null }];
    expect(buildSheetModel(noHours).panel2.rows[0]).toMatchObject({ hours: HOURS_NOT_LISTED, hoursMissing: true });
    expect(HOURS_NOT_LISTED).toBe("Hours not listed: call first");
    expect(m.panel2.rows[0]!.hoursMissing).toBe(false);
    // Honest blanks: the paper says "Phone not listed" instead of an empty cell.
    expect(m.panel2.rows[5]).toMatchObject({ phone: "", phoneText: PHONE_NOT_LISTED, web: "", webUrl: null });
    expect(m.panel2.rows[0]!.phoneText).toBe(m.panel2.rows[0]!.phone);
  });

  it("panel 2 keeps the explain parts and says one plain line on why", () => {
    const x = buildSheetModel(makeExplainedSheet());
    expect(x.panel2.explained).toBe(true);
    expect(x.panel2.rows[0]).toMatchObject({
      activation: "Ask to leave flyers at the counter.",
      why: "Ranks 1st here for this crowd.",
      confidence: "high",
      confidenceWhy: "Rank 1 of 40 in a top area, open on the street-team day.",
      refs: "Q3",
      lessSure: false,
    });
    // Anything short of high confidence gets a dagger (and one note), never "check first" in the line.
    expect(x.panel2.rows[2]!.why).toBe("Ranks 3rd here for this crowd.");
    expect(x.panel2.rows[2]!.lessSure).toBe(true);
    // A row without explain parts on a sheet that has them shows no explain cells, not made-up text.
    const mixed = makeExplainedSheet();
    mixed.cards.partners.results[1] = { ...mixed.cards.partners.results[1]!, explain: undefined };
    const mm = buildSheetModel(mixed);
    expect(mm.panel2.explained).toBe(true);
    expect(mm.panel2.rows[1]).toMatchObject({ activation: "", confidence: null });
  });

  it("panel 2 compares each partner with the house list", () => {
    const s = makeSheet();
    s.cards.partners.results = [
      { ...PARTNERS[0]!, qlooRank: 2, houseRank: 9 },
      { ...PARTNERS[1]!, qlooRank: 4, houseRank: null },
      { ...PARTNERS[2]!, qlooRank: 5, houseRank: 3 },
      { ...PARTNERS[3]!, chips: [...PARTNERS[3]!.chips, { label: "tonight vs house +5 ranks", ledgerRef: "Q20" }] },
      { ...PARTNERS[4]!, chips: [...PARTNERS[4]!.chips, { label: "tonight vs house: not in the house top 20", ledgerRef: "Q21" }] },
      PARTNERS[5]!,
    ];
    const m2 = buildSheetModel(s);
    expect(m2.panel2.rows.map((r) => r.house)).toEqual(["+7", "new", "-2", "+5", "new", ""]);
    expect(m2.panel2.hasHouse).toBe(true);
    expect(m2.panel2.rows.slice(0, 3).map((r) => r.why)).toEqual([
      "Ranks 2nd here for this crowd, 9th for the room's usual crowd.",
      "Ranks 4th here for this crowd; not in the usual crowd's list.",
      "Ranks 5th here for this crowd, 3rd for the room's usual crowd; a good place on any night, not just this bill.",
    ]);
    // The why line already says it, so there is no "vs house" legend.
    expect(m2.panel2.houseNote).toBeNull();
    expect(m.panel2.hasHouse).toBe(false);
  });

  it("panel 2 numbers each partner's area as on the map", () => {
    expect(m.panel2.rows.map((r) => r.tileRank)).toEqual([1, 1, 2, 2, 3, 4]);
    const s = makeSheet();
    s.cards.partners.results = [{ ...PARTNERS[0]!, tileGeohash: null, tileName: undefined }];
    expect(buildSheetModel(s).panel2.rows[0]).toMatchObject({ tileRank: null, tile: "near venue" });
  });

  it("panel 2 counts rows past the cap", () => {
    const capped = buildSheetModel(makeSheet(), { maxPartners: 4 });
    expect(capped.panel2.rows).toHaveLength(4);
    expect(capped.panel2.omitted).toBe(2);
    expect(capped.panel2.title).toBe("Partners (6)");
  });

  it("panel 3 is in call order: ranked first, then declared-not-scored", () => {
    expect(m.panel3.rows.map((r) => [r.rank, r.label, r.scored])).toEqual([
      ["1", "Hilltop Record Club", true],
      ["2", "Riverside Neighbours Association", true],
      ["–", "Alumni chapter (operator contact)", false],
    ]);
    expect(m.panel3.rows[0]!.refs).toBe("Q11");
  });

  it("panel 4 marks bars operator-only on an all-ages show", () => {
    expect(m.panel4.rows.map((r) => [r.name, r.operatorOnly])).toEqual([
      ["Front Step Diner", false],
      ["The Ninth Bar", true],
      ["Morning Shift Coffee", false],
    ]);
    expect(m.panel4.rows[1]!.detail).toContain("not for fans");
    expect(m.panel4.rows[0]!.detail).toBe("Restaurant · 240 m · 3.1% of the crowd · ranks 4 places higher here than for the room's usual crowd");
    // The same facts one by one, for the paper's table.
    expect(m.panel4.rows[0]).toMatchObject({ category: "Restaurant", distance: "240 m", share: "3.1%", vsUsual: "4 places higher", capacity: 80 });
    expect(m.panel4.rows[1]!.category).toBe("Bar, not for fans");
    expect(m.panel4.shareNote).toMatch(/assumed capacity|people fit/);
    expect(m.panel4.ageLine).toBe("Age policy: All ages (Ticketmaster age policy).");
  });

  it("the fan-facing version leaves bars out on an all-ages show", () => {
    const fan = buildSheetModel(makeSheet(), { audience: "fan" });
    expect(fan.panel4.rows.map((r) => r.name)).toEqual(["Front Step Diner", "Morning Shift Coffee"]);
    expect(fan.panel4.withheld).toBe(1);
    expect(fan.subline).toContain("fan-facing version");
  });

  it("the fan-facing version also leaves bars out of the partner list on an all-ages show", () => {
    const fan = buildSheetModel(makeSheet(), { audience: "fan" });
    expect(fan.panel2.rows.map((r) => r.name)).not.toContain("Night Owl Taproom");
    expect(fan.panel2.withheld).toBe(1);
    expect(fan.panel2.title).toBe("Partners (5)");
    expect(m.panel2.rows.map((r) => r.name)).toContain("Night Owl Taproom");
    expect(m.panel2.withheld).toBe(0);
    const adult = makeSheet();
    adult.bill = { ...adult.bill, legalAgeEnforced: true };
    expect(buildSheetModel(adult, { audience: "fan" }).panel2.withheld).toBe(0);
  });

  it("treats an unknown age policy as all ages, and keeps allowed bars on a 21+ show", () => {
    const unknown = makeSheet();
    unknown.bill = { ...unknown.bill, legalAgeEnforced: null };
    expect(buildSheetModel(unknown, { audience: "fan" }).panel4.withheld).toBe(1);
    expect(buildSheetModel(unknown).panel4.ageLine).toBe("Age policy: not on the listing, so treated as all ages.");
    const adult = makeSheet();
    adult.bill = { ...adult.bill, legalAgeEnforced: true };
    adult.cards = { ...adult.cards, prePost: { ...adult.cards.prePost, results: adult.cards.prePost.results.map((s) => ({ ...s, fanFacingAllowed: true })) } };
    const fanAdult = buildSheetModel(adult, { audience: "fan" });
    expect(fanAdult.panel4.rows.map((r) => r.name)).toContain("The Ninth Bar");
    expect(fanAdult.panel4.withheld).toBe(0);
  });

  it("panel 5 lists podcasts with scope and one sponsor", () => {
    expect(m.panel5.podcasts).toEqual([
      { name: "Long Drive Radio Hour", scope: "national", refs: "Q12" },
      { name: "Tuesday Tape Club", scope: "local", refs: "Q12" },
    ]);
    expect(m.panel5.sponsor?.name).toBe("Cumberland Lemonade Co.");
    expect(m.panel5.sponsorNote).toBeNull();
    const none = makeSheet();
    none.cards = { ...none.cards, media: { ...none.cards.media, results: none.cards.media.results.filter((x) => x.kind !== "sponsor") } };
    expect(buildSheetModel(none).panel5.sponsorNote).toBe("No sponsor brand came back.");
  });

  it("panel 1 says what the map is compared with, and the split-half check when the sheet has one", () => {
    expect(m.panel1.title).toBe("Where this crowd stands out, compared with the room's usual crowd");
    expect(m.panel1.legendCaption).toBe("Fans compared with the room's usual crowd");
    expect(m.panel1.baseline).toBe(
      "Compared with the shows this room usually books. Shading shows where this bill's fans stand out, not where buyers live.",
    );
    const s = makeSheet();
    s.cards = {
      ...s.cards,
      liftMap: {
        ...s.cards.liftMap,
        results: { ...s.cards.liftMap.results, liftDiagnostics: { splitHalfSpearman: 0.714, liftVsHeatSpearman: 0.42, billFloor: 0.5, method: "split-half" } },
      },
    };
    expect(buildSheetModel(s).panel1.baseline).toContain("The map holds up when the bill is split in two (0.71; 1 means identical).");
    const tag = makeSheet();
    tag.cards = { ...tag.cards, liftMap: { ...tag.cards.liftMap, results: { ...tag.cards.liftMap.results, diagnostics: { spearmanLiftVsHeat: null, baseline: "tag" } } } };
    expect(buildSheetModel(tag).panel1.baseline).toMatch(/^Compared with fans of this genre in general: too few of the room's headliners matched Qloo\./);
    expect(buildSheetModel(tag).panel1.legendCaption).toBe("Fans compared with fans of this genre in general");
    expect(buildSheetModel(tag).panel1.title).toBe("Where this crowd stands out, compared with fans of this genre in general");
  });

  it("panel 6 withholds alcohol hooks on a show that is not 21+, and caps at 3", () => {
    expect(m.panel6.hooks).toEqual(["Americana and string bands, one night.", "Record-store regulars, this one is yours.", "Walk-ins welcome at our partners."]);
    expect(m.panel6.withheld).toBe(1);
    expect(m.panel6.note).toBe("Each line is built only from approved Qloo tags (Q8). No jokes, no artist voice.");
    const adult = makeSheet();
    adult.bill = { ...adult.bill, legalAgeEnforced: true };
    const ma = buildSheetModel(adult);
    expect(ma.panel6.hooks).toHaveLength(3);
    expect(ma.panel6.hooks).toContain("Cold beer and banjo.");
    expect(ma.panel6.withheld).toBe(0);
  });
});

describe("footer", () => {
  const m = buildSheetModel(makeSheet(), { ledgerUrl: "https://example.com/plan/test-plan-1#ledger" });

  it("shows the budget heuristic with dollars", () => {
    expect(m.footer.budgetTitle).toBe("Budget split (a heuristic, not a forecast)");
    expect(m.footer.budget[0]).toEqual({ name: "East Bank", share: "30%", usd: "$750" });
  });

  it("prints the sheet's limits", () => {
    expect(m.footer.limitsTitle).toBe("What this sheet doesn't show");
    expect(m.footer.limits).toEqual([...LIMITS_EVERY_SHEET, "Synthetic test sheet."]);
    const noLimits = buildSheetModel(makeSheet({ limits: [] }));
    expect(noLimits.footer.limits).toEqual([...LIMITS_EVERY_SHEET]);
  });

  it("references the ledger and links it when the URL is absolute", () => {
    expect(ledgerRanges(makeSheet().ledger)).toBe("Q1-Q12, T1-T2, P1, L1");
    expect(m.footer.receiptsTitle).toBe("Requests behind this sheet");
    expect(m.footer.ledgerLine).toBe(
      "16 requests: Q1-Q12, T1-T2, P1, L1. Receipts for every Q number: https://example.com/plan/test-plan-1#ledger (also in sheet.json). Plan test-plan-1.",
    );
    expect(buildSheetModel(makeSheet()).footer.ledgerLine).toBe("16 requests: Q1-Q12, T1-T2, P1, L1. Receipts for every Q number: sheet.json. Plan test-plan-1.");
    expect(m.footer.ledgerUrl).toBe("https://example.com/plan/test-plan-1#ledger");
    expect(buildSheetModel(makeSheet(), { ledgerUrl: "/plan/x#ledger" }).footer.ledgerUrl).toBeNull();
  });

  it("prints one footer line: headliner, room, show date, print date, data date and Sample on fixtures", () => {
    expect(buildSheetModel(makeSheet(), { printedAt: "2026-10-14T10:00:00Z" }).footer.printLine).toBe(
      "Juniper Wire · Example Hall · Fri Nov 20 · printed Wed Oct 14 2026 · data from Fri Oct 9 2026",
    );
    expect(buildSheetModel(makeSheet({ mode: "fixture" }), { printedAt: "2026-10-14T10:00:00Z" }).footer.printLine).toMatch(/ · data from Fri Oct 9 2026 · Sample$/);
    expect(buildSheetModel(makeSheet()).footer.elsewhere).toBe("Podcasts, the sponsor pick, copy lines and the budget split are on the web sheet and in sheet.json.");
  });

  it("collapses receipts into one sorted group", () => {
    expect(receiptGroup(["Q13", "Q6", "Q13", "Q14"])).toBe("Q6, Q13-Q14");
    expect(receiptGroup(["Q1", "Q4", "Q5", "Q2", "Q3", "Q6", "Q7", "T2", "Q8", "Q9"])).toBe("Q1-Q9, T2");
    expect(receiptGroup(["Q1", "Q3", "Q5", "Q7", "Q9"])).toBe("Q1, Q3, Q5 +2");
    expect(formatHours("16:00-02:00")).toBe("4 pm to 2 am");
    expect(formatHours("07:30-12:00, 17:00-00:00")).toBe("7:30 am to noon, 5 pm to midnight");
  });

  it("attributes every data source", () => {
    for (const source of ["Ticketmaster", "OpenStreetMap", "U.S. Census Bureau", "Qloo"]) expect(m.footer.attribution).toContain(source);
    expect(m.footer.attribution).not.toContain("Google");
  });
});

describe("sheetModelText", () => {
  it("never labels a show soft or tracking", () => {
    const text = sheetModelText(buildSheetModel(makeSheet({ hypothetical: true, mode: "fixture" }))).join("\n");
    expect(text).not.toMatch(/\bsoft\b|\btracking\b/i);
    expect(text).toContain("Juniper Wire");
  });

  it("reads plainly: no shouted labels, no marketing words", () => {
    const text = sheetModelText(buildSheetModel(makeExplainedSheet({ hypothetical: true, mode: "fixture" }))).join("\n");
    expect(text).not.toMatch(/STREET SHEET|FIXTURE|HYPOTHETICAL|SYNTHETIC/);
    expect(text).not.toMatch(/AI-powered|unlock|seamless|powerful|insights|!/i);
    expect(text).toContain("Sample data");
    expect(text).toContain("Start with this place");
    expect(text).toContain("Ask to leave flyers at the counter.");
  });
});
