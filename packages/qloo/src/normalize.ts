/**
 * Normalizers: raw Qloo bodies -> @walkup/contracts shapes.
 * Defensive by design: an unknown shape yields an empty value plus a reason;
 * missing optional fields never throw. Rows missing a required field (id,
 * geohash, affinity) are skipped and counted.
 *
 * Shapes handled (checked against live bodies on Oct 15; see README):
 *  - /search and /entities: flat results[]; external ids under properties.external.<ns> = {id}
 *  - /v2/insights entities: results.entities[]; external ids top-level external.<ns> = [{id, ...}]
 *  - urn:heatmap: results.heatmap[{location{latitude,longitude,geohash}, query{affinity,affinity_rank,popularity}}]
 *    (affinity_rank is a 0-1 fraction; there is no response-level query block)
 *  - urn:demographics: results.demographics[{entity_id, query{age{...}, gender{male,female}}}]
 *    (a signal tag's block also uses entity_id, holding the tag URN)
 *  - urn:tag and /v2/tags: results.tags[]
 *  - /v2/analysis/compare: results.tags (shared) | results.a | results.b (no success field)
 *  - any 2xx: top-level warnings[{type:"not_found", "signal.interests.entities":[ids]}]
 */
import {
  AGE_BUCKETS,
  type CompareResult,
  type CompareTag,
  type DemographicsBlock,
  type ExplainContribution,
  type GeoPoint,
  type HeatCell,
  type QlooEntity,
  type QlooTag,
} from "@walkup/contracts";
import { decodeGeohash } from "./geohash";
import type { Normalized, QlooWarning, RankedTag } from "./types";

type Rec = Record<string, unknown>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Finite number, or a numeric string (compare returns query.count as a string). */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function arr(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function rec(v: unknown): Rec {
  return isRecord(v) ? v : {};
}

function nonNull<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

function resultsOf(body: unknown): unknown {
  return isRecord(body) ? body.results : undefined;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** "urn:tag:genre:music:americana" -> "urn:tag:genre:music". */
export function tagNamespace(id: string): string | undefined {
  const parts = id.split(":");
  if (parts[0] !== "urn" || parts[1] !== "tag" || parts.length < 4) return undefined;
  return parts.slice(0, -1).join(":");
}

export function normalizeTagRef(raw: unknown): QlooTag | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id) ?? str(raw.tag_id) ?? str(raw.value);
  if (!id) return null;
  const name = str(raw.name) ?? id.split(":").pop() ?? id;
  const sub = str(raw.subtype);
  const type = str(raw.type);
  const ns = sub?.startsWith("urn:tag:") ? sub : type?.startsWith("urn:tag:") ? type : tagNamespace(id);
  const tag: QlooTag = { id, name };
  if (ns) tag.type = ns;
  if (sub) tag.subtype = sub;
  return tag;
}

function parentsOf(raw: Rec): string[] | undefined {
  const fromParents = (arr(raw.parents) ?? [])
    .map((p) => (typeof p === "string" ? str(p) : str(rec(p).type) ?? str(rec(p).id)))
    .filter(nonNull);
  if (fromParents.length > 0) return fromParents;
  const fromTypes = (arr(raw.types) ?? []).map(str).filter(nonNull);
  return fromTypes.length > 0 ? fromTypes : undefined;
}

