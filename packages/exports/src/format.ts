/**
 * Deterministic formatting and small sheet helpers shared by every export.
 * No locale guessing and no clock: the same sheet always formats the same way.
 */
import type { Bill, LedgerEntry, LiftTile, OperatorInputs, Partner, PartnerExplain, StreetSheet, Weekday } from "@walkup/contracts";
import { WEEKDAYS } from "@walkup/contracts";
import { stateFromZctas, stateFromZip } from "@walkup/gazetteer/states";

/** Tiles at or above this lift are "top" tiles (same threshold as the engine's minLift and the web sheet). */
export const TOP_LIFT = 1.3;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Noon UTC on a YYYY-MM-DD date, so day arithmetic never crosses a boundary. */
export function parseYmd(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}

export function ymdOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return ymdOf(d);
}

/** Weekday of a YYYY-MM-DD date. */
export function weekdayOfYmd(ymd: string): Weekday {
  const js = parseYmd(ymd).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7] as Weekday;
}

/** "Sat Nov 28 2026"; an unparseable date is returned as given. */
export function formatShowDate(ymd: string): string {
  if (!isYmd(ymd)) return ymd;
  const d = parseYmd(ymd);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

/** Whole days from the plan's creation date (UTC) to the show date. Null when either is unusable. */
export function tMinusDays(createdAtIso: string, showYmd: string): number | null {
  const created = new Date(createdAtIso);
  if (Number.isNaN(created.getTime()) || !isYmd(showYmd)) return null;
  const createdDay = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate());
  const show = parseYmd(showYmd);
  const showDay = Date.UTC(show.getUTCFullYear(), show.getUTCMonth(), show.getUTCDate());
  return Math.round((showDay - createdDay) / 86_400_000);
}

/** "21 days to the show", "1 day to the show", "Show day", "2 days after the show", "" when unknown. */
export function tMinusLabel(days: number | null): string {
  if (days === null) return "";
  if (days === 0) return "Show day";
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} after the show`;
  return `${days} ${days === 1 ? "day" : "days"} to the show`;
}

/** "16:00" -> "4 pm", "09:30" -> "9:30 am", "00:00" -> "midnight", "12:00" -> "noon". */
function clock12(hh: number, mm: number): string {
  const h = hh % 24;
  if (mm === 0 && h === 0) return "midnight";
  if (mm === 0 && h === 12) return "noon";
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

/**
 * Opening hours as a US reader says them: "16:00-02:00" -> "4 pm to 2 am". Text around the ranges is kept;
 * anything else passes through unchanged.
 */
export function formatHours(s: string): string {
  // Live Qloo hours carry seconds ("17:00:00-00:00:00"); they are dropped.
  return s.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*[-–]\s*(\d{1,2}):(\d{2})(?::\d{2})?\b/g, (_m, h1: string, m1: string, h2: string, m2: string) => `${clock12(Number(h1), Number(m1))} to ${clock12(Number(h2), Number(m2))}`);
}

function parseReceipts(ids: readonly string[]): { id: string; p: string; n: number }[] {
  const uniq = [...new Set(ids.map((r) => (r ?? "").trim()).filter((r) => r !== ""))];
  const parsed = uniq.map((id) => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(id);
    return m ? { id, p: m[1] as string, n: Number(m[2]) } : { id, p: id, n: Number.NaN };
  });
  const rank = (p: string) => {
    const i = LEDGER_ORDER.indexOf(p);
    return i === -1 ? 99 : i;
  };
  return parsed.sort((a, b) => rank(a.p) - rank(b.p) || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0) || a.n - b.n);
}

/** Receipt ids once each, sorted by source (Q, T, P, C, L, A) and number: ["Q15","Q12","Q15"] -> ["Q12","Q15"]. */
export function sortedReceipts(ids: readonly string[]): string[] {
  return parseReceipts(ids).map((r) => r.id);
}

/**
 * Receipt ids as one compact footnote group: unique, sorted by source (Q, T, P, C, L, A) and number, runs
 * collapsed ("Q6-Q9"), at most `max` groups and then "+N". E.g. ["Q13","Q6","Q14","Q7"] -> "Q6-Q7, Q13-Q14".
 */
export function receiptGroup(ids: readonly string[], max = 3): string {
  const parsed = parseReceipts(ids);
  const groups: string[] = [];
  let i = 0;
  while (i < parsed.length) {
    const start = parsed[i] as { id: string; p: string; n: number };
    let j = i;
    while (j + 1 < parsed.length && parsed[j + 1]!.p === start.p && Number.isFinite(start.n) && parsed[j + 1]!.n === parsed[j]!.n + 1) j++;
    groups.push(j > i ? `${start.id}-${parsed[j]!.id}` : start.id);
    i = j + 1;
  }
  if (groups.length <= max) return groups.join(", ");
  const shown = groups.slice(0, max);
  const hidden = groups.slice(max).reduce((n, g) => n + (g.includes("-") ? 2 : 1), 0);
  return `${shown.join(", ")} +${hidden}`;
}

export function formatInt(n: number): string {
  const s = Math.round(Math.abs(n)).toString();
  const withCommas = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${withCommas}` : withCommas;
}

