/**
 * National-chain matcher over a hand-kept list of brand names
 * (config/chains.json). Pure: the caller passes the list.
 *
 * Both sides are normalized the same way: accents stripped, lower case,
 * apostrophes and periods removed ("Dunkin'" -> "dunkin", "T.J. Maxx" ->
 * "tj maxx"), "&" and "+" read as "and", every other run of punctuation a
 * space, and a leading "the" dropped. Matching is on whole words:
 *
 *  - a place matches a brand key (its name or an alias) when its words equal
 *    the key's words, or start with them ("Starbucks Coffee Company",
 *    "Potbelly Sandwich Shop", "Outback Steakhouse Tysons");
 *  - an `exact` entry (a common word or a town name: "Target", "Gap",
 *    "Burlington") never matches as the start of a longer name. It matches the
 *    whole name, the whole name with a trailing store number ("Target 1234"),
 *    or the part before " - ", " | ", " @ ", "(" or "," ("Gap (Georgetown)").
 *
 * So "Jerry's Seafood" does not match "Jerry's Subs & Pizza", and "Pho Deluxe
 * Tysons" matches nothing: a word shared with a brand is not enough.
 */

export interface ChainEntry {
  name: string;
  aliases?: readonly string[];
  kind?: string;
  /** Match only as the whole name (see the module comment). */
  exact?: boolean;
}

export interface ChainList {
  chains: readonly ChainEntry[];
}

export interface ChainIndex {
  /** Number of brand keys (names and aliases) indexed. */
  readonly size: number;
  /** The canonical brand name the place name matches, or null. */
  match(name: string): string | null;
}

/** The normalized form both sides are compared in (see the module comment). */
export function normalizeChainName(name: string): string {
  return (typeof name === "string" ? name : "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['’‘`´.]/g, "")
    .replace(/[&+]/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^the (?=\S)/, "");
}

/** Trailing store numbers: "starbucks 1234", "target store 0567", "gap no 12". */
function withoutStoreNumber(norm: string): string {
  return norm.replace(/(?: (?:store|no|number|unit|location|ste))? [a-z]?\d+[a-z]?$/, "").trim();
}

/** The part of a raw name before a separator that usually starts a location: " - ", " | ", " @ ", "(", ",". */
function headOf(raw: string): string | null {
  const m = /\s[-–—|@]\s|\(|,/.exec(raw);
  return m && m.index > 0 ? raw.slice(0, m.index) : null;
}

interface Key {
  words: string[];
  text: string;
  exact: boolean;
  canonical: string;
}

const COMPILED = new WeakMap<object, ChainIndex>();

/** Builds the lookup once per list. Entries without a usable name are skipped. */
export function compileChains(list: ChainList | readonly ChainEntry[]): ChainIndex {
  const cached = COMPILED.get(list);
  if (cached) return cached;
  const entries: readonly ChainEntry[] = Array.isArray(list) ? list : ((list as ChainList).chains ?? []);
  const byFirst = new Map<string, Key[]>();
  let size = 0;
  for (const e of entries) {
    if (!e || typeof e.name !== "string") continue;
    const canonical = e.name.trim();
    for (const raw of [e.name, ...(Array.isArray(e.aliases) ? e.aliases : [])]) {
      const text = normalizeChainName(raw);
      if (!text) continue;
      const words = text.split(" ");
      const first = words[0] as string;
      const list = byFirst.get(first) ?? [];
      if (list.some((k) => k.text === text)) continue;
      list.push({ words, text, exact: e.exact === true, canonical });
      byFirst.set(first, list);
      size++;
    }
  }
  // Longest key first, so "Starbucks Reserve" is tried before "Starbucks" (same brand either way).
  for (const keys of byFirst.values()) keys.sort((a, b) => b.words.length - a.words.length || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

  const index: ChainIndex = {
    size,
    match(name: string): string | null {
      if (typeof name !== "string" || !name.trim()) return null;
      const full = normalizeChainName(name);
      const head = headOf(name);
      const variants = new Set([full, withoutStoreNumber(full)]);
      if (head) {
        const h = normalizeChainName(head);
        variants.add(h);
        variants.add(withoutStoreNumber(h));
      }
      for (const v of variants) {
        if (!v) continue;
        const words = v.split(" ");
        for (const k of byFirst.get(words[0] as string) ?? []) {
          if (v === k.text) return k.canonical;
          // Not an exact entry: the key's words start the name ("starbucks coffee company").
          if (!k.exact && v.startsWith(`${k.text} `)) return k.canonical;
        }
      }
      return null;
    },
  };
  COMPILED.set(list, index);
  return index;
}

/** A compiled index as is, or a list compiled (once). */
export function chainIndex(list: ChainList | ChainIndex | readonly ChainEntry[]): ChainIndex {
  return typeof (list as ChainIndex).match === "function" ? (list as ChainIndex) : compileChains(list as ChainList | readonly ChainEntry[]);
}

/** The canonical chain name a place name matches on the list, or null. */
export function chainOf(name: string, list: ChainList | ChainIndex | readonly ChainEntry[]): string | null {
  return chainIndex(list).match(name);
}

/** True when the place name matches a brand on the hand-kept chain list. */
export function isChain(name: string, list: ChainList | ChainIndex | readonly ChainEntry[]): boolean {
  return chainOf(name, list) !== null;
}
