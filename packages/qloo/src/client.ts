/**
 * QlooClient: the only code path that talks to Qloo.
 *
 * request() order:
 *   fixture mode: fixtures/raw -> fixtures/synthetic -> QlooFixtureMissingError
 *   live mode:    SQLite cache -> month guard -> in-flight dedupe -> token bucket + retries -> cache/record
 * Every call (hit, miss, refusal or failure) writes exactly one ledger entry.
 */
import { join } from "node:path";
import {
  createMemoryLedger,
  type CompareResult,
  type DemographicsBlock,
  type EnvelopeStatus,
  type GeoPoint,
  type HeatCell,
  type LedgerEntry,
  type LedgerSink,
  type QlooEntity,
  type Resolution,
} from "@walkup/contracts";
import {
  buildCompare,
  buildDemographics,
  buildEntitiesByExternal,
  buildEntitiesByIds,
  buildEntityInsights,
  buildHeatmap,
  buildInsights,
  buildPlaceInsights,
  buildSearch,
  buildTagProfile,
  buildTagsSearch,
  type DemographicsOptions,
  type EntityInsightsOptions,
  type HeatmapOptions,
  type PlaceInsightsOptions,
  type SearchOptions,
  type TagProfileOptions,
  type TagsSearchOptions,
} from "./builders";
import { createSqliteCache, type QlooCache } from "./cache";
import { canonicalKey, sha256Hex } from "./canonical";
import { assertAllowedBaseUrl, loadConfig, type EnvLike, type QlooConfig } from "./config";
import {
  isSignalNotFoundError,
  parseQlooErrors,
  QlooConfigError,
  QlooError,
  QlooFixtureMissingError,
  QlooHttpError,
  QlooQuotaGuardError,
} from "./errors";
import { createFileFixtureStore, type FixtureStore } from "./fixtures";
import { buildCurl, ledgerParams, redactString } from "./ledger";
import { globalLimiter, noLimiter, type RateLimiter } from "./limiter";
import {
  countResults,
  droppedSignalIds,
  normalizeCompare,
  normalizeDemographics,
  normalizeEntityList,
  normalizeHeatmap,
  normalizeInsights,
  normalizeTagList,
  responseMeta,
  responseWarnings,
  type InsightsValue,
} from "./normalize";
import { decideFallback, defaultRole, resolveFromEntities, signalAlternates, toCandidate } from "./resolve";
import { send, type FetchLike, type RetryOptions } from "./transport";
import type {
  ExternalMatch,
  Normalized,
  Params,
  QlooRequest,
  QlooResult,
  QlooWarning,
  QuotaSnapshot,
  RankedTag,
  RawResponse,
  ResultMeta,
  SignalCheck,
  SignalEntity,
} from "./types";

export interface QlooClientOptions {
  /** Full config; defaults to loadConfig(env). */
  config?: QlooConfig;
  env?: EnvLike;
  /** Injected fetch (tests, mocks). Defaults to global fetch; refused under vitest. */
  fetch?: FetchLike;
  /** null disables caching. Default: SQLite at <dataDir>/qloo-cache.sqlite, opened on first live call. */
  cache?: QlooCache | null;
  ledger?: LedgerSink;
  fixtures?: FixtureStore;
  /** Default: the process-wide 3 req/s bucket. */
  limiter?: RateLimiter;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  retry?: RetryOptions;
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Skip the cache read (the fresh answer is still cached). */
  fresh?: boolean;
}

export interface ResolveExactOptions {
  requireComedianTag?: boolean;
  /** Venues: search near this point (filter.location + filter.radius in miles). */
  nearPoint?: { lat: number; lon: number };
  /** Miles around nearPoint; default 1. */
  radiusMiles?: number;
  /** /search take; default 10. */
  take?: number;
  role?: Resolution["role"];
  /**
   * Acts: after an exact pick, check with one cheap place-insights call near this point
   * (take 1) that Qloo will use the pick as a signal. A pick Qloo reports as not_found is
   * replaced by the next usable entry from the same search (other exact matches, then
   * `aliases`, then "<name> and ..." billing names). See resolveUsable.
   */
  checkSignalAt?: GeoPoint;
  /** Other billing names for the act, tried after the exact matches when the pick is not_found. */
  aliases?: readonly string[];
}

export interface CheckSignalsOptions {
  /** filter.location.radius in metres; default 1500. */
  radiusM?: number;
}

/** Ids per signal-check call. */
export const SIGNAL_CHECK_BATCH = 25;
/** Most entries a signal check looks at for one name (the pick plus alternates). */
export const SIGNAL_CHECK_MAX_IDS = 6;

