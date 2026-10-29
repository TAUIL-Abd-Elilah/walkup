/**
 * Second re-audit (Oct 29), integration: the chain limit names every signal `chainSignals` reads (a shared website
 * at 3 or more places too), on new runs and, through the recheck, on stored sheets.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { recheckSheet } from "../src/index";
import { CHAIN_DETECT_LIMIT, CHAIN_DETECT_LIMIT_BEFORE } from "../src/steps/partners";
import { deps, runPreset, sheetOf } from "./helpers";

let g1a: StreetSheet;

beforeAll(async () => {
  g1a = sheetOf((await runPreset("g1-a", deps())).final);
});

describe("the chain limit", () => {
  it("names the shared-website signal", () => {
    expect(CHAIN_DETECT_LIMIT).toContain("or the same name or website at 3 or more places;");
    expect(CHAIN_DETECT_LIMIT_BEFORE).not.toContain("name or website");
  });

  it("is rewritten on a stored sheet's partner and spot cards, once, and nothing else moves", () => {
    const s = structuredClone(g1a);
    s.cards.partners.limits = [...s.cards.partners.limits.filter((l) => l !== CHAIN_DETECT_LIMIT), CHAIN_DETECT_LIMIT_BEFORE];
    s.cards.prePost.limits = [CHAIN_DETECT_LIMIT_BEFORE, ...s.cards.prePost.limits.filter((l) => l !== CHAIN_DETECT_LIMIT)];
    const { sheet, report } = recheckSheet(s);
    expect(sheet.cards.partners.limits.at(-1)).toBe(CHAIN_DETECT_LIMIT);
    expect(sheet.cards.prePost.limits[0]).toBe(CHAIN_DETECT_LIMIT);
    expect(JSON.stringify(sheet)).not.toContain(CHAIN_DETECT_LIMIT_BEFORE);
    expect(report.rewritten).toEqual(expect.arrayContaining(["partners chain limit", "prePost chain limit"]));
    // Running it again changes nothing.
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });
});
