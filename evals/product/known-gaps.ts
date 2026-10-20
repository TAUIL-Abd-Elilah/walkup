/**
 * Product gaps this eval found and reported, still open. A failing check
 * listed here stays a failure in score.json (the case is "failed"), but it is
 * marked as known so CI can tell a known gap from a regression. The vitest
 * wrapper also fails when a listed gap no longer reproduces, so this list is
 * kept current: delete the entry when the owner fixes it.
 */
import type { CheckResult } from "./checks";

export interface KnownGap {
  /** Cases where the gap reproduces on the fixture world (the same check elsewhere is a regression). */
  cases: readonly string[];
  /** Exact check name. */
  check: string;
  /** Package and file that would carry the fix. */
  owner: string;
  note: string;
}

/**
 * Empty today. The one gap this eval reported (C11, C12: pre/post spots without hours for show night were
 * presented as open) was fixed in packages/orchestrator src/steps/prepost.ts: those spots now carry the chip
 * "near the room, no hours listed for show night: call ahead" and the card counts them.
 */
export const KNOWN_GAPS: readonly KnownGap[] = [];

export function knownGapFor(caseId: string, check: CheckResult): KnownGap | undefined {
  if (check.status !== "fail") return undefined;
  return KNOWN_GAPS.find((g) => g.cases.includes(caseId) && g.check === check.name);
}
