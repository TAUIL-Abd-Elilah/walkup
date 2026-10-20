/**
 * The latent taste space of the fixture world. Every entity, tag, place and
 * map cell carries a vector over these dimensions; affinities are weighted
 * matches plus seeded noise. Invented for tests: it models no real audience.
 */
export const DIMS = ["roots", "hiphop_rnb", "indie_alt", "comedy_night", "latin", "family", "arts_dining"] as const;
export type Dim = (typeof DIMS)[number];
export type Taste = number[];

export function taste(parts: Partial<Record<Dim, number>>): Taste {
  return DIMS.map((d) => parts[d] ?? 0);
}

export function zeroTaste(): Taste {
  return DIMS.map(() => 0);
}

export function addScaled(into: Taste, v: Taste, w: number): Taste {
  for (let i = 0; i < into.length; i++) into[i] = (into[i] ?? 0) + (v[i] ?? 0) * w;
  return into;
}

export function norm(v: Taste): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

export function isZero(v: Taste): boolean {
  return norm(v) === 0;
}

export function cosine(a: Taste, b: Taste): number {
  const na = norm(a);
  const nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s / (na * nb);
}

/** Weighted average of `field` over the signal's dimensions (0..1 when the field is 0..1). */
export function weightedMatch(signal: Taste, field: Taste): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < signal.length; i++) {
    const w = Math.max(0, signal[i] ?? 0);
    num += w * (field[i] ?? 0);
    den += w;
  }
  return den > 0 ? num / den : 0;
}
