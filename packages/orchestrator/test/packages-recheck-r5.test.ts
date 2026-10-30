/**
 * Round 5: `recheckSheet` on a fixture-world sheet whose narration is written as Claude wrote it on the recorded
 * sheets: an area line with another area's percentile is swapped for the template's, and two text-only fixes ("an
 * 82nd", "about 2.0 times") reach Claude's other lines. Every line below is synthetic.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { templateTileWhy } from "@walkup/narrator";
import { recheckSheet } from "../src/index";
import { deps, runPreset, sheetOf } from "./helpers";

let base: StreetSheet;

beforeAll(async () => {
  base = sheetOf((await runPreset("g1-a", deps())).final);
});

describe("recheckSheet: Claude's area lines", () => {
  it("swaps a line citing a percentile that is not the area's, writes 'an 82nd' and 'about 2.0 times', and is stable", () => {
    const s = structuredClone(base);
    const [t0, t1] = s.cards.liftMap.results.tiles;
    t0!.billPct = 0.8049;
    t0!.housePct = 0.239;
    t1!.lift = 2.0406;
    t1!.billPct = 0.82;
    s.narration = {
      ...s.narration!,
      templated: false,
      summary: "A short summary with no claim in it.",
      tileWhy: [
        { geohash: t0!.geohash, text: "This area is at the 81st percentile for this bill." },
        { geohash: t1!.geohash, text: "This area shows a lift of about 2 times the room's usual crowd, with a 82nd percentile bill rank." },
      ],
    };
    const { sheet, report } = recheckSheet(s);
    expect(report.replaced).toEqual(["tileWhy[0]: says the 81st percentile, the area's are 80th for this crowd and 24th for the room's usual crowd"]);
    expect(sheet.narration!.tileWhy[0]!.text).toBe(templateTileWhy(t0!));
    expect(sheet.guard.reasons).toContain("replaced by the template: tileWhy[0]: says the 81st percentile, the area's are 80th for this crowd and 24th for the room's usual crowd");
    expect(sheet.narration!.tileWhy[1]!.text).toBe("This area shows a lift of about 2.0 times the room's usual crowd, with an 82nd percentile bill rank.");
    expect(report.rewritten).toEqual(expect.arrayContaining(['"an" before a number (1)', '"about N.0 times" (1)']));
    // Nothing the run found changes, and a second pass changes nothing.
    expect(sheet.cards.liftMap.results.tiles).toEqual(s.cards.liftMap.results.tiles);
    expect(sheet.budgetSplit).toEqual(s.budgetSplit);
    expect(sheet.cards.partners.results.map((p) => p.entity.entityId)).toEqual(s.cards.partners.results.map((p) => p.entity.entityId));
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("leaves a templated narration's lines alone", () => {
    const s = structuredClone(base);
    s.narration = { ...s.narration!, templated: true, summary: "Template words with a 82nd in them." };
    expect(recheckSheet(s).sheet.narration!.summary).toBe("Template words with a 82nd in them.");
  });
});
