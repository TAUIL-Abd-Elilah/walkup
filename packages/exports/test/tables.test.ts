import { describe, expect, it } from "vitest";
import {
  apportion,
  geohashHalfDiagonalMi,
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
import { topTiles } from "../src/format";
import { parseCsv, parseCsvObjects } from "./csv-parse";
import { ACTS, makeExplainedSheet, makeSheet, TILES } from "./helpers";

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
    expect(rows[0]?.receipts).toBe("Q3 Q2");
    expect(rows[0]?.chips).toBe("over-indexes for this bill [Q3]; in a 2.10x lift tile [Q2]");
    expect(rows[0]?.tile).toBe("East Bank");
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
    const zips = zipRows(sheet).map((r) => r.zip);
    expect(new Set(zips)).toEqual(new Set(["37206", "37203", "37212", "37208", "37228", "02134"]));
    // Tiles under 1.3x (37209, 37218, 37211) are not targets.
    expect(zips).not.toContain("37209");
    expect(zips).not.toContain("37211");
  });

  it("skips malformed ZCTAs and tiles without any", () => {
    const zips = zipRows(sheet).map((r) => r.zip);
    expect(zips).not.toContain("ABCDE");
    expect(zips).not.toContain("1234");
  });

  it("a tile that shares a ZIP with a higher area is the same place, so its ZIP is listed once", () => {
    const s = makeSheet();
    s.cards.liftMap.results.tiles = s.cards.liftMap.results.tiles.map((t, i) => (i === 2 ? { ...t, zctas: ["37208", "37206"] } : t));
    const row = zipRows(s).find((r) => r.zip === "37206");
    expect(row?.tiles).toEqual([TILES[0]!.geohash]);
    expect(row?.liftScore).toBe(2.1);
    expect(zipRows(s).some((r) => r.zip === "37208")).toBe(false);
  });

  it("weights sum to exactly 1 and rows are sorted by weight", () => {
    const rows = zipRows(sheet);
    expect(rows.reduce((a, r) => a + r.suggestedWeight, 0)).toBeCloseTo(1, 10);
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.suggestedWeight).toBeGreaterThanOrEqual(rows[i]!.suggestedWeight);
  });

  it("writes zip, lift_score, suggested_weight with leading zeros intact and no BOM", () => {
    const text = zipsCsv(sheet);
    const rows = parseCsv(text);
    expect(rows[0]).toEqual([...ZIPS_CSV_COLUMNS]);
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

  it("a geohash-6 cell is well under a mile across", () => {
    const d = geohashHalfDiagonalMi(TILES[0]!.geohash);
    expect(d).toBeGreaterThan(0.2);
    expect(d).toBeLessThan(1);
  });

  it("puts one pin per top tile at its centre with radius >= 1 mile", () => {
    const pins = pinRows(sheet);
    expect(pins).toHaveLength(5);
    expect(pins[0]).toMatchObject({ lat: 36.175, lon: -86.75, radiusMi: 1, geohash: TILES[0]!.geohash });
    for (const p of pins) expect(p.radiusMi).toBeGreaterThanOrEqual(1);
  });

  it("never goes below 1 mile, but honours a larger floor", () => {
    expect(pinRows(sheet, { minRadiusMi: 0.25 }).every((p) => p.radiusMi === 1)).toBe(true);
    expect(pinRows(sheet, { minRadiusMi: 2 }).every((p) => p.radiusMi === 2)).toBe(true);
  });

  it("writes lat, lon, radius_mi", () => {
    const rows = parseCsv(pinsCsv(sheet));
    expect(rows[0]).toEqual([...PINS_CSV_COLUMNS]);
    expect(rows[1]).toEqual(["36.175", "-86.75", "1"]);
    expect(rows).toHaveLength(6);
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
