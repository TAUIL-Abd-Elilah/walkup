/**
 * One shape for "what a plan id shows": a sheet, a pause waiting for picks, or
 * an error. Stored plans, fresh orchestrator results and a host's own preset
 * loader (the web app's bundled preset sheets) all map onto it.
 */
import type { StreetSheet } from "@walkup/contracts";
import type { PlanResult, StoredPlan } from "@walkup/orchestrator";
import { errorEnvelope, pausedEnvelope, sheetEnvelope, type PauseLike, type PlanMode, type ToolEnvelope } from "./envelope";

export type PlanView =
  | { kind: "sheet"; sheet: StreetSheet; presetId?: string }
  | { kind: "paused"; planId: string; mode: PlanMode; pause: PauseLike; presetId?: string }
  | { kind: "error"; planId: string | null; mode: PlanMode; reason: string };

export function viewOfStored(stored: StoredPlan): PlanView {
  const preset = stored.presetId ? { presetId: stored.presetId } : {};
  if (stored.status === "complete" && stored.sheet) return { kind: "sheet", sheet: stored.sheet, ...preset };
  if (stored.pause) return { kind: "paused", planId: stored.planId, mode: stored.mode, pause: stored.pause, ...preset };
  return { kind: "error", planId: stored.planId, mode: stored.mode, reason: `Plan ${stored.planId} has no sheet.` };
}

export function viewOfResult(r: PlanResult): PlanView {
  const preset = r.presetId ? { presetId: r.presetId } : {};
  if (r.status === "complete" && r.sheet) return { kind: "sheet", sheet: r.sheet, ...preset };
  if (r.status === "needs_input" && r.pause) return { kind: "paused", planId: r.planId, mode: r.mode, pause: r.pause, ...preset };
  return { kind: "error", planId: r.planId, mode: r.mode, reason: r.error ?? "The plan could not be built." };
}

export function envelopeOfView(v: PlanView, origin: string | null): ToolEnvelope {
  switch (v.kind) {
    case "sheet":
      return sheetEnvelope(v.sheet, origin);
    case "paused":
      return pausedEnvelope(v.planId, v.pause, v.mode, origin);
    case "error":
      return errorEnvelope(v.reason, v.mode, { planId: v.planId });
  }
}
