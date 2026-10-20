/**
 * Pinned tag URNs. Live runs read config/tags.json and use a tag only when its
 * status is "pinned"; unpinned categories are skipped and the card says so.
 * The fixture world ships its own synthetic pins (WORLD_TAG_PINS).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface TagPins {
  /** Where the pins came from (shown in limits). */
  source: string;
  /** Category key -> pinned tag URN. Unpinned categories are absent. */
  categories: Record<string, string>;
  /** Sponsor exclusion key -> pinned brand tag URN (alcohol, tobacco, gambling). */
  sponsorExclusions: Record<string, string>;
  /** Tags that mark a person as a comedian. */
  comedianTags: string[];
  /** Lower-cased Ticketmaster genre (or "default") -> tag URN for the tag baseline. */
  baselineTags: Record<string, string>;
  /** Generic foot-traffic heatmap signal (Q6), usually the restaurant category. */
  genericHeatTag: string | null;
}

/** The Q9 category set (barber_shop and beauty_salon only when pinned). */
export const DEFAULT_PARTNER_CATEGORIES = [
  "bar",
  "restaurant",
  "cafe",
  "record_store",
  "book_store",
  "clothing_store",
  "barber_shop",
  "beauty_salon",
] as const;

/** Extra categories tried when a tile returns too few places. */
export const WIDEN_CATEGORIES = ["pub", "sports_bar", "bakery", "soul_food"] as const;

/** The Q10 pre/post category set. */
export const PREPOST_CATEGORIES = ["restaurant", "bar", "cafe"] as const;

export const EMPTY_PINS: TagPins = {
  source: "none",
  categories: {},
  sponsorExclusions: {},
  comedianTags: [],
  baselineTags: {},
  genericHeatTag: null,
};

interface ConfigEntry {
  key?: string;
  urn?: string | null;
  status?: string;
}

interface TagsConfig {
  categories?: ConfigEntry[];
  sponsorExclusions?: ConfigEntry[];
  personChecks?: ConfigEntry[];
  baselines?: ConfigEntry[];
}

function pinned(list: ConfigEntry[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of list ?? []) {
    if (e.status === "pinned" && typeof e.urn === "string" && e.urn.startsWith("urn:tag:") && e.key) out[e.key] = e.urn;
  }
  return out;
}

/**
 * Where the pins live: WALKUP_TAGS_FILE when set (the image sets
 * /app/config/tags.json), else the nearest config/tags.json above this module
 * or above the working directory. A bundled server moves this module deep
 * under .next/, so the working directory walk is what finds the repository
 * (or /app) there.
 */
export function defaultTagsFile(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = (env.WALKUP_TAGS_FILE ?? "").trim();
  if (fromEnv) return resolve(/*turbopackIgnore: true*/ fromEnv);
  for (const start of [dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let dir = resolve(/*turbopackIgnore: true*/ start);
    for (let i = 0; i < 10; i++) {
      const f = join(/*turbopackIgnore: true*/ dir, "config", "tags.json");
      if (existsSync(/*turbopackIgnore: true*/ f)) return f;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(process.cwd(), "config", "tags.json");
}

/** Reads pinned URNs from config/tags.json. Unpinned entries are left out. */
export function loadTagPins(file: string = defaultTagsFile()): TagPins {
  if (!existsSync(/*turbopackIgnore: true*/ file)) return { ...EMPTY_PINS, source: `${file} (missing)` };
  const cfg = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as TagsConfig;
  const categories = pinned(cfg.categories);
  const person = pinned(cfg.personChecks);
  return {
    source: "config/tags.json",
    categories,
    sponsorExclusions: pinned(cfg.sponsorExclusions),
    comedianTags: person.comedian ? [person.comedian] : [],
    baselineTags: pinned(cfg.baselines),
    genericHeatTag: categories.restaurant ?? null,
  };
}

/** Pinned URNs for the given category keys, plus the keys that were skipped. */
export function categoryUrns(pins: TagPins, keys: readonly string[]): { urns: string[]; used: string[]; skipped: string[] } {
  const urns: string[] = [];
  const used: string[] = [];
  const skipped: string[] = [];
  for (const k of keys) {
    const u = pins.categories[k];
    if (u) {
      urns.push(u);
      used.push(k);
    } else skipped.push(k);
  }
  return { urns, used, skipped };
}

/** Category key -> [urn] for the engine's resolveCategory. */
export function categoryTagMap(pins: TagPins): Record<string, string[]> {
  return Object.fromEntries(Object.entries(pins.categories).map(([k, v]) => [k, [v]]));
}

/** True for a Ticketmaster classification that names comedy. */
export function isComedyClassification(classification: string | undefined | null): boolean {
  return /comedy/i.test(classification ?? "");
}

/**
 * The tag baseline for a bill: by Ticketmaster genre, then "default". Comedy never gets one: on
 * Oct 15 the stand-up comedy tag heatmap came back with 0 areas near a comedy club (probe 19), and the
 * music "default" would compare a comedy crowd with music fans. A comedy bill uses the room's own
 * roster (5 or more comedians) or has no lift map.
 */
export function baselineTagFor(pins: TagPins, classification: string | undefined): string | null {
  if (isComedyClassification(classification)) return null;
  const parts = (classification ?? "")
    .toLowerCase()
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of [...parts].reverse()) {
    const hit = pins.baselineTags[p];
    if (hit) return hit;
  }
  return pins.baselineTags.default ?? null;
}
