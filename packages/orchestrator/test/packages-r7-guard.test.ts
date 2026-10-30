/**
 * Round 7, orchestrator: when the recheck drops a partner whose name says restaurant, the guard notes the Checks list
 * prints keep their counts true: an area line's "the sheet has N in this area" and "N partner lines trimmed".
 * Synthetic data.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { recheckSheet } from "../src/index";
import { deps, runPreset, sheetOf } from "./helpers";

let g1a: StreetSheet;

beforeAll(async () => {
  g1a = sheetOf((await runPreset("g1-a", deps())).final);
});

/** g1-a with restaurants left out, one area partner renamed "... Restaurant & Bar", and the given guard reasons. */
function withNotes(reasons: (s: { tile: number; have: number; lines: number }) => string[]): StreetSheet {
  const sheet = structuredClone(g1a);
  sheet.operator = { ...sheet.operator, excludeCategories: ["restaurant"] };
  const tiles = sheet.narration!.tileWhy.map((t) => t.geohash);
  const i = sheet.cards.partners.results.findIndex(
    (p) => p.tileGeohash && tiles.includes(p.tileGeohash) && p.entity.entityId !== sheet.discovery?.entityId && sheet.narration!.partnerLines.some((l) => l.entityId === p.entity.entityId),
  );
  const p = sheet.cards.partners.results[i]!;
  sheet.cards.partners.results[i] = { ...p, entity: { ...p.entity, name: "La Parra Restaurant & Bar" } };
  const tile = tiles.indexOf(p.tileGeohash!);
  const have = sheet.cards.partners.results.filter((x) => x.tileGeohash === p.tileGeohash).length;
  sheet.guard = { ...sheet.guard, reasons: reasons({ tile, have, lines: sheet.narration!.partnerLines.length }) };
  return sheet;
}

describe("guard note counts after a partner is dropped by name", () => {
  it("an area line's count and an all-lines trim count follow the list, once", () => {
    let before = { tile: 0, have: 0, lines: 0 };
    const s = withNotes((x) => {
      before = x;
      return [
        `replaced by the template: tileWhy[${x.tile}]: says twelve partners, the sheet has ${x.have} in this area`,
        `${x.lines} partner lines trimmed: a tag the place doesn't list as shared was cut.`,
      ];
    });
    const { sheet, report } = recheckSheet(s);
    expect(report.droppedPartners).toHaveLength(1);
    expect(sheet.guard.reasons).toContain(`replaced by the template: tileWhy[${before.tile}]: says twelve partners, the sheet has ${before.have - 1} in this area`);
    expect(sheet.guard.reasons).toContain(`${before.lines - 1} partner lines trimmed: a tag the place doesn't list as shared was cut.`);
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("a partial trim count is capped at the lines left, and other areas' notes stay", () => {
    const s = withNotes((x) => [
      `replaced by the template: tileWhy[${(x.tile + 1) % 5}]: says twelve partners, the sheet has 3 in this area`,
      `${x.lines - 1} partner lines trimmed: a tag the place doesn't list as shared was cut.`,
    ]);
    const lines = s.narration!.partnerLines.length;
    const { sheet } = recheckSheet(s);
    expect(sheet.guard.reasons[0]).toBe(s.guard.reasons[0]);
    expect(sheet.guard.reasons[1]).toBe(`${lines - 1} partner lines trimmed: a tag the place doesn't list as shared was cut.`);
  });

  it("counts only Claude's lines: every one trimmed, with one line the template replaced", () => {
    const s = withNotes((x) => [
      `replaced by the template: partnerLines[0]: "house" instead of the room's usual crowd`,
      `${x.lines - 1} partner lines trimmed: a tag the place doesn't list as shared was cut.`,
    ]);
    const lines = s.narration!.partnerLines.length;
    const { sheet } = recheckSheet(s);
    expect(sheet.guard.reasons[1]).toBe(`${lines - 2} partner lines trimmed: a tag the place doesn't list as shared was cut.`);
  });
});
