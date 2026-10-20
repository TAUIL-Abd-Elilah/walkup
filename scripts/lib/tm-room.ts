/**
 * Ticketmaster room tooling for key day (scripts/tm-room.ts): find one room
 * on Discovery, read its roster the way a plan does (the next 60 events from
 * the as-of date), apply the hero selection rule to a window with its working
 * shown, check that each pick can be planned, and write the room's point and
 * roster Spotify ids into probe.config.json. Every function takes an injected
 * TmClient; nothing here reads or prints the key.
 */

import { explainG1Rule, genreClass, type G1Explanation, type GenreClass } from "@walkup/orchestrator";
import { actsOf, rosterHeadliners, TM_MAX_DEEP_RESULTS, toVenue, tryToBill, type TmClient, type TmEvent, type TmVenue } from "@walkup/tm";
import { validateConfig, type ProbeConfig, type VenueCfg } from "./probe/config.js";

export const TM_PROVIDER = "Ticketmaster Discovery API v2";
/** The house roster as a plan reads it (orchestrator Q2: next 60 events from the as-of date, top 20 headliners). */
export const ROSTER_SIZE = 60;
export const ROSTER_TOP = 20;
/** Window page size; Discovery serves at most (page + 1) * size <= 1000 results. */
export const WINDOW_PAGE_SIZE = 200;

export interface Window {
  from: string;
  to: string;
}

export interface VenueRow {
  id: string;
  name: string;
  city: string;
  state: string | null;
  address: string | null;
  url: string | null;
  /** From toVenue: null when the record has no usable coordinates. */
  point: { lat: number; lon: number } | null;
}

/**
 * Lowercase, accents and punctuation dropped, "&" read as "and". "The Truth"
 * matches "the truth" and "The Truth." but not "The Truth Nashville": an exact
 * name, not a loose one.
 */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function venueRow(v: TmVenue): VenueRow | null {
  if (!v.id) return null;
  const mapped = toVenue(v);
  return {
    id: v.id,
    name: v.name ?? "",
    city: v.city?.name ?? "",
    state: v.state?.stateCode ?? v.state?.name ?? null,
    address: v.address?.line1 ?? null,
    url: v.url ?? null,
    point: mapped ? { lat: mapped.lat, lon: mapped.lon } : null,
  };
}

function rowsOf(venues: readonly TmVenue[]): VenueRow[] {
  return dedupe(venues.map(venueRow).filter((v): v is VenueRow => v !== null));
}

function dedupe(rows: readonly VenueRow[]): VenueRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

export type VenueLookup =
  | { kind: "found"; venue: VenueRow; query: string; candidates: VenueRow[] }
  | { kind: "choose"; reason: string; candidates: VenueRow[] };

/**
 * One room by exact name and city: /venues first, then the venues on matching
 * /events. Anything but exactly one exact match asks for --venue-id.
 */
export async function findVenue(tm: TmClient, q: { name: string; city: string; state: string }): Promise<VenueLookup> {
  const want = normalizeName(q.name);
  const city = normalizeName(q.city);
  const exact = (rows: VenueRow[]) => rows.filter((v) => normalizeName(v.name) === want && normalizeName(v.city) === city);
  const place = `${q.city}, ${q.state}`;

  const searched = rowsOf((await tm.searchVenues(q.name, { stateCode: q.state, countryCode: "US", size: 50 })).data);
  const hits = exact(searched);
  if (hits.length === 1) return { kind: "found", venue: hits[0] as VenueRow, query: `venues.json keyword="${q.name}" stateCode=${q.state} countryCode=US`, candidates: searched };
  if (hits.length > 1) return { kind: "choose", reason: `${hits.length} Ticketmaster venues are named exactly "${q.name}" in ${place}. Pass --venue-id with the one you mean.`, candidates: hits };

  const events = (await tm.searchEvents({ keyword: q.name, city: q.city, stateCode: q.state, countryCode: "US", size: 50 })).data;
  const embedded = rowsOf(events.flatMap((e) => e._embedded?.venues ?? []));
  const eventHits = exact(embedded);
  const candidates = dedupe([...searched, ...embedded]);
  if (eventHits.length === 1) {
    const query = `events.json keyword="${q.name}" city="${q.city}" stateCode=${q.state} countryCode=US (the venue on the events)`;
    return { kind: "found", venue: eventHits[0] as VenueRow, query, candidates };
  }
  if (eventHits.length > 1) return { kind: "choose", reason: `${eventHits.length} venues on Ticketmaster events are named exactly "${q.name}" in ${place}. Pass --venue-id with the one you mean.`, candidates: eventHits };
  const next = candidates.length > 0 ? "Pass --venue-id with one of the venues listed, or check the spelling." : "Check the spelling, or pass --venue-id.";
  return { kind: "choose", reason: `No Ticketmaster venue is named exactly "${q.name}" in ${place}. ${next}`, candidates };
}

