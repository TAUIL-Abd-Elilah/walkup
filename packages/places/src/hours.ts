import type { Weekday } from "@walkup/contracts";
import type { GoogleOpeningHours, GooglePoint } from "./types";

/** Google numbers days 0 = Sunday .. 6 = Saturday. */
export const GOOGLE_DAY: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const WEEK_MIN = 7 * 1440;

interface HasHours {
  regularOpeningHours?: GoogleOpeningHours | null;
}

function minuteOfWeek(p: GooglePoint): number | null {
  if (typeof p.day !== "number" || p.day < 0 || p.day > 6) return null;
  return p.day * 1440 + (p.hour ?? 0) * 60 + (p.minute ?? 0);
}

/** Periods as [open, close) minute-of-week spans; close wraps past Saturday night. */
function spans(hours: GoogleOpeningHours): { alwaysOpen: boolean; list: [number, number][] } | null {
  const periods = hours.periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;
  const list: [number, number][] = [];
  for (const period of periods) {
    if (!period.open) continue;
    const o = minuteOfWeek(period.open);
    if (o === null) continue;
    if (!period.close) return { alwaysOpen: true, list: [] };
    const c = minuteOfWeek(period.close);
    if (c === null) continue;
    list.push([o, c <= o ? c + WEEK_MIN : c]);
  }
  return list.length > 0 ? { alwaysOpen: false, list } : null;
}

function covers(span: [number, number], t: number): boolean {
  return (t >= span[0] && t < span[1]) || (t + WEEK_MIN >= span[0] && t + WEEK_MIN < span[1]);
}

/**
 * Does the place open on this weekday? True when a period opens that day (or a
 * multi-day period is still open at noon), false when the hours rule it out,
 * null when Google gave no regular hours. Overnight spill (Fri 18:00 to Sat 02:00)
 * does not count as open on Saturday.
 */
export function isOpenOn(place: HasHours, weekday: Weekday): boolean | null {
  const hours = place.regularOpeningHours;
  if (!hours) return null;
  const s = spans(hours);
  if (!s) return null;
  if (s.alwaysOpen) return true;
  const day = GOOGLE_DAY[weekday];
  if (s.list.some(([o]) => Math.floor(o / 1440) === day)) return true;
  const noon = day * 1440 + 720;
  return s.list.some((span) => covers(span, noon));
}

/** Is the place open at a local "HH:MM" on this weekday? Null when hours are unknown. */
export function isOpenAt(place: HasHours, weekday: Weekday, time: string): boolean | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new RangeError(`Not HH:MM: ${time}`);
  const hours = place.regularOpeningHours;
  if (!hours) return null;
  const s = spans(hours);
  if (!s) return null;
  if (s.alwaysOpen) return true;
  const t = GOOGLE_DAY[weekday] * 1440 + Number(m[1]) * 60 + Number(m[2]);
  return s.list.some((span) => covers(span, t));
}

/** OPERATIONAL -> true; CLOSED_TEMPORARILY / CLOSED_PERMANENTLY -> false; missing or other -> null. */
export function isOperational(place: { businessStatus?: string | null }): boolean | null {
  switch (place.businessStatus) {
    case "OPERATIONAL":
      return true;
    case "CLOSED_TEMPORARILY":
    case "CLOSED_PERMANENTLY":
      return false;
    default:
      return null;
  }
}
