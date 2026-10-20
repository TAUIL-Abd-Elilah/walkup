/** Name matching and distance helpers for resolution checks. */

import type { Point } from "./config.js";

/** Lowercase, strip accents and punctuation, "&" -> "and", drop a leading "the". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");
}

export function isExactName(candidate: string, wanted: string[]): boolean {
  const c = normalizeName(candidate);
  return wanted.some((w) => normalizeName(w) === c);
}

/**
 * True when `candidate` is `wanted` extended into a billing name ("<wanted> and ...", "<wanted> with ..."),
 * e.g. "Jason Isbell and The 400 Unit" for "Jason Isbell".
 */
export function extendsName(wanted: string, candidate: string): boolean {
  const w = normalizeName(wanted);
  const c = normalizeName(candidate);
  if (!w || c === w) return false;
  return c.startsWith(`${w} and `) || c.startsWith(`${w} with `);
}

/** Sorensen-Dice similarity on character bigrams of the normalized, space-free names. 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a).replace(/ /g, "");
  const y = normalizeName(b).replace(/ /g, "");
  if (x === y) return x.length > 0 ? 1 : 0;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      hits++;
      grams.set(g, n - 1);
    }
  }
  return (2 * hits) / (x.length - 1 + (y.length - 1));
}

/** Great-circle distance in metres. */
export function haversineM(a: Point, b: Point): number {
  const R = 6_371_008.8;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True when every word of the query appears as a word in the name. */
export function containsAllWords(name: string, query: string): boolean {
  const words = new Set(normalizeName(name).split(" "));
  return normalizeName(query)
    .split(" ")
    .filter((w) => w !== "")
    .every((w) => words.has(w));
}
