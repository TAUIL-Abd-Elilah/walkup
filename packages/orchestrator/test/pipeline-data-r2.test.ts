/**
 * Second re-audit (Oct 29), the recheck over stored sheets: partner chains said last in their own area (card and
 * step; spots keep "listed last"), the guard's "15 partner line(s) trimmed" counted in words, and the Checks step
 * counting a summary the guard dropped as replaced. Fixture-world sheets changed by hand to the stored forms.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { guardDropCounts } from "@walkup/engine";
import { recheckSheet } from "../src/index";
import { chainsLastInArea } from "../src/refresh";
import { partnerLineCount, partnerLineReason } from "../src/steps/copy";
import { deps, runPreset, sheetOf } from "./helpers";

let g1a: StreetSheet;
let g3: StreetSheet;

beforeAll(async () => {
  g1a = sheetOf((await runPreset("g1-a", deps())).final);
  g3 = sheetOf((await runPreset("g3", deps())).final);
});

const CARD_OLD = "2 of 24 partners are national chains, listed last: no local place filled their slot. 12 more chains left off: 10 for local places, 2 by the limit of 2 per list.";
const STEP_OLD = "Listed 1 national chain last, after the local places: no local place filled its slot; left off 3 national chains, at most 2 per list: A, B and C.";
const SPOTS_OLD = "8 spots within 1.5 km. 1 of 8 spots is a national chain, listed last: no local place filled its slot.";

function withStoredChains(s: StreetSheet): StreetSheet {
  const out = structuredClone(s);
  out.cards.partners.summary = `${out.cards.partners.summary} ${CARD_OLD}`;
  out.cards.prePost.summary = SPOTS_OLD;
  out.steps = out.steps!.map((st) => (st.id === "partners" ? { ...st, cause: `${st.cause ?? ""} ${STEP_OLD}`.trim() } : st));
  return out;
}

describe("partner chains are last in their own area", () => {
  it("rewrites the card and the step on a list grouped by area, and leaves the spots alone", () => {
    const s = withStoredChains(g1a);
    const { sheet, report } = recheckSheet(s);
    expect(sheet.cards.partners.summary).toContain("2 of 24 partners are national chains, listed last in their area: no local place filled their slot. 12 more chains left off");
    expect(sheet.steps!.find((x) => x.id === "partners")!.cause).toContain("Listed 1 national chain last in its area: no local place filled its slot; left off 3 national chains");
    expect(sheet.cards.prePost.summary).toBe(SPOTS_OLD);
    expect(report.rewritten).toEqual(expect.arrayContaining(["partners chain order", "partners step chain order"]));
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("keeps 'listed last' on a list from near the venue alone", () => {
    const s = withStoredChains(g3);
    const { sheet, report } = recheckSheet(s);
    expect(sheet.cards.partners.summary).toContain("listed last: no local place filled their slot");
    expect(report.rewritten).not.toContain("partners chain order");
  });

  it("touches only the partner forms", () => {
    expect(chainsLastInArea("1 of 16 partners is a national chain, listed last: no local place filled its slot.")).toBe(
      "1 of 16 partners is a national chain, listed last in its area: no local place filled its slot.",
    );
    expect(chainsLastInArea(SPOTS_OLD)).toBe(SPOTS_OLD);
    const spotsStep = "Listed 1 national chain last, after the local spots: no local spot filled its slot";
    expect(chainsLastInArea(spotsStep)).toBe(spotsStep);
  });
});

describe("guard reasons and the Checks step", () => {
  it("says 'line' or 'lines' by the count", () => {
    expect(partnerLineCount(1)).toBe("1 partner line");
    expect(partnerLineCount(15)).toBe("15 partner lines");
    expect(partnerLineReason("15 partner line(s) trimmed: a tag the place doesn't list as shared was cut.")).toBe("15 partner lines trimmed: a tag the place doesn't list as shared was cut.");
    expect(partnerLineReason("1 partner line(s) dropped: cited entity not traced to this run's ledger.")).toBe("1 partner line dropped: cited entity not traced to this run's ledger.");
    expect(partnerLineReason("partnerLines[3]: not a partner")).toBe("partnerLines[3]: not a partner");
  });

  it("writes a dropped count the Checks step reads back as citation drops", () => {
    for (const n of [1, 2, 1200]) {
      const reason = `${partnerLineCount(n)} dropped: cited entity not traced to this run's ledger.`;
      expect(reason).toMatch(/^\d+ partner lines? dropped: /);
      expect(guardDropCounts([reason])).toEqual({ citation: n, notPartner: 0, alcohol: 0, other: 0 });
    }
  });

  it("rewrites stored reasons, and counts a dropped summary as replaced in the Checks step", () => {
    const s = structuredClone(g1a);
    s.narration = { ...s.narration!, templated: false };
    s.guard = {
      ...s.guard,
      dropped: 2,
      reasons: [
        ...s.guard.reasons.filter((r) => !/template/.test(r)),
        "summary: number 1.8 is not in this run",
        'partnerLines[6]: alcohol word "Cocktail" on a show that is not 21+',
        "replaced by the template: tileWhy[1]: says three partners, the sheet has 4 in this area",
        "2 partner line(s) trimmed: a tag the place doesn't list as shared was cut.",
      ],
    };
    s.steps = s.steps!.map((st) =>
      st.id === "guard"
        ? { ...st, decision: "Dropped 2 lines: 1 that cited something this run didn't return and 1 with an alcohol word on a show that isn't 21+; fixed wording replaced 1 of Claude's area and partner lines." }
        : st,
    );
    const { sheet, report } = recheckSheet(s);
    expect(sheet.guard.reasons.at(-1)).toBe("2 partner lines trimmed: a tag the place doesn't list as shared was cut.");
    expect(sheet.guard.dropped).toBe(2);
    expect(sheet.steps!.find((x) => x.id === "guard")!.decision).toBe(
      "Dropped 1 line with an alcohol word on a show that isn't 21+; fixed wording replaced Claude's summary and 1 of its area and partner lines.",
    );
    expect(report.rewritten).toEqual(expect.arrayContaining(["guard reasons", "guard step"]));
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });
});
