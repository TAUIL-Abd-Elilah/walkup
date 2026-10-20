/**
 * Plan storage and the operator's cached picks. The interfaces are small so a
 * server can back them with SQLite (store-sqlite.ts, server code only) and
 * tests with memory.
 */
import type { StreetSheet } from "@walkup/contracts";
import type { CallBudget, PausedPlan, PlanRequest } from "./types";

export interface StoredPlan {
  planId: string;
  createdAt: string;
  mode: "live" | "fixture";
  status: "complete" | "needs_input";
  presetId?: string;
  request: PlanRequest;
  sheet?: StreetSheet;
  pause?: PausedPlan;
  budget?: CallBudget;
  citations?: Record<string, string>;
}

export interface PlanStore {
  put(plan: StoredPlan): void | Promise<void>;
  get(planId: string): StoredPlan | null | Promise<StoredPlan | null>;
  /** Most recent complete plan for a preset (quota-guard fallback). */
  latestForPreset(presetId: string): StoredPlan | null | Promise<StoredPlan | null>;
  list(limit?: number): StoredPlan[] | Promise<StoredPlan[]>;
  /**
   * Complete plans, newest first, at most `limit`, narrowed to one preset and/or one mode (the web
   * app's recorded state reads its live runs this way).
   */
  listComplete(filter: CompleteFilter, limit: number): StoredPlan[] | Promise<StoredPlan[]>;
}

export interface CompleteFilter {
  presetId?: string;
  mode?: StoredPlan["mode"];
}

export function createMemoryPlanStore(): PlanStore {
  const plans = new Map<string, StoredPlan>();
  const clone = (p: StoredPlan): StoredPlan => JSON.parse(JSON.stringify(p)) as StoredPlan;
  return {
    put(plan) {
      plans.set(plan.planId, clone(plan));
    },
    get(planId) {
      const p = plans.get(planId);
      return p ? clone(p) : null;
    },
    latestForPreset(presetId) {
      const hits = [...plans.values()]
        .filter((p) => p.presetId === presetId && p.status === "complete")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return hits[0] ? clone(hits[0]) : null;
    },
    list(limit = 50) {
      return [...plans.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },
    listComplete(filter, limit) {
      return [...plans.values()]
        .filter((p) => p.status === "complete" && (filter.presetId === undefined || p.presetId === filter.presetId) && (filter.mode === undefined || p.mode === filter.mode))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, limit)
        .map(clone);
    },
  };
}

export const CHOICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Operator picks for ambiguous names, cached per (query, types) for 30 days. */
export interface ChoiceStore {
  get(query: string, types: readonly string[], now: number): string | null | Promise<string | null>;
  set(query: string, types: readonly string[], entityId: string, now: number): void | Promise<void>;
  /** Forgets a pick (one Qloo turned out to have no taste data for). Optional for older stores. */
  delete?(query: string, types: readonly string[]): void | Promise<void>;
}

export function choiceKey(query: string, types: readonly string[]): string {
  return `${query.trim().toLowerCase()}|${[...types].sort().join(",")}`;
}

export function createMemoryChoiceStore(): ChoiceStore {
  const rows = new Map<string, { entityId: string; at: number }>();
  return {
    get(query, types, now) {
      const r = rows.get(choiceKey(query, types));
      return r && now - r.at < CHOICE_TTL_MS ? r.entityId : null;
    },
    set(query, types, entityId, now) {
      rows.set(choiceKey(query, types), { entityId, at: now });
    },
    delete(query, types) {
      rows.delete(choiceKey(query, types));
    },
  };
}

/** Reads one stored plan. */
export async function getPlan(store: PlanStore, planId: string): Promise<StoredPlan | null> {
  return (await store.get(planId)) ?? null;
}
