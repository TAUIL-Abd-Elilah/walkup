import type { GeoPoint } from "@walkup/contracts";

/** Overlap rule between the Google arm and Qloo places. */
export const OVERLAP_MIN_SIMILARITY = 0.85;
export const OVERLAP_MAX_DISTANCE_M = 150;

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in metres. */
export function haversineM(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Lowercase, strip accents and punctuation, "&" -> "and". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lcsLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] as number) + 1 : Math.max(prev[j] as number, cur[j - 1] as number);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] as number;
}

/** Indel similarity 2*LCS/(|a|+|b|), the "ratio" of rapidfuzz. */
export function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  return total === 0 ? 1 : (2 * lcsLength(a, b)) / total;
}

/**
 * Token-set ratio in 0..1 (rapidfuzz semantics): compares the shared tokens with
 * each side's shared+remaining tokens and keeps the best ratio. When one name's
 * tokens are a subset of the other's, the score is 1 ("Lantern" vs "The Lantern").
 */
export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(normalizeName(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeName(b).split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).sort();
  const onlyA = [...ta].filter((t) => !tb.has(t)).sort();
  const onlyB = [...tb].filter((t) => !ta.has(t)).sort();
  const sect = inter.join(" ");
  const combA = [sect, onlyA.join(" ")].filter(Boolean).join(" ");
  const combB = [sect, onlyB.join(" ")].filter(Boolean).join(" ");
  const scores = [ratio(combA, combB)];
  if (sect) scores.push(ratio(sect, combA), ratio(sect, combB));
  return Math.max(...scores);
}

export interface NamedPoint {
  name: string;
  location?: GeoPoint | null;
}

export interface PlaceMatch {
  controlIndex: number;
  qlooIndex: number;
  controlName: string;
  qlooName: string;
  similarity: number;
  distanceM: number;
}

export interface MatchOptions {
  minSimilarity?: number; // default 0.85
  maxDistanceM?: number; // default 150
}

/**
 * One-to-one matches between control-arm places and Qloo places: name token-set
 * ratio >= 0.85 and <= 150 m apart. Places without coordinates never match (the
 * distance cannot be checked). Greedy by similarity, then distance.
 */
export function matchPlaces(control: NamedPoint[], qloo: NamedPoint[], opts: MatchOptions = {}): PlaceMatch[] {
  const minSim = opts.minSimilarity ?? OVERLAP_MIN_SIMILARITY;
  const maxDist = opts.maxDistanceM ?? OVERLAP_MAX_DISTANCE_M;
  const candidates: PlaceMatch[] = [];
  control.forEach((c, ci) => {
    if (!c.location) return;
    qloo.forEach((q, qi) => {
      if (!q.location) return;
      const distanceM = haversineM(c.location as GeoPoint, q.location as GeoPoint);
      if (distanceM > maxDist) return;
      const similarity = tokenSetRatio(c.name, q.name);
      if (similarity < minSim) return;
      candidates.push({ controlIndex: ci, qlooIndex: qi, controlName: c.name, qlooName: q.name, similarity, distanceM });
    });
  });
  candidates.sort((x, y) => y.similarity - x.similarity || x.distanceM - y.distanceM || x.controlIndex - y.controlIndex || x.qlooIndex - y.qlooIndex);
  const usedC = new Set<number>();
  const usedQ = new Set<number>();
  const out: PlaceMatch[] = [];
  for (const m of candidates) {
    if (usedC.has(m.controlIndex) || usedQ.has(m.qlooIndex)) continue;
    usedC.add(m.controlIndex);
    usedQ.add(m.qlooIndex);
    out.push(m);
  }
  return out.sort((x, y) => x.controlIndex - y.controlIndex);
}

/** Control-arm names that also appear in the Qloo list (ControlArmResult.overlapWithQloo). */
export function overlapWithQloo(control: NamedPoint[], qloo: NamedPoint[], opts: MatchOptions = {}): string[] {
  return matchPlaces(control, qloo, opts).map((m) => m.controlName);
}
