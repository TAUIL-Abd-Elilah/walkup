/**
 * Round 5: `recheckSheet` drops a fan copy line narrate()'s guard now drops ("a cozy room" from a taste tag), so the
 * stored sheet, sheet.json and MCP say what the page shows: the card's count and status, the guard's reason and count,
 * and the Summary step's line count. Every line below is synthetic.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { narrateStep } from "@walkup/engine";
import { recheckSheet } from "../src/index";
import { deps, runPreset, sheetOf } from "./helpers";

let base: StreetSheet;

beforeAll(async () => {
  base = sheetOf((await runPreset("g1-a", deps())).final);
});

const LINES = [
  "Test Headliner at Sample Hall: heritage and americana.",
  "Test Headliner at Sample Hall: country and folk, with a cozy room.",
  "Test Headliner at Sample Hall: alt-country and roots rock.",
];

/** A sheet whose copy card holds three model lines, one of them calling the room cozy, with the step as a run wrote it. */
function withHooks(templated: boolean): StreetSheet {
  const s = structuredClone(base);
  const head = s.bill.acts[0]?.name ?? "Test Headliner";
  const venue = s.bill.venue.name;
  s.narration = { ...s.narration!, templated };
  s.cards.copyHooks = {
    ...s.cards.copyHooks,
    status: "ok",
    summary: "3 lines, each built only from approved Qloo tags.",
    results: LINES.map((l) => ({ text: l.replace("Test Headliner", head).replace("Sample Hall", venue), tagIds: [] })),
  };
  delete s.cards.copyHooks.reason;
  const step = narrateStep({ templated, hooks: 3, hooksStatus: "ok", ledgerRefs: [] });
  s.steps = (s.steps ?? []).map((x) => (x.id === "narrate" ? { ...x, decision: step.decision, status: step.status } : x));
  return s;
}

describe("recheckSheet: fan copy", () => {
  it("drops a line that calls the room cozy, recounts the card and the Summary step, and is stable", () => {
    const s = withHooks(false);
    const { sheet, report } = recheckSheet(s);
    expect(sheet.cards.copyHooks.results.map((h) => h.text)).toEqual([s.cards.copyHooks.results[0]!.text, s.cards.copyHooks.results[2]!.text]);
    expect(sheet.cards.copyHooks.summary).toBe("2 lines, each built only from approved Qloo tags.");
    expect(sheet.cards.copyHooks.status).toBe("partial");
    expect(sheet.cards.copyHooks.reason).toBe("2 lines passed the checks.");
    expect(sheet.guard.dropped).toBe(s.guard.dropped + 1);
    expect(sheet.guard.reasons).toContain('copyHooks[1]: a room size from a taste tag ("cozy room")');
    const narrate = sheet.steps!.find((x) => x.id === "narrate")!;
    expect(narrate.decision).toMatch(/ and 2 fan copy lines /);
    expect(narrate.cause).toBe("Only 2 copy lines passed the tag allowlist and the checks.");
    expect(report.rewritten).toEqual(expect.arrayContaining(["copy lines dropped (1)", "copy lines step"]));
    // Nothing the run found changes, and a second pass changes nothing.
    expect(sheet.cards.partners.results).toEqual(s.cards.partners.results);
    expect(sheet.budgetSplit).toEqual(s.budgetSplit);
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("leaves a templated sheet's copy alone", () => {
    const s = withHooks(true);
    expect(recheckSheet(s).sheet.cards.copyHooks).toEqual(s.cards.copyHooks);
  });
});
