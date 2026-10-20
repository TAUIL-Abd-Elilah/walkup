/**
 * Qloo access for the P1 runner: the exact request shapes of evals/p1/ARMS.md, sent through
 * @walkup/qloo (cache, ledger, retries, 3 req/s, month quota guard) behind a per-run call
 * cap. Requests are built by hand where the shared builders would add parameters the contract
 * does not list (for example /search take=10 or a lat,lon location).
 */
import type { GeoPoint, QlooEntity } from "@walkup/contracts";
import {
  buildEntitiesByIds,
  buildPlaceInsights,
  buildTagsSearch,
  canonicalKey,
  normalizeEntity,
  QlooConfigError,
  QlooHostRefusedError,
  QlooQuotaGuardError,
  wktPoint,
  type FetchLike,
  type QlooCache,
  type QlooClient,
  type QlooRequest,
  type RawResponse,
} from "@walkup/qloo";
import { StopRunError } from "./errors";
import { ARM_TAKE, DERBY_TAKE, METRO_RADIUS_M, SEARCH_TAKE } from "./protocol";
import type { RunStore } from "./store";

// ---------------------------------------------------------------------------
// Call cap
// ---------------------------------------------------------------------------

export const QLOO_LIVE_TOTAL_KEY = "qloo-sent-total";

/**
 * Counts every HTTP request sent to Qloo in this run (retries included) and refuses to start
 * a new uncached request once `cap` were sent. Retries of the request in flight can add at most
 * the transport's retry count. Cache hits never count.
 */
export class QlooBudget {
  sent = 0;
  constructor(
    readonly cap: number,
    private readonly store: RunStore | null = null,
  ) {}

  wrapFetch(fetch: FetchLike): FetchLike {
    return async (url, init) => {
      this.sent += 1;
      this.store?.increment(QLOO_LIVE_TOTAL_KEY);
      return fetch(url, init);
    };
  }

  reserve(): void {
    if (this.sent >= this.cap) {
      throw new StopRunError(
        "qloo_budget",
        `Qloo call cap reached: ${this.sent} requests sent in this run (cap ${this.cap}). Everything so far is cached; run the same command again to resume.`,
      );
    }
  }
}

export interface QlooIo {
  request(req: QlooRequest): Promise<RawResponse>;
  readonly stats: { live: number; cached: number };
}

/** Wraps a live-mode QlooClient whose cache is `cache` and whose fetch went through `budget.wrapFetch`. */
export function createQlooIo(client: QlooClient, cache: QlooCache | null, budget: QlooBudget, now: () => number = Date.now): QlooIo {
  const stats = { live: 0, cached: 0 };
  return {
    stats,
    async request(req) {
      const cached = cache ? cache.get(canonicalKey(req), now()) !== null : false;
      if (!cached) budget.reserve();
      try {
        const raw = await client.request(req);
        if (raw.cacheHit) stats.cached += 1;
        else stats.live += 1;
        return raw;
      } catch (err) {
        if (err instanceof QlooQuotaGuardError) {
          throw new StopRunError("qloo_quota", `Qloo month guard: ${err.message}. Cached answers still work; resume when the quota allows.`);
        }
        if (err instanceof QlooConfigError || err instanceof QlooHostRefusedError) {
          throw new StopRunError("config", err.message);
        }
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Request shapes (ARMS.md §0, §1, §2, §3, §6)
// ---------------------------------------------------------------------------

/** §0a: GET /search?query=<name>&types=urn:entity:brand */
export function brandSearchRequest(name: string): QlooRequest {
  return { method: "GET", path: "/search", params: { query: name.trim(), types: ["urn:entity:brand"] }, cls: "search" };
}

/** §0a fallback when /search omits tags: GET /entities?entity_ids=<ids> */
export function entitiesRequest(ids: readonly string[]): QlooRequest {
  const [req] = buildEntitiesByIds(ids.slice(0, 50));
  if (!req) throw new TypeError("entitiesRequest needs at least one id");
  return req;
}

/** §0b: GET /v2/tags?filter.query=<word>&filter.parents.types=urn:entity:place */
export function tagsRequest(word: string): QlooRequest {
  return buildTagsSearch(word, { parentsTypes: ["place"] });
}

/** §1: GET /search?query=<bar_name>&types=urn:entity:place&filter.location=POINT(lon lat)&filter.radius=<miles>&take=20 */
export function placeSearchRequest(barName: string, at: GeoPoint, radiusMiles: number): QlooRequest {
  return {
    method: "GET",
    path: "/search",
    params: {
      query: barName.trim(),
      types: ["urn:entity:place"],
      "filter.location": wktPoint(at),
      "filter.radius": radiusMiles,
      take: SEARCH_TAKE,
    },
    cls: "search",
  };
}

/** §2 Q-signal, or §3 Q-pop when `clubEntity` is null. */
export function placeArmRequest(clubEntity: string | null, p: GeoPoint, pinnedTags: readonly string[]): QlooRequest {
  return buildPlaceInsights({
    ...(clubEntity ? { signalEntities: [clubEntity] } : {}),
    point: p,
    radiusM: METRO_RADIUS_M,
    tags: [...pinnedTags],
    operator: "union",
    take: ARM_TAKE,
  });
}

/** §6 Q-derby: signal club c, shortlist of primary bars. */
export function derbyRequest(clubEntity: string, shortlist: readonly string[]): QlooRequest {
  return buildPlaceInsights({ signalEntities: [clubEntity], resultsEntities: [...shortlist], take: DERBY_TAKE });
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface RankedEntry {
  /** 1-based position in the returned list (rows the normalizer cannot read still hold a position). */
  position: number;
  entityId: string | null;
  entity: QlooEntity | null;
}

/** Entities in returned order from /search, /entities (flat results[]) or insights (results.entities[]). */
export function rankedEntries(body: unknown): RankedEntry[] {
  const results = typeof body === "object" && body !== null ? (body as { results?: unknown }).results : undefined;
  let list: unknown[] = [];
  if (Array.isArray(results)) list = results;
  else if (typeof results === "object" && results !== null && Array.isArray((results as { entities?: unknown }).entities)) {
    list = (results as { entities: unknown[] }).entities;
  }
  return list.map((raw, i) => {
    const entity = normalizeEntity(raw);
    let entityId = entity?.entityId ?? null;
    if (!entityId && typeof raw === "object" && raw !== null) {
      const r = raw as { entity_id?: unknown; id?: unknown };
      const id = typeof r.entity_id === "string" ? r.entity_id : typeof r.id === "string" ? r.id : "";
      entityId = id.trim() || null;
    }
    return { position: i + 1, entityId, entity };
  });
}