/** The venue record carried on the room's own events (for --venue-id, which skips the search). */
export function venueFromEvents(venueId: string, events: readonly TmEvent[]): VenueRow | null {
  for (const e of events) for (const v of e._embedded?.venues ?? []) if (v.id === venueId) return venueRow(v);
  return null;
}

// ---------------------------------------------------------------------------
// Roster and window
// ---------------------------------------------------------------------------

const usable = (s: string | undefined): s is string => !!s && s.trim() !== "" && s !== "Undefined";

/** "Music / Country / Americana", Discovery's "Undefined" placeholders and repeats dropped. */
export function labelsOf(e: TmEvent): string {
  const c = e.classifications?.[0];
  const parts = [c?.segment?.name, c?.genre?.name, c?.subGenre?.name].filter(usable);
  return parts.filter((p, i) => p !== parts[i - 1]).join(" / ");
}

export interface RosterRow {
  id: string;
  localDate: string | null;
  name: string;
  labels: string;
  genreClass: GenreClass;
  status: string | null;
  /** The headliner's Spotify id from Ticketmaster, or null. */
  spotifyId: string | null;
}

export interface Roster {
  events: TmEvent[];
  rows: RosterRow[];
  /** Headliner Spotify ids in house-set order (rosterHeadliners: recency x frequency), deduped. */
  spotifyIds: string[];
  /** Headliners in the top 20 (with or without a Spotify id). */
  headliners: number;
}

