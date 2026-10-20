/**
 * Lenient opening-hours reader for one weekday. It never guesses "closed":
 * "closed" needs explicit evidence (a "Closed"/"off" value, an empty entry in an
 * otherwise populated week, or a full list of periods that skips the day).
 * Anything it does not recognise is "unknown".
 *
 * Shapes handled:
 *  - object keyed by day name ("Monday", "mon", "MONDAY") whose values are
 *    arrays of {opens, closes} / {open, close} / {start, end} objects, arrays of
 *    strings, a single string, a single interval object or a boolean;
 *  - arrays of strings such as "Monday: 11 AM-2 AM" or "Sun: Closed";
 *  - a free-text string ("Mon-Fri 11am-2am; Sat, Sun 10am-2am", "Daily 7-3",
 *    "Open 24 hours", OSM style "Mo-Fr 09:00-17:00; Su off");
 *  - Google-style objects with weekdayDescriptions / weekday_text or periods
 *    ({open: {day: 0..6 (0 = Sunday), hour, minute} | {day, time: "1100"}});
 *  - arrays of {day, opens, closes} rows;
 *  - a JSON string of any of the above.
 */
import { WEEKDAYS, type Weekday } from "@walkup/contracts";

export type HoursStatus = "open" | "closed" | "unknown";

export interface HoursOnDay {
  status: HoursStatus;
  /** Human text for the day ("11:00-02:00", "11 AM-2 AM"), null when closed or unknown. */
  text: string | null;
}

export interface HoursOptions {
  /** A recognised week that simply does not mention the day. Default "unknown". */
  missingDayMeans?: "unknown" | "closed";
}

const UNKNOWN: HoursOnDay = { status: "unknown", text: null };
const CLOSED: HoursOnDay = { status: "closed", text: null };

const DAY_ALIASES: Readonly<Record<string, Weekday>> = {
  monday: "monday",
  mon: "monday",
  mo: "monday",
  tuesday: "tuesday",
  tues: "tuesday",
  tue: "tuesday",
  tu: "tuesday",
  wednesday: "wednesday",
  weds: "wednesday",
  wed: "wednesday",
  we: "wednesday",
  thursday: "thursday",
  thurs: "thursday",
  thur: "thursday",
  thu: "thursday",
  th: "thursday",
  friday: "friday",
  fri: "friday",
  fr: "friday",
  saturday: "saturday",
  sat: "saturday",
  sa: "saturday",
  sunday: "sunday",
  sun: "sunday",
  su: "sunday",
};

