/**
 * The P1 ground-truth table (data/private/p1/bars_full.csv, written by collect_bars.py and
 * centroids.py) and the queries built from it. A query is one (club, metro) pair (plan §4);
 * its own bars are the club's bars whose metro is that metro.
 */
import type { GeoPoint } from "@walkup/contracts";
import { parseCsv } from "./csv";
import { isClubKey, metroDisplayName, VIABILITY_METROS, type ClubKey } from "./protocol";

export const REQUIRED_BAR_COLUMNS = [
  "bar_key",
  "club",
  "city",
  "state",
  "bar_name",
  "address",
  "page_last_updated",
  "listing_role",
  "metro_geoid",
  "metro_name",
  "metro_state",
  "metro_lat",
  "metro_lon",
] as const;

export interface BarRow {
  barKey: string;
  club: ClubKey;
  city: string;
  state: string;
  barName: string;
  address: string;
  pageLastUpdated: string;
  /** "official" or "satellite" as the club designates the listing. */
  listingRole: string;
  metroGeoid: string;
  metroName: string;
  metroState: string;
  /** Census Gazetteer internal point P, or null (status no_metro). */
  metroPoint: GeoPoint | null;
}

function point(latS: string, lonS: string): GeoPoint | null {
  if (latS.trim() === "" || lonS.trim() === "") return null;
  const lat = Number(latS);
  const lon = Number(lonS);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Parses and validates the table. Throws on missing columns, unknown clubs or duplicate rows. */
export function parseBars(text: string): BarRow[] {
  const { header, records } = parseCsv(text);
  const missing = REQUIRED_BAR_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new Error(`bars CSV is missing columns: ${missing.join(", ")}`);
  const seen = new Set<string>();
  const out: BarRow[] = [];
  records.forEach((r, idx) => {
    const line = idx + 2;
    const club = (r.club ?? "").trim();
    if (!isClubKey(club)) throw new Error(`bars CSV line ${line}: unknown club "${club}"`);
    const barKey = (r.bar_key ?? "").trim();
    if (!barKey) throw new Error(`bars CSV line ${line}: empty bar_key`);
    const id = `${club}|${barKey}`;
    if (seen.has(id)) throw new Error(`bars CSV line ${line}: duplicate bar ${id}`);
    seen.add(id);
    const geoid = (r.metro_geoid ?? "").trim();
    out.push({
      barKey,
      club,
      city: (r.city ?? "").trim(),
      state: (r.state ?? "").trim(),
      barName: (r.bar_name ?? "").trim(),
      address: (r.address ?? "").trim(),
      pageLastUpdated: (r.page_last_updated ?? "").trim(),
      listingRole: (r.listing_role ?? "").trim(),
      metroGeoid: geoid,
      metroName: (r.metro_name ?? "").trim(),
      metroState: (r.metro_state ?? "").trim(),
      metroPoint: geoid ? point(r.metro_lat ?? "", r.metro_lon ?? "") : null,
    });
  });
  return out;
}

export interface Query {
  /** "<club>|<metro_geoid>" */
  key: string;
  club: ClubKey;
  metro: string;
  metroName: string;
  metroState: string;
  /** Prompt name (centroids.metro_display_name). */
  metroDisplay: string;
  point: GeoPoint;
  bars: BarRow[];
}

export function queryKey(club: string, metro: string): string {
  return `${club}|${metro}`;
}

/** One query per (club, metro) over the bars that have a metro point, sorted by club then metro id. */
export function buildQueries(bars: readonly BarRow[]): Query[] {
  const map = new Map<string, Query>();
  for (const b of bars) {
    if (!b.metroPoint || !b.metroGeoid) continue;
    const key = queryKey(b.club, b.metroGeoid);
    let q = map.get(key);
    if (!q) {
      q = {
        key,
        club: b.club,
        metro: b.metroGeoid,
        metroName: b.metroName,
        metroState: b.metroState,
        metroDisplay: metroDisplayName(b.metroName),
        point: b.metroPoint,
        bars: [],
      };
      map.set(key, q);
    }
    q.bars.push(b);
  }
  const out = [...map.values()];
  for (const q of out) q.bars.sort((a, b) => (a.barKey < b.barKey ? -1 : a.barKey > b.barKey ? 1 : 0));
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type SelectionMode = "full" | "limit" | "viability";

export interface Selection {
  mode: SelectionMode;
  queries: Query[];
  /** Bars covered by this run: every row for a full run (no_metro rows included), else the selected queries' bars. */
  bars: BarRow[];
}

export function isViabilityQuery(q: Query): boolean {
  return VIABILITY_METROS.some((m) => m.name === q.metroDisplay && m.state === q.metroState);
}

/**
 * Full run: every query and every row. --limit N: the first N queries in (club, metro) order
 * and only their bars (a smoke run). --viability: the §13 probe queries (Houston, Chicago, Durham).
 */
export function selectQueries(bars: readonly BarRow[], opts: { limit?: number | null; viability?: boolean }): Selection {
  const all = buildQueries(bars);
  if (opts.viability) {
    const queries = all.filter(isViabilityQuery);
    return { mode: "viability", queries, bars: queries.flatMap((q) => q.bars) };
  }
  if (opts.limit !== null && opts.limit !== undefined) {
    const queries = all.slice(0, Math.max(0, opts.limit));
    return { mode: "limit", queries, bars: queries.flatMap((q) => q.bars) };
  }
  return { mode: "full", queries: all, bars: [...bars] };
}

export function barId(b: Pick<BarRow, "club" | "barKey">): string {
  return `${b.club}|${b.barKey}`;
}
