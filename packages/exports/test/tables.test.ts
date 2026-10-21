import { describe, expect, it } from "vitest";
import {
  apportion,
  areaBudget,
  geohashHalfDiagonalKm,
  MIN_PIN_RADIUS_KM,
  OFFER_CODE_STATUS,
  OFFER_CODES_CSV_COLUMNS,
  offerCodeRows,
  offerCodesCsv,
  PARTNERS_CSV_COLUMNS,
  partnersCsv,
  PINS_CSV_COLUMNS,
  pinRows,
  pinsCsv,
  tileWeights,
  zipRows,
  zipsCsv,
  ZIPS_CSV_COLUMNS,
} from "../src/tables";
import { topTiles, weekdayShort } from "../src/format";
import { planStreetTeamVisits } from "../src/ics";
import { parseCsv, parseCsvObjects } from "./csv-parse";
import { ACTS, makeExplainedSheet, makeHoursSheet, makeMultiStateSheet, makeSheet, PARTNERS, TILES } from "./helpers";

/** Every ZIP counts as homes in these tests (the default reads @walkup/gazetteer/zips; see zips-default.test.ts). */
const allHomes = { isResidentialZip: () => true };

describe("partners.csv", () => {
  const sheet = makeSheet();
  const text = partnersCsv(sheet);
  const rows = parseCsvObjects(text);

  it("has the call-list columns", () => {
    expect(parseCsv(text)[0]).toEqual([...PARTNERS_CSV_COLUMNS]);
  });

  it("lists suggested partners in sheet order, then the declared list in call order", () => {
    expect(rows.map((r) => r.name)).toEqual([
      "Low Hum Records",
      'Spins, "Wax" & Co.',
      "Corner Fade Barbers",
      "Paper Lantern Books",
      "Night Owl Taproom",
      "Field Day Cafe",
      "Hilltop Record Club",
      "Riverside Neighbours Association",
      "Alumni chapter (operator contact)",
    ]);
    expect(rows.map((r) => r.call_order)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    expect(rows.slice(6).map((r) => r.qloo_rank)).toEqual(["1", "2", ""]);
    expect(rows[8]?.notes).toBe("not in Qloo's catalog, kept in your order");
  });

  it("labels every suggested partner as not affiliated and keeps chips with their ledger refs", () => {
    for (const r of rows.slice(0, 6)) {
      expect(r.list).toBe("suggested");
      expect(r.affiliation).toBe("suggested, not affiliated");
    }
    // Once each, in ledger order.
    expect(rows[0]?.receipts).toBe("Q2 Q3");
    expect(rows[0]?.chips).toBe("over-indexes for this bill [Q3]; in a 2.10x lift tile [Q2]");
    expect(rows[0]?.tile).toBe("East Bank, TN");
    expect(rows[0]?.tile_lift).toBe("2.1");
    expect(rows[2]?.category).toBe("Barbershop");
  });

  it("only carries a contact email the operator typed", () => {
    expect(rows.filter((r) => r.contact_email !== "").map((r) => r.contact_email)).toEqual(["lead@example.com"]);
  });

  it("escapes names with commas and quotes", () => {
    expect(text).toContain('"Spins, ""Wax"" & Co."');
  });

  it("marks every row of a sample call list, and no row of a live one", () => {
    expect(rows.every((r) => !(r.notes ?? "").includes("Sample data"))).toBe(true);
    const fx = parseCsvObjects(partnersCsv(makeSheet({ mode: "fixture" })));
    expect(fx).toHaveLength(9);
    for (const r of fx) expect(r.notes).toContain("Sample data: made-up places and numbers, not a live run.");
    expect(fx[8]?.notes).toMatch(/^not in Qloo's catalog, kept in your order; Sample data:/);
  });

  it("leaves the activation, why and confidence columns blank without explain parts", () => {
    for (const r of rows) {
      expect(r.activation).toBe("");
      expect(r.why).toBe("");
      expect(r.confidence).toBe("");
    }
  });

  it("fills activation, why and confidence from each partner's explain parts", () => {
    const x = parseCsvObjects(partnersCsv(makeExplainedSheet()));
    expect(x[0]).toMatchObject({
      activation: "Ask to leave flyers at the counter.",
      why: "Record store, Americana, Vinyl. High confidence: Rank 1 of 40 in a top area, open on the street-team day. Affinity is aggregate taste, not a visit count.",
      confidence: "high",
    });
    expect(x[4]?.confidence).toBe("low");
    // The operator's own list has no explain parts.
    expect(x.slice(6).every((r) => r.activation === "" && r.why === "" && r.confidence === "")).toBe(true);
  });

  it("says which day the hours are for, in the same words as the sheet, and says when to call first", () => {
    expect(rows[0]?.hours_on_day).toBe("Thu 10 am to 7 pm");
    const live = makeSheet();
    live.cards.partners.results = [
      { ...PARTNERS[0]!, hoursOnDay: "17:00:00-02:00:00" },
      { ...PARTNERS[1]!, hoursOnDay: null },
    ];
    const r = parseCsvObjects(partnersCsv(live, { includeDeclared: false }));
    expect(r.map((x) => x.hours_on_day)).toEqual(["Thu 5 pm to 2 am", "Hours not listed: call first"]);
  });

  it("has a day column: the street-team day the calendar visits each partner, with that day's hours", () => {
    expect(rows[0]).toMatchObject({ day: "Thu", visit_dates: "2026-10-29; 2026-11-19", hours_on_day: "Thu 10 am to 7 pm" });
    // The operator's own list is not on the calendar.
    expect(rows.slice(6).every((r) => r.day === "" && r.visit_dates === "")).toBe(true);
    const sheet = makeHoursSheet();
    const r = parseCsvObjects(partnersCsv(sheet, { includeDeclared: false }));
    const by = new Map(r.map((x) => [x.name, x]));
    // Closed Thursday, open Saturday 20:00-02:00: Saturday, with Saturday's hours (not the first street-team day's).
    expect(by.get("Late Bar Books")).toMatchObject({ day: "Sat", hours_on_day: "Sat 8 pm to 2 am" });
    expect(by.get("Evening Records")).toMatchObject({ day: "Thu", hours_on_day: "Thu 5 pm to 9 pm" });
    expect(by.get("No Hours Cafe")?.hours_on_day).toBe("Hours not listed: call first");
    expect(by.get("Always Shut Shop")).toMatchObject({ day: "", visit_dates: "", hours_on_day: "Closed Thu and Sat: not on the calendar" });
    // The same days and dates as street-team.ics.
    const visits = planStreetTeamVisits(sheet).filter((v) => v.partner);
    for (const x of r) {
      const mine = visits.filter((v) => v.partner!.entity.name === x.name);
      expect(x.day, x.name).toBe([...new Set(mine.map((v) => weekdayShort(v.weekday)))].join("; "));
      expect(x.visit_dates, x.name).toBe(mine.map((v) => v.date).join("; "));
    }
  });

  it("doesn't repeat the not-affiliated line in the why column (the affiliation column says it)", () => {
    const x = makeExplainedSheet();
    x.cards.partners.results = x.cards.partners.results.map((p) => ({ ...p, explain: { ...p.explain!, limits: "Suggested, not affiliated: no partner has agreed to anything." } }));
    const r = parseCsvObjects(partnersCsv(x, { includeDeclared: false }));
    expect(r[0]?.why).toBe("Record store, Americana, Vinyl. High confidence: Rank 1 of 40 in a top area, open on the street-team day.");
    expect(r[0]?.affiliation).toBe("suggested, not affiliated");
  });

  it("labels each area with its own place and state, never the venue's city (DC room, MD and VA areas)", () => {
    const r = parseCsvObjects(partnersCsv(makeMultiStateSheet(), { includeDeclared: false }));
    expect(r.map((x) => x.tile)).toEqual(["Silver Spring, MD", "Arlington, VA", "Capitol Hill, DC", "Takoma Park, MD"]);
    const codes = offerCodeRows(makeMultiStateSheet());
    expect(codes.filter((c) => c.channel === "street team").map((c) => c.tile)).toEqual(["Silver Spring, MD", "Arlington, VA", "Capitol Hill, DC"]);
    expect(codes[0]?.description).toBe("Street team code for Corner Press Books (Silver Spring, MD)");
    expect(codes.map((c) => `${c.tile} ${c.description}`).join(" ")).not.toMatch(/Washington|Silver Spring, DC|Arlington, DC/);
  });

  it("can leave the declared list out", () => {
    expect(parseCsvObjects(partnersCsv(sheet, { includeDeclared: false }))).toHaveLength(6);
  });
});

describe("tile weights", () => {
  it("uses the budget split when it covers every selected tile", () => {
    const sheet = makeSheet();
    const w = tileWeights(sheet, topTiles(sheet));
    expect(w.get(TILES[0]!.geohash)).toBeCloseTo(0.3, 10);
    expect([...w.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("follows the area order: the largest share goes to area 1, the next to area 2, ...", () => {
    const sheet = makeSheet();
    // A stored split whose shares don't fall with the area number.
    const shares = [0.4, 0.1, 0.1, 0.25, 0.15];
    sheet.budgetSplit = TILES.slice(0, 5).map((t, i) => ({ geohash: t.geohash, share: shares[i]!, label: "heuristic, not a forecast" as const }));
    const top = topTiles(sheet);
    const w = top.map((t) => tileWeights(sheet, top).get(t.geohash)!);
    expect(w).toEqual([0.4, 0.25, 0.15, 0.1, 0.1].map((x) => expect.closeTo(x, 10)));
    // The sheet's budget split says the same, by area number.
    expect(areaBudget(sheet).map((b) => [b.rank, b.tile.geohash, Math.round(b.share * 100)])).toEqual(top.map((t, i) => [i + 1, t.geohash, [40, 25, 15, 10, 10][i]]));
    expect(areaBudget(makeSheet({ budgetSplit: undefined }))).toEqual([]);
  });

  it("falls back to lift-proportional weights", () => {
    const sheet = makeSheet({ budgetSplit: undefined });
    const top = topTiles(sheet);
    const w = tileWeights(sheet, top);
    const sum = top.reduce((a, t) => a + t.lift, 0);
    expect(w.get(TILES[0]!.geohash)).toBeCloseTo(2.1 / sum, 10);
  });

  it("apportions to exactly one with largest remainders", () => {
    const out = apportion([
      { key: "a", w: 1 },
      { key: "b", w: 1 },
      { key: "c", w: 1 },
    ]);
    expect([...out.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(out.get("a")).toBe(0.3334);
    expect(out.get("b")).toBe(0.3333);
    expect(apportion([{ key: "x", w: 0 }]).size).toBe(0);
  });
});

describe("zips.csv", () => {
  const sheet = makeSheet();

  it("derives ZIPs from the top tiles' ZCTAs only", () => {
    const zips = zipRows(sheet, allHomes).map((r) => r.zip);
    expect(new Set(zips)).toEqual(new Set(["37206", "37203", "37212", "37208", "37228", "02134"]));
    // Tiles under 1.3x (37209, 37218, 37211) are not targets.
    expect(zips).not.toContain("37209");
    expect(zips).not.toContain("37211");
  });

  it("skips malformed ZCTAs and tiles without any", () => {
    const zips = zipRows(sheet, allHomes).map((r) => r.zip);
    expect(zips).not.toContain("ABCDE");
    expect(zips).not.toContain("1234");
  });

  it("a tile that shares a ZIP with a higher area is the same place, so its ZIP is listed once", () => {
    const s = makeSheet();
    s.cards.liftMap.results.tiles = s.cards.liftMap.results.tiles.map((t, i) => (i === 2 ? { ...t, zctas: ["37208", "37206"] } : t));
    const row = zipRows(s, allHomes).find((r) => r.zip === "37206");
    expect(row?.tiles).toEqual([TILES[0]!.geohash]);
    expect(row?.liftScore).toBe(2.1);
    expect(zipRows(s, allHomes).some((r) => r.zip === "37208")).toBe(false);
  });

  it("lists a ZIP in two areas once, under the first", () => {
    const s = makeSheet();
    // A tile far enough from area 1 to keep its own number, sharing a ZIP with area 2.
    s.cards.liftMap.results.tiles = s.cards.liftMap.results.tiles.map((t, i) => (i === 4 ? { ...t, zctas: ["37212", "02134"] } : t));
    const rows = zipRows(s, allHomes);
    expect(rows.filter((r) => r.zip === "37212")).toHaveLength(1);
    expect(rows.find((r) => r.zip === "37212")?.area).toBe(topTiles(s).findIndex((t) => t.geohash === TILES[1]!.geohash) + 1);
  });

  it("weights sum to exactly 1 and fall with the area number: area 1's ZIPs get the most", () => {
    const rows = zipRows(sheet, allHomes);
    expect(rows.reduce((a, r) => a + r.suggestedWeight, 0)).toBeCloseTo(1, 10);
    expect(rows.map((r) => r.area)).toEqual([...rows.map((r) => r.area)].sort((a, b) => a - b));
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.suggestedWeight).toBeGreaterThanOrEqual(rows[i]!.suggestedWeight);
    // Area 1 has one ZIP and area 2 two: each of area 2's ZIPs still gets less than area 1's.
    const a1 = rows.filter((r) => r.area === 1);
    const a2 = rows.filter((r) => r.area === 2);
    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(2);
    for (const r of a2) expect(r.suggestedWeight).toBeLessThan(a1[0]!.suggestedWeight);
  });

  it("agrees with the area order even when a stored budget split does not", () => {
    const s = makeSheet();
    const shares = [0.1, 0.4, 0.1, 0.25, 0.15];
    s.budgetSplit = TILES.slice(0, 5).map((t, i) => ({ geohash: t.geohash, share: shares[i]!, label: "heuristic, not a forecast" as const }));
    const rows = zipRows(s, allHomes);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.suggestedWeight).toBeGreaterThanOrEqual(rows[i]!.suggestedWeight);
    expect(rows[0]).toMatchObject({ zip: "37206", area: 1 });
    expect(rows[0]!.suggestedWeight).toBeGreaterThan(rows.at(-1)!.suggestedWeight);
  });

  it("drops ZIPs that are not homes (P.O. boxes, one organisation, a campus), and an area left with none", () => {
    const notHomes = new Set(["37203", "37206"]);
    const rows = zipRows(sheet, { isResidentialZip: (z) => !notHomes.has(z) });
    expect(rows.map((r) => r.zip)).not.toContain("37203");
    // Area 1's only ZIP is gone, so area 1 has no row; the rest keep their numbers.
    expect(rows.some((r) => r.area === 1)).toBe(false);
    expect(rows[0]).toMatchObject({ zip: "37212", area: 2 });
    expect(rows.reduce((a, r) => a + r.suggestedWeight, 0)).toBeCloseTo(1, 10);
  });

  it("writes zip, area, area_name, lift_score, suggested_weight with leading zeros intact and no BOM", () => {
    const text = zipsCsv(sheet, allHomes);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual([...ZIPS_CSV_COLUMNS]);
    expect(rows[0]).toEqual(["zip", "area", "area_name", "lift_score", "suggested_weight"]);
    expect(rows[1]!.slice(0, 4)).toEqual(["37206", "1", "East Bank, TN", "2.1"]);
    expect(rows.some((r) => r[0] === "02134")).toBe(true);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text).not.toMatch(/fan|audience|ethnic|income/i);
  });

  it("is empty (header only) when no tile reaches the lift floor", () => {
    expect(parseCsv(zipsCsv(sheet, { minLift: 5 }))).toHaveLength(1);
  });
});

describe("pins.csv", () => {
  const sheet = makeSheet();

  it("a geohash-6 cell is well under 1.6 km across", () => {
    const d = geohashHalfDiagonalKm(TILES[0]!.geohash);
    expect(d).toBeGreaterThan(0.3);
    expect(d).toBeLessThan(1.6);
  });

  it("puts one pin per numbered area at its centre, with the area's number and name, radius >= 1.6 km", () => {
    const pins = pinRows(sheet);
    expect(pins).toHaveLength(5);
    expect(pins[0]).toMatchObject({ area: 1, name: "East Bank, TN", lat: 36.175, lon: -86.75, radiusKm: 1.6, geohash: TILES[0]!.geohash });
    expect(pins.map((p) => p.area)).toEqual([1, 2, 3, 4, 5]);
    expect(pins.map((p) => p.geohash)).toEqual(topTiles(sheet).map((t) => t.geohash));
    for (const p of pins) expect(p.radiusKm).toBeGreaterThanOrEqual(MIN_PIN_RADIUS_KM);
  });

  it("never goes below 1.6 km, but honours a larger floor", () => {
    expect(pinRows(sheet, { minRadiusKm: 0.25 }).every((p) => p.radiusKm === 1.6)).toBe(true);
    expect(pinRows(sheet, { minRadiusKm: 3 }).every((p) => p.radiusKm === 3)).toBe(true);
  });

  it("writes area, area_name, lat, lon, radius_km", () => {
    const rows = parseCsv(pinsCsv(sheet));
    expect(rows[0]).toEqual([...PINS_CSV_COLUMNS]);
    expect(rows[0]).toEqual(["area", "area_name", "lat", "lon", "radius_km"]);
    expect(rows[1]).toEqual(["1", "East Bank, TN", "36.175", "-86.75", "1.6"]);
    expect(rows).toHaveLength(6);
    expect(pinsCsv(sheet)).not.toMatch(/mi\b|mile/i);
  });
});

describe("offer-codes.csv", () => {
  const sheet = makeSheet();
  const rows = offerCodeRows(sheet);

  it("has one code per partner, per declared entry and per top tile", () => {
    expect(rows.filter((r) => r.channel === "partner")).toHaveLength(6);
    expect(rows.filter((r) => r.channel === "your list")).toHaveLength(3);
    expect(rows.filter((r) => r.channel === "street team")).toHaveLength(5);
  });

  it("labels every row 'create in your ticketing platform' and leaves pricing to the operator", () => {
    const text = offerCodesCsv(sheet);
    const objs = parseCsvObjects(text);
    expect(parseCsv(text)[0]).toEqual([...OFFER_CODES_CSV_COLUMNS]);
    expect(objs.every((r) => r.status === OFFER_CODE_STATUS)).toBe(true);
    expect(OFFER_CODE_STATUS).toBe("create in your ticketing platform");
    expect(objs.every((r) => r.discount === "" && r.max_uses === "")).toBe(true);
    expect(objs[0]).toMatchObject({ event_id: "syn-tm-1", event_date: "2026-11-20", venue: "Example Hall", valid_from: "2026-10-09", valid_until: "2026-11-20" });
  });

  it("makes unique A-Z0-9 codes that never carry act names", () => {
    const codes = rows.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^[A-Z0-9]+$/);
    const blob = rows.map((r) => `${r.code} ${r.description}`).join(" ").toUpperCase();
    for (const act of ACTS) {
      expect(blob).not.toContain(act.toUpperCase());
      expect(blob).not.toContain(act.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6));
    }
    expect(rows[0]?.code).toBe("LOWHUM01");
  });

  it("marks sample codes in their description", () => {
    expect(rows.every((r) => !r.description.startsWith("[Sample]"))).toBe(true);
    const fx = offerCodeRows(makeSheet({ mode: "fixture" }));
    expect(fx.length).toBe(rows.length);
    expect(fx.every((r) => r.description.startsWith("[Sample] ") && r.status === OFFER_CODE_STATUS)).toBe(true);
  });

  it("applies the operator's prefix", () => {
    expect(offerCodeRows(sheet, { codePrefix: "fall-26" })[0]?.code).toBe("FALL26LOWHUM01");
  });
});
