/**
 * Round 4 of the re-audit, the downloads' side:
 *
 * - The calendar's "Area 1 of 5" line gives the same "about N times" as the plan page and the PDF (the sheet's
 *   2-decimal lift, half up: 2.1534 is 2.15x and "about 2.2 times"), and names the genre's fans on a tag baseline
 *   (text-integrity-lift-about-N-times-rounding-disagrees).
 * - The PDF quotes copy lines with curly quotes, as the plan page and the print view do
 *   (text-integrity-pdf-copy-lines-straight-quotes).
 * - With no usual crowd to compare with, the map panel says "no lift map" once, not three times
 *   (text-integrity-g3-map-panel-says-no-lift-map-three-times).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { toIcs } from "../src/ics";
import { renderStreetSheetPdf } from "../src/pdf";
import { buildSheetModel, sheetModelText } from "../src/sheet-model";
import { makeSheet, TILES } from "./helpers";
import { pdfPlainText } from "./pdf-text";

/** Every DESCRIPTION, unfolded and unescaped. */
function descriptions(ics: string): string[] {
  return ics
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter((l) => l.startsWith("DESCRIPTION:"))
    .map((l) => l.slice("DESCRIPTION:".length).replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1"));
}

function withLift(sheet: StreetSheet, lift: number, baseline: "house" | "tag" = "house"): StreetSheet {
  const tiles = sheet.cards.liftMap.results.tiles.map((t, i) => (i === 0 ? { ...t, lift } : t));
  return {
    ...sheet,
    cards: { ...sheet.cards, liftMap: { ...sheet.cards.liftMap, results: { ...sheet.cards.liftMap.results, tiles, diagnostics: { ...sheet.cards.liftMap.results.diagnostics, baseline } } } },
  };
}

describe("the calendar's area line (text-integrity-lift-about-N-times-rounding-disagrees)", () => {
  it("rounds the sheet's 2-decimal lift half up, as the plan page and the PDF do", () => {
    for (const [lift, words] of [
      [2.1534, "About 2.2 times"],
      [2.4477, "About 2.5 times"],
      [2.2491, "About 2.3 times"],
    ] as const) {
      const desc = descriptions(toIcs(withLift(makeSheet(), lift))).join("\n");
      expect(desc, String(lift)).toContain(`Area 1 of 5: East Bank, TN, ZIP 37206. ${words} the room's usual crowd.`);
      expect(desc).toContain("Where this bill's fans stand out from the room's usual crowd, not where buyers live.");
    }
  });

  it("names the genre's fans on a tag baseline, as the plan page's area lines do", () => {
    const s = withLift(makeSheet(), 2.1534, "tag");
    s.bill = { ...s.bill, classification: "Comedy" };
    const desc = descriptions(toIcs(s)).join("\n");
    expect(desc).toContain("Area 1 of 5: East Bank, TN, ZIP 37206. About 2.2 times comedy fans in general.");
    expect(desc).toContain("Where this bill's fans stand out from comedy fans in general, not where buyers live.");
    expect(desc).not.toContain("the room's usual crowd");
    expect(TILES[0]!.name).toBe("East Bank");
  });
});

describe("the PDF's copy lines (text-integrity-pdf-copy-lines-straight-quotes)", () => {
  it("are in curly quotes, Letter and A4", async () => {
    for (const pageSize of ["LETTER", "A4"] as const) {
      const text = pdfPlainText((await renderStreetSheetPdf(makeSheet(), { pageSize })).buffer);
      expect(text, pageSize).toContain("“Americana and string bands, one night.”");
      expect(text, pageSize).not.toMatch(/"Americana/);
    }
  }, 60_000);
});

describe("a sheet with no usual crowd (text-integrity-g3-map-panel-says-no-lift-map-three-times)", () => {
  const g3 = (JSON.parse(readFileSync(new URL("../../../fixtures/synthetic/engine/g3.sheet.json", import.meta.url), "utf8")) as { sheet: StreetSheet }).sheet;

  it("says there is no lift map once in the map panel, after the card's own reason", async () => {
    expect(g3.cards.liftMap.results.diagnostics.baseline).toBe("none");
    const m = buildSheetModel(g3);
    expect(m.panel1.baseline).toBe("");
    expect(m.panel1.empty).toBe("No lift map: there is no usual crowd to compare this bill with.");
    expect(sheetModelText(m).join(" ")).not.toContain("Nothing to compare with");
    const text = pdfPlainText((await renderStreetSheetPdf(g3)).buffer);
    expect(text).toContain("No lift map: there is no usual crowd to compare this bill with.");
    expect(text).not.toContain("Nothing to compare with");
  }, 60_000);
});
