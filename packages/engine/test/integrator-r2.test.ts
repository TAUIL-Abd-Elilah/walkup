/**
 * Second re-audit (Oct 29), integration: a failed line the template had no wording for ("replaced by the template:
 * tileWhy[2]: ... (dropped)") was left out, not replaced. The Checks step counts it with the dropped lines, as the
 * plan page's Checks panel does, and never among the lines fixed wording replaced.
 */
import { describe, expect, it } from "vitest";
import { guardStep, replacedLines } from "../src/index";

const SWAP_DROPPED = "replaced by the template: tileWhy[2]: number (94) not backed by the sheet (dropped)";
const SWAPPED = "replaced by the template: tileWhy[1]: says 6 partners, the sheet has 8";

describe("a failed line with no fixed wording for its slot", () => {
  it("is not counted as replaced", () => {
    expect(replacedLines([SWAP_DROPPED])).toBeNull();
    expect(replacedLines([SWAP_DROPPED, SWAPPED])).toBe("fixed wording replaced 1 of Claude's area and partner lines");
  });

  it("is counted as left out in the Checks step", () => {
    expect(guardStep({ dropped: 0, denied: 0, alcoholHeld: 0, reasons: [SWAP_DROPPED, SWAPPED], ledgerRefs: [] }).decision).toBe(
      "Dropped 1 line for other checks listed under Checks; fixed wording replaced 1 of Claude's area and partner lines.",
    );
    expect(
      guardStep({ dropped: 1, denied: 0, alcoholHeld: 0, reasons: ["partnerLines[3]: entityId not in this run", SWAP_DROPPED], ledgerRefs: [] }).decision,
    ).toBe("Dropped 2 lines: 1 that cited something this run didn't return and 1 for other checks listed under Checks.");
  });
});
