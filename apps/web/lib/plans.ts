/**
 * Preset sheets bundled with the app (server-only: imported by server
 * components, route handlers and lib/server).
 *
 * Source of truth: the sheets the orchestrator itself produces on the
 * synthetic fixture world (fixtures/synthetic/engine/<id>.sheet.json, written
 * by `npx tsx packages/orchestrator/scripts/generate-fixture-sheets.ts`).
 * The hand-built sheets (fixtures/synthetic/<id>.sheet.json) are the fallback:
 * a generated sheet that fails validation is replaced by its hand-built twin,
 * with a warning. A hand-built sheet that fails validation fails the build.
 */
import g1aHand from "../../../fixtures/synthetic/g1-a.sheet.json";
import g1bHand from "../../../fixtures/synthetic/g1-b.sheet.json";
import g2Hand from "../../../fixtures/synthetic/g2.sheet.json";
import g3Hand from "../../../fixtures/synthetic/g3.sheet.json";
import g1aEngine from "../../../fixtures/synthetic/engine/g1-a.sheet.json";
import g1bEngine from "../../../fixtures/synthetic/engine/g1-b.sheet.json";
import g2Engine from "../../../fixtures/synthetic/engine/g2.sheet.json";
import g3Engine from "../../../fixtures/synthetic/engine/g3.sheet.json";
import type { FixtureSource, SheetFixture } from "./fixture-types";
import { assertFixture, validateFixture } from "./validate";

export interface PresetFixture extends SheetFixture {
  source: FixtureSource;
}

export const PRESET_PLAN_IDS = ["g1-a", "g1-b", "g2", "g3"] as const;
export type PresetPlanId = (typeof PRESET_PLAN_IDS)[number];

/**
 * Presets with a live show and no bundled sample sheet (the fixture world has no copy of their room): served from
 * a stored live run, or not at all.
 */
export const LIVE_ONLY_PRESET_IDS = ["g4-a", "g4-b"] as const;

/** Every preset id, bundled or live-only, in the order the landing lists them. */
export const ALL_PRESET_IDS: readonly string[] = ["g1-a", "g1-b", ...LIVE_ONLY_PRESET_IDS, "g2", "g3"];

export function isLiveOnlyPresetId(id: string): boolean {
  return (LIVE_ONLY_PRESET_IDS as readonly string[]).includes(id);
}

const HAND: Record<PresetPlanId, unknown> = { "g1-a": g1aHand, "g1-b": g1bHand, g2: g2Hand, g3: g3Hand };
const ENGINE: Record<PresetPlanId, unknown> = { "g1-a": g1aEngine, "g1-b": g1bEngine, g2: g2Engine, g3: g3Engine };

/** Picks the generated sheet when it validates and is for this plan id, else the hand-built one. */
export function choosePreset(id: string, engine: unknown, hand: unknown): PresetFixture {
  const errors = validateFixture(engine);
  const sheetId = (engine as { sheet?: { planId?: unknown } } | null)?.sheet?.planId;
  if (errors.length === 0 && sheetId === id) return { ...(engine as SheetFixture), source: "engine" };
  console.warn(`walkup: generated fixture ${id} is not usable (${errors[0] ?? `plan id ${String(sheetId)}`}); serving the hand-built sheet.`);
  return { ...assertFixture(hand, `${id}.sheet.json`), source: "hand-built" };
}

const FIXTURES: PresetFixture[] = PRESET_PLAN_IDS.map((id) => choosePreset(id, ENGINE[id], HAND[id]));
const BY_ID = new Map(FIXTURES.map((f) => [f.sheet.planId, f]));

export const PLAN_IDS: string[] = FIXTURES.map((f) => f.sheet.planId);

export function isPresetId(id: string): id is PresetPlanId {
  return (PRESET_PLAN_IDS as readonly string[]).includes(id);
}

/** The bundled sheet for a preset id (no store lookup, no enrichment). */
export function getPlan(id: string): PresetFixture | null {
  return BY_ID.get(id) ?? null;
}

export function listPlans(): PresetFixture[] {
  return FIXTURES;
}

/** The hand-built fallback, always (tests and comparisons). */
export function handBuiltPlan(id: string): SheetFixture | null {
  return isPresetId(id) ? assertFixture(HAND[id], `${id}.sheet.json`) : null;
}
