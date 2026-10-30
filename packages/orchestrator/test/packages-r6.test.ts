/**
 * Round 6, orchestrator: the age mix names the act a stand-in title speaks for and the acts with no data; a run with
 * no lift map stores the reworded "Where buyers live" line and no partner reason says "not in a top area"; the lift
 * card says what its count counts. The offline recheck makes the same text-only changes to a stored sheet: the lift
 * card's count, "national chains aside", Ticketmaster's genre as the header gives it, and a Summary step that counted
 * kept copy lines as written. Synthetic data.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { BUYERS_LIMIT, NO_LIFT_BUYERS_LIMIT, type Partner, type StreetSheet } from "@walkup/contracts";
import { CHAINS_ASIDE } from "@walkup/engine";
import { recheckSheet } from "../src/index";
import { deps, runPreset, sheetOf } from "./helpers";

let g1a: StreetSheet;
let g2: StreetSheet;
let g3: StreetSheet;

beforeAll(async () => {
  g1a = sheetOf((await runPreset("g1-a", deps())).final);
  g2 = sheetOf((await runPreset("g2", deps())).final);
  g3 = sheetOf((await runPreset("g3", deps())).final);
});

const LIFT_COUNT = /^\d+ areas pass both tests \(lift 1\.3 or more against the room's usual crowd, percentile 70 or higher for this crowd\)\. /;

describe("a run's own wording", () => {
  it("names the act a stand-in speaks for and the acts with no age data (G2)", () => {
    const demo = g2.cards.demographics;
    expect(g2.bill.acts).toHaveLength(3);
    expect(demo.summary).toBe("Age mix for 1 of the bill's 3 acts (Reggie Collier, through a stand-in title) and 11 of the room's usual acts.");
    expect(demo.reason).toBe("Qloo has no age data for Dorian Pike and Sidecar.");
  });

  it("says the lift card's count is the areas that pass both tests", () => {
    for (const s of [g1a, g2]) expect(s.cards.liftMap.summary).toMatch(LIFT_COUNT);
  });

  it("stores the reworded buyers line and says near the venue on a run with no lift map (G3)", () => {
    expect(g3.limits).toContain(NO_LIFT_BUYERS_LIMIT);
    expect(g3.limits).not.toContain(BUYERS_LIMIT);
    expect(g1a.limits).toContain(BUYERS_LIMIT);
    const why = g3.cards.partners.results.map((p) => p.explain?.confidenceWhy ?? "");
    expect(why.length).toBeGreaterThan(0);
    for (const w of why) {
      expect(w).toMatch(/ near the venue/);
      expect(w).not.toMatch(/top area/);
    }
  });
});

describe("recheckSheet: text-only rewrites", () => {
  it("says what the lift card's count counts, from the Lift map step's own tests, and is stable", () => {
    const s = structuredClone(g1a);
    const n = /^(\d+) areas/.exec(s.cards.liftMap.summary)![1];
    s.cards.liftMap.summary = s.cards.liftMap.summary.replace(LIFT_COUNT, `${n} areas where this bill's crowd ranks higher than the room's usual crowd. `);
    const { sheet, report } = recheckSheet(s);
    expect(sheet.cards.liftMap.summary).toBe(g1a.cards.liftMap.summary);
    expect(report.rewritten).toContain("lift card count");
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("says national chains aside when a chain in the pick's area ranks higher and would have qualified", () => {
    const s = structuredClone(g1a);
    const d = s.discovery!;
    expect(d.kind).toBe("partner");
    expect(d.why).not.toContain(CHAINS_ASIDE);
    const pick = s.cards.partners.results.find((p) => p.entity.entityId === d.entityId)!;
    const chain: Partner = {
      ...structuredClone(pick),
      entity: { ...pick.entity, entityId: "E-chain", name: "Smoothie Chain" },
      chain: true,
      qlooRank: Math.max(1, pick.qlooRank - 1),
      score: pick.score + 1,
      houseRank: pick.qlooRank + 30,
    };
    s.cards.partners.results.push(chain);
    const { sheet, report } = recheckSheet(s);
    expect(sheet.discovery?.why).toBe(d.why!.replace(/^(the highest-ranked place for this crowd in area 1)( that )/, `$1${CHAINS_ASIDE}$2`));
    expect(sheet.discovery?.entityId).toBe(d.entityId);
    expect(sheet.discovery?.headline).toBe(d.headline);
    expect(report.rewritten).toContain("discovery why");
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
    // Ranked about as high for the usual crowd: the chain would not have qualified, and the line stays.
    const near = structuredClone(s);
    near.cards.partners.results.find((p) => p.entity.entityId === "E-chain")!.houseRank = chain.qlooRank + 1;
    expect(recheckSheet(near).sheet.discovery?.why).toBe(d.why);
  });

  it("writes Ticketmaster's genre the way the header does in Claude's lines", () => {
    const s = structuredClone(g1a);
    s.bill.classification = "Music / R&B";
    s.narration = { ...s.narration!, templated: false, summary: `This Music / R&B show draws its own crowd. ${s.narration!.summary}` };
    const { sheet, report } = recheckSheet(s);
    expect(sheet.narration?.summary.startsWith("This R&B show draws its own crowd. ")).toBe(true);
    expect(report.rewritten).toContain("genre as the header gives it (1)");
  });

  it("stops a Summary step counting kept copy lines as written", () => {
    const s = structuredClone(g1a);
    s.narration = { ...s.narration!, templated: false };
    s.cards.copyHooks = { ...s.cards.copyHooks, status: "partial", results: s.cards.copyHooks.results.slice(0, 2), reason: "2 lines passed the checks." };
    s.steps = s.steps!.map((x) =>
      x.id === "narrate" ? { ...x, decision: "Claude wrote the summary and 2 fan copy lines from this run's results.", cause: "Only 2 copy lines passed the tag allowlist and the checks." } : x,
    );
    const { sheet, report } = recheckSheet(s);
    const step = sheet.steps!.find((x) => x.id === "narrate")!;
    expect(step.decision).toBe("Claude wrote the summary and fan copy lines from this run's results.");
    expect(step.cause).toBe("Only 2 copy lines passed the tag allowlist and the checks.");
    expect(report.rewritten).toContain("summary step copy count");
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });
});
