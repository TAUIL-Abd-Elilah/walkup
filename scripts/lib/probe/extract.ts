/**
 * Tolerant readers for API response shapes. They pull out only what the probe
 * needs to derive numbers; nothing here is persisted.
 *
 * Shapes (from the API notes): /search and /entities return a flat `results[]`;
 * /v2/insights returns `results.entities | heatmap | demographics | tags`;
 * /v2/analysis/compare returns `results.tags | a | b`; /v2/tags returns
 * `results.tags`; /v2/audiences returns `results.audiences`.
 */

export interface EntityLite {
  id: string;
  name: string;
  subtype: string | null;
  types: string[];
  popularity: number | null;
  affinity: number | null;
  distanceM: number | null;
  tagIds: string[];
  tagNames: string[];
  lat: number | null;
  lon: number | null;
  hours: unknown;
  /** Number of explainability contributor entries on this result (0 when absent). */
  explainCount: number;
}

export interface TagLite {
  id: string;
  name: string;
  parentTypes: string[];
  affinity: number | null;
}

export interface CellLite {
  geohash: string;
  affinity: number;
  popularity: number;
}

export interface DemoBlockLite {
  entityId: string | null;
  ageKeys: string[];
  genderKeys: string[];
}

/**
 * Signal ids a 2xx body says Qloo ignored: top-level warnings[{type:"not_found",
 * "<prefix>signal.interests.entities":[ids]}] (live shape, Oct 15). Ids only; de-duplicated.
 */
