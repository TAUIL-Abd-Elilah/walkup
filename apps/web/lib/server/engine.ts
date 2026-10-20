/**
 * The server's plan engine: @walkup/orchestrator deps for the current
 * mode, plan storage and the operator's cached picks. Server-only (it loads
 * @walkup/qloo, which loads better-sqlite3). Never import it from a
 * client component.
 *
 * - Fixture mode: createFixtureDeps() on one @walkup/qloo-world per
 *   process. Presets run end to end for free; the narrator uses its labelled
 *   template (no model call on synthetic data).
 * - Live mode: createDepsFromEnv() (Qloo, Ticketmaster, Places, Census, Claude).
 *
 * Singletons live on globalThis so every route bundle shares one engine.
 */
import { join } from "node:path";
import {
  createDepsFromEnv,
  createFixtureDeps,
  createMemoryChoiceStore,
  createMemoryPlanStore,
  type ChoiceStore,
  type FixtureDeps,
  type PlanDeps,
  type PlanStore,
} from "@walkup/orchestrator";
import { createSqliteStores } from "@walkup/orchestrator/sqlite";
import { createWorld, type World } from "@walkup/qloo-world";
import { dataDir, ensureGazetteerDir } from "./env";

export interface Stores {
  plans: PlanStore;
  choices: ChoiceStore;
  kind: "sqlite" | "memory";
  close?: () => void;
}

interface EngineState {
  stores: Stores | null;
  world: World | null;
  fixture: FixtureDeps | null;
  live: PlanDeps | null;
  /** Per-preset fixture deps with the sheet's own clock (enriching cached sheets). */
  enrich: Map<string, FixtureDeps>;
}

const KEY = "__walkupEngine";

function state(): EngineState {
  const g = globalThis as Record<string, unknown>;
  let s = g[KEY] as EngineState | undefined;
  if (!s) {
    s = { stores: null, world: null, fixture: null, live: null, enrich: new Map() };
    g[KEY] = s;
  }
  return s;
}

function openStores(): Stores {
  const choice = (process.env.WALKUP_PLAN_STORE ?? "").trim().toLowerCase();
  if (choice !== "memory") {
    try {
      const s = createSqliteStores(join(dataDir(), "plans.sqlite"));
      return { plans: s.plans, choices: s.choices, kind: "sqlite", close: () => s.close() };
    } catch (err) {
      console.warn(`walkup: SQLite plan store unavailable (${err instanceof Error ? err.message : String(err)}); using memory.`);
    }
  }
  return { plans: createMemoryPlanStore(), choices: createMemoryChoiceStore(), kind: "memory" };
}

export function stores(): Stores {
  const s = state();
  if (!s.stores) s.stores = openStores();
  return s.stores;
}

export function world(): World {
  const s = state();
  ensureGazetteerDir();
  if (!s.world) s.world = createWorld();
  return s.world;
}

/** Shared fixture deps (synthetic world, template narration). */
export function fixtureDeps(): FixtureDeps {
  const s = state();
  if (!s.fixture) {
    const st = stores();
    s.fixture = createFixtureDeps({ world: world(), store: st.plans, choices: st.choices, narratorClient: null });
  }
  return s.fixture;
}

/** Live deps from env. Only call when runtimeMode() is live. */
export function liveDeps(): PlanDeps {
  const s = state();
  if (!s.live) {
    ensureGazetteerDir();
    const st = stores();
    s.live = createDepsFromEnv(process.env, { store: st.plans, choices: st.choices });
  }
  return s.live;
}

export function depsFor(mode: "live" | "fixture"): PlanDeps {
  return mode === "live" ? liveDeps() : fixtureDeps();
}

/** Fixture deps whose clock is pinned (so ledger entries added to a cached sheet carry its date). */
export function pinnedFixtureDeps(key: string, at: number): FixtureDeps {
  const s = state();
  let d = s.enrich.get(key);
  if (!d) {
    d = createFixtureDeps({ world: world(), clock: () => at });
    s.enrich.set(key, d);
  }
  return d;
}

/** Operator picks scoped to one browser session; no session means nothing is remembered. */
export function sessionChoices(base: ChoiceStore, sessionId: string | null): ChoiceStore {
  if (!sessionId) return { get: () => null, set: () => {} };
  const k = (q: string) => `${sessionId}\u0001${q}`;
  return {
    get: (query, types, now) => base.get(k(query), types, now),
    set: (query, types, entityId, now) => base.set(k(query), types, entityId, now),
  };
}

/** Latest Qloo month quota seen by a live run (the header note reads it through runtimeMode). */
export interface QuotaSlot {
  remaining: number | null;
  limit: number | null;
}
const QUOTA_KEY = "__walkupQlooQuota";

export function lastQuota(): QuotaSlot | null {
  const v = (globalThis as Record<string, unknown>)[QUOTA_KEY];
  return v && typeof v === "object" ? (v as QuotaSlot) : null;
}

/** After a live run: remember the month quota for the pill and /healthz. */
export function publishLiveQuota(deps: PlanDeps): void {
  try {
    const q = deps.qloo.quota();
    (globalThis as Record<string, unknown>)[QUOTA_KEY] = { remaining: q.remaining, limit: q.limit } satisfies QuotaSlot;
  } catch {
    // The quota is informational.
  }
}

/** Tests: replace or reset the engine. */
export function setEngineForTests(over: Partial<Pick<EngineState, "stores" | "fixture" | "live" | "world">>): void {
  const s = state();
  Object.assign(s, over);
}

export function resetEngineForTests(): void {
  const s = state();
  s.stores?.close?.();
  s.stores = null;
  s.fixture = null;
  s.live = null;
  s.enrich.clear();
}
