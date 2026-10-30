/**
 * Round 8: the resolution card's reason counts its stand-ins ("so a stand-in is used" with one) and joins names with
 * "and"; a copy line dropped for calling the room cozy from a taste tag is a claim the run didn't back, so the stored
 * Checks step says so and the recheck rewrites an older step that called it "other checks". Every line is synthetic.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { guardStep } from "@walkup/engine";
import { recheckSheet } from "../src/index";
import { deps, runPreset, sheetOf } from "./helpers";

describe("resolution reason (L2)", () => {
  it("says one stand-in in the singular", async () => {
    const s = sheetOf((await runPreset("g2", deps())).final);
    expect(s.cards.resolution.reason).toBe("Qloo has little on Reggie Collier, so a stand-in is used.");
  });
});

describe("Checks step: a room size from a taste tag (L3)", () => {
  let base: StreetSheet;
  beforeAll(async () => {
    base = sheetOf((await runPreset("g1-a", deps())).final);
  });

  const REASONS = [
    "partnerLines[11]: not a partner",
    "partnerLines[12]: not a partner",
    'copyHooks[1]: a room size from a taste tag ("cozy room")',
  ];

  it("counts the drop as a claim the run didn't back", () => {
    expect(guardStep({ dropped: 3, denied: 0, alcoholHeld: 0, reasons: REASONS, ledgerRefs: [] }).decision).toBe(
      "Dropped 3 lines: 1 that made a claim the run didn't back and 2 about places that aren't partners on this sheet.",
    );
  });

  it("rewrites a stored step that said other checks, text only, and is stable", () => {
    const s = structuredClone(base);
    s.guard = { ...s.guard, dropped: 3, reasons: [...s.guard.reasons.filter((r) => !/^(?:partnerLines|copyHooks|tileWhy|summary)/.test(r)), ...REASONS] };
    const old = "Dropped 3 lines: 2 about places that aren't partners on this sheet and 1 for other checks listed under Checks.";
    s.steps = (s.steps ?? []).map((x) => (x.id === "guard" ? { ...x, decision: old } : x));
    const { sheet, report } = recheckSheet(s);
    const step = sheet.steps!.find((x) => x.id === "guard")!;
    expect(step.decision).toMatch(/^Dropped 3 lines: 1 that made a claim the run didn't back and 2 about places that aren't partners on this sheet/);
    expect(report.rewritten).toContain("guard step");
    expect(sheet.guard).toEqual(s.guard);
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });
});
