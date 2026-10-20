import { createMemoryLedger, type EnvelopeStatus, type LedgerSink } from "@walkup/contracts";
import { toTmDateTime } from "./dates";
import {
  createMemoryCounterStore,
  createRateLimiter,
  realSleep,
  utcDayKey,
  type Clock,
  type DailyCounterStore,
  type Sleep,
} from "./limits";
import type {
  TmEvent,
  TmEventSearchResponse,
  TmEventSort,
  TmPage,
  TmVenue,
  TmVenueSearchResponse,
} from "./types";

export const TM_BASE_URL = "https://app.ticketmaster.com/discovery/v2";
export const TM_KEY_ENV = "TICKETMASTER_API_KEY";
/** What the ledger and copy-as-curl show instead of the key. */
export const TM_KEY_REF = "$TICKETMASTER_API_KEY";
export const TM_MAX_PAGE_SIZE = 200;
/** Discovery refuses deep pages: page * size must stay under 1000. */
export const TM_MAX_DEEP_RESULTS = 1000;
export const TM_RATE_PER_SECOND = 5;
export const TM_DAILY_LIMIT = 5000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TmUsage {
  day: string; // UTC day key
  used: number;
  limit: number;
  warnAt: number;
}

export interface TmClientOptions {
  /** Defaults to process.env.TICKETMASTER_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Ledger ids ("T1", "T2", ...) come from this sink. Defaults to a private in-memory ledger. */
  ledger?: LedgerSink;
  now?: Clock;
  sleep?: Sleep;
  /** Default 5 (Discovery's per-second limit). */
  ratePerSecond?: number;
  /** Requests per UTC day before the client refuses to send. Default 5000. */
  dailyLimit?: number;
  /** Count at which onQuotaWarning fires (once per day). Default 90% of dailyLimit. */
  dailyWarnAt?: number;
  counterStore?: DailyCounterStore;
  onQuotaWarning?: (usage: TmUsage) => void;
  /** Retries on 429 and 5xx. Default 2. */
  maxRetries?: number;
  userAgent?: string;
}

export interface TmResult<T> {
  data: T;
  ledgerRef: string;
  httpStatus: number | null;
  page?: TmPage;
}

export class TmError extends Error {
  readonly status: number | null;
  readonly ledgerRef: string | undefined;
  constructor(message: string, status: number | null, ledgerRef?: string) {
    super(message);
    this.name = "TmError";
    this.status = status;
    this.ledgerRef = ledgerRef;
  }
}

export class TmQuotaError extends TmError {
  constructor(message: string, ledgerRef?: string) {
    super(message, null, ledgerRef);
    this.name = "TmQuotaError";
  }
}

export interface DateWindow {
  /** Date, "YYYY-MM-DD" or zoned ISO string; sent as YYYY-MM-DDTHH:mm:ssZ. */
  startDateTime?: string | Date;
  endDateTime?: string | Date;
}

export interface EventsByVenueOptions extends DateWindow {
  /** 1..200. Default 60 (the house-roster window). */
  size?: number;
  page?: number;
  /** Default "date,asc". */
  sort?: TmEventSort | (string & {});
}

export interface SearchEventsOptions extends DateWindow {
  keyword?: string;
  city?: string;
  stateCode?: string;
  countryCode?: string;
  classificationName?: string;
  size?: number;
  page?: number;
  sort?: TmEventSort | (string & {});
}

export interface SearchVenuesOptions {
  stateCode?: string;
  countryCode?: string;
  size?: number;
  page?: number;
}

export interface TmClient {
  getEvent(id: string): Promise<TmResult<TmEvent | null>>;
  eventsByVenue(venueId: string, opts?: EventsByVenueOptions): Promise<TmResult<TmEvent[]>>;
  searchEvents(opts: SearchEventsOptions): Promise<TmResult<TmEvent[]>>;
  searchVenues(keyword: string, opts?: SearchVenuesOptions): Promise<TmResult<TmVenue[]>>;
  usage(): Promise<TmUsage>;
  readonly ledger: LedgerSink;
}

type ParamValue = string | number | undefined | null;

interface RawOutcome {
  status: number | null;
  body: unknown;
  text: string;
  ledgerRef: string;
}

