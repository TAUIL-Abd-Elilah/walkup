/**
 * Per-caller caps (docs/spec.md): fresh runs are capped at 3 per caller per day and
 * 15 per day in total; cached presets and reads are unlimited.
 *
 * The limiter is an interface so a host can plug in its own (apps/web passes
 * its persistent per-IP limiter, so REST and MCP share one allowance). Tools
 * hand it the caller's address; implementations keep only a keyed hash.
 */
import { createHash, randomBytes } from "node:crypto";

export const FRESH_RUNS_PER_CALLER_PER_DAY = 3;
export const FRESH_RUNS_PER_DAY = 15;
/** Burst guard on every MCP HTTP request (cheap reads included). */
export const REQUESTS_PER_MINUTE = 120;

export interface CapDecision {
  allowed: boolean;
  /** Why the run was refused; starts with "limit reached". */
  reason?: string;
  leftForCaller: number;
  leftToday: number;
}

export interface FreshRunLimiter {
  /** Would a fresh run be allowed now for this caller address? Takes nothing. */
  check(ip: string, now: number): CapDecision | Promise<CapDecision>;
  /** Takes one fresh run, or refuses. Check and take are one step, so concurrent calls cannot overshoot. */
  take(ip: string, now: number): CapDecision | Promise<CapDecision>;
  /** Gives one back (a run that failed before sending any Qloo request). */
  refund(ip: string, now: number): void | Promise<void>;
}

export interface FreshRunLimits {
  perCallerPerDay?: number;
  perDay?: number;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** In-memory limiter keyed by callerKey(ip): counters reset at 00:00 UTC; lost on restart. */
export function createMemoryFreshRunLimiter(limits: FreshRunLimits = {}): FreshRunLimiter {
  const perCaller = Math.max(0, Math.floor(limits.perCallerPerDay ?? FRESH_RUNS_PER_CALLER_PER_DAY));
  const perDay = Math.max(0, Math.floor(limits.perDay ?? FRESH_RUNS_PER_DAY));
  let day = "";
  let total = 0;
  const byCaller = new Map<string, number>();
  const roll = (now: number) => {
    const d = utcDay(now);
    if (d !== day) {
      day = d;
      total = 0;
      byCaller.clear();
    }
  };
  const decide = (key: string): CapDecision => {
    const used = byCaller.get(key) ?? 0;
    const leftForCaller = Math.max(0, perCaller - used);
    const leftToday = Math.max(0, perDay - total);
    if (leftForCaller === 0) {
      return {
        allowed: false,
        reason: `limit reached: ${perCaller} fresh runs per caller per day. Presets and existing plans stay available (get_sheet, bill_vs_house).`,
        leftForCaller,
        leftToday,
      };
    }
    if (leftToday === 0) {
      return {
        allowed: false,
        reason: `limit reached: ${perDay} fresh runs per day on this server. Presets and existing plans stay available.`,
        leftForCaller,
        leftToday,
      };
    }
    return { allowed: true, leftForCaller, leftToday };
  };
  return {
    check(ip, now) {
      roll(now);
      return decide(callerKey(ip));
    },
    take(ip, now) {
      roll(now);
      const key = callerKey(ip);
      const d = decide(key);
      if (!d.allowed) return d;
      byCaller.set(key, (byCaller.get(key) ?? 0) + 1);
      total += 1;
      return { allowed: true, leftForCaller: d.leftForCaller - 1, leftToday: d.leftToday - 1 };
    },
    refund(ip, now) {
      roll(now);
      const key = callerKey(ip);
      const used = byCaller.get(key) ?? 0;
      if (used > 0) {
        byCaller.set(key, used - 1);
        total = Math.max(0, total - 1);
      }
    },
  };
}

/** A limiter that never refuses (local stdio servers on the owner's own keys can opt into it). */
export function createUnlimitedFreshRunLimiter(): FreshRunLimiter {
  const open: CapDecision = { allowed: true, leftForCaller: Number.MAX_SAFE_INTEGER, leftToday: Number.MAX_SAFE_INTEGER };
  return { check: () => open, take: () => open, refund: () => {} };
}

const SHARED_KEY = Symbol.for("walkup.mcp.freshRunLimiter");

/**
 * One limiter per process, shared by every module that asks for it (the MCP
 * route and, once wired, the web app's POST /api/plan and /api/rank-partners).
 */
export function sharedFreshRunLimiter(limits: FreshRunLimits = {}): FreshRunLimiter {
  const g = globalThis as unknown as Record<symbol, FreshRunLimiter | undefined>;
  const existing = g[SHARED_KEY];
  if (existing) return existing;
  const created = createMemoryFreshRunLimiter(limits);
  g[SHARED_KEY] = created;
  return created;
}

/** Sliding one-minute window per caller. */
export interface RequestRateLimiter {
  hit(callerKey: string, now: number): boolean;
}

export function createRequestRateLimiter(perMinute = REQUESTS_PER_MINUTE): RequestRateLimiter {
  const hits = new Map<string, number[]>();
  return {
    hit(key, now) {
      const since = now - 60_000;
      const list = (hits.get(key) ?? []).filter((t) => t > since);
      if (list.length >= perMinute) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      // Keep the map small: drop callers with no hit in the last minute.
      if (hits.size > 5_000) for (const [k, v] of hits) if ((v[v.length - 1] ?? 0) <= since) hits.delete(k);
      return true;
    },
  };
}

const SALT = randomBytes(16).toString("hex");

/** Salted hash of the caller's address (per process); raw IPs are never stored. */
export function callerKey(ip: string, salt: string = SALT): string {
  return createHash("sha256").update(`${salt}|${ip.trim().toLowerCase()}`).digest("hex").slice(0, 24);
}

type HeaderBag = { get(name: string): string | null };

/**
 * The caller's address as the proxy saw it: Fly-Client-IP (set by Fly's edge,
 * not by the client), then X-Real-IP, then the last X-Forwarded-For hop (the
 * one our proxy appended). "unknown" otherwise, which shares one bucket.
 */
export function clientIpFrom(headers: HeaderBag): string {
  const fly = headers.get("fly-client-ip")?.trim();
  if (fly) return fly;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
    const last = hops[hops.length - 1];
    if (last) return last;
  }
  return "unknown";
}
