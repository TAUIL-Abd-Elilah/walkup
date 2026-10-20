/**
 * Qloo side of the fixture world: a fetch-compatible transport answering
 * /search, /entities, /v2/insights (heatmap, demographics, tag, place,
 * podcast, brand, artist, person, movie, tv_show), /v2/analysis/compare,
 * /v2/tags and /v2/audiences with bodies shaped like the live API (field names
 * and placement checked against live bodies on Oct 15; values are invented).
 * Every body says synthetic: true. POST /v2/insights (weighted signals) is a 400, as live (probe 14).
 *
 * Like the live API, unknown or inapplicable params are ignored with HTTP 200;
 * a heatmap without a signal or location is a 400; output.heatmap.boundary
 * city|neighborhood is a 400; unsupported entity types are a 403. Error bodies
 * are {errors: [{message, path?}]}.
 *
 * Live placement mirrored here:
 *  - /search and /entities rows: types[], properties.external.<ns> = {id}, tag refs {tag_id, name, type, value},
 *    places with location {lat, lon} only.
 *  - insights rows: type + subtype, top-level external.<ns> = [{id}], tag refs {id, name, type, weight: null},
 *    places with location {lat, lon, geohash (12 chars)}, properties.neighborhood null, properties.localities[]
 *    (city and ZCTA rows), numeric business_rating, hours {<weekday>: [{closed, opens, closes}]}.
 *  - heatmaps: only success and results (no response-level query, no duration).
 *  - demographics: every block keyed by entity_id (a signal tag's block holds the tag URN).
 *  - a signal id the world has no taste data for (catalog noSignal) is dropped: entity insights add
 *    warnings [{type: "not_found", "signal.interests.entities": [ids]}]; heatmaps, tag profiles and compare
 *    drop it silently; demographics still return its block; a heatmap left with only not_found ids is still a 200
 *    with cells (plain foot traffic), and only a malformed id makes it a 400; an entity insights call with no usable
 *    signal, no filter and no signal.location is a 400 on signal.interests.entities.
 */
import {
  ALL_TAGS,
  CONTENT_TAGS,
  DENIED_ETHNICITY,
  DENIED_KEYWORD,
  rawTag,
  tagById,
  tagNamespace,
  type WorldTag,
} from "./catalog-tags";
import { CATALOG, catalogById, catalogBySpotify, type CatalogEntity } from "./catalog-entities";
import { encodeGeohash, haversineKm, parseLatLon, parseWktPoint } from "./geo";
import { bodyText, canonicalParams, jsonResponse, type FetchLike } from "./http";
import { audienceField } from "./audience";
import { metroFor, populatedGrid } from "./metro";
import { deniedTagsFor, placeById, placesWithin, type WorldPlace } from "./places-gen";
import { clamp, gauss, pick, round, unit } from "./rng";
import type { Scenario } from "./scenario";
import { addScaled, cosine, DIMS, isZero, weightedMatch, zeroTaste, type Taste } from "./taste";

export interface WorldContext {
  seed: string;
  scenario(): Scenario;
  count(kind: "qloo" | "tm" | "places", path: string): number;
}

type Params = Map<string, string>;

interface SignalEntity {
  id: string;
  weight: number;
}

interface Signal {
  taste: Taste;
  entities: SignalEntity[];
  tags: string[];
  /** Every signal entity is a thin one. */
  thin: boolean;
  empty: boolean;
  /** Signal ids left out because the world has no taste data for them (live: not_found). */
  dropped: string[];
}

/**
 * Heat is mostly foot traffic (live heatmaps track popularity at 0.9 and up).
 * On top of a cell's density, for a signal with taste:
 *   x (1 - S c / 2 + S c m)   m = match with the shared preference field, S = HEAT_TASTE_SWING
 *   x (1 + A c a)             a = match with the audience field (audience.ts), taste weights squared, A = HEAT_AUDIENCE_GAIN
 *   x (1 + E n)               n = mean over the signal's entities and tags of a per-seed, per-cell normal draw, E = HEAT_SEED_NOISE
 * where c = coherence ^ HEAT_COHERENCE_POWER and coherence = |sum of weighted taste vectors| / sum of their lengths
 * (1 when every seed points the same way). A broad signal, such as a room's twelve headliners across genres, looks
 * more like plain foot traffic than a focused bill. Seed subsets of one bill agree on where its crowd lives but are
 * not identical, so a split-half check on lift has something to measure.
 */
const HEAT_TASTE_SWING = 0.2;
const HEAT_AUDIENCE_GAIN = 1;
const HEAT_COHERENCE_POWER = 5;
const HEAT_SEED_NOISE = 0.01;
const HEAT_NOISE = 0.01;
/** Thin signals have place affinities for only this share of places. */
const THIN_PLACE_SHARE = 0.05;

const WEEKDAY_KEYS: Record<string, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

function list(p: Params, key: string): string[] {
  const v = p.get(key);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(p: Params, key: string): number | null {
  const v = p.get(key);
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the (?=\S)/, "");
}

/** Taste of any id: catalog entity, place, or (unknown id) a seeded vector. */
function tasteOfId(id: string, seed: string): { taste: Taste; thin: boolean; known: boolean } {
  const e = catalogById(id);
  if (e) return { taste: e.taste, thin: !!e.thin, known: true };
  const p = placeById(id, seed);
  if (p) return { taste: p.taste, thin: false, known: true };
  return { taste: DIMS.map((d) => unit(`${seed}|unknown|${id}|${d}`) * 0.5), thin: false, known: false };
}

