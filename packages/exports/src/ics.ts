/**
 * street-team.ics: an RFC 5545 calendar of tile visits by day, plus the show.
 *
 * - Lines end in CRLF and are folded at 75 octets (continuation lines start
 *   with one space; UTF-8 sequences are never split).
 * - TEXT values escape backslash, semicolon, comma and newlines.
 * - UIDs are derived from the plan id, the date and the tile geohash, so a
 *   re-export of the same plan updates events instead of duplicating them.
 * - DTSTAMP is the plan's createdAt (UTC), so the same sheet gives the same file.
 * - Times are floating local times (no TZID): "10:00" means 10:00 wherever the
 *   street team is, which is the venue's own wall clock. Pass `timeZone` with a
 *   supported US zone to pin them with a VTIMEZONE instead.
 */
import type { LiftTile, Partner, StreetSheet, Weekday } from "@walkup/contracts";
import { WEEKDAYS } from "@walkup/contracts";
import {
  actsLine,
  addDaysYmd,
  categoryLabel,
  formatHours,
  FIXTURE_NOTICE,
  SAMPLE_PREFIX,
  isYmd,
  receiptGroup,
  SUGGESTED_NOT_AFFILIATED,
  tileLabel,
  topTiles,
  weekdayOfYmd,
  ymdOf,
  type TileSelectOptions,
} from "./format";

export const ICS_EOL = "\r\n";
export const ICS_PRODID = "-//Walkup//Street Sheet export//EN";