export function formatUsd(n: number): string {
  return `$${formatInt(n)}`;
}

export function formatPct(x: number, dp = 0): string {
  return `${(x * 100).toFixed(dp)}%`;
}

export function formatLift(lift: number): string {
  return `${lift.toFixed(2)}x`;
}

/** Round to `dp` decimals and drop float noise (0.1 + 0.2 -> 0.3). */
export function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export const WEEKDAY_SHORT: Readonly<Record<Weekday, string>> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

export function weekdayShort(d: Weekday): string {
  return WEEKDAY_SHORT[d] ?? d;
}

export function weekdayLong(d: Weekday): string {
  return d.charAt(0).toUpperCase() + d.slice(1);
}

export function actsLine(bill: Bill): string {
  const names = (bill.acts ?? []).map((a) => (a.name ?? "").trim()).filter((n) => n !== "");
  return names.length > 0 ? names.join(", ") : "Unnamed bill";
}

export const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  bar: "Bar",
  restaurant: "Restaurant",
  cafe: "Cafe",
  coffee: "Coffee",
  record_store: "Record store",
  book_store: "Bookstore",
  barber_shop: "Barbershop",
  beauty_salon: "Salon",
  clothing_store: "Clothing",
  other: "Other",
};

export function categoryLabel(key: string | null | undefined): string {
  if (!key) return "";
  const known = CATEGORY_LABEL[key];
  if (known) return known;
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Age policy wording. Alcohol rules come from Ticketmaster's ageRestrictions only, never from Qloo. */
export function ageLabel(legalAgeEnforced: boolean | null): { inline: string; long: string } {
  if (legalAgeEnforced === true) return { inline: "21+", long: "21+ (Ticketmaster age policy)" };
  if (legalAgeEnforced === false) return { inline: "all ages", long: "All ages (Ticketmaster age policy)" };
  return { inline: "age policy unknown", long: "Age policy not on the listing: treated as all ages" };
}

/**
 * Age wording for the sheet header and panel 4. Ticketmaster's rule comes first; the operator's "all ages"
 * setting can only add a restriction, so it shows only when Ticketmaster does not already say all ages.
 */
export function sheetAgeLabel(bill: Pick<Bill, "legalAgeEnforced">, operator?: Pick<OperatorInputs, "allAges"> | null): { short: string; long: string } {
  const tm = ageLabel(bill.legalAgeEnforced);
  const short = bill.legalAgeEnforced === true ? "21+" : bill.legalAgeEnforced === false ? "All ages" : "Age policy unknown";
  if (operator?.allAges === true && bill.legalAgeEnforced !== false) {
    return { short: bill.legalAgeEnforced === true ? "21+ (no bars: operator setting)" : "All ages (operator setting)", long: `${tm.long}. The operator set this sheet to all ages: no bars` };
  }
  return { short, long: tm.long };
}

/**
 * True unless Ticketmaster says the show is 21+: fan-facing text may then not mention alcohol or bars.
 * The operator's all-ages setting can only make this stricter, never relax it.
 */
export function isAllAgesForCopy(bill: Pick<Bill, "legalAgeEnforced">, operator?: Pick<OperatorInputs, "allAges"> | null): boolean {
  return bill.legalAgeEnforced !== true || operator?.allAges === true;
}

const LEDGER_ORDER = ["Q", "T", "P", "C", "L", "A"];

/** Ledger id ranges, e.g. "Q1-Q22, T1-T2, A1". Ids that do not end in a number are listed as they are. */
export function ledgerRanges(entries: readonly Pick<LedgerEntry, "id">[]): string {
  const byPrefix = new Map<string, number[]>();
  const odd: string[] = [];
  for (const e of entries) {
    const m = /^([A-Za-z]+)(\d+)$/.exec(e.id);
    if (!m || m[1] === undefined || m[2] === undefined) {
      odd.push(e.id);
      continue;
    }
    byPrefix.set(m[1], [...(byPrefix.get(m[1]) ?? []), Number(m[2])]);
  }
  const rank = (p: string): number => {
    const i = LEDGER_ORDER.indexOf(p);
    return i === -1 ? 99 : i;
  };
  const prefixes = [...byPrefix.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const parts = prefixes.map((p) => {
    const ns = byPrefix.get(p) ?? [];
    const min = Math.min(...ns);
    const max = Math.max(...ns);
    return min === max ? `${p}${min}` : `${p}${min}-${p}${max}`;
  });
  return [...parts, ...odd].join(", ");
}

export interface TileSelectOptions {
  /** How many tiles to keep (default 5, as on the sheet). */
  maxTiles?: number;
  /** Lift floor (default 1.3). */
  minLift?: number;
}

/** Areas closer than this (km) to a higher-lift area are the same place and get no number of their own. */
export const AREA_MERGE_KM = 3;

function kmBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** True when `t` is the same place as `o`: within AREA_MERGE_KM or sharing a ZIP. */
export function sameArea(o: Pick<LiftTile, "lat" | "lon" | "zctas">, t: Pick<LiftTile, "lat" | "lon" | "zctas">): boolean {
  const zo = o.zctas ?? [];
  return kmBetween(o, t) < AREA_MERGE_KM || (zo.length > 0 && (t.zctas ?? []).some((z) => zo.includes(z)));
}

/**
 * The numbered areas: lift >= minLift, highest lift first (ties: billPct desc, geohash asc), skipping a tile
 * that is the same place as one already numbered (within 3 km or sharing a ZIP), so 1-5 are distinct places.
 * Same rule as the orchestrator's spread tiles, so the numbers match the budget split and partner areas.
 */
export function topTiles(sheet: StreetSheet, opts: TileSelectOptions = {}): LiftTile[] {
  const minLift = opts.minLift ?? TOP_LIFT;
  const n = Math.max(0, opts.maxTiles ?? 5);
  const sorted = [...(sheet.cards.liftMap.results.tiles ?? [])]
    .filter((t) => Number.isFinite(t.lift) && t.lift >= minLift)
    .sort((a, b) => b.lift - a.lift || b.billPct - a.billPct || (a.geohash < b.geohash ? -1 : a.geohash > b.geohash ? 1 : 0));
  const out: LiftTile[] = [];
  for (const t of sorted) {
    if (out.length >= n) break;
    if (out.some((o) => sameArea(o, t))) continue;
    out.push(t);
  }
  return out;
}

export function tileLabel(t: Pick<LiftTile, "name" | "geohash">): string {
  return t.name && t.name.trim() !== "" ? t.name.trim() : t.geohash;
}

/**
 * The state an area is in ("MD"): the state of the tile's own point when the run stored it, else from its ZCTAs
 * (nearest first, as the run lists them). Null when none is known.
 */
export function areaState(t: Pick<LiftTile, "zctas"> & Partial<Pick<LiftTile, "state">>): string | null {
  return t.state ?? stateFromZctas(t.zctas ?? []);
}

/** A trailing distance in an area name, ", 19 km northwest" (the run names a far area by its distance from the room). */
export const DISTANCE_SUFFIX = /, [\d.]+ km (?:north|northeast|east|southeast|south|southwest|west|northwest)$/;

/**
 * Adds ", ST" unless the name already carries that state as one of its parts. A trailing distance stays last:
 * "Des Plaines, 19 km northwest" becomes "Des Plaines, IL, 19 km northwest", as on the plan page.
 */
export function withState(name: string, st: string | null): string {
  if (!st || name === "") return name;
  if (name === st || name.split(/,\s*/).includes(st)) return name;
  const suffix = DISTANCE_SUFFIX.exec(name)?.[0] ?? "";
  return `${name.slice(0, name.length - suffix.length)}, ${st}${suffix}`;
}

/**
 * An area as people name it: its own place name and its own state, "Silver Spring, MD", "Langston, DC",
 * "Tysons Green, VA", "Des Plaines, IL, 19 km northwest". Never the venue's city or state: a metro can span several
 * states. The state comes from the tile's own point, else its ZCTAs; an area without either, or named only by its
 * geohash, keeps the bare name. The same label on the web sheet, the PDF, the CSVs and the calendar.
 */
export function areaLabel(t: Pick<LiftTile, "name" | "geohash" | "zctas"> & Partial<Pick<LiftTile, "state">>): string {
  const name = tileLabel(t);
  if (!t.name || t.name.trim() === "") return name;
  return withState(name, areaState(t));
}

/** The state in a US street address ("... Laurel, MD 20707"), or null. */
export function addressState(address: string | null | undefined): string | null {
  const a = (address ?? "").trim();
  const m = /,\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/.exec(a);
  if (m) return stateFromZip(m[2]) ?? m[1] ?? null;
  const zip = /\b(\d{5})(?:-\d{4})?\s*$/.exec(a)?.[1];
  return zip ? stateFromZip(zip) : null;
}

/**
 * A partner's area label: its lift tile's label when the tile is on the sheet (so the numbers and names match the
 * map), else its tile name with the state of its own address, else its geohash, else "".
 */
export function partnerAreaLabel(p: Pick<Partner, "tileGeohash" | "tileName" | "address">, tiles: ReadonlyMap<string, LiftTile>): string {
  const tile = p.tileGeohash ? tiles.get(p.tileGeohash) : undefined;
  if (tile && (tile.name ?? "").trim() !== "") return areaLabel(tile);
  const name = (p.tileName ?? "").trim();
  if (name !== "") return withState(name, addressState(p.address));
  return tile ? tileLabel(tile) : (p.tileGeohash ?? "");
}

/**
 * The state of a partner's own address when it differs from the state its area label ends in ("Kenilworth, DC",
 * "Des Plaines, IL, 19 km northwest"), else null: an area's places come from up to 2 km around its centre, sometimes
 * over a state line ("Oasiz Bar & Grill", area Kenilworth, DC, at an address in Hyattsville, MD).
 */
export function partnerOtherState(p: Pick<Partner, "address">, label: string): string | null {
  const own = addressState(p.address);
  const area = /,\s*([A-Z]{2})(?:,\s*[\d.]+ km \w+)?$/.exec(label)?.[1] ?? null;
  return own && area && own !== area ? own : null;
}

/** The area words for a partner from the search around the venue (no area of its own), on paper and in the files. */
export const NEAR_VENUE = "near venue";

/** `partnerAreaLabel` for paper and files: "Kenilworth, DC (place in MD)" when the address is over a state line. */
export function partnerAreaText(p: Pick<Partner, "tileGeohash" | "tileName" | "address">, tiles: ReadonlyMap<string, LiftTile>): string {
  const label = partnerAreaLabel(p, tiles);
  const other = label ? partnerOtherState(p, label) : null;
  return other ? `${label} (place in ${other})` : label;
}

/**
 * The weekday a partner's `hoursOnDay` belongs to: the first street-team day, else the show's weekday (the same
 * day the plan read the hours for). Null when neither is set.
 */
export function hoursWeekday(sheet: Pick<StreetSheet, "operator" | "bill">): Weekday | null {
  return sheet.operator.streetTeamDays?.[0] ?? sheet.bill.weekday ?? null;
}

/**
 * A phone number as people read it: "+12027334604" and "2027334604" become "(202) 733-4604". Anything that is
 * not a 10-digit US number (with or without +1) is returned as given.
 */
export function formatPhone(phone: string | null | undefined): string {
  const raw = (phone ?? "").trim();
  // Extensions and vanity letters stay as written.
  if (/[a-z]/i.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (!ten) return raw;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

/** "example.com" from "https://www.example.com/a/b". */
export function shortDomain(url: string): string {
  const host = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^www\./i, "")
    .split(/[/?#]/)[0];
  return host ?? url;
}

/** Upper-case A-Z0-9 code fragment from free text (accents removed), at most `len` characters. */
export function codeFragment(s: string, len: number): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, Math.max(0, len));
}

export const SUGGESTED_NOT_AFFILIATED = "Suggested, not affiliated: no partner has agreed to anything.";

export const ATTRIBUTION =
  "Events: Ticketmaster. Map data © OpenStreetMap contributors. Population: U.S. Census Bureau, ACS 5-year. Affinity data: Qloo.";

/** The credit line on a sample (fixture) sheet: no live source answered, so none is credited as one. */
export const SAMPLE_ATTRIBUTION = "Sample data shaped like Ticketmaster and Qloo answers. Map data © OpenStreetMap contributors.";

/** The map key's four steps, the same on the web, the print view and the PDF: label and a lift that draws it. */
export const LIFT_KEY: readonly { label: string; sample: number }[] = [
  { label: "under 1.0x", sample: 0.8 },
  { label: "1.0 to 1.3x", sample: 1.1 },
  { label: "1.3 to 2.2x", sample: 1.6 },
  { label: "2.2x and up", sample: 2.2 },
];

/** The short label a sample (fixture) sheet carries in its header and as its light watermark. */
export const SAMPLE_LABEL = "Sample data";

/** One plain sentence on every sample (fixture) file: PDF footer, calendar, partners.csv, sheet.json. */
export const FIXTURE_NOTICE = "Sample data: made-up places and numbers, not a live run.";

/** Prefix on calendar summaries and offer-code descriptions of a sample sheet. */
export const SAMPLE_PREFIX = "[Sample] ";

/** Up to three allowlisted tag names from a partner's explain parts, e.g. "Americana, Vinyl, Live music". */
export function explainTags(e: Pick<PartnerExplain, "tags">, max = 3): string {
  return (e.tags ?? [])
    .map((t) => (t.name ?? "").trim())
    .filter((n) => n !== "")
    .slice(0, max)
    .join(", ");
}

/**
 * The partner table's "Why (confidence)" cell: the tags that tie the place to this crowd, then the confidence
 * word, e.g. "Americana, Vinyl (high)". With no tags, "high confidence".
 */
export function partnerWhy(e: Pick<PartnerExplain, "tags" | "confidence">): string {
  const tags = explainTags(e);
  return tags !== "" ? `${tags} (${e.confidence})` : `${e.confidence} confidence`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st ... */
export function ordinal(n: number): string {
  const i = Math.round(n);
  const m100 = Math.abs(i) % 100;
  const m10 = Math.abs(i) % 10;
  const suffix = m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th";
  return `${i}${suffix}`;
}

/**
 * One plain line on why a partner is on the list, the same on screen and on paper: its rank here for this
 * crowd, then where the room's usual crowd ranks it. When the usual crowd ranks it as high or higher, the line
 * says it suits any night. How sure the pick is lives in its own column or note (a dagger), not in this line.
 * E.g. "Ranks 8th here for this crowd, 20th for the room's usual crowd."
 */
export function partnerWhyLine(p: { qlooRank: number; houseRank?: number | null }): string {
  const here = `Ranks ${ordinal(p.qlooRank)} here for this crowd`;
  let line: string;
  if (typeof p.houseRank === "number" && Number.isFinite(p.houseRank)) {
    line = p.houseRank === p.qlooRank ? `${here}, the same for the room's usual crowd` : `${here}, ${ordinal(p.houseRank)} for the room's usual crowd`;
    if (p.houseRank <= p.qlooRank) line += "; a good place on any night, not just this bill";
  } else if (p.houseRank === null) line = `${here}; not in the usual crowd's list`;
  else line = here;
  return `${line}.`;
}

/** True when a partner gets the dagger: Walkup is less sure of it (confidence below high). */
export function partnerLessSure(p: { explain?: Pick<PartnerExplain, "confidence"> | null }): boolean {
  const c = p.explain?.confidence;
  return c === "medium" || c === "low";
}

/** The one note under a partner table with daggers, the same on screen and on paper. */
export const LESS_SURE_NOTE = "† Less certain: the search widened, the list was short or the place ranked low. Call before you go.";

/**
 * The receipts behind a partner's why line, the same on screen and on paper: the pool's request and the
 * usual-crowd search (not the lift tile or the influence chip, which have their own lines).
 */
export function partnerWhyRefs(p: { chips: readonly { label: string; ledgerRef: string }[] }): string[] {
  return p.chips.filter((c) => !/^in a [\d.]+x lift tile$/.test(c.label) && !/^most influenced by /.test(c.label)).map((c) => c.ledgerRef);
}

/**
 * The radius the lift map was searched at when it widened past the operator's ("The search widened to 60 km ..." on
 * the map card's reason), else null. The same reading as the plan page's header.
 */
export function mapReachKm(sheet: { cards: { liftMap: { reason?: string | null } }; operator: { radiusKm: number } }): number | null {
  const m = /The search widened to (\d+(?:\.\d+)?) km/.exec(sheet.cards.liftMap.reason ?? "");
  const km = m ? Number(m[1]) : null;
  return km !== null && km !== sheet.operator.radiusKm ? km : null;
}

/** "Thu and Sat", "Thu, Fri and Sat": the street-team days, the same words everywhere. */
export function streetDaysText(days: readonly Weekday[]): string {
  const w = days.map(weekdayShort);
  if (w.length <= 1) return w.join("");
  return `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

/** "Capacity 4,400 (assumed)": a count the operator entered or a preset carries, never ticket sales. */
export function capacityText(capacity: number): string {
  return `Capacity ${formatInt(capacity)} (assumed)`;
}

/**
 * Lines in a sheet's limits that say where the data came from, not what the sheet can't show. "The Google Places
 * list" and "Without-Qloo list" appear only on sheets made before the comparison list was removed (Oct 20 2026).
 */
const PROVENANCE_LINE = /^(Sample data|Venue points for rooms|Venue coordinates in this synthetic fixture|The Google Places list|Fixture mode|Without-Qloo list|Planning tool)/i;

/**
 * The sheet's real limits ("What this sheet doesn't show"), the same list on paper and in the email: provenance
 * lines (sample data, approximate venue points, "planning tool") are
 * said elsewhere once. Falls back to the four lines every sheet carries.
 */
export function realLimits(limits: readonly string[] | undefined, fallback: readonly string[]): string[] {
  const own = (limits ?? []).map((l) => l.trim()).filter((l) => l !== "" && !PROVENANCE_LINE.test(l));
  return [...new Set(own.length > 0 ? own : fallback)];
}

/** Blanks the paper and partners.csv say out loud instead of leaving a cell empty. */
export const PHONE_NOT_LISTED = "Phone not listed";
export const WEBSITE_NOT_LISTED = "Website not listed";
export const HOURS_NOT_LISTED = "Hours not listed: call first";

/** A spot the room's usual crowd's list does not have, in a sentence and in the paper table's narrow column. */
export const SPOT_NOT_IN_USUAL = "not in the room's usual crowd's list";
export const SPOT_NOT_IN_USUAL_SHORT = "not in its list";

/** A declared partner Qloo could not rank, in the same words on the web, on paper, in the CSV and over MCP. */
export const DECLARED_UNRANKED = "not in Qloo's catalog, kept in your order";

/**
 * How a spot ranks for this crowd against the room's usual crowd, in one phrase:
 * "ranks 3 places higher here than for the room's usual crowd", "ranks the same here as for the room's usual crowd".
 * A spot without a rank says so when the usual crowd's list came back (`listCameBack`, other spots have a rank):
 * "not in the room's usual crowd's list". Otherwise "".
 */
export function spotVsUsual(deltaRank: number | null, listCameBack = false): string {
  if (deltaRank === null || !Number.isFinite(deltaRank)) return listCameBack ? SPOT_NOT_IN_USUAL : "";
  if (deltaRank === 0) return "ranks the same here as for the room's usual crowd";
  const n = Math.abs(deltaRank);
  return `ranks ${n} ${n === 1 ? "place" : "places"} ${deltaRank > 0 ? "higher" : "lower"} here than for the room's usual crowd`;
}

/** What the spots' share column assumes, one sentence on the web and on paper. */
export function spotsShareNote(capacities: readonly number[]): string | null {
  if (capacities.length === 0) return null;
  const caps = [...new Set(capacities)];
  return caps.length === 1 && Number.isFinite(caps[0])
    ? `Share is the part of the crowd each spot might get, assuming about ${formatInt(caps[0] as number)} people fit: a rule of thumb, not a forecast.`
    : "Share is the part of the crowd each spot might get, with an assumed capacity for each: a rule of thumb, not a forecast.";
}

/**
 * Hours on one day as people say them: "Thu 10 am to 8 pm". Blank hours say so: "Hours not listed: call first".
 * `hoursOnDay` may already lead with the day ("Thu 10:00-20:00").
 */
export function dayHoursText(hoursOnDay: string | null | undefined, day?: Weekday): string {
  const raw = (hoursOnDay ?? "").trim();
  if (raw === "") return "Hours not listed: call first";
  const lead = /^([A-Z][a-z]{2}) /.exec(raw)?.[1];
  const body = formatHours(raw.replace(/^[A-Z][a-z]{2} /, ""));
  const d = day ? weekdayShort(day) : lead;
  return d ? `${d} ${body}` : body;
}

/** The longer form for partners.csv: tags, then the confidence and why it is that, e.g. "Americana, Vinyl. High confidence: ...". */
export function partnerWhyLong(e: Pick<PartnerExplain, "tags" | "confidence" | "confidenceWhy" | "limits">): string {
  const tags = explainTags(e, 8);
  const conf = `${e.confidence.charAt(0).toUpperCase()}${e.confidence.slice(1)} confidence${e.confidenceWhy?.trim() ? `: ${e.confidenceWhy.trim().replace(/\.$/, "")}` : ""}.`;
  const limits = e.limits?.trim() ? ` ${e.limits.trim().replace(/\.?$/, ".")}` : "";
  return `${tags !== "" ? `${tags}. ` : ""}${conf}${limits}`;
}

/**
 * True when the sheet's counts (seats left, capacity) are what-ifs to label as such: on a sample (fixture) sheet
 * only. A live sheet's counts are the operator's own, so it carries no what-if label, watermark or flag, whatever an
 * older stored sheet says in `hypothetical`.
 */
export function countsAreWhatIf(sheet: Pick<StreetSheet, "mode" | "hypothetical">): boolean {
  return sheet.mode === "fixture" && sheet.hypothetical === true;
}

/**
 * "1.5 km", "0.2 km", "<0.1 km"; "" when unknown. Every distance on the sheet and in the files is in km. Under 1 km
 * it rounds the distance the plan page shows (to 10 m, "950 m") rather than the raw metres, so 949.7 m is "1.0 km"
 * here as 950 m is there.
 */
export function formatKm(metres: number | null | undefined): string {
  if (metres === null || metres === undefined || !Number.isFinite(metres) || metres < 0) return "";
  if (metres < 50) return "<0.1 km";
  const shown = metres < 1000 ? Math.round(metres / 10) * 10 : metres;
  return `${(Math.round(shown / 100) / 10).toFixed(1)} km`;
}

const CART_OR_STAND = /\b(carts?|kiosks?|food trucks?|stands?)\b/i;

/**
 * True for a food cart, kiosk, stand or food truck (by its category or its name): not a place to meet before or
 * after a show, and it has no room to count.
 */
export function isCartOrStand(place: { name: string; category?: string | null }): boolean {
  const category = (place.category ?? "").replace(/[_-]+/g, " ");
  return CART_OR_STAND.test(category) || CART_OR_STAND.test(place.name ?? "");
}

/**
 * The before-and-after spots the sheet lists: no carts, kiosks, stands or food trucks; the local spots nearest to the
 * venue first, then the national chains nearest first, as the card's chain sentence says ("listed last"). Spots
 * without a distance go last in their group, in the sheet's order. The same list on the web, the print view and the PDF.
 */
export function sheetSpots<T extends { entity: { name: string; distanceM?: number | null }; category?: string | null; chain?: boolean }>(spots: readonly T[]): T[] {
  const far = (s: T) => (typeof s.entity.distanceM === "number" && Number.isFinite(s.entity.distanceM) ? s.entity.distanceM : Number.POSITIVE_INFINITY);
  const chain = (s: T) => (s.chain === true ? 1 : 0);
  return spots
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !isCartOrStand({ name: s.entity.name, category: s.category }))
    .sort((a, b) => chain(a.s) - chain(b.s) || far(a.s) - far(b.s) || a.i - b.i)
    .map(({ s }) => s);
}

/**
 * True when the spots' shares of the crowd say something: they differ (to one decimal of a percent). When every
 * spot gets the same share, the share column and its note are left out.
 */
export function spotSharesDiffer(shares: readonly number[]): boolean {
  return new Set(shares.filter((x) => Number.isFinite(x)).map((x) => (x * 100).toFixed(1))).size > 1;
}

/**
 * Text cut to about `max` characters at a sentence end, never mid-sentence: whole sentences while they fit, and at
 * least the first sentence whole.
 */
export function sentencesUpTo(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  // A sentence ends at . ! or ? followed by a space ("1.7 times" is not an end).
  const parts = t.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const p of parts) {
    const next = out === "" ? p : `${out} ${p}`;
    if (out !== "" && next.length > max) break;
    out = next;
  }
  return out;
}