/** True for ids Qloo lists but has no taste data for (the scripted not_found case). */
function noSignal(id: string): boolean {
  return catalogById(id)?.noSignal === true;
}

function readSignal(p: Params, seed: string, prefix = ""): Signal {
  const asked: SignalEntity[] = list(p, `${prefix}signal.interests.entities`).map((id) => ({ id, weight: 1 }));
  const dropped = asked.filter((e) => noSignal(e.id)).map((e) => e.id);
  const entities = asked.filter((e) => !noSignal(e.id));
  const tags = list(p, `${prefix}signal.interests.tags`);
  const t = zeroTaste();
  let thinAll = entities.length > 0;
  for (const e of entities) {
    const x = tasteOfId(e.id, seed);
    addScaled(t, x.taste, e.weight);
    if (!x.thin) thinAll = false;
  }
  for (const id of tags) {
    const tag = tagById(id);
    if (tag) addScaled(t, tag.vec, 1);
  }
  const total = entities.reduce((s, e) => s + e.weight, 0) + tags.length;
  if (total > 0) for (let i = 0; i < t.length; i++) t[i] = (t[i] ?? 0) / total;
  return { taste: t, entities, tags, thin: thinAll, empty: entities.length === 0 && tags.length === 0, dropped };
}

/** Live 2xx warning for ignored signal ids (the dotted parameter name is a literal key). */
function notFoundWarnings(sig: Signal): Record<string, unknown>[] {
  return sig.dropped.length > 0 ? [{ type: "not_found", "signal.interests.entities": sig.dropped }] : [];
}

/** Live 4xx body. Messages are the world's own wording. */
function errorBody(message: string, path?: string): Record<string, unknown> {
  return { synthetic: true, errors: [path ? { message, path } : { message }] };
}

const SIGNAL_PATH = "signal.interests.entities";

/** Entity ids are UUIDs; anything else in a heatmap signal is a 400 (live). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How much a signal's seeds point the same way: |sum of weighted taste vectors| / sum of their weighted lengths,
 * in [0, 1]. One seed, or seeds of one kind, give about 1; a mix of genres gives less.
 */
function coherence(sig: Signal, seed: string): number {
  const len = (v: Taste) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  let lengths = 0;
  let weight = 0;
  for (const e of sig.entities) {
    lengths += e.weight * len(tasteOfId(e.id, seed).taste);
    weight += e.weight;
  }
  for (const id of sig.tags) {
    const tag = tagById(id);
    if (tag) lengths += len(tag.vec);
    weight += 1;
  }
  // sig.taste is the weighted mean, so its length times the total weight is the length of the weighted sum.
  return lengths > 0 ? clamp((len(sig.taste) * weight) / lengths, 0, 1) : 1;
}

/** Percentile rank in (0, 1], ties share their average rank. */
function pctRanks(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const out = new Array<number>(values.length).fill(0);
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && (idx[j + 1] as { v: number }).v === (idx[k] as { v: number }).v) j++;
    const avg = (k + j + 2) / 2;
    for (let m = k; m <= j; m++) out[(idx[m] as { i: number }).i] = avg / values.length;
    k = j + 1;
  }
  return out;
}

/** Month quota the world reports unless a scenario sets one. Fixed, so a long-running fixture server never trips the guard on a quota that does not exist. */
export const WORLD_QUOTA_REMAINING = 9000;

function headers(ctx: WorldContext): Record<string, string> {
  const q = ctx.scenario().quotaRemaining;
  const remaining = q ?? WORLD_QUOTA_REMAINING;
  return {
    "x-second-ratelimit-limit": "5",
    "x-month-ratelimit-limit": "10000",
    "x-month-ratelimit-remaining": String(remaining),
  };
}

function err(status: number, message: string, h: Record<string, string>): Response {
  return jsonResponse(status, errorBody(message), h);
}

// ---------------------------------------------------------------------------
// Entity bodies
// ---------------------------------------------------------------------------

/**
 * A tag reference as the live API writes it: /search and /entities rows use {tag_id, name, type, value};
 * insights rows use {id, name, type, weight: null}.
 */
function tagRef(t: WorldTag, flat: boolean): Record<string, unknown> {
  const r = rawTag(t);
  return flat ? { tag_id: r.id, name: r.name, type: r.type, value: r.id } : { ...r, weight: null };
}

function personTags(e: CatalogEntity, sc: Scenario, flat: boolean): Record<string, unknown>[] {
  const tags = e.tagIds.map((id) => tagById(id)).filter((t): t is WorldTag => !!t);
  if (sc.deniedTags && e.subtype === "urn:entity:person") tags.push(DENIED_ETHNICITY);
  return tags.map((t) => tagRef(t, flat));
}

/** Live hours: lowercase weekday keys, a closed day is [{closed: true, opens: null, closes: null}]. */
function liveHours(hours: Record<string, { opens: string; closes: string }[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [day, slots] of Object.entries(hours)) {
    out[day.toLowerCase()] = slots.length === 0 ? [{ closed: true, opens: null, closes: null }] : slots.map((x) => ({ closed: false, opens: x.opens, closes: x.closes }));
  }
  return out;
}

/** Live properties.localities: one row per containing area; the ZCTA row's name is the ZIP code. */
function localities(p: WorldPlace): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [{ name: p.city, place: "city", boundary: "administrative", admin_level: 8, locality_id: `synthetic-city-${p.metro}`, abbreviation: null, country_code: null }];
  if (p.zip) rows.push({ name: p.zip, place: "ZCTA", boundary: "ZCTA", admin_level: 10, locality_id: `z${p.zip}`, abbreviation: null, country_code: null });
  rows.push({ name: p.state, place: "state", boundary: "administrative", admin_level: 4, locality_id: `synthetic-state-${p.state}`, abbreviation: p.state, country_code: null });
  return rows;
}

