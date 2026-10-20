/**
 * Formatting helpers. Deterministic (no locale guessing) so server and client
 * render identical text and hydration never shifts layout.
 */
import type { Bill, Weekday } from "@walkup/contracts";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function parseYmd(ymd: string): Date {
  return new Date(`${ymd}T12:00:00Z`);
}

/** "Fri Nov 20 2026" */
export function formatShowDate(ymd: string): string {
  const d = parseYmd(ymd);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

/** "November 20, 2026" */
export function formatLongDate(ymd: string): string {
  const d = parseYmd(ymd);
  return `${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** "Oct 30 2026, 15:04 UTC" */
export function formatStamp(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** "Oct 30 2026, 15:04:07 UTC": a request time to the second, for receipts. */
export function formatStampSeconds(iso: string): string {
  const d = new Date(iso);
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return formatStamp(iso).replace(/ UTC$/, `:${ss} UTC`);
}

/** "16:05 UTC" */
export function formatClockUtc(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** "Oct 14" (UTC), for a tab title. */
export function formatDayMonth(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "the PDF", "the PDF and the call list", "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Whole days from the plan's creation to the show (the T-minus badge). */
export function tMinusDays(createdAtIso: string, showYmd: string): number {
  const created = new Date(createdAtIso);
  const createdDay = Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate());
  const show = parseYmd(showYmd);
  const showDay = Date.UTC(show.getUTCFullYear(), show.getUTCMonth(), show.getUTCDate());
  return Math.round((showDay - createdDay) / 86_400_000);
}

export function tMinusLabel(days: number): string {
  if (days % 7 === 0 && days >= 28) return `T-${days / 7} weeks`;
  return `T-${days}`;
}

export function formatInt(n: number): string {
  const s = Math.round(Math.abs(n)).toString();
  const withCommas = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${withCommas}` : withCommas;
}

export function formatUsd(n: number): string {
  return `$${formatInt(n)}`;
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

export function formatBytes(b: number): string {
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b >= 1000) return `${(b / 1000).toFixed(1)} kB`;
  return `${b} B`;
}

export function formatPct(x: number, dp = 0): string {
  return `${(x * 100).toFixed(dp)}%`;
}

export function formatLift(lift: number): string {
  return `${lift.toFixed(2)}x`;
}

export function formatDistance(m: number | null | undefined): string {
  if (m === null || m === undefined) return "";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}

export function formatSigned(n: number, dp = 2): string {
  const s = n.toFixed(dp);
  return n > 0 ? `+${s}` : s;
}

const WEEKDAY_SHORT: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

export function weekdayShort(d: Weekday): string {
  return WEEKDAY_SHORT[d];
}

export function actsLine(bill: Bill): string {
  return bill.acts.map((a) => a.name).join(", ");
}

export function headlinerName(bill: Bill): string {
  return bill.acts.find((a) => a.role === "headliner")?.name ?? bill.acts[0]?.name ?? "";
}

/** "example.com/walkup-fixture/x" from a URL, for compact display. */
export function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** "(615) 555-0100" -> "tel:+16155550100"; "+1 555-0101" keeps its own country code. */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (phone.trim().startsWith("+")) return `tel:+${digits}`;
  return `tel:+1${digits.slice(-10)}`;
}
