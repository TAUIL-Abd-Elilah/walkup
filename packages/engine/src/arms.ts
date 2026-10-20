/**
 * Support for the comparison with the fair control ("Without Qloo", arm F):
 * ranked-list overlap and the place matcher used beside it (fuzzy name +
 * distance match).
 */
import { haversineM } from "./geohash";
import { cmpStr, isFiniteNumber } from "./num";
import { jaccard, kendallTauRankings, topKOverlap } from "./stats";

export interface ArmComparison {
  overlap: string[];
  onlyA: string[];
  onlyB: string[];
  jaccard: number;
  topKOverlap: number;
  k: number;
  kendallTauShared: number | null;
}

/** Overlap between two ranked id lists (e.g. the Qloo list vs the control list). Lists keep rank order. */
export function compareArms(a: readonly string[], b: readonly string[], k = 8): ArmComparison {
  const sa = new Set(a);
  const sb = new Set(b);
  const dedupe = (xs: readonly string[]) => [...new Set(xs)];
  return {
    overlap: dedupe(a).filter((x) => sb.has(x)),
    onlyA: dedupe(a).filter((x) => !sb.has(x)),
    onlyB: dedupe(b).filter((x) => !sa.has(x)),
    jaccard: jaccard(a, b),
    topKOverlap: topKOverlap(a, b, k),
    k,
    kendallTauShared: kendallTauRankings(a, b),
  };
}

/** Lower-case, strip accents and punctuation, "&" -> "and", drop a leading "the". */
export function normalizePlaceName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

function ratio(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}

/** Name similarity in [0, 1]: max of the edit-distance ratio and the token-sorted edit-distance ratio. */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizePlaceName(a);
  const nb = normalizePlaceName(b);
  if (na === "" && nb === "") return 0;
  const sorted = (s: string) => s.split(" ").filter(Boolean).sort().join(" ");
  return Math.max(ratio(na, nb), ratio(sorted(na), sorted(nb)));
}

export interface NamedPoint {
  id: string;
  name: string;
  lat?: number | null;
  lon?: number | null;
}

export interface PlaceMatch {
  a: string;
  b: string;
  similarity: number;
  distanceM: number | null;
}

/**
 * One-to-one matches between two place lists: name similarity >= minSimilarity
 * (default 0.85) and, when both have coordinates, within maxDistanceM (default
 * 150 m). Greedy by similarity, then distance, then ids.
 */
export function matchPlaces(
  a: readonly NamedPoint[],
  b: readonly NamedPoint[],
  opts: { minSimilarity?: number; maxDistanceM?: number; requireCoordinates?: boolean } = {},
): PlaceMatch[] {
  const minSim = isFiniteNumber(opts.minSimilarity) ? opts.minSimilarity : 0.85;
  const maxD = isFiniteNumber(opts.maxDistanceM) ? opts.maxDistanceM : 150;
  const pairs: PlaceMatch[] = [];
  for (const x of a) {
    for (const y of b) {
      const sim = nameSimilarity(x.name, y.name);
      if (sim < minSim) continue;
      const haveCoords = isFiniteNumber(x.lat) && isFiniteNumber(x.lon) && isFiniteNumber(y.lat) && isFiniteNumber(y.lon);
      const d = haveCoords ? haversineM({ lat: x.lat as number, lon: x.lon as number }, { lat: y.lat as number, lon: y.lon as number }) : null;
      if (d === null && opts.requireCoordinates) continue;
      if (d !== null && d > maxD) continue;
      pairs.push({ a: x.id, b: y.id, similarity: sim, distanceM: d });
    }
  }
  pairs.sort(
    (p, q) =>
      q.similarity - p.similarity ||
      (p.distanceM ?? Number.MAX_VALUE) - (q.distanceM ?? Number.MAX_VALUE) ||
      cmpStr(p.a, q.a) ||
      cmpStr(p.b, q.b),
  );
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const out: PlaceMatch[] = [];
  for (const p of pairs) {
    if (usedA.has(p.a) || usedB.has(p.b)) continue;
    usedA.add(p.a);
    usedB.add(p.b);
    out.push(p);
  }
  return out;
}