/** Ledger envelope status for a 2xx answer. Ignored signal ids make it partial. */
function okStatus(resultCount: number, dropped: readonly string[]): EnvelopeStatus {
  if (dropped.length > 0) return "partial";
  return resultCount > 0 ? "ok" : "empty";
}

/** Ledger note for ignored signal ids (ids are Qloo entity ids, never secrets). */
function droppedNote(dropped: readonly string[]): string {
  const n = dropped.length;
  return `Qloo ignored ${n} signal id${n === 1 ? "" : "s"} it has no taste data for (not_found): ${dropped.join(", ")}`;
}

/** Warnings and dropped ids of a 2xx body, plus the ledger note when ids were dropped. */
function warningInfo(body: unknown): { warnings: QlooWarning[]; dropped: string[]; note: string | null } {
  const warnings = responseWarnings(body);
  const dropped = droppedSignalIds(warnings);
  return { warnings, dropped, note: dropped.length > 0 ? droppedNote(dropped) : null };
}

function withWarnings(r: RawResponse, w: { warnings: QlooWarning[]; dropped: string[] }): RawResponse {
  if (w.warnings.length > 0) r.warnings = w.warnings;
  if (w.dropped.length > 0) r.droppedSignals = w.dropped;
  return r;
}

export interface ExternalLookup {
  entities: QlooEntity[];
  matches: ExternalMatch[];
  /** Requested external ids with no entity. */
  missing: string[];
}

interface FetchOutcome {
  status: number;
  text: string;
  bytes: number;
  latencyMs: number;
  notes: string[];
}

type EntryFields = Pick<LedgerEntry, "httpStatus" | "envelopeStatus" | "latencyMs" | "bytes" | "cacheHit" | "resultCount">;

/** State shared by a client and every withLedger() view of it. */
interface SharedState {
  /** undefined = open the default SQLite file on first use; null = caching disabled. */
  cache: QlooCache | null | undefined;
  ownsCache: boolean;
  quota: QuotaSnapshot;
  quotaLoaded: boolean;
  inflight: Map<string, Promise<FetchOutcome>>;
}

const QUOTA_META = "qloo.quota";

function sameUtcMonth(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth();
}

function withRef<E extends QlooError>(err: E, ref: string): E {
  err.ledgerRef = ref;
  return err;
}

export class QlooClient {
  readonly config: QlooConfig;
  readonly ledger: LedgerSink;
  private readonly fixtures: FixtureStore;
  private readonly state: SharedState;
  private readonly fetchImpl: FetchLike | null;
  private readonly limiter: RateLimiter;
  private readonly now: () => number;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly random: (() => number) | undefined;
  private readonly retry: RetryOptions | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(opts: QlooClientOptions = {}) {
    this.config = opts.config ?? loadConfig(opts.env ?? process.env);
    assertAllowedBaseUrl(this.config.baseUrl, this.config.allowHost);
    if (this.config.mode === "live" && !this.config.apiKey) {
      throw new QlooConfigError("live mode needs QLOO_API_KEY");
    }
    if (this.config.mode === "live" && !opts.fetch && process.env.VITEST) {
      throw new QlooConfigError("tests must inject fetch; refusing to reach the network");
    }
    this.fetchImpl = opts.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
    this.ledger = opts.ledger ?? createMemoryLedger();
    this.fixtures = opts.fixtures ?? createFileFixtureStore(this.config.fixturesDir);
    this.state = {
      cache: opts.cache,
      ownsCache: opts.cache === undefined,
      quota: { remaining: null, limit: null, updatedAt: null },
      quotaLoaded: false,
      inflight: new Map(),
    };
    this.limiter = opts.limiter ?? (this.config.mode === "live" ? globalLimiter() : noLimiter);
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep;
    this.random = opts.random;
    this.retry = opts.retry;
    this.timeoutMs = opts.timeoutMs;
  }

  get mode(): QlooConfig["mode"] {
    return this.config.mode;
  }

  /** Latest month quota seen in x-month-ratelimit-* headers. */
  quota(): QuotaSnapshot {
    return { ...this.currentQuota() };
  }

  /** True when the month guard would refuse a fresh call right now. */
  guardTripped(): boolean {
    const q = this.quota();
    return q.remaining !== null && q.remaining < this.config.monthGuardFloor;
  }

  /**
   * Forgets the remembered month quota (e.g. after Qloo raises the limit).
   * The next live response sets it again.
   */
  resetQuota(): void {
    this.state.quota = { remaining: null, limit: null, updatedAt: null };
    this.state.quotaLoaded = true;
    if (this.config.mode === "live") this.cache()?.setMeta(QUOTA_META, JSON.stringify(this.state.quota));
  }

