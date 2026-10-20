/**
 * Turns what the caller typed into one Ticketmaster event id: a Ticketmaster
 * event link, or "Artist @ Venue, Date" (parsed with @walkup/narrator,
 * then a Ticketmaster search). Several matching events pause with needs_input;
 * nothing is picked silently. Links are never fetched: only the id is read.
 */
import type { Candidate, LedgerEntry, LedgerSink } from "@walkup/contracts";
import type { ShowQuery } from "@walkup/narrator";
import type { TmClient, TmEvent } from "@walkup/tm";

export type EventLookup =
  | { kind: "event"; tmEventId: string; via: "url" | "text"; ledger: LedgerEntry[] }
  | { kind: "needs_input"; input: string; query: ShowQuery; candidates: Candidate[]; ledger: LedgerEntry[] }
  | { kind: "error"; reason: string; ledger: LedgerEntry[] };

/** Subtype used for Ticketmaster events offered as candidates. */
export const TM_EVENT_SUBTYPE = "urn:ticketmaster:event";

const TM_HOST_RE = /(^|\.)(ticketmaster|livenation)\.[a-z]{2,3}(\.[a-z]{2})?$/i;
/** The fixture world's event links (synthetic Ticketmaster stand-in). */
const FIXTURE_HOST = "tickets.example";
const EVENT_ID_RE = /\/event\/([A-Za-z0-9_-]{4,80})(?:[/?#]|$)/;

export function looksLikeUrl(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim());
}

/** The event id in a Ticketmaster (or fixture-world) event link, or null. */
export function tmEventIdFromUrl(text: string): string | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!TM_HOST_RE.test(host) && host !== FIXTURE_HOST) return null;
  const m = EVENT_ID_RE.exec(u.pathname);
  return m ? (m[1] as string) : null;
}

/** Words and the date (MM-DD-YYYY) from a link slug such as /artist-city-state-11-20-2026/event/<id>. */
export function slugHints(text: string): { words: string[]; date: string | null } {
  let path = "";
  try {
    path = new URL(text.trim()).pathname;
  } catch {
    return { words: [], date: null };
  }
  const slug = path.split("/event/")[0]?.split("/").filter(Boolean).pop() ?? "";
  const m = /(\d{2})-(\d{2})-(\d{4})$/.exec(slug);
  const date = m ? `${m[3]}-${m[1]}-${m[2]}` : null;
  const words = (m ? slug.slice(0, m.index) : slug)
    .split("-")
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w && !/^\d+$/.test(w));
  return { words, date };
}

export function normalizeLabel(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the\s+/, "");
}

