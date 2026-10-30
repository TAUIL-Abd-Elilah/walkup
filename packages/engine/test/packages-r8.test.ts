/** Round 8: copy lines dropped for a claim the run didn't back are counted apart from wording and policy drops. */
import { describe, expect, it } from "vitest";
import { guardDropCounts, guardStep, UNBACKED_COPY_DROP_RE } from "../src/index";

describe("guardDropCounts: unbacked copy claims", () => {
  it("counts a room size from a taste tag and a claim the sheet can't back", () => {
    const reasons = [
      'copyHooks[1]: a room size from a taste tag ("intimate room")',
      'copyHooks[2]: claim the sheet can\'t back ("sold out")',
      "partnerLines[6]: alcohol word \"Cocktail\" on a show that is not 21+",
      "copyHooks[0]: repeat",
    ];
    expect(guardDropCounts(reasons)).toEqual({ citation: 0, unbacked: 2, notPartner: 0, alcohol: 1, other: 1 });
    expect(UNBACKED_COPY_DROP_RE.test("copyHooks[0]: repeat")).toBe(false);
    expect(guardStep({ dropped: 4, denied: 0, alcoholHeld: 0, reasons, ledgerRefs: [] }).decision).toBe(
      "Dropped 4 lines: 2 that made a claim the run didn't back, 1 with an alcohol word on a show that isn't 21+ and 1 for other checks listed under Checks.",
    );
  });
});
