/**
 * Test helpers: fixture-world deps with a fixed clock and counter ids, and a
 * preset runner that answers the needs_input pause the way an operator would
 * (picking the comedian among the candidates). Nothing reaches the network.
 */
import type { QlooEntity, StreetSheet } from "@walkup/contracts";
import { createFixtureDeps, planShow, type FixtureDeps, type FixtureDepsOptions, type PlanOptions, type PlanResult } from "../src/index";

export const CLOCK_MS = Date.parse("2026-10-30T15:00:00Z");

export function counterIds(prefix = "plan"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

export function deps(o: FixtureDepsOptions = {}): FixtureDeps {
  return createFixtureDeps({ clock: () => CLOCK_MS, idGen: counterIds(), ...o });
}

/** Runs a preset; a needs_input pause is resumed with the person candidate tagged comedian. */
export async function runPreset(id: string, d: FixtureDeps, opts: PlanOptions = {}): Promise<{ first: PlanResult; final: PlanResult }> {
  const first = await planShow({ presetId: id }, d, opts);
  if (first.status !== "needs_input" || !first.pause) return { first, final: first };
  const resolutions: Record<string, string> = {};
  for (const p of first.pause.pending) {
    const pick = p.candidates.find((c) => c.subtype === "urn:entity:person") ?? p.candidates[0];
    if (pick) resolutions[p.input] = pick.entityId;
  }
  const final = await planShow({ presetId: id, resolutions, planId: first.planId }, d, opts);
  return { first, final };
}

/** Every QlooEntity anywhere in a value (deep). */
export function allEntities(v: unknown, out: QlooEntity[] = []): QlooEntity[] {
  if (Array.isArray(v)) {
    for (const x of v) allEntities(x, out);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.entityId === "string" && typeof o.subtype === "string" && Array.isArray(o.tags)) out.push(o as unknown as QlooEntity);
    for (const x of Object.values(o)) allEntities(x, out);
  }
  return out;
}

/** Ledger refs cited anywhere in the cards (chips, provenance, resolution rows). */
export function citedRefs(sheet: StreetSheet): string[] {
  const refs: string[] = [];
  for (const card of Object.values(sheet.cards)) {
    refs.push(...card.provenance);
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        if (typeof o.ledgerRef === "string") refs.push(o.ledgerRef);
        Object.values(o).forEach(walk);
      }
    };
    walk(card.results);
  }
  if (sheet.control) refs.push(...sheet.control.ledgerRefs);
  return refs;
}

export function sheetOf(r: PlanResult): StreetSheet {
  if (!r.sheet) throw new Error(`no sheet: ${r.status} ${r.error ?? ""}`);
  return r.sheet;
}
