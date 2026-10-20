/**
 * Deterministic numbers for the fixture world. Every value the world returns
 * is a pure function of (world seed, request params, entity key): no clock, no
 * Math.random.
 */

/** FNV-1a 32-bit over a string. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Finalizer (murmur3 fmix32) so nearby keys give unrelated values. */
function mix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Uniform in [0, 1) from any string key. */
export function unit(key: string): number {
  return mix32(fnv1a(key)) / 4294967296;
}

/** Uniform integer in [0, n). */
export function pick(key: string, n: number): number {
  return Math.min(n - 1, Math.floor(unit(key) * n));
}

/** One element of a non-empty list, chosen by key. */
export function choose<T>(key: string, list: readonly T[]): T {
  return list[pick(key, list.length)] as T;
}

/** Roughly normal (Irwin-Hall of 4), mean 0, sd about 1. */
export function gauss(key: string): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += unit(`${key}#g${i}`);
  return (s - 2) * Math.sqrt(3);
}

/** Hex string of `len` characters from a key. */
export function hexOf(key: string, len: number): string {
  let out = "";
  let i = 0;
  while (out.length < len) {
    out += mix32(fnv1a(`${key}#h${i}`)).toString(16).padStart(8, "0");
    i++;
  }
  return out.slice(0, len);
}

/** mulberry32 stream seeded from a key. */
export function stream(key: string): () => number {
  let a = mix32(fnv1a(key));
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
