/**
 * Round 7, orchestrator: the offline recheck fails Claude's "stands out in five areas" under a lift card that counts
 * more, and puts the template's summary in its place with the reason in the checks. A summary the template already
 * wrote in its old wording ("in 4 areas") is reworded, not reported as replaced. Synthetic data.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { recheckSheet } from "../src/index";
import { deps, runPreset, sheetOf } from "./helpers";

let g1a: StreetSheet;

beforeAll(async () => {
  g1a = sheetOf((await runPreset("g1-a", deps())).final);
});

describe("recheckSheet: the count of areas that stand out", () => {
  it("replaces Claude's count when it is not the lift card's", () => {
    const s = structuredClone(g1a);
    const passed = Number(/^(\d+) areas pass both tests/.exec(s.cards.liftMap.summary)![1]);
    expect(passed).toBeGreaterThan(5);
    s.narration = { ...s.narration!, templated: false, summary: "This crowd stands out in five areas compared with the room's usual crowd." };
    const { sheet, report } = recheckSheet(s);
    expect(report.replaced).toEqual([`summary: says the crowd stands out in five areas; the lift card counts ${passed} that pass both tests`]);
    expect(sheet.narration!.summary).toMatch(/stands out from the room's usual crowd in the sheet's top \d areas; the strongest, /);
    expect(sheet.guard.reasons.at(-1)).toBe(`replaced by the template: ${report.replaced[0]}`);
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("rewords the template's own old count without calling it replaced", () => {
    const s = structuredClone(g1a);
    const now = s.narration!.summary;
    const top = /in the sheet's top (\d+) areas;/.exec(now)![1];
    s.narration = { ...s.narration!, templated: false, summary: now.replace(`in the sheet's top ${top} areas;`, `in ${top} areas;`) };
    s.guard = { ...s.guard, reasons: [...s.guard.reasons, "summary: number 9.9 is not in this run"] };
    const { sheet, report } = recheckSheet(s);
    expect(sheet.narration!.summary).toBe(now);
    expect(report.replaced).toEqual([]);
    expect(report.rewritten).toContain("summary top areas");
  });
});
