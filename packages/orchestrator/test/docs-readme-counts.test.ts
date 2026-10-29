/**
 * The README's revise call counts on the fixture world (packages/orchestrator/README.md, "Re-run"): each note's
 * fresh Qloo calls, and what a radius change re-sends, match a real revise run.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parentRequest, planShow, revisePlan, type PlanResult } from "../src/index";
import { deps, sheetOf } from "./helpers";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

async function revise(presetId: string, note: string): Promise<PlanResult> {
  const d = deps();
  const parent = sheetOf(await planShow({ presetId }, d));
  const r = await revisePlan({ sheet: parent, request: parentRequest(parent, { presetId })! }, note, d);
  if (r.status === "question") throw new Error(`question: ${r.revision.question}`);
  return r.result;
}

describe("orchestrator README: revise call counts", { timeout: 120_000 }, () => {
  it("a radius change re-sends the heatmaps, the partner searches and the 2 pick-list searches (20 on G1-A)", async () => {
    const b = (await revise("g1-a", "within 10 km")).budget;
    expect(b.qlooFresh).toBe(20);
    expect(b.byNode["Q11 declared pick list"]).toBe(2);
    const partners = Object.entries(b.byNode).filter(([n]) => n.startsWith("Q9 ")).reduce((s, [, n]) => s + n, 0);
    // The rest are the heatmaps: the bill's, the room's usual crowd's, the generic one and the split-half maps.
    expect(20 - partners - 2).toBe(8);
    expect(README).toContain('the partner searches and the 2 pick-list searches for your declared partners ("within 10 km" on G1-A: 20)');
  });

  it("the other three notes: 0, 10 and 3 fresh calls, none venue-level", async () => {
    const parent = sheetOf(await planShow({ presetId: "g1-a" }, deps()));
    const area = parent.cards.partners.results[0]!.tileName;
    expect(area).toBeTruthy();
    const none = (await revise("g1-a", "no bars")).budget;
    const allAges = (await revise("g1-a", "All ages: no bars")).budget;
    const skip = (await revise("g1-a", `skip ${area}`)).budget;
    expect([none.qlooFresh, allAges.qlooFresh, skip.qlooFresh]).toEqual([0, 10, 3]);
    expect([none.venueLevel, allAges.venueLevel, skip.venueLevel]).toEqual([0, 0, 0]);
    expect(README).toContain('"no bars" sends 0 Qloo calls; "All ages: no bars" on G1-A (a 21+ bill) sends 10');
    expect(README).toContain('"skip <area>" sends the 3 calls for the one pool that moved');
    expect(README).toContain("Venue-level calls stay cached in the other three.");
  });
});
