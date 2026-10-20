/**
 * Local types for @walkup/qloo. Shared shapes (QlooEntity, HeatCell, ...)
 * come from @walkup/contracts; these are the request/response plumbing.
 */
import type { EnvelopeStatus, QlooTag } from "@walkup/contracts";

/** A query/body parameter value before serialization. null/undefined/""/[] are dropped. */
export type ParamValue = string | number | boolean | string[] | null | undefined;
export type Params = Record<string, ParamValue>;

/** Same value space as LedgerEntry.params. */
export type LedgerParamValue = string | number | boolean | string[] | null;

/**
 * Request classes drive the cache TTL:
 * search/entities/tags 30 d; insights/heatmap/compare 7 d. "audiences" names no request the client sends
 * any more (/v2/audiences returned nothing on Oct 15, probe 17); it stays only so the sealed P1 eval's cache
 * config keeps type-checking.
 */
export type RequestClass = "search" | "entities" | "tags" | "audiences" | "insights" | "heatmap" | "compare";

/** Every Qloo call is a GET: POST /v2/insights with weighted signals returned 400 on Oct 15 (probe 14) and was removed. */
export type HttpMethod = "GET";

/** A signal entity id (plain id; nothing weights one act against another). */
export type SignalEntity = string;

export interface QlooRequest {
  method: HttpMethod;
  /** Path only, e.g. "/v2/insights". */
  path: string;
  /** GET query params (flat dotted keys). */
  params: Params;
  cls: RequestClass;
  /** Builder note copied into the ledger (e.g. "weights ignored: GET"). */
  note?: string;
}

export type QlooMode = "live" | "fixture";
export type RequestedMode = "auto" | QlooMode;

export type ResponseSource = "live" | "cache" | "inflight" | "fixture-raw" | "fixture-synthetic";

/** What the core request() returns: the parsed body plus where it came from. */
export interface RawResponse {
  body: unknown;
  httpStatus: number | null;
  ledgerRef: string;
  source: ResponseSource;
  cacheHit: boolean;
  bytes: number;
  /** Canonical request key (no secrets). */
  key: string;
  /** sha256 of the key; also the fixture file name. */
  hash: string;
  resultCount: number;
  /** Top-level `warnings[]` of a 2xx body (absent when there were none). */
  warnings?: QlooWarning[];
  /** Signal ids Qloo reported as not_found and left out of the answer (absent when none). */
  droppedSignals?: string[];
}

/**
 * One entry of a 2xx body's top-level `warnings[]`. Live shape (Oct 15):
 * `{"type":"not_found","signal.interests.entities":["<id>"]}`: the key is the
 * literal dotted parameter name, the value the ids Qloo ignored.
 */
export interface QlooWarning {
  /** e.g. "not_found". */
  type: string;
  /** The request parameter the ids came from, e.g. "signal.interests.entities". */
  param?: string;
  ids: string[];
  message?: string;
}

/** Result of QlooClient.checkSignals: which ids Qloo will use as a taste signal. */
export interface SignalCheck {
  /** Ids sent, de-duplicated, in order. */
  checked: string[];
  /** Ids Qloo kept. */
  usable: string[];
  /** Ids Qloo reported as not_found (or all of them, when it refused the call with a 400 on signal.interests.entities). */
  dropped: string[];
  /** Ledger ids of the check calls (one per batch of 25). */
  ledgerRefs: string[];
  /** Per checked id: the ledger id of the batch call that judged it (cite this for a swap, not ledgerRefs[0]). */
  ledgerRefById: Record<string, string>;
  cacheHit: boolean;
}

/** Normalizer output: never throws, reports why a shape was not understood. */
export interface Normalized<T> {
  value: T;
  /** Set when the body did not have the expected shape (value is then empty). */
  reason?: string;
  /** Rows dropped because a required field (id, geohash, ...) was missing. */
  skipped: number;
}

/** Extra response-level data some helpers surface. */
export interface ResultMeta {
  /**
   * Response-level query.explainability, passed through as returned. Live shape (Oct 15):
   * `{"signal.interests.entities": {effect_on_all_recs|effect_on_top3_recs|top5|top10: [{entity_id, avg_score}]}}`.
   */
  explainability?: unknown;
  /** Top-level `warnings[]` of the body, when Qloo sent any. */
  warnings?: QlooWarning[];
  /**
   * Signal ids Qloo ignored (warnings of type not_found on any *signal.interests.entities param).
   * The answer was computed without them. Entity insights (places, brands, podcasts, ...) report this;
   * heatmaps, tag profiles and compare drop such ids without a warning (live, Oct 15).
   */
  droppedSignals?: string[];
  skipped?: number;
}

export interface QlooResult<T> {
  value: T;
  /** ok | empty for successful calls (callers decide needs_input/partial/degraded). */
  status: EnvelopeStatus;
  reason?: string;
  /** First ledger id; equals ledgerRefs[0]. */
  ledgerRef: string;
  /** All ledger ids (more than one when a helper batches). */
  ledgerRefs: string[];
  cacheHit: boolean;
  source: ResponseSource;
  /** True when any part was served from a synthetic fixture. */
  synthetic: boolean;
  meta?: ResultMeta;
}

/** A tag with its position and scores inside one response. */
export interface RankedTag extends QlooTag {
  /** 1-based position inside its response. */
  rank: number;
  /** query.affinity for urn:tag insights; null for /v2/tags. */
  affinity: number | null;
  popularity: number | null;
  /** Parent entity types, when returned (e.g. "urn:entity:place"). */
  parents?: string[];
}


export interface ExternalMatch {
  externalId: string;
  entityId: string;
}

export interface QuotaSnapshot {
  remaining: number | null;
  limit: number | null;
  /** epoch ms of the response that reported it. */
  updatedAt: number | null;
}
