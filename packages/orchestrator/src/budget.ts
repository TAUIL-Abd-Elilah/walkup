/**
 * Call budget of one run, read back from its ledger: Qloo calls sent (not
 * served from cache), split into bill-specific and venue-baseline nodes.
 * The spec's budget is about 14-18 Qloo calls per fresh run when the venue
 * baseline is cached, plus 4-6 on a cold venue.
 */
import type { LedgerEntry } from "@walkup/contracts";
import type { RunLedger } from "./ledger";
import type { CallBudget } from "./types";

export const BUDGET_TARGET = { billLevel: { min: 12, max: 18 }, coldVenueExtra: { min: 4, max: 6 } } as const;

export function callBudget(entries: readonly LedgerEntry[], ledger: RunLedger): CallBudget {
  const b: CallBudget = { qlooFresh: 0, qlooCached: 0, qlooTotal: 0, billLevel: 0, venueLevel: 0, arms: 0, tm: 0, places: 0, anthropic: 0, byNode: {} };
  for (const e of entries) {
    if (e.kind === "tm") b.tm++;
    else if (e.kind === "places") b.places++;
    else if (e.kind === "anthropic") b.anthropic++;
    if (e.kind !== "qloo") continue;
    b.qlooTotal++;
    // A refused call (month guard) or a fixture miss sent nothing.
    const sent = !e.cacheHit && e.httpStatus !== null;
    if (!sent) {
      if (e.cacheHit) b.qlooCached++;
      continue;
    }
    b.qlooFresh++;
    const info = ledger.info(e.id);
    const label = info?.node ?? "unknown";
    b.byNode[label] = (b.byNode[label] ?? 0) + 1;
    if (info?.level === "venue") b.venueLevel++;
    else if (info?.level === "arm") b.arms++;
    else b.billLevel++;
  }
  return b;
}
