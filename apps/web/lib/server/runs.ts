/**
 * In-process run registry: one entry per plan run, so the SSE route can replay
 * the cards a run has emitted and follow it to the end. Finished runs are kept
 * for a while (the plan store keeps complete and paused plans for good).
 */
import type { Bill, Candidate, Envelope, Resolution, StreetSheet, TraceStep } from "@walkup/contracts";
import { CARD_ORDER, planShow, type CardKey, type PlanDeps, type PlanOptions, type PlanRequest, type PlanResult } from "@walkup/orchestrator";
import { noteQlooRejection } from "./key-status";
import { applyProxyPicks, type ProxyPicks } from "./proxy";
import { recordLedgerOutcomes } from "./health";

export interface StreamCard {
  key: CardKey;
  envelope: Envelope<unknown>;
}

export interface Pending {
  input: string;
  candidates: Candidate[];
}

export type RunStatus = "running" | "complete" | "needs_input" | "error";

export type RunEvent =
  | { type: "card"; index: number; card: StreamCard }
  | { type: "step"; index: number; step: TraceStep }
  | { type: "needs_input"; planId: string; pending: Pending[]; resolution: Envelope<Resolution[]>; bill: Bill }
  | { type: "done"; planId: string; status: Exclude<RunStatus, "running">; error?: string };

/** Extra fields the web keeps on a stored request (ignored by the orchestrator). */
export interface WebRequestExtras {
  /** Acts the operator answered with "None of these: use a proxy". */
  proxyPicks?: ProxyPicks;
  /**
   * The request carried the caller's own inputs (what-ifs, a partner list, or picks sent with
   * the request instead of chosen from the candidates a pause showed). Such a run belongs to
   * its caller: it is never served to other visitors as the preset.
   */
  customInputs?: boolean;
}

export type WebPlanRequest = PlanRequest & WebRequestExtras;

/**
 * True when a run of a preset may stand for the preset itself (served to every visitor):
 * the preset's own inputs, picks only from a pause's candidates, no proxy stand-in.
 */
export function isCanonicalRequest(r: WebPlanRequest | undefined): boolean {
  if (!r) return false;
  const operatorKeys = r.operator ? Object.keys(r.operator).length : 0;
  const proxies = r.proxyPicks ? Object.keys(r.proxyPicks).length : 0;
  return !r.customInputs && operatorKeys === 0 && proxies === 0;
}

export interface RunState {
  planId: string;
  status: RunStatus;
  mode: "live" | "fixture";
  presetId?: string;
  title: string;
  startedAt: number;
  finishedAt?: number;
  cards: StreamCard[];
  /** The step stream so far (sheet.steps as the run reaches each step). */
  steps: TraceStep[];
  pending?: Pending[];
  resolution?: Envelope<Resolution[]>;
  bill?: Bill;
  error?: string;
  result?: PlanResult;
  sheet?: StreetSheet;
  done: Promise<RunState>;
}

export interface StartRunInput {
  request: WebPlanRequest;
  deps: PlanDeps;
  mode: "live" | "fixture";
  title: string;
  /** Post-processing of a complete sheet (partner house ranks). */
  enrich?: (sheet: StreetSheet) => Promise<StreetSheet>;
  /** Called once with the finished run (counters, quota). */
  onFinish?: (run: RunState) => void;
  /**
   * What runs the plan; default planShow(request, deps, opts). The revise route passes the orchestrator's
   * runRevision here, so a revision streams, stores and enriches like any other run.
   */
  run?: (opts: PlanOptions) => Promise<PlanResult>;
}

interface Registry {
  runs: Map<string, RunState>;
  listeners: Map<string, Set<(e: RunEvent) => void>>;
}

const KEY = "__walkupRuns";
/** Finished runs stay replayable for this long. */
export const KEEP_FINISHED_MS = 15 * 60 * 1000;

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  let r = g[KEY] as Registry | undefined;
  if (!r) {
    r = { runs: new Map(), listeners: new Map() };
    g[KEY] = r;
  }
  return r;
}

function emit(planId: string, e: RunEvent): void {
  for (const fn of registry().listeners.get(planId) ?? []) {
    try {
      fn(e);
    } catch {
      // A closed stream never breaks the run.
    }
  }
}

export function getRun(planId: string): RunState | undefined {
  const r = registry().runs.get(planId);
  if (r && r.finishedAt && Date.now() - r.finishedAt > KEEP_FINISHED_MS) {
    registry().runs.delete(planId);
    return undefined;
  }
  return r;
}

export function isRunning(planId: string): boolean {
  return getRun(planId)?.status === "running";
}

