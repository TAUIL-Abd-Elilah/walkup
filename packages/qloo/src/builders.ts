/**
 * Typed request builders. Pure: no I/O. Each returns a QlooRequest the client
 * sends (or replays). Rules baked in:
 *  - WKT is POINT(lon lat).
 *  - filter.type uses video_game; /search types uses videogame.
 *  - insights take <= 50; /search radius is miles (<= 100); insights radius is metres.
 *  - Tags must be URNs (urn:tag:...); free-text tags are refused.
 *  - output.heatmap.boundary=city|neighborhood is refused (400 on the hackathon host).
 *  - Every /v2/insights call is a GET with plain entity ids. POST with {entity, weight} objects returned 400
 *    on Oct 15 (probe 14) and was removed; only the probe script keeps its own weighted POST request.
 */
import type { GeoPoint } from "@walkup/contracts";
import type { Params, QlooRequest, RequestClass, SignalEntity } from "./types";

export const INSIGHTS_MAX_TAKE = 50;
export const SEARCH_MAX_RADIUS_MILES = 100;
export const INSIGHTS_MAX_RADIUS_M = 800_000;
/** /entities ids per call. */
export const ENTITIES_BATCH = 50;

export const EXTERNAL_NAMESPACES = [
  "spotify",
  "imdb",
  "isbn10",
  "isbn13",
  "goodreads",
  "goodreads_author",
  "igdb",
  "musicbrainz",
  "lastfm",
  "soundcloud",
  "itunes",
  "twitch",
  "twitter",
  "instagram",
  "facebook",
  "wikidata",
  "resy",
  "michelin",
  "tablet",
  "metacritic",
  "rottentomatoes",
  "library_of_congress",
] as const;
export type ExternalNamespace = (typeof EXTERNAL_NAMESPACES)[number];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function shortType(t: string): string {
  const s = t.trim();
  return s.startsWith("urn:entity:") ? s.slice("urn:entity:".length) : s;
}

/** Type URN for /search `types` (videogame). */
export function searchTypeUrn(t: string): string {
  const s = shortType(t);
  return `urn:entity:${s === "video_game" ? "videogame" : s}`;
}

/** Type URN for insights `filter.type` (video_game). urn:heatmap / urn:tag / urn:demographics pass through. */
export function insightsTypeUrn(t: string): string {
  const s = t.trim();
  if (s.startsWith("urn:") && !s.startsWith("urn:entity:")) return s;
  const short = shortType(s);
  if (short === "heatmap" || short === "tag" || short === "demographics") return `urn:${short}`;
  return `urn:entity:${short === "videogame" ? "video_game" : short}`;
}

function assertPoint(p: GeoPoint): void {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
    throw new RangeError(`Invalid point lat=${p.lat} lon=${p.lon}`);
  }
}

function coord(n: number): string {
  return String(Number(n.toFixed(6)));
}

/** WKT for Qloo: POINT(lon lat). POINT(lat lon) silently returns nothing, so order matters. */
export function wktPoint(p: GeoPoint): string {
  assertPoint(p);
  return `POINT(${coord(p.lon)} ${coord(p.lat)})`;
}

