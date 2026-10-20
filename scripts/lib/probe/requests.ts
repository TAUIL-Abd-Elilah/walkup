/**
 * Pure request builders for the probe. No I/O here, so every probe's request
 * shape can be tested offline and printed by --dry-run.
 *
 * API facts encoded here:
 *  - WKT is POINT(lon lat). POINT(lat lon) silently returns nothing.
 *  - /v2/insights uses filter.type with "video_game"; /search uses `types` with "videogame".
 *  - /search radius (filter.radius) is in miles; insights radius (filter.location.radius) is in metres.
 *  - insights `take` max is 50; heatmaps ignore `take`, so it is never sent for them.
 *  - output.heatmap.boundary=city|neighborhood returns 400 on this host and is never sent.
 */

import type { EntityKind, Point } from "./config.js";
import type { ParamValue, RequestSpec } from "./types.js";

export const DEFAULT_BASE_URL = "https://hackathon.api.qloo.com";
export const MAX_TAKE = 50;

export function wktPoint(p: Point): string {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) {
    throw new RangeError(`invalid point lat=${p.lat} lon=${p.lon}`);
  }
  return `POINT(${fmt(p.lon)} ${fmt(p.lat)})`;
}

/** "lat,lon" as /search filter.location expects. */
export function latLon(p: Point): string {
  return `${fmt(p.lat)},${fmt(p.lon)}`;
}

/** Entity type URN for /v2/insights filter.type (and /v2/tags filter.parents.types). */
export function insightsType(kind: EntityKind): string {
  return `urn:entity:${kind}`;
}

/** Entity type URN for /search `types`. Video games are spelled "videogame" there. */
export function searchType(kind: EntityKind): string {
  return kind === "video_game" ? "urn:entity:videogame" : `urn:entity:${kind}`;
}

export function searchRequest(opts: {
  query: string;
  kinds: EntityKind[];
  take?: number;
  near?: Point & { radiusMiles: number };
  label?: string;
}): RequestSpec {
  const params: Record<string, ParamValue> = {
    query: opts.query,
    types: opts.kinds.map(searchType).join(","),
    take: opts.take ?? 5,
  };
  if (opts.near) {
    params["filter.location"] = latLon(opts.near);
    params["filter.radius"] = opts.near.radiusMiles;
  }
  return { method: "GET", path: "/search", params, label: opts.label ?? `search ${opts.kinds.join("/")} "${opts.query}"` };
}

export function entitiesBySpotify(ids: string[], label?: string): RequestSpec {
  return {
    method: "GET",
    path: "/entities",
    params: { "external.spotify.ids": ids.join(",") },
    label: label ?? `entities by ${ids.length} spotify ids`,
  };
}

export function entitiesByIds(ids: string[], label?: string): RequestSpec {
  return { method: "GET", path: "/entities", params: { entity_ids: ids.join(",") }, label: label ?? `entities by id (${ids.length})` };
}

export function tagSearchRequest(opts: { query: string; parentType: string | null; take?: number }): RequestSpec {
  const params: Record<string, ParamValue> = { "filter.query": opts.query, take: opts.take ?? 25 };
  if (opts.parentType) params["filter.parents.types"] = opts.parentType;
  return { method: "GET", path: "/v2/tags", params, label: `tags "${opts.query}"` };
}

export function audiencesRequest(query: string): RequestSpec {
  return { method: "GET", path: "/v2/audiences", params: { "filter.query": query }, label: `audiences "${query}"` };
}

export interface PlaceInsightsOpts {
  point?: Point;
  radiusM?: number;
  signalEntities?: string[];
  tags?: string[];
  tagsOperator?: "union" | "intersection";
  excludeTags?: string[];
  resultsEntities?: string[];
  resultsEntitiesQuery?: string[];
  hours?: string;
  demographicsAge?: string[];
  audiences?: string[];
  explainability?: boolean;
  take: number;
  label: string;
}

/** filter.type=urn:entity:place with stacked filters. */
export function placeInsights(o: PlaceInsightsOpts): RequestSpec {
  const params: Record<string, ParamValue> = { "filter.type": insightsType("place") };
  if (o.signalEntities?.length) params["signal.interests.entities"] = o.signalEntities.join(",");
  if (o.demographicsAge?.length) params["signal.demographics.age"] = o.demographicsAge.join(",");
  if (o.audiences?.length) params["signal.demographics.audiences"] = o.audiences.join(",");
  if (o.point) {
    params["filter.location"] = wktPoint(o.point);
    if (o.radiusM !== undefined) params["filter.location.radius"] = o.radiusM;
  }
  if (o.tags?.length) {
    params["filter.tags"] = o.tags.join(",");
    if (o.tagsOperator && o.tags.length > 1) params["operator.filter.tags"] = o.tagsOperator;
  }
  if (o.excludeTags?.length) params["filter.exclude.tags"] = o.excludeTags.join(",");
  if (o.resultsEntities?.length) params["filter.results.entities"] = o.resultsEntities.join(",");
  if (o.resultsEntitiesQuery?.length) params["filter.results.entities.query"] = o.resultsEntitiesQuery.join(",");
  if (o.hours) params["filter.hours"] = o.hours;
  if (o.explainability) params["feature.explainability"] = true;
  params.take = checkTake(o.take);
  return { method: "GET", path: "/v2/insights", params, label: o.label };
}