export async function readRoster(tm: TmClient, venueId: string, asOf: string): Promise<Roster> {
  const events = (await tm.eventsByVenue(venueId, { startDateTime: asOf, size: ROSTER_SIZE })).data;
  const rows = events.map((e) => ({
    id: e.id,
    localDate: e.dates?.start?.localDate ?? null,
    name: e.name ?? e.id,
    labels: labelsOf(e),
    genreClass: genreClass(e),
    status: e.dates?.status?.code ?? null,
    spotifyId: actsOf(e)[0]?.spotifyId ?? null,
  }));
  const heads = rosterHeadliners(events, { top: ROSTER_TOP, referenceDate: asOf });
  const spotifyIds = [...new Set(heads.map((h) => h.act.spotifyId).filter((x): x is string => !!x))];
  return { events, rows, spotifyIds, headliners: heads.length };
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export interface WindowRead {
  events: TmEvent[];
  pages: number;
  /** True when the window holds more than Discovery serves (1000 results). */
  truncated: boolean;
  startDateTime: string;
  endDateTime: string;
}

/**
 * Every event in the window. Discovery filters on UTC instants and a bare
 * date is UTC midnight, so the request runs to the end of the day after the
 * window's last day (a late show on the last local day is not cut off) and
 * the rule then keeps local dates inside the window.
 */
export async function readWindow(tm: TmClient, venueId: string, window: Window): Promise<WindowRead> {
  const startDateTime = `${window.from}T00:00:00Z`;
  const endDateTime = `${addDays(window.to, 1)}T23:59:59Z`;
  const events: TmEvent[] = [];
  let page = 0;
  let truncated = false;
  for (;;) {
    const r = await tm.eventsByVenue(venueId, { startDateTime, endDateTime, size: WINDOW_PAGE_SIZE, page, sort: "date,asc" });
    events.push(...r.data);
    if (page + 1 >= (r.page?.totalPages ?? 1)) break;
    if ((page + 2) * WINDOW_PAGE_SIZE > TM_MAX_DEEP_RESULTS) {
      truncated = true;
      break;
    }
    page += 1;
  }
  return { events, pages: page + 1, truncated, startDateTime, endDateTime };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface PickCheck {
  bill: "A" | "B";
  id: string;
  name: string;
  headliner: string | null;
  spotifyId: string | null;
  warnings: string[];
}

/** What stands between a pick and a plan: a bill Walkup can build, and a headliner with a Spotify id. */
export function checkPick(bill: "A" | "B", e: TmEvent): PickCheck {
  const warnings: string[] = [];
  const mapped = tryToBill(e);
  if (!mapped.bill) warnings.push(`Bill ${bill} cannot be planned: ${mapped.issues.join("; ")}.`);
  else if (mapped.issues.length > 0) warnings.push(`Bill ${bill}: ${mapped.issues.join("; ")}.`);
  const head = actsOf(e)[0] ?? null;
  if (head && !head.spotifyId) {
    warnings.push(`Bill ${bill}: the headliner ${head.name} has no Spotify link on Ticketmaster, so Walkup looks it up by name. The spec needs both headliners to resolve exactly: check it before you record.`);
  }
  const status = e.dates?.status?.code?.toLowerCase();
  if (status === "postponed" || status === "rescheduled") warnings.push(`Bill ${bill} is ${status} on Ticketmaster.`);
  return { bill, id: e.id, name: e.name ?? e.id, headliner: head?.name ?? null, spotifyId: head?.spotifyId ?? null, warnings };
}

export interface RoomReport {
  venue: VenueRow;
  /** How the venue was found (the probe config's source.query). */
  venueQuery: string;
  asOf: string;
  roster: Roster;
  window: WindowRead & Window;
  explanation: G1Explanation;
  picks: PickCheck[];
  warnings: string[];
}

export interface ReportInput {
  /** The venue from the search; null with --venue-id (then read from the room's events). */
  venue: VenueRow | null;
  venueId: string;
  venueQuery: string;
  asOf: string;
  window: Window;
}

export async function roomReport(tm: TmClient, input: ReportInput): Promise<RoomReport> {
  const roster = await readRoster(tm, input.venueId, input.asOf);
  const read = await readWindow(tm, input.venueId, input.window);
  const explanation = explainG1Rule(read.events, input.window);
  const warnings: string[] = [];
  const venue = input.venue ?? venueFromEvents(input.venueId, [...roster.events, ...read.events]);
  if (!venue) warnings.push(`No event at venue ${input.venueId} carries the venue record, so its name and point are unknown.`);
  const byId = new Map(read.events.map((e) => [e.id, e]));
  const picks: PickCheck[] = [];
  for (const [bill, pick] of [
    ["A", explanation.billA],
    ["B", explanation.billB],
  ] as const) {
    const e = pick.id ? byId.get(pick.id) : undefined;
    if (e) picks.push(checkPick(bill, e));
  }
  for (const p of picks) warnings.push(...p.warnings);
  if (read.truncated) warnings.push(`The window holds more than ${TM_MAX_DEEP_RESULTS} events; only the first ${TM_MAX_DEEP_RESULTS} were read.`);
  if (roster.events.length === 0) warnings.push(`Ticketmaster lists no event at this room from ${input.asOf}, so there is no house roster.`);
  else if (roster.spotifyIds.length === 0) warnings.push("No roster headliner has a Spotify link on Ticketmaster, so the probe's house set stays a stand-in.");
  return {
    venue: venue ?? { id: input.venueId, name: "", city: "", state: null, address: null, url: null, point: null },
    venueQuery: input.venueQuery,
    asOf: input.asOf,
    roster,
    window: { ...read, from: input.window.from, to: input.window.to },
    explanation,
    picks,
    warnings,
  };
}

/** The report without Ticketmaster bodies (for --json). */
export function reportJson(r: RoomReport): Record<string, unknown> {
  return {
    venue: r.venue,
    venueQuery: r.venueQuery,
    asOf: r.asOf,
    roster: { events: r.roster.rows, spotifyIds: r.roster.spotifyIds, headliners: r.roster.headliners },
    window: {
      from: r.window.from,
      to: r.window.to,
      startDateTime: r.window.startDateTime,
      endDateTime: r.window.endDateTime,
      eventsRead: r.window.events.length,
      pages: r.window.pages,
      truncated: r.window.truncated,
      candidates: r.explanation.candidates,
    },
    billA: r.explanation.billA,
    billB: r.explanation.billB,
    picks: r.picks,
    warnings: r.warnings,
  };
}

const cell = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}~` : s.padEnd(n));

export function renderReport(r: RoomReport): string[] {
  const v = r.venue;
  const L: string[] = [];
  L.push(`Venue   ${v.name || "(name unknown)"}, ${[v.city, v.state].filter(Boolean).join(", ")} (venue id ${v.id})`);
  if (v.address || v.url) L.push(`        ${[v.address, v.url].filter(Boolean).join("  ")}`);
  L.push(`        ${v.point ? `Point ${v.point.lat}, ${v.point.lon} from the Ticketmaster venue record` : "No point on the Ticketmaster venue record"}`);
  L.push(`        Found by ${r.venueQuery}`);
  L.push("");
  L.push(`Roster  ${r.roster.events.length} events from ${r.asOf} (the room's next ${ROSTER_SIZE}, as a plan reads them)`);
  for (const row of r.roster.rows) {
    L.push(`  ${cell(row.localDate ?? "no date", 10)}  ${cell(row.name, 36)}  ${cell(row.labels || "-", 32)}  ${cell(row.genreClass, 9)}  ${cell(row.status ?? "-", 11)}  ${row.spotifyId ?? "-"}`);
  }
  L.push(`Roster Spotify ids in house-set order: ${r.roster.spotifyIds.length} of the top ${r.roster.headliners} headliners have one`);
  for (const id of r.roster.spotifyIds) L.push(`  ${id}`);
  L.push("");
  const w = r.window;
  L.push(`Window  ${w.from} to ${w.to}: ${w.events.length} events read in ${w.pages} ${w.pages === 1 ? "page" : "pages"} (${w.startDateTime} to ${w.endDateTime}, then kept by local date)`);
  for (const c of r.explanation.candidates) {
    const labels = [c.genre, c.subGenre].filter((x): x is string => x !== null).join(" / ") || "-";
    L.push(`  ${cell(c.localDate, 10)}  ${cell(c.name, 36)}  ${cell(labels, 32)}  ${cell(c.genreClass, 9)}  ${cell(String(c.distance), 4)}  ${c.eligible ? (c.status ?? "-") : `${c.status} (skipped)`}`);
  }
  if (r.explanation.candidates.length === 0) L.push("  (no event dated in the window)");
  L.push(`Bill A  ${r.explanation.billA.id ?? "none"}  ${r.explanation.billA.reason}`);
  L.push(`Bill B  ${r.explanation.billB.id ?? "none"}  ${r.explanation.billB.reason}`);
  for (const p of r.picks) L.push(`        Bill ${p.bill} headliner: ${p.headliner ?? "none"}, Spotify ${p.spotifyId ?? "none"}`);
  if (r.warnings.length > 0) {
    L.push("");
    L.push("Warnings");
    for (const x of r.warnings) L.push(`  - ${x}`);
  }
  return L;
}

// ---------------------------------------------------------------------------
// probe.config.json: a targeted rewrite that keeps the hand formatting
// ---------------------------------------------------------------------------

interface Member {
  keyStart: number;
  valueStart: number;
  valueEnd: number;
}

function skipWs(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i] as string)) i++;
  return i;
}

