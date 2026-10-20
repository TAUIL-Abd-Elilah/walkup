/**
 * Daily spend guard for Anthropic calls.
 *
 * Cost is estimated from the `usage` block of each response. When the day's
 * estimated spend reaches the cap, callers fall back to the deterministic
 * template (narration) or stop the loop (control arm).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MODEL } from "./constants";

export interface ModelRates {
  /** USD per million uncached input tokens. */
  input: number;
  /** USD per million output tokens (thinking tokens are billed as output). */
  output: number;
  /** USD per million cache-read input tokens. */
  cacheRead: number;
  /** USD per million cache-write input tokens (5-minute TTL, 1.25x input). */
  cacheWrite: number;
}

/** Rates for the model this package calls. */
export const MODEL_RATES: Readonly<Record<string, ModelRates>> = {
  [MODEL]: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Cheaper Claude models a deployment may pick with OPENROUTER_MODEL (rates as OpenRouter lists them, Oct 2026).
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/**
 * Used when a server-side fallback served the turn with a model not listed above.
 * Deliberately priced at the top tier so the guard errs toward stopping early.
 */
export const UNLISTED_MODEL_RATES: ModelRates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export const DEFAULT_DAILY_CAP_USD = 5;

/** The subset of the SDK's usage block the estimate needs. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** Per-model breakdown (present when a fallback ran). Shape-checked at runtime. */
  iterations?: ReadonlyArray<unknown> | null;
}

/**
 * The Anthropic model id for an OpenRouter slug ("anthropic/claude-opus-5.5" is
 * "claude-opus-5-5"; OpenRouter bills Claude at Anthropic's list rates). Other ids
 * pass through unchanged.
 */
export function canonicalModel(model: string): string {
  if (!model.startsWith("anthropic/")) return model;
  return model.slice("anthropic/".length).replace(/(\d)\.(\d)/g, "$1-$2");
}

export function ratesFor(model: string | null | undefined): ModelRates {
  if (!model) return MODEL_RATES[MODEL] as ModelRates;
  return MODEL_RATES[canonicalModel(model)] ?? UNLISTED_MODEL_RATES;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function costOf(
  rates: ModelRates,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  return (
    (input * rates.input + output * rates.output + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite) /
    1_000_000
  );
}

/**
 * Estimated USD cost of one response. When the usage block carries a per-model
 * `iterations` breakdown (a fallback ran), each iteration is priced at its own
 * model's rates; otherwise the aggregate is priced at `model`'s rates.
 */
export function estimateCostUsd(usage: UsageLike, model: string = MODEL): number {
  const iterations = Array.isArray(usage.iterations) ? usage.iterations : [];
  let fromIterations = 0;
  let counted = 0;
  for (const raw of iterations) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const input = num(it["input_tokens"]);
    const output = num(it["output_tokens"]);
    if (input === 0 && output === 0) continue;
    const itModel = typeof it["model"] === "string" ? (it["model"] as string) : model;
    fromIterations += costOf(
      ratesFor(itModel),
      input,
      output,
      num(it["cache_read_input_tokens"]),
      num(it["cache_creation_input_tokens"]),
    );
    counted += 1;
  }
  if (counted > 0) return fromIterations;
  return costOf(
    ratesFor(model),
    num(usage.input_tokens),
    num(usage.output_tokens),
    num(usage.cache_read_input_tokens),
    num(usage.cache_creation_input_tokens),
  );
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

/** Where the day's running total lives. Sync or async; keyed by UTC day "YYYY-MM-DD". */
export interface SpendStore {
  get(day: string): number | Promise<number>;
  add(day: string, usd: number): void | Promise<void>;
}

export function createMemorySpendStore(seed: Record<string, number> = {}): SpendStore {
  const totals = new Map<string, number>(Object.entries(seed));
  return {
    get(day) {
      return totals.get(day) ?? 0;
    },
    add(day, usd) {
      totals.set(day, (totals.get(day) ?? 0) + usd);
    },
  };
}

/**
 * JSON file store ({"2026-10-13": 0.42, ...}). Synchronous and single-process;
 * good enough for one server. A missing file counts as zero spend. A corrupt or
 * unreadable file is treated as "cap reached" (get returns +Infinity), and add
 * refuses to overwrite it (throws), so a broken store never resets the day's
 * total or unlocks spending.
 */
export function createFileSpendStore(filePath: string): SpendStore {
  function read(): Record<string, number> | null {
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
      }
      return out;
    } catch {
      return null;
    }
  }
  return {
    get(day) {
      const all = read();
      if (all === null) return Number.POSITIVE_INFINITY;
      return all[day] ?? 0;
    },
    add(day, usd) {
      const all = read();
      if (all === null) throw new Error(`spend file ${filePath} is unreadable or corrupt; not overwritten`);
      all[day] = (all[day] ?? 0) + usd;
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(all, null, 2));
    },
  };
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface SpendGuardOptions {
  store?: SpendStore;
  /** Default $5/day. */
  dailyCapUsd?: number;
  /** Injectable clock; the day key is the UTC calendar day. */
  now?: () => Date;
}

export class SpendGuard {
  readonly dailyCapUsd: number;
  private readonly store: SpendStore;
  private readonly now: () => Date;

  constructor(opts: SpendGuardOptions = {}) {
    this.store = opts.store ?? createMemorySpendStore();
    this.dailyCapUsd = opts.dailyCapUsd ?? DEFAULT_DAILY_CAP_USD;
    this.now = opts.now ?? (() => new Date());
  }

  dayKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  async spentToday(): Promise<number> {
    return await this.store.get(this.dayKey());
  }

  async remainingUsd(): Promise<number> {
    return Math.max(0, this.dailyCapUsd - (await this.spentToday()));
  }

  /** True while today's spend plus `reserveUsd` stays under the cap. */
  async canSpend(reserveUsd = 0): Promise<boolean> {
    const spent = await this.spentToday();
    return spent + Math.max(0, reserveUsd) < this.dailyCapUsd;
  }

  /** Adds the estimated cost of a response to today's total and returns it. */
  async record(usage: UsageLike, model: string = MODEL): Promise<number> {
    const usd = estimateCostUsd(usage, model);
    await this.recordUsd(usd);
    return usd;
  }

  async recordUsd(usd: number): Promise<void> {
    if (usd > 0) await this.store.add(this.dayKey(), usd);
  }
}