export function createTmClient(options: TmClientOptions = {}): TmClient {
  const apiKey = options.apiKey ?? process.env[TM_KEY_ENV] ?? "";
  const baseUrl = (options.baseUrl ?? TM_BASE_URL).replace(/\/+$/, "");
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const ledger = options.ledger ?? createMemoryLedger();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const dailyLimit = options.dailyLimit ?? TM_DAILY_LIMIT;
  const warnAt = options.dailyWarnAt ?? Math.floor(dailyLimit * 0.9);
  const store = options.counterStore ?? createMemoryCounterStore();
  const maxRetries = options.maxRetries ?? 2;
  const onWarn =
    options.onQuotaWarning ??
    ((u: TmUsage) => console.warn(`[tm] ${u.used}/${u.limit} Discovery requests used on ${u.day} (UTC).`));
  const limiter = createRateLimiter({
    maxPerWindow: options.ratePerSecond ?? TM_RATE_PER_SECOND,
    windowMs: 1000,
    now,
    sleep,
  });
  const warnedDays = new Set<string>();
  // Check-and-count runs one caller at a time, so concurrent calls cannot all pass the cap check.
  let quotaGate: Promise<unknown> = Promise.resolve();
  function reserve(day: string): Promise<{ sent: true; count: number } | { sent: false; used: number }> {
    const run = quotaGate.then(async () => {
      const used = await store.get(day);
      if (used >= dailyLimit) return { sent: false as const, used };
      return { sent: true as const, count: await store.increment(day) };
    });
    quotaGate = run.catch(() => undefined);
    return run;
  }

  const redact = (s: string): string => (apiKey ? s.split(apiKey).join(TM_KEY_REF) : s);

  async function request(path: string, params: Record<string, ParamValue>, note: string[], countOf: (body: unknown) => number, okStatuses: number[] = []): Promise<RawOutcome> {
    if (!apiKey) throw new TmError(`${TM_KEY_ENV} is not set`, null);

    const clean: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      clean[k] = v;
    }
    const qs = new URLSearchParams(Object.entries(clean).map(([k, v]) => [k, String(v)])).toString();
    const sep = qs ? "&" : "";
    const url = `${baseUrl}${path}?${qs}${sep}apikey=${encodeURIComponent(apiKey)}`;
    const curl = `curl -s "${baseUrl}${path}?${qs}${sep}apikey=${TM_KEY_REF}"`;
    const endpoint = `${basePath}${path}`;
    const ledgerParams: Record<string, string | number> = { ...clean, apikey: TM_KEY_REF };
    const startedMs = now();
    const startedAt = new Date(startedMs).toISOString();

    let attempt = 0;
    for (;;) {
      const day = utcDayKey(now());
      const slot = await reserve(day);
      if (!slot.sent) {
        const ledgerRef = ledger.add({
          kind: "tm",
          method: "GET",
          endpoint,
          params: ledgerParams,
          httpStatus: null,
          envelopeStatus: "error",
          latencyMs: 0,
          bytes: 0,
          cacheHit: false,
          resultCount: 0,
          curl,
          startedAt,
          note: `not sent: daily cap ${dailyLimit} reached for ${day} (UTC)`,
        });
        throw new TmQuotaError(`Ticketmaster daily cap reached (${slot.used}/${dailyLimit} on ${day} UTC)`, ledgerRef);
      }
      if (slot.count >= warnAt && !warnedDays.has(day)) {
        warnedDays.add(day);
        onWarn({ day, used: slot.count, limit: dailyLimit, warnAt });
      }

      await limiter.acquire();

      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers: { Accept: "application/json", ...(options.userAgent ? { "User-Agent": options.userAgent } : {}) },
        });
      } catch (err) {
        const msg = redact(err instanceof Error ? err.message : String(err));
        const ledgerRef = ledger.add({
          kind: "tm",
          method: "GET",
          endpoint,
          params: ledgerParams,
          httpStatus: null,
          envelopeStatus: "error",
          latencyMs: now() - startedMs,
          bytes: 0,
          cacheHit: false,
          resultCount: 0,
          curl,
          startedAt,
          note: [...note, `network error: ${msg}`].join("; "),
        });
        throw new TmError(`Ticketmaster request failed: ${msg}`, null, ledgerRef);
      }

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        attempt += 1;
        await res.text().catch(() => "");
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1));
        continue;
      }
      if (attempt > 0) note.push(`retried ${attempt}x`);

      const text = await res.text();
      const bytes = new TextEncoder().encode(text).length;
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      // A 2xx that is not a JSON object (proxy page, truncated body) is a failure, not an empty roster.
      const notJson = res.ok && !isObject(body);
      if (notJson) note.push("response was not a JSON object");
      const ok = (res.ok && !notJson) || okStatuses.includes(res.status);
      const resultCount = res.ok ? countOf(body) : 0;
      const envelopeStatus: EnvelopeStatus = !ok ? "error" : resultCount > 0 ? "ok" : "empty";
      if (!res.ok && ok) note.push(`HTTP ${res.status} treated as empty`);
      const ledgerRef = ledger.add({
        kind: "tm",
        method: "GET",
        endpoint,
        params: ledgerParams,
        httpStatus: res.status,
        envelopeStatus,
        latencyMs: now() - startedMs,
        bytes,
        cacheHit: false,
        resultCount,
        curl,
        startedAt,
        ...(note.length > 0 ? { note: note.join("; ") } : {}),
      });
      if (!ok) {
        const detail = notJson ? "response was not a JSON object" : errorDetail(body, text);
        throw new TmError(`Ticketmaster HTTP ${res.status}: ${redact(detail)}`, res.status, ledgerRef);
      }
      return { status: res.status, body, text, ledgerRef };
    }
  }

  function sizeParam(size: number | undefined, fallback: number, note: string[]): number {
    const want = size ?? fallback;
    const clamped = Math.min(TM_MAX_PAGE_SIZE, Math.max(1, Math.floor(want)));
    if (clamped !== want) note.push(`size clamped from ${want} to ${clamped}`);
    return clamped;
  }

  function checkDeepPaging(size: number, page: number | undefined): void {
    if (page !== undefined && (page + 1) * size > TM_MAX_DEEP_RESULTS) {
      throw new RangeError(`Discovery deep paging limit: (page + 1) * size must be <= ${TM_MAX_DEEP_RESULTS}`);
    }
  }

  const dt = (v: string | Date | undefined): string | undefined => (v === undefined ? undefined : toTmDateTime(v));

  async function eventSearch(params: Record<string, ParamValue>, note: string[]): Promise<TmResult<TmEvent[]>> {
    const out = await request("/events.json", params, note, (b) => eventsOf(b).length);
    return { data: eventsOf(out.body), ledgerRef: out.ledgerRef, httpStatus: out.status, ...pageOf(out.body) };
  }

  return {
    ledger,

    async getEvent(id) {
      if (!id.trim()) throw new RangeError("event id is empty");
      const out = await request(
        `/events/${encodeURIComponent(id.trim())}.json`,
        {},
        [],
        (b) => (isEvent(b) ? 1 : 0),
        [404],
      );
      return { data: out.status === 404 || !isEvent(out.body) ? null : out.body, ledgerRef: out.ledgerRef, httpStatus: out.status };
    },

    async eventsByVenue(venueId, opts = {}) {
      if (!venueId.trim()) throw new RangeError("venueId is empty");
      const note: string[] = [];
      const size = sizeParam(opts.size, 60, note);
      checkDeepPaging(size, opts.page);
      return eventSearch(
        {
          venueId: venueId.trim(),
          startDateTime: dt(opts.startDateTime),
          endDateTime: dt(opts.endDateTime),
          size,
          page: opts.page,
          sort: opts.sort ?? "date,asc",
        },
        note,
      );
    },

    async searchEvents(opts) {
      const note: string[] = [];
      const size = sizeParam(opts.size, 20, note);
      checkDeepPaging(size, opts.page);
      return eventSearch(
        {
          keyword: opts.keyword,
          city: opts.city,
          stateCode: opts.stateCode,
          countryCode: opts.countryCode,
          classificationName: opts.classificationName,
          startDateTime: dt(opts.startDateTime),
          endDateTime: dt(opts.endDateTime),
          size,
          page: opts.page,
          sort: opts.sort,
        },
        note,
      );
    },

    async searchVenues(keyword, opts = {}) {
      const note: string[] = [];
      const size = sizeParam(opts.size, 20, note);
      checkDeepPaging(size, opts.page);
      const out = await request(
        "/venues.json",
        { keyword, stateCode: opts.stateCode, countryCode: opts.countryCode, size, page: opts.page },
        note,
        (b) => venuesOf(b).length,
      );
      return { data: venuesOf(out.body), ledgerRef: out.ledgerRef, httpStatus: out.status, ...pageOf(out.body) };
    },

    async usage() {
      const day = utcDayKey(now());
      return { day, used: await store.get(day), limit: dailyLimit, warnAt };
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEvent(v: unknown): v is TmEvent {
  return isObject(v) && typeof v.id === "string";
}

function eventsOf(body: unknown): TmEvent[] {
  if (!isObject(body)) return [];
  const list = (body as TmEventSearchResponse)._embedded?.events;
  return Array.isArray(list) ? list.filter(isEvent) : [];
}

function venuesOf(body: unknown): TmVenue[] {
  if (!isObject(body)) return [];
  const list = (body as TmVenueSearchResponse)._embedded?.venues;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function pageOf(body: unknown): { page?: TmPage } {
  if (!isObject(body) || !isObject(body.page)) return {};
  const p = body.page;
  const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : 0);
  return { page: { size: n("size"), totalElements: n("totalElements"), totalPages: n("totalPages"), number: n("number") } };
}

/** Discovery errors come as {fault:{faultstring}} (gateway) or {errors:[{detail}]} (API). */
function errorDetail(body: unknown, text: string): string {
  if (isObject(body)) {
    const fault = body.fault;
    if (isObject(fault) && typeof fault.faultstring === "string") return fault.faultstring;
    const errors = body.errors;
    if (Array.isArray(errors) && isObject(errors[0])) {
      const e = errors[0];
      if (typeof e.detail === "string") return e.detail;
    }
  }
  return text.slice(0, 200);
}