/** Listen to a run's events; returns the unsubscribe function. */
export function subscribe(planId: string, fn: (e: RunEvent) => void): () => void {
  const l = registry().listeners;
  const set = l.get(planId) ?? new Set();
  set.add(fn);
  l.set(planId, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) l.delete(planId);
  };
}

function prune(): void {
  const now = Date.now();
  for (const [id, r] of registry().runs) if (r.finishedAt && now - r.finishedAt > KEEP_FINISHED_MS) registry().runs.delete(id);
}

/** Starts a run in the background and returns its live state at once. */
export function startRun(input: StartRunInput): RunState {
  prune();
  const planId = input.request.planId;
  if (!planId) throw new Error("startRun needs request.planId");
  const existing = getRun(planId);
  if (existing?.status === "running") return existing;

  let resolveDone!: (r: RunState) => void;
  const run: RunState = {
    planId,
    status: "running",
    mode: input.mode,
    title: input.title,
    startedAt: Date.now(),
    cards: [],
    steps: [],
    done: new Promise<RunState>((res) => {
      resolveDone = res;
    }),
    ...(typeof input.request.presetId === "string" ? { presetId: input.request.presetId } : {}),
  };
  registry().runs.set(planId, run);

  const finish = (status: Exclude<RunStatus, "running">, error?: string) => {
    run.status = status;
    run.finishedAt = Date.now();
    if (error) run.error = error;
    try {
      input.onFinish?.(run);
    } catch {
      // Counters are best effort.
    }
    emit(planId, { type: "done", planId, status, ...(error ? { error } : {}) });
    resolveDone(run);
  };

  void (async () => {
    try {
      const opts: PlanOptions = {
        arms: ["F"],
        onCard: (key, envelope) => {
          const card = { key, envelope };
          run.cards.push(card);
          emit(planId, { type: "card", index: run.cards.length - 1, card });
        },
        onStep: (step) => {
          run.steps.push(step);
          emit(planId, { type: "step", index: run.steps.length - 1, step });
        },
      };
      const result = input.run ? await input.run(opts) : await planShow(input.request, input.deps, opts);
      run.result = result;
      const ledger = result.sheet?.ledger ?? result.pause?.ledger ?? [];
      recordLedgerOutcomes(ledger);
      if (input.mode === "live") noteQlooRejection(ledger);
      if (result.status === "complete" && result.sheet) {
        let sheet = applyProxyPicks(result.sheet, input.request.proxyPicks);
        if (input.enrich) {
          try {
            sheet = await input.enrich(sheet);
          } catch {
            // The sheet stands without the extra chips.
          }
        }
        run.sheet = sheet;
        if (input.deps.store && !result.servedFromStore) {
          const stored = await input.deps.store.get(planId);
          if (stored) {
            const request = { ...stored.request, ...extras(input.request) };
            // Only a live run with the preset's own inputs may become "the" preset (latestForPreset
            // reads the top-level presetId). A fixture run or one with the caller's own inputs keeps
            // its preset in `request` only, so it never stands in for the preset for other visitors.
            const shared = input.mode === "live" && isCanonicalRequest(input.request);
            const { presetId: _presetId, ...rest } = stored;
            await input.deps.store.put(shared ? { ...stored, sheet, request } : { ...rest, sheet, request });
          }
        }
        finish("complete");
      } else if (result.status === "needs_input" && result.pause) {
        run.pending = result.pause.pending;
        run.resolution = result.pause.resolution;
        run.bill = result.pause.bill;
        if (input.deps.store) {
          const stored = await input.deps.store.get(planId);
          if (stored) await input.deps.store.put({ ...stored, request: { ...stored.request, ...extras(input.request) } });
        }
        emit(planId, { type: "needs_input", planId, pending: result.pause.pending, resolution: result.pause.resolution, bill: result.pause.bill });
        finish("needs_input");
      } else {
        finish("error", result.error ?? "The run stopped without a sheet.");
      }
    } catch (err) {
      finish("error", err instanceof Error ? err.message : String(err));
    }
  })();
  return run;
}

function extras(r: WebPlanRequest): WebRequestExtras {
  return {
    ...(r.proxyPicks && Object.keys(r.proxyPicks).length > 0 ? { proxyPicks: r.proxyPicks } : {}),
    ...(r.customInputs ? { customInputs: true } : {}),
  };
}

/** Cards of a finished sheet in stream order (for replaying a stored or cached plan). */
export function cardsOf(sheet: StreetSheet): StreamCard[] {
  return CARD_ORDER.map((key) => ({ key, envelope: sheet.cards[key] as Envelope<unknown> }));
}

export function resetRunsForTests(): void {
  registry().runs.clear();
  registry().listeners.clear();
}
