/**
 * Helpers shared by several probes: name resolution, tag lookup, venue choice,
 * the KG1 place pool and the house set. Every helper goes through ctx.call, so
 * the in-run memo makes repeated use free and --dry-run prints each request once.
 */

import { DENIED_TAG_KEYWORDS, DENIED_TAG_PREFIXES } from "@walkup/contracts";
import type { ActCfg, BillCfg, EntityKind, Point } from "./config.js";
import { type EntityLite, anyEntities, errorPaths, insightEntities, searchEntities, signalWarnings, tagList } from "./extract.js";
import { containsAllWords, extendsName, haversineM, isExactName, nameSimilarity, normalizeName } from "./names.js";
import { entitiesBySpotify, placeInsights, searchRequest, tagSearchRequest } from "./requests.js";
import type { Derived, ProbeContext, ProbeOutcome, ProbeStatus, RequestSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Outcomes and formatting
// ---------------------------------------------------------------------------

export function outcome(status: ProbeStatus, headline: string, lines: string[] = [], derived: Derived = {}): ProbeOutcome {
  return { status, headline, lines, derived };
}

export function planned(lines: string[] = []): ProbeOutcome {
  return outcome("planned", "planned (dry run)", lines);
}

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return n.toFixed(digits);
}

/** NaN-safe "below" check: NaN is never a pass. */
export function below(v: number, max: number): boolean {
  return Number.isFinite(v) && v < max;
}

/**
 * Status for a probe whose deciding call did not return 200. A 4xx other than
 * 429 means the API refused the request shape (a real "not supported": fail);
 * no response, 429 or 5xx is transient (inconclusive). An empty list from a
 * failed call must never be read as "the results changed".
 */
export function httpFailureStatus(status: number | null): ProbeStatus {
  return status !== null && status >= 400 && status < 500 && status !== 429 ? "fail" : "inconclusive";
}

export function placeholderId(kind: string, name: string): string {
  return `{{${kind}:${name}}}`;
}

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

export interface Resolved {
  id: string;
  exact: boolean;
  popularity: number | null;
  candidates: number;
  placeholder: boolean;
  /** In memory only (used for tag checks). */
  tagIds: string[];
  entity: EntityLite | null;
  /** Candidate ids the signal check reported as not_found (skipped before this pick). */
  droppedIds: string[];
  /** Name of the first-choice entry that was skipped as not_found, when another entry is used. */
  substitutedFrom: string | null;
}

/** Most candidates one act sends to the signal check. */
export const CHECK_CANDIDATES_PER_ACT = 4;
/** Signal check: place insights, take 1, this radius around the check point. */
export const SIGNAL_CHECK_RADIUS_M = 1500;

interface ActSearch {
  act: ActCfg;
  dry: boolean;
  /** null: the search failed or found nothing. */
  list: EntityLite[] | null;
  /** In preference order; exact flags whether a name rule matched. */
  candidates: { e: EntityLite; exact: boolean }[];
}

/**
 * Candidate order for an act: exact name, then exact aliases, then billing-name extensions
 * ("<name> and ...", "<name> with ..."); when none match, the top search hit (exact=false).
 */
export function orderCandidates(list: EntityLite[], act: ActCfg): { e: EntityLite; exact: boolean }[] {
  const names = [act.name, ...(act.aliases ?? [])];
  const out: { e: EntityLite; exact: boolean }[] = [];
  const add = (pred: (e: EntityLite) => boolean) => {
    for (const e of list) if (!out.some((x) => x.e.id === e.id) && pred(e)) out.push({ e, exact: true });
  };
  add((e) => isExactName(e.name, [act.name]));
  add((e) => isExactName(e.name, names.slice(1)));
  add((e) => names.some((n) => extendsName(n, e.name)));
  if (out.length === 0 && list[0]) out.push({ e: list[0], exact: false });
  return out.slice(0, CHECK_CANDIDATES_PER_ACT);
}

