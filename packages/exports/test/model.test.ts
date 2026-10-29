import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LIMITS_EVERY_SHEET, type StreetSheet } from "@walkup/contracts";
import {
  AREA_BLURB_CHARS,
  AREA_BLURB_ZIP_CHARS,
  buildSheetModel,
  HOURS_NOT_LISTED,
  noTopPick,
  noTopPickText,
  PAGE_SECTIONS,
  partnerHoursColumn,
  PHONE_NOT_LISTED,
  sheetModelText,
  spotColumnWidths,
  THIN_SIGNAL_NOTE,
} from "../src/sheet-model";
import { formatHours, formatKm, isCartOrStand, ledgerRanges, receiptGroup, sentencesUpTo, sheetSpots, spotSharesDiffer, spotVsUsual, tMinusDays, tMinusLabel } from "../src/format";
import { fanFacingSpots, isFanFacing, partnerIsFanFacing, spotIsFanFacing } from "../src/audience";
import { addressState, areaLabel, formatPhone, LESS_SURE_NOTE } from "../src/format";
import { toIcs } from "../src/ics";
import { pinRows, zipRows } from "../src/tables";
import { makeExplainedSheet, makeMultiStateSheet, makeSheet, MEDIA, PARTNERS, place, SPOTS } from "./helpers";

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
    // A live sheet's counts are the operator's own: an older stored sheet flagged hypothetical gets no what-if
    // watermark, label, "(assumed)" or planning-tool note.
    const oldLive = buildSheetModel(makeSheet({ hypothetical: true }));
    expect(oldLive.watermarks).toEqual([]);
    expect(oldLive.labels).toEqual([]);
    expect(oldLive.seatsLine).toBe("640 of 1,200 seats left");
    expect(oldLive.notes.some((n) => /^Planning tool/.test(n))).toBe(false);
    // What-if counts are a sample sheet's.
    const hyp = buildSheetModel(makeSheet({ mode: "fixture", hypothetical: true }));
    // The seats line already says "(assumed)", so no extra label.
    expect(hyp.labels).toEqual(["Sample data"]);
    const noCounts = makeSheet({ mode: "fixture", hypothetical: true });
    noCounts.operator = { ...noCounts.operator, seatsLeft: null, capacity: null };
    expect(buildSheetModel(noCounts).labels).toEqual(["Sample data", "Counts are what-ifs"]);
    expect(hyp.seatsLine).toBe("640 of 1,200 seats left (assumed)");
    expect(hyp.notes).toContain("Planning tool: Walkup has no sales data for this show.");
    const fx = buildSheetModel(makeSheet({ mode: "fixture", hypothetical: true }));
    expect(fx.sampleLabel).toBe("Sample data");
    expect(fx.labels).toEqual(["Sample data"]);
    // One watermark on a sample sheet, never two; a live sheet has none.
    expect(fx.watermarks).toEqual(["Sample data"]);
    expect(buildSheetModel(makeSheet({ mode: "fixture", hypothetical: false })).watermarks).toEqual(["Sample data"]);
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
    const hyp = makeSheet({ mode: "fixture", hypothetical: true });
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
      // The pick's row is less certain (medium confidence), so the line has its dagger and note.
      text: "Paper Lantern Books, 4.2 km out in Edgehill†. A bookstore this crowd ranks highly that the list without Qloo does not have.",
      rule: "Why this one: the highest-ranked partner that is not a bar, more than 2 km from the venue and missing from the list without Qloo.",
      lessSureNote: "† Less certain: the search widened, the list was short or the place ranked low. Call before you go.",
      refs: "Q4, P1",
      entityId: "syn-place-4",
      geohash: null,
    });
  });
});

