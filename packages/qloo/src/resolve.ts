/**
 * Exact-name resolution ("resolve, confirm, then ask"). A name resolves only
 * on a normalized exact match; ambiguity is never resolved silently. Anything
 * else becomes needs_input with up to 5 candidates, or unresolved.
 */
import type { ActRole, Candidate, QlooEntity, Resolution } from "@walkup/contracts";

export const COMEDIAN_TAGS = ["urn:tag:genre:person:comedian", "urn:tag:occupation:person:comedian"] as const;
export const MAX_CANDIDATES = 5;

const FOLD: Record<string, string> = {
  "ß": "ss",
  "ø": "o",
  "ł": "l",
  "đ": "d",
  "ð": "d",
  "þ": "th",
  "æ": "ae",
  "œ": "oe",
  "ı": "i",
};

/**
 * Casefold, strip diacritics and punctuation, "&" -> "and", drop a leading "the".
 * "The Beyoncé & Co." -> "beyonce and co"; "Guns N' Roses" -> "guns n roses".
 */
export function normalizeName(input: string): string {
  let t = input.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
  t = t.replace(/[ßøłđðþæœı]/g, (c) => FOLD[c] ?? c);
  t = t.replace(/&/g, " and ");
  t = t.replace(/['’‘`´]/g, "");
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  t = t.replace(/^the (?=\S)/, "");
  return t;
}

export function hasComedianTag(e: QlooEntity): boolean {
  return e.tags.some((t) => (COMEDIAN_TAGS as readonly string[]).includes(t.id));
}

/** Person tags that mark a musician (live /search person rows, Oct 15). */
export const MUSICIAN_TAGS = [
  "urn:tag:genre:person:musician",
  "urn:tag:occupation:person:musician",
  "urn:tag:occupation:person:singer",
  "urn:tag:occupation:person:singer_songwriter",
  "urn:tag:occupation:person:songwriter",
  "urn:tag:occupation:person:rapper",
  "urn:tag:occupation:person:recording_artist",
] as const;

export function hasMusicianTag(e: QlooEntity): boolean {
  return e.tags.some((t) => (MUSICIAN_TAGS as readonly string[]).includes(t.id));
}

/** Namespaces whose ids name one real act; a shared id means two entries are the same act. */
const SAME_ACT_NAMESPACES = ["spotify", "musicbrainz", "wikidata"] as const;

function externalIdSet(e: QlooEntity, ns: string): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) walk((v as Record<string, unknown>).id);
  };
  walk(e.external?.[ns]);
  return out;
}

/**
 * Live /search lists most musicians twice under one exact name (Oct 15): an artist entry and a person
 * entry for the same human. They are the same act when they share an entity id, share a Spotify,
 * MusicBrainz or Wikidata id, or the person carries a musician tag. A comedian and a same-named band
 * ("Sidecar") share none of these, so they stay ambiguous.
 */
export function sameAct(a: QlooEntity, b: QlooEntity): boolean {
  if (a.entityId === b.entityId) return true;
  const kinds = new Set([a.subtype, b.subtype]);
  if (!(kinds.has("urn:entity:artist") && kinds.has("urn:entity:person"))) return false;
  const person = a.subtype === "urn:entity:person" ? a : b;
  const artist = person === a ? b : a;
  if (hasMusicianTag(person) && !hasComedianTag(person)) return true;
  return SAME_ACT_NAMESPACES.some((ns) => {
    const x = externalIdSet(artist, ns);
    return [...externalIdSet(person, ns)].some((id) => x.has(id));
  });
}

/** Entities with an entity id already seen removed (live /search can list one id as artist and as person). */
function uniqueById(list: readonly QlooEntity[]): QlooEntity[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.entityId) ? false : (seen.add(e.entityId), true)));
}

function firstExternalId(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      const id = firstExternalId(item);
      if (id) return id;
    }
    return undefined;
  }
  if (typeof v === "object" && v !== null) {
    const r = v as Record<string, unknown>;
    return firstExternalId(r.id ?? r.ids ?? r.value);
  }
  return undefined;
}

