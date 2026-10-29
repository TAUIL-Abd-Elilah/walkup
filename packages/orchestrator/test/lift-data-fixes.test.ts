/**
 * Round 4 of the re-audit (text-integrity-lift-about-N-times-rounding-disagrees): one "about N times" per area. A
 * run writes the sheet's 2-decimal lift rounded half up everywhere (`aboutTimes`), and the recheck corrects what
 * stored sheets wrote by the old rules: the template's area lines and summary (2.15 read "2.1") and the heat step
 * (the raw lift, so 2.4477 read "2.4" beside the sheet's 2.45x). A line Claude wrote is left alone.
 * Fixture world only.
 */
import { describe, expect, it } from "vitest";
import { aboutTimes, type StreetSheet } from "@walkup/contracts";
import { recheckSheet } from "../src/index";
import { numberedTiles } from "../src/steps/heat";
import { deps, runPreset, sheetOf } from "./helpers";

/** A stored sheet as the old rules wrote it: area 1 at `lift`, its template line and the summary at `old` figures. */
async function storedWith(lift: number, figures: { line: string; summary: string; step: string }): Promise<{ fresh: StreetSheet; stored: StreetSheet; geohash: string }> {
  const fresh = sheetOf((await runPreset("g1-a", deps())).final);
  const stored: StreetSheet = structuredClone(fresh);
  const first = numberedTiles(stored.cards.liftMap.results.tiles)[0]!;
  first.lift = lift;
  const n = stored.narration!;
  expect(n.templated).toBe(true);
  n.tileWhy = n.tileWhy.map((w) => (w.geohash === first.geohash ? { ...w, text: w.text.replace(/^About \d+\.\d times /, `About ${figures.line} times `) } : w));
  n.summary = n.summary.replace(/(; the strongest, [^,]+, is about )\d+\.\d( times )/, `$1${figures.summary}$2`);
  stored.steps = stored.steps!.map((s) => (s.id === "heat" ? { ...s, decision: s.decision.replace(/about \d+\.\d times/, `about ${figures.step} times`) } : s));
  return { fresh, stored, geohash: first.geohash };
}

const heat = (s: StreetSheet) => s.steps!.find((x) => x.id === "heat")!.decision;
const line = (s: StreetSheet, geohash: string) => s.narration!.tileWhy.find((w) => w.geohash === geohash)!.text;

describe("one 'about N times' per area", () => {
  it("is what a run writes: the template's line, its summary and the heat step agree", async () => {
    const s = sheetOf((await runPreset("g1-a", deps())).final);
    const first = numberedTiles(s.cards.liftMap.results.tiles)[0]!;
    const words = `about ${aboutTimes(first.lift)} times the room's usual crowd`;
    expect(line(s, first.geohash).toLowerCase()).toContain(words);
    expect(s.narration!.summary).toContain(`is ${words}.`);
    expect(heat(s)).toBe(`Put ${first.name} first: ${words}.`);
    expect(recheckSheet(s).report.rewritten.filter((r) => /figure/.test(r))).toEqual([]);
  });

  it("rechecks the template's 2.15 that read 2.1 (Englewood) to 2.2 in the area line and the summary", async () => {
    const { stored, geohash } = await storedWith(2.1534, { line: "2.1", summary: "2.1", step: "2.2" });
    const { sheet, report } = recheckSheet(stored);
    expect(line(sheet, geohash)).toMatch(/^About 2\.2 times the room's usual crowd\. /);
    expect(sheet.narration!.summary).toMatch(/; the strongest, [^,]+, is about 2\.2 times the room's usual crowd\./);
    expect(heat(sheet)).toMatch(/: about 2\.2 times the room's usual crowd\.$/);
    expect(report.rewritten).toEqual(expect.arrayContaining(["area line figure (1)", "summary figure"]));
    expect(report.rewritten).not.toContain("lift map step figure");
    // Nothing else in the line moves, and a second pass changes nothing.
    expect(line(sheet, geohash).replace("2.2", "2.1")).toBe(line(stored, geohash));
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("rechecks the heat step's 2.4 beside the sheet's 2.45x (Highwood) to 2.5", async () => {
    const { stored } = await storedWith(2.4477, { line: "2.5", summary: "2.5", step: "2.4" });
    const { sheet, report } = recheckSheet(stored);
    expect(heat(sheet)).toMatch(/: about 2\.5 times the room's usual crowd\.$/);
    expect(report.rewritten).toContain("lift map step figure");
    expect(report.rewritten.filter((r) => /^(area line|summary) figure/.test(r))).toEqual([]);
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("never touches a line Claude wrote, nor a figure the old rule would not have written", async () => {
    const { stored, geohash } = await storedWith(2.1534, { line: "2.1", summary: "2.1", step: "2.2" });
    const claude: StreetSheet = structuredClone(stored);
    claude.narration = {
      ...claude.narration!,
      templated: false,
      tileWhy: claude.narration!.tileWhy.map((w) => (w.geohash === geohash ? { ...w, text: "This area shows about 2.1 times the room's usual crowd." } : w)),
    };
    const after = recheckSheet(claude).sheet;
    expect(line(after, geohash)).toBe("This area shows about 2.1 times the room's usual crowd.");
    // Claude's summary (the guard did not replace it) keeps its words.
    expect(after.narration!.summary).toBe(claude.narration!.summary);
    // A step figure that is neither rule's is not this code's to guess at.
    const odd: StreetSheet = structuredClone(stored);
    odd.steps = odd.steps!.map((s) => (s.id === "heat" ? { ...s, decision: s.decision.replace(/about \d+\.\d times/, "about 1.9 times") } : s));
    expect(heat(recheckSheet(odd).sheet)).toContain("about 1.9 times");
  });
});
