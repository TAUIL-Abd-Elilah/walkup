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

/** "Greensky Bluegrass's", "FLO's"; a plural band name takes the apostrophe alone ("The Roots'"). */
export function possessive(name: string): string {
  return /^the\s.+s$/i.test(name.trim()) ? `${name}'` : `${name}'s`;
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

/**
 * Sites that host many businesses' pages: the host alone ("facebook.com") doesn't say which page. The same list as
 * the engine's LISTING_HOSTS (website.ts), which keeps these links only when they point at a page; a subdomain
 * counts too ("order.toasttab.com"). test/web-r4-fixes.test.ts checks the two lists agree.
 */
export const SHARED_HOSTS: readonly string[] = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "yelp.com",
  "google.com",
  "goo.gl",
  "g.page",
  "tripadvisor.com",
  "opentable.com",
  "resy.com",
  "toasttab.com",
  "square.site",
  "linktr.ee",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "doordash.com",
  "ubereats.com",
  "grubhub.com",
  "squarespace.com",
  "wixsite.com",
];

/** The query parameters that name a place on a listing site ("google.com/maps?cid=123"); the engine keeps these too. */
const PLACE_PARAMS = ["cid", "place_id", "q"] as const;

/**
 * "example.com" from "https://www.example.com/menu?x=1": where a website is, said on paper in place of a link. A page
 * on a shared site keeps its path (and Google's place parameter), so it still names the place:
 * "facebook.com/cafeaddis", "google.com/maps?cid=123".
 */
export function webHost(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    const shared = SHARED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    if (!shared) return host;
    let path = u.pathname.replace(/\/+$/, "");
    try {
      path = decodeURI(path);
    } catch {
      // Keep the path as it is written.
    }
    // Google Maps names the place in the query; elsewhere the query only counts when there is no path.
    const google = host === "google.com" || host.endsWith(".google.com");
    const param = google || !path ? PLACE_PARAMS.find((k) => u.searchParams.get(k)) : undefined;
    return host + path + (param ? `?${param}=${u.searchParams.get(param)}` : "");
  } catch {
    return shortUrl(url).split(/[/?#]/)[0] ?? url;
  }
}

/** "(615) 555-0100" -> "tel:+16155550100"; "+1 555-0101" keeps its own country code. */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (phone.trim().startsWith("+")) return `tel:+${digits}`;
  return `tel:+1${digits.slice(-10)}`;
}