export interface IcsOptions extends TileSelectOptions {
  /** Street-team weekdays. Default: the sheet's `operator.streetTeamDays`. */
  streetTeamDays?: readonly Weekday[];
  /** How many weeks before the show to schedule (1-8). Default 1: the last occurrence of each day before the show. */
  weeks?: number;
  /** First visit of the day, "HH:MM" local. Default "10:00". */
  startTime?: string;
  /** Minutes per tile visit. Default 90. */
  visitMinutes?: number;
  /** Minutes between visits (travel). Default 30. */
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
  /** "HH:MM" local. */
  start: string;
  end: string;
  /** Null for the single "near the venue" visit used when the sheet has no top tiles. */
  tile: LiftTile | null;
  /** 1-based rank of the tile among the top tiles. */
  tileRank: number | null;
  partners: Partner[];
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
// The plan: which tiles on which day
// ---------------------------------------------------------------------------

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
    for (let k = 1; k <= 7; k++) {
      const date = addDaysYmd(showDate, -(k + 7 * w));
      const weekday = weekdayOfYmd(date);
      if (!wanted.includes(weekday)) continue;
      if (opts.notBefore && isYmd(opts.notBefore) && date < opts.notBefore) continue;
      out.push({ date, weekday, week: w });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Tile visits by day. Within each week the top tiles are dealt round-robin
 * over that week's street-team days in lift order (tile 1 on the first day,
 * tile 2 on the second, ...), then each day's visits run back to back from
 * `startTime`. With no top tiles, each day gets one visit to the partners near
 * the venue (when there are any).
 */
export function planStreetTeamVisits(sheet: StreetSheet, opts: IcsOptions = {}): StreetTeamVisit[] {
  const days = opts.streetTeamDays ?? sheet.operator.streetTeamDays ?? [];
  const created = new Date(sheet.createdAt);
  const notBefore = opts.notBefore ?? (Number.isNaN(created.getTime()) ? undefined : ymdOf(created));
  const dates = streetTeamDates(sheet.bill.date, days, { weeks: opts.weeks, notBefore: notBefore || undefined });
  if (dates.length === 0) return [];

  const tiles = topTiles(sheet, opts);
  const partners = sheet.cards.partners.results;
  type Slot = { tile: LiftTile | null; rank: number | null; partners: Partner[] };
  const slots: Slot[] =
    tiles.length > 0
      ? tiles.map((t, i) => ({ tile: t, rank: i + 1, partners: partners.filter((p) => p.tileGeohash === t.geohash) }))
      : partners.length > 0
        ? [{ tile: null, rank: null, partners: [...partners] }]
        : [];
  if (slots.length === 0) return [];

  const byDate = new Map<string, Slot[]>();
  const weeks = [...new Set(dates.map((d) => d.week))];
  for (const w of weeks) {
    const weekDates = dates.filter((d) => d.week === w);
    if (slots.length === 1 && slots[0]?.tile === null) {
      for (const d of weekDates) byDate.set(d.date, [slots[0]]);
      continue;
    }
    slots.forEach((s, i) => {
      const d = weekDates[i % weekDates.length];
      if (!d) return;
      byDate.set(d.date, [...(byDate.get(d.date) ?? []), s]);
    });
  }

  const start = parseHm(opts.startTime, 10 * 60);
  const visitMin = Math.max(15, Math.floor(opts.visitMinutes ?? 90));
  const gapMin = Math.max(0, Math.floor(opts.gapMinutes ?? 30));
  const lastMinute = 23 * 60 + 59;
  const minSlot = 10;
  const visits: StreetTeamVisit[] = [];
  for (const d of dates) {
    const daySlots = byDate.get(d.date) ?? [];
    if (daySlots.length === 0) continue;
    const n = daySlots.length;
    let dayStart = start;
    let slot = visitMin + gapMin;
    let visit = visitMin;
    if (dayStart + n * slot - gapMin > lastMinute) {
      // Too many visits for what is left of the day: shrink them evenly so the
      // day still ends before midnight. If that leaves under `minSlot` minutes
      // per visit, start the day earlier instead, so every visit starts and ends
      // on its own date (never "24:00") and ends after it starts.
      slot = Math.floor((lastMinute - dayStart) / n);
      if (slot < minSlot) {
        slot = Math.max(1, Math.min(minSlot, Math.floor(lastMinute / n)));
        dayStart = Math.max(0, lastMinute - n * slot);
      }
      visit = Math.max(1, slot - Math.min(gapMin, Math.floor(slot / 4)));
    }
    daySlots.forEach((s, i) => {
      const from = dayStart + i * slot;
      visits.push({
        date: d.date,
        weekday: d.weekday,
        start: hm(from),
        end: hm(Math.min(lastMinute, from + visit)),
        tile: s.tile,
        tileRank: s.rank,
        partners: s.partners,
      });
    });
  }
  return visits;
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

function textProp(name: string, value: string): string {
  return `${name}:${escapeIcsText(value)}`;
}

function geoProp(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
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

function visitDescription(sheet: StreetSheet, v: StreetTeamVisit, tileCount: number): string {
  const lines: string[] = [];
  if (sheet.mode === "fixture") lines.push(FIXTURE_NOTICE);
  if (v.tile) {
    const zips = (v.tile.zctas ?? []).join(", ");
    lines.push(`Area ${v.tileRank ?? "?"} of ${tileCount}: ${tileLabel(v.tile)}${zips ? `, ZIP ${zips}` : ""}. ${liftWords(v.tile.lift)}.`);
    lines.push("Where this bill's fans stand out from the room's usual crowd, not where buyers live.");
  } else {
    lines.push(`Partners near ${sheet.bill.venue.name}.`);
  }
  if (v.partners.length > 0) {
    lines.push("", SUGGESTED_NOT_AFFILIATED, "Partners to visit:");
    v.partners.forEach((p, i) => {
      const bits = [
        `${i + 1}. ${p.entity.name}${p.category ? ` (${categoryLabel(p.category)})` : ""}`,
        p.address ?? "",
        p.hoursOnDay ? formatHours(p.hoursOnDay) : "",
        p.phone ?? "",
      ].filter((b) => b !== "");
      const refs = receiptGroup(p.chips.map((c) => c.ledgerRef));
      lines.push(`${bits.join(" - ")}${refs ? ` (${refs})` : ""}`);
    });
  } else {
    lines.push("", "No partners listed for this area: flyer drop only.");
  }
  lines.push("", `Plan ${sheet.planId}. The requests behind each line are in sheet.json.`);
  return lines.join("\n");
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

  const visits = planStreetTeamVisits(sheet, opts);
  for (const v of visits) {
    const key = v.tile ? uidSafe(v.tile.geohash) : "venue";
    const title = v.tile
      ? `${fixture}Street team: area ${v.tileRank}, ${tileLabel(v.tile)}`
      : `${fixture}Street team: partners near ${sheet.bill.venue.name}`;
    const loc = v.tile ? [tileLabel(v.tile), where].filter((x) => x !== "").join(", ") : [sheet.bill.venue.name, where].filter((x) => x !== "").join(", ");
    lines.push(
      "BEGIN:VEVENT",
      `UID:hl-${plan}-${v.date.replace(/-/g, "")}-${key}@${domain}`,
      dtstamp,
      `DTSTART${tzParam}:${icsLocal(v.date, v.start)}`,
      `DTEND${tzParam}:${icsLocal(v.date, v.end)}`,
      textProp("SUMMARY", title),
      textProp("LOCATION", loc),
    );
    const geo = v.tile ? geoProp(v.tile.lat, v.tile.lon) : geoProp(sheet.bill.venue.lat, sheet.bill.venue.lon);
    if (geo) lines.push(geo);
    lines.push(
      textProp("DESCRIPTION", visitDescription(sheet, v, tileCount)),
      "CATEGORIES:Street team",
      "STATUS:TENTATIVE",
      "TRANSP:OPAQUE",
      "END:VEVENT",
    );
  }

  const includeShow = (opts.includeShow ?? true) || visits.length === 0;
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