async function searchAct(ctx: ProbeContext, act: ActCfg, near?: Point & { radiusMiles: number }): Promise<ActSearch> {
  const res = await ctx.call(searchRequest({ query: act.name, kinds: [act.kind], take: 5, ...(near ? { near } : {}) }));
  if (res.dry) return { act, dry: true, list: null, candidates: [] };
  if (res.status !== 200) return { act, dry: false, list: null, candidates: [] };
  const list = searchEntities(res.json);
  return { act, dry: false, list: list.length > 0 ? list : null, candidates: orderCandidates(list, act) };
}

/** The point signal checks use: the first configured venue with coordinates (stable, so checks are memoized). */
export function checkPoint(ctx: ProbeContext): Point | null {
  for (const key of Object.keys(ctx.cfg.venues)) {
    const p = venuePoint(ctx, key);
    if (p) return p;
  }
  return null;
}

/**
 * Which of these ids Qloo has taste data for: one place-insights call (take 1) with the ids as
 * signal.interests.entities near checkPoint. A 200 lists ignored ids in warnings (not_found); a 400 that
 * blames signal.interests.entities means none were usable. Returns the dropped set, or null when the call
 * failed for another reason (then nothing is skipped). Memoized like every probe call.
 */
export async function droppedSignals(ctx: ProbeContext, ids: string[]): Promise<Set<string> | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const point = checkPoint(ctx);
  const spec: RequestSpec = {
    ...placeInsights({
      ...(point ? { point, radiusM: SIGNAL_CHECK_RADIUS_M } : {}),
      signalEntities: unique,
      take: 1,
      label: `signal check: does Qloo have taste data for ${unique.length} id(s)`,
    }),
    purpose: "signal-check",
  };
  const res = await ctx.call(spec);
  if (res.dry) return new Set();
  if (res.status === 200) return new Set(signalWarnings(res.json));
  if (res.status === 400 && errorPaths(res.json).some((x) => x.endsWith("signal.interests.entities"))) return new Set(unique);
  return null;
}

function placeholderResolved(act: ActCfg): Resolved {
  return { id: placeholderId(act.kind, act.name), exact: true, popularity: null, candidates: 0, placeholder: true, tagIds: [], entity: null, droppedIds: [], substitutedFrom: null };
}

/** First candidate not in `dropped`, with what was skipped. */
function pickUsable(s: ActSearch, dropped: Set<string> | null): Resolved | null {
  if (s.dry) return placeholderResolved(s.act);
  if (!s.list) return null;
  const skipped: string[] = [];
  for (const c of s.candidates) {
    if (dropped?.has(c.e.id)) {
      skipped.push(c.e.id);
      continue;
    }
    const first = s.candidates[0];
    return {
      id: c.e.id,
      exact: c.exact,
      popularity: c.e.popularity,
      candidates: s.list.length,
      placeholder: false,
      tagIds: c.e.tagIds,
      entity: c.e,
      droppedIds: skipped,
      substitutedFrom: skipped.length > 0 && first ? first.e.name : null,
    };
  }
  return null;
}

/**
 * Resolves several acts with one signal check: typed /search per act, candidates in preference order
 * (exact name, aliases, "<name> and ..." billing names), then one place-insights call (take 1) over every
 * candidate id. An entry Qloo reports as not_found is skipped for the next candidate, so a dropped id is
 * never used as a signal. In a dry run the check is planned with placeholder ids.
 */
export async function resolveActs(ctx: ProbeContext, acts: ActCfg[], opts: { check?: boolean } = {}): Promise<(Resolved | null)[]> {
  const searches: ActSearch[] = [];
  for (const act of acts) searches.push(await searchAct(ctx, act));
  let dropped: Set<string> | null = new Set();
  if (opts.check !== false) {
    const ids = searches.flatMap((s) => (s.dry ? [placeholderId(s.act.kind, s.act.name)] : s.candidates.map((c) => c.e.id)));
    dropped = await droppedSignals(ctx, ids);
  }
  return searches.map((s) => pickUsable(s, dropped));
}

