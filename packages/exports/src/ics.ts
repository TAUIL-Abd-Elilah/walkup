/**
 * street-team.ics: an RFC 5545 calendar of street-team stops by day, plus the show.
 *
 * - Two passes: a first pass about four weeks out and a final pass in the show
 *   week (never before the plan was made, never on a holiday such as Christmas
 *   Eve, when shops keep holiday hours: that day's stops move to the same
 *   weekday a week earlier, else to the nearest free day of the same week, so
 *   each pass keeps its number of days). Each street-team day covers one part
 *   of town: the areas are cut into runs along a nearest-neighbour route from
 *   the venue, an area's partners share a day, and the day's stops follow a
 *   nearest-neighbour walk.
 * - One event per partner stop, timed inside that partner's open hours on that
 *   day (read from the place's own week of hours, for that weekday). A partner
 *   whose hours that day aren't listed gets a stop marked "call first". A
 *   partner closed on every street-team day is not scheduled; its area's first
 *   event says so. A numbered area with no partner to visit gets a flyer drop.
 * - No two stops overlap, and each hop allows the travel time. A stop no day of
 *   the pass has time left for is not timed; the day's first event lists it
 *   (a day with no timed stop gets one all-day event that does).
 * - Lines end in CRLF and are folded at 75 octets (continuation lines start
 *   with one space; UTF-8 sequences are never split).
 * - TEXT values escape backslash, semicolon, comma and newlines.
 * - UIDs are derived from the plan id, the date, the tile geohash and the
 *   partner id, so a re-export of the same plan updates events instead of
 *   duplicating them.
 * - DTSTAMP is the plan's createdAt (UTC), so the same sheet gives the same file.
 * - Times are floating local times (no TZID): "10:00" means 10:00 wherever the
 *   street team is, which is the venue's own wall clock. Pass `timeZone` with a
 *   supported US zone to pin them with a VTIMEZONE instead.
 */
import type { LiftTile, Partner, StreetSheet, Weekday } from "@walkup/contracts";
import { WEEKDAYS } from "@walkup/contracts";
import { haversineM } from "@walkup/engine";
import {
  actsLine,
  addDaysYmd,
  areaLabel,
  categoryLabel,
  formatHours,
  formatPhone,
  formatShowDate,
  FIXTURE_NOTICE,
  hoursWeekday,
  SAMPLE_PREFIX,
  isYmd,
  partnerAreaText,
  receiptGroup,
  streetDaysText,
  SUGGESTED_NOT_AFFILIATED,
  topTiles,
  weekdayOfYmd,
  weekdayShort,
  ymdOf,
  type TileSelectOptions,
} from "./format";
import { areaZips } from "./area-zips";
import { partnerHoursOn, type DayHours } from "./hours";

export const ICS_EOL = "\r\n";
export const ICS_PRODID = "-//Walkup//Street Sheet export//EN";

export interface IcsOptions extends TileSelectOptions {
  /** Street-team weekdays. Default: the sheet's `operator.streetTeamDays`. */
  streetTeamDays?: readonly Weekday[];
  /**
   * Weeks before the show for the first pass (2-8): 4 (the default) puts it on the street-team days 22 to 28 days
   * out. 0 or 1: the show week only.
   */
  firstPassWeeksOut?: number;
  /** Minutes per partner stop on the final pass, when there was a first pass. Default 10. */
  finalPassMinutes?: number;
  /** First stop of the day, "HH:MM" local. Default "10:00". A partner open only before then is still visited while open. */
  startTime?: string;
  /** Minutes for an area flyer drop (a numbered area with no partner to visit). Default 90. */
  visitMinutes?: number;
  /** Minutes per partner stop. Default 20 (cut short when the partner closes sooner). */
  stopMinutes?: number;
  /** Least minutes between stops; longer hops take 2 minutes per km. Default 15. */
  gapMinutes?: number;
  /**
   * IANA zone for the venue. Default: `sheet.bill.venue.timeZone` (from
   * Ticketmaster). Supported US zones get a VTIMEZONE and TZID parameters;
   * anything else (or nothing) gives floating local times.
   */
  timeZone?: string;
  /** Add the show itself as an event. Default true. */
  includeShow?: boolean;
  /** Doors or show time "HH:MM" for a timed show event; omitted gives an all-day event. */
  showStartTime?: string;
  /** Length of a timed show event in minutes. Default 180. */
  showMinutes?: number;
  /** Right-hand side of every UID. Default "walkup". */
  uidDomain?: string;
  /** Skip visit dates before this YYYY-MM-DD. Default: the plan's creation date. Pass "" to keep every date. */
  notBefore?: string;
}

export interface StreetTeamVisit {
  date: string; // YYYY-MM-DD
  weekday: Weekday;
  /** "first": the sweep about four weeks out; "final": the show week (a day moved off a holiday is a week earlier). */
  pass: StreetTeamPass;
  /** "HH:MM" local. Inside the partner's open hours whenever they are listed for that day. */
  start: string;
  end: string;
  /** The stop's area tile, when it is on the sheet. Null for a partner near the venue (no top tiles at all). */
  tile: LiftTile | null;
  /** 1-based rank of the tile among the top tiles; null outside them. */
  tileRank: number | null;
  /** The partner this stop is for; null for an area flyer drop. */
  partner: Partner | null;
  /** [partner] for a stop, [] for a flyer drop. */
  partners: Partner[];
  /** The partner's hours that day as listed; null when not listed (and on a flyer drop). */
  hours: string | null;
  /** True when the partner's hours that day are not listed: call before going. */
  callFirst: boolean;
  /**
   * Partners left off the calendar because they are listed closed on every street-team day of the pass. Set on
   * their area's earliest event of that pass (its flyer drop, or its first stop); when the pass times no stop there,
   * on the event that lists the area's stops with no time left, else on the earliest event of the area's day (else
   * of the pass, else a `StreetTeamNote`); [] elsewhere.
   */
  closedAllDays: Partner[];
  /**
   * Stops of this day the route has no time left for, on no other street-team day of the pass either (a partner, or
   * an area's flyer drop). They are never put on top of another stop: the day's earliest event lists them, to arrange
   * by phone (a day with no timed event gets a `StreetTeamNote` instead). Set on that event only; [] elsewhere.
   */
  notTimed: NotTimedStop[];
}

/**
 * A street-team day of a pass that has no timed stop, but stops with no time left (or partners closed on every
 * street-team day) to say: the calendar gives it one all-day event that lists them, so nothing is dropped unsaid.
 */
export interface StreetTeamNote {
  date: string;
  weekday: Weekday;
  pass: StreetTeamPass;
  notTimed: NotTimedStop[];
  closedAllDays: Partner[];
}

/** The street-team calendar's plan: the timed stops, and the days that only have something to say (`StreetTeamNote`). */
export interface StreetTeamPlan {
  visits: StreetTeamVisit[];
  notes: StreetTeamNote[];
}

/** A stop the day's route has no time left for (`StreetTeamVisit.notTimed`). */
export interface NotTimedStop {
  /** The street-team day it was planned for. */
  date: string;
  weekday: Weekday;
  /** The partner; null for an area's flyer drop. */
  partner: Partner | null;
  tile: LiftTile | null;
  tileRank: number | null;
  /** The partner's hours that day as listed; null when not listed (and on a flyer drop). */
  hours: string | null;
  callFirst: boolean;
}

// ---------------------------------------------------------------------------
// Text, folding and dates
// ---------------------------------------------------------------------------

/** RFC 5545 TEXT escaping. Control characters other than newlines are dropped. */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\r\n|\r|\n/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

const encoder = new TextEncoder();

/**
 * Folds one content line so that no physical line exceeds 75 octets (excluding
 * CRLF). Continuation lines begin with a single space. Never splits a UTF-8
 * multi-octet character.
 */
export function foldLine(line: string, limit = 75): string {
  if (encoder.encode(line).length <= limit) return line;
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  let max = limit;
  for (const ch of line) {
    const b = encoder.encode(ch).length;
    if (curBytes + b > max) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
      max = limit - 1; // the leading space counts
    }
    cur += ch;
    curBytes += b;
  }
  parts.push(cur);
  return parts.join(`${ICS_EOL} `);
}