/** /v2/tags and urn:tag insights: results.tags[] in response order. */
export function normalizeTagList(body: unknown): Normalized<RankedTag[]> {
  const results = resultsOf(body);
  const list = (isRecord(results) ? arr(results.tags) : null) ?? arr(results);
  if (!list) return { value: [], reason: "unexpected shape: no results.tags[]", skipped: 0 };
  const out: RankedTag[] = [];
  let skipped = 0;
  for (const raw of list) {
    const base = normalizeTagRef(raw);
    if (!base || !isRecord(raw)) {
      skipped++;
      continue;
    }
    const q = rec(raw.query);
    const tag: RankedTag = {
      ...base,
      rank: out.length + 1,
      affinity: num(q.affinity),
      popularity: num(raw.popularity) ?? num(q.popularity),
    };
    const parents = parentsOf(raw);
    if (parents) tag.parents = parents;
    out.push(tag);
  }
  return { value: out, skipped };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * properties kept on QlooEntity.properties (place bodies run to hundreds of KB).
 * `neighborhood` is not kept: it was null on every live place row (Oct 15). The ZIP code
 * comes from properties.localities instead (see `zip` in projectProperties).
 */
export const PROJECTED_PROPERTIES = [
  "address",
  "hours",
  "phone",
  "website",
  "price_level",
  "is_closed",
  "short_description",
  "business_rating",
  "release_year",
  "image",
  "geocode",
] as const;

function subtypeOf(raw: Rec): string {
  const sub = str(raw.subtype);
  if (sub) return sub;
  const fromTypes = (arr(raw.types) ?? []).map(str).find((t) => t?.startsWith("urn:entity:"));
  if (fromTypes) return fromTypes;
  const t = str(raw.type);
  return t ?? "urn:entity";
}

export function projectProperties(props: Rec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PROJECTED_PROPERTIES) {
    const v = props[k];
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  if (out.image !== undefined) {
    const url = typeof out.image === "string" ? str(out.image) : str(rec(out.image).url);
    if (url) out.image = url;
    else delete out.image;
  }
  const year = num(out.release_year);
  if (year !== null) {
    out.release_year = year;
  } else {
    delete out.release_year;
    const d = str(props.release_date);
    const y = d ? Number(d.slice(0, 4)) : NaN;
    if (Number.isInteger(y) && y > 1000) out.release_year = y;
  }
  for (const k of ["price_level", "business_rating"] as const) {
    if (out[k] !== undefined) {
      const n = num(out[k]);
      if (n === null) delete out[k];
      else out[k] = n;
    }
  }
  if (out.is_closed !== undefined && typeof out.is_closed !== "boolean") {
    out.is_closed = out.is_closed === "true" || out.is_closed === 1;
  }
  const zip = zipOf(props);
  if (zip) out.zip = zip;
  return out;
}

/**
 * ZIP code of a place from properties.localities[] (live: {name, place: "ZCTA"|"city"|"county"|..., boundary,
 * locality_id: "z37203", ...}). Prefers the ZCTA row's name, then a "z<digits>" locality_id.
 */
export function zipOf(props: Rec): string | undefined {
  for (const raw of arr(props.localities) ?? []) {
    const l = rec(raw);
    const kind = (str(l.place) ?? str(l.boundary) ?? "").toUpperCase();
    if (kind !== "ZCTA") continue;
    const name = str(l.name);
    if (name && /^\d{5}$/.test(name)) return name;
    const lid = str(l.locality_id);
    if (lid && /^z\d{5}$/i.test(lid)) return lid.slice(1);
  }
  return undefined;
}

function locationOf(raw: Rec, props: Rec): (GeoPoint & { geohash?: string }) | undefined {
  const loc = rec(raw.location);
  const lat = num(loc.lat) ?? num(loc.latitude) ?? num(props.latitude);
  const lon = num(loc.lon) ?? num(loc.lng) ?? num(loc.longitude) ?? num(props.longitude);
  if (lat === null || lon === null) return undefined;
  const out: GeoPoint & { geohash?: string } = { lat, lon };
  const gh = str(loc.geohash);
  if (gh) out.geohash = gh;
  return out;
}

function explainOf(query: Rec): ExplainContribution[] | undefined {
  const ex = rec(query.explainability);
  const list = arr(ex["signal.interests.entities"]);
  if (!list) return undefined;
  const out = list
    .map((c): ExplainContribution | null => {
      const r = rec(c);
      const entityId = str(r.entity_id) ?? str(r.id);
      const score = num(r.score);
      return entityId && score !== null ? { entityId, score: Math.min(1, Math.max(0, score)) } : null;
    })
    .filter(nonNull);
  return out;
}

export function normalizeEntity(raw: unknown): QlooEntity | null {
  if (!isRecord(raw)) return null;
  const entityId = str(raw.entity_id) ?? str(raw.id);
  const name = str(raw.name);
  if (!entityId || !name) return null;
  const props = rec(raw.properties);
  const query = rec(raw.query);
  const e: QlooEntity = {
    entityId,
    name,
    subtype: subtypeOf(raw),
    popularity: num(raw.popularity),
    affinity: num(query.affinity),
    tags: (arr(raw.tags) ?? []).map(normalizeTagRef).filter(nonNull),
    properties: projectProperties(props),
  };
  const loc = locationOf(raw, props);
  if (loc) e.location = loc;
  if (query.distance !== undefined) e.distanceM = num(query.distance);
  const ex = explainOf(query);
  if (ex) e.explainability = ex;
  // Insights rows carry top-level external.<ns> = [{id, ...}]; /search and /entities rows carry
  // properties.external.<ns> = {id} (live, Oct 15).
  const external = isRecord(raw.external) ? raw.external : isRecord(props.external) ? props.external : undefined;
  if (external) e.external = external;
  const dis = str(raw.disambiguation);
  if (dis) e.disambiguation = dis;
  return e;
}

/** /search and /entities (flat results[]) and insights (results.entities[]). */
export function normalizeEntityList(body: unknown): Normalized<QlooEntity[]> {
  const results = resultsOf(body);
  const list = arr(results) ?? (isRecord(results) ? arr(results.entities) : null);
  if (!list) return { value: [], reason: "unexpected shape: no results[] or results.entities[]", skipped: 0 };
  const value: QlooEntity[] = [];
  let skipped = 0;
  for (const raw of list) {
    const e = normalizeEntity(raw);
    if (e) value.push(e);
    else skipped++;
  }
  return { value, skipped };
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

export function normalizeHeatmap(body: unknown): Normalized<HeatCell[]> {
  const results = resultsOf(body);
  const list = isRecord(results) ? arr(results.heatmap) : null;
  if (!list) return { value: [], reason: "unexpected shape: no results.heatmap[]", skipped: 0 };
  const value: HeatCell[] = [];
  let skipped = 0;
  let filled = 0;
  for (const raw of list) {
    const cell = rec(raw);
    const loc = rec(cell.location);
    const q = rec(cell.query);
    const geohash = str(loc.geohash) ?? str(cell.geohash);
    const affinity = num(q.affinity) ?? num(cell.affinity);
    if (!geohash || affinity === null) {
      skipped++;
      continue;
    }
    let lat = num(loc.latitude) ?? num(loc.lat);
    let lon = num(loc.longitude) ?? num(loc.lon);
    if (lat === null || lon === null) {
      const c = decodeGeohash(geohash);
      if (!c) {
        skipped++;
        continue;
      }
      lat = c.lat;
      lon = c.lon;
    }
    const rank = num(q.affinity_rank) ?? num(cell.affinity_rank);
    const pop = num(q.popularity) ?? num(cell.popularity);
    if (rank === null || pop === null) filled++;
    value.push({ geohash, lat, lon, affinity, affinityRank: rank ?? 0, popularity: pop ?? 0 });
  }
  const out: Normalized<HeatCell[]> = { value, skipped };
  if (filled > 0) out.reason = `${filled} cell(s) missing affinity_rank or popularity (set to 0)`;
  return out;
}

// ---------------------------------------------------------------------------
// Demographics
// ---------------------------------------------------------------------------

export function normalizeDemographics(body: unknown): Normalized<DemographicsBlock[]> {
  const results = resultsOf(body);
  const list = isRecord(results) ? arr(results.demographics) : null;
  if (!list) return { value: [], reason: "unexpected shape: no results.demographics[]", skipped: 0 };
  const value: DemographicsBlock[] = [];
  let skipped = 0;
  for (const raw of list) {
    const b = rec(raw);
    const entityId = str(b.entity_id) ?? str(b.tag_id) ?? str(b.id);
    if (!entityId) {
      skipped++;
      continue;
    }
    const q = rec(b.query);
    const ageRaw = rec(q.age);
    const genderRaw = rec(q.gender);
    const block: DemographicsBlock = { entityId, age: {}, gender: {} };
    for (const bucket of AGE_BUCKETS) {
      const n = num(ageRaw[bucket]);
      if (n !== null) block.age[bucket] = n;
    }
    const male = num(genderRaw.male);
    const female = num(genderRaw.female);
    if (male !== null) block.gender.male = male;
    if (female !== null) block.gender.female = female;
    value.push(block);
  }
  return { value, skipped };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function compareTag(raw: unknown): CompareTag | null {
  const base = normalizeTagRef(raw);
  if (!base || !isRecord(raw)) return null;
  const q = rec(raw.query);
  const t: CompareTag = { ...base };
  const score = num(q.score) ?? num(q.affinity);
  const count = num(q.count);
  if (score !== null) t.score = score;
  if (count !== null) t.count = count;
  return t;
}

export function emptyCompare(): CompareResult {
  return { shared: [], a: [], b: [], fromTagDiff: false };
}

export function normalizeCompare(body: unknown): Normalized<CompareResult> {
  const results = resultsOf(body);
  if (!isRecord(results)) return { value: emptyCompare(), reason: "unexpected shape: no results object", skipped: 0 };
  const shared = arr(results.tags);
  const a = arr(results.a);
  const b = arr(results.b);
  if (!shared && !a && !b) return { value: emptyCompare(), reason: "unexpected shape: no results.tags, a or b", skipped: 0 };
  let skipped = 0;
  const conv = (list: unknown[] | null): CompareTag[] => {
    const out: CompareTag[] = [];
    for (const raw of list ?? []) {
      const t = compareTag(raw);
      if (t) out.push(t);
      else skipped++;
    }
    return out;
  };
  return { value: { shared: conv(shared), a: conv(a), b: conv(b), fromTagDiff: false }, skipped };
}


// ---------------------------------------------------------------------------
// Generic insights and counting
// ---------------------------------------------------------------------------

export type InsightsKind = "entities" | "heatmap" | "demographics" | "tags" | "unknown";

export interface InsightsValue {
  kind: InsightsKind;
  entities: QlooEntity[];
  heatmap: HeatCell[];
  demographics: DemographicsBlock[];
  tags: RankedTag[];
}

export function normalizeInsights(body: unknown): Normalized<InsightsValue> {
  const empty: InsightsValue = { kind: "unknown", entities: [], heatmap: [], demographics: [], tags: [] };
  const results = rec(resultsOf(body));
  if (Array.isArray(results.entities)) {
    const n = normalizeEntityList(body);
    return { ...n, value: { ...empty, kind: "entities", entities: n.value } };
  }
  if (Array.isArray(results.heatmap)) {
    const n = normalizeHeatmap(body);
    return { ...n, value: { ...empty, kind: "heatmap", heatmap: n.value } };
  }
  if (Array.isArray(results.demographics)) {
    const n = normalizeDemographics(body);
    return { ...n, value: { ...empty, kind: "demographics", demographics: n.value } };
  }
  if (Array.isArray(results.tags)) {
    const n = normalizeTagList(body);
    return { ...n, value: { ...empty, kind: "tags", tags: n.value } };
  }
  return { value: empty, reason: "unexpected shape: no results.entities|heatmap|demographics|tags", skipped: 0 };
}

/** Rows in a raw body, for the ledger. Compare counts shared + a + b. */
export function countResults(body: unknown): number {
  const results = resultsOf(body);
  if (Array.isArray(results)) return results.length;
  if (!isRecord(results)) return 0;
  for (const k of ["entities", "heatmap", "demographics", "audiences"] as const) {
    const v = results[k];
    if (Array.isArray(v)) return v.length;
  }
  const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
  return len(results.tags) + len(results.a) + len(results.b);
}

// ---------------------------------------------------------------------------
// Warnings (2xx bodies)
// ---------------------------------------------------------------------------

/** The param whose not_found ids mean "this signal was ignored" (also a./b. on compare). */
const SIGNAL_PARAM_RE = /(^|\.)signal\.interests\.entities$/;

/**
 * Top-level `warnings[]` of a 2xx body (falls back to query.warnings). Live shape (Oct 15):
 * `[{"type":"not_found","signal.interests.entities":["<id>"]}]`, the dotted parameter name as a literal key.
 * One QlooWarning per (entry, parameter); unknown shapes are skipped. Never throws.
 */
export function responseWarnings(body: unknown): QlooWarning[] {
  if (!isRecord(body)) return [];
  const list = arr(body.warnings) ?? arr(rec(body.query).warnings) ?? [];
  const out: QlooWarning[] = [];
  for (const raw of list) {
    if (typeof raw === "string") {
      out.push({ type: "message", ids: [], message: raw });
      continue;
    }
    const w = rec(raw);
    const type = str(w.type) ?? "unknown";
    const message = str(w.message);
    let found = false;
    for (const [k, v] of Object.entries(w)) {
      if (k === "type" || k === "message") continue;
      const ids = (arr(v) ?? (typeof v === "string" ? [v] : [])).map(str).filter(nonNull);
      if (ids.length === 0) continue;
      found = true;
      const entry: QlooWarning = { type, param: k, ids };
      if (message) entry.message = message;
      out.push(entry);
    }
    if (!found) out.push(message ? { type, ids: [], message } : { type, ids: [] });
  }
  return out;
}

/** Signal ids Qloo ignored: not_found warnings on any (a./b.)signal.interests.entities param, de-duplicated. */
export function droppedSignalIds(warnings: readonly QlooWarning[]): string[] {
  const out: string[] = [];
  for (const w of warnings) {
    if (w.type !== "not_found" || !w.param || !SIGNAL_PARAM_RE.test(w.param)) continue;
    for (const id of w.ids) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Response-level data passed to ResultMeta: query.explainability (as returned) and the warnings.
 * Heatmaps have no response-level query block on the live API (Oct 15).
 */
export function responseMeta(body: unknown): { explainability?: unknown; warnings?: QlooWarning[]; droppedSignals?: string[] } {
  const q = isRecord(body) ? rec(body.query) : {};
  const out: { explainability?: unknown; warnings?: QlooWarning[]; droppedSignals?: string[] } = {};
  if (q.explainability !== undefined) out.explainability = q.explainability;
  const warnings = responseWarnings(body);
  if (warnings.length > 0) out.warnings = warnings;
  const dropped = droppedSignalIds(warnings);
  if (dropped.length > 0) out.droppedSignals = dropped;
  return out;
}
