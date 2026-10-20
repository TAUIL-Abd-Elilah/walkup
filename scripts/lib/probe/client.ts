/**
 * Minimal HTTP client for the probe: raw fetch, 3 req/s pacing, hard call
 * budget, bounded retries on 429/5xx, monthly-quota floor, header capture and
 * an in-run memo so shared requests (resolutions, pools) are made once.
 *
 * Response bodies stay in memory. Nothing in this file writes to disk.
 */

import { errorPaths, signalWarnings } from "./extract.js";
import { buildUrl, canonicalKey, toCurl } from "./requests.js";
import { CallBudget, type Clock, QuotaGuardError, RateLimiter, realClock } from "./limiter.js";
import type { CallRecord, CallResult, HttpMethod, RequestSpec } from "./types.js";

export interface TransportRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export const fetchTransport: Transport = async (req) => {
  const init: RequestInit = { method: req.method, headers: req.headers, signal: AbortSignal.timeout(req.timeoutMs) };
  if (req.body !== undefined) init.body = req.body;
  const res = await fetch(req.url, init);
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: res.status, headers, text };
};

export interface ClientOptions {
  baseUrl: string;
  apiKey: string | null;
  dryRun: boolean;
  budget: CallBudget;
  limiter?: RateLimiter;
  transport?: Transport;
  clock?: Clock;
  maxRetries: number;
  timeoutMs: number;
  minMonthRemaining: number;
  /** Called after every request (live, memo or planned). Used for --verbose and the dry-run listing. */
  onCall?: (record: CallRecord, spec: RequestSpec, curl: string) => void;
}

const MONTH_REMAINING_HEADER = "x-month-ratelimit-remaining";

export class ProbeClient {
  private readonly memo = new Map<string, CallResult>();
  private plannedSeq = 0;
  private sink: CallRecord[] = [];
  private readonly limiter: RateLimiter;
  private readonly transport: Transport;
  private readonly clock: Clock;
  /** Latest value seen for every rate-limit style header. */
  readonly rateHeaders: Record<string, string> = {};
  monthRemaining: number | null = null;

  constructor(private readonly o: ClientOptions) {
    this.clock = o.clock ?? realClock;
    this.limiter = o.limiter ?? new RateLimiter(3, this.clock);
    this.transport = o.transport ?? fetchTransport;
    if (!o.dryRun && !o.apiKey) throw new Error("QLOO_API_KEY is not set");
  }

  /** Records of subsequent calls go to this array (one per probe). */
  setSink(sink: CallRecord[]): void {
    this.sink = sink;
  }

  /** API calls made so far (live), or requests planned so far (dry run). */
  get callCount(): number {
    return this.o.dryRun ? this.plannedSeq : this.o.budget.used;
  }

  async call(spec: RequestSpec): Promise<CallResult> {
    const key = canonicalKey(spec);
    const curl = toCurl(this.o.baseUrl, spec);
    const hit = this.memo.get(key);
    if (hit) {
      const record: CallRecord = { ...hit.record, label: spec.label, memo: true, attempts: 0, ms: 0 };
      this.sink.push(record);
      this.o.onCall?.(record, spec, curl);
      return { ...hit, record };
    }

    if (this.o.dryRun) {
      const record = baseRecord(spec, ++this.plannedSeq);
      const result: CallResult = { dry: true, status: null, json: null, record };
      this.memo.set(key, result);
      this.sink.push(record);
      this.o.onCall?.(record, spec, curl);
      return result;
    }

    const result = await this.live(spec);
    this.memo.set(key, result);
    this.sink.push(result.record);
    this.o.onCall?.(result.record, spec, curl);
    this.checkMonthFloor();
    return result;
  }

  private async live(spec: RequestSpec): Promise<CallResult> {
    const url = buildUrl(this.o.baseUrl, spec);
    const headers: Record<string, string> = { "X-Api-Key": this.o.apiKey ?? "", Accept: "application/json" };
    let body: string | undefined;
    if (spec.method === "POST") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(spec.body ?? {});
    }

