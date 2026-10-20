/**
 * Overlap between Qloo partners and control-arm places: a pair counts when the
 * token-set name similarity is >= 0.85 and the two points are <= 150 m apart.
 * Matching is one-to-one, best similarity first, then nearest.
 */
import type { ControlPlace, GeoPoint, Partner } from "@walkup/contracts";

export const OVERLAP_MIN_SIMILARITY = 0.85;
export const OVERLAP_MAX_DISTANCE_M = 150;

export interface OverlapCandidate {
  name: string;
  location?: GeoPoint | null | undefined;
  entityId?: string;
}

export interface OverlapPair {
  qlooName: string;
  entityId?: string;
  controlName: string;
  placeId: string;
  similarity: number;
  distanceM: number;
}

const DROP_TOKENS = new Set(["the"]);

/** Lowercase, strip accents and apostrophes, "&" -> "and", split on non-alphanumerics, drop "the". */
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !DROP_TOKENS.has(t));
}

function lcsLength(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length]!;
}

/** Normalized indel similarity, 0..1 (rapidfuzz `ratio` / 100). */
export function ratio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  return (2 * lcsLength(a, b)) / (a.length + b.length);
}

/** Token-set similarity, 0..1 (rapidfuzz `token_set_ratio` / 100). */
export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).sort();
  const diffA = [...ta].filter((t) => !tb.has(t)).sort();
  const diffB = [...tb].filter((t) => !ta.has(t)).sort();
  if (inter.length > 0 && (diffA.length === 0 || diffB.length === 0)) return 1;
  const sect = inter.join(" ");
  const sa = [sect, diffA.join(" ")].filter(Boolean).join(" ");
  const sb = [sect, diffB.join(" ")].filter(Boolean).join(" ");
  let best = ratio(sa, sb);
  if (sect) best = Math.max(best, ratio(sect, sa), ratio(sect, sb));
  return best;
}

/** Great-circle distance in metres. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function partnersToCandidates(partners: ReadonlyArray<Partner>): OverlapCandidate[] {
  return partners.map((p) => ({
    name: p.entity.name,
    entityId: p.entity.entityId,
    location: p.entity.location ? { lat: p.entity.location.lat, lon: p.entity.location.lon } : null,
  }));
}

export function findOverlapPairs(
  qloo: ReadonlyArray<OverlapCandidate>,
  control: ReadonlyArray<Pick<ControlPlace, "placeId" | "name" | "location">>,
  opts: { minSimilarity?: number; maxDistanceM?: number } = {},
): OverlapPair[] {
  const minSim = opts.minSimilarity ?? OVERLAP_MIN_SIMILARITY;
  const maxDist = opts.maxDistanceM ?? OVERLAP_MAX_DISTANCE_M;
  const candidates: (OverlapPair & { qi: number; ci: number })[] = [];
  qloo.forEach((q, qi) => {
    if (!q.location) return;
    control.forEach((c, ci) => {
      if (!c.location) return;
      const distanceM = haversineM(q.location!, c.location);
      if (distanceM > maxDist) return;
      const similarity = tokenSetRatio(q.name, c.name);
      if (similarity < minSim) return;
      candidates.push({
        qi,
        ci,
        qlooName: q.name,
        ...(q.entityId ? { entityId: q.entityId } : {}),
        controlName: c.name,
        placeId: c.placeId,
        similarity,
        distanceM,
      });
    });
  });
  candidates.sort((x, y) => y.similarity - x.similarity || x.distanceM - y.distanceM || x.qi - y.qi || x.ci - y.ci);
  const usedQ = new Set<number>();
  const usedC = new Set<number>();
  const out: OverlapPair[] = [];
  for (const { qi, ci, ...pair } of candidates) {
    if (usedQ.has(qi) || usedC.has(ci)) continue;
    usedQ.add(qi);
    usedC.add(ci);
    out.push(pair);
  }
  return out;
}

/** Names (Qloo side) that appear in both arms, in Qloo order. */
export function overlapNames(
  qloo: ReadonlyArray<OverlapCandidate>,
  control: ReadonlyArray<Pick<ControlPlace, "placeId" | "name" | "location">>,
  opts?: { minSimilarity?: number; maxDistanceM?: number },
): string[] {
  const pairs = findOverlapPairs(qloo, control, opts);
  const matched = new Set(pairs.map((p) => p.qlooName));
  const out: string[] = [];
  for (const q of qloo) if (matched.has(q.name) && !out.includes(q.name)) out.push(q.name);
  return out;
}
