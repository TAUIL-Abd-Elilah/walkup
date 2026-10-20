/**
 * Wires the run services: @walkup/qloo (live mode, private SQLite cache with a one-year
 * TTL so a long run never re-fetches, ledger, month guard, 3 retries at 1 s / 2 s / 4 s),
 * @walkup/places (persistent cache and counters, the plan's 2,500 cap), the Census
 * Geocoder and the model client with @walkup/narrator's spend guard. Every network
 * function is injectable; tests pass fakes and nothing reaches the network.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMemoryLedger, type LedgerSink } from "@walkup/contracts";
import { createFileSpendStore, createMemorySpendStore, SpendGuard } from "@walkup/narrator";
import { createPlacesClient } from "@walkup/places";
import {
  createQlooClient,
  createSqliteCache,
  loadConfig,
  type FetchLike,
  type QlooCache,
  type RateLimiter,
} from "@walkup/qloo";
import { createGeocoder, type FetchFn } from "./census";
import { StopRunError } from "./errors";
import type { ModelClient } from "./model-arms";
import { createPlacesIo, type PlacesIo } from "./places-io";
import { PLACES_TOTAL_CAP } from "./protocol";
import { createQlooIo, QlooBudget } from "./qloo-io";
import type { Services } from "./runner";
import { RunStore, storePlacesCache, storePlacesCounter } from "./store";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface ServiceOptions {
  /** SQLite file for the Qloo cache and the run store, or ":memory:". */
  stateFile: string;
  /** Spend file for the model guard, or null for an in-memory store. */
  spendFile: string | null;
  env: Record<string, string | undefined>;
  qlooFetch: FetchLike;
  placesFetch: (url: string, init?: RequestInit) => Promise<Response>;
  censusFetch: FetchFn;
  /** Null: arms F and L cannot run. */
  modelClient: ModelClient | null;
  /** Null: no Places client (--no-google or no key). */
  usePlaces: boolean;
  maxQlooCalls: number;
  placesDailyCap: number;
  llmDailyCapUsd: number;
  sleep?: (ms: number) => Promise<void>;
  /** Tests: noLimiter. Default: the process-wide 3 req/s bucket. */
  limiter?: RateLimiter;
  /** Census pacing (default 1000 ms). */
  censusIntervalMs?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ServiceHandle {
  services: Services;
  cache: QlooCache;
  ledger: LedgerSink;
  close(): void;
}

export function createServices(o: ServiceOptions): ServiceHandle {
  const apiKey = (o.env["QLOO_API_KEY"] ?? "").trim();
  if (!apiKey) throw new StopRunError("config", "QLOO_API_KEY is not set (put it in .env), or use --dry-run");
  const placesKey = (o.env["GOOGLE_PLACES_API_KEY"] ?? "").trim();
  if (o.usePlaces && !placesKey) {
    throw new StopRunError("config", "GOOGLE_PLACES_API_KEY is not set: the closed check (§5) and arm F need it; pass --no-google for a provisional Qloo-only run");
  }
  const cache = createSqliteCache(o.stateFile, {
    ttlMs: { search: YEAR_MS, entities: YEAR_MS, tags: YEAR_MS, audiences: YEAR_MS, insights: YEAR_MS, heatmap: YEAR_MS, compare: YEAR_MS },
  });
  const store = new RunStore(cache);
  const ledger = createMemoryLedger();
  const budget = new QlooBudget(o.maxQlooCalls, store);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => new Date());

  // Live mode only (P1 is never replayed from product fixtures); recording to fixtures/raw is off.
  const config = { ...loadConfig(o.env), mode: "live" as const, requestedMode: "live" as const, record: false };
  const client = createQlooClient({
    config,
    fetch: budget.wrapFetch(o.qlooFetch),
    cache,
    ledger,
    // Plan: retry 429 / 5xx / timeouts up to 3 times with 1 s, 2 s, 4 s (random() = 1 removes the jitter).
    retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 4000 },
    random: () => 1,
    sleep,
    now: () => now().getTime(),
    ...(o.limiter ? { limiter: o.limiter } : {}),
  });
  const qloo = createQlooIo(client, cache, budget, () => now().getTime());

  let places: PlacesIo | null = null;
  if (o.usePlaces) {
    const pc = createPlacesClient({
      apiKey: placesKey,
      fetch: o.placesFetch,
      ledger,
      cache: storePlacesCache(store),
      counterStore: storePlacesCounter(store, PLACES_TOTAL_CAP),
      dailyCap: o.placesDailyCap,
      maxRetries: 3,
      sleep,
      now: () => now().getTime(),
    });
    places = createPlacesIo(pc, store, PLACES_TOTAL_CAP, { sleep });
  }

  const geocoder = createGeocoder({
    fetch: o.censusFetch,
    store,
    sleep,
    now: () => now().getTime(),
    ...(o.censusIntervalMs !== undefined ? { minIntervalMs: o.censusIntervalMs } : {}),
  });

  const model = o.modelClient
    ? {
        client: o.modelClient,
        spend: new SpendGuard({ store: o.spendFile ? createFileSpendStore(o.spendFile) : createMemorySpendStore(), dailyCapUsd: o.llmDailyCapUsd, now }),
        ledger,
        sleep,
      }
    : null;

  const services: Services = {
    qloo,
    places,
    geocoder,
    model,
    store,
    ledger,
    now,
    log: o.log ?? ((line: string) => console.log(line)),
    qlooCap: o.maxQlooCalls,
  };
  return { services, cache, ledger, close: () => cache.close() };
}

// ---------------------------------------------------------------------------
// Seal checks
// ---------------------------------------------------------------------------

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** True when docs/preregistration/p1-plan.md matches p1-plan.sha256; null when either file is missing. */
export function planMatchesSeal(repoRoot: string): boolean | null {
  const dir = join(repoRoot, "docs", "preregistration");
  const shaFile = join(dir, "p1-plan.sha256");
  const plan = join(dir, "p1-plan.md");
  if (!existsSync(shaFile) || !existsSync(plan)) return null;
  const sealed = readFileSync(shaFile, "utf8").trim().split(/\s+/)[0];
  return sealed === sha256File(plan);
}

/** True when `barsPath` is the sealed table (same hash as data/private/p1/bars_full.csv in p1-code.sha256). */
export function barsMatchSeal(repoRoot: string, barsPath: string): boolean | null {
  const codeSha = join(repoRoot, "docs", "preregistration", "p1-code.sha256");
  if (!existsSync(codeSha) || !existsSync(barsPath)) return null;
  const line = readFileSync(codeSha, "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().endsWith("data/private/p1/bars_full.csv"));
  if (!line) return null;
  return line.trim().split(/\s+/)[0] === sha256File(barsPath);
}
