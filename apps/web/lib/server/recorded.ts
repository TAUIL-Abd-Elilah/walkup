/**
 * Recorded state (live runs are paused; lib/mode.ts decides when): which
 * stored live run stands for each preset, the check a recording must pass to be
 * served, and whether the plan store holds any live sheet at all. Server-only.
 */
import type { StreetSheet } from "@walkup/contracts";
import { presetById, presetShowOf, type StoredPlan } from "@walkup/orchestrator";
import { stores, type Stores } from "./engine";
import { qlooRefusedKey } from "./key-status";
import { isCanonicalRequest, type WebPlanRequest } from "./runs";

/** Complete live runs of a preset read, newest first, to find one worth serving. */
export const RECORDED_LOOKBACK = 10;

/**
 * A stored live sheet good enough to stand for its preset while live runs are paused. It fails when Qloo refused the key
 * on it (the rule that switches the server off live mode, key-status.ts qlooRefusedKey), or when at least half
 * of its cards are errors.
 */
export function usableRecording(sheet: StreetSheet): boolean {
  if (qlooRefusedKey(sheet.ledger)) return false;
  const cards = Object.values(sheet.cards);
  return cards.filter((c) => c.status === "error").length * 2 < cards.length;
}

/**
 * The recording a preset shows in recorded state: the latest live run of the preset's current live show made with
 * the preset's own inputs (the run live mode serves) that passes usableRecording. Null leaves the bundled sample
 * sheet in place.
 */
export async function recordedPresetRun(id: string): Promise<StoredPlan | null> {
  const preset = presetById(id);
  if (!preset) return null;
  const runs = await stores().plans.listComplete({ presetId: id, mode: "live" }, RECORDED_LOOKBACK);
  return (
    runs.find(
      (s) =>
        s.sheet &&
        isCanonicalRequest(s.request as WebPlanRequest) &&
        presetShowOf(preset, "live", s.sheet.bill) !== null &&
        usableRecording(s.sheet),
    ) ?? null
  );
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

let dayMemo: { stores: Stores; value: string | null } | null = null;

/**
 * The UTC day ("2026-10-21") of the newest complete live sheet in the plan store: the day the recorded sheets
 * were made. Null when none is stored, or while an asynchronous store has not answered yet.
 */
export function recordedOnDay(): string | null {
  let st: Stores;
  try {
    st = stores();
  } catch {
    return null;
  }
  if (dayMemo?.stores === st && dayMemo.value !== null) return dayMemo.value;
  const pick = (runs: StoredPlan[]) => runs.map((r) => (r.sheet?.createdAt ?? r.createdAt ?? "").slice(0, 10)).filter(Boolean).sort().pop() ?? null;
  const found = st.plans.listComplete({ mode: "live" }, 50);
  if (found instanceof Promise) {
    void found.then((runs) => (dayMemo = { stores: st, value: pick(runs) }), () => undefined);
    return null;
  }
  dayMemo = { stores: st, value: pick(found) };
  return dayMemo.value;
}

/** Complete plans read to find the revisions of one plan. */
export const REVISION_LOOKBACK = 200;

/** A stored revision of a plan, for the "Revised: All ages, no bars" link. */
export interface PlanRevisionLink {
  planId: string;
  /** The change note as the operator typed it. */
  instruction: string;
  createdAt: string;
}

/**
 * The stored complete revisions of `planId` (sheets whose revision.parentPlanId is it), newest first, one per note.
 * Found through the plan store, never from a list of ids, so any revision recorded or made on this server shows.
 * A live parent lists live revisions only, so a recording never links to a sample.
 */
export async function revisionsOf(planId: string, mode?: "live" | "fixture"): Promise<PlanRevisionLink[]> {
  let st: Stores;
  try {
    st = stores();
  } catch {
    return [];
  }
  let runs: StoredPlan[];
  try {
    runs = await st.plans.listComplete(mode ? { mode } : {}, REVISION_LOOKBACK);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: PlanRevisionLink[] = [];
  for (const r of runs) {
    const rev = r.sheet?.revision;
    if (!r.sheet || rev?.parentPlanId !== planId || r.sheet.planId === planId) continue;
    const instruction = (rev.instruction ?? "").trim();
    const key = instruction.toLowerCase().replace(/\s+/g, " ");
    if (instruction === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({ planId: r.sheet.planId, instruction, createdAt: r.sheet.createdAt });
  }
  return out;
}