/** One disambiguation link: Wikidata, then IMDb, then Spotify (artists). */
export function externalUrl(e: QlooEntity): string | undefined {
  const ext = e.external;
  if (!ext) return undefined;
  const wd = firstExternalId(ext.wikidata);
  if (wd && /^Q\d+$/.test(wd)) return `https://www.wikidata.org/wiki/${wd}`;
  const imdb = firstExternalId(ext.imdb);
  if (imdb && /^tt\d+$/.test(imdb)) return `https://www.imdb.com/title/${imdb}/`;
  if (imdb && /^nm\d+$/.test(imdb)) return `https://www.imdb.com/name/${imdb}/`;
  const sp = firstExternalId(ext.spotify);
  if (sp && /^[A-Za-z0-9]{22}$/.test(sp) && e.subtype === "urn:entity:artist") return `https://open.spotify.com/artist/${sp}`;
  return undefined;
}

export function toCandidate(e: QlooEntity): Candidate {
  const c: Candidate = { entityId: e.entityId, name: e.name, subtype: e.subtype, popularity: e.popularity };
  const sd = e.properties.short_description;
  if (typeof sd === "string" && sd.trim()) c.shortDescription = sd.trim();
  else if (e.disambiguation) c.shortDescription = e.disambiguation;
  const ry = e.properties.release_year;
  if (typeof ry === "number" && Number.isFinite(ry)) c.releaseYear = ry;
  const url = externalUrl(e);
  if (url) c.externalUrl = url;
  return c;
}

export interface ResolveOptions {
  role?: Resolution["role"];
  /** Comedy bills: a match must carry a comedian tag to be admissible. */
  requireComedianTag?: boolean;
  ledgerRef?: string;
  /**
   * Entity ids Qloo will not use as a signal (not_found in a signal check). They are never
   * picked and never offered as candidates.
   */
  unusable?: ReadonlySet<string>;
}

/** Default role from the types searched: places resolve venues, everything else a headliner. */
export function defaultRole(types: readonly string[]): ActRole | "venue" {
  const onlyPlaces = types.length > 0 && types.every((t) => t.endsWith("place"));
  return onlyPlaces ? "venue" : "headliner";
}

/** Pure: decide a Resolution from entities already fetched (from /search or /entities). */
export function resolveFromEntities(input: string, entities: readonly QlooEntity[], opts: ResolveOptions = {}): Resolution {
  const base: Resolution = { input, role: opts.role ?? "headliner", status: "unresolved" };
  if (opts.ledgerRef) base.ledgerRef = opts.ledgerRef;
  const target = normalizeName(input);
  const unusable = opts.unusable;
  if (unusable && unusable.size > 0) entities = entities.filter((e) => !unusable.has(e.entityId));
  if (!target || entities.length === 0) return base;

  entities = uniqueById(entities);
  const exact = entities.filter((e) => normalizeName(e.name) === target);
  const admissible = opts.requireComedianTag ? exact.filter(hasComedianTag) : exact;
  const only = admissible[0];
  if (admissible.length === 1 && only) return { ...base, status: "exact", entity: only };
  // One artist and one person entry for the same musician: the artist entry is the act.
  const [x, y] = admissible;
  if (admissible.length === 2 && x && y && !opts.requireComedianTag && sameAct(x, y)) {
    return { ...base, status: "exact", entity: x.subtype === "urn:entity:artist" ? x : y };
  }

  // Ambiguous (several exact) or no admissible exact match: ask, exact matches first.
  const ordered = [...admissible, ...exact.filter((e) => !admissible.includes(e)), ...entities.filter((e) => !exact.includes(e))];
  return { ...base, status: "needs_input", candidates: ordered.slice(0, MAX_CANDIDATES).map(toCandidate) };
}

/**
 * True when `name` is `target` extended into a billing name: "<target> and ...", "<target> with ...",
 * after normalizeName ("&" already reads "and"). "Jason Isbell and The 400 Unit" extends "Jason Isbell".
 */
export function extendsName(target: string, name: string): boolean {
  const t = normalizeName(target);
  const n = normalizeName(name);
  if (!t || n === t) return false;
  return n.startsWith(`${t} and `) || n.startsWith(`${t} with `);
}

export interface AlternateOptions {
  /** Other names the act is billed under; exact matches on these come second. */
  aliases?: readonly string[];
  requireComedianTag?: boolean;
  /** Ids to leave out (the first pick, ids already known to be unusable). */
  exclude?: ReadonlySet<string>;
  /** Subtype of the dropped pick: other exact matches of this subtype come first, other subtypes last. */
  subtype?: string;
}

