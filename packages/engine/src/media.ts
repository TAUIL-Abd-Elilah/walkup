/**
 * Podcasts and the sponsor brand, as a promoter would read them.
 *
 * Recency. Qloo's podcast entities carry `properties.release_year`, the year of the show's latest episode in
 * Qloo's data (a show that ended in 2019 reads 2019; a weekly show reads the current year of the data), and on
 * some entities an end date or a status. A show is "recent" when its latest year is at most
 * PODCAST_RECENT_YEARS before the plan's year; "ended" when Qloo marks it ended or finished; "unknown" without
 * any of these. Ended and old shows are left out when enough recent ones are on the list; otherwise they stay,
 * labelled "back catalogue" (people can still listen; a read on a new episode can't be bought).
 *
 * Display name. A brand Qloo files under its legal name ("Recreational Equipment Inc") is shown by its short
 * name: Qloo's own alias or short name when the entity has one, else the acronym Qloo's own description opens
 * with when it spells the name's initials ("REI is a retail co-op ..."). Otherwise the name is unchanged.
 */
import type { QlooEntity } from "@walkup/contracts";

/** A podcast whose latest episode year is at most this many years before the plan's year counts as recent. */
export const PODCAST_RECENT_YEARS = 2;
/** Keep ended or old shows only while fewer recent ones than this are on the list. */
export const MIN_RECENT_PODCASTS = 2;
export const BACK_CATALOGUE_CHIP = "back catalogue";

export type PodcastRecency = { status: "recent" | "old" | "ended" | "unknown"; lastYear: number | null };

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d{4}/.test(v.trim())) return Number(v.trim().slice(0, 4));
  return null;
}

/** How recent a podcast is, from its Qloo properties (see the module comment). `asOfYear` is the plan's year. */
export function podcastRecency(e: Pick<QlooEntity, "properties">, asOfYear: number): PodcastRecency {
  const p = (e.properties ?? {}) as Record<string, unknown>;
  const status = typeof p.status === "string" ? p.status.toLowerCase() : "";
  const ended = p.ended === true || p.is_ended === true || p.is_active === false || /\b(ended|finished|complete|completed|inactive|cancel+ed)\b/.test(status);
  const lastYear = num(p.latest_episode_date) ?? num(p.last_episode_date) ?? num(p.end_date) ?? num(p.release_year) ?? num(p.year);
  if (ended) return { status: "ended", lastYear };
  if (lastYear === null) return { status: "unknown", lastYear };
  return { status: asOfYear - lastYear <= PODCAST_RECENT_YEARS ? "recent" : "old", lastYear };
}

export interface PodcastPick<T> {
  item: T;
  recency: PodcastRecency;
  /** True when shown as back catalogue (ended or old, kept because too few recent shows came back). */
  backCatalogue: boolean;
}

/**
 * Up to `max` podcasts in Qloo's order: recent and unknown ones first-class; ended and old ones only to fill the
 * list up to MIN_RECENT_PODCASTS, each marked back catalogue. Never reorders the shows it keeps.
 */
export function pickPodcasts<T>(items: readonly T[], entityOf: (t: T) => Pick<QlooEntity, "properties">, asOfYear: number, max: number): PodcastPick<T>[] {
  const rated = items.map((item) => ({ item, recency: podcastRecency(entityOf(item), asOfYear) }));
  const fresh = rated.filter((r) => r.recency.status === "recent" || r.recency.status === "unknown");
  const stale = rated.filter((r) => r.recency.status === "old" || r.recency.status === "ended");
  const keepStale = Math.max(0, Math.min(stale.length, MIN_RECENT_PODCASTS - fresh.length, max - Math.min(fresh.length, max)));
  const kept = new Set([...fresh.slice(0, max), ...stale.slice(0, keepStale)].map((r) => r.item));
  return rated.filter((r) => kept.has(r.item)).map((r) => ({ ...r, backCatalogue: r.recency.status === "old" || r.recency.status === "ended" }));
}

/** "back catalogue: latest episodes 2019" for a kept old or ended show. */
export function backCatalogueLabel(r: PodcastRecency): string {
  return r.lastYear !== null ? `${BACK_CATALOGUE_CHIP}: latest episodes ${r.lastYear}` : `${BACK_CATALOGUE_CHIP}: no new episodes`;
}

const LEGAL_SUFFIX = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|lp|llp)\b\.?/gi;

/** The short name a brand is known by (see the module comment), or its name unchanged. */
export function brandDisplayName(e: Pick<QlooEntity, "name" | "properties">): string {
  const name = (e.name ?? "").trim();
  const p = (e.properties ?? {}) as Record<string, unknown>;
  for (const k of ["short_name", "display_name", "alias"]) {
    const v = p[k];
    if (typeof v === "string" && v.trim() !== "" && v.trim().length < name.length) return v.trim();
  }
  const akas = Array.isArray(p.akas) ? p.akas : Array.isArray(p.aliases) ? p.aliases : [];
  const shortAka = akas
    .map((a) => (typeof a === "string" ? a : a && typeof a === "object" && typeof (a as { value?: unknown }).value === "string" ? (a as { value: string }).value : ""))
    .map((a) => a.trim())
    .filter((a) => a !== "" && a.length < name.length && /^[A-Z0-9&.\- ]{2,8}$/.test(a))
    .sort((a, b) => a.length - b.length)[0];
  if (shortAka) return shortAka;
  const words = name.replace(LEGAL_SUFFIX, " ").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const withSuffix = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const desc = typeof p.short_description === "string" ? p.short_description.trim() : "";
  const lead = /^([A-Z][A-Z0-9&]{1,7})\b/.exec(desc)?.[1];
  if (lead && words.length >= 2) {
    const initials = (ws: string[]) => ws.map((w) => (w[0] ?? "").toUpperCase()).join("");
    if (lead === initials(words) || lead === initials(withSuffix)) return lead;
  }
  return name;
}