  /**
   * A view of this client that writes to another ledger (one per plan run)
   * while sharing the cache, quota state, limiter and in-flight requests.
   */
  withLedger(ledger: LedgerSink): QlooClient {
    const view = Object.create(QlooClient.prototype) as QlooClient;
    Object.assign(view, this);
    (view as unknown as { ledger: LedgerSink }).ledger = ledger;
    return view;
  }

  /** Closes the default SQLite cache if this client opened it (shared with its views). */
  close(): void {
    if (this.state.ownsCache && this.state.cache) this.state.cache.close();
    if (this.state.ownsCache) this.state.cache = undefined;
  }

  private cache(): QlooCache | null {
    if (this.state.cache === undefined) {
      this.state.cache = createSqliteCache(join(this.config.dataDir, "qloo-cache.sqlite"));
    }
    return this.state.cache;
  }

  private loadQuota(): void {
    if (this.state.quotaLoaded || this.config.mode !== "live") return;
    this.state.quotaLoaded = true;
    const raw = this.cache()?.getMeta(QUOTA_META);
    if (!raw) return;
    try {
      const q = JSON.parse(raw) as QuotaSnapshot;
      if (typeof q.updatedAt === "number" && sameUtcMonth(q.updatedAt, this.now())) this.state.quota = q;
    } catch {
      // A corrupt meta row only loses the remembered quota; the next response refreshes it.
    }
  }

  /**
   * The remembered quota, forgotten once the UTC month it was read in has ended.
   * Without this a long-running server whose guard tripped late in one month
   * would never make the fresh call that reads the new month's headers.
   */
  private currentQuota(): QuotaSnapshot {
    this.loadQuota();
    const q = this.state.quota;
    if (q.updatedAt !== null && !sameUtcMonth(q.updatedAt, this.now())) {
      this.state.quota = { remaining: null, limit: null, updatedAt: null };
    }
    return this.state.quota;
  }

  private updateQuota(remaining: number | null, limit: number | null): void {
    if (remaining === null && limit === null) return;
    this.state.quota = {
      remaining: remaining ?? this.state.quota.remaining,
      limit: limit ?? this.state.quota.limit,
      updatedAt: this.now(),
    };
    this.cache()?.setMeta(QUOTA_META, JSON.stringify(this.state.quota));
  }

  private secrets(): (string | null)[] {
    return [this.config.apiKey];
  }

  private addEntry(base: Omit<LedgerEntry, "id" | keyof EntryFields | "note">, notes: string[], fields: EntryFields): string {
    const note = redactString(notes.filter(Boolean).join("; "), this.secrets());
    return this.ledger.add({ ...base, ...fields, ...(note ? { note } : {}) });
  }

  private maybeRecord(hash: string, key: string, status: number, body: unknown, overwrite: boolean): void {
    if (!this.config.record || this.config.mode !== "live") return;
    if (!overwrite && this.fixtures.has(hash)) return;
    this.fixtures.write(hash, { key, status, body, recordedAt: new Date(this.now()).toISOString() });
  }