/** Typed recommendations for non-place types. Location goes in signal.location (filter.location is ignored there). */
export function typedInsights(o: {
  kind: Exclude<EntityKind, "place">;
  signalEntities: string[];
  signalLocation?: Point;
  excludeTags?: string[];
  resultsEntities?: string[];
  resultsEntitiesQuery?: string[];
  explainability?: boolean;
  take: number;
  label: string;
}): RequestSpec {
  const params: Record<string, ParamValue> = {
    "filter.type": insightsType(o.kind),
    "signal.interests.entities": o.signalEntities.join(","),
  };
  if (o.signalLocation) params["signal.location"] = wktPoint(o.signalLocation);
  if (o.excludeTags?.length) params["filter.exclude.tags"] = o.excludeTags.join(",");
  if (o.resultsEntities?.length) params["filter.results.entities"] = o.resultsEntities.join(",");
  if (o.resultsEntitiesQuery?.length) params["filter.results.entities.query"] = o.resultsEntitiesQuery.join(",");
  if (o.explainability) params["feature.explainability"] = true;
  params.take = checkTake(o.take);
  return { method: "GET", path: "/v2/insights", params, label: o.label };
}

/** GET heatmap around a point. Exactly one of the two signal kinds must be given. */
export function heatmapRequest(o: {
  point: Point;
  radiusM: number;
  signalEntities?: string[];
  signalTags?: string[];
  label: string;
}): RequestSpec {
  const params: Record<string, ParamValue> = { "filter.type": "urn:heatmap" };
  if (o.signalEntities?.length) params["signal.interests.entities"] = o.signalEntities.join(",");
  if (o.signalTags?.length) params["signal.interests.tags"] = o.signalTags.join(",");
  if (!params["signal.interests.entities"] && !params["signal.interests.tags"]) {
    throw new Error("heatmap needs at least one signal");
  }
  params["filter.location"] = wktPoint(o.point);
  params["filter.location.radius"] = o.radiusM;
  return { method: "GET", path: "/v2/insights", params, label: o.label };
}

/** POST heatmap with weighted entity objects ({entity, weight}). */
export function weightedHeatmapPost(o: {
  point: Point;
  radiusM: number;
  weighted: { entity: string; weight: number }[];
  label: string;
}): RequestSpec {
  return {
    method: "POST",
    path: "/v2/insights",
    params: {},
    body: {
      "filter.type": "urn:heatmap",
      "signal.interests.entities": o.weighted.map((w) => ({ entity: w.entity, weight: w.weight })),
      "filter.location": wktPoint(o.point),
      "filter.location.radius": o.radiusM,
    },
    label: o.label,
  };
}

export function demographicsRequest(entityIds: string[], label: string): RequestSpec {
  return {
    method: "GET",
    path: "/v2/insights",
    params: { "filter.type": "urn:demographics", "signal.interests.entities": entityIds.join(",") },
    label,
  };
}

export function tagProfileRequest(entityIds: string[], take: number, label: string): RequestSpec {
  return {
    method: "GET",
    path: "/v2/insights",
    params: { "filter.type": "urn:tag", "signal.interests.entities": entityIds.join(","), take: checkTake(take) },
    label,
  };
}

export function compareRequest(a: string[], b: string[], take: number, label: string): RequestSpec {
  return {
    method: "GET",
    path: "/v2/analysis/compare",
    params: {
      "a.signal.interests.entities": a.join(","),
      "b.signal.interests.entities": b.join(","),
      take: checkTake(take),
    },
    label,
  };
}

/** Full URL for a spec. The key is never part of it (it travels in the X-Api-Key header). */
export function buildUrl(baseUrl: string, spec: RequestSpec): string {
  const url = new URL(spec.path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [k, v] of Object.entries(spec.params)) url.searchParams.set(k, String(v));
  return url.toString();
}

/** Stable identity of a request: method, path, sorted params and body. Used for the in-run memo. */
export function canonicalKey(spec: RequestSpec): string {
  const params = Object.keys(spec.params)
    .sort()
    .map((k) => `${k}=${String(spec.params[k])}`)
    .join("&");
  return `${spec.method} ${spec.path}?${params}${spec.body ? ` ${stableJson(spec.body)}` : ""}`;
}

/** copy-as-curl with the key as an env var reference, never the value. */
export function toCurl(baseUrl: string, spec: RequestSpec): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const head = `curl -sS ${q(buildUrl(baseUrl, spec))} -H "X-Api-Key: $QLOO_API_KEY"`;
  if (spec.method === "POST") {
    return `${head} -H 'Content-Type: application/json' -X POST --data ${q(JSON.stringify(spec.body ?? {}))}`;
  }
  return head;
}

/** Replaces every occurrence of any secret with a placeholder. */
export function redactSecrets(text: string, secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

function checkTake(take: number): number {
  if (!Number.isInteger(take) || take < 1 || take > MAX_TAKE) throw new RangeError(`take must be 1..${MAX_TAKE}, got ${take}`);
  return take;
}

function fmt(n: number): string {
  return String(Number(n.toFixed(7)));
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
