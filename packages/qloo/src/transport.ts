/**
 * HTTP transport: X-Api-Key header, the shared token bucket, at most 2 retries
 * with exponential backoff + jitter on 429 / 5xx / network errors, and the
 * month quota headers. It returns the final status; the client interprets it.
 */
import { encodeQuery } from "./canonical";
import { QlooNetworkError } from "./errors";
import type { RateLimiter } from "./limiter";
import { defaultSleep } from "./limiter";
import type { QlooRequest } from "./types";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RetryOptions {
  /** Retries after the first attempt (default 2). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface TransportDeps {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  limiter: RateLimiter;
  retry?: RetryOptions;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface TransportResult {
  status: number;
  text: string;
  bytes: number;
  latencyMs: number;
  attempts: number;
  /** One line per retry, e.g. "retry 1 after HTTP 429 (612 ms)". */
  retryNotes: string[];
  monthRemaining: number | null;
  monthLimit: number | null;
}

export function buildUrl(baseUrl: string, req: QlooRequest): string {
  const qs = encodeQuery(req.params);
  return qs ? `${baseUrl}${req.path}?${qs}` : `${baseUrl}${req.path}`;
}

function headerInt(h: Headers, name: string): number | null {
  const v = h.get(name);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Exponential backoff with "equal jitter": half fixed, half random. */
export function backoffDelay(attempt: number, random: () => number, retry: RetryOptions = {}): number {
  const base = retry.baseDelayMs ?? 500;
  const cap = retry.maxDelayMs ?? 8000;
  const d = Math.min(cap, base * 2 ** attempt);
  return Math.round(d / 2 + random() * (d / 2));
}

function retryAfterMs(h: Headers): number | null {
  const v = h.get("retry-after");
  if (!v) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : null;
}

export async function send(req: QlooRequest, deps: TransportDeps): Promise<TransportResult> {
  const maxRetries = Math.max(0, deps.retry?.maxRetries ?? 2);
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const url = buildUrl(deps.baseUrl, req);
  const headers: Record<string, string> = { "X-Api-Key": deps.apiKey, Accept: "application/json" };

  const retryNotes: string[] = [];
  let monthRemaining: number | null = null;
  let monthLimit: number | null = null;
  let lastNetworkError = "";
  const t0 = now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await deps.limiter.acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response | null = null;
    let text = "";
    try {
      res = await deps.fetch(url, { method: req.method, headers, signal: ctrl.signal });
      text = await res.text();
    } catch (err) {
      lastNetworkError = err instanceof Error ? err.message : String(err);
      res = null;
    } finally {
      clearTimeout(timer);
    }

    if (res) {
      monthRemaining = headerInt(res.headers, "x-month-ratelimit-remaining") ?? monthRemaining;
      monthLimit = headerInt(res.headers, "x-month-ratelimit-limit") ?? monthLimit;
      const monthExhausted = res.status === 429 && monthRemaining !== null && monthRemaining < 1;
      if (!isRetryableStatus(res.status) || attempt === maxRetries || monthExhausted) {
        return {
          status: res.status,
          text,
          bytes: Buffer.byteLength(text, "utf8"),
          latencyMs: Math.max(0, now() - t0),
          attempts: attempt + 1,
          retryNotes,
          monthRemaining,
          monthLimit,
        };
      }
      const delay = Math.max(backoffDelay(attempt, random, deps.retry), Math.min(retryAfterMs(res.headers) ?? 0, deps.retry?.maxDelayMs ?? 8000));
      retryNotes.push(`retry ${attempt + 1} after HTTP ${res.status} (${delay} ms)`);
      await sleep(delay);
      continue;
    }

    if (attempt === maxRetries) break;
    const delay = backoffDelay(attempt, random, deps.retry);
    retryNotes.push(`retry ${attempt + 1} after network error (${delay} ms)`);
    await sleep(delay);
  }
  throw new QlooNetworkError(lastNetworkError || "unknown", maxRetries + 1);
}