function loosely(a: string, b: string): boolean {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

const DAY_MS = 86_400_000;

function canceled(e: TmEvent): boolean {
  const code = e.dates?.status?.code?.toLowerCase();
  return code === "canceled" || code === "cancelled";
}

function venueOf(e: TmEvent) {
  return e._embedded?.venues?.[0];
}

export function eventCandidate(e: TmEvent): Candidate {
  const v = venueOf(e);
  const where = [v?.name, v?.city?.name].filter(Boolean).join(", ");
  const c: Candidate = {
    entityId: e.id,
    name: [e.name ?? "Untitled event", where, e.dates?.start?.localDate].filter(Boolean).join(" · "),
    subtype: TM_EVENT_SUBTYPE,
    popularity: null,
  };
  if (e.url) c.externalUrl = e.url;
  return c;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface LookupDeps {
  tm: TmClient;
  ledger: LedgerSink;
  parse: (text: string) => Promise<ShowQuery>;
  now: () => number;
}

async function fromUrl(text: string, d: LookupDeps): Promise<EventLookup> {
  const id = tmEventIdFromUrl(text);
  if (!id) {
    return {
      kind: "error",
      reason: 'Only Ticketmaster event links are read (.../event/<id>). Or type the show as "Artist @ Venue, Date".',
      ledger: d.ledger.entries(),
    };
  }
  try {
    const r = await d.tm.getEvent(id);
    if (r.data) return { kind: "event", tmEventId: r.data.id, via: "url", ledger: d.ledger.entries() };
  } catch (err) {
    return { kind: "error", reason: `Ticketmaster lookup failed: ${errMessage(err)}`, ledger: d.ledger.entries() };
  }
  // Some links carry a page id that Discovery does not serve; find the event whose own link matches.
  const hints = slugHints(text);
  if (hints.date && hints.words.length > 0) {
    const start = Date.parse(`${hints.date}T00:00:00Z`);
    const tries: string[] = [];
    for (const words of [hints.words, hints.words.slice(0, 3), hints.words.slice(0, 2)]) {
      const k = words.join(" ");
      if (k && !tries.includes(k)) tries.push(k);
    }
    for (const keyword of tries) {
      try {
        const r = await d.tm.searchEvents({ keyword, startDateTime: new Date(start - DAY_MS), endDateTime: new Date(start + 2 * DAY_MS), size: 50 });
        const hit = r.data.find((e) => (e.url ?? "").includes(`/event/${id}`));
        if (hit) return { kind: "event", tmEventId: hit.id, via: "url", ledger: d.ledger.entries() };
      } catch (err) {
        return { kind: "error", reason: `Ticketmaster search failed: ${errMessage(err)}`, ledger: d.ledger.entries() };
      }
    }
  }
  return {
    kind: "error",
    reason: `Ticketmaster did not return event ${id}. Check the link, or type the show as "Artist @ Venue, Date".`,
    ledger: d.ledger.entries(),
  };
}

async function fromText(text: string, d: LookupDeps, pick?: string): Promise<EventLookup> {
  const q = await d.parse(text);
  if (!q.artist) {
    return { kind: "error", reason: 'Could not read an act from the text. Use "Artist @ Venue, Date" or a Ticketmaster event link.', ledger: d.ledger.entries() };
  }
  const now = d.now();
  const day = q.date ? Date.parse(`${q.date}T00:00:00Z`) : null;
  let events: TmEvent[];
  try {
    const r = await d.tm.searchEvents({
      keyword: q.artist,
      startDateTime: new Date(day !== null ? day - DAY_MS : now),
      ...(day !== null ? { endDateTime: new Date(day + 2 * DAY_MS) } : {}),
      size: 50,
      sort: "date,asc",
    });
    events = r.data;
  } catch (err) {
    return { kind: "error", reason: `Ticketmaster search failed: ${errMessage(err)}`, ledger: d.ledger.entries() };
  }
  const matches = events.filter((e) => {
    if (canceled(e)) return false;
    if (q.date && e.dates?.start?.localDate !== q.date) return false;
    const v = venueOf(e);
    if (q.venue && !(v?.name && loosely(v.name, q.venue))) return false;
    if (q.city && !(v?.city?.name && loosely(v.city.name, q.city))) return false;
    const names = [e.name ?? "", ...(e._embedded?.attractions ?? []).map((a) => a.name ?? "")];
    return names.some((n) => n && loosely(n, q.artist));
  });
  const described = [q.artist, q.venue && `@ ${q.venue}`, q.city, q.date].filter(Boolean).join(" ");
  if (matches.length === 0) {
    return {
      kind: "error",
      reason: `No Ticketmaster event matches ${described}. Check the spelling and date, or paste the Ticketmaster event link.`,
      ledger: d.ledger.entries(),
    };
  }
  if (pick) {
    const chosen = matches.find((e) => e.id === pick);
    if (chosen) return { kind: "event", tmEventId: chosen.id, via: "text", ledger: d.ledger.entries() };
  }
  if (matches.length === 1) return { kind: "event", tmEventId: (matches[0] as TmEvent).id, via: "text", ledger: d.ledger.entries() };
  return { kind: "needs_input", input: text, query: q, candidates: matches.slice(0, 10).map(eventCandidate), ledger: d.ledger.entries() };
}

/**
 * Resolves a Ticketmaster link or "Artist @ Venue, Date" to one event id.
 * `pick` is a Ticketmaster event id chosen from an earlier needs_input.
 */
export async function lookupEvent(text: string, d: LookupDeps, pick?: string): Promise<EventLookup> {
  return looksLikeUrl(text) ? fromUrl(text, d) : fromText(text, d, pick);
}