/**
 * Typed /search, exact normalized-name match preferred (then aliases, then billing names); falls back to the
 * top hit flagged exact=false. With `check`, one signal check skips entries Qloo has no taste data for.
 */
export async function resolveAct(
  ctx: ProbeContext,
  act: ActCfg,
  near?: Point & { radiusMiles: number },
  opts: { check?: boolean } = {},
): Promise<Resolved | null> {
  const s = await searchAct(ctx, act, near);
  if (!opts.check) return pickUsable(s, new Set());
  const ids = s.dry ? [placeholderId(act.kind, act.name)] : s.candidates.map((c) => c.e.id);
  return pickUsable(s, await droppedSignals(ctx, ids));
}

/** All exact-name candidates for a query (ambiguity check). */
export async function exactCandidates(ctx: ProbeContext, act: ActCfg): Promise<{ total: number; exact: number } | null> {
  const res = await ctx.call(searchRequest({ query: act.name, kinds: [act.kind], take: 5 }));
  if (res.dry || res.status !== 200) return null;
  const list = searchEntities(res.json);
  const wanted = [act.name, ...(act.aliases ?? [])];
  return { total: list.length, exact: list.filter((e) => isExactName(e.name, wanted)).length };
}

export interface PlaceMatch {
  resolved: Resolved | null;
  similarity: number;
  distanceM: number | null;
}

