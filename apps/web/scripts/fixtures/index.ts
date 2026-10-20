import type { SheetFixture } from "../../lib/fixture-types";
import { buildG1A, buildG1B } from "./g1";
import { buildG2 } from "./g2";
import { buildG3 } from "./g3";

/** File name (in fixtures/synthetic) -> fixture. Deterministic. */
export function buildAllFixtures(): Record<string, SheetFixture> {
  return {
    "g1-a.sheet.json": buildG1A(),
    "g1-b.sheet.json": buildG1B(),
    "g2.sheet.json": buildG2(),
    "g3.sheet.json": buildG3(),
  };
}

export function serializeFixture(fx: SheetFixture): string {
  return `${JSON.stringify(fx, null, 2)}\n`;
}