/**
 * `flat` = a /search or /entities row (types[], properties.external.<ns> = {id}); otherwise an insights row
 * (type + subtype, top-level external.<ns> = [{id}]).
 */
function catalogBody(e: CatalogEntity, sc: Scenario, query?: Record<string, unknown>, flat = false): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (e.shortDescription) props.short_description = `${e.shortDescription} (synthetic)`;
  if (e.releaseYear !== undefined) {
    props.release_year = e.releaseYear;
    props.release_date = `${e.releaseYear}-01-01`;
  }
  const body: Record<string, unknown> = {
    name: e.name,
    entity_id: e.id,
    popularity: e.popularity,
    tags: personTags(e, sc, flat),
    properties: props,
  };
  if (flat) body.types = [e.subtype];
  else {
    body.type = "urn:entity";
    body.subtype = e.subtype;
  }
  if (e.spotifyId) {
    if (flat) props.external = { spotify: { id: e.spotifyId } };
    else body.external = { spotify: [{ id: e.spotifyId }] };
  }
  if (e.subtype === "urn:entity:place" && e.location) {
    body.location = flat
      ? { lat: e.location.lat, lon: e.location.lon }
      : { lat: e.location.lat, lon: e.location.lon, geohash: encodeGeohash(e.location.lat, e.location.lon, 12) };
    props.address = e.address ?? null;
  }
  if (query) body.query = query;
  return body;
}

function placeBody(p: WorldPlace, sc: Scenario, query: Record<string, unknown> | undefined, flat = false): Record<string, unknown> {
  const closed = p.u.closed < sc.closedRate;
  const props: Record<string, unknown> = {
    address: p.address,
    // Live place rows carry neighborhood: null (Oct 15); areas come from localities and the gazetteer.
    neighborhood: null,
    phone: p.phone,
    website: p.website,
    price_level: p.priceLevel,
    business_rating: p.rating,
    is_closed: closed,
    geocode: { city: p.city, admin1_region: p.state, country_code: "US", name: null },
    localities: localities(p),
    akas: [{ value: p.name, language: "en" }],
  };
  if (!(p.u.noHours < sc.noHoursRate)) props.hours = liveHours(p.hours);
  const tags = [...p.tagIds, ...deniedTagsFor(p, sc.deniedTags)]
    .map((id) => tagById(id))
    .filter((t): t is WorldTag => !!t)
    .map((t) => tagRef(t, flat));
  const body: Record<string, unknown> = {
    name: p.name,
    entity_id: p.id,
    popularity: p.popularity,
    // /search rows have no geohash; insights rows carry a 12-character one.
    location: flat ? { lat: p.lat, lon: p.lon } : { lat: p.lat, lon: p.lon, geohash: encodeGeohash(p.lat, p.lon, 12) },
    properties: props,
    tags,
  };
  if (flat) body.types = ["urn:entity:place"];
  else {
    body.type = "urn:entity";
    body.subtype = "urn:entity:place";
  }
  if (query) body.query = query;
  return body;
}

function placeIsOpenOn(p: WorldPlace, sc: Scenario, weekday: string): boolean {
  if (p.u.noHours < sc.noHoursRate) return true; // unknown hours: Qloo cannot rule it out
  const day = WEEKDAY_KEYS[weekday.toLowerCase()];
  if (!day) return true;
  return (p.hours[day] ?? []).length > 0;
}

function placeTagIds(p: WorldPlace, sc: Scenario): string[] {
  return [...p.tagIds, ...deniedTagsFor(p, sc.deniedTags)];
}

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

function contributions(sig: Signal, target: Taste, seed: string): { entity_id: string; score: number }[] {
  if (sig.entities.length === 0) return [];
  const raw = sig.entities.map((e) => ({ id: e.id, s: Math.max(0, cosine(tasteOfId(e.id, seed).taste, target)) * e.weight }));
  const max = Math.max(...raw.map((r) => r.s), 1e-9);
  return raw
    .map((r) => ({ entity_id: r.id, score: round(clamp((r.s / max) * 0.9, 0, 1), 3) }))
    .filter((c) => c.score >= 0.1);
}

