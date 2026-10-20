/**
 * Recorded state (Qloo is no longer available; lib/mode.ts decides when): which
 * stored live run stands for each preset, the check a recording must pass to be
 * served, and whether the plan store holds any live sheet at all. Server-only.
 */
import type { LedgerEntry, StreetSheet } from "@walkup/contracts";
import type { StoredPlan } from "@walkup/orchestrator";
import { stores, type Stores } from "./engine";
import { isCanonicalRequest, type WebPlanRequest } from "./runs";

/** Complete live runs of a preset read, newest first, to find one worth serving. */
export const RECORDED_LOOKBACK = 10;

function accepted(e: LedgerEntry): boolean {
  return e.httpStatus !== null && ((e.httpStatus >= 200 && e.httpStatus < 300) || e.httpStatus === 404);
}

/**
 * A stored live sheet good enough to stand for its preset once Qloo is gone. It fails when Qloo refused the key
 * on it (any 401; a 403 when no Qloo call on the sheet was answered, since Qloo also answers 403 for one filter
 * the key may not use), or when at least half of its cards are errors.
 */
export function usableRecording(sheet: StreetSheet): boolean {
  const qloo = sheet.ledger.filter((e) => e.kind === "qloo");
  if (qloo.some((e) => e.httpStatus === 401)) return false;
  if (qloo.some((e) => e.httpStatus === 403) && !qloo.some(accepted)) return false;
  const cards = Object.values(sheet.cards);
  return cards.filter((c) => c.status === "error").length * 2 < cards.length;
}

/**
 * The recording a preset shows in recorded state: the latest live run made with the preset's own inputs (the
 * run live mode serves) that passes usableRecording. Null leaves the bundled sample sheet in place.
 */
export async function recordedPresetRun(id: string): Promise<StoredPlan | null> {
  const runs = await stores().plans.listComplete({ presetId: id, mode: "live" }, RECORDED_LOOKBACK);
  return runs.find((s) => s.sheet && isCanonicalRequest(s.request as WebPlanRequest) && usableRecording(s.sheet)) ?? null;
}

/**
 * Read once per rejection and plan store: it is asked only after Qloo rejected the key, and no live sheet can be
 * added while the server is not live. A store that answers asynchronously counts as empty until it has answered.
 */
let memo: { stores: Stores; rejectedAt: string; value: boolean } | null = null;

/**
 * True when the plan store holds at least one complete live sheet: the rejected-key rule in runtimeMode.
 * `rejectedAt` is the time of the rejection being asked about.
 */
export function liveSheetStored(rejectedAt: string): boolean {
  let st: Stores;
  try {
    st = stores();
  } catch {
    return false;
  }
  if (memo?.stores === st && memo.rejectedAt === rejectedAt) return memo.value;
  const found = st.plans.listComplete({ mode: "live" }, 1);
  if (found instanceof Promise) {
    void found.then((runs) => (memo = { stores: st, rejectedAt, value: runs.length > 0 }), () => undefined);
    return false;
  }
  memo = { stores: st, rejectedAt, value: found.length > 0 };
  return memo.value;
}