/**
 * Fallback entries for a name whose first pick Qloo cannot use as a signal, from the same search
 * results, in tiers: (1) other exact normalized-name matches of the pick's subtype, (2) exact matches
 * on an alias, (3) billing-name extensions ("<name> and ...", "<name> with ..."), (4) exact matches of
 * another subtype (for a music act: the musician's person entry). A tier is only tried when the tiers
 * before it have nothing usable. Comedian-tag rules apply to every tier; an id appears once.
 */
export function signalAlternates(input: string, entities: readonly QlooEntity[], opts: AlternateOptions = {}): QlooEntity[][] {
  const exclude = opts.exclude ?? new Set<string>();
  const ok = (e: QlooEntity) => !exclude.has(e.entityId) && (!opts.requireComedianTag || hasComedianTag(e));
  const target = normalizeName(input);
  const seen = new Set<string>(exclude);
  const tier = (pred: (e: QlooEntity) => boolean): QlooEntity[] => {
    const out: QlooEntity[] = [];
    for (const e of entities) {
      if (seen.has(e.entityId) || !ok(e) || !pred(e)) continue;
      seen.add(e.entityId);
      out.push(e);
    }
    return out;
  };
  const aliasTargets = new Set((opts.aliases ?? []).map(normalizeName).filter((a) => a && a !== target));
  const names = [input, ...(opts.aliases ?? [])];
  const isExact = (e: QlooEntity) => normalizeName(e.name) === target;
  const sameKind = (e: QlooEntity) => opts.subtype === undefined || e.subtype === opts.subtype;
  return [
    tier((e) => isExact(e) && sameKind(e)),
    tier((e) => aliasTargets.has(normalizeName(e.name))),
    tier((e) => names.some((n) => extendsName(n, e.name))),
    tier(isExact),
  ];
}

/** What to do with an act whose first pick Qloo has no taste data for. */
export interface FallbackDecision {
  /** use: one usable entry; ask: several usable entries (needs_input); none: no usable entry. */
  kind: "use" | "ask" | "none";
  /** kind = use: the entry to use instead. */
  entity?: QlooEntity;
  /** kind = ask: the usable entries to offer (at most five). */
  candidates?: QlooEntity[];
  /**
   * kind = use: a plain line for the sheet when the swap is not clear-cut: the entry is billed under a different
   * name, or entries in the tier that decided (or a tier before it) were never checked.
   */
  note?: string;
}

/**
 * Decides the fallback for a dropped pick from its alternates tiers (signalAlternates), given which ids a signal
 * check sent (`checked`) and which it reported as not_found (`dropped`). The first tier with a usable entry
 * decides. Nothing ambiguous is settled silently: several usable entries ask the operator, and a single usable
 * entry that is billed under another name, or that won while candidates in its tier (or an earlier one) were never
 * checked, carries a note the sheet shows.
 */
export function decideFallback(
  name: string,
  tiers: readonly (readonly QlooEntity[])[],
  checked: ReadonlySet<string>,
  dropped: ReadonlySet<string>,
): FallbackDecision {
  let uncheckedBefore = 0;
  for (const tier of tiers) {
    const usable = tier.filter((e) => checked.has(e.entityId) && !dropped.has(e.entityId));
    const unchecked = tier.filter((e) => !checked.has(e.entityId)).length;
    const only = usable[0];
    if (!only) {
      uncheckedBefore += unchecked;
      continue;
    }
    if (usable.length > 1) return { kind: "ask", candidates: usable.slice(0, MAX_CANDIDATES) };
    const notes: string[] = [];
    if (normalizeName(only.name) !== normalizeName(name)) {
      notes.push(`"${only.name}" is billed under a different name, so check it's the same act.`);
    }
    const open = uncheckedBefore + unchecked;
    if (open > 0) {
      notes.push(
        `${open === 1 ? "One other entry" : `${open} other entries`} under this name ${open === 1 ? "wasn't" : "weren't"} checked, so it may not be the only fit.`,
      );
    }
    return notes.length > 0 ? { kind: "use", entity: only, note: notes.join(" ") } : { kind: "use", entity: only };
  }
  return { kind: "none" };
}