/** Resolves a named place near a point by name similarity (and distance when both points are known). */
export async function resolvePlace(
  ctx: ProbeContext,
  name: string,
  near: Point & { radiusMiles: number },
  opts: { minSimilarity: number; maxDistanceM?: number; truePoint?: Point | null },
): Promise<PlaceMatch> {
  const res = await ctx.call(searchRequest({ query: name, kinds: ["place"], take: 5, near }));
  if (res.dry) {
    return {
      resolved: { id: placeholderId("place", name), exact: true, popularity: null, candidates: 0, placeholder: true, tagIds: [], entity: null, droppedIds: [], substitutedFrom: null },
      similarity: 1,
      distanceM: null,
    };
  }
  if (res.status !== 200) return { resolved: null, similarity: 0, distanceM: null };
  const list = searchEntities(res.json);
  let best: { e: EntityLite; sim: number; dist: number | null } | null = null;
  for (const e of list) {
    const sim = nameSimilarity(e.name, name);
    const dist =
      opts.truePoint && e.lat !== null && e.lon !== null ? haversineM(opts.truePoint, { lat: e.lat, lon: e.lon }) : null;
    if (sim < opts.minSimilarity) continue;
    if (opts.maxDistanceM !== undefined && dist !== null && dist > opts.maxDistanceM) continue;
    if (!best || sim > best.sim) best = { e, sim, dist };
  }
  if (!best) {
    const top = list[0];
    return { resolved: null, similarity: top ? nameSimilarity(top.name, name) : 0, distanceM: null };
  }
  return {
    resolved: {
      id: best.e.id,
      exact: normalizeName(best.e.name) === normalizeName(name),
      popularity: best.e.popularity,
      candidates: list.length,
      placeholder: false,
      tagIds: best.e.tagIds,
      entity: best.e,
      droppedIds: [],
      substitutedFrom: null,
    },
    similarity: best.sim,
    distanceM: best.dist,
  };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagRef {
  key: string;
  id: string;
  exact: boolean;
  pinned: boolean;
  placeholder: boolean;
  query: string | null;
  candidates: number;
}

const NAMESPACE_PREFERENCE = ["urn:tag:category:place:", "urn:tag:genre:place:", "urn:tag:genre:"];

function preferNamespace<T extends { id: string }>(list: T[]): T | undefined {
  for (const ns of NAMESPACE_PREFERENCE) {
    const hit = list.find((t) => t.id.startsWith(ns));
    if (hit) return hit;
  }
  return list[0];
}

/** Resolves a configured tag key: pinned id first, else /v2/tags lookups in order. */
export async function findTag(ctx: ProbeContext, key: string): Promise<TagRef | null> {
  const pinned = ctx.cfg.tags.pinned[key];
  if (pinned) return { key, id: pinned.id, exact: true, pinned: true, placeholder: false, query: null, candidates: 0 };
  const kw = ctx.cfg.tags.keywords.find((k) => k.key === key);
  if (!kw) return null;
  for (const q of kw.queries) {
    const res = await ctx.call(tagSearchRequest({ query: q, parentType: kw.parentType }));
    if (res.dry) return { key, id: placeholderId("tag", key), exact: true, pinned: false, placeholder: true, query: q, candidates: 0 };
    if (res.status !== 200) continue;
    const list = tagList(res.json);
    const wanted = [q, key.replace(/_/g, " ")];
    const exact = list.filter((t) => wanted.some((w) => normalizeName(t.name) === normalizeName(w)));
    const loose = list.filter((t) => containsAllWords(t.name, q));
    const pick = preferNamespace(exact) ?? preferNamespace(loose);
    if (pick) return { key, id: pick.id, exact: exact.length > 0, pinned: false, placeholder: false, query: q, candidates: list.length };
  }
  return null;
}

/** Every tag whose name contains the query words (for exclusion lists), up to the keyword's max. */
export async function findTagsAll(ctx: ProbeContext, key: string): Promise<TagRef[]> {
  const pinned = ctx.cfg.tags.pinned[key];
  if (pinned) return [{ key, id: pinned.id, exact: true, pinned: true, placeholder: false, query: null, candidates: 0 }];
  const kw = ctx.cfg.tags.keywords.find((k) => k.key === key);
  if (!kw) return [];
  const max = kw.max ?? 5;
  for (const q of kw.queries) {
    const res = await ctx.call(tagSearchRequest({ query: q, parentType: kw.parentType }));
    if (res.dry) return [{ key, id: placeholderId("tags", key), exact: true, pinned: false, placeholder: true, query: q, candidates: 0 }];
    if (res.status !== 200) continue;
    const list = tagList(res.json).filter((t) => containsAllWords(t.name, q));
    if (list.length > 0) {
      return list.slice(0, max).map((t) => ({
        key,
        id: t.id,
        exact: normalizeName(t.name) === normalizeName(q),
        pinned: false,
        placeholder: false,
        query: q,
        candidates: list.length,
      }));
    }
  }
  return [];
}

export async function tagIdsFor(ctx: ProbeContext, keys: string[]): Promise<{ ids: string[]; missing: string[] }> {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const k of keys) {
    const t = await findTag(ctx, k);
    if (t) ids.push(t.id);
    else missing.push(k);
  }
  return { ids, missing };
}

export function isDeniedTag(id: string, name: string): boolean {
  const idl = id.toLowerCase();
  const hay = `${idl} ${name.toLowerCase()}`;
  return (
    DENIED_TAG_PREFIXES.some((p) => idl.startsWith(p)) || DENIED_TAG_KEYWORDS.some((k) => hay.includes(k))
  );
}

// ---------------------------------------------------------------------------
// Venues and bills
// ---------------------------------------------------------------------------

export function venuePoint(ctx: ProbeContext, key: string): Point | null {
  const v = ctx.cfg.venues[key];
  if (!v || v.lat === null || v.lon === null) return null;
  return { lat: v.lat, lon: v.lon };
}

export interface VenueChoice {
  key: string;
  point: Point;
  note: string | null;
}

