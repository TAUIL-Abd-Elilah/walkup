import { WEEKDAYS, type Weekday } from "@walkup/contracts";

const TM_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Discovery wants `YYYY-MM-DDTHH:mm:ssZ` (UTC, no milliseconds). Accepts a Date,
 * a bare `YYYY-MM-DD` (start of that UTC day) or any ISO string with a zone.
 */
export function toTmDateTime(input: string | Date): string {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new RangeError("Invalid Date");
    return input.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  const s = input.trim();
  if (TM_DATETIME.test(s)) return s;
  if (ISO_DATE.test(s)) return `${s}T00:00:00Z`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime()) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    throw new RangeError(`Not a zoned ISO datetime: ${s}`);
  }
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Weekday of a venue-local calendar date. The date is read as a plain calendar
 * day (no timezone shift): "2026-11-28" is a Saturday wherever the code runs.
 */
export function weekdayOfLocalDate(localDate: string): Weekday {
  const m = ISO_DATE.exec(localDate);
  if (!m) throw new RangeError(`Not a YYYY-MM-DD date: ${localDate}`);
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) {
    throw new RangeError(`Not a calendar date: ${localDate}`);
  }
  // getUTCDay: 0 = Sunday. WEEKDAYS starts on Monday.
  return WEEKDAYS[(date.getUTCDay() + 6) % 7] as Weekday;
}

/** Whole days from a to b (both YYYY-MM-DD), calendar arithmetic only. */
export function daysBetween(a: string, b: string): number {
  const pa = ISO_DATE.exec(a);
  const pb = ISO_DATE.exec(b);
  if (!pa || !pb) throw new RangeError(`Not YYYY-MM-DD: ${a} / ${b}`);
  const ta = Date.UTC(Number(pa[1]), Number(pa[2]) - 1, Number(pa[3]));
  const tb = Date.UTC(Number(pb[1]), Number(pb[2]) - 1, Number(pb[3]));
  return Math.round((tb - ta) / 86_400_000);
}
