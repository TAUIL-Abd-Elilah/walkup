/** Small numeric helpers shared by every engine module. No I/O. */

export function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/** Coerces anything to a finite number, or returns `fallback`. Numeric strings are accepted. */
export function toFinite(x: unknown, fallback: number): number {
  if (typeof x === "number") return Number.isFinite(x) ? x : fallback;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Rounds half away from zero at `decimals` places, avoiding the usual binary
 * artefacts (roundTo(1.005, 2) === 1.01).
 */
export function roundTo(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return x;
  const d = Math.max(0, Math.floor(decimals));
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x);
  const viaString = Number(`${Math.round(Number(`${abs}e${d}`))}e-${d}`);
  if (Number.isFinite(viaString)) return sign * viaString;
  const f = 10 ** d;
  return (sign * Math.round(abs * f)) / f;
}

export function mean(xs: readonly number[]): number | null {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (Number.isFinite(x)) {
      s += x;
      n += 1;
    }
  }
  return n === 0 ? null : s / n;
}

export function sum(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) if (Number.isFinite(x)) s += x;
  return s;
}

/** Deterministic string comparison (code-unit order, locale independent). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Numeric comparison where NaN sorts last. */
export function cmpNum(a: number, b: number): number {
  const an = Number.isNaN(a);
  const bn = Number.isNaN(b);
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export const EPS = 1e-9;
