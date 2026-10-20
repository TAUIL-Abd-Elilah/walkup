/**
 * The plan request a revision re-runs: the parent's own request with the
 * operator overrides merged in.
 *
 * A preset is re-run by its event (the preset's event, date, inputs and seed
 * plan), never in the preset's slot, so a revised sheet is never stored or
 * served as the preset itself. Names the parent run paused on keep the pick
 * the parent used, so the revision does not stop to ask again.
 */
import type { OperatorInputs, StreetSheet } from "@walkup/contracts";
import { presetById } from "../presets";
import type { PlanRequest } from "../types";

/** The picks behind the parent's pause steps: act name -> the entity the sheet resolved it to. */
export function pausePicks(sheet: StreetSheet): Record<string, string> {
  const out: Record<string, string> = {};
  const pauses = (sheet.steps ?? []).filter((s) => s.kind === "pause");
  if (pauses.length === 0) return out;
  // Longest names first, so "Sidecar Trio" wins over "Sidecar" in the same sentence.
  const acts = [...sheet.bill.acts].sort((a, b) => b.name.length - a.name.length);
  for (const step of pauses) {
    const act = acts.find((a) => step.decision.includes(a.name));
    if (!act) continue;
    const row = sheet.cards.resolution.results.find((r) => r.input === act.name && r.entity);
    if (row?.entity) out[act.name] = row.entity.entityId;
  }
  return out;
}

function withoutPlanId(r: PlanRequest): PlanRequest {
  const { planId: _drop, ...rest } = r;
  return rest;
}

function presetRequest(presetId: string, resolutions: Record<string, string> | undefined): PlanRequest | null {
  const preset = presetById(presetId);
  if (!preset) return null;
  return {
    tmEventId: preset.tmEventId,
    asOf: preset.asOf,
    operator: { ...preset.operator },
    ...(preset.seeds ? { seeds: preset.seeds } : {}),
    ...(preset.categories ? { categories: preset.categories } : {}),
    ...(preset.pairedWith ? { pairedPlanId: preset.pairedWith } : {}),
    ...(resolutions && Object.keys(resolutions).length > 0 ? { resolutions } : {}),
  };
}

export interface ParentRequestInput {
  /** The request the parent was run with (from the plan store), when known. */
  stored?: PlanRequest | null;
  /** The preset the parent sheet stands for (a bundled preset sheet). */
  presetId?: string | null;
}

/**
 * The parent's request, or null when it cannot be rebuilt. Order: the stored
 * request (a preset request becomes its event request), then the preset, then
 * the sheet's own bill and operator inputs.
 */
export function parentRequest(sheet: StreetSheet, from: ParentRequestInput = {}): PlanRequest | null {
  const stored = from.stored ? withoutPlanId(from.stored) : null;
  if (stored) {
    if (typeof stored.presetId === "string") {
      const { presetId, ...rest } = stored;
      const base = presetRequest(presetId, { ...pausePicks(sheet), ...(rest.resolutions ?? {}) });
      if (!base) return null;
      return { ...base, ...rest, operator: { ...base.operator, ...rest.operator }, ...(base.resolutions ? { resolutions: base.resolutions } : {}) };
    }
    return stored;
  }
  if (from.presetId) return presetRequest(from.presetId, pausePicks(sheet));
  return { bill: sheet.bill, operator: { ...sheet.operator }, asOf: sheet.createdAt.slice(0, 10) };
}

/** The parent request with the revision's operator overrides on top. */
export function revisedRequest(parent: PlanRequest, overrides: Partial<OperatorInputs>, planId: string): PlanRequest {
  return { ...parent, planId, operator: { ...parent.operator, ...overrides } };
}