    let attempts = 0;
    let seq = 0;
    let last: { status: number | null; headers: Record<string, string>; text: string; ms: number; error?: string } = {
      status: null,
      headers: {},
      text: "",
      ms: 0,
    };
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      this.o.budget.take(); // throws BudgetExceededError at the cap
      seq = this.o.budget.used;
      attempts++;
      await this.limiter.acquire();
      const t0 = this.clock.now();
      try {
        const req: { url: string; method: HttpMethod; headers: Record<string, string>; body?: string; timeoutMs: number } = {
          url,
          method: spec.method,
          headers,
          timeoutMs: this.o.timeoutMs,
        };
        if (body !== undefined) req.body = body;
        const res = await this.transport(req);
        last = { status: res.status, headers: this.cleanHeaders(res.headers), text: res.text, ms: this.clock.now() - t0 };
      } catch (err) {
        last = { status: null, headers: {}, text: "", ms: this.clock.now() - t0, error: errorMessage(err) };
      }
      this.noteRateHeaders(last.headers);
      const retryable = last.status === null || last.status === 429 || last.status >= 500;
      if (!retryable || attempt === this.o.maxRetries) break;
      if (this.monthBelowFloor()) break;
      await this.clock.sleep(backoffMs(attempt, last.headers["retry-after"]));
    }

    const record: CallRecord = {
      ...baseRecord(spec, seq),
      status: last.status,
      ms: last.ms,
      bytes: Buffer.byteLength(last.text, "utf8"),
      attempts,
      headers: last.headers,
    };
    let json: unknown = null;
    if (last.text.length > 0) {
      try {
        json = JSON.parse(last.text);
      } catch {
        record.error = "response was not JSON";
      }
    }
    if (last.status !== null && last.status >= 200 && last.status < 300) {
      const dropped = signalWarnings(json);
      if (dropped.length > 0) record.notFound = dropped;
    } else if (last.status !== null && last.status >= 400 && last.status < 500) {
      const paths = errorPaths(json);
      if (paths.length > 0) record.errorPaths = paths;
    }
    if (last.error) record.error = this.redact(last.error);
    return { dry: false, status: last.status, json, record };
  }

  private cleanHeaders(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      const key = k.toLowerCase();
      if (key === "set-cookie") out[key] = "[omitted]";
      else out[key] = this.redact(v);
    }
    return out;
  }

  private noteRateHeaders(h: Record<string, string>): void {
    for (const [k, v] of Object.entries(h)) {
      if (/ratelimit|rate-limit|retry-after/i.test(k)) this.rateHeaders[k] = v;
    }
    const rem = h[MONTH_REMAINING_HEADER];
    if (rem !== undefined && rem !== "" && Number.isFinite(Number(rem))) this.monthRemaining = Number(rem);
  }

  private monthBelowFloor(): boolean {
    return this.monthRemaining !== null && this.monthRemaining < this.o.minMonthRemaining;
  }

  private checkMonthFloor(): void {
    if (this.monthBelowFloor()) throw new QuotaGuardError(this.monthRemaining as number, this.o.minMonthRemaining);
  }

  private redact(text: string): string {
    const key = this.o.apiKey;
    return key && key.length >= 4 ? text.split(key).join("[REDACTED]") : text;
  }
}

function baseRecord(spec: RequestSpec, seq: number): CallRecord {
  const record: CallRecord = {
    seq,
    label: spec.label,
    method: spec.method,
    path: spec.path,
    params: { ...spec.params },
    status: null,
    ms: 0,
    bytes: 0,
    attempts: 0,
    memo: false,
    headers: {},
  };
  if (spec.body) record.body = spec.body;
  if (spec.purpose) record.purpose = spec.purpose;
  return record;
}

export function backoffMs(attempt: number, retryAfter: string | undefined): number {
  const secs = retryAfter !== undefined ? Number(retryAfter) : NaN;
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  return 1000 * 2 ** attempt;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