/** "lat,lon" for /search filter.location. */
export function latLonString(p: GeoPoint): string {
  assertPoint(p);
  return `${coord(p.lat)},${coord(p.lon)}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function optTake(take: number | undefined, max: number): number | undefined {
  if (take === undefined || !Number.isFinite(take)) return undefined;
  return clamp(Math.round(take), 1, max);
}

/** Trimmed, de-duplicated, order kept. */
export function uniqueIds(list: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const id = String(raw).trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function tagUrns(list: readonly string[] | undefined, field: string): string[] {
  const out = uniqueIds(list);
  for (const t of out) {
    if (!t.startsWith("urn:tag:")) throw new TypeError(`${field} takes pinned tag URNs (urn:tag:...), got "${t}"`);
  }
  return out;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export interface SplitSignal {
  ids: string[];
}

/** Signal entity ids, trimmed and de-duplicated in order. */
export function splitSignal(list: readonly SignalEntity[] | undefined): SplitSignal {
  return { ids: uniqueIds(list) };
}

function insightsClass(params: Params): RequestClass {
  return params["filter.type"] === "urn:heatmap" ? "heatmap" : "insights";
}

const REFUSED_BOUNDARIES = new Set(["city", "neighborhood"]);

/**
 * Validates and finalizes a /v2/insights request (always a GET with plain entity ids).
 */
export function finalizeInsights(params: Params, signal: SplitSignal | null, signalKey = "signal.interests.entities"): QlooRequest {
  const p: Params = { ...params };
  const ft = p["filter.type"];
  if (typeof ft !== "string" || ft.trim() === "") throw new TypeError("insights needs filter.type");
  p["filter.type"] = insightsTypeUrn(ft);
  const boundary = p["output.heatmap.boundary"];
  if (typeof boundary === "string" && REFUSED_BOUNDARIES.has(boundary.trim().toLowerCase())) {
    throw new TypeError("output.heatmap.boundary=city|neighborhood returns 400 on this host; use our gazetteer");
  }
  if (typeof p.take === "number") p.take = optTake(p.take, INSIGHTS_MAX_TAKE);
  if (signal && signal.ids.length > 0) p[signalKey] = signal.ids;
  return { method: "GET", path: "/v2/insights", params: p, cls: insightsClass(p) };
}

// ---------------------------------------------------------------------------
// /search and /entities
// ---------------------------------------------------------------------------

export interface SearchOptions {
  location?: GeoPoint;
  /** Miles (Qloo /search unit), max 100. */
  radiusMiles?: number;
  /** Default 10. */
  take?: number;
  sortBy?: "match" | "distance" | "popularity";
  page?: number;
  extra?: Params;
}

export function buildSearch(query: string, types: readonly string[], opts: SearchOptions = {}): QlooRequest {
  const q = query.trim();
  if (!q) throw new TypeError("search query is empty");
  const params: Params = {
    ...opts.extra,
    query: q,
    types: uniqueIds(types.map(searchTypeUrn)),
    take: optTake(opts.take ?? 10, 199),
    sort_by: opts.sortBy,
    page: opts.page,
  };
  if (opts.location) {
    params["filter.location"] = latLonString(opts.location);
    if (opts.radiusMiles !== undefined) params["filter.radius"] = clamp(opts.radiusMiles, 0, SEARCH_MAX_RADIUS_MILES);
  }
  return { method: "GET", path: "/search", params, cls: "search" };
}

export function buildEntitiesByIds(ids: readonly string[]): QlooRequest[] {
  return chunk(uniqueIds(ids), ENTITIES_BATCH).map((batch) => ({
    method: "GET" as const,
    path: "/entities",
    params: { entity_ids: batch },
    cls: "entities" as const,
  }));
}

export function isExternalNamespace(ns: string): ns is ExternalNamespace {
  return (EXTERNAL_NAMESPACES as readonly string[]).includes(ns);
}

export function buildEntitiesByExternal(ns: string, ids: readonly string[]): QlooRequest[] {
  if (!isExternalNamespace(ns)) throw new TypeError(`Unsupported external namespace "${ns}"`);
  return chunk(uniqueIds(ids), ENTITIES_BATCH).map((batch) => ({
    method: "GET" as const,
    path: "/entities",
    params: { [`external.${ns}.ids`]: batch },
    cls: "entities" as const,
  }));
}

// ---------------------------------------------------------------------------
// /v2/insights helpers
// ---------------------------------------------------------------------------

export function buildInsights(params: Params, opts: { signalEntities?: SignalEntity[] } = {}): QlooRequest {
  const signal = opts.signalEntities ? splitSignal(opts.signalEntities) : null;
  return finalizeInsights(params, signal);
}

export interface HeatmapOptions {
  signalEntities?: SignalEntity[];
  signalTags?: string[];
  point: GeoPoint;
  /** Metres. */
  radiusM?: number;
  extra?: Params;
}

export function buildHeatmap(o: HeatmapOptions): QlooRequest {
  const signal = splitSignal(o.signalEntities);
  const tags = tagUrns(o.signalTags, "signalTags");
  if (signal.ids.length === 0 && tags.length === 0) {
    throw new TypeError("heatmap needs signalEntities or signalTags (Qloo returns 400 without a signal)");
  }
  const params: Params = {
    ...o.extra,
    "filter.type": "urn:heatmap",
    "filter.location": wktPoint(o.point),
    "filter.location.radius": o.radiusM !== undefined ? clamp(Math.round(o.radiusM), 0, INSIGHTS_MAX_RADIUS_M) : undefined,
    "signal.interests.tags": tags,
  };
  return finalizeInsights(params, signal);
}

export interface DemographicsOptions {
  signalTags?: string[];
  extra?: Params;
}

export function buildDemographics(entityIds: readonly string[], o: DemographicsOptions = {}): QlooRequest {
  const ids = uniqueIds(entityIds);
  const tags = tagUrns(o.signalTags, "signalTags");
  if (ids.length === 0 && tags.length === 0) throw new TypeError("demographics needs entity ids or tags");
  return finalizeInsights(
    { ...o.extra, "filter.type": "urn:demographics", "signal.interests.entities": ids, "signal.interests.tags": tags },
    null,
  );
}

export interface PlaceInsightsOptions {
  signalEntities?: SignalEntity[];
  point?: GeoPoint;
  /** Metres. */
  radiusM?: number;
  /** Pinned category tag URNs (filter.tags). */
  tags?: string[];
  /** operator.filter.tags. */
  operator?: "union" | "intersection";
  /** filter.hours: weekday the place must be open, e.g. "thursday". */
  hours?: string;
  /** filter.price_level.max (1-4). */
  priceMax?: number;
  excludeTags?: string[];
  excludeEntities?: string[];
  /** Max 50. */
  take?: number;
  explainability?: boolean;
  /** filter.results.entities: score only this shortlist. */
  resultsEntities?: string[];
  extra?: Params;
}

export function buildPlaceInsights(o: PlaceInsightsOptions): QlooRequest {
  const tags = tagUrns(o.tags, "tags");
  const params: Params = {
    ...o.extra,
    "filter.type": "urn:entity:place",
    "filter.location": o.point ? wktPoint(o.point) : undefined,
    "filter.location.radius":
      o.point && o.radiusM !== undefined ? clamp(Math.round(o.radiusM), 0, INSIGHTS_MAX_RADIUS_M) : undefined,
    "filter.tags": tags,
    "operator.filter.tags": tags.length > 0 ? o.operator : undefined,
    "filter.hours": o.hours ? o.hours.trim().toLowerCase() : undefined,
    "filter.price_level.max": o.priceMax !== undefined ? clamp(Math.round(o.priceMax), 1, 4) : undefined,
    "filter.exclude.tags": tagUrns(o.excludeTags, "excludeTags"),
    "filter.exclude.entities": uniqueIds(o.excludeEntities),
    "filter.results.entities": uniqueIds(o.resultsEntities),
    "feature.explainability": o.explainability ? true : undefined,
    take: optTake(o.take, INSIGHTS_MAX_TAKE),
  };
  return finalizeInsights(params, splitSignal(o.signalEntities));
}

export interface EntityInsightsOptions {
  signalEntities?: SignalEntity[];
  /** signal.location as WKT (ranks what over-indexes near this point; not a filter). */
  signalLocationPoint?: GeoPoint;
  excludeTags?: string[];
  take?: number;
  explainability?: boolean;
  extra?: Params;
}

export function buildEntityInsights(type: string, o: EntityInsightsOptions = {}): QlooRequest {
  const ft = insightsTypeUrn(type);
  if (!ft.startsWith("urn:entity:")) throw new TypeError(`entityInsights needs an entity type, got "${type}"`);
  const params: Params = {
    ...o.extra,
    "filter.type": ft,
    "signal.location": o.signalLocationPoint ? wktPoint(o.signalLocationPoint) : undefined,
    "filter.exclude.tags": tagUrns(o.excludeTags, "excludeTags"),
    "feature.explainability": o.explainability ? true : undefined,
    take: optTake(o.take, INSIGHTS_MAX_TAKE),
  };
  return finalizeInsights(params, splitSignal(o.signalEntities));
}

export interface TagProfileOptions {
  signalEntities: SignalEntity[];
  /** filter.tag.types namespaces, e.g. "urn:tag:genre:music". */
  tagTypes?: string[];
  diversifyBySubtype?: boolean;
  diversifyTake?: number;
  take?: number;
  extra?: Params;
}

export function buildTagProfile(o: TagProfileOptions): QlooRequest {
  const signal = splitSignal(o.signalEntities);
  if (signal.ids.length === 0) throw new TypeError("tagProfile needs signalEntities");
  const params: Params = {
    ...o.extra,
    "filter.type": "urn:tag",
    "filter.tag.types": tagUrns(o.tagTypes, "tagTypes"),
    "diversify.by": o.diversifyBySubtype ? "subtype" : undefined,
    "diversify.take":
      o.diversifyBySubtype && o.diversifyTake !== undefined ? Math.max(1, Math.round(o.diversifyTake)) : undefined,
    take: optTake(o.take, INSIGHTS_MAX_TAKE),
  };
  return finalizeInsights(params, signal);
}

// ---------------------------------------------------------------------------
// compare, tags
// ---------------------------------------------------------------------------

export function buildCompare(a: readonly string[], b: readonly string[], take?: number, extra?: Params): QlooRequest {
  const aa = uniqueIds(a);
  const bb = uniqueIds(b);
  if (aa.length === 0 || bb.length === 0) throw new TypeError("compare needs entities on both sides");
  return {
    method: "GET",
    path: "/v2/analysis/compare",
    params: {
      ...extra,
      "a.signal.interests.entities": aa,
      "b.signal.interests.entities": bb,
      take: optTake(take, INSIGHTS_MAX_TAKE),
    },
    cls: "compare",
  };
}

export interface TagsSearchOptions {
  /** Entity types the tags apply to (filter.parents.types), e.g. "place". */
  parentsTypes?: string[];
  semantic?: boolean;
  typoTolerance?: boolean;
  tagTypes?: string[];
  take?: number;
}

export function buildTagsSearch(query: string, o: TagsSearchOptions = {}): QlooRequest {
  const q = query.trim();
  if (!q) throw new TypeError("tags query is empty");
  return {
    method: "GET",
    path: "/v2/tags",
    params: {
      "filter.query": q,
      "filter.parents.types": uniqueIds((o.parentsTypes ?? []).map(insightsTypeUrn)),
      "filter.tag.types": uniqueIds(o.tagTypes),
      "feature.semantic_search": o.semantic ? true : undefined,
      "feature.typo_tolerance": o.typoTolerance ? true : undefined,
      take: optTake(o.take, INSIGHTS_MAX_TAKE),
    },
    cls: "tags",
  };
}

