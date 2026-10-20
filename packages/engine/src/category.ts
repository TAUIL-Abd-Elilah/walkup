/**
 * Shared helpers for place entities: pinned category, closed flag and the
 * contact properties shown on the sheet.
 */
import type { QlooEntity } from "@walkup/contracts";

export interface CategoryOptions {
  /** Custom resolver; wins when it returns a non-empty string. */
  categoryOf?: (e: QlooEntity) => string | null | undefined;
  /** Pinned category key -> tag ids (from config/tags.json). Checked in insertion order. */
  categoryTags?: Readonly<Record<string, readonly string[]>>;
  /** Categories that count as bars for the "at least one non-bar" rule and all-ages pages. */
  barCategories?: readonly string[];
}

export const DEFAULT_BAR_CATEGORIES: readonly string[] = [
  "bar",
  "pub",
  "sports_bar",
  "irish_pub",
  "wine_bar",
  "cocktail_bar",
  "beer_bar",
  "brewery",
  "brewpub",
  "lounge",
  "night_club",
  "nightclub",
  "dive_bar",
];

const PLACE_CATEGORY_RE = /^urn:tag:category:place:([a-z0-9_]+)/i;

/**
 * Category key for a place: the custom resolver, then the pinned tag map, then
 * the first `urn:tag:category:place:<key>` tag, else "other".
 */
export function resolveCategory(e: QlooEntity, opts: CategoryOptions = {}): string {
  if (opts.categoryOf) {
    const v = opts.categoryOf(e);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  const tagIds = new Set((e.tags ?? []).map((t) => t.id));
  if (opts.categoryTags) {
    for (const [key, ids] of Object.entries(opts.categoryTags)) {
      if (ids.some((id) => tagIds.has(id))) return key;
    }
  }
  for (const t of e.tags ?? []) {
    const m = PLACE_CATEGORY_RE.exec(t.id ?? "");
    if (m && m[1]) return m[1].toLowerCase();
  }
  return "other";
}

export function isBarCategory(category: string, barCategories: readonly string[] = DEFAULT_BAR_CATEGORIES): boolean {
  return barCategories.includes(category);
}

/** True when Qloo marks the place closed (`is_closed: true`, also accepts "true" and `isClosed`). */
export function isClosedEntity(e: QlooEntity): boolean {
  const p = e.properties ?? {};
  const v = p.is_closed ?? p.isClosed;
  return v === true || v === "true" || v === 1;
}

export function propString(e: QlooEntity, ...keys: string[]): string | null {
  const p = e.properties ?? {};
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

export function distanceOf(e: QlooEntity): number {
  const d = e.distanceM;
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : Number.POSITIVE_INFINITY;
}
