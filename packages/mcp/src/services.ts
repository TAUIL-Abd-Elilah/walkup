/**
 * What the tools run on: orchestrator deps (live or fixture), the plan store,
 * the fresh-run limiter, the secrets to scrub and the show-text parser.
 *
 * - createMcpServices(): from deps you already have (tests, the web app).
 * - createFixtureServices(): the fixture world, memory store; no keys needed.
 * - createServicesFromEnv(): live deps when QLOO_API_KEY and
 *   TICKETMASTER_API_KEY are set (and WALKUP_MODE is not "fixture"),
 *   otherwise fixture deps; plans in SQLite under WALKUP_DATA_DIR.
 * - getEnvServices(): one createServicesFromEnv() per process.
 */
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { LedgerSink } from "@walkup/contracts";
import { heuristicShowQuery, parseShowQuery, type ShowQuery } from "@walkup/narrator";
import {
  createDepsFromEnv,
  createFixtureDeps,
  createMemoryChoiceStore,
  createMemoryPlanStore,
  resolveMode,
  type ChoiceStore,
  type FixtureDepsOptions,
  type PlanDeps,
  type PlanResult,
  type PlanStore,
} from "@walkup/orchestrator";
import { createSqlitePlanStore } from "@walkup/orchestrator/sqlite";
import { secretsFromEnv, type PlanMode, type Secret } from "./envelope";
import { createRequestRateLimiter, sharedFreshRunLimiter, type FreshRunLimiter, type RequestRateLimiter } from "./limits";
import type { PlanView } from "./views";

/** File name of the plan store inside WALKUP_DATA_DIR (shared with the web app's sheet routes). */
export const PLANS_DB_FILE = "plans.sqlite";

export type ShowParser = (text: string, ledger?: LedgerSink) => Promise<ShowQuery>;

/**
 * What a preset id shows. "page": what the plan page shows (a preset whose run
 * pauses for a pick shows the pick first); "api": the sheet a read returns.
 * Null falls back to the built-in loader (plan store, else one orchestrator run).
 */
export type PresetViewLoader = (presetId: string, view: "page" | "api") => Promise<PlanView | null>;

export interface RunPolicy {
  /**
   * Free-form runs (event text or a Ticketmaster link) in fixture mode, on the
   * synthetic world. Default true; the hosted web app turns them off, as its
   * REST API does (presets stay open).
   */
  fixtureEventRuns: boolean;
  /** Count fixture-mode runs against the caps. Default true (live runs always count). */
  capFixtureRuns: boolean;
  /** The reason given when fixtureEventRuns is off. */
  fixtureRefusal: string;
  /**
   * Set when the host serves recorded sheets only (Qloo is no longer available): every tool but get_sheet
   * answers 503 with this reason and mode "recorded". Default null.
   */
  recorded: string | null;
}

export const DEFAULT_FIXTURE_REFUSAL =
  "Fresh runs are disabled in fixture mode (this server has no live Qloo key). Presets run on the synthetic fixture world: plan_show with presetId g1-a, g1-b, g2 or g3.";

export interface McpServices {
  deps: PlanDeps;
  /** Where plans are written and read (also deps.store). */
  store: PlanStore;
  limiter: FreshRunLimiter;
  /** Burst guard for the HTTP transport; null disables it. */
  rate: RequestRateLimiter | null;
  secrets: Secret[];
  now: () => number;
  idGen: () => string;
  parseShow: ShowParser;
  /** Per-caller pick cache, so one caller's pick never becomes another's default. */
  choicesFor: (callerKey: string) => ChoiceStore;
  /** Preset runs in flight, so concurrent first calls share one run. */
  inflight: Map<string, Promise<unknown>>;
  mode: PlanMode;
  policy: RunPolicy;
  /** Host's own preset loader (see PresetViewLoader). */
  presetView?: PresetViewLoader;
  /** Called after every orchestrator run (quota display, rejected-key detection). Errors are ignored. */
  afterRun?: (result: PlanResult, deps: PlanDeps) => void | Promise<void>;
  /** Optional close hook (SQLite). */
  close?: () => void;
}

export interface ServicesOptions {
  deps: PlanDeps;
  store?: PlanStore;
  limiter?: FreshRunLimiter;
  rate?: RequestRateLimiter | null;
  secrets?: Secret[];
  now?: () => number;
  idGen?: () => string;
  parseShow?: ShowParser;
  policy?: Partial<RunPolicy>;
  presetView?: PresetViewLoader;
  afterRun?: McpServices["afterRun"];
  close?: () => void;
}

const MAX_CALLER_PICK_CACHES = 2_000;