  private async fetchOnce(req: QlooRequest): Promise<FetchOutcome> {
    if (!this.fetchImpl) throw new QlooConfigError("no fetch implementation available");
    const res = await send(req, {
      baseUrl: this.config.baseUrl,
      apiKey: this.config.apiKey ?? "",
      fetch: this.fetchImpl,
      limiter: this.limiter,
      ...(this.retry ? { retry: this.retry } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      ...(this.sleep ? { sleep: this.sleep } : {}),
      ...(this.random ? { random: this.random } : {}),
      now: this.now,
    });
    this.updateQuota(res.monthRemaining, res.monthLimit);
    return { status: res.status, text: res.text, bytes: res.bytes, latencyMs: res.latencyMs, notes: res.retryNotes };
  }

  /** Core: one canonical request -> parsed body. Throws typed errors after writing the ledger entry. */
  async request(req: QlooRequest, opts: RequestOptions = {}): Promise<RawResponse> {
    const key = canonicalKey(req);
    const hash = sha256Hex(key);
    const started = this.now();
    const base = {
      kind: "qloo" as const,
      method: req.method,
      endpoint: req.path,
      params: ledgerParams(req, this.secrets()),
      curl: buildCurl(req, this.config.baseUrl, this.secrets()),
      startedAt: new Date(started).toISOString(),
    };
    const notes: string[] = req.note ? [req.note] : [];
    const emptyOn404 = req.cls === "search" || req.cls === "entities";

    // ---- fixture mode -------------------------------------------------------
    if (this.config.mode === "fixture") {
      const fx = this.fixtures.read(hash);
      if (!fx) {
        notes.push(`fixture missing (${hash.slice(0, 12)})`);
        const ref = this.addEntry(base, notes, {
          httpStatus: null,
          envelopeStatus: "degraded",
          latencyMs: Math.max(0, this.now() - started),
          bytes: 0,
          cacheHit: false,
          resultCount: 0,
        });
        throw withRef(new QlooFixtureMissingError(hash, key), ref);
      }
      notes.push(fx.synthetic ? "fixture replay: synthetic" : `fixture replay: recorded${fx.recordedAt ? ` ${fx.recordedAt.slice(0, 10)}` : ""}`);
      const status = fx.status ?? 200;
      const bytes = Buffer.byteLength(JSON.stringify(fx.body) ?? "", "utf8");
      if (status >= 400 && !(status === 404 && emptyOn404)) {
        const ref = this.addEntry(base, notes, {
          httpStatus: status,
          envelopeStatus: "error",
          latencyMs: Math.max(0, this.now() - started),
          bytes,
          cacheHit: false,
          resultCount: 0,
        });
        throw withRef(new QlooHttpError(status, "fixture recorded an error", req.path, parseQlooErrors(fx.body)), ref);
      }
      const body = status === 404 ? { results: [] } : fx.body;
      const resultCount = countResults(body);
      const w = warningInfo(body);
      if (w.note) notes.push(w.note);
      const ledgerRef = this.addEntry(base, notes, {
        httpStatus: fx.status,
        envelopeStatus: okStatus(resultCount, w.dropped),
        latencyMs: Math.max(0, this.now() - started),
        bytes,
        cacheHit: false,
        resultCount,
      });
      return withWarnings(
        {
          body,
          httpStatus: fx.status,
          ledgerRef,
          source: fx.synthetic ? "fixture-synthetic" : "fixture-raw",
          cacheHit: false,
          bytes,
          key,
          hash,
          resultCount,
        },
        w,
      );
    }

    // ---- live mode: cache ---------------------------------------------------
    const cache = this.cache();
    if (cache && !opts.fresh) {
      const hit = cache.get(key, started);
      if (hit) {
        let body: unknown;
        let parsed = true;
        try {
          body = JSON.parse(hit.body) as unknown;
        } catch {
          parsed = false;
        }
        if (parsed) {
          notes.push(`cache hit (stored ${new Date(hit.storedAt).toISOString().slice(0, 10)})`);
          this.maybeRecord(hash, key, hit.status, body, false);
          const resultCount = countResults(body);
          const bytes = Buffer.byteLength(hit.body, "utf8");
          const w = warningInfo(body);
          if (w.note) notes.push(w.note);
          const ledgerRef = this.addEntry(base, notes, {
            httpStatus: hit.status,
            envelopeStatus: okStatus(resultCount, w.dropped),
            latencyMs: Math.max(0, this.now() - started),
            bytes,
            cacheHit: true,
            resultCount,
          });
          return withWarnings({ body, httpStatus: hit.status, ledgerRef, source: "cache", cacheHit: true, bytes, key, hash, resultCount }, w);
        }
      }
    }

    // ---- month guard --------------------------------------------------------
    const remaining = this.currentQuota().remaining;
    if (remaining !== null && remaining < this.config.monthGuardFloor) {
      notes.push(`month guard: ${remaining} left < ${this.config.monthGuardFloor}; fresh call refused`);
      const ref = this.addEntry(base, notes, {
        httpStatus: null,
        envelopeStatus: "degraded",
        latencyMs: 0,
        bytes: 0,
        cacheHit: false,
        resultCount: 0,
      });
      throw withRef(new QlooQuotaGuardError(remaining, this.config.monthGuardFloor), ref);
    }

    // ---- network (with in-flight dedupe) ------------------------------------
    let outcome: FetchOutcome;
    const existing = this.state.inflight.get(key);
    const shared = existing !== undefined;
    try {
      if (existing) {
        outcome = await existing;
      } else {
        const p = this.fetchOnce(req);
        this.state.inflight.set(key, p);
        try {
          outcome = await p;
        } finally {
          this.state.inflight.delete(key);
        }
      }
    } catch (err) {
      const msg = redactString(err instanceof Error ? err.message : String(err), this.secrets());
      notes.push(msg);
      const ref = this.addEntry(base, notes, {
        httpStatus: null,
        envelopeStatus: "error",
        latencyMs: Math.max(0, this.now() - started),
        bytes: 0,
        cacheHit: false,
        resultCount: 0,
      });
      if (err instanceof QlooError) {
        err.message = redactString(err.message, this.secrets());
        throw withRef(err, ref);
      }
      throw withRef(new QlooError(msg), ref);
    }

    if (shared) notes.push("shared an identical in-flight request");
    else notes.push(...outcome.notes);
    const status = outcome.status;
    let body: unknown;
    let cacheText = outcome.text;
    if (status >= 200 && status < 300) {
      try {
        body = JSON.parse(outcome.text) as unknown;
      } catch {
        const ref = this.addEntry(base, notes, {
          httpStatus: status,
          envelopeStatus: "error",
          latencyMs: outcome.latencyMs,
          bytes: outcome.bytes,
          cacheHit: false,
          resultCount: 0,
        });
        throw withRef(new QlooHttpError(status, "response was not JSON", req.path), ref);
      }
    } else if (status === 404 && emptyOn404) {
      body = { results: [] };
      cacheText = JSON.stringify(body);
      notes.push("HTTP 404: no match");
    } else {
      // Redact before cutting: a key straddling the cut would otherwise leak its first characters.
      const redacted = redactString(outcome.text, this.secrets());
      const snippet = redacted.slice(0, 300);
      const qlooErrors = parseQlooErrors(redacted);
      notes.push(`HTTP ${status}`);
      const blamed = [...new Set(qlooErrors.map((e) => e.path).filter((x): x is string => !!x))];
      if (blamed.length > 0) notes.push(`Qloo blamed ${blamed.join(", ")}`);
      const ref = this.addEntry(base, notes, {
        httpStatus: status,
        envelopeStatus: "error",
        latencyMs: outcome.latencyMs,
        bytes: outcome.bytes,
        cacheHit: false,
        resultCount: 0,
      });
      throw withRef(new QlooHttpError(status, snippet, req.path, qlooErrors), ref);
    }

    if (!shared) {
      cache?.set(key, req.cls, { body: cacheText, status }, this.now());
      this.maybeRecord(hash, key, status, body, true);
    }
    const resultCount = countResults(body);
    const w = warningInfo(body);
    if (w.note) notes.push(w.note);
    const ledgerRef = this.addEntry(base, notes, {
      httpStatus: status,
      envelopeStatus: okStatus(resultCount, w.dropped),
      latencyMs: shared ? Math.max(0, this.now() - started) : outcome.latencyMs,
      bytes: outcome.bytes,
      cacheHit: shared,
      resultCount,
    });
    return withWarnings(
      {
        body,
        httpStatus: status,
        ledgerRef,
        source: shared ? "inflight" : "live",
        cacheHit: shared,
        bytes: outcome.bytes,
        key,
        hash,
        resultCount,
      },
      w,
    );
  }

  // -------------------------------------------------------------------------
  // Result wrapping
  // -------------------------------------------------------------------------

  private wrap<T>(raws: RawResponse[], n: Normalized<T>, isEmpty: (v: T) => boolean, meta?: ResultMeta): QlooResult<T> {
    const refs = raws.map((r) => r.ledgerRef);
    const first = raws[0];
    const r: QlooResult<T> = {
      value: n.value,
      status: isEmpty(n.value) ? "empty" : "ok",
      ledgerRef: refs[0] ?? "",
      ledgerRefs: refs,
      cacheHit: raws.length > 0 && raws.every((x) => x.cacheHit),
      source: first?.source ?? "live",
      synthetic: raws.some((x) => x.source === "fixture-synthetic"),
    };
    if (n.reason) r.reason = n.reason;
    const m: ResultMeta = { ...meta };
    if (n.skipped > 0) m.skipped = n.skipped;
    if (Object.keys(m).length > 0) r.meta = m;
    return r;
  }

  // -------------------------------------------------------------------------
  // Typed methods
  // -------------------------------------------------------------------------

  /** GET /search: flat results[]. 404 = empty. */
  async search(query: string, types: readonly string[], opts: SearchOptions = {}): Promise<QlooResult<QlooEntity[]>> {
    const raw = await this.request(buildSearch(query, types, opts));
    return this.wrap([raw], normalizeEntityList(raw.body), (v) => v.length === 0);
  }

  /** GET /entities?entity_ids=... in batches of 50. */
  async entitiesByIds(ids: readonly string[]): Promise<QlooResult<QlooEntity[]>> {
    const reqs = buildEntitiesByIds(ids);
    const raws: RawResponse[] = [];
    const value: QlooEntity[] = [];
    const reasons: string[] = [];
    let skipped = 0;
    for (const req of reqs) {
      const raw = await this.request(req);
      raws.push(raw);
      const n = normalizeEntityList(raw.body);
      value.push(...n.value);
      skipped += n.skipped;
      if (n.reason) reasons.push(n.reason);
    }
    const n: Normalized<QlooEntity[]> = { value, skipped };
    if (reqs.length === 0) n.reason = "no ids given";
    else if (reasons.length > 0) n.reason = reasons.join("; ");
    return this.wrap(raws, n, (v) => v.length === 0);
  }

  /** GET /entities?external.<ns>.ids=... (e.g. spotify), in batches of 50, with id matches. */
  async entitiesByExternal(ns: string, ids: readonly string[]): Promise<QlooResult<ExternalLookup>> {
    const reqs = buildEntitiesByExternal(ns, ids);
    const raws: RawResponse[] = [];
    const entities: QlooEntity[] = [];
    const reasons: string[] = [];
    let skipped = 0;
    for (const req of reqs) {
      const raw = await this.request(req);
      raws.push(raw);
      const n = normalizeEntityList(raw.body);
      entities.push(...n.value);
      skipped += n.skipped;
      if (n.reason) reasons.push(n.reason);
    }
    const wanted = new Set(ids.map((s) => s.trim()).filter(Boolean));
    const matches: ExternalMatch[] = [];
    const found = new Set<string>();
    for (const e of entities) {
      for (const extId of externalIds(e.external?.[ns])) {
        if (wanted.has(extId) && !found.has(extId)) {
          found.add(extId);
          matches.push({ externalId: extId, entityId: e.entityId });
        }
      }
    }
    const missing = [...wanted].filter((id) => !found.has(id));
    const n: Normalized<ExternalLookup> = { value: { entities, matches, missing }, skipped };
    if (reqs.length === 0) n.reason = "no ids given";
    else if (reasons.length > 0) n.reason = reasons.join("; ");
    return this.wrap(raws, n, (v) => v.entities.length === 0);
  }

  /** Generic GET /v2/insights (every Qloo call is a GET with plain entity ids). */
  async insights(params: Params, opts: { signalEntities?: SignalEntity[] } = {}): Promise<QlooResult<InsightsValue>> {
    const raw = await this.request(buildInsights(params, opts));
    const n = normalizeInsights(raw.body);
    const v = n.value;
    return this.wrap(
      [raw],
      n,
      () => v.entities.length + v.heatmap.length + v.demographics.length + v.tags.length === 0,
      responseMeta(raw.body),
    );
  }

  /**
   * filter.type=urn:heatmap around a WKT point. Cells are percentiles within this one response.
   * Live (Oct 15): a not_found signal id is dropped without a warning, and a heatmap left with only
   * not_found ids still answers 200 with cells (probe 2: 814 cells for the not_found id alone). Only a
   * malformed id is a 400. So a heatmap never says whether a seed was usable: check seeds with
   * checkSignals (the insights check) first.
   */
  async heatmap(o: HeatmapOptions): Promise<QlooResult<HeatCell[]>> {
    const raw = await this.request(buildHeatmap(o));
    return this.wrap([raw], normalizeHeatmap(raw.body), (v) => v.length === 0, responseMeta(raw.body));
  }

  /** filter.type=urn:demographics: one block per signal entity (live: a not_found id still gets a block, no warning). */
  async demographics(entityIds: readonly string[], o: DemographicsOptions = {}): Promise<QlooResult<DemographicsBlock[]>> {
    const raw = await this.request(buildDemographics(entityIds, o));
    return this.wrap([raw], normalizeDemographics(raw.body), (v) => v.length === 0, responseMeta(raw.body));
  }

  /** filter.type=urn:entity:place with stacked constraints and explainability. */
  async placeInsights(o: PlaceInsightsOptions): Promise<QlooResult<QlooEntity[]>> {
    const raw = await this.request(buildPlaceInsights(o));
    return this.wrap([raw], normalizeEntityList(raw.body), (v) => v.length === 0, responseMeta(raw.body));
  }

  /** filter.type=urn:entity:<type> (podcast, brand, artist, ...), optional signal.location. */
  async entityInsights(type: string, o: EntityInsightsOptions = {}): Promise<QlooResult<QlooEntity[]>> {
    const raw = await this.request(buildEntityInsights(type, o));
    return this.wrap([raw], normalizeEntityList(raw.body), (v) => v.length === 0, responseMeta(raw.body));
  }

  /** filter.type=urn:tag: the tag profile of a set of entities, in rank order (live: not_found ids dropped silently). */
  async tagProfile(o: TagProfileOptions): Promise<QlooResult<RankedTag[]>> {
    const raw = await this.request(buildTagProfile(o));
    return this.wrap([raw], normalizeTagList(raw.body), (v) => v.length === 0, responseMeta(raw.body));
  }

  /**
   * GET /v2/analysis/compare: shared tags plus a/b distinctive tags. Qloo ignores `take` here
   * (live, Oct 15: take=30 gave 44/47/27 rows, take=5 gave 46/39/27), so each list is cut to
   * `take` client-side. not_found ids are dropped silently.
   */
  async compare(a: readonly string[], b: readonly string[], take?: number, extra?: Params): Promise<QlooResult<CompareResult>> {
    const req = buildCompare(a, b, take, extra);
    const raw = await this.request(req);
    const n = normalizeCompare(raw.body);
    const cap = req.params.take;
    if (typeof cap === "number") {
      n.value = { ...n.value, shared: n.value.shared.slice(0, cap), a: n.value.a.slice(0, cap), b: n.value.b.slice(0, cap) };
    }
    return this.wrap([raw], n, (v) => v.shared.length + v.a.length + v.b.length === 0, responseMeta(raw.body));
  }

  /** GET /v2/tags: tag lookup for pinning (build time). */
  async tagsSearch(query: string, o: TagsSearchOptions = {}): Promise<QlooResult<RankedTag[]>> {
    const raw = await this.request(buildTagsSearch(query, o));
    return this.wrap([raw], normalizeTagList(raw.body), (v) => v.length === 0);
  }

  /**
   * Which of these entity ids Qloo will use as a taste signal. One cheap call per 25 ids:
   * GET /v2/insights filter.type=urn:entity:place, the ids as signal.interests.entities,
   * filter.location=POINT near `point`, radius 1500 m, take=1. Qloo answers 200 with a top-level
   * warnings[{type:"not_found","signal.interests.entities":[ids]}] for ids it has no data for
   * (live, Oct 15: one call lists only the dropped ids). A 400 that blames signal.interests.entities
   * means none were usable. A 200 is cached like any insights call (7 days); a 400 is not cached, so the
   * next check asks again. The ledger notes each drop, and `ledgerRefById` names the batch call per id.
   * Heatmaps, tag profiles, demographics and compare do not warn, so they cannot be used for this.
   */
  async checkSignals(ids: readonly string[], point: GeoPoint, o: CheckSignalsOptions = {}): Promise<SignalCheck> {
    const checked = [...new Set(ids.map((s) => s.trim()).filter(Boolean))];
    const out: SignalCheck = { checked, usable: [], dropped: [], ledgerRefs: [], ledgerRefById: {}, cacheHit: true };
    if (checked.length === 0) return out;
    for (let i = 0; i < checked.length; i += SIGNAL_CHECK_BATCH) {
      const batch = checked.slice(i, i + SIGNAL_CHECK_BATCH);
      const req = buildPlaceInsights({ signalEntities: batch, point, radiusM: o.radiusM ?? 1500, take: 1 });
      req.note = "signal check: which ids Qloo has taste data for";
      try {
        const raw = await this.request(req);
        out.ledgerRefs.push(raw.ledgerRef);
        for (const id of batch) out.ledgerRefById[id] = raw.ledgerRef;
        if (!raw.cacheHit) out.cacheHit = false;
        const dropped = new Set(raw.droppedSignals ?? []);
        for (const id of batch) (dropped.has(id) ? out.dropped : out.usable).push(id);
      } catch (err) {
        if (!isSignalNotFoundError(err)) throw err;
        if (err.ledgerRef) {
          out.ledgerRefs.push(err.ledgerRef);
          for (const id of batch) out.ledgerRefById[id] = err.ledgerRef;
        }
        out.cacheHit = false;
        out.dropped.push(...batch);
      }
    }
    return out;
  }

  /**
   * Resolution from entities already fetched (typed /search), with a signal check when
   * `checkSignalAt` is given (never for venues). Without it this is resolveFromEntities.
   *
   * With it, the pick (or the needs_input candidates) and up to five fallback entries are checked in
   * one checkSignals call, and an entry Qloo reports as not_found is never used:
   *  - exact pick usable: returned as is;
   *  - exact pick dropped: the first tier of signalAlternates with a usable entry decides (decideFallback).
   *    One usable entry: status "exact" on it, with `replaced` naming the dropped pick and citing the batch
   *    call that dropped it; when that entry has another billing name, or entries of its tier (or an earlier
   *    one) were never checked, `reason` says so for the sheet. Several: needs_input with those (nothing
   *    ambiguous is resolved silently). None: unresolved with a reason;
   *  - needs_input: dropped candidates are removed (unresolved when none is left).
   */
  async resolveUsable(
    name: string,
    entities: readonly QlooEntity[],
    opts: ResolveExactOptions & { ledgerRef?: string } = {},
  ): Promise<Resolution> {
    const role = opts.role ?? "headliner";
    const requireComedianTag = opts.requireComedianTag ?? false;
    const res = resolveFromEntities(name, entities, { role, requireComedianTag, ...(opts.ledgerRef ? { ledgerRef: opts.ledgerRef } : {}) });
    const at = opts.checkSignalAt;
    if (!at || role === "venue" || res.status === "unresolved") return res;

    if (res.status === "exact" && res.entity) {
      const pick = res.entity;
      const tiers = signalAlternates(name, entities, {
        ...(opts.aliases ? { aliases: opts.aliases } : {}),
        requireComedianTag,
        exclude: new Set([pick.entityId]),
        subtype: pick.subtype,
      });
      const alternates = tiers.flat().slice(0, SIGNAL_CHECK_MAX_IDS - 1);
      const check = await this.checkSignals([pick.entityId, ...alternates.map((e) => e.entityId)], at);
      const dropped = new Set(check.dropped);
      if (!dropped.has(pick.entityId)) return res;
      // Cite the batch call that dropped the pick, not just the first batch.
      const checkRef = check.ledgerRefById[pick.entityId] ?? check.ledgerRefs[0];
      const replaced = { entityId: pick.entityId, name: pick.name, reason: "not_found" as const, ...(checkRef ? { ledgerRef: checkRef } : {}) };
      const { entity: _dropped, ...rest } = res;
      const decision = decideFallback(name, tiers, new Set(check.checked), dropped);
      if (decision.kind === "use" && decision.entity) {
        return { ...rest, status: "exact", entity: decision.entity, replaced, ...(decision.note ? { reason: decision.note } : {}) };
      }
      if (decision.kind === "ask" && decision.candidates) {
        return {
          ...rest,
          status: "needs_input",
          candidates: decision.candidates.map(toCandidate),
          replaced,
          reason: `Qloo's first match for "${name}" has no taste data. Pick the entry that matches this act.`,
        };
      }
      return {
        ...rest,
        status: "unresolved",
        replaced,
        reason: `Qloo lists "${name}" but has no taste data for it, so the run can't use this act.`,
      };
    }

    if (res.status === "needs_input" && res.candidates && res.candidates.length > 0) {
      const ids = res.candidates.slice(0, SIGNAL_CHECK_MAX_IDS).map((c) => c.entityId);
      const check = await this.checkSignals(ids, at);
      if (check.dropped.length === 0) return res;
      const dropped = new Set(check.dropped);
      const candidates = res.candidates.filter((c) => !dropped.has(c.entityId));
      if (candidates.length === 0) {
        const { candidates: _none, ...rest } = res;
        return { ...rest, status: "unresolved", reason: `Qloo lists "${name}" but has no taste data for any match, so the run can't use this act.` };
      }
      const n = check.dropped.length;
      return { ...res, candidates, reason: `Left out ${n} match${n === 1 ? "" : "es"} Qloo has no taste data for.` };
    }
    return res;
  }

  /**
   * Typed /search, then exact normalized-name match only. One admissible exact
   * match -> "exact"; several, or none with results -> "needs_input" (<= 5
   * candidates); no results -> "unresolved". With `checkSignalAt` (acts), the
   * result goes through resolveUsable: an entry Qloo has no taste data for is never used.
   */
  async resolveExact(name: string, types: readonly string[], opts: ResolveExactOptions = {}): Promise<Resolution> {
    const search: SearchOptions = { take: opts.take ?? 10 };
    if (opts.nearPoint) {
      search.location = opts.nearPoint;
      search.radiusMiles = opts.radiusMiles ?? 1;
    }
    const r = await this.search(name, types, search);
    return this.resolveUsable(name, r.value, { ...opts, role: opts.role ?? defaultRole(types), ledgerRef: r.ledgerRef });
  }
}

/** External ids as Qloo returns them: [{id}], {id}, "id" or ["id"]. */
function externalIds(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v.trim()];
  if (typeof v === "number") return [String(v)];
  if (Array.isArray(v)) return v.flatMap(externalIds);
  if (typeof v === "object") {
    const r = v as Record<string, unknown>;
    return externalIds(r.id ?? r.ids ?? r.value);
  }
  return [];
}

export function createQlooClient(opts: QlooClientOptions = {}): QlooClient {
  return new QlooClient(opts);
}
