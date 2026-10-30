/**
 * Round 8 (L3): the plan page's Checks line counts a copy line dropped for a room size read off a taste tag ("cozy
 * room" for a room that holds 6,000) as a claim the run didn't back, as the stored Checks step now does. The reasons
 * below are copied from the recorded Rhiannon Giddens revisions 2cf1cf3c and 95e3c9b6.
 */
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { GuardReport } from "@walkup/contracts";
import { guardDropCounts, UNBACKED_COPY_DROP_RE } from "@walkup/engine";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { checksLine, unbackedDrops } = await import("../components/plan/PlanView");

const POLICY = "59 tags denied by policy (ethnicity/inclusivity/credit_card/customer_identity/cost_description)";
const NAMESPACES = { ethnicity: 4, inclusivity: 5, credit_card: 7, customer_identity: 30, cost_description: 13 };

const G_2CF1 = {
  dropped: 14,
  deniedTagCount: 59,
  deniedByNamespace: NAMESPACES,
  reasons: [
    POLICY,
    ...Array.from({ length: 13 }, (_, i) => `partnerLines[${11 + i}]: not a partner`),
    'replaced by the template: summary: superlative "the most" not backed by the sheet',
    "replaced by the template: tileWhy[1]: says two partners, the sheet has 3 in this area",
    "2 tags held back from copy on a show that is not 21+ (alcohol).",
    "11 partner lines trimmed: a tag the place doesn't list as shared was cut.",
    'copyHooks[1]: a room size from a taste tag ("cozy room")',
  ],
} satisfies GuardReport;

const G_95E3 = {
  dropped: 4,
  deniedTagCount: 59,
  deniedByNamespace: NAMESPACES,
  reasons: [
    POLICY,
    'partnerLines[6]: alcohol word "Cocktail" on a show that is not 21+',
    "partnerLines[16]: not a partner",
    "partnerLines[17]: not a partner",
    'replaced by the template: summary: superlative "largest" not backed by the sheet',
    'replaced by the template: tileWhy[0]: superlative "the most" not backed by the sheet',
    "2 tags held back from copy on a show that is not 21+ (alcohol).",
    "15 partner lines trimmed: a tag the place doesn't list as shared was cut.",
    "replaced by the template: partnerLines[0]: merges split opening hours into one span",
    'copyHooks[1]: a room size from a taste tag ("intimate room")',
  ],
} satisfies GuardReport;

describe("a room size read off a taste tag is a claim the run didn't back (L3)", () => {
  it("splits the Checks line on 2cf1cf3c and 95e3c9b6", () => {
    expect(checksLine(G_2CF1)).toMatch(/^Checks left out 14 lines: 1 for a claim the run didn't back, 13 for a wording or policy rule\. /);
    expect(checksLine(G_95E3)).toMatch(/^Checks left out 4 lines: 1 for a claim the run didn't back, 3 for a wording or policy rule\. /);
  });

  it("counts a claim the sheet can't back the same way", () => {
    const g: GuardReport = { dropped: 2, deniedTagCount: 0, reasons: ['copyHooks[0]: claim the sheet can\'t back ("sold out")', "partnerLines[3]: not a partner"] };
    expect(checksLine(g)).toBe("Checks left out 2 lines: 1 for a claim the run didn't back, 1 for a wording or policy rule. No tag was left out under the data policy.");
  });

  it("agrees with the stored Checks step's count", () => {
    for (const g of [G_2CF1, G_95E3]) {
      const c = guardDropCounts(g.reasons);
      expect(unbackedDrops(g)).toBe(c.citation + c.unbacked);
    }
    expect(UNBACKED_COPY_DROP_RE.test(G_2CF1.reasons.at(-1)!)).toBe(true);
  });
});