/** The preferred venue when its point is known, else the fallback (with a note). */
export function chooseVenue(ctx: ProbeContext, preferred: string, fallback: string): VenueChoice | null {
  const p = venuePoint(ctx, preferred);
  if (p) return { key: preferred, point: p, note: null };
  const f = venuePoint(ctx, fallback);
  if (f) return { key: fallback, point: f, note: `${preferred} has no coordinates yet; used ${fallback}` };
  return null;
}

/** Venue point, or its search anchor when the point is unknown. */
export function pointOrAnchor(ctx: ProbeContext, key: string): { point: Point; anchored: boolean } | null {
  const p = venuePoint(ctx, key);
  if (p) return { point: p, anchored: false };
  const a = ctx.cfg.venues[key]?.searchAnchor;
  return a ? { point: { lat: a.lat, lon: a.lon }, anchored: true } : null;
}

export function billsAt(ctx: ProbeContext, venueKey: string): BillCfg[] {
  return ctx.cfg.kg1.bills[venueKey] ?? [];
}

/** A bill's acts as signal ids, signal-checked in one call (see resolveActs). */
export async function resolveBill(ctx: ProbeContext, bill: BillCfg): Promise<{ ids: string[]; refs: (Resolved | null)[] }> {
  const refs = await resolveActs(ctx, bill.acts);
  return { ids: refs.filter((r): r is Resolved => r !== null).map((r) => r.id), refs };
}