function stringEnd(t: string, i: number): number {
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === "\\") j++;
    else if (t[j] === '"') return j + 1;
  }
  throw new Error("probe config: unterminated string");
}

function valueEnd(t: string, i: number): number {
  const c = t[i];
  if (c === '"') return stringEnd(t, i);
  if (c === "{" || c === "[") {
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (ch === '"') j = stringEnd(t, j) - 1;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    throw new Error("probe config: unbalanced brackets");
  }
  const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(t.slice(i));
  if (!m) throw new Error(`probe config: unexpected character at offset ${i}`);
  return i + m[0].length;
}

/** The members of the object that starts at `open` ("{"), with their spans. */
function members(t: string, open: number): Map<string, Member> {
  const out = new Map<string, Member>();
  let i = skipWs(t, open + 1);
  while (t[i] !== "}") {
    if (t[i] !== '"') throw new Error(`probe config: expected a key at offset ${i}`);
    const keyStart = i;
    const keyEnd = stringEnd(t, i);
    const key = JSON.parse(t.slice(keyStart, keyEnd)) as string;
    i = skipWs(t, keyEnd);
    if (t[i] !== ":") throw new Error(`probe config: expected ":" after "${key}"`);
    const valueStart = skipWs(t, i + 1);
    const end = valueEnd(t, valueStart);
    out.set(key, { keyStart, valueStart, valueEnd: end });
    i = skipWs(t, end);
    if (t[i] === ",") i = skipWs(t, i + 1);
  }
  return out;
}

function indentAt(t: string, i: number): string {
  const lineStart = t.lastIndexOf("\n", i - 1) + 1;
  return t.slice(lineStart, i);
}

/** JSON.stringify at two spaces, continued at the key's own indent. */
function block(value: unknown, indent: string): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