function choiceCaches(): (key: string) => ChoiceStore {
  const caches = new Map<string, ChoiceStore>();
  return (key) => {
    const hit = caches.get(key);
    if (hit) return hit;
    if (caches.size >= MAX_CALLER_PICK_CACHES) {
      const oldest = caches.keys().next().value;
      if (oldest !== undefined) caches.delete(oldest);
    }
    const created = createMemoryChoiceStore();
    caches.set(key, created);
    return created;
  };
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Free text to ticketing fields: the model when the narrator has one, the deterministic parser otherwise. */
export function defaultShowParser(deps: PlanDeps, now: () => number): ShowParser {
  return async (text, ledger) => {
    const client = deps.narrator?.client ?? null;
    if (!client) return heuristicShowQuery(text);
    const parsed = await parseShowQuery(text, {
      client,
      ...(deps.narrator?.spend ? { spend: deps.narrator.spend } : {}),
      ...(ledger ? { ledger } : {}),
      today: isoDay(now()),
    });
    const q: ShowQuery = { artist: parsed.artist };
    if (parsed.venue) q.venue = parsed.venue;
    if (parsed.city) q.city = parsed.city;
    if (parsed.date) q.date = parsed.date;
    return q;
  };
}

export function createMcpServices(o: ServicesOptions): McpServices {
  const store = o.store ?? o.deps.store ?? createMemoryPlanStore();
  const now = o.now ?? o.deps.clock ?? (() => Date.now());
  const deps: PlanDeps = { ...o.deps, store };
  const services: McpServices = {
    deps,
    store,
    limiter: o.limiter ?? sharedFreshRunLimiter(),
    rate: o.rate === undefined ? createRequestRateLimiter() : o.rate,
    secrets: o.secrets ?? secretsFromEnv(process.env),
    now,
    idGen: o.idGen ?? (() => randomUUID()),
    parseShow: o.parseShow ?? defaultShowParser(deps, now),
    choicesFor: choiceCaches(),
    inflight: new Map(),
    mode: resolveMode(deps),
    policy: { fixtureEventRuns: true, capFixtureRuns: true, fixtureRefusal: DEFAULT_FIXTURE_REFUSAL, recorded: null, ...o.policy },
  };
  if (o.presetView) services.presetView = o.presetView;
  if (o.afterRun) services.afterRun = o.afterRun;
  if (o.close) services.close = o.close;
  return services;
}

export interface FixtureServicesOptions extends FixtureDepsOptions {
  limiter?: FreshRunLimiter;
  rate?: RequestRateLimiter | null;
  secrets?: Secret[];
  parseShow?: ShowParser;
  policy?: Partial<RunPolicy>;
}

/** The fixture world (synthetic Qloo, Ticketmaster and Places), memory plan store. Mode is always "fixture". */
export function createFixtureServices(o: FixtureServicesOptions = {}): McpServices {
  const { limiter, rate, secrets, parseShow, policy, ...fixture } = o;
  const store = fixture.store ?? createMemoryPlanStore();
  const deps = createFixtureDeps({ ...fixture, store });
  const s: ServicesOptions = { deps, store };
  if (limiter) s.limiter = limiter;
  if (rate !== undefined) s.rate = rate;
  if (secrets) s.secrets = secrets;
  if (parseShow) s.parseShow = parseShow;
  if (policy) s.policy = policy;
  if (fixture.clock) s.now = fixture.clock;
  if (fixture.idGen) s.idGen = fixture.idGen;
  return createMcpServices(s);
}

export interface EnvServicesOptions {
  /** Data directory when WALKUP_DATA_DIR is unset. Default: ./.cache from the working directory. */
  dataDirFallback?: string;
  limiter?: FreshRunLimiter;
  /** Plan store; default SQLite at <data dir>/plans.sqlite (memory if it cannot be opened). */
  store?: PlanStore;
  policy?: Partial<RunPolicy>;
  onWarning?: (message: string) => void;
}

export function dataDirFrom(env: Record<string, string | undefined>, fallback?: string): string {
  const fromEnv = env.WALKUP_DATA_DIR?.trim();
  return resolve(/*turbopackIgnore: true*/ fromEnv || fallback || ".cache");
}

/** Live or fixture services from the environment. Keys are read here and never leave the process. */
export function createServicesFromEnv(env: Record<string, string | undefined> = process.env, o: EnvServicesOptions = {}): McpServices {
  const dataDir = dataDirFrom(env, o.dataDirFallback);
  let store = o.store;
  let close: (() => void) | undefined;
  if (!store) {
    try {
      const sqlite = createSqlitePlanStore(join(dataDir, PLANS_DB_FILE));
      store = sqlite;
      close = () => sqlite.close();
    } catch (err) {
      o.onWarning?.(`Plan store: SQLite unavailable (${err instanceof Error ? err.message : String(err)}); plans are kept in memory.`);
      store = createMemoryPlanStore();
    }
  }
  const deps = createDepsFromEnv({ ...env, WALKUP_DATA_DIR: dataDir }, { store });
  const s: ServicesOptions = { deps, store, secrets: secretsFromEnv(env) };
  if (o.limiter) s.limiter = o.limiter;
  if (o.policy) s.policy = o.policy;
  if (close) s.close = close;
  return createMcpServices(s);
}

const ENV_SERVICES_KEY = Symbol.for("walkup.mcp.envServices");

/** One set of env services per process (the Next route module may be evaluated more than once). */
export function getEnvServices(o: EnvServicesOptions = {}): McpServices {
  const g = globalThis as unknown as Record<symbol, McpServices | undefined>;
  const existing = g[ENV_SERVICES_KEY];
  if (existing) return existing;
  const created = createServicesFromEnv(process.env, o);
  g[ENV_SERVICES_KEY] = created;
  return created;
}