function parseHm(hm: string | undefined, fallback: number): number {
  if (!hm) return fallback;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(hm.trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return h * 60 + mi;
}

function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "2026-11-26" + "10:00" -> "20261126T100000" (local, no zone). */
export function icsLocal(date: string, time: string): string {
  return `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
}

/** An ISO instant as UTC basic format, "20261017T143000Z". */
export function icsUtc(iso: string): string {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? new Date(0) : d;
  return t.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

function uidSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-");
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

interface ZoneRule {
  std: { offsetMin: number; name: string };
  dst?: { offsetMin: number; name: string };
}

/** US zones with the post-2007 DST rule (second Sunday of March to first Sunday of November, 02:00). */
export const SUPPORTED_TIME_ZONES: Readonly<Record<string, ZoneRule>> = {
  "America/New_York": { std: { offsetMin: -300, name: "EST" }, dst: { offsetMin: -240, name: "EDT" } },
  "America/Detroit": { std: { offsetMin: -300, name: "EST" }, dst: { offsetMin: -240, name: "EDT" } },
  "America/Chicago": { std: { offsetMin: -360, name: "CST" }, dst: { offsetMin: -300, name: "CDT" } },
  "America/Denver": { std: { offsetMin: -420, name: "MST" }, dst: { offsetMin: -360, name: "MDT" } },
  "America/Phoenix": { std: { offsetMin: -420, name: "MST" } },
  "America/Los_Angeles": { std: { offsetMin: -480, name: "PST" }, dst: { offsetMin: -420, name: "PDT" } },
  "America/Anchorage": { std: { offsetMin: -540, name: "AKST" }, dst: { offsetMin: -480, name: "AKDT" } },
  "Pacific/Honolulu": { std: { offsetMin: -600, name: "HST" } },
};

function offsetText(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`;
}

export function vtimezoneLines(tzid: string): string[] {
  const rule = SUPPORTED_TIME_ZONES[tzid];
  if (!rule) return [];
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  if (!rule.dst) {
    lines.push(
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      `TZOFFSETFROM:${offsetText(rule.std.offsetMin)}`,
      `TZOFFSETTO:${offsetText(rule.std.offsetMin)}`,
      `TZNAME:${rule.std.name}`,
      "END:STANDARD",
    );
  } else {
    lines.push(
      "BEGIN:DAYLIGHT",
      "DTSTART:20070311T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      `TZOFFSETFROM:${offsetText(rule.std.offsetMin)}`,
      `TZOFFSETTO:${offsetText(rule.dst.offsetMin)}`,
      `TZNAME:${rule.dst.name}`,
      "END:DAYLIGHT",
      "BEGIN:STANDARD",
      "DTSTART:20071104T020000",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      `TZOFFSETFROM:${offsetText(rule.dst.offsetMin)}`,
      `TZOFFSETTO:${offsetText(rule.std.offsetMin)}`,
      `TZNAME:${rule.std.name}`,
      "END:STANDARD",
    );
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

// ---------------------------------------------------------------------------
// The plan: which stops on which day
// ---------------------------------------------------------------------------

/** Fixed-date days with no street team: shops keep holiday hours then, not the week's listed hours. */
const BLACKOUT_DAYS: Readonly<Record<string, string>> = {
  "12-24": "Christmas Eve",
  "12-25": "Christmas Day",
  "12-31": "New Year's Eve",
  "01-01": "New Year's Day",
  "07-04": "Independence Day",
};

/**
 * The holiday a street-team date falls on, or null: Christmas Eve and Day, New Year's Eve and Day, Independence Day,
 * and Thanksgiving (the fourth Thursday of November). The calendar sends no one out on these days.
 */
export function streetTeamBlackout(date: string): string | null {
  if (!isYmd(date)) return null;
  const named = BLACKOUT_DAYS[date.slice(5)];
  if (named) return named;
  const day = Number(date.slice(8, 10));
  return date.slice(5, 7) === "11" && day >= 22 && day <= 28 && weekdayOfYmd(date) === "thursday" ? "Thanksgiving" : null;
}

export function isStreetTeamBlackout(date: string): boolean {
  return streetTeamBlackout(date) !== null;
}

/**
 * The street-team days in one week before the show: week 0 is the 7 days right before it, week 1 the 7 before those.
 * Holidays (`streetTeamBlackout`) are left out unless `withHolidays`.
 */
function weekDates(showDate: string, wanted: readonly Weekday[], w: number, withHolidays = false): { date: string; weekday: Weekday }[] {
  const out: { date: string; weekday: Weekday }[] = [];
  for (let k = 1; k <= 7; k++) {
    const date = addDaysYmd(showDate, -(k + 7 * w));
    const weekday = weekdayOfYmd(date);
    if (wanted.includes(weekday) && (withHolidays || !isStreetTeamBlackout(date))) out.push({ date, weekday });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Street-team dates: for each requested weekday, its last occurrence in the 7
 * days before the show, repeated for `weeks` weeks. Sorted ascending, each with
 * its week index (0 = the week right before the show).
 */
export function streetTeamDates(
  showDate: string,
  days: readonly Weekday[],
  opts: { weeks?: number; notBefore?: string } = {},
): { date: string; weekday: Weekday; week: number }[] {
  if (!isYmd(showDate)) return [];
  const weeks = Math.min(8, Math.max(1, Math.floor(opts.weeks ?? 1)));
  const wanted = WEEKDAYS.filter((d) => days.includes(d));
  const out: { date: string; weekday: Weekday; week: number }[] = [];
  for (let w = 0; w < weeks; w++) {
    for (const d of weekDates(showDate, wanted, w)) {
      if (opts.notBefore && isYmd(opts.notBefore) && d.date < opts.notBefore) continue;
      out.push({ ...d, week: w });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export type StreetTeamPass = "first" | "final";

/** Default weeks before the show for the first pass: the street-team days 22 to 28 days out. */
export const FIRST_PASS_WEEKS_OUT = 4;

/** How far a holiday's stops may move on the same weekday: one week earlier, else two (else another day of its week). */
const HOLIDAY_MOVE_WEEKS = 2;

/** One street-team day of a pass. */
export interface StreetTeamPassDate {
  date: string;
  weekday: Weekday;
  pass: StreetTeamPass;
  /**
   * Set when this day stands in for a holiday of the pass: the same weekday a week or two before it, else another
   * day of the holiday's week (then `weekday` is that day's own).
   */
  insteadOf?: { date: string; holiday: string };
}

/** A holiday in a pass's week, and the day its stops moved to (null: no day was free, so the pass is a day short). */
export interface StreetTeamHoliday {
  date: string;
  weekday: Weekday;
  pass: StreetTeamPass;
  holiday: string;
  movedTo: string | null;
}

/**
 * Both passes, and the holidays in their weeks. A holiday moves to the same weekday a week earlier (two weeks when
 * that one is a holiday too), never before `notBefore` and, in the final pass, never onto or before the first pass's
 * days. With no such day it moves to the nearest free day of its own week (earlier first; not a holiday, not
 * another street-team day of the pass, same limits), so the pass keeps its number of days and no day holds two
 * days' stops. Only when the whole week is taken does the final pass go a day short; a first pass that would moves a
 * week closer (or there is only the final pass).
 */
function planPasses(
  showDate: string,
  days: readonly Weekday[],
  opts: { notBefore?: string; firstPassWeeksOut?: number },
): { dates: StreetTeamPassDate[]; holidays: StreetTeamHoliday[] } {
  const none = { dates: [], holidays: [] };
  if (!isYmd(showDate)) return none;
  const wanted = WEEKDAYS.filter((d) => days.includes(d));
  if (wanted.length === 0) return none;
  const notBefore = opts.notBefore && isYmd(opts.notBefore) ? opts.notBefore : null;
  const ok = (date: string) => notBefore === null || date >= notBefore;
  const byDate = (a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  // `w`: the week the pass stands for (0 = the 7 days right before the show).
  const resolve = (week: readonly { date: string; weekday: Weekday }[], pass: StreetTeamPass, after: string | null, w: number) => {
    const dates: StreetTeamPassDate[] = [];
    const holidays: StreetTeamHoliday[] = [];
    const weekStart = addDaysYmd(showDate, -(7 + 7 * w));
    const weekEnd = addDaysYmd(showDate, -(1 + 7 * w));
    const free = (alt: string) =>
      !isStreetTeamBlackout(alt) && ok(alt) && (after === null || alt > after) && !week.some((x) => x.date === alt) && !dates.some((x) => x.date === alt);
    for (const d of week) {
      const holiday = streetTeamBlackout(d.date);
      if (!holiday) {
        dates.push({ ...d, pass });
        continue;
      }
      let movedTo: { date: string; weekday: Weekday } | null = null;
      for (let j = 1; j <= HOLIDAY_MOVE_WEEKS && movedTo === null; j++) {
        const alt = addDaysYmd(d.date, -7 * j);
        if (free(alt)) movedTo = { date: alt, weekday: d.weekday };
      }
      // No free day on that weekday: the nearest other day of the same week, earlier first, with that day's own
      // weekday (and hours), so the pass keeps its number of days instead of piling its stops on the days left.
      for (let k = 1; k <= 6 && movedTo === null; k++) {
        for (const alt of [addDaysYmd(d.date, -k), addDaysYmd(d.date, k)]) {
          if (movedTo === null && alt >= weekStart && alt <= weekEnd && free(alt)) movedTo = { date: alt, weekday: weekdayOfYmd(alt) };
        }
      }
      if (movedTo) dates.push({ ...movedTo, pass, insteadOf: { date: d.date, holiday } });
      holidays.push({ ...d, pass, holiday, movedTo: movedTo?.date ?? null });
    }
    return { dates: dates.sort(byDate), holidays };
  };
  const out: StreetTeamPassDate[] = [];
  const holidays: StreetTeamHoliday[] = [];
  const weeksOut = Math.min(8, Math.max(0, Math.floor(opts.firstPassWeeksOut ?? FIRST_PASS_WEEKS_OUT)));
  for (let w = weeksOut - 1; w >= 1; w--) {
    const week = weekDates(showDate, wanted, w, true);
    if (week.length === 0 || !week.every((d) => ok(d.date))) continue;
    const first = resolve(week, "first", null, w);
    // A first pass keeps every one of its days or moves a week closer: a short one would pile two days' stops onto one.
    if (first.dates.length < week.length) continue;
    out.push(...first.dates);
    holidays.push(...first.holidays);
    break;
  }
  const lastFirst = out.length > 0 ? out[out.length - 1]!.date : null;
  const final = resolve(
    weekDates(showDate, wanted, 0, true).filter((d) => ok(d.date)),
    "final",
    lastFirst,
    0,
  );
  out.push(...final.dates);
  holidays.push(...final.holidays);
  return { dates: out, holidays };
}

/**
 * The street-team passes: a first pass about four weeks out (the street-team days 22 to 28 days before the show)
 * and a final pass in the show week (the 7 days before it). A first-pass week that starts before `notBefore` (the
 * plan's creation date) moves one week closer at a time, down to 8-14 days out; when no whole week fits, there is
 * only the final pass, without its dates before `notBefore`. `firstPassWeeksOut` 0 or 1 gives the final pass only.
 * No one goes out on a holiday (`streetTeamBlackout`: Christmas Eve): its stops move to the same weekday a week
 * earlier (`insteadOf` says so), so a pass keeps its days and a partner its weekday. When that day is not free
 * (before the plan was made, or onto the first pass) they move to the nearest free day of the holiday's own week,
 * with that day's weekday. Each pass is in date order.
 */
export function streetTeamPasses(
  showDate: string,
  days: readonly Weekday[],
  opts: { notBefore?: string; firstPassWeeksOut?: number } = {},
): StreetTeamPassDate[] {
  return planPasses(showDate, days, opts).dates;
}

/**
 * The holidays in the weeks `streetTeamPasses` uses (the final pass's week, and the first pass's when there is one),
 * not before `notBefore`, with the day each one's stops moved to, so the calendar can say where they went.
 */
export function streetTeamHolidays(
  showDate: string,
  days: readonly Weekday[],
  opts: { notBefore?: string; firstPassWeeksOut?: number } = {},
): StreetTeamHoliday[] {
  return planPasses(showDate, days, opts).holidays;
}

/** The pass options `planStreetTeamVisits` and `toIcs` share: the days, the earliest date and the first pass's weeks out. */
function passOptions(sheet: StreetSheet, opts: IcsOptions): { days: readonly Weekday[]; notBefore: string | undefined; firstPassWeeksOut: number | undefined } {
  const days = opts.streetTeamDays ?? sheet.operator.streetTeamDays ?? [];
  const created = new Date(sheet.createdAt);
  const notBefore = opts.notBefore ?? (Number.isNaN(created.getTime()) ? undefined : ymdOf(created));
  return { days, notBefore: notBefore || undefined, firstPassWeeksOut: opts.firstPassWeeksOut };
}

interface Point {
  lat: number;
  lon: number;
}

/** A group of stops kept on one day: a numbered area with its partners, or partners outside them sharing a tile. */
interface Group {
  slot: number;
  tile: LiftTile | null;
  rank: number | null;
  partners: Partner[];
  /** A numbered area: it gets one flyer drop when no partner there is visited. */
  area: boolean;
  pos: Point | null;
}

interface Item {
  slot: number;
  order: number;
  tile: LiftTile | null;
  rank: number | null;
  partner: Partner | null;
  hours: DayHours | null;
  /** Allowed [start, end) minute ranges for the stop. */
  windows: [number, number][];
  minutes: number;
  pos: Point | null;
}

const LAST_MINUTE = 23 * 60 + 59;
/** How long the street team waits for a nearer stop rather than taking the one that can start soonest. */
const STAY_MINUTES = 45;
/** Minutes of travel per km between stops (about 30 km/h across town), rounded up to 5 minutes. */
const TRAVEL_MIN_PER_KM = 2;

function point(lat: unknown, lon: unknown): Point | null {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

function kmApart(a: Point | null, b: Point | null): number | null {
  if (!a || !b) return null;
  return haversineM(a, b) / 1000;
}

/** The partner's own map point, else its tile's centre. */
function partnerPoint(p: Partner, tiles: ReadonlyMap<string, LiftTile>): Point | null {
  const own = point(p.entity.location?.lat, p.entity.location?.lon);
  if (own) return own;
  const t = p.tileGeohash ? tiles.get(p.tileGeohash) : undefined;
  return t ? point(t.lat, t.lon) : null;
}

/** Nearest-neighbour order from `start`; items without a point keep their order at the end. */
function nearestOrder<T>(items: readonly T[], pointOf: (t: T) => Point | null, start: Point | null): T[] {
  const left = items.map((it, i) => ({ it, i, p: pointOf(it) }));
  const placed = left.filter((x) => x.p !== null);
  const rest = left.filter((x) => x.p === null);
  const out: T[] = [];
  let at = start ?? placed[0]?.p ?? null;
  while (placed.length > 0) {
    let best = 0;
    let bestKm = Number.POSITIVE_INFINITY;
    placed.forEach((x, k) => {
      const d = kmApart(at, x.p) ?? 0;
      if (d < bestKm - 1e-9 || (Math.abs(d - bestKm) <= 1e-9 && x.i < placed[best]!.i)) {
        best = k;
        bestKm = d;
      }
    });
    const [next] = placed.splice(best, 1);
    out.push(next!.it);
    at = next!.p;
  }
  return [...out, ...rest.map((x) => x.it)];
}

/**
 * The groups of stops: each numbered area (in area order) with its partners, then the partners outside the numbered
 * areas grouped by their own tile (a partner without a tile is a group of its own).
 */
function stopGroups(sheet: StreetSheet, tiles: readonly LiftTile[], allTiles: ReadonlyMap<string, LiftTile>): Group[] {
  const partners = sheet.cards.partners.results;
  const groups: Group[] = tiles.map((t, i) => ({
    slot: i,
    tile: t,
    rank: i + 1,
    partners: partners.filter((p) => p.tileGeohash === t.geohash),
    area: true,
    pos: point(t.lat, t.lon),
  }));
  const top = new Set(tiles.map((t) => t.geohash));
  const byKey = new Map<string, Partner[]>();
  for (const p of partners) {
    if (p.tileGeohash && top.has(p.tileGeohash)) continue;
    const key = p.tileGeohash ? `t:${p.tileGeohash}` : `p:${p.entity.entityId}`;
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }
  for (const [key, ps] of byKey) {
    const tile = key.startsWith("t:") ? (allTiles.get(key.slice(2)) ?? null) : null;
    const pts = ps.map((p) => partnerPoint(p, allTiles)).filter((x): x is Point => x !== null);
    const mean = pts.length > 0 ? { lat: pts.reduce((a, b) => a + b.lat, 0) / pts.length, lon: pts.reduce((a, b) => a + b.lon, 0) / pts.length } : null;
    groups.push({ slot: groups.length, tile, rank: null, partners: ps, area: false, pos: (tile ? point(tile.lat, tile.lon) : null) ?? mean });
  }
  return groups;
}

/**
 * Cuts the groups (in route order) into `n` runs, run k for day k: where the route jumps furthest (so a day covers
 * one part of town), keeping each day between half and one and a half times its fair share of stops (a single
 * group larger than that is a run of its own). Ties: the more even split. Falls back to even runs when no cut fits.
 */
function splitRoute(route: readonly Group[], n: number): Map<number, number> {
  const weight = (g: Group) => Math.max(1, g.partners.length);
  const w = route.map(weight);
  const total = w.reduce((a, b) => a + b, 0);
  const ideal = total / Math.max(1, n);
  const out = new Map<number, number>();
  // Even runs: each group goes to the day its middle stop falls in.
  let before = 0;
  route.forEach((g, i) => {
    out.set(g.slot, Math.min(n - 1, Math.floor(((before + w[i]! / 2) * n) / Math.max(1, total))));
    before += w[i]!;
  });
  if (n <= 1 || route.length <= n) return route.length <= n ? new Map(route.map((g, i) => [g.slot, i])) : out;
  const gaps = route.slice(1).map((g, i) => kmApart(route[i]!.pos, g.pos) ?? 0);
  const fits = (from: number, to: number) => {
    const sum = w.slice(from, to).reduce((a, b) => a + b, 0);
    return to - from === 1 || (sum >= ideal * 0.5 && sum <= ideal * 1.5);
  };
  let best: { cuts: number[]; gap: number; spread: number } | null = null;
  let budget = 20_000;
  const search = (from: number, left: number, cuts: number[]) => {
    if (budget-- <= 0) return;
    if (left === 0) {
      if (!fits(from, route.length)) return;
      const bounds = [0, ...cuts, route.length];
      const gap = cuts.reduce((a, c) => a + gaps[c - 1]!, 0);
      const spread = bounds.slice(1).reduce((a, b, k) => a + Math.abs(w.slice(bounds[k]!, b).reduce((x, y) => x + y, 0) - ideal), 0);
      if (!best || gap > best.gap + 1e-9 || (Math.abs(gap - best.gap) <= 1e-9 && spread < best.spread)) best = { cuts: [...cuts], gap, spread };
      return;
    }
    for (let c = from + 1; c <= route.length - left; c++) if (fits(from, c)) search(c, left - 1, [...cuts, c]);
  };
  search(0, n - 1, []);
  const found = best as { cuts: number[] } | null;
  if (!found || budget <= 0) return out;
  let day = 0;
  route.forEach((g, i) => {
    while (day < found.cuts.length && i >= found.cuts[day]!) day += 1;
    out.set(g.slot, day);
  });
  return out;
}

/** Earliest start at or after `cursor` where the item fits whole inside one of its windows, or null. */
function earliestFit(it: Item, cursor: number): number | null {
  for (const [a, b] of it.windows) {
    const t = Math.max(a, cursor);
    if (t + it.minutes <= b) return t;
  }
  return null;
}

function hoursKnown(h: DayHours | null | undefined): boolean {
  return !!h && h.status === "open" && h.ranges.length > 0;
}

function travelMinutes(from: Point | null, to: Point | null, gapMin: number): number {
  const km = kmApart(from, to);
  if (km === null) return gapMin;
  return Math.max(gapMin, Math.ceil((km * TRAVEL_MIN_PER_KM) / 5) * 5);
}

type Timed = { it: Item; t: number; end: number };

/**
 * Puts `it` in a free stretch between two of the day's stops (or before the first), travel included both ways and
 * inside its own hours. False when no stretch is long enough.
 */
function fitBetween(placed: Timed[], it: Item, dayStart: number, gapMin: number): boolean {
  const sorted = [...placed].sort((a, b) => a.t - b.t);
  for (let i = 0; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i]!;
    const t = earliestFit(it, prev ? prev.end + travelMinutes(prev.it.pos, it.pos, gapMin) : dayStart);
    if (t === null || t + it.minutes + travelMinutes(it.pos, next.it.pos, gapMin) > next.t) continue;
    placed.push({ it, t, end: t + it.minutes });
    return true;
  }
  return false;
}

/**
 * One day's stops in order. The day starts at the venue at `start` (earlier when a stop is open only before then).
 * Each step takes, among the stops that can start within 45 minutes of the soonest one (travel included), a stop in
 * the same area when there is one, else the nearest: a nearest-neighbour walk that keeps an area together and never
 * puts a stop outside its listed hours. A stop that can't fit after the others goes in a free stretch between two
 * stops when one is long enough, travel included; otherwise it is `unplaced` (never timed on top of another stop).
 * Nothing runs past 23:59.
 */
function scheduleDay(items: readonly Item[], start: number, gapMin: number, venue: Point | null): { placed: Timed[]; unplaced: Item[] } {
  const left = [...items];
  const placed: Timed[] = [];
  const early = left.filter((it) => earliestFit(it, start) === null && earliestFit(it, 0) !== null).map((it) => earliestFit(it, 0)!);
  const dayStart = Math.min(start, ...early);
  let cursor = dayStart;
  let at = venue;
  let lastSlot = -1;
  let first = true;
  const deadline = (it: Item) => Math.max(...it.windows.map((win) => win[1]));
  while (left.length > 0) {
    const fits = left
      .map((it) => ({ it, t: earliestFit(it, cursor + (first ? 0 : travelMinutes(at, it.pos, gapMin))), km: kmApart(at, it.pos) ?? Number.POSITIVE_INFINITY }))
      .filter((x): x is { it: Item; t: number; km: number } => x.t !== null);
    if (fits.length === 0) {
      // No room after the others: a free stretch between two stops, the closing-soonest stop first; else unplaced.
      const unplaced: Item[] = [];
      for (const it of [...left].sort((x, y) => deadline(x) - deadline(y) || x.slot - y.slot || x.order - y.order)) {
        if (!fitBetween(placed, it, dayStart, gapMin)) unplaced.push(it);
      }
      return { placed, unplaced };
    }
    const soonest = Math.min(...fits.map((f) => f.t));
    const near = fits.filter((f) => f.t <= soonest + STAY_MINUTES);
    const same = near.filter((f) => f.it.slot === lastSlot);
    const pool = (same.length > 0 ? same : near).sort(
      (x, y) => x.km - y.km || x.t - y.t || deadline(x.it) - deadline(y.it) || x.it.slot - y.it.slot || x.it.order - y.it.order,
    );
    // Never take a stop that leaves another one no time inside its hours: that one goes first.
    const strands = (f: { it: Item; t: number }): boolean => {
      const end = f.t + f.it.minutes;
      return fits.some((o) => o.it !== f.it && earliestFit(o.it, end + travelMinutes(f.it.pos ?? at, o.it.pos, gapMin)) === null);
    };
    const pick =
      pool.find((f) => !strands(f)) ??
      [...fits].sort((x, y) => deadline(x.it) - deadline(y.it) || x.t - y.t || x.km - y.km || x.it.slot - y.it.slot || x.it.order - y.it.order)[0]!;
    const end = Math.min(LAST_MINUTE, pick.t + pick.it.minutes);
    placed.push({ it: pick.it, t: pick.t, end });
    left.splice(left.indexOf(pick.it), 1);
    cursor = end;
    at = pick.it.pos ?? at;
    lastSlot = pick.it.slot;
    first = false;
  }
  return { placed, unplaced: [] };
}

/**
 * Street-team stops by day, in two passes: a first pass about four weeks out (every partner and a flyer drop in
 * each numbered area with no partner to visit) and a final pass in the show week (the same stops again, shorter:
 * restock flyers, check the poster). See `streetTeamPasses` for the dates.
 *
 * Days: the groups (each numbered area with its partners; partners outside them grouped by their own tile) are put
 * in nearest-neighbour order from the venue and cut into runs of about the same number of stops, one run per
 * street-team day of the pass, so each day covers one part of town and an area's partners share a day. An area
 * moves to another street-team day when more of its partners are open then and both days stay between half and one
 * and a half times their share of stops.
 *
 * Partners: each is visited on its area's day when it is open then, else on another street-team day of that pass
 * when it is open, else on the first of those days its hours aren't listed ("call first"). A partner listed closed
 * on every street-team day is not visited; its area's earliest event of the pass says so (see
 * `StreetTeamVisit.closedAllDays` for an area the pass times no stop in). A numbered area with no partner visited
 * gets one flyer drop on its day.
 *
 * Times: see `scheduleDay`. Hours are read for the day of the stop from the place's own week of hours
 * (`properties.hours`), so a Saturday stop is timed and labelled with Saturday's hours. A stop its day has no time
 * left for (travel included) moves to another street-team day of the pass where it fits whole inside that day's
 * hours (a partner the first pass moves keeps that weekday in the final pass); with no such day it is not timed
 * at all, and the day's earliest event lists it (`notTimed`; a day with no timed event gets a `StreetTeamNote`), so
 * no two stops ever overlap and nothing is dropped unsaid.
 */
export function planStreetTeam(sheet: StreetSheet, opts: IcsOptions = {}): StreetTeamPlan {
  const none: StreetTeamPlan = { visits: [], notes: [] };
  const { days, notBefore, firstPassWeeksOut } = passOptions(sheet, opts);
  const dates = streetTeamPasses(sheet.bill.date, days, { notBefore, firstPassWeeksOut });
  if (dates.length === 0) return none;

  const tiles = topTiles(sheet, opts);
  const allTiles = new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  const groups = stopGroups(sheet, tiles, allTiles);
  if (groups.length === 0) return none;
  const venue = point(sheet.bill.venue.lat, sheet.bill.venue.lon);
  const route = nearestOrder(groups, (g) => g.pos, venue);

  const listedDay = hoursWeekday(sheet);
  const start = Math.min(LAST_MINUTE - 15, parseHm(opts.startTime, 10 * 60));
  const flyerMin = Math.max(15, Math.floor(opts.visitMinutes ?? 90));
  const stopMin = Math.max(5, Math.floor(opts.stopMinutes ?? 20));
  const twoPasses = dates.some((d) => d.pass === "first");
  const finalMin = twoPasses ? Math.max(5, Math.floor(opts.finalPassMinutes ?? 10)) : stopMin;
  const gapMin = Math.max(0, Math.floor(opts.gapMinutes ?? 15));
  const wide: [number, number][] = [[start, LAST_MINUTE]];

  type Placed = StreetTeamVisit & { slot: number };
  const visits: Placed[] = [];
  const untimed: { date: string; weekday: Weekday; pass: StreetTeamPass; items: Item[] }[] = [];
  // Partners closed on every street-team day of a pass, by group, with the group's day.
  const closedBy: { pass: StreetTeamPass; slot: number; date: string; weekday: Weekday; partners: Partner[] }[] = [];
  // A partner the first pass moved to another day (its own day had no time left) keeps that weekday in the final pass.
  const movedTo = new Map<string, Weekday>();
  for (const pass of ["first", "final"] as const) {
    // In the order of the week the pass stands for: a day moved off a holiday keeps the holiday's place, so day k is
    // the same weekday in both passes and a partner keeps its weekday (and that day's hours).
    const slot = (d: StreetTeamPassDate) => d.insteadOf?.date ?? d.date;
    const passDates = dates.filter((d) => d.pass === pass).sort((a, b) => (slot(a) < slot(b) ? -1 : slot(a) > slot(b) ? 1 : 0));
    const n = passDates.length;
    if (n === 0) continue;
    const minutes = pass === "final" ? finalMin : stopMin;
    const runs = splitRoute(route, n);
    // Stops per day after the cut, weighed as splitRoute weighs them (an area with no partner counts one: its flyer
    // drop). An area moves to another day only when both days stay inside the cut's band.
    const stopsOf = (g: Group) => Math.max(1, g.partners.length);
    const share = route.reduce((a, g) => a + stopsOf(g), 0) / n;
    const load = Array.from({ length: n }, () => 0);
    for (const g of route) load[runs.get(g.slot) ?? 0]! += stopsOf(g);
    const dayItems: Item[][] = passDates.map(() => []);
    // The same stop on the pass's other street-team days, nearest day first: where it goes when its own day has no
    // time left for it.
    const elsewhere = new Map<Item, { k: number; it: Item }[]>();
    for (const g of route) {
      const hours = g.partners.map((p) => passDates.map((d) => partnerHoursOn(p, d.weekday, listedDay)));
      // The run's day, unless more of the area's partners are open on another street-team day and both days stay
      // between half and one and a half times their share of stops.
      const openOn = (k: number) => hours.filter((h) => hoursKnown(h[k])).length;
      const run = runs.get(g.slot) ?? 0;
      let home = run;
      const inBand = (k: number) => load[k]! + stopsOf(g) <= share * 1.5 && load[run]! - stopsOf(g) >= share * 0.5;
      for (let k = 0; k < n; k++) if (k !== run && openOn(k) > openOn(home) && inBand(k)) home = k;
      if (home !== run) {
        load[run]! -= stopsOf(g);
        load[home]! += stopsOf(g);
      }
      const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => Math.abs(a - home) - Math.abs(b - home) || a - b);
      const visited: Item[] = [];
      const closed: Partner[] = [];
      g.partners.forEach((p, pi) => {
        const hs = hours[pi]!;
        const listed = order.filter((k) => hoursKnown(hs[k]));
        // Open with listed hours, else the first day its hours aren't listed (call first).
        const open = listed.length > 0 ? listed : order.filter((k) => hs[k]!.status !== "closed");
        const moved = movedTo.get(p.entity.entityId);
        const can = [...open.filter((k) => passDates[k]!.weekday === moved), ...open.filter((k) => passDates[k]!.weekday !== moved)];
        if (can.length === 0) {
          closed.push(p);
          return;
        }
        const itemOn = (k: number): Item => {
          const h = hs[k]!;
          const windows = hoursKnown(h) ? h.ranges.map(([a, b]) => [a, Math.min(b, LAST_MINUTE)] as [number, number]).filter(([a, b]) => b > a) : [];
          const win = windows.length > 0 ? windows : wide;
          // Cut short only when the place is open for less than a whole stop and closes (never by the day's end, 23:59).
          const [la, lb] = win.reduce((best, w) => (w[1] - w[0] > best[1] - best[0] ? w : best), win[0]!);
          const short = windows.length > 0 && lb - la < minutes && lb < LAST_MINUTE ? Math.max(1, lb - la) : null;
          return {
            slot: g.slot,
            order: pi,
            tile: p.tileGeohash ? (allTiles.get(p.tileGeohash) ?? null) : null,
            rank: g.rank,
            partner: p,
            hours: h,
            windows: win,
            minutes: short ?? minutes,
            pos: partnerPoint(p, allTiles) ?? g.pos,
          };
        };
        const [pick, ...rest] = can;
        const it = itemOn(pick!);
        visited.push(it);
        dayItems[pick!]!.push(it);
        elsewhere.set(
          it,
          rest.map((k) => ({ k, it: itemOn(k) })),
        );
      });
      if (g.area && visited.length === 0) {
        const flyers = (): Item => ({ slot: g.slot, order: -1, tile: g.tile, rank: g.rank, partner: null, hours: null, windows: wide, minutes: flyerMin, pos: g.pos });
        const it = flyers();
        dayItems[home]!.push(it);
        elsewhere.set(
          it,
          order.filter((k) => k !== home).map((k) => ({ k, it: flyers() })),
        );
      }
      if (closed.length > 0) closedBy.push({ pass, slot: g.slot, date: passDates[home]!.date, weekday: passDates[home]!.weekday, partners: closed });
    }
    const sched = dayItems.map((items) => scheduleDay(items, start, gapMin, venue));
    // A stop its own day has no time left for goes to another street-team day of the pass where it fits whole, inside
    // that day's hours, without leaving out a stop that day already had time for.
    for (let k = 0; k < n; k++) {
      for (const it of [...sched[k]!.unplaced]) {
        for (const alt of elsewhere.get(it) ?? []) {
          const trial = scheduleDay([...dayItems[alt.k]!, alt.it], start, gapMin, venue);
          if (trial.unplaced.some((x) => x === alt.it || !sched[alt.k]!.unplaced.includes(x))) continue;
          dayItems[alt.k]!.push(alt.it);
          if (it.partner && pass === "first") movedTo.set(it.partner.entity.entityId, passDates[alt.k]!.weekday);
          sched[alt.k] = trial;
          dayItems[k] = dayItems[k]!.filter((x) => x !== it);
          sched[k] = { placed: sched[k]!.placed, unplaced: sched[k]!.unplaced.filter((x) => x !== it) };
          break;
        }
      }
    }
    passDates.forEach((d, k) => {
      for (const { it, t, end } of sched[k]!.placed) {
        visits.push({
          date: d.date,
          weekday: d.weekday,
          pass,
          start: hm(t),
          end: hm(Math.min(LAST_MINUTE, Math.max(t + 1, end))),
          tile: it.tile,
          tileRank: it.rank,
          partner: it.partner,
          partners: it.partner ? [it.partner] : [],
          hours: dayHoursOf(it),
          callFirst: it.partner !== null && !hoursKnown(it.hours),
          closedAllDays: [],
          notTimed: [],
          slot: it.slot,
        });
      }
      const left = sched[k]!.unplaced;
      if (left.length > 0) untimed.push({ date: d.date, weekday: d.weekday, pass, items: left });
    });
  }
  visits.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.start < b.start ? -1 : a.start > b.start ? 1 : a.slot - b.slot));
  // What a pass could not time is said once, never dropped and never timed on top of another stop. A stop with no
  // time left goes on its day's earliest event; a day with no timed event gets a note of its own.
  const notes: StreetTeamNote[] = [];
  const noteOn = (date: string, weekday: Weekday, pass: StreetTeamPass): StreetTeamNote => {
    let n = notes.find((x) => x.date === date);
    if (!n) {
      n = { date, weekday, pass, notTimed: [], closedAllDays: [] };
      notes.push(n);
    }
    return n;
  };
  type Host = { notTimed: NotTimedStop[]; closedAllDays: Partner[] };
  const untimedHost = new Map<string, Host>();
  for (const u of untimed) {
    const host: Host = visits.find((v) => v.date === u.date) ?? noteOn(u.date, u.weekday, u.pass);
    for (const it of u.items) {
      host.notTimed.push({ date: u.date, weekday: u.weekday, partner: it.partner, tile: it.tile, tileRank: it.rank, hours: dayHoursOf(it), callFirst: it.partner !== null && !hoursKnown(it.hours) });
      const key = `${u.pass}-${it.slot}`;
      if (!untimedHost.has(key)) untimedHost.set(key, host);
    }
  }
  // Partners closed on every street-team day: on their area's earliest event of the pass, else with the area's stops
  // with no time left, else on the earliest event of the area's day, else of the pass, else in a note on that day.
  for (const c of closedBy) {
    const host: Host =
      visits.find((v) => v.pass === c.pass && v.slot === c.slot) ??
      untimedHost.get(`${c.pass}-${c.slot}`) ??
      visits.find((v) => v.date === c.date) ??
      visits.find((v) => v.pass === c.pass) ??
      noteOn(c.date, c.weekday, c.pass);
    for (const p of c.partners) if (!host.closedAllDays.includes(p)) host.closedAllDays.push(p);
  }
  notes.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { visits: visits.map(({ slot: _slot, ...v }) => v), notes };
}

/** The timed street-team stops (`planStreetTeam` without its notes). */
export function planStreetTeamVisits(sheet: StreetSheet, opts: IcsOptions = {}): StreetTeamVisit[] {
  return planStreetTeam(sheet, opts).visits;
}

/** A stop's hours that day as listed, or null when not listed (and on a flyer drop). */
function dayHoursOf(it: Item): string | null {
  return hoursKnown(it.hours) || it.hours?.status === "open" ? (it.hours?.text ?? null) : null;
}

/** Where and when one partner is visited: the weekdays and dates of its stops, and its hours on each weekday. */
export interface PartnerVisit {
  weekdays: Weekday[];
  dates: string[];
  /** The partner's hours on its first visit day, as listed; null when not listed. */
  hours: string | null;
  callFirst: boolean;
  /**
   * Each visit weekday with that day's hours (null when not listed), in visit order. One entry when the passes visit
   * on the same weekday, as they do unless a holiday's stops moved to another day of its week.
   */
  days: { weekday: Weekday; hours: string | null }[];
  /** Dates of `dates` the day's route had no time left for this partner (the calendar lists it on that day's first event). */
  notTimed: string[];
}

/**
 * Each partner's street-team stops (keyed by entity id), from the same plan as street-team.ics, so the call list and
 * the sheet name the same days as the calendar. A stop the route had no time for keeps its day (the calendar lists it
 * on that day's first event, or on the day's all-day note). A partner closed on every street-team day has no entry.
 */
export function partnerVisits(sheet: StreetSheet, opts: IcsOptions = {}): Map<string, PartnerVisit> {
  const out = new Map<string, PartnerVisit>();
  const plan = planStreetTeam(sheet, opts);
  const stops = [
    ...plan.visits.flatMap((v) => [{ ...v, timed: true }, ...v.notTimed.map((x) => ({ ...x, timed: false }))]),
    ...plan.notes.flatMap((n) => n.notTimed.map((x) => ({ ...x, timed: false }))),
  ];
  stops.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const v of stops) {
    if (!v.partner) continue;
    const id = v.partner.entity.entityId;
    let cur = out.get(id);
    if (!cur) {
      cur = { weekdays: [], dates: [], hours: v.hours, callFirst: v.callFirst, days: [], notTimed: [] };
      out.set(id, cur);
    }
    if (!cur.weekdays.includes(v.weekday)) {
      cur.weekdays.push(v.weekday);
      cur.days.push({ weekday: v.weekday, hours: v.hours });
    }
    if (!cur.dates.includes(v.date)) cur.dates.push(v.date);
    if (!v.timed && !cur.notTimed.includes(v.date)) cur.notTimed.push(v.date);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

function textProp(name: string, value: string): string {
  return `${name}:${escapeIcsText(value)}`;
}

function geoProp(lat: number | undefined, lon: number | undefined): string | null {
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return `GEO:${lat.toFixed(6)};${lon.toFixed(6)}`;
}

/** "About 1.8 times the room's usual crowd" (prose never carries a ratio like "1.84x"). */
function liftWords(lift: number): string {
  if (!Number.isFinite(lift)) return "Compared with the room's usual crowd";
  if (lift < 0.95) return "Below the room's usual crowd";
  if (lift < 1.05) return "About the same as the room's usual crowd";
  if (lift < 1.3) return "A little above the room's usual crowd";
  return `About ${(Math.round(lift * 10) / 10).toFixed(1)} times the room's usual crowd`;
}

function placeLine(sheet: StreetSheet): string {
  const v = sheet.bill.venue;
  return [v.city, v.state].filter((x) => x && x.trim() !== "").join(", ");
}

/** "ZIP 20002, 20019": the area's residential 5-digit ZIPs (the same rule as the sheet and zips.csv), or "". */
function zipText(t: LiftTile): string {
  const zips = areaZips(t.zctas);
  return zips.length > 0 ? `ZIP ${zips.join(", ")}` : "";
}

/** The area a stop is in, in words: "area 1, Langston, DC", "Kenilworth, DC", or "near The Anthem". */
function stopArea(sheet: StreetSheet, v: StreetTeamVisit, tiles: ReadonlyMap<string, LiftTile>): string {
  if (v.tile && v.tileRank !== null) return `area ${v.tileRank}, ${areaLabel(v.tile)}`;
  const label = v.partner ? partnerAreaText(v.partner, tiles) : v.tile ? areaLabel(v.tile) : "";
  return label !== "" ? label : `near ${sheet.bill.venue.name}`;
}

/**
 * "First pass, 4 weeks out: ..." or "Final pass, show week: ...", said only when the calendar has both passes. A final
 * pass day moved off a holiday to the week before says "Final pass, 2 weeks out".
 */
function passLine(sheet: StreetSheet, v: Pick<StreetTeamVisit, "date" | "pass" | "partner">): string {
  const daysOut = Math.round((Date.parse(`${sheet.bill.date}T12:00:00Z`) - Date.parse(`${v.date}T12:00:00Z`)) / 86_400_000);
  const weeks = Math.max(1, Math.round(daysOut / 7));
  const out = `${weeks} ${weeks === 1 ? "week" : "weeks"} out`;
  const when = v.pass === "first" ? `First pass, ${out}` : daysOut <= 7 ? "Final pass, show week" : `Final pass, ${out}`;
  if (!v.partner) return `${when}.`;
  return v.pass === "first" ? `${when}: leave flyers and ask to put a poster up.` : `${when}: restock flyers and check the poster is still up.`;
}

/**
 * `streetDays` are the street-team days of this stop's pass (a holiday moved to another day of its week brings that
 * day's weekday), so "closed on Wed and Sat" names only days the pass visits. `holidayNote` is said on the pass's
 * earliest event.
 */
function visitDescription(
  sheet: StreetSheet,
  v: StreetTeamVisit,
  tileCount: number,
  tiles: ReadonlyMap<string, LiftTile>,
  streetDays: readonly Weekday[],
  twoPasses: boolean,
  holidayNote: string | null,
): string {
  const lines: string[] = [];
  if (sheet.mode === "fixture") lines.push(FIXTURE_NOTICE);
  if (twoPasses) lines.push(passLine(sheet, v));
  if (holidayNote) lines.push(holidayNote);
  if (v.tile && v.tileRank !== null) {
    const zips = zipText(v.tile);
    lines.push(`Area ${v.tileRank} of ${tileCount}: ${areaLabel(v.tile)}${zips ? `, ${zips}` : ""}. ${liftWords(v.tile.lift)}.`);
    lines.push("Where this bill's fans stand out from the room's usual crowd, not where buyers live.");
  } else if (v.partner && v.tile) {
    lines.push(`${stopArea(sheet, v, tiles)}: outside the ${tileCount} numbered areas.`);
  } else {
    lines.push(`Partners near ${sheet.bill.venue.name}.`);
  }
  const p = v.partner;
  if (p) {
    const day = weekdayShort(v.weekday);
    lines.push("", `${p.entity.name}${p.category ? ` (${categoryLabel(p.category)})` : ""}`);
    if (p.address?.trim()) lines.push(p.address.trim());
    if (p.phone?.trim()) lines.push(formatPhone(p.phone));
    lines.push(
      !v.callFirst ? `Open ${day} ${formatHours(v.hours ?? "")}.` : v.hours ? `Hours for ${day} as listed: ${v.hours}. Call first.` : `Hours for ${day} not listed: call first.`,
    );
    if (p.explain?.activation?.trim()) lines.push(p.explain.activation.trim());
    lines.push(SUGGESTED_NOT_AFFILIATED);
    const refs = receiptGroup(p.chips.map((c) => c.ledgerRef));
    if (refs) lines.push(`Receipts: ${refs}.`);
  } else {
    // A flyer drop: the area has no partner visited this pass, so any partner listed in it is closed on every day.
    const listed = v.tile !== null && sheet.cards.partners.results.some((x) => x.tileGeohash === v.tile!.geohash);
    lines.push("", listed ? `Every partner listed here is closed on ${streetDaysText(streetDays)}: flyer drop only.` : "No partners listed for this area: flyer drop only.");
  }
  lines.push(...unscheduledLines(sheet, v, tiles, streetDays));
  lines.push("", `Plan ${sheet.planId}. The requests behind each line are in sheet.json.`);
  return lines.join("\n");
}

/** What the event carries that the pass could not time: the partners closed on every street-team day, then the stops with no time left. */
function unscheduledLines(
  sheet: StreetSheet,
  v: Pick<StreetTeamVisit, "closedAllDays" | "notTimed">,
  tiles: ReadonlyMap<string, LiftTile>,
  streetDays: readonly Weekday[],
): string[] {
  const lines: string[] = [];
  if (v.closedAllDays.length > 0) {
    lines.push("", `Not scheduled, closed on ${streetDaysText(streetDays)}: ${v.closedAllDays.map((c) => c.entity.name).join(", ")}. Call to ask about dropping flyers another day.`);
  }
  if (v.notTimed.length > 0) lines.push("", notTimedLine(sheet, v.notTimed, tiles));
  return lines;
}

/**
 * The all-day event of a street-team day with nothing timed (`StreetTeamNote`): "Street team, first pass: no time
 * left for 1 stop", its description listing the stops to arrange by phone.
 */
function noteEventLines(
  sheet: StreetSheet,
  n: StreetTeamNote,
  ctx: { head: string; uid: string; dtstamp: string; tiles: ReadonlyMap<string, LiftTile>; streetDays: readonly Weekday[]; twoPasses: boolean; holidayNote: string | null },
): string[] {
  const count = n.notTimed.length;
  const title = count > 0 ? `${ctx.head}: no time left for ${count} ${count === 1 ? "stop" : "stops"}` : `${ctx.head}: not scheduled, closed on ${streetDaysText(ctx.streetDays)}`;
  const desc: string[] = [];
  if (sheet.mode === "fixture") desc.push(FIXTURE_NOTICE);
  if (ctx.twoPasses) desc.push(passLine(sheet, { date: n.date, pass: n.pass, partner: null }));
  if (ctx.holidayNote) desc.push(ctx.holidayNote);
  desc.push(...unscheduledLines(sheet, n, ctx.tiles, ctx.streetDays));
  desc.push("", `Plan ${sheet.planId}. The requests behind each line are in sheet.json.`);
  while (desc[0] === "") desc.shift();
  return [
    "BEGIN:VEVENT",
    ctx.uid,
    ctx.dtstamp,
    `DTSTART;VALUE=DATE:${n.date.replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${addDaysYmd(n.date, 1).replace(/-/g, "")}`,
    textProp("SUMMARY", title),
    textProp("DESCRIPTION", desc.join("\n")),
    "CATEGORIES:Street team",
    "STATUS:TENTATIVE",
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ];
}

/**
 * "No time left on the Sat Dec 19 2026 route for: Jeffery Pub (area 3, South Shore, IL), 7041 S Jeffery Blvd Chicago,
 * IL 60649, (773) 363-8555, open Sat 8 pm to 5 am; the flyer drop in area 4, Auburn Gresham, IL. Call the partners to
 * arrange a drop-off, and do the flyer drop, another day." Said on the day's first event.
 */
function notTimedLine(sheet: StreetSheet, stops: readonly NotTimedStop[], tiles: ReadonlyMap<string, LiftTile>): string {
  const byDate = new Map<string, NotTimedStop[]>();
  for (const s of stops) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  return [...byDate]
    .map(([date, xs]) => {
      const what = xs.map((s) => {
        const where = s.tile && s.tileRank !== null ? `area ${s.tileRank}, ${areaLabel(s.tile)}` : s.partner ? partnerAreaText(s.partner, tiles) || `near ${sheet.bill.venue.name}` : "";
        if (!s.partner) return `the flyer drop in ${where}`;
        const day = weekdayShort(s.weekday);
        const hours = s.callFirst ? `hours for ${day} not listed` : `open ${day} ${formatHours(s.hours ?? "")}`;
        return [`${s.partner.entity.name} (${where})`, s.partner.address?.trim() ?? "", s.partner.phone?.trim() ? formatPhone(s.partner.phone) : "", hours].filter((x) => x !== "").join(", ");
      });
      const partners = xs.some((s) => s.partner);
      const drops = xs.filter((s) => !s.partner).length;
      const todo = !drops
        ? "Call to arrange a drop-off another day."
        : !partners
          ? `Do the flyer ${drops === 1 ? "drop" : "drops"} another day.`
          : `Call the partners to arrange a drop-off, and do the flyer ${drops === 1 ? "drop" : "drops"}, another day.`;
      return `No time left on the ${formatShowDate(date)} route for: ${what.join("; ")}. ${todo}`;
    })
    .join("\n");
}

/**
 * "No street team on Thu Dec 24 2026 (Christmas Eve): shops keep holiday hours. Its stops are on Thu Dec 17 2026
 * instead." (or "on Wed Dec 23 2026 instead" when they moved within the week), or, with no free day to move to,
 * "... Its stops are on the pass's other days."
 */
function holidayLine(x: StreetTeamHoliday): string {
  const where = x.movedTo ? `on ${formatShowDate(x.movedTo)} instead` : "on the pass's other days";
  return `No street team on ${formatShowDate(x.date)} (${x.holiday}): shops keep holiday hours. Its stops are ${where}.`;
}

/** RFC 5545 text of the street-team calendar. */
export function toIcs(sheet: StreetSheet, opts: IcsOptions = {}): string {
  // The caller's zone wins; otherwise the venue's own (Ticketmaster's venue timezone), when it is one we can write.
  const zone = opts.timeZone ?? sheet.bill.venue.timeZone;
  const tzid = zone && SUPPORTED_TIME_ZONES[zone] ? zone : null;
  const tzParam = tzid ? `;TZID=${tzid}` : "";
  const domain = uidSafe(opts.uidDomain ?? "walkup");
  const plan = uidSafe(sheet.planId);
  const dtstamp = `DTSTAMP:${icsUtc(sheet.createdAt)}`;
  const fixture = sheet.mode === "fixture" ? SAMPLE_PREFIX : "";
  const acts = actsLine(sheet.bill);
  const where = placeLine(sheet);
  const tileCount = topTiles(sheet, opts).length;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    textProp("X-WR-CALNAME", `${fixture}Street team: ${acts}`),
  ];
  if (tzid) lines.push(`X-WR-TIMEZONE:${tzid}`, ...vtimezoneLines(tzid));

  const { visits, notes } = planStreetTeam(sheet, opts);
  const passes = new Set([...visits, ...notes].map((v) => v.pass));
  const twoPasses = passes.has("first") && passes.has("final");
  const tiles = new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  const streetDays = WEEKDAYS.filter((d) => (opts.streetTeamDays ?? sheet.operator.streetTeamDays ?? []).includes(d));
  // Each pass's own days and its holidays (with the day their stops moved to), said on its earliest event.
  const po = passOptions(sheet, opts);
  const passDates = streetTeamPasses(sheet.bill.date, po.days, po);
  const passDays = (pass: StreetTeamPass) => {
    const days = WEEKDAYS.filter((d) => passDates.some((x) => x.pass === pass && x.weekday === d));
    return days.length > 0 ? days : streetDays;
  };
  const holidays = streetTeamHolidays(sheet.bill.date, po.days, po);
  const noted = new Set<StreetTeamPass>();
  const holidayNoteFor = (pass: StreetTeamPass): string | null => {
    const skipped = noted.has(pass) ? [] : holidays.filter((x) => x.pass === pass);
    noted.add(pass);
    return skipped.length > 0 ? skipped.map(holidayLine).join(" ") : null;
  };
  // In date order; a day's note (a day with nothing timed) has the day to itself.
  const entries: ({ date: string; visit: StreetTeamVisit; note?: undefined } | { date: string; note: StreetTeamNote; visit?: undefined })[] = [
    ...visits.map((visit) => ({ date: visit.date, visit })),
    ...notes.map((note) => ({ date: note.date, note })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const entry of entries) {
    if (entry.note) {
      const n = entry.note;
      const head = `${fixture}Street team${twoPasses ? `, ${n.pass} pass` : ""}`;
      lines.push(
        ...noteEventLines(sheet, n, {
          head,
          uid: `UID:hl-${plan}-${n.date.replace(/-/g, "")}-no-time@${domain}`,
          dtstamp,
          tiles,
          streetDays: passDays(n.pass),
          twoPasses,
          holidayNote: holidayNoteFor(n.pass),
        }),
      );
      continue;
    }
    const v = entry.visit;
    const area = stopArea(sheet, v, tiles);
    const p = v.partner;
    const key = [v.tile ? uidSafe(v.tile.geohash) : "venue", p ? uidSafe(p.entity.entityId) : "flyers"].join("-");
    const head = `${fixture}Street team${twoPasses ? `, ${v.pass} pass` : ""}`;
    const title = p ? `${head}: ${p.entity.name} (${area})${v.callFirst ? ", call first" : ""}` : `${head}: ${area}, flyer drop`;
    const loc = p ? [p.entity.name, p.address?.trim() || area].filter((x) => x !== "").join(", ") : v.tile ? areaLabel(v.tile) : [sheet.bill.venue.name, where].filter((x) => x !== "").join(", ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:hl-${plan}-${v.date.replace(/-/g, "")}-${key}@${domain}`,
      dtstamp,
      `DTSTART${tzParam}:${icsLocal(v.date, v.start)}`,
      `DTEND${tzParam}:${icsLocal(v.date, v.end)}`,
      textProp("SUMMARY", title),
      textProp("LOCATION", loc),
    );
    const geo = geoProp(p?.entity.location?.lat, p?.entity.location?.lon) ?? (v.tile ? geoProp(v.tile.lat, v.tile.lon) : null) ?? geoProp(sheet.bill.venue.lat, sheet.bill.venue.lon);
    if (geo) lines.push(geo);
    lines.push(
      textProp("DESCRIPTION", visitDescription(sheet, v, tileCount, tiles, passDays(v.pass), twoPasses, holidayNoteFor(v.pass))),
      "CATEGORIES:Street team",
      "STATUS:TENTATIVE",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }

  const includeShow = (opts.includeShow ?? true) || entries.length === 0;
  if (includeShow && isYmd(sheet.bill.date)) {
    const v = sheet.bill.venue;
    lines.push("BEGIN:VEVENT", `UID:hl-${plan}-show@${domain}`, dtstamp);
    const showStart = opts.showStartTime ? parseHm(opts.showStartTime, -1) : -1;
    if (showStart >= 0) {
      const endMin = showStart + Math.max(30, Math.floor(opts.showMinutes ?? 180));
      const endDate = endMin >= 24 * 60 ? addDaysYmd(sheet.bill.date, 1) : sheet.bill.date;
      lines.push(
        `DTSTART${tzParam}:${icsLocal(sheet.bill.date, hm(showStart))}`,
        `DTEND${tzParam}:${icsLocal(endDate, hm(endMin % (24 * 60)))}`,
      );
    } else {
      lines.push(`DTSTART;VALUE=DATE:${sheet.bill.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${addDaysYmd(sheet.bill.date, 1).replace(/-/g, "")}`);
    }
    const desc = [
      ...(sheet.mode === "fixture" ? [FIXTURE_NOTICE] : []),
      `${acts} at ${v.name}.`,
      ...(sheet.bill.tmUrl ? [`Listing: ${sheet.bill.tmUrl}`] : []),
      `Plan ${sheet.planId}.`,
    ].join("\n");
    lines.push(textProp("SUMMARY", `${fixture}Show: ${acts} at ${v.name}`), textProp("LOCATION", [v.name, where].filter((x) => x !== "").join(", ")));
    const geo = geoProp(v.lat, v.lon);
    if (geo) lines.push(geo);
    lines.push(textProp("DESCRIPTION", desc), "CATEGORIES:Show", "STATUS:CONFIRMED", showStart >= 0 ? "TRANSP:OPAQUE" : "TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map((l) => foldLine(l)).join(ICS_EOL) + ICS_EOL;
}
