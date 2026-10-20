/**
 * TypeScript port of the resolution helpers in evals/p1/matching.py (sealed with the
 * plan): name normalization, name similarity, haversine distance. The P1 runner must
 * decide matches exactly as the sealed Python code would, so:
 *
 *  - `sequenceRatio` is difflib.SequenceMatcher(None, a, b, autojunk=False).ratio();
 *  - `normalizeName` follows matching.normalize_name step by step;
 *  - `nameSimilarity` is matching.name_similarity, rounded to 6 decimals.
 *
 * test/similarity.test.ts checks every function against values produced by the
 * Python module itself.
 */

/** Python str.casefold for the characters that can survive into [0-9a-z] (ASCII plus sharp s). */
function casefold(s: string): string {
  return s.toLowerCase().replace(/ß/g, "ss");
}

/**
 * matching.normalize_name: NFKD, drop combining marks, casefold, "&" -> " and ",
 * drop apostrophes, other punctuation -> space, collapse whitespace, drop one leading "the".
 * Combining marks are removed by Unicode category M; for Latin-script names this is the
 * same set as Python's unicodedata.combining() != 0.
 */
export function normalizeName(input: string | null | undefined): string {
  let s = (input ?? "").normalize("NFKD");
  s = s.replace(/\p{M}/gu, "");
  s = casefold(s).replace(/&/g, " and ");
  s = s.replace(/['‘’ʼ`]/g, "");
  s = s.replace(/[^0-9a-z]+/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  if (s.startsWith("the ")) s = s.slice(4);
  return s;
}

/** Total size of difflib's matching blocks (no junk, autojunk off). */
function matchingSize(a: readonly string[], b: readonly string[]): number {
  const b2j = new Map<string, number[]>();
  b.forEach((ch, j) => {
    const list = b2j.get(ch);
    if (list) list.push(j);
    else b2j.set(ch, [j]);
  });

  const findLongest = (alo: number, ahi: number, blo: number, bhi: number): [number, number, number] => {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    // difflib extends the match with equal non-junk neighbours; with no junk this is a no-op
    // for a maximal match, kept for fidelity.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  };

  let total = 0;
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k > 0) {
      total += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return total;
}

/** difflib.SequenceMatcher(None, a, b, autojunk=False).ratio(), over code points. */
export function sequenceRatio(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const length = ca.length + cb.length;
  if (length === 0) return 1.0;
  return (2.0 * matchingSize(ca, cb)) / length;
}

/** matching._ratio: 1.0 when both strings are empty. */
function ratio(a: string, b: string): number {
  if (!a && !b) return 1.0;
  return sequenceRatio(a, b);
}

function contiguousRun(short: readonly string[], long: readonly string[]): boolean {
  const n = short.length;
  for (let i = 0; i + n <= long.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (long[i + k] !== short[k]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function round6(x: number): number {
  return Number(x.toFixed(6));
}

function splitTokens(s: string): string[] {
  return s === "" ? [] : s.split(" ");
}

/**
 * matching.name_similarity: max(ratio(normalized), ratio(sorted tokens), containment),
 * where containment is 1.0 when the shorter token list has at least two tokens and is a
 * contiguous run inside the longer one.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  const ta = splitTokens(na);
  const tb = splitTokens(nb);
  let best = Math.max(ratio(na, nb), ratio([...ta].sort().join(" "), [...tb].sort().join(" ")));
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length >= 2 && contiguousRun(short, long)) best = Math.max(best, 1.0);
  return round6(best);
}

/** matching.haversine_m (metres, mean Earth radius 6,371,008.8 m). */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371008.8;
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Same test as publish_sample.py's "with_street_number": the address starts with a digit. */
export function hasStreetNumber(address: string | null | undefined): boolean {
  return /^\s*\d/.test(address ?? "");
}

const COUNTRY_TAILS = new Set(["usa", "us", "u s a", "united states", "united states of america"]);

/**
 * The 5-digit ZIP an address shows, or null. A ZIP counts only at the end of the address
 * (after the city or state, optionally followed by the country), so a leading 5-digit street
 * number is never read as a ZIP. Shapes: "..., 80220", "..., CO 80220", "... Tucson AZ 85705".
 */
export function extractZip(address: string | null | undefined): string | null {
  const parts = (address ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const tailKey = (s: string): string => s.toLowerCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();
  while (parts.length > 0 && COUNTRY_TAILS.has(tailKey(parts[parts.length - 1] as string))) parts.pop();
  const last = parts[parts.length - 1];
  if (last === undefined) return null;
  const m =
    /^(\d{5})(?:-\d{4})?$/.exec(last) ?? // "..., 80220"
    /^[A-Za-z]{2}\.?\s+(\d{5})(?:-\d{4})?$/.exec(last) ?? // "..., CO 80220"
    /\s[A-Za-z]{2}\.?\s+(\d{5})(?:-\d{4})?$/.exec(last); // "... Tucson AZ 85705"
  return m ? (m[1] as string) : null;
}