export interface ProbeUpdate {
  /** venues.<key>; added when the config has no such room. */
  key: string;
  venue: VenueRow;
  venueQuery: string;
  spotifyIds: string[];
  rosterCount: number;
  asOf: string;
  /** Date the Ticketmaster records were read (YYYY-MM-DD). */
  retrieved: string;
}

/**
 * Writes venues.<key> (lat, lon, note, source) and roster (venue, spotifyIds,
 * note) into the config text and leaves every other byte alone. Refuses a
 * venue without a point, a key that names a different room, and any result
 * that validateConfig rejects.
 */
export function rewriteProbeConfig(text: string, u: ProbeUpdate): { text: string; notes: string[] } {
  const v = u.venue;
  if (!v.point) throw new Error(`The Ticketmaster record for venue ${v.id} has no coordinates, so probe.config.json was not changed.`);
  const parsed = JSON.parse(text) as ProbeConfig;
  const existing = parsed.venues?.[u.key] as VenueCfg | undefined;
  if (existing && (normalizeName(existing.name) !== normalizeName(v.name) || normalizeName(existing.city) !== normalizeName(v.city))) {
    throw new Error(
      `venues.${u.key} is "${existing.name}, ${existing.city}" but the Ticketmaster venue is "${v.name}, ${v.city}". Pass --probe-key with a new key to add it as its own room; probe.config.json was not changed.`,
    );
  }
  const source = { provider: TM_PROVIDER, query: u.venueQuery, ...(v.url ? { url: v.url } : {}), result: v.id, retrieved: u.retrieved };
  const note = `Point from the Ticketmaster venue record ${v.id}, read ${u.retrieved} with npm run tm:room.`;
  const entry = existing
    ? { ...existing, lat: v.point.lat, lon: v.point.lon, note, source }
    : { name: v.name, city: v.city, state: v.state ?? "", lat: v.point.lat, lon: v.point.lon, note, source };
  const rosterNote =
    u.spotifyIds.length > 0
      ? `Spotify artist ids of the headliners on the room's next ${u.rosterCount} Ticketmaster events from ${u.asOf} (venue ${v.id}), in house-set order (top ${ROSTER_TOP} by recency and frequency). Used for the house set (#2, #13) and probe #18`
      : u.rosterCount > 0
        ? `No headliner on the room's next ${u.rosterCount} Ticketmaster events from ${u.asOf} (venue ${v.id}) has a Spotify link, so the house set stays a stand-in and probe #18 is skipped`
        : `Ticketmaster listed no event at venue ${v.id} from ${u.asOf}, so the house set stays a stand-in and probe #18 is skipped`;
  const roster = { venue: u.key, spotifyIds: u.spotifyIds, note: rosterNote };

  const root = skipWs(text, 0);
  if (text[root] !== "{") throw new Error("probe config: not a JSON object");
  const top = members(text, root);
  const venues = top.get("venues");
  const rosterSpan = top.get("roster");
  if (!venues || text[venues.valueStart] !== "{" || !rosterSpan) throw new Error("probe config: venues or roster missing");
  const rooms = members(text, venues.valueStart);
  const edits: { start: number; end: number; text: string }[] = [
    { start: rosterSpan.valueStart, end: rosterSpan.valueEnd, text: block(roster, indentAt(text, rosterSpan.keyStart)) },
  ];
  const room = rooms.get(u.key);
  if (room) {
    edits.push({ start: room.valueStart, end: room.valueEnd, text: block(entry, indentAt(text, room.keyStart)) });
  } else {
    const last = [...rooms.values()].at(-1);
    if (!last) throw new Error("probe config: venues is empty");
    const indent = indentAt(text, last.keyStart);
    edits.push({ start: last.valueEnd, end: last.valueEnd, text: `,\n${indent}${JSON.stringify(u.key)}: ${block(entry, indent)}` });
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  const errors = validateConfig(JSON.parse(out));
  if (errors.length > 0) throw new Error(`The rewritten probe config does not validate, so it was not written:\n  - ${errors.join("\n  - ")}`);
  const notes: string[] = [];
  if (!room) notes.push(`Added venues.${u.key}.`);
  const after = JSON.parse(out) as ProbeConfig;
  if (after.kg2.venue !== u.key) notes.push(`kg2.venue is still "${after.kg2.venue}": point it at "${u.key}" to run KG2 on this room.`);
  return { text: out, notes };
}
