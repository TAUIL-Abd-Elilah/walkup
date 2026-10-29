/**
 * Second re-audit (Oct 29), integration: the Checks panel counts a failed line the template had no wording for
 * ("replaced by the template: ... (dropped)") with the other lines left out, also when the guard dropped some, so its
 * count matches the Checks step's.
 */
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }), notFound: () => undefined }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { checksLine } = await import("../components/plan/PlanView");
const { guardStep } = await import("@walkup/engine");

const SWAP_DROPPED = "replaced by the template: tileWhy[2]: number (94) not backed by the sheet (dropped)";

describe("the Checks panel and step agree on a line with no fixed wording", () => {
  it("counts it with the lines the guard dropped", () => {
    const reasons = ["partnerLines[3]: entityId not in this run", SWAP_DROPPED];
    expect(checksLine({ dropped: 1, reasons, deniedTagCount: 0 })).toBe("Checks left out 2 lines. No tag was left out under the data policy.");
    expect(guardStep({ dropped: 1, denied: 0, alcoholHeld: 0, reasons, ledgerRefs: [] }).decision).toMatch(/^Dropped 2 lines: /);
    expect(checksLine({ dropped: 0, reasons: [SWAP_DROPPED], deniedTagCount: 0 })).toBe("Checks left out 1 line. No tag was left out under the data policy.");
    expect(guardStep({ dropped: 0, denied: 0, alcoholHeld: 0, reasons: [SWAP_DROPPED], ledgerRefs: [] }).decision).toBe("Dropped 1 line for other checks listed under Checks.");
  });
});