function aggregateExplainability(rows: { contribs: { entity_id: string; score: number }[] }[], sig: Signal): Record<string, unknown> {
  const avg = (n: number, id: string) => {
    const slice = rows.slice(0, n);
    if (slice.length === 0) return 0;
    const s = slice.reduce((acc, r) => acc + (r.contribs.find((c) => c.entity_id === id)?.score ?? 0), 0);
    return round(s / slice.length, 3);
  };
  return {
    "signal.interests.entities": sig.entities.map((e) => ({
      entity_id: e.id,
      average_influence: { top_3: avg(3, e.id), top_5: avg(5, e.id), top_10: avg(10, e.id), all: avg(rows.length, e.id) },
    })),
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleSearch(p: Params, ctx: WorldContext): { status: number; body: unknown } {
  const sc = ctx.scenario();
  const q = normalizeName(p.get("query") ?? "");
  if (!q) return { status: 400, body: errorBody("query is required", "query") };
  const types = list(p, "types").map((t) => (t === "urn:entity:videogame" ? "urn:entity:video_game" : t));
  const take = clamp(Math.round(num(p, "take") ?? 20), 1, 199);
  const loc = parseLatLon(p.get("filter.location"));
  const radiusKm = clamp(num(p, "filter.radius") ?? 10, 0, 100) * 1.609344;
  const qTokens = q.split(" ");
  const score = (name: string): number => {
    const n = normalizeName(name);
    if (n === q) return 3;
    if (n.startsWith(`${q} `) || n.endsWith(` ${q}`)) return 1.5;
    const tokens = new Set(n.split(" "));
    return qTokens.every((t) => tokens.has(t)) ? 1 : 0;
  };
  const hits: { s: number; pop: number; body: Record<string, unknown> }[] = [];
  const wantType = (t: string) => types.length === 0 || types.includes(t);
  for (const e of CATALOG) {
    if (!wantType(e.subtype)) continue;
    if (e.subtype === "urn:entity:place") continue;
    const s = score(e.name);
    if (s > 0) hits.push({ s, pop: e.popularity, body: catalogBody(e, sc, undefined, true) });
  }
  if (wantType("urn:entity:place")) {
    const places: WorldPlace[] = loc ? placesWithin(loc, radiusKm * 1000, ctx.seed) : [];
    const seen = new Set<string>();
    for (const pl of places) {
      if (seen.has(pl.id)) continue;
      seen.add(pl.id);
      const s = score(pl.name);
      if (s > 0) hits.push({ s, pop: pl.popularity, body: placeBody(pl, sc, undefined, true) });
    }
    if (!loc) {
      for (const e of CATALOG) {
        if (e.subtype !== "urn:entity:place") continue;
        const s = score(e.name);
        const pl = placeById(e.id, ctx.seed);
        if (s > 0 && pl) hits.push({ s, pop: e.popularity, body: placeBody(pl, sc, undefined, true) });
      }
    }
  }
  hits.sort((a, b) => b.s - a.s || b.pop - a.pop || String(a.body.entity_id).localeCompare(String(b.body.entity_id)));
  if (hits.length === 0) return { status: 404, body: errorBody("No entities found") };
  return { status: 200, body: { synthetic: true, results: hits.slice(0, take).map((h) => h.body) } };
}

function handleEntities(p: Params, ctx: WorldContext): { status: number; body: unknown } {
  const sc = ctx.scenario();
  const out: Record<string, unknown>[] = [];
  for (const id of list(p, "entity_ids")) {
    const e = catalogById(id);
    if (e && e.subtype !== "urn:entity:place") out.push(catalogBody(e, sc, undefined, true));
    else {
      const pl = placeById(id, ctx.seed);
      if (pl) out.push(placeBody(pl, sc, undefined, true));
    }
  }
  for (const sid of list(p, "external.spotify.ids")) {
    const e = catalogBySpotify(sid);
    if (e) out.push(catalogBody(e, sc, undefined, true));
  }
  return { status: 200, body: { synthetic: true, results: out } };
}

function handleHeatmap(p: Params, sig: Signal, ctx: WorldContext, noise: string): { status: number; body: unknown } {
  const sc = ctx.scenario();
  const boundary = (p.get("output.heatmap.boundary") ?? "").toLowerCase();
  if (boundary === "city" || boundary === "neighborhood") {
    return { status: 400, body: errorBody("output.heatmap.boundary must be urn:geohash or urn:entity:locality", "output.heatmap.boundary") };
  }
  const point = parseWktPoint(p.get("filter.location"));
  const malformed = list(p, "signal.interests.entities").filter((id) => !UUID_RE.test(id));
  if (malformed.length > 0) {
    // Live (probe 2, Oct 15): a malformed id is a 400 that blames signal.interests.entities.
    return { status: 400, body: errorBody("signal.interests.entities must be entity ids", SIGNAL_PATH) };
  }
  // Live (probe 2, Oct 15): a not_found id is dropped silently, and a heatmap left with only not_found ids is still a
  // 200 with cells (plain foot traffic: no taste moves them). A heatmap never says whether a seed was usable.
  const onlyDropped = sig.empty && sig.dropped.length > 0;
  if (!point || (sig.empty && !onlyDropped)) {
    return { status: 400, body: errorBody("at least one valid signal and filter.location or filter.location.query is required") };
  }
  const radiusKm = clamp((num(p, "filter.location.radius") ?? 30000) / 1000, 1, 800);
  const m = metroFor(point.lat, point.lon, ctx.seed);
  const results: unknown[] = [];
  if (m) {
    const grid = populatedGrid(m, point, radiusKm, ctx.seed);
    const thin = sc.thinHeatmap || sig.thin;
    const cap = Math.max(1, Math.round((thin ? 150 : 2600) * (radiusKm / 40) ** 2));
    let cells = grid.slice(0, cap);
    if (thin && grid.length > cap) {
      // Thin signals have data in scattered cells (likelier where people are), not only downtown.
      const mean = grid.reduce((s2, c) => s2 + c.density, 0) / grid.length;
      const keep = (cap / grid.length) / Math.max(1e-6, mean);
      cells = grid.filter((c) => unit(`${ctx.seed}|thin|${c.geohash}`) < keep * c.density);
    }
    const zero = isZero(sig.taste);
    const focus = zero ? 0 : coherence(sig, ctx.seed) ** HEAT_COHERENCE_POWER;
    const swing = HEAT_TASTE_SWING * focus;
    const gain = HEAT_AUDIENCE_GAIN * focus;
    const squared = sig.taste.map((x) => Math.max(0, x) ** 2);
    const audience = audienceField(m, ctx.seed);
    const seeds = [...sig.entities.map((e) => ({ key: e.id, w: e.weight })), ...sig.tags.map((t) => ({ key: t, w: 1 }))];
    const seedWeight = seeds.reduce((s2, x) => s2 + x.w, 0) || 1;
    const match = cells.map((cell) => weightedMatch(sig.taste, cell.field));
    const scores = cells.map((cell, i) => {
      const aud = zero ? 0 : weightedMatch(squared, audience(cell.lat, cell.lon));
      const seedNoise = seeds.reduce((s2, x) => s2 + x.w * gauss(`${ctx.seed}|seed heat|${x.key}|${cell.geohash}`), 0) / seedWeight;
      return (
        cell.density * (1 - swing / 2 + swing * (match[i] as number)) * (1 + gain * aud) * (1 + HEAT_SEED_NOISE * seedNoise) +
        // Noise is mostly a property of the cell (sparse data there), a little of the request.
        HEAT_NOISE * (0.8 * gauss(`${ctx.seed}|cell|${cell.geohash}`) + 0.2 * gauss(`${noise}|${cell.geohash}`))
      );
    });
    const aff = pctRanks(scores);
    const affRank = pctRanks(match.map((x, i) => x + 1e-6 * unit(`${noise}|r|${(cells[i] as { geohash: string }).geohash}`)));
    const pop = pctRanks(cells.map((c) => c.density));
    const rows = cells.map((c, i) => ({
      location: { latitude: round(c.lat, 6), longitude: round(c.lon, 6), geohash: c.geohash },
      query: { affinity: round(aff[i] as number, 4), affinity_rank: round(affRank[i] as number, 4), popularity: round(pop[i] as number, 4) },
    }));
    rows.sort((a, b) => b.query.affinity - a.query.affinity || (a.location.geohash < b.location.geohash ? -1 : 1));
    results.push(...rows);
  }
  // Live heatmap bodies carry only success and results.
  return { status: 200, body: { synthetic: true, success: true, results: { heatmap: results } } };
}

const AGE_BUCKETS = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"] as const;
const AGE_PROFILE: Record<string, number[]> = {
  roots: [-0.4, -0.2, 0, 0.2, 0.4, 0.5],
  hiphop_rnb: [0.6, 0.5, 0.2, -0.1, -0.4, -0.6],
  indie_alt: [0.3, 0.6, 0.4, 0, -0.3, -0.5],
  comedy_night: [-0.1, 0.2, 0.4, 0.4, 0.1, -0.2],
  latin: [0.3, 0.4, 0.3, 0.1, -0.2, -0.4],
  family: [-0.3, -0.2, 0.1, 0.5, 0.3, 0.1],
  arts_dining: [-0.4, -0.2, 0, 0.2, 0.4, 0.5],
};
const MALE_LEAN: Record<string, number> = { roots: 0.08, hiphop_rnb: 0.04, indie_alt: 0.02, comedy_night: 0.06, latin: 0, family: -0.1, arts_dining: -0.08 };

function demographicsBlock(key: string, v: Taste, noise: string): Record<string, unknown> {
  const total = v.reduce((s, x) => s + Math.max(0, x), 0) || 1;
  const age: Record<string, number> = {};
  AGE_BUCKETS.forEach((b, bi) => {
    let s = 0;
    DIMS.forEach((d, di) => {
      s += Math.max(0, v[di] ?? 0) * ((AGE_PROFILE[d] ?? [])[bi] ?? 0);
    });
    age[b] = round(clamp(s / total + 0.04 * gauss(`${noise}|${key}|${b}`), -0.9, 0.9), 3);
  });
  let m = 0;
  DIMS.forEach((d, di) => {
    m += Math.max(0, v[di] ?? 0) * (MALE_LEAN[d] ?? 0);
  });
  const male = round(clamp(m / total + 0.02 * gauss(`${noise}|${key}|g`), -0.5, 0.5), 3);
  // Live: every block, a signal tag's included, is keyed by entity_id.
  return { entity_id: key, query: { age, gender: { male, female: round(-male, 3) } } };
}

function handleDemographics(p: Params, sig: Signal, ctx: WorldContext, noise: string): { status: number; body: unknown } {
  if (sig.empty && sig.dropped.length === 0) return { status: 400, body: errorBody("a signal is required", SIGNAL_PATH) };
  const blocks: Record<string, unknown>[] = [];
  // Live: demographics still return a block for an id other calls report as not_found.
  for (const e of list(p, "signal.interests.entities").map((id) => ({ id }))) {
    const c = catalogById(e.id);
    // Person entities carry no audience block in this world (thin by design).
    if (c && c.subtype === "urn:entity:person") continue;
    const t = tasteOfId(e.id, ctx.seed);
    if (!t.known) continue;
    blocks.push(demographicsBlock(e.id, t.taste, noise));
  }
  for (const id of sig.tags) {
    const tag = tagById(id);
    if (tag && !isZero(tag.vec)) blocks.push(demographicsBlock(id, tag.vec, noise));
  }
  return { status: 200, body: { synthetic: true, success: true, duration: 120, results: { demographics: blocks } } };
}

function handleTagProfile(p: Params, sig: Signal, ctx: WorldContext, noise: string): { status: number; body: unknown } {
  if (sig.empty) return { status: 400, body: errorBody("a signal is required", SIGNAL_PATH) };
  const sc = ctx.scenario();
  const types = list(p, "filter.tag.types");
  const parents = list(p, "filter.parents.types");
  const take = clamp(Math.round(num(p, "take") ?? 20), 1, 50);
  const diversify = p.get("diversify.by") === "subtype";
  const perSubtype = diversify ? clamp(Math.round(num(p, "diversify.take") ?? 8), 1, 50) : Infinity;
  let pool: WorldTag[] = CONTENT_TAGS.filter((t) => !isZero(t.vec));
  if (types.length > 0) pool = pool.filter((t) => types.some((ns) => t.id.startsWith(`${ns}:`)));
  if (parents.length > 0) pool = pool.filter((t) => t.parents.some((x) => parents.includes(x)));
  const scored = pool
    .map((t) => ({ t, s: cosine(sig.taste, t.vec) + 0.06 * gauss(`${noise}|${t.id}`) }))
    .sort((a, b) => b.s - a.s || (a.t.id < b.t.id ? -1 : 1));
  const counts = new Map<string, number>();
  const picked: { t: WorldTag; s: number }[] = [];
  for (const x of scored) {
    const ns = tagNamespace(x.t.id);
    if ((counts.get(ns) ?? 0) >= perSubtype) continue;
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
    picked.push(x);
  }
  let rows = picked.slice(0, sig.thin ? 3 : take);
  if (sc.deniedTags && (types.length === 0 || types.some((ns) => DENIED_KEYWORD.id.startsWith(`${ns}:`)))) {
    const at = Math.min(3, rows.length);
    rows = [...rows.slice(0, at), { t: DENIED_KEYWORD, s: rows[at - 1]?.s ?? 0.5 }, ...rows.slice(at)].slice(0, Math.max(take, rows.length));
  }
  const top = Math.max(...rows.map((r) => r.s), 1e-9);
  const tags = rows.map((r) => ({
    tag_id: r.t.id,
    name: r.t.name,
    types: r.t.parents,
    subtype: tagNamespace(r.t.id),
    tag_value: r.t.id,
    popularity: r.t.popularity,
    query: { affinity: round(clamp(0.5 + 0.5 * (r.s / top), 0, 1), 4) },
  }));
  return { status: 200, body: { synthetic: true, success: true, duration: 140, results: { tags } } };
}

function insightsEntities(
  p: Params,
  sig: Signal,
  type: string,
  ctx: WorldContext,
  noise: string,
): { status: number; body: unknown } {
  const sc = ctx.scenario();
  const take = clamp(Math.round(num(p, "take") ?? 20), 1, 50);
  const page = clamp(Math.round(num(p, "page") ?? 1), 1, 100);
  const explain = p.get("feature.explainability") === "true";
  const excludeTags = new Set(list(p, "filter.exclude.tags"));
  const excludeIds = new Set(list(p, "filter.exclude.entities"));
  const resultsIds = list(p, "filter.results.entities");
  const filterTags = list(p, "filter.tags");
  const op = (p.get("operator.filter.tags") ?? "union").toLowerCase();
  const point = parseWktPoint(p.get("filter.location"));
  const signalPoint = parseWktPoint(p.get("signal.location"));
  const hasSignal = !sig.empty;
  if (!hasSignal && sig.dropped.length > 0 && !signalPoint && !point && filterTags.length === 0 && resultsIds.length === 0) {
    // Live: every signal id unknown and nothing else to rank by -> 400 that blames signal.interests.entities.
    return { status: 400, body: errorBody("Every signal.interests.entities id was invalid; entity insights need at least one valid signal or filter", SIGNAL_PATH) };
  }
  const warnings = notFoundWarnings(sig);

  type Row = { body: (q: Record<string, unknown>) => Record<string, unknown>; score: number; taste: Taste; distance: number | null };
  const rows: Row[] = [];

  if (type === "urn:entity:place") {
    const radiusM = clamp(num(p, "filter.location.radius") ?? 5000, 0, 800_000);
    let candidates: WorldPlace[] = [];
    if (resultsIds.length > 0) {
      candidates = resultsIds.map((id) => placeById(id, ctx.seed)).filter((x): x is WorldPlace => !!x);
      if (point) candidates = candidates.filter((c) => haversineKm(point, c) * 1000 <= radiusM);
    } else if (point) {
      candidates = placesWithin(point, radiusM, ctx.seed);
    }
    const hours = p.get("filter.hours");
    const priceMax = num(p, "filter.price_level.max");
    const priceMin = num(p, "filter.price_level.min");
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (excludeIds.has(c.id)) continue;
      const tags = placeTagIds(c, sc);
      if (tags.some((t) => excludeTags.has(t))) continue;
      if (filterTags.length > 0) {
        const ok = op === "intersection" ? filterTags.every((t) => tags.includes(t)) : filterTags.some((t) => tags.includes(t));
        if (!ok) continue;
      }
      if (hours && !placeIsOpenOn(c, sc, hours)) continue;
      if (priceMax !== null && c.priceLevel > priceMax) continue;
      if (priceMin !== null && c.priceLevel < priceMin) continue;
      if (hasSignal && sig.thin && c.u.sparse > THIN_PLACE_SHARE && resultsIds.length === 0) continue;
      const match = hasSignal ? Math.max(0, cosine(sig.taste, c.taste)) : 0;
      const noiseU = unit(`${noise}|${c.id}`);
      const score = hasSignal ? 0.62 * match + 0.26 * c.popularity + 0.12 * noiseU : c.popularity + 0.001 * noiseU;
      const distance = point ? round(haversineKm(point, c) * 1000, 1) : null;
      rows.push({ body: (q) => placeBody(c, sc, q), score, taste: c.taste, distance });
    }
  } else {
    if (type === "urn:entity:brand" && (sc.emptyBrands || (hasSignal && sig.thin))) {
      return { status: 200, body: { synthetic: true, success: true, duration: 90, results: { entities: [] }, ...(warnings.length > 0 ? { warnings } : {}) } };
    }
    const metro = signalPoint ? metroFor(signalPoint.lat, signalPoint.lon, ctx.seed) : null;
    for (const e of CATALOG) {
      if (e.subtype !== type) continue;
      if (e.testOnly && !resultsIds.includes(e.id)) continue;
      if (excludeIds.has(e.id)) continue;
      if (resultsIds.length > 0 && !resultsIds.includes(e.id)) continue;
      if (e.tagIds.some((t) => excludeTags.has(t))) continue;
      if (filterTags.length > 0 && !filterTags.some((t) => e.tagIds.includes(t))) continue;
      // Signal entities are not recommended back to themselves.
      if (sig.entities.some((s) => s.id === e.id)) continue;
      const match = hasSignal ? Math.max(0, cosine(sig.taste, e.taste)) : 0;
      // Brands move with signal.location (local brands rise); podcasts do not.
      const local = type === "urn:entity:brand" && metro && e.metro === metro.key ? 0.22 : 0;
      const score = (hasSignal ? 0.6 * match + 0.3 * e.popularity : e.popularity) + local + 0.1 * unit(`${noise}|${e.id}`);
      rows.push({ body: (q) => catalogBody(e, sc, q), score, taste: e.taste, distance: null });
    }
    if (hasSignal && sig.thin && type === "urn:entity:podcast") rows.splice(0, rows.length, ...rows.sort((a, b) => b.score - a.score).slice(0, 3));
  }

  rows.sort((a, b) => b.score - a.score || (a.distance ?? 0) - (b.distance ?? 0));
  const slice = rows.slice((page - 1) * take, page * take);
  const top = slice[0]?.score ?? 1;
  const bottom = rows[rows.length - 1]?.score ?? 0;
  const span = Math.max(1e-9, top - bottom);
  const withContribs = slice.map((r) => ({ r, contribs: explain && hasSignal ? contributions(sig, r.taste, ctx.seed) : [] }));
  const entities = withContribs.map(({ r, contribs }) => {
    const q: Record<string, unknown> = {};
    if (hasSignal) q.affinity = round(clamp(0.55 + 0.44 * ((r.score - bottom) / span), 0, 1), 4);
    if (r.distance !== null) q.distance = r.distance;
    if (explain && hasSignal) q.explainability = { "signal.interests.entities": contribs };
    return r.body(q);
  });
  const body: Record<string, unknown> = { synthetic: true, success: true, duration: 150 + pick(noise, 400), results: { entities } };
  if (warnings.length > 0) body.warnings = warnings;
  if (explain && hasSignal) body.query = { explainability: aggregateExplainability(withContribs, sig) };
  return { status: 200, body };
}

function handleCompare(p: Params, ctx: WorldContext, noise: string): { status: number; body: unknown } {
  const sc = ctx.scenario();
  const a = readSignal(p, ctx.seed, "a.");
  const b = readSignal(p, ctx.seed, "b.");
  if (a.empty || b.empty) return { status: 400, body: errorBody("both a and b signals are required", a.empty ? "a.signal.interests.entities" : "b.signal.interests.entities") };
  const take = clamp(Math.round(num(p, "take") ?? 20), 1, 50);
  if (sc.emptyCompare) return { status: 200, body: { synthetic: true, duration: 80, results: { tags: [], a: [], b: [], matchEntities: [] } } };
  const scored = CONTENT_TAGS.map((t) => ({
    t,
    sa: cosine(t.vec, a.taste) + 0.03 * gauss(`${noise}|a|${t.id}`),
    sb: cosine(t.vec, b.taste) + 0.03 * gauss(`${noise}|b|${t.id}`),
  }));
  const tagRow = (t: WorldTag, extra: Record<string, unknown>) => ({ tag_id: t.id, name: t.name, type: "urn:tag", subtype: tagNamespace(t.id), ...extra });
  const shared = scored
    .filter((x) => Math.min(x.sa, x.sb) >= 0.3)
    .sort((x, y) => Math.min(y.sa, y.sb) - Math.min(x.sa, x.sb))
    .slice(0, Math.min(8, take))
    .map((x) => tagRow(x.t, { popularity: x.t.popularity, query: { score: round(Math.min(x.sa, x.sb), 3) } }));
  const side = (mine: "sa" | "sb", other: "sa" | "sb") =>
    scored
      .filter((x) => x[mine] > 0.35 && x[mine] - x[other] > 0.05)
      .sort((x, y) => y[mine] - y[other] - (x[mine] - x[other]))
      .slice(0, Math.min(10, take))
      .map((x) => tagRow(x.t, { query: { count: String(Math.round(x[mine] * 40)) } }));
  const aRows: Record<string, unknown>[] = side("sa", "sb");
  if (sc.deniedTags) aRows.splice(Math.min(2, aRows.length), 0, tagRow(DENIED_ETHNICITY, { query: { count: "9" } }));
  return { status: 200, body: { synthetic: true, duration: 95, results: { tags: shared, a: aRows, b: side("sb", "sa"), matchEntities: [] } } };
}

function handleTags(p: Params): { status: number; body: unknown } {
  const q = (p.get("filter.query") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const parents = list(p, "filter.parents.types");
  const take = clamp(Math.round(num(p, "take") ?? 20), 1, 50);
  const semantic = p.get("feature.semantic_search") === "true";
  const rows = ALL_TAGS.filter((t) => {
    if (parents.length > 0 && !t.parents.some((x) => parents.includes(x))) return false;
    const name = t.name.toLowerCase();
    const hay = `${name} ${t.id.toLowerCase().replace(/_/g, " ")}`;
    return semantic ? q.some((w) => hay.includes(w)) : q.every((w) => name.includes(w));
  })
    .slice(0, take)
    .map((t) => ({ id: t.id, name: t.name, type: t.type, parents: t.parents.map((x) => ({ type: x })), popularity: t.popularity }));
  return { status: 200, body: { synthetic: true, duration: 40, success: true, results: { tags: rows } } };
}

const AUDIENCES = [
  { id: "urn:audience:hobbies_and_interests:live_music", name: "Live music", type: "urn:audience:hobbies_and_interests" },
  { id: "urn:audience:leisure:comedy_nights", name: "Comedy nights", type: "urn:audience:leisure" },
  { id: "urn:audience:life_stage:young_professionals", name: "Young professionals", type: "urn:audience:life_stage" },
  { id: "urn:audience:spending_habits:local_shopping", name: "Local shopping", type: "urn:audience:spending_habits" },
  { id: "urn:audience:political_preferences:synthetic_example", name: "Synthetic political example", type: "urn:audience:political_preferences" },
];

/**
 * Live (Oct 15): filter.query on its own returns no audiences ("country music", "alumni", "church" all came back
 * empty), so a free-text query answers an empty list here too. Without filter.query the world lists its examples
 * (filtered by filter.audience.types when given).
 */
function handleAudiences(p: Params): { status: number; body: unknown } {
  const q = (p.get("filter.query") ?? "").trim();
  const types = list(p, "filter.audience.types");
  const rows = q
    ? []
    : AUDIENCES.filter((a) => types.length === 0 || types.includes(a.type)).map((a, i) => ({
        ...a,
        entity_id: `0000aud0-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        parents: [{ type: "urn:audience" }],
      }));
  return { status: 200, body: { synthetic: true, success: true, totalRequestDuration: 30, results: { audiences: rows } } };
}

const SUPPORTED_TYPES = new Set([
  "urn:heatmap",
  "urn:demographics",
  "urn:tag",
  "urn:entity:place",
  "urn:entity:podcast",
  "urn:entity:brand",
  "urn:entity:artist",
  "urn:entity:person",
  "urn:entity:movie",
  "urn:entity:tv_show",
  "urn:entity:book",
  "urn:entity:video_game",
  "urn:entity:destination",
]);

function handleInsights(p: Params, ctx: WorldContext, noise: string): { status: number; body: unknown } {
  const type = p.get("filter.type") ?? "";
  if (!type) return { status: 400, body: errorBody("filter.type is required", "filter.type") };
  if (!SUPPORTED_TYPES.has(type)) {
    return { status: 403, body: errorBody(`You do not have permission to access ${type}`, "filter.type") };
  }
  const sig = readSignal(p, ctx.seed);
  if (type === "urn:heatmap") return handleHeatmap(p, sig, ctx, noise);
  if (type === "urn:demographics") return handleDemographics(p, sig, ctx, noise);
  if (type === "urn:tag") return handleTagProfile(p, sig, ctx, noise);
  if (type !== "urn:entity:brand" && type !== "urn:entity:place" && p.has("signal.location")) {
    // signal.location does not move these rankings in this world, so it does not seed their noise either.
    const without = new Map(p);
    without.delete("signal.location");
    return insightsEntities(p, sig, type, ctx, `${ctx.seed}|/v2/insights|${canonicalParams(without)}`);
  }
  return insightsEntities(p, sig, type, ctx, noise);
}

export function createQlooTransport(ctx: WorldContext): FetchLike {
  const seenOnce = new Set<string>();
  return async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    ctx.count("qloo", u.pathname);
    const h = headers(ctx);
    const sc = ctx.scenario();
    const requestKey = `${method} ${u.pathname}?${u.search}|${bodyText(init) ?? ""}`;
    if (sc.rateLimitOnce && !seenOnce.has(requestKey)) {
      seenOnce.add(requestKey);
      return jsonResponse(429, errorBody("Too Many Requests"), { ...h, "retry-after": "0" });
    }
    if (method === "POST" && (u.pathname === "/v2/insights" || u.pathname === "/v2/insights/")) {
      // Live (Oct 15, probe 14): POST /v2/insights with {entity, weight} signals is a 400. The product only sends GETs.
      return jsonResponse(400, errorBody("POST is not supported on /v2/insights; send a GET with entity ids", SIGNAL_PATH), h);
    }
    const params: Params = new Map(u.searchParams);
    const noise = `${ctx.seed}|${u.pathname}|${canonicalParams(params)}`;
    let out: { status: number; body: unknown };
    switch (u.pathname) {
      case "/search":
        out = handleSearch(params, ctx);
        break;
      case "/entities":
        out = handleEntities(params, ctx);
        break;
      case "/v2/insights":
      case "/v2/insights/":
        out = handleInsights(params, ctx, noise);
        break;
      case "/v2/analysis/compare":
        out = handleCompare(params, ctx, noise);
        break;
      case "/v2/tags":
        out = handleTags(params);
        break;
      case "/v2/audiences":
        out = handleAudiences(params);
        break;
      default:
        return err(404, `no route for ${u.pathname}`, h);
    }
    return jsonResponse(out.status, out.body, h);
  };
}