describe("panels", () => {
  const m = buildSheetModel(makeSheet());

  it("panel 1 lists the top 5 tiles with ZIPs and a why line", () => {
    // Each area carries its own state from its own ZIPs: the synthetic Inglewood tile's only valid ZCTA (02134) is a
    // Massachusetts ZIP, so it says MA; Woodbine has no ZCTA and keeps its bare name.
    expect(m.panel1.tiles.map((t) => t.name)).toEqual(["East Bank, TN", "Edgehill, TN", "Germantown North, TN", "Woodbine", "Inglewood, MA"]);
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
      tile: "East Bank, TN",
      tileLift: "2.10x",
      // The same receipts as the web sheet's Why cell: the pool's request, not the lift tile's heatmap.
      refs: "Q3",
      // Two street-team days: the day the calendar visits it, and that day's hours.
      hours: "Thu 10 am to 7 pm",
      visitDay: "Thu",
      web: "example.com",
      activation: "",
      why: "Ranks 1st here for this crowd.",
      confidence: null,
    });
    expect(m.panel2.explained).toBe(false);
    expect(m.panel2.footer).toBe("Suggested, not affiliated: no partner has agreed to anything.");
    expect(m.panel2.hoursHeader).toBe("Visit day");
    const noHours = makeSheet();
    noHours.cards.partners.results = [{ ...PARTNERS[0]!, hoursOnDay: null }];
    expect(buildSheetModel(noHours).panel2.rows[0]).toMatchObject({ hours: "Thu, hours not listed: call first", hoursMissing: true });
    // With one street-team day, the column is that day's hours.
    const oneDay = makeSheet();
    oneDay.operator = { ...oneDay.operator, streetTeamDays: ["thursday"] };
    expect(buildSheetModel(oneDay).panel2.hoursHeader).toBe("Open Thu");
    expect(buildSheetModel(oneDay).panel2.rows[0]).toMatchObject({ hours: "10 am to 7 pm", visitDay: "" });
    oneDay.cards.partners.results = [{ ...PARTNERS[0]!, hoursOnDay: null }];
    expect(buildSheetModel(oneDay).panel2.rows[0]).toMatchObject({ hours: HOURS_NOT_LISTED, hoursMissing: true });
    expect(HOURS_NOT_LISTED).toBe("Hours not listed: call first");
    expect(m.panel2.rows[0]!.hoursMissing).toBe(false);
    // Honest blanks: the paper says "Phone not listed" instead of an empty cell.
    expect(m.panel2.rows[5]).toMatchObject({ phone: "", phoneText: PHONE_NOT_LISTED, web: "", webUrl: null });
    expect(m.panel2.rows[0]!.phoneText).toBe(m.panel2.rows[0]!.phone);
  });

  it("marks a less certain top pick with the table's dagger and note, as the plan page does", () => {
    // The pick (Paper Lantern Books) has medium confidence: its table row has the dagger, so the line does too.
    const x = buildSheetModel(makeExplainedSheet());
    expect(x.panel2.rows.find((r) => r.entityId === "syn-place-4")!.lessSure).toBe(true);
    expect(x.discovery).toMatchObject({ kind: "partner", label: "Start with this place", lessSureNote: LESS_SURE_NOTE });
    expect(x.discovery!.text).toMatch(/^Paper Lantern Books, 4\.2 km out in Edgehill†\. A bookstore/);
    // A sure pick has neither.
    const sure = makeExplainedSheet();
    sure.discovery = { ...sure.discovery!, entityId: "syn-place-1" };
    expect(buildSheetModel(sure).discovery).toMatchObject({ lessSureNote: null });
    expect(buildSheetModel(sure).discovery!.text).not.toContain("†");
  });

  it("says there is no top pick when the run found none, and why, read from the sheet", () => {
    const s = makeSheet();
    expect(buildSheetModel(s).discovery).toBeNull();
    s.steps = [{ id: "guard", kind: "other", label: "Guard", decision: "Checked.", status: "ok", ledgerRefs: [] }];
    expect(buildSheetModel(s).discovery).toMatchObject({
      kind: "none",
      label: "No top pick on this sheet",
      text: "no partner has a rank for the room's usual crowd to compare with, and the area rule needs map checks this sheet doesn't have.",
      lessSureNote: null,
      entityId: null,
    });
    // A one-act bill (f81d3edd, 090902c0): no partner stands apart, and the map had no second half to check against.
    s.cards.partners.results = s.cards.partners.results.map((p) => ({ ...p, houseRank: p.qlooRank + 2 }));
    const checks = { splitHalfSpearman: null, liftVsHeatSpearman: 0.1, billFloor: 0.7, method: "Lift." };
    s.cards.liftMap.results.liftDiagnostics = { ...checks, note: "This bill has one act, so there was no second half to check the map against." };
    expect(noTopPickText(s)).toBe(
      "No top pick on this sheet: the room's usual crowd ranks no partner here at least 5 places lower than this crowd does, and the area rule needs the map's split-half check, which can't run on a one-act bill.",
    );
    // Halves that disagree, or a map that passed its checks and still had no area.
    s.cards.liftMap.results.liftDiagnostics = { ...checks, splitHalfSpearman: 0.31 };
    expect(noTopPickText(s)).toMatch(/and the area rule needs the two halves of the bill to agree on the map, and they didn't \(0\.31; above 0\.5 needed\)\.$/);
    s.cards.liftMap.results.liftDiagnostics = { ...checks, splitHalfSpearman: 0.8 };
    expect(noTopPickText(s)).toMatch(/, and no numbered area met the area rule\.$/);
    // The only place the usual crowd ranks far lower is a national chain, which the rule skips.
    s.cards.partners.results[0] = { ...s.cards.partners.results[0]!, houseRank: 30, chain: true };
    expect(noTopPickText(s)).toMatch(/^No top pick on this sheet: the only partners the room's usual crowd ranks at least 5 places lower are national chains, which the rule skips, and /);
    // A genre stand-in instead of the room's own crowd: neither rule runs.
    s.cards.liftMap.results.diagnostics = { ...s.cards.liftMap.results.diagnostics, baseline: "tag" };
    expect(noTopPick(s).reason).toMatch(/^both rules compare this crowd with the room's usual crowd, and this run compared it with .+ instead\.$/);
    s.revision = { parentPlanId: "test-plan-0", instruction: "No restaurants", interpreter: "rules", toolCalls: [], changes: [] };
    expect(buildSheetModel(s).discovery!.label).toBe("No top pick after this change");
    expect(noTopPickText(s)).toMatch(/^No top pick after this change: both rules /);
  });

  it("gives the g3 sample sheet, which has no usual crowd, a reason that matches the rest of its sheet", () => {
    const g3 = (JSON.parse(readFileSync(new URL("../../../fixtures/synthetic/engine/g3.sheet.json", import.meta.url), "utf8")) as { sheet: StreetSheet }).sheet;
    expect(g3.cards.liftMap.results.diagnostics.baseline).toBe("none");
    const m = buildSheetModel(g3);
    expect(m.discovery).toMatchObject({
      kind: "none",
      label: "No top pick on this sheet",
      text: "both rules compare this crowd with the room's usual crowd, and this run has no usual crowd to compare with.",
    });
    expect(sheetModelText(m).join(" ")).not.toContain("ranks no partner");
    expect(m.panel1.baseline).toMatch(/^Nothing to compare with/);
  });

  it("says when the map search widened past the radius, in the plan page's words", () => {
    const s = makeSheet();
    expect(buildSheetModel(s).subline).toContain("40 km radius");
    s.operator = { ...s.operator, radiusKm: 10 };
    s.cards.liftMap = { ...s.cards.liftMap, status: "partial", reason: "The search widened to 60 km (fewer than 200 map squares came back within 10 km)." };
    const sub = buildSheetModel(s).subline;
    expect(sub).toContain("radius 10 km; the map search widened to 60 km");
    expect(sub).not.toContain("10 km radius");
  });

  it("puts the website's domain beside a missing phone, and points to the ad files only when there are areas", () => {
    const s = makeSheet();
    s.cards.partners.results = [{ ...PARTNERS[0]!, phone: null }, PARTNERS[5]!];
    const m = buildSheetModel(s);
    expect(m.panel2.rows[0]!.phoneText).toBe("Phone not listed · example.com");
    expect(m.panel2.rows[1]!.phoneText).toBe("Phone not listed");
    expect(m.footer.elsewhere).toContain("zips.csv and pins.csv");
    s.cards.liftMap = { ...s.cards.liftMap, results: { ...s.cards.liftMap.results, tiles: s.cards.liftMap.results.tiles.map((t) => ({ ...t, lift: 1.1 })) } };
    expect(buildSheetModel(s).footer.elsewhere).toBe("Street-team days and times are in street-team.ics.");
  });

  it("gives the plan page and the email the same hours column as the paper, the CSV and the calendar", () => {
    const s = makeSheet();
    const col = partnerHoursColumn(s);
    expect(col).toMatchObject({ header: "Visit day", byVisit: true });
    const model = buildSheetModel(s).panel2.rows;
    s.cards.partners.results.forEach((p, i) => {
      const c = col.cell(p);
      expect({ hours: c.hours, visitDay: c.visitDay, hoursMissing: c.hoursMissing }).toEqual({ hours: model[i]!.hours, visitDay: model[i]!.visitDay, hoursMissing: model[i]!.hoursMissing });
      expect(c.withDay).toBe(c.hours);
    });
    // With one street-team day, the line form leads with that day.
    const oneDay = makeSheet();
    oneDay.operator = { ...oneDay.operator, streetTeamDays: ["thursday"] };
    const one = partnerHoursColumn(oneDay);
    expect(one).toMatchObject({ header: "Open Thu", byVisit: false });
    expect(one.cell(PARTNERS[0]!)).toEqual({ hours: "10 am to 7 pm", dayHours: "10 am to 7 pm", visitDay: "", hoursMissing: false, withDay: "Thu 10 am to 7 pm", routeNote: "" });
    expect(one.cell({ ...PARTNERS[0]!, hoursOnDay: null }).withDay).toBe(HOURS_NOT_LISTED);
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
    expect(m.panel4.rows[0]!.detail).toBe("Restaurant · 0.2 km · 3.1% of the crowd · ranks 4 places higher here than for the room's usual crowd");
    // The same facts one by one, for the paper's table.
    expect(m.panel4.rows[0]).toMatchObject({ category: "Restaurant", distance: "0.2 km", share: "3.1%", vsUsual: "4 places higher", capacity: 80 });
    expect(m.panel4.showShare).toBe(true);
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
    expect(m.panel5.podcastsOmitted).toBe(0);
    expect(m.panel5.sponsor?.name).toBe("Cumberland Lemonade Co.");
    expect(m.panel5.sponsorNote).toBeNull();
    const none = makeSheet();
    none.cards = { ...none.cards, media: { ...none.cards.media, results: none.cards.media.results.filter((x) => x.kind !== "sponsor") } };
    expect(buildSheetModel(none).panel5.sponsorNote).toBe("No sponsor brand came back.");
    // Said once: when the status line already gives the reason, there is no second note under the list.
    none.cards = { ...none.cards, media: { ...none.cards.media, status: "partial", reason: "No sponsor brand came back." } };
    const p5 = buildSheetModel(none).panel5;
    expect(p5.status).toBe("Partial: No sponsor brand came back.");
    expect(p5.sponsorNote).toBeNull();
    expect(sheetModelText(buildSheetModel(none)).filter((x) => x.includes("No sponsor brand came back."))).toHaveLength(0);
  });

  it("panel 5 lists four podcasts, and counts any past the cap", () => {
    const s = makeSheet();
    const pods = ["One", "Two", "Three", "Four"].map((n, i) => ({ ...MEDIA[0]!, entity: { ...MEDIA[0]!.entity, entityId: `syn-pod-x${i}`, name: `${n} Pod` } }));
    s.cards = { ...s.cards, media: { ...s.cards.media, results: [...pods, MEDIA[2]!] } };
    const p5 = buildSheetModel(s).panel5;
    expect(p5.podcasts.map((p) => p.name)).toEqual(["One Pod", "Two Pod", "Three Pod", "Four Pod"]);
    expect(p5.podcastsOmitted).toBe(0);
    const three = buildSheetModel(s, { maxPodcasts: 3 });
    expect(three.panel5.podcasts).toHaveLength(3);
    expect(three.panel5.podcastsOmitted).toBe(1);
    expect(sheetModelText(three)).toContain("+1 more podcast on the plan page and in sheet.json.");
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
    expect(m.footer.budget[0]).toEqual({ rank: 1, name: "East Bank, TN", share: "30.0%", usd: "$750" });
    expect(m.footer.budget.map((b) => b.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("gives each area its own stored share and dollars, to one decimal, adding up to 100.0%", () => {
    // A recorded split's last share takes the rounding (0.143, 0.143, 0.143, 0.144 after 0.427): each area keeps its
    // own, as the plan page and the area text ("a rough split of the budget of 14.4%") say.
    const s = makeSheet();
    const shares = [0.427, 0.143, 0.143, 0.143, 0.144];
    s.budgetSplit = s.cards.liftMap.results.tiles.slice(0, 5).map((t, i) => ({ geohash: t.geohash, share: shares[i]!, label: "heuristic, not a forecast" as const }));
    s.operator = { ...s.operator, mediaBudgetUsd: 6000 };
    const rows = buildSheetModel(s).footer.budget;
    expect(rows.map((b) => [b.share, b.usd])).toEqual([
      ["42.7%", "$2,562"],
      ["14.3%", "$858"],
      ["14.3%", "$858"],
      ["14.3%", "$858"],
      ["14.4%", "$864"],
    ]);
    // Lift-proportional weights (no stored split for every area) still print shares that add up to 100.0%.
    const lift = makeSheet();
    lift.budgetSplit = [{ geohash: "zzzzzz", share: 1, label: "heuristic, not a forecast" }];
    const pct = buildSheetModel(lift).footer.budget.map((b) => Number(b.share.replace("%", "")));
    expect(pct.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
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
    expect(buildSheetModel(makeSheet()).footer.elsewhere).toBe("Street-team days and times are in street-team.ics; ad ZIPs and pins in zips.csv and pins.csv.");
  });

  it("collapses receipts into one sorted group", () => {
    expect(receiptGroup(["Q13", "Q6", "Q13", "Q14"])).toBe("Q6, Q13-Q14");
    expect(receiptGroup(["Q1", "Q4", "Q5", "Q2", "Q3", "Q6", "Q7", "T2", "Q8", "Q9"])).toBe("Q1-Q9, T2");
    expect(receiptGroup(["Q1", "Q3", "Q5", "Q7", "Q9"])).toBe("Q1, Q3, Q5 +2");
    expect(formatHours("16:00-02:00")).toBe("4 pm to 2 am");
    expect(formatHours("07:30-12:00, 17:00-00:00")).toBe("7:30 am to noon, 5 pm to midnight");
    // Live Qloo hours carry seconds.
    expect(formatHours("17:00:00-00:00:00")).toBe("5 pm to midnight");
    expect(formatHours("Thu 06:00:00-11:00:00")).toBe("Thu 6 am to 11 am");
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

describe("area labels", () => {
  it("name each area with its own place and state, not the venue's city: a DC room with MD and VA areas", () => {
    const sheet = makeMultiStateSheet();
    const m = buildSheetModel(sheet);
    expect(m.placeLine).toBe("Example Hall, Washington, DC");
    expect(m.panel1.tiles.map((t) => t.name)).toEqual(["Silver Spring, MD", "Arlington, VA", "Capitol Hill, DC"]);
    expect(m.panel2.rows.map((r) => [r.tileRank, r.tile])).toEqual([
      [1, "Silver Spring, MD"],
      [2, "Arlington, VA"],
      [3, "Capitol Hill, DC"],
      [null, "Takoma Park, MD"],
    ]);
    expect(m.footer.budget.map((b) => b.name)).toEqual(["Silver Spring, MD", "Arlington, VA", "Capitol Hill, DC"]);
    const text = sheetModelText(m).join("\n");
    expect(text).not.toMatch(/Silver Spring, (Washington|DC)|Arlington, (Washington|DC)/);
  });

  it("take the state from the tile's own point when the run recorded it, over its first ZIP's", () => {
    // Georgetown's nearest ZCTA can be across the river in Virginia; the tile's point is in DC.
    const georgetown = { name: "Georgetown", geohash: "dqcjq9", zctas: ["22209", "20007"], state: "DC" };
    expect(areaLabel(georgetown)).toBe("Georgetown, DC");
    expect(areaLabel({ ...georgetown, state: undefined })).toBe("Georgetown, VA");
    // Every file reads the whole tile, so the state reaches the map list, the budget split, zips.csv and pins.csv.
    const s = makeMultiStateSheet();
    const tiles = s.cards.liftMap.results.tiles.map((t, i) => (i === 1 ? { ...t, name: "Georgetown", zctas: ["22209", "20007"], state: "DC" } : t));
    s.cards.liftMap.results.tiles = tiles;
    const m = buildSheetModel(s);
    expect(m.panel1.tiles[1]!.name).toBe("Georgetown, DC");
    expect(m.footer.budget[1]!.name).toBe("Georgetown, DC");
    expect(m.panel2.rows.find((r) => r.tileRank === 2)!.tile).toBe("Georgetown, DC");
    expect(zipRows(s, { isResidentialZip: () => true }).filter((r) => r.area === 2).map((r) => r.areaName)).toEqual(["Georgetown, DC", "Georgetown, DC"]);
    expect(pinRows(s)[1]!.name).toBe("Georgetown, DC");
    expect(toIcs(s).replace(/\r\n /g, "")).toContain("area 2\\, Georgetown\\, DC");
  });

  it("put the state before a trailing distance, as the plan page does", () => {
    expect(areaLabel({ name: "Des Plaines, 19 km northwest", geohash: "dp3wbe", zctas: ["60018"] })).toBe("Des Plaines, IL, 19 km northwest");
    expect(areaLabel({ name: "Des Plaines, IL, 19 km northwest", geohash: "dp3wbe", zctas: ["60018"] })).toBe("Des Plaines, IL, 19 km northwest");
  });

  it("keep a name that already ends with its state, and a geohash-only area bare", () => {
    expect(areaLabel({ name: "Silver Spring, MD", geohash: "dqcjz5", zctas: ["20910"] })).toBe("Silver Spring, MD");
    expect(areaLabel({ name: "", geohash: "dqcjz5", zctas: ["20910"] })).toBe("dqcjz5");
    expect(areaLabel({ name: "Woodbine", geohash: "dn6m00", zctas: [] })).toBe("Woodbine");
    expect(addressState("14200 Baltimore Ave Laurel, MD 20707")).toBe("MD");
    expect(addressState("1577 Spring Hill Rd Vienna, VA 22182-1234")).toBe("VA");
    expect(addressState("100 Example St, Nashville, TN")).toBeNull();
  });
});

describe("phones", () => {
  it("print a US number the way people read it and keep the raw number for dialing", () => {
    expect(formatPhone("+12027334604")).toBe("(202) 733-4604");
    expect(formatPhone("2027334604")).toBe("(202) 733-4604");
    expect(formatPhone("(615) 555-0101")).toBe("(615) 555-0101");
    expect(formatPhone("+44 20 7946 0958")).toBe("+44 20 7946 0958");
    expect(formatPhone("555-0101 ext 4")).toBe("555-0101 ext 4");
    const live = makeSheet();
    live.cards.partners.results = [{ ...PARTNERS[0]!, phone: "+12027334604" }];
    expect(buildSheetModel(live).panel2.rows[0]).toMatchObject({ phone: "+12027334604", phoneText: "(202) 733-4604" });
  });
});

describe("thin signal", () => {
  it("is said once: the header note, not again in the limits", () => {
    const thin = makeSheet({ limits: [...LIMITS_EVERY_SHEET, "Thin signal: treat as a starting list."] });
    const m = buildSheetModel(thin); // 6 partners: under 15, so the header says it
    expect(m.notes).toContain(THIN_SIGNAL_NOTE);
    expect(m.footer.limits.some((l) => /thin signal/i.test(l))).toBe(false);
  });
});

describe("fan-facing places: one shared rule", () => {
  // A restaurant the plan let through (fanFacingAllowed: true) whose name is a drinking word, as recorded live sheets have.
  const drinkName = { ...SPOTS[0]!, entity: place("syn-place-60", "Whiskey Lantern", { distanceM: 300 }), category: "restaurant", fanFacingAllowed: true };

  it("treats a drinking word in the name like a bar on a show that is not 21+, whatever the plan's flag says", () => {
    const sheet = makeSheet();
    expect(spotIsFanFacing(drinkName, sheet)).toBe(false);
    expect(spotIsFanFacing(SPOTS[0]!, sheet)).toBe(true);
    expect(spotIsFanFacing(SPOTS[1]!, sheet)).toBe(false);
    expect(partnerIsFanFacing(PARTNERS[4]!, sheet)).toBe(false); // a bar
    expect(partnerIsFanFacing(PARTNERS[0]!, sheet)).toBe(true);
    const adult = makeSheet();
    adult.bill = { ...adult.bill, legalAgeEnforced: true };
    expect(spotIsFanFacing(drinkName, adult)).toBe(true);
    expect(isFanFacing({ name: "Night Owl Taproom", category: "bar" }, adult.bill, { allAges: true })).toBe(false);
    // The plan's own "no" always holds.
    expect(isFanFacing({ name: "Front Step Diner", category: "restaurant", fanFacingAllowed: false }, adult.bill, adult.operator)).toBe(false);
  });

  it("is what both the operator sheet (web and PDF) and the fan version use, for every age policy", () => {
    for (const legalAgeEnforced of [false, true, null]) {
      for (const allAges of [undefined, true]) {
        const sheet = makeSheet();
        sheet.bill = { ...sheet.bill, legalAgeEnforced };
        sheet.operator = { ...sheet.operator, ...(allAges ? { allAges } : {}) };
        sheet.cards.prePost.results = [...SPOTS, drinkName];
        // The sheet lists spots nearest first.
        const shared = sheetSpots(fanFacingSpots(sheet.cards.prePost.results, sheet)).map((x) => x.entity.name);
        const operator = buildSheetModel(sheet);
        const fan = buildSheetModel(sheet, { audience: "fan" });
        expect(fan.panel4.rows.map((r) => r.name), `${legalAgeEnforced} ${allAges}`).toEqual(shared);
        expect(operator.panel4.rows.filter((r) => !r.operatorOnly).map((r) => r.name)).toEqual(shared);
        expect(operator.panel4.rows.filter((r) => r.operatorOnly).every((r) => r.category.endsWith("not for fans"))).toBe(true);
        expect(fan.panel2.rows.map((r) => r.name)).toEqual(sheet.cards.partners.results.filter((p) => partnerIsFanFacing(p, sheet)).map((p) => p.entity.name));
      }
    }
  });
});

describe("one page, the same sections on paper and in print", () => {
  it("lists every section the PDF and the print view print, in reading order", () => {
    const m = buildSheetModel(makeSheet());
    expect(m.sections).toEqual(PAGE_SECTIONS);
    expect(m.sections).toEqual(["map", "spots", "partners", "media", "hooks", "budget", "declared", "limits", "requests"]);
    // At most four podcasts (the PDF lists three and counts the rest) and three copy lines.
    expect(m.panel5.podcasts.length).toBeLessThanOrEqual(4);
    expect(m.panel6.hooks.length).toBeLessThanOrEqual(3);
  });

  it("cuts an area's blurb at a sentence end, never mid-sentence", () => {
    expect(sentencesUpTo("One. Two two. Three three three.", 14)).toBe("One. Two two.");
    expect(sentencesUpTo("About 1.7 times the usual crowd here. More.", 20)).toBe("About 1.7 times the usual crowd here.");
    expect(sentencesUpTo("Short.", 100)).toBe("Short.");
    const s = makeSheet();
    const long = `${"A first sentence about this area that runs on for a while".padEnd(70, ".")} Then a second sentence that would not fit on the paper at all, no matter what. And a third.`;
    s.narration = { ...s.narration!, tileWhy: [{ geohash: s.cards.liftMap.results.tiles[0]!.geohash, text: long }] };
    const t = buildSheetModel(s).panel1.tiles[0]!;
    expect(t.why).toBe(long);
    expect(t.blurb.startsWith("ZIP 37206. A first sentence")).toBe(true);
    expect(t.blurb).toMatch(/[.!?]$/);
    expect(t.blurb.length).toBeLessThanOrEqual(AREA_BLURB_CHARS);
    expect(t.blurb).not.toContain("Then a second");
  });

  it("keeps the same sentences in an area with four ZIPs as in its neighbours", () => {
    const s = makeSheet();
    const why = "About 2.3 times the room's usual crowd. 78th percentile for this crowd, 5th for the room's usual crowd.";
    s.cards.liftMap.results.tiles = s.cards.liftMap.results.tiles.map((t, i) => (i === 1 ? { ...t, zctas: ["37203", "37212", "37204", "37215"] } : t));
    s.narration = { ...s.narration!, tileWhy: s.cards.liftMap.results.tiles.slice(0, 3).map((t) => ({ geohash: t.geohash, text: why })) };
    const tiles = buildSheetModel(s).panel1.tiles.slice(0, 3);
    expect(tiles[1]!.zips).toBe("ZIP 37203, 37212, 37204, 37215");
    for (const t of tiles) expect(t.blurb.endsWith(why)).toBe(true);
    // The ZIP line takes at most three ZIPs' worth of the length.
    expect(tiles[1]!.blurb.length).toBeLessThanOrEqual(AREA_BLURB_CHARS + tiles[1]!.zips.length - AREA_BLURB_ZIP_CHARS);
  });

  it("keeps the phone whole for its own line", () => {
    const s = makeSheet();
    s.cards.partners.results = [{ ...PARTNERS[0]!, address: "1000 Extremely Long Boulevard Name Northeast, Suite 12, Nashville", phone: "+16155550101" }];
    expect(buildSheetModel(s).panel2.rows[0]).toMatchObject({ phoneText: "(615) 555-0101" });
  });
});

describe("before and after the show", () => {
  const spot = (id: string, name: string, distanceM: number | null, extra: Partial<(typeof SPOTS)[number]> = {}) => ({
    ...SPOTS[0]!,
    entity: place(id, name, distanceM === null ? {} : { distanceM }),
    ...extra,
  });

  it("drops food carts, kiosks, stands and food trucks, by category or name", () => {
    expect(isCartOrStand({ name: "Corner Coffee Cart", category: "cafe" })).toBe(true);
    expect(isCartOrStand({ name: "Main Street Kiosk" })).toBe(true);
    expect(isCartOrStand({ name: "Taco Stand" })).toBe(true);
    expect(isCartOrStand({ name: "Blue Plate", category: "food_truck" })).toBe(true);
    expect(isCartOrStand({ name: "Grandstand Grill", category: "restaurant" })).toBe(false);
    expect(isCartOrStand({ name: "Front Step Diner", category: "restaurant" })).toBe(false);
    const s = makeSheet();
    s.cards.prePost.results = [...SPOTS, spot("syn-place-70", "Late Night Hot Dog Cart", 30), spot("syn-place-71", "Smokey Wheels", 60, { category: "food_truck" })];
    const names = buildSheetModel(s).panel4.rows.map((r) => r.name);
    expect(names).toEqual(["Front Step Diner", "The Ninth Bar", "Morning Shift Coffee"]);
  });

  it("lists spots nearest to the venue first, those without a distance last", () => {
    const s = makeSheet();
    s.cards.prePost.results = [spot("a", "Far Diner", 900), spot("b", "No Distance Diner", null), spot("c", "Near Diner", 120), spot("d", "Mid Diner", 400)];
    expect(sheetSpots(s.cards.prePost.results).map((x) => x.entity.name)).toEqual(["Near Diner", "Mid Diner", "Far Diner", "No Distance Diner"]);
    expect(buildSheetModel(s).panel4.rows.map((r) => r.name)).toEqual(["Near Diner", "Mid Diner", "Far Diner", "No Distance Diner"]);
  });

  it("lists national chains last, after every local spot, as the card's sentence says, and marks them", () => {
    const s = makeSheet();
    s.cards.prePost.results = [spot("a", "Chain Scoops", 100, { chain: true, category: "bakery" }), spot("b", "Far Local", 900), spot("c", "Near Local", 50), spot("d", "Chain Coffee", 800, { chain: true, category: "cafe" })];
    const order = ["Near Local", "Far Local", "Chain Scoops", "Chain Coffee"];
    expect(sheetSpots(s.cards.prePost.results).map((x) => x.entity.name)).toEqual(order);
    const rows = buildSheetModel(s).panel4.rows;
    expect(rows.map((r) => r.name)).toEqual(order);
    // The page's "Bakery · national chain": the table cell and the one-line detail say it on paper too.
    expect(rows[2]).toMatchObject({ category: "Bakery, national chain", distance: "0.1 km" });
    expect(rows[2]!.detail.startsWith("Bakery · national chain · 0.1 km")).toBe(true);
    expect(rows[0]!.category).not.toContain("chain");
  });

  it("marks a national chain partner's type, as the plan page's partner table does", () => {
    const s = makeSheet();
    s.cards.partners.results = s.cards.partners.results.map((p, i) => (i === 5 ? { ...p, chain: true } : p));
    const rows = buildSheetModel(s).panel2.rows;
    expect(rows[5]!.category).toBe("Cafe, national chain");
    expect(rows[0]!.category).toBe("Record store");
  });

  it("drops the share column and its note when every spot gets the same share", () => {
    const s = makeSheet();
    s.cards.prePost.results = SPOTS.map((x) => ({ ...x, expectedShare: 0.02, assumedCapacity: 120 }));
    const p = buildSheetModel(s).panel4;
    expect(p.showShare).toBe(false);
    expect(p.shareNote).toBeNull();
    expect(p.rows.every((r) => r.share === "")).toBe(true);
    expect(p.rows.map((r) => r.detail).join(" ")).not.toMatch(/of the crowd|%/);
    expect(spotSharesDiffer([0.02, 0.02])).toBe(false);
    expect(spotSharesDiffer([0.02, 0.031])).toBe(true);
  });

  it("gives every distance in km", () => {
    expect(formatKm(240)).toBe("0.2 km");
    expect(formatKm(1500)).toBe("1.5 km");
    expect(formatKm(30)).toBe("<0.1 km");
    expect(formatKm(null)).toBe("");
    // Under 1 km, the distance the plan page shows ("950 m") is what gets rounded: 949.7 m is 1.0 km, not 0.9 km.
    expect(formatKm(949.7)).toBe("1.0 km");
    expect(formatKm(944)).toBe("0.9 km");
    expect(formatKm(1075)).toBe("1.1 km");
    expect(buildSheetModel(makeSheet()).panel4.rows.map((r) => r.distance)).toEqual(["0.2 km", "0.4 km", "1.2 km"]);
  });

  it("says in words when the usual crowd's list does not have a spot, never a blank cell", () => {
    const p = buildSheetModel(makeSheet()).panel4;
    expect(p.showVsUsual).toBe(true);
    // Morning Shift Coffee has no usual-crowd rank while the other spots do: the list came back without it.
    const coffee = p.rows.find((r) => r.name === "Morning Shift Coffee")!;
    expect(coffee.vsUsual).toBe("not in its list");
    expect(coffee.detail).toContain("not in the room's usual crowd's list");
    expect(p.rows.every((r) => r.vsUsual !== "")).toBe(true);
    expect(spotVsUsual(null)).toBe("");
    expect(spotVsUsual(null, true)).toBe("not in the room's usual crowd's list");
  });

  it("leaves the Vs usual crowd column out when no spot has a usual-crowd rank", () => {
    const s = makeSheet();
    s.cards.prePost.results = SPOTS.map((x) => ({ ...x, deltaRank: null }));
    const p = buildSheetModel(s).panel4;
    expect(p.showVsUsual).toBe(false);
    expect(p.rows.every((r) => r.vsUsual === "")).toBe(true);
    expect(p.rows.map((r) => r.detail).join(" ")).not.toContain("usual crowd");
    // The freed width goes to the Spot column, on the PDF and the print view alike.
    expect(spotColumnWidths(true, false)).toEqual({ spot: "55%", type: "23%", distance: "12%", share: "10%", vsUsual: null });
    expect(spotColumnWidths(false, true)).toEqual({ spot: "40%", type: "25%", distance: "15%", share: null, vsUsual: "20%" });
  });
});
