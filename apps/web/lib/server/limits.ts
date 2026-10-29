/**
 * Cost caps for fresh runs (spec: 3 per IP per day, 15 per day in total; cached
 * presets are unlimited) and small per-IP rate windows for other expensive
 * requests (send previews render a PDF; proxy title searches call Qloo).
 *
 * IPs are kept only as a keyed hash. Day counts survive restarts in
 * ${WALKUP_DATA_DIR}/fresh-runs.json; rate windows are in memory.
 */
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir, intEnv, type Env } from "./env";

export const DEFAULT_FRESH_PER_IP = 3;
export const DEFAULT_FRESH_PER_DAY = 15;

export interface Allowance {
  used: number;
  limit: number;
  remaining: number;
}

export interface FreshRunStatus {
  allowed: boolean;
  reason?: string;
  you: Allowance;
  total: Allowance;
  /** UTC day the counts belong to. */
  day: string;
}

interface DayState {
  day: string;
  total: number;
  perIp: Record<string, number>;
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

let processSecret: string | null = null;
function secret(env: Env): string {
  const s = env.WALKUP_SIGNING_SECRET ?? "";
  if (s.length >= 32) return s;
  processSecret ??= randomBytes(32).toString("hex");
  return processSecret;
}

export function hashIp(ip: string | null, env: Env = process.env): string {
  return createHmac("sha256", secret(env))
    .update(`walkup-ip:${ip ?? "unknown"}`)
    .digest("hex")
    .slice(0, 20);
}

export interface FreshRunLimiterOptions {
  perIp?: number;
  perDay?: number;
  /** JSON file for the day counts; null keeps them in memory. */
  file?: string | null;
  now?: () => number;
  env?: Env;
}

export class FreshRunLimiter {
  readonly perIp: number;
  readonly perDay: number;
  private readonly file: string | null;
  private readonly now: () => number;
  private readonly env: Env;
  private state: DayState;

  constructor(o: FreshRunLimiterOptions = {}) {
    this.perIp = o.perIp ?? DEFAULT_FRESH_PER_IP;
    this.perDay = o.perDay ?? DEFAULT_FRESH_PER_DAY;
    this.file = o.file ?? null;
    this.now = o.now ?? Date.now;
    this.env = o.env ?? process.env;
    this.state = this.load();
  }

  private load(): DayState {
    const fresh: DayState = { day: utcDay(this.now()), total: 0, perIp: {} };
    if (!this.file || !existsSync(this.file)) return fresh;
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8")) as DayState;
      if (s && typeof s.day === "string" && typeof s.total === "number" && s.perIp && typeof s.perIp === "object") return s;
    } catch {
      // A damaged file starts the day over.
    }
    return fresh;
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state), "utf8");
      renameSync(`${this.file}.tmp`, this.file);
    } catch {
      // Counting continues in memory.
    }
  }

  private roll(): void {
    const day = utcDay(this.now());
    if (this.state.day !== day) this.state = { day, total: 0, perIp: {} };
  }

  status(ip: string | null): FreshRunStatus {
    this.roll();
    const key = hashIp(ip, this.env);
    const mine = this.state.perIp[key] ?? 0;
    const you: Allowance = { used: mine, limit: this.perIp, remaining: Math.max(0, this.perIp - mine) };
    const total: Allowance = { used: this.state.total, limit: this.perDay, remaining: Math.max(0, this.perDay - this.state.total) };
    let reason: string | undefined;
    if (total.remaining === 0) reason = `The day's ${this.perDay} fresh runs are used up. Presets stay open; fresh runs reset at 00:00 UTC.`;
    else if (you.remaining === 0) reason = `Fresh runs are capped at ${this.perIp} per network per day. Presets stay open; the cap resets at 00:00 UTC.`;
    return { allowed: !reason, ...(reason ? { reason } : {}), you, total, day: this.state.day };
  }

  /** Counts one fresh run when allowed. `allowed` says whether this run was counted; the counts are after it. */
  take(ip: string | null): FreshRunStatus {
    const s = this.status(ip);
    if (!s.allowed) return s;
    const key = hashIp(ip, this.env);
    this.state.perIp[key] = (this.state.perIp[key] ?? 0) + 1;
    this.state.total += 1;
    this.save();
    const after = this.status(ip);
    return { allowed: true, you: after.you, total: after.total, day: after.day };
  }

  /** Gives a run back (it failed before sending anything). */
  refund(ip: string | null, day: string): void {
    this.roll();
    if (this.state.day !== day) return;
    const key = hashIp(ip, this.env);
    if ((this.state.perIp[key] ?? 0) > 0) this.state.perIp[key] = (this.state.perIp[key] ?? 0) - 1;
    if (this.state.total > 0) this.state.total -= 1;
    this.save();
  }
}