/** Google's day numbering: 0 = Sunday. */
const GOOGLE_DAY: Readonly<Record<Weekday, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const LONG_DAY_RE = /^(?:(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|(tues|weds|thurs|thur|mon|tue|wed|thu|fri|sat|sun))\.?(?![a-z])/i;
const SHORT_DAY_RE = /^(mo|tu|we|th|fr|sa|su)(?![a-z])/i;
const SHORT_DAY_FOLLOW_RE = /^(\s*[-\u2013\u2014,&/]\s*(mo|tu|we|th|fr|sa|su)(?![a-z])|\s+(\d|off\b|closed\b)|\s*$|\s*:)/i;
const RANGE_SEP_RE = /^\s*(?:-|\u2013|\u2014|to\b|through\b|thru\b)\s*/i;
const LIST_SEP_RE = /^\s*(?:,|&|\/|\band\b)\s*/i;

export function normalizeWeekday(s: unknown): Weekday | null {
  if (typeof s !== "string") return null;
  const k = s.trim().toLowerCase().replace(/\.$/, "");
  return DAY_ALIASES[k] ?? null;
}

function cleanText(s: string): string {
  return s
    .replace(/[\u00a0\u202f\u2009\u2007]/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function dayRange(a: Weekday, b: Weekday): Weekday[] {
  const out: Weekday[] = [];
  let i = WEEKDAYS.indexOf(a);
  const j = WEEKDAYS.indexOf(b);
  for (let guard = 0; guard < 7; guard++) {
    out.push(WEEKDAYS[i] as Weekday);
    if (i === j) break;
    i = (i + 1) % 7;
  }
  return out;
}

function matchDayToken(s: string): { day: Weekday; len: number } | null {
  const long = LONG_DAY_RE.exec(s);
  if (long) {
    const day = normalizeWeekday(long[1] ?? long[2]);
    if (day) return { day, len: long[0].length };
  }
  const short = SHORT_DAY_RE.exec(s);
  if (short && SHORT_DAY_FOLLOW_RE.test(s.slice(short[0].length))) {
    const day = normalizeWeekday(short[1]);
    if (day) return { day, len: short[0].length };
  }
  return null;
}

/** Leading day specification of a text segment ("Mon-Fri", "Sat & Sun", "Daily", "Weekends"). */
export function parseDaySpec(segment: string): { days: Weekday[]; rest: string } | null {
  let s = segment.trim();
  const special: [RegExp, Weekday[]][] = [
    [/^(?:open\s+)?(?:daily|every\s*day|all\s+week|7\s+days(?:\s+a\s+week)?)\b/i, [...WEEKDAYS]],
    [/^weekdays\b/i, ["monday", "tuesday", "wednesday", "thursday", "friday"]],
    [/^weekends?\b/i, ["saturday", "sunday"]],
  ];
  for (const [re, days] of special) {
    const m = re.exec(s);
    if (m) return { days, rest: s.slice(m[0].length).replace(/^[\s:,-]+/, "") };
  }
  const days = new Set<Weekday>();
  let first = true;
  for (;;) {
    let probe = s;
    if (!first) {
      const sep = LIST_SEP_RE.exec(probe);
      if (!sep) break;
      probe = probe.slice(sep[0].length);
    }
    const tok = matchDayToken(probe);
    if (!tok) break;
    probe = probe.slice(tok.len);
    const range = RANGE_SEP_RE.exec(probe);
    let added = false;
    if (range) {
      const tok2 = matchDayToken(probe.slice(range[0].length));
      if (tok2) {
        for (const d of dayRange(tok.day, tok2.day)) days.add(d);
        probe = probe.slice(range[0].length + tok2.len);
        added = true;
      }
    }
    if (!added) days.add(tok.day);
    s = probe;
    first = false;
  }
  if (days.size === 0) return null;
  return { days: WEEKDAYS.filter((d) => days.has(d)), rest: s.replace(/^[\s:,-]+/, "") };
}

type ValueClass = { kind: "open"; text: string | null } | { kind: "closed" } | { kind: "unknown" } | { kind: "empty" };

const CLOSED_TEXT_RE = /^(?:closed|off)\b/i;
const ALL_DAY_RE = /\b24\s*(?:hours|hrs|h)\b|\b24\s*\/\s*7\b/i;

function classifyText(raw: string): ValueClass {
  const t = cleanText(raw);
  if (t === "") return { kind: "empty" };
  // "Closed" / "off" is evidence for the whole day; "Closed until 5 PM" or
  // "Closed 2-5" names a window, so it is not.
  if (CLOSED_TEXT_RE.test(t)) return /\d/.test(t) ? { kind: "unknown" } : { kind: "closed" };
  if (ALL_DAY_RE.test(t)) return { kind: "open", text: "Open 24 hours" };
  if (/\d/.test(t) || /\bopen\b/i.test(t)) return { kind: "open", text: t };
  return { kind: "unknown" };
}

function fmtTime(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const n = Math.round(v);
    if (n >= 0 && n <= 2400) return `${String(Math.floor(n / 100)).padStart(2, "0")}:${String(n % 100).padStart(2, "0")}`;
    return null;
  }
  if (typeof v === "string") {
    const t = cleanText(v).replace(/^T(?=\d)/, "");
    if (t === "") return null;
    if (/^\d{4}$/.test(t)) return `${t.slice(0, 2)}:${t.slice(2)}`;
    return t;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.hour === "number" && Number.isFinite(o.hour)) {
      const m = typeof o.minute === "number" && Number.isFinite(o.minute) ? o.minute : 0;
      return `${String(o.hour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
    if (o.time !== undefined) return fmtTime(o.time);
  }
  return null;
}

const OPEN_KEYS = ["opens", "open", "start", "from", "open_time", "openTime", "opening"];
const CLOSE_KEYS = ["closes", "close", "end", "to", "close_time", "closeTime", "closing"];

function classifyInterval(o: Record<string, unknown>): ValueClass {
  if (o.closed === true || o.is_closed === true || o.isClosed === true) return { kind: "closed" };
  let opens: string | null = null;
  let closes: string | null = null;
  for (const k of OPEN_KEYS) {
    if (o[k] !== undefined && typeof o[k] !== "boolean") {
      opens = fmtTime(o[k]);
      if (opens) break;
    }
  }
  for (const k of CLOSE_KEYS) {
    if (o[k] !== undefined && typeof o[k] !== "boolean") {
      closes = fmtTime(o[k]);
      if (closes) break;
    }
  }
  if (opens || closes) return { kind: "open", text: `${opens ?? "?"}-${closes ?? "?"}` };
  if (o.open === false) return { kind: "closed" };
  if (typeof o.hours === "string") return classifyText(o.hours);
  if (typeof o.text === "string") return classifyText(o.text);
  return { kind: "unknown" };
}

function combine(parts: ValueClass[]): ValueClass {
  if (parts.length === 0) return { kind: "empty" };
  const open = parts.filter((p): p is { kind: "open"; text: string | null } => p.kind === "open");
  if (open.length > 0) {
    const texts = open.map((p) => p.text).filter((t): t is string => !!t);
    return { kind: "open", text: texts.length > 0 ? [...new Set(texts)].join(", ") : null };
  }
  if (parts.every((p) => p.kind === "closed" || p.kind === "empty") && parts.some((p) => p.kind === "closed")) return { kind: "closed" };
  if (parts.every((p) => p.kind === "empty")) return { kind: "empty" };
  return { kind: "unknown" };
}

function classifyValue(v: unknown): ValueClass {
  if (v === null || v === undefined) return { kind: "empty" };
  if (typeof v === "boolean") return v ? { kind: "open", text: null } : { kind: "closed" };
  if (typeof v === "string") return classifyText(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return { kind: "empty" };
    return combine(v.map((x) => classifyValue(x)));
  }
  if (typeof v === "object") return classifyInterval(v as Record<string, unknown>);
  return { kind: "unknown" };
}

function fromClass(c: ValueClass): HoursOnDay {
  if (c.kind === "open") return { status: "open", text: c.text };
  if (c.kind === "closed") return CLOSED;
  return UNKNOWN;
}

/** Day-keyed map: decides the target day with the "explicit evidence" rule. */
function fromDayMap(entries: Map<Weekday, ValueClass[]>, day: Weekday, opts: HoursOptions): HoursOnDay {
  const othersPopulated = [...entries.entries()].some(([d, vs]) => d !== day && vs.some((v) => v.kind === "open" || v.kind === "closed"));
  const mine = entries.get(day);
  if (!mine) return othersPopulated && opts.missingDayMeans === "closed" ? CLOSED : UNKNOWN;
  const c = combine(mine);
  if (c.kind === "empty") return othersPopulated ? CLOSED : UNKNOWN;
  return fromClass(c);
}

function splitSegments(text: string): string[] {
  const dayAhead = "(?=(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|weds|thurs|thur|mon|tue|wed|thu|fri|sat|sun|daily|weekdays|weekends?)(?![a-z]))";
  const out: string[] = [];
  for (const line of text.split(/\r?\n|;|\|/)) {
    for (const piece of line.split(new RegExp(`,\\s*${dayAhead}`, "i"))) {
      const p = cleanText(piece);
      if (p) out.push(p);
    }
  }
  return out;
}

function fromText(text: string, day: Weekday, opts: HoursOptions): HoursOnDay {
  const entries = new Map<Weekday, ValueClass[]>();
  let pending: Weekday[] = [];
  let sawDays = false;
  let bare: ValueClass | null = null;
  for (const seg of splitSegments(text)) {
    const spec = parseDaySpec(seg);
    if (!spec) {
      if (/^(?:(?:permanently|temporarily)\s+)?closed$/i.test(seg)) bare = { kind: "closed" };
      else if (ALL_DAY_RE.test(seg) && bare === null) bare = { kind: "open", text: "Open 24 hours" };
      continue;
    }
    sawDays = true;
    if (spec.rest === "") {
      pending.push(...spec.days);
      continue;
    }
    const cls = classifyText(spec.rest);
    for (const d of [...pending, ...spec.days]) {
      const arr = entries.get(d) ?? [];
      arr.push(cls);
      entries.set(d, arr);
    }
    pending = [];
  }
  if (!sawDays) return bare ? fromClass(bare) : UNKNOWN;
  if (!entries.has(day)) {
    const populated = [...entries.values()].some((vs) => vs.some((v) => v.kind === "open" || v.kind === "closed"));
    return populated && opts.missingDayMeans === "closed" ? CLOSED : UNKNOWN;
  }
  return fromDayMap(entries, day, opts);
}

function fromPeriods(periods: unknown[], day: Weekday): HoursOnDay {
  const target = GOOGLE_DAY[day];
  // Google encodes "always open" as a single period opening Sunday 00:00 with no close.
  if (periods.length === 1) {
    const only = periods[0] as Record<string, unknown> | null;
    const open = only && typeof only === "object" ? (only.open as Record<string, unknown> | undefined) : undefined;
    if (open && typeof open === "object" && !only?.close && fmtTime(open) === "00:00") return { status: "open", text: "Open 24 hours" };
  }
  const texts: string[] = [];
  let valid = 0;
  for (const p of periods) {
    if (!p || typeof p !== "object") return UNKNOWN;
    const open = (p as Record<string, unknown>).open as Record<string, unknown> | undefined;
    if (!open || typeof open !== "object" || typeof open.day !== "number" || !Number.isInteger(open.day)) return UNKNOWN;
    valid++;
    if (open.day !== target) continue;
    const close = (p as Record<string, unknown>).close;
    const o = fmtTime(open);
    const c = close && typeof close === "object" ? fmtTime(close) : null;
    texts.push(c ? `${o ?? "?"}-${c}` : "Open 24 hours");
  }
  if (valid === 0) return UNKNOWN;
  if (texts.length === 0) return CLOSED;
  return { status: "open", text: [...new Set(texts)].join(", ") };
}

const DAY_FIELD_KEYS = ["day", "days", "weekday", "dayOfWeek", "day_of_week"];

/**
 * Hours for one weekday from whatever `properties.hours` looks like.
 * Unknown shapes return "unknown", never "closed".
 */
export function hoursOnDay(hours: unknown, day: Weekday, opts: HoursOptions = {}, depth = 0): HoursOnDay {
  if (depth > 3 || hours === null || hours === undefined) return UNKNOWN;
  if (typeof hours === "string") {
    const t = hours.trim();
    if ((t.startsWith("{") || t.startsWith("[")) && depth < 3) {
      try {
        // JSON.parse returns `any`; it is immediately narrowed by hoursOnDay's own checks.
        const parsed: unknown = JSON.parse(t);
        return hoursOnDay(parsed, day, opts, depth + 1);
      } catch {
        /* fall through to text */
      }
    }
    return fromText(t, day, opts);
  }
  if (Array.isArray(hours)) {
    if (hours.length === 0) return UNKNOWN;
    if (hours.every((x) => typeof x === "string")) return fromText((hours as string[]).join("\n"), day, opts);
    const objs = hours.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
    if (objs.length !== hours.length) return UNKNOWN;
    if (objs.every((o) => o.open && typeof o.open === "object")) return fromPeriods(objs, day);
    const entries = new Map<Weekday, ValueClass[]>();
    for (const o of objs) {
      const key = DAY_FIELD_KEYS.find((k) => o[k] !== undefined);
      if (!key) return UNKNOWN;
      const raw = o[key];
      let days: Weekday[] = [];
      if (typeof raw === "number" && Number.isInteger(raw)) {
        const d = (Object.keys(GOOGLE_DAY) as Weekday[]).find((w) => GOOGLE_DAY[w] === raw);
        if (d) days = [d];
      } else if (typeof raw === "string") {
        const single = normalizeWeekday(raw);
        days = single ? [single] : (parseDaySpec(raw)?.days ?? []);
      } else if (Array.isArray(raw)) {
        days = raw.map((x) => normalizeWeekday(x)).filter((x): x is Weekday => x !== null);
      }
      if (days.length === 0) return UNKNOWN;
      const rest: Record<string, unknown> = { ...o };
      delete rest[key];
      const cls = classifyValue(rest);
      for (const d of days) {
        const arr = entries.get(d) ?? [];
        arr.push(cls);
        entries.set(d, arr);
      }
    }
    return fromDayMap(entries, day, opts);
  }
  if (typeof hours === "object") {
    const o = hours as Record<string, unknown>;
    const entries = new Map<Weekday, ValueClass[]>();
    for (const [k, v] of Object.entries(o)) {
      const d = normalizeWeekday(k);
      if (!d) continue;
      const arr = entries.get(d) ?? [];
      arr.push(classifyValue(v));
      entries.set(d, arr);
    }
    if (entries.size > 0) return fromDayMap(entries, day, opts);
    for (const k of ["weekdayDescriptions", "weekday_text", "weekdayText"]) {
      const v = o[k];
      if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string")) return fromText(v.join("\n"), day, opts);
    }
    if (Array.isArray(o.periods) && o.periods.length > 0) return fromPeriods(o.periods, day);
    for (const k of ["hours", "regularOpeningHours", "opening_hours", "openingHours", "currentOpeningHours"]) {
      if (o[k] !== undefined) return hoursOnDay(o[k], day, opts, depth + 1);
    }
  }
  return UNKNOWN;
}
