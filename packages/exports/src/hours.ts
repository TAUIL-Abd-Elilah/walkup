/**
 * A partner's opening hours on one weekday, as clock ranges the street-team calendar can schedule inside.
 * The week comes from the place's own `properties.hours` (read by the engine's lenient reader, which never
 * guesses "closed"); the sheet's `hoursOnDay` text (the hours on the first street-team day, written at plan
 * time) fills in that one day when the week can't be read.
 */
import type { Partner, Weekday } from "@walkup/contracts";
import { hoursOnDay } from "@walkup/engine";

export interface DayHours {
  /** "open": listed open that day; "closed": listed closed; "unknown": not listed (call first). */
  status: "open" | "closed" | "unknown";
  /** The hours as listed ("17:00:00-21:00:00", "10:00-14:00, 17:00-21:30"), null when closed or unknown. */
  text: string | null;
  /**
   * Open ranges in minutes after midnight on that day, [start, end), end at most 1440. A range past midnight
   * ("20:00-02:00") is cut at midnight. Empty when closed, unknown, or the text can't be read as clock times.
   */
  ranges: [number, number][];
}

const DAY_PREFIX = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\.?\s+/i;
const SHORT: Readonly<Record<Weekday, string>> = {
  monday: "mon",
  tuesday: "tue",
  wednesday: "wed",
  thursday: "thu",
  friday: "fri",
  saturday: "sat",
  sunday: "sun",
};

function to24(h: number, ap: string | undefined): number {
  if (!ap) return h;
  const p = ap === "pm";
  if (p && h < 12) return h + 12;
  if (!p && h === 12) return 0;
  return h;
}

/**
 * Clock ranges in a day's hours text: "17:00:00-21:00:00", "10:00-14:00, 17:00-21:30", "11 AM-2 AM",
 * "9:30am to 5pm", "Open 24 hours". Minutes after midnight, cut at midnight, merged and sorted.
 */
export function parseOpenRanges(text: string | null | undefined): [number, number][] {
  const t = (text ?? "")
    .toLowerCase()
    .replace(/\b([ap])\.\s?m\.?/g, "$1m")
    .replace(/[–—]|\bto\b|\bthrough\b/g, "-")
    .trim();
  if (t === "") return [];
  if (/\b24\s*(hours|hrs|h)\b/.test(t)) return [[0, 1440]];
  const re = /(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?\s*-\s*(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?/g;
  const out: [number, number][] = [];
  for (const m of t.matchAll(re)) {
    let ap1 = m[3];
    const ap2 = m[6];
    const h1 = Number(m[1]);
    const h2 = Number(m[4]);
    if (h1 > 24 || h2 > 24) continue;
    // "11-2 pm": the first time takes the second's half of the day unless that would put it after the close.
    if (!ap1 && ap2) ap1 = h1 <= h2 && h1 !== 12 ? ap2 : ap2 === "pm" ? "am" : "pm";
    const start = to24(h1, ap1) * 60 + Number(m[2] ?? 0);
    let end = to24(h2, ap2) * 60 + Number(m[5] ?? 0);
    if (start >= 1440) continue;
    if (end <= start) end = 1440; // past midnight (or "00:00" close): open to the end of the day
    out.push([start, Math.min(1440, end)]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * The partner's hours on `day`. `listedDay` is the weekday the sheet's `hoursOnDay` text belongs to (the first
 * street-team day, else the show's weekday); that text is used for that day when the week can't be read.
 */
export function partnerHoursOn(p: Pick<Partner, "entity" | "hoursOnDay">, day: Weekday, listedDay: Weekday | null): DayHours {
  const week = hoursOnDay(p.entity.properties?.hours, day);
  if (week.status === "closed") return { status: "closed", text: null, ranges: [] };
  if (week.status === "open") return { status: "open", text: week.text, ranges: parseOpenRanges(week.text) };
  const listed = (p.hoursOnDay ?? "").trim();
  if (listed !== "" && day === listedDay) {
    const lead = DAY_PREFIX.exec(listed)?.[1]?.toLowerCase();
    // "Thu 10:00-19:00" belongs to Thursday only.
    if (!lead || lead === SHORT[day]) {
      const text = listed.replace(DAY_PREFIX, "");
      return { status: "open", text, ranges: parseOpenRanges(text) };
    }
  }
  return { status: "unknown", text: null, ranges: [] };
}