export function signalWarnings(json: unknown): string[] {
  if (!isRecord(json)) return [];
  const out: string[] = [];
  for (const w of arr(json.warnings)) {
    if (!isRecord(w) || w.type !== "not_found") continue;
    for (const [k, v] of Object.entries(w)) {
      if (!/(^|\.)signal\.interests\.entities$/.test(k)) continue;
      for (const id of arr(v)) if (typeof id === "string" && id !== "" && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Parameter names a 4xx body blames: {"errors":[{"message","path"}]}. */
export function errorPaths(json: unknown): string[] {
  if (!isRecord(json)) return [];
  const out: string[] = [];
  for (const e of arr(json.errors)) {
    const p = isRecord(e) ? str(e.path) : null;
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export function searchEntities(json: unknown): EntityLite[] {
  if (!isRecord(json)) return [];
  return arr(json.results).map(entityLite).filter(isEntity);
}

export function insightEntities(json: unknown): EntityLite[] {
  const results = isRecord(json) ? json.results : undefined;
  if (!isRecord(results)) return [];
  return arr(results.entities).map(entityLite).filter(isEntity);
}

/** Entities from either shape (flat results[] or results.entities[]). */
export function anyEntities(json: unknown): EntityLite[] {
  const a = insightEntities(json);
  return a.length > 0 ? a : searchEntities(json);
}

export function heatCells(json: unknown): CellLite[] {
  const results = isRecord(json) ? json.results : undefined;
  if (!isRecord(results)) return [];
  const out: CellLite[] = [];
  for (const c of arr(results.heatmap)) {
    if (!isRecord(c)) continue;
    const loc = isRecord(c.location) ? c.location : {};
    const q = isRecord(c.query) ? c.query : {};
    const geohash = str(loc.geohash);
    const affinity = num(q.affinity);
    if (!geohash || affinity === null) continue;
    out.push({ geohash, affinity, popularity: num(q.popularity) ?? 0 });
  }
  return out;
}

export function tagList(json: unknown): TagLite[] {
  if (!isRecord(json)) return [];
  const results = json.results;
  const list = isRecord(results) ? arr(results.tags) : arr(results);
  return list.map(tagLite).filter((t): t is TagLite => t !== null);
}

export function demographicBlocks(json: unknown): DemoBlockLite[] {
  const results = isRecord(json) ? json.results : undefined;
  if (!isRecord(results)) return [];
  const out: DemoBlockLite[] = [];
  for (const b of arr(results.demographics)) {
    if (!isRecord(b)) continue;
    const q = isRecord(b.query) ? b.query : {};
    out.push({
      entityId: str(b.entity_id),
      ageKeys: isRecord(q.age) ? Object.keys(q.age) : [],
      genderKeys: isRecord(q.gender) ? Object.keys(q.gender) : [],
    });
  }
  return out;
}

export function compareSides(json: unknown): { shared: TagLite[]; a: TagLite[]; b: TagLite[] } {
  const results = isRecord(json) ? json.results : undefined;
  if (!isRecord(results)) return { shared: [], a: [], b: [] };
  const read = (v: unknown): TagLite[] => arr(v).map(tagLite).filter((t): t is TagLite => t !== null);
  return { shared: read(results.tags), a: read(results.a), b: read(results.b) };
}

export function audienceList(json: unknown): { id: string; name: string }[] {
  const results = isRecord(json) ? json.results : undefined;
  const list = isRecord(results) ? arr(results.audiences) : arr(results);
  const out: { id: string; name: string }[] = [];
  for (const a of list) {
    if (!isRecord(a)) continue;
    const id = str(a.id) ?? str(a.audience_id);
    if (id) out.push({ id, name: str(a.name) ?? "" });
  }
  return out;
}

export type DayState = "open" | "closed" | "unknown";

/** Best-effort read of properties.hours for one weekday. */
export function dayState(hours: unknown, day: string): DayState {
  if (!isRecord(hours)) return "unknown";
  const want = day.slice(0, 3).toLowerCase();
  const key = Object.keys(hours).find((k) => k.slice(0, 3).toLowerCase() === want);
  if (key === undefined) return "unknown";
  const v = hours[key];
  if (v === null || v === undefined) return "closed";
  if (typeof v === "string") return /closed/i.test(v) ? "closed" : v.trim() === "" ? "closed" : "open";
  if (Array.isArray(v)) {
    if (v.length === 0) return "closed";
    const allClosed = v.every((slot) => isRecord(slot) && slot.closed === true);
    return allClosed ? "closed" : "open";
  }
  if (isRecord(v) && v.closed === true) return "closed";
  return "open";
}

function entityLite(e: unknown): EntityLite | null {
  if (!isRecord(e)) return null;
  const id = str(e.entity_id) ?? str(e.id);
  if (!id) return null;
  const q = isRecord(e.query) ? e.query : {};
  const props = isRecord(e.properties) ? e.properties : {};
  const loc = isRecord(e.location) ? e.location : {};
  const tags = arr(e.tags).filter(isRecord);
  const explain = isRecord(q.explainability) ? q.explainability : null;
  let explainCount = 0;
  if (explain) for (const v of Object.values(explain)) if (Array.isArray(v)) explainCount += v.length;
  return {
    id,
    name: str(e.name) ?? "",
    subtype: str(e.subtype),
    types: arr(e.types).filter((t): t is string => typeof t === "string"),
    popularity: num(e.popularity),
    affinity: num(q.affinity),
    distanceM: num(q.distance),
    tagIds: tags.map((t) => str(t.id) ?? str(t.tag_id) ?? "").filter((s) => s !== ""),
    tagNames: tags.map((t) => str(t.name) ?? "").filter((s) => s !== ""),
    lat: num(loc.lat) ?? num(loc.latitude),
    lon: num(loc.lon) ?? num(loc.longitude),
    hours: props.hours,
    explainCount,
  };
}

function tagLite(t: unknown): TagLite | null {
  if (!isRecord(t)) return null;
  const id = str(t.id) ?? str(t.tag_id);
  if (!id) return null;
  const parents = arr(t.parents)
    .map((p) => (isRecord(p) ? str(p.type) : typeof p === "string" ? p : null))
    .filter((s): s is string => s !== null);
  const q = isRecord(t.query) ? t.query : {};
  return { id, name: str(t.name) ?? "", parentTypes: parents, affinity: num(q.affinity) ?? num(q.score) };
}

function isEntity(e: EntityLite | null): e is EntityLite {
  return e !== null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