const KEY = "__walkupFreshRuns";

export function freshRuns(env: Env = process.env): FreshRunLimiter {
  const g = globalThis as Record<string, unknown>;
  let l = g[KEY] as FreshRunLimiter | undefined;
  if (!l) {
    l = new FreshRunLimiter({
      perIp: intEnv(env, "WALKUP_FRESH_RUNS_PER_IP", DEFAULT_FRESH_PER_IP, 0, 1000),
      perDay: intEnv(env, "WALKUP_FRESH_RUNS_PER_DAY", DEFAULT_FRESH_PER_DAY, 0, 100_000),
      file: join(dataDir(env), "fresh-runs.json"),
      env,
    });
    g[KEY] = l;
  }
  return l;
}

export function setFreshRunsForTests(l: FreshRunLimiter | null): void {
  (globalThis as Record<string, unknown>)[KEY] = l ?? undefined;
}

// ---------------------------------------------------------------------------
// Sliding windows (in memory)
// ---------------------------------------------------------------------------

const WINDOWS_KEY = "__walkupRateWindows";

function windows(): Map<string, number[]> {
  const g = globalThis as Record<string, unknown>;
  let m = g[WINDOWS_KEY] as Map<string, number[]> | undefined;
  if (!m) {
    m = new Map();
    g[WINDOWS_KEY] = m;
  }
  return m;
}

/** At most `limit` hits per `windowMs` per (bucket, ip). */
export function rateLimit(bucket: string, ip: string | null, limit: number, windowMs: number, now: number = Date.now()): { ok: boolean; retryAfterS: number } {
  const key = `${bucket}:${hashIp(ip)}`;
  const m = windows();
  const hits = (m.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    m.set(key, hits);
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((windowMs - (now - (hits[0] ?? now))) / 1000)) };
  }
  hits.push(now);
  m.set(key, hits);
  if (m.size > 5000) for (const k of [...m.keys()].slice(0, 1000)) m.delete(k);
  return { ok: true, retryAfterS: 0 };
}

export function resetRateWindowsForTests(): void {
  windows().clear();
}

// ---------------------------------------------------------------------------
// Revisions (POST /api/plan/<id>/revise)
// ---------------------------------------------------------------------------

/**
 * Revisions per network per hour. A revision re-runs the plan on cached Qloo answers (only the requests
 * whose inputs changed are new) and may make one model call, and is capped on its own window; in live mode it
 * also takes a fresh run (see revise.ts), refunded when it makes no new Qloo call. Live is tighter than fixture mode.
 */
/** Recorded mode reads the note and opens a stored version: no API call, so judges sharing one network get a higher cap. */
export const REVISES_PER_HOUR = { fixture: 30, live: 12, recorded: 120 } as const;
const REVISE_WINDOW_MS = 60 * 60 * 1000;

export function reviseAllowed(ip: string | null, mode: "live" | "fixture" | "recorded", now: number = Date.now()): { ok: boolean; retryAfterS: number; limit: number } {
  const limit = REVISES_PER_HOUR[mode];
  return { ...rateLimit(`revise-${mode}`, ip, limit, REVISE_WINDOW_MS, now), limit };
}