/** Plain lines for acts whose first match was skipped as not_found (for probe SUMMARY lines). */
export function substitutionLines(prefix: string, acts: ActCfg[], refs: (Resolved | null)[]): string[] {
  const out: string[] = [];
  acts.forEach((act, i) => {
    const r = refs[i];
    if (r?.substitutedFrom) {
      out.push(`${prefix}"${act.name}": Qloo has no taste data for the first match (${r.droppedIds.join(", ")}), so "${r.entity?.name ?? r.id}" was used`);
    } else if (r === null && act) {
      out.push(`${prefix}"${act.name}": no usable Qloo entry (no match, or no taste data for any match)`);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// KG1 pool (shared with probes 10, 15, 16, 17)
// ---------------------------------------------------------------------------

export interface PoolResult {
  ids: string[];
  entities: EntityLite[];
  status: number | null;
  dry: boolean;
  tagIds: string[];
  missingTags: string[];
}

/** No-signal place call near the venue: the pool, in popularity order (the "Q-pop" arm). */
export async function poolAt(ctx: ProbeContext, venueKey: string, extra: { hours?: string } = {}): Promise<PoolResult | null> {
  const point = venuePoint(ctx, venueKey);
  if (!point) return null;
  const c = ctx.cfg.kg1;
  const tags = await tagIdsFor(ctx, c.poolTagKeys);
  const spec = placeInsights({
    point,
    radiusM: c.poolRadiusM,
    tags: tags.ids,
    tagsOperator: "union",
    ...(extra.hours ? { hours: extra.hours } : {}),
    take: c.poolSize,
    label: `pool near ${venueKey}${extra.hours ? ` open ${extra.hours}` : ""} (no signal = popularity order)`,
  });
  const res = await ctx.call(spec);
  if (res.dry) return { ids: [placeholderId("pool", venueKey)], entities: [], status: null, dry: true, tagIds: tags.ids, missingTags: tags.missing };
  const entities = res.status === 200 ? insightEntities(res.json) : [];
  return { ids: entities.map((e) => e.id), entities, status: res.status, dry: false, tagIds: tags.ids, missingTags: tags.missing };
}

export interface ScoredResult {
  ids: string[];
  entities: EntityLite[];
  status: number | null;
  dry: boolean;
  billIds: string[];
  poolSize: number;
}

/** The same pool scored with a bill as signal (filter.results.entities). */
export async function scoredPoolAt(
  ctx: ProbeContext,
  venueKey: string,
  billIndex: number,
  extra: { demographicsAge?: string[]; audiences?: string[]; tag?: string } = {},
): Promise<ScoredResult | null> {
  const point = venuePoint(ctx, venueKey);
  const bill = billsAt(ctx, venueKey)[billIndex];
  if (!point || !bill) return null;
  const pool = await poolAt(ctx, venueKey);
  if (!pool || (!pool.dry && pool.ids.length === 0)) return null;
  const { ids: billIds } = await resolveBill(ctx, bill);
  if (billIds.length === 0) return null;
  const suffix = extra.demographicsAge ? " + age signal" : extra.audiences ? " + audience signal" : "";
  const spec = placeInsights({
    point,
    radiusM: ctx.cfg.kg1.poolRadiusM,
    signalEntities: billIds,
    ...(extra.demographicsAge ? { demographicsAge: extra.demographicsAge } : {}),
    ...(extra.audiences ? { audiences: extra.audiences } : {}),
    resultsEntities: pool.ids,
    take: Math.min(50, Math.max(pool.ids.length, ctx.cfg.kg1.poolSize)),
    label: `pool near ${venueKey} scored by bill ${bill.label}${suffix}`,
  });
  const res = await ctx.call(spec);
  if (res.dry) return { ids: [], entities: [], status: null, dry: true, billIds, poolSize: pool.ids.length };
  const entities = res.status === 200 ? insightEntities(res.json) : [];
  return { ids: entities.map((e) => e.id), entities, status: res.status, dry: false, billIds, poolSize: pool.ids.length };
}

// ---------------------------------------------------------------------------
// House set
// ---------------------------------------------------------------------------

export interface HouseSet {
  ids: string[];
  source: "roster" | "stand-in";
  note: string;
}

/**
 * The room's usual crowd. With Ticketmaster roster Spotify ids for this venue
 * (filled on key day) it is the resolved roster; otherwise a stand-in: the
 * headliners of the test bills configured for the other rooms.
 */
export async function houseFor(ctx: ProbeContext, venueKey: string): Promise<HouseSet> {
  const roster = ctx.cfg.roster;
  const c = ctx.cfg.kg2;
  let rosterMiss: string | null = null;
  if (roster.venue === venueKey && roster.spotifyIds.length > 0) {
    const res = await ctx.call(entitiesBySpotify(roster.spotifyIds.slice(0, 60), `house roster for ${venueKey} by spotify ids`));
    if (res.dry) return { ids: [placeholderId("house", venueKey)], source: "roster", note: "roster via /entities external.spotify.ids" };
    const ents = res.status === 200 ? anyEntities(res.json) : [];
    const ids = ents.map((e) => e.id).slice(0, c.houseMaxEntities);
    if (ids.length >= c.houseMinResolved) {
      return { ids, source: "roster", note: `${ids.length} roster acts resolved from ${roster.spotifyIds.length} spotify ids` };
    }
    rosterMiss = `roster lookup resolved ${ents.length} of ${Math.min(60, roster.spotifyIds.length)} spotify ids (HTTP ${res.status ?? "no response"}; need ${c.houseMinResolved})`;
  }
  const ids: string[] = [];
  const heads: ActCfg[] = [];
  for (const [v, bills] of Object.entries(ctx.cfg.kg1.bills)) {
    if (v === venueKey) continue;
    for (const b of bills) {
      const head = b.acts[0];
      if (head) heads.push(head);
    }
  }
  for (const r of await resolveActs(ctx, heads)) if (r && !ids.includes(r.id)) ids.push(r.id);
  return {
    ids: ids.slice(0, c.houseMaxEntities),
    source: "stand-in",
    note: rosterMiss
      ? `${rosterMiss}, so the house is a stand-in: headliners of the test bills for the other rooms`
      : "stand-in house: headliners of the test bills for the other rooms (fill roster.spotifyIds from Ticketmaster for the real house)",
  };
}

export function kindLabel(kind: EntityKind): string {
  return kind.replace("_", " ");
}
