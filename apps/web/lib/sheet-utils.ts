import type { GuardReport, LedgerEntry, LiftTile, Partner, QlooEntity, StreetSheet, TraceStep } from "@walkup/contracts";
import { formatClockUtc, formatDayMonth, formatStamp, headlinerName, joinAnd } from "./format";
import { TOP_LIFT } from "./lift";
import { LEDGER_SOURCE_SHORT, tagFallbackName } from "./labels";

/** Areas closer than this (km) to a higher-lift area are the same place and get no number of their own. */
export const AREA_MERGE_KM = 3;

/** True when `t` is the same place as `o`: within AREA_MERGE_KM or sharing a ZIP. */
export function sameArea(o: Pick<LiftTile, "lat" | "lon" | "zctas">, t: Pick<LiftTile, "lat" | "lon" | "zctas">): boolean {
  const zo = o.zctas ?? [];
  return distanceKm(o, t) < AREA_MERGE_KM || (zo.length > 0 && (t.zctas ?? []).some((z) => zo.includes(z)));
}

/**
 * The numbered areas 1-5: lift 1.3 and up, highest first, skipping a tile that is the same place as one already
 * numbered (within 3 km or sharing a ZIP). The orchestrator's budget split, partner areas and narration use the
 * same rule, so these numbers match them everywhere. Names that still clash get a distance and direction.
 */
export function topTiles(sheet: StreetSheet, n = 5): LiftTile[] {
  const sorted = [...sheet.cards.liftMap.results.tiles]
    .filter((t) => t.lift >= TOP_LIFT)
    .sort((a, b) => b.lift - a.lift || b.billPct - a.billPct || (a.geohash < b.geohash ? -1 : a.geohash > b.geohash ? 1 : 0));
  const out: LiftTile[] = [];
  for (const t of sorted) {
    if (out.length >= n) break;
    if (out.some((o) => sameArea(o, t))) continue;
    out.push(t);
  }
  return distinctNames(out, sheet.bill.venue);
}

/** Gives areas that still share a name a distance and direction from the venue ("Nashville-Davidson, 17 km west"). */
export function distinctNames(tiles: LiftTile[], venue: { lat: number; lon: number }): LiftTile[] {
  const count = new Map<string, number>();
  for (const t of tiles) if (t.name) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  return tiles.map((t) =>
    t.name && (count.get(t.name) ?? 0) > 1 ? { ...t, name: `${t.name}, ${formatKm(distanceKm(venue, t))} ${compassDirection(venue, t)}` } : t,
  );
}

/** An area's display name: its gazetteer name, never a geohash. */
export function areaName(t: Pick<LiftTile, "name"> | undefined, number?: number): string {
  if (t?.name) return t.name;
  return number ? `Area ${number}` : "Unnamed area";
}

export function allTiles(sheet: StreetSheet): LiftTile[] {
  return [...sheet.cards.liftMap.results.tiles].sort((a, b) => b.lift - a.lift);
}

export function tileWhy(sheet: StreetSheet, geohash: string): string | undefined {
  return sheet.narration?.tileWhy.find((t) => t.geohash === geohash)?.text;
}

export function partnerLine(sheet: StreetSheet, entityId: string): string | undefined {
  return sheet.narration?.partnerLines.find((p) => p.entityId === entityId)?.text;
}

/** Every tag name the sheet knows, so a hook's tag ids can be shown by name. */
export function tagIndex(sheet: StreetSheet): Map<string, string> {
  const m = new Map<string, string>();
  const addEntity = (e: QlooEntity | undefined) => e?.tags.forEach((t) => m.set(t.id, t.name));
  const c = sheet.cards;
  c.resolution.results.forEach((r) => {
    addEntity(r.entity);
    addEntity(r.proxy?.entity);
  });
  c.partners.results.forEach((p) => addEntity(p.entity));
  c.prePost.results.forEach((p) => addEntity(p.entity));
  c.media.results.forEach((p) => addEntity(p.entity));
  c.declared.results.forEach((p) => addEntity(p.entity));
  const diff = c.whatsDifferent.results;
  [...diff.shared, ...diff.a, ...diff.b].forEach((t) => m.set(t.id, t.name));
  return m;
}

export function tagName(index: Map<string, string>, id: string): string {
  return index.get(id) ?? tagFallbackName(id);
}

/** entityId -> display name across every card (for explainability rows). */
export function entityIndex(sheet: StreetSheet): Map<string, string> {
  const m = new Map<string, string>();
  const add = (e: QlooEntity | undefined) => {
    if (e) m.set(e.entityId, e.name);
  };
  const c = sheet.cards;
  c.resolution.results.forEach((r) => {
    add(r.entity);
    add(r.proxy?.entity);
    r.candidates?.forEach((cand) => m.set(cand.entityId, `${cand.name} (${cand.subtype.split(":").pop() ?? ""})`));
  });
  c.partners.results.forEach((p) => add(p.entity));
  c.prePost.results.forEach((p) => add(p.entity));
  c.media.results.forEach((p) => add(p.entity));
  c.declared.results.forEach((p) => add(p.entity));
  return m;
}

/**
 * "3 tags denied by policy (ethnicity/inclusivity/credit_card)": from the structured counts when the sheet has
 * them, else from the orchestrator's receipt line (older sheets), else the bare count. Never tag names.
 */
export function deniedLine(guard: GuardReport): string {
  const by = guard.deniedByNamespace;
  const classes = by ? Object.keys(by).filter((k) => (by[k] ?? 0) > 0) : [];
  const n = guard.deniedTagCount;
  if (classes.length > 0) return `${n} ${n === 1 ? "tag" : "tags"} denied by policy (${classes.join("/")})`;
  return guard.reasons.find((r) => /denied by policy/i.test(r)) ?? `${n} ${n === 1 ? "tag" : "tags"} denied by policy`;
}

export function isThinSignal(sheet: StreetSheet): boolean {
  return sheet.cards.liftMap.results.diagnostics.baseline !== "house" || sheet.cards.partners.results.length < 15;
}

export function liftWeak(sheet: StreetSheet): boolean {
  const s = sheet.cards.liftMap.results.diagnostics.spearmanLiftVsHeat;
  return s !== null && s > 0.9;
}

export function ageLabel(legalAgeEnforced: boolean | null): { short: string; inline: string; long: string } {
  if (legalAgeEnforced === true) return { short: "21+", inline: "21+", long: "21+ (Ticketmaster age policy)" };
  if (legalAgeEnforced === false) return { short: "All ages", inline: "all ages", long: "All ages (Ticketmaster age policy)" };
  return { short: "Unknown", inline: "age policy unknown", long: "not on the listing, so treated as all ages" };
}

/** "comedy fans in general" for a sheet that fell back to a genre tag; "the room's usual crowd" otherwise. */
export function baselineName(sheet: StreetSheet): string {
  if (sheet.cards.liftMap.results.diagnostics?.baseline !== "tag") return "the room's usual crowd";
  const raw = sheet.bill.classification ?? "";
  const g = (/\(([^)]+)\)\s*$/.exec(raw)?.[1] ?? raw.split("/").pop() ?? "").trim();
  if (!g || /^(undefined|other|miscellaneous)$/i.test(g)) return "fans of this genre in general";
  return `${/^[A-Z]{2,}/.test(g) ? g : g.toLowerCase()} fans in general`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st ... */
export function ordinal(n: number): string {
  const i = Math.round(n);
  const m100 = Math.abs(i) % 100;
  const m10 = Math.abs(i) % 10;
  return `${i}${m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`;
}

/** "16:00-02:00" -> "4 pm to 2 am" (same wording as the printed sheet). */
export function formatHours(s: string): string {
  const clock = (hh: number, mm: number) => {
    const h = hh % 24;
    if (mm === 0 && h === 0) return "midnight";
    if (mm === 0 && h === 12) return "noon";
    const suffix = h < 12 ? "am" : "pm";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
  };
  return s.replace(/\b(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\b/g, (_m, a: string, b: string, c: string, d: string) => `${clock(Number(a), Number(b))} to ${clock(Number(c), Number(d))}`);
}

const SOURCE_ORDER = ["Q", "T", "P", "C", "L", "A"];

/**
 * Receipt ids as one footnote group: unique, sorted (Q, T, P ... then number), runs collapsed. Returns the groups
 * to show (each with its ids) and how many ids are hidden behind "+N" past `max` groups.
 */
export function receiptGroups(ids: readonly string[], max = 3): { groups: { label: string; ids: string[] }[]; hidden: string[] } {
  const uniq = [...new Set(ids.map((r) => (r ?? "").trim()).filter(Boolean))];
  const parsed = uniq.map((id) => {
    const m = /^([A-Za-z]+)(\d+)$/.exec(id);
    return m ? { id, p: m[1] as string, n: Number(m[2]) } : { id, p: id, n: Number.NaN };
  });
  const rank = (p: string) => (SOURCE_ORDER.indexOf(p) === -1 ? 99 : SOURCE_ORDER.indexOf(p));
  parsed.sort((a, b) => rank(a.p) - rank(b.p) || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0) || a.n - b.n);
  const groups: { label: string; ids: string[] }[] = [];
  let i = 0;
  while (i < parsed.length) {
    let j = i;
    while (j + 1 < parsed.length && parsed[j + 1]!.p === parsed[i]!.p && Number.isFinite(parsed[i]!.n) && parsed[j + 1]!.n === parsed[j]!.n + 1) j++;
    const run = parsed.slice(i, j + 1).map((x) => x.id);
    groups.push({ label: run.length > 1 ? `${run[0]}–${run[run.length - 1]}` : run[0]!, ids: run });
    i = j + 1;
  }
  const shown = groups.slice(0, max);
  return { groups: shown, hidden: groups.slice(max).flatMap((g) => g.ids) };
}

export function ledgerMap(entries: LedgerEntry[]): Map<string, LedgerEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|co|inc|llc)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Ledger id ranges for a footer line, e.g. "Q1-Q18, T1-T2, L1". */
export function ledgerRanges(entries: LedgerEntry[]): string {
  const byPrefix = new Map<string, number[]>();
  for (const e of entries) {
    const prefix = e.id.replace(/\d+$/, "");
    const n = Number(e.id.slice(prefix.length));
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), n]);
  }
  return [...byPrefix.entries()]
    .map(([p, ns]) => {
      const min = Math.min(...ns);
      const max = Math.max(...ns);
      return min === max ? `${p}${min}` : `${p}${min}-${p}${max}`;
    })
    .join(", ");
}

// ---------------------------------------------------------------------------
// Two bills in one room (the landing page's worked example)
// ---------------------------------------------------------------------------

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Eight-point compass direction from `from` to `to` ("north", "southeast", ...). */
export function compassDirection(from: { lat: number; lon: number }, to: { lat: number; lon: number }): (typeof COMPASS)[number] {
  const dy = to.lat - from.lat;
  const dx = (to.lon - from.lon) * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8]!;
}

/** "6.2 km" under 10 km, "19 km" above. */
export function formatKm(km: number): string {
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

export interface TopArea {
  name: string;
  geohash: string;
  lift: number;
  km: number;
  direction: (typeof COMPASS)[number];
  /** What the lift was measured against: the room's own roster, or a genre tag standing in for it. */
  baseline?: "house" | "tag";
}

/**
 * Lift in prose, always naming its baseline. Same thresholds and phrases as
 * `liftInWords` in @walkup/engine (steps.ts), kept here so client bundles don't
 * pull in the engine; test/landing.test.ts checks the two agree. Ratios like
 * "1.8x" belong in tables only.
 */
export function liftPhrase(lift: number, baseline: "house" | "tag" = "house", genre?: string): string {
  const b = baseline === "tag" ? (genre ?? "the genre baseline") : "the room's usual crowd";
  if (!Number.isFinite(lift)) return `compared with ${b}`;
  if (lift < 0.95) return `below ${b}`;
  if (lift < 1.05) return `about the same as ${b}`;
  if (lift < 1.3) return `a little above ${b}`;
  return `about ${(Math.round(lift * 10) / 10).toFixed(1)} times ${b}`;
}

export interface BillComparison {
  /** Both bills play the same venue (by name and city). */
  sameRoom: boolean;
  /** Length of the top lists compared (the shorter of the two, at most `n`). */
  topN: number;
  sharedTop: number;
  partnersA: number;
  partnersB: number;
  /** Partner places on both sheets (matched by normalized name). */
  sharedPartners: number;
  /** Each bill's highest-lift area, with its distance and direction from the venue. */
  a: TopArea | null;
  b: TopArea | null;
}

function topArea(sheet: StreetSheet): TopArea | null {
  const t = topTiles(sheet, 1)[0];
  if (!t) return null;
  const venue = { lat: sheet.bill.venue.lat, lon: sheet.bill.venue.lon };
  return {
    // The sentence adds the distance and direction itself, so a name that already carries them drops them.
    name: areaName(t, 1).replace(/, [\d.]+ km (north|northeast|east|southeast|south|southwest|west|northwest)$/, ""),
    geohash: t.geohash,
    lift: t.lift,
    km: distanceKm(venue, t),
    direction: compassDirection(venue, t),
    // A top area exists only when lift was computed, so "none" (no baseline, no tiles) never reaches here.
    baseline: sheet.cards.liftMap.results.diagnostics?.baseline === "tag" ? "tag" : "house",
  };
}

/** What the two sheets have in common, all read from the sheets themselves. */
export function compareBills(a: StreetSheet, b: StreetSheet, n = 5): BillComparison {
  const topA = topTiles(a, n);
  const topB = topTiles(b, n);
  const inA = new Set(topA.map((t) => t.geohash));
  const partnersA = new Set(a.cards.partners.results.map((p) => normalizeName(p.entity.name)));
  const sameRoom =
    normalizeName(a.bill.venue.name) === normalizeName(b.bill.venue.name) && normalizeName(a.bill.venue.city) === normalizeName(b.bill.venue.city);
  return {
    sameRoom,
    topN: Math.min(topA.length, topB.length),
    sharedTop: topB.filter((t) => inA.has(t.geohash)).length,
    partnersA: a.cards.partners.results.length,
    partnersB: b.cards.partners.results.length,
    sharedPartners: b.cards.partners.results.filter((p) => partnersA.has(normalizeName(p.entity.name))).length,
    a: topArea(a),
    b: topArea(b),
  };
}

/**
 * The comparison in one sentence, e.g. "The two bills share none of their top 5 areas and 2 of their 24 suggested
 * partners: A's crowd stands out most in X, 6.2 km north of The Truth, about 1.5 times the room's usual crowd, and
 * B's in Y, 19 km east, about 2.5 times."
 */
export function comparisonSentence(c: BillComparison, names: { a: string; b: string; venue: string }): string {
  const some = (k: number, of: string) => (k === 0 ? `none of ${of}` : `${k} of ${of}`);
  const areas = c.topN > 0 ? some(c.sharedTop, `their top ${c.topN} areas`) : null;
  const partners =
    c.partnersA === c.partnersB
      ? some(c.sharedPartners, `their ${c.partnersA} suggested partners`)
      : `${c.sharedPartners} suggested ${c.sharedPartners === 1 ? "partner" : "partners"} (of ${c.partnersA} and ${c.partnersB})`;
  const shared = `The two bills share ${areas ? `${areas} and ${partners}` : partners}`;
  if (!c.a || !c.b) return `${shared}.`;
  const ba = c.a.baseline ?? "house";
  const bb = c.b.baseline ?? "house";
  const liftA = liftPhrase(c.a.lift, ba);
  // The second phrase drops the baseline when it is the same one ("about 2.5 times").
  const liftB = ba === bb ? liftPhrase(c.b.lift, bb).replace(/ (the room's usual crowd|the genre baseline|[\w-]+ fans in general)$/, "") : liftPhrase(c.b.lift, bb);
  return (
    `${shared}: ${names.a}'s crowd stands out most in ${c.a.name}, ${formatKm(c.a.km)} ${c.a.direction} of ${names.venue}, ${liftA}, ` +
    `and ${names.b}'s in ${c.b.name}, ${formatKm(c.b.km)} ${c.b.direction}, ${liftB}.`
  );
}

/**
 * The landing's sheets section in recorded mode (Qloo is no longer available): its heading and why nothing new
 * runs, said from what is served. Recordings are called recordings; a sheet marked sample is not one, and when no
 * live run was recorded the section says they are all samples.
 */
export function recordedSheetsSection(sheets: readonly Pick<StreetSheet, "mode">[]): { heading: string; intro: string } {
  const lead = "Qloo is no longer available, so new plans are off.";
  const live = sheets.filter((s) => s.mode === "live").length;
  if (live === 0) {
    return {
      heading: "Sample sheets",
      intro: `${lead} No live run was recorded before it went away, so these are sample sheets with made-up places and numbers.`,
    };
  }
  const intro = `${lead} ${live === sheets.length ? "These sheets were" : "The sheets not marked sample were"} recorded from live runs on the dates shown.`;
  return { heading: "Recorded sheets", intro: live === sheets.length ? intro : `${intro} A sheet marked sample uses made-up places and numbers.` };
}

// ---------------------------------------------------------------------------
// The sheet page: send status, section source lines, partner wording, where the areas sit
// ---------------------------------------------------------------------------

/** Ledger endpoint of every "Send to street team" action (sent, demo, refused or failed). */
export const SEND_ENDPOINT = "resend.emails.send";

export interface SendRecord {
  id: string;
  at: string;
  outcome: "sent" | "demo" | "refused" | "failed";
  recipients: number;
}

/** "1 address", "2 addresses". */
export function addressCount(n: number): string {
  return `${n} ${n === 1 ? "address" : "addresses"}`;
}

/** The send actions in the ledger, oldest first, read from their notes ("sent: message id ...", "demo: not sent. ..."). */
export function sendRecords(entries: readonly LedgerEntry[]): SendRecord[] {
  return entries
    .filter((e) => e.kind === "action" && e.endpoint === SEND_ENDPOINT)
    .map((e) => {
      const note = e.note ?? "";
      const outcome: SendRecord["outcome"] = /^sent\b/.test(note) ? "sent" : /^demo\b/.test(note) ? "demo" : /^refused\b/.test(note) ? "refused" : "failed";
      const count = e.params.recipientCount;
      const list = e.params.recipients;
      return { id: e.id, at: e.startedAt, outcome, recipients: typeof count === "number" ? count : Array.isArray(list) ? list.length : 0 };
    })
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * The sheet's status in words for the meta line and the tab title: "Draft, not sent" until a real send, then
 * "Sent Oct 14, 16:05 UTC to 2 addresses". A demo send never counts as sent.
 */
export function sendStatus(entries: readonly LedgerEntry[]): { line: string; title: string; sent: boolean } {
  const records = sendRecords(entries);
  const sent = records.filter((r) => r.outcome === "sent").at(-1);
  if (sent) {
    return { line: `Sent ${formatDayMonth(sent.at)}, ${formatClockUtc(sent.at)} to ${addressCount(sent.recipients)}`, title: `sent ${formatDayMonth(sent.at)}`, sent: true };
  }
  const demo = records.filter((r) => r.outcome === "demo").at(-1);
  if (demo) return { line: `Draft, not sent (demo send recorded ${formatDayMonth(demo.at)}, ${formatClockUtc(demo.at)})`, title: "draft", sent: false };
  return { line: "Draft, not sent", title: "draft", sent: false };
}

/** The tab title of a finished sheet: "Sample: Hollis Creek String Band at The Truth, street sheet (draft)". */
export function sheetTitle(sheet: StreetSheet, entries: readonly LedgerEntry[] = sheet.ledger): string {
  const who = headlinerName(sheet.bill) || "Untitled bill";
  return `${sheet.mode === "fixture" ? "Sample: " : ""}${who} at ${sheet.bill.venue.name}, street sheet (${sendStatus(entries).title})`;
}

/** One step per send action, added after the run's own steps in "What Walkup decided". */
export function sendSteps(entries: readonly LedgerEntry[]): TraceStep[] {
  return sendRecords(entries).map((r) => {
    const when = `${formatDayMonth(r.at)}, ${formatClockUtc(r.at)}`;
    const decision =
      r.outcome === "sent"
        ? `Sent the sheet to ${addressCount(r.recipients)} on ${when}.`
        : r.outcome === "demo"
          ? `Recorded a demo send for ${addressCount(r.recipients)} on ${when}; nothing left the server.`
          : `Nothing was sent on ${when}: the send was ${r.outcome === "refused" ? "refused" : "not delivered"}.`;
    return { id: `send-${r.id}`, kind: "send", label: "Send", decision, status: r.outcome === "refused" || r.outcome === "failed" ? "error" : "ok", ledgerRefs: [r.id] };
  });
}

/**
 * The muted source line under a section heading: which data, when it was fetched, how much came from cache.
 * "6 Qloo requests, fetched Oct 30 2026, 15:00 UTC, none from cache." Sample sheets say so first. Null when the
 * section cites no request in this ledger.
 */
export function sourceLine(ids: readonly string[], entries: readonly LedgerEntry[], sample: boolean): string | null {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const found = [...new Set(ids)].map((id) => byId.get(id)).filter((e): e is LedgerEntry => e !== undefined && e.kind !== "action");
  if (found.length === 0) return null;
  const kinds = [...new Set(found.map((e) => e.kind))].map((k) => LEDGER_SOURCE_SHORT[k]);
  const n = found.length;
  const what = `${n} ${joinAnd(kinds)} ${n === 1 ? "request" : "requests"}`;
  const latest = found.map((e) => e.startedAt).sort().at(-1) as string;
  const cached = found.filter((e) => e.cacheHit).length;
  const cache = cached === 0 ? "none from cache" : cached === n ? (n === 1 ? "from cache" : "all from cache") : `${cached} from cache`;
  if (sample) return `Sample data standing in for ${what}, ${formatStamp(latest)}${cached > 0 ? `, ${cache}` : ""}.`;
  return `${what}, fetched ${formatStamp(latest)}, ${cache}.`;
}

/**
 * The orchestrator's markdown sentence ("24 of 24 picks also rank for the room's usual crowd, so their scores were
 * marked down ..."): true of nearly every pick, so it tells the reader nothing. Any sentence about the markdown goes.
 */
const PENALTY_SENTENCE = /\s*[^.]*\bmarked down\b[^.]*\./g;

/**
 * The partner section's summary in plain words. Every pick the room's usual crowd ranks as high is marked down,
 * not removed; the summary says so only when the markdown changed the list:
 * "Places the room's usual crowd ranks as high are marked down; 5 of them didn't make the list and come back only if
 * nothing better is open nearby."
 */
export function partnerSummary(sheet: StreetSheet): string {
  let s = sheet.cards.partners.summary.replace(PENALTY_SENTENCE, "");
  const step = sheet.steps?.find((st) => st.id === "partners-usual");
  const m = step ? /\b([\d,]+) places? fell off the list\.?$/.exec(step.decision) ?? /^Dropped ([\d,]+) places?\b/.exec(step.decision) : null;
  const n = m ? Number(m[1]!.replace(/,/g, "")) : 0;
  if (n > 0) {
    const one = n === 1;
    s += ` Places ${baselineName(sheet)} ranks as high are marked down; ${one ? "1 of them didn't make the list and comes" : `${n} of them didn't make the list and come`} back only if nothing better is open nearby.`;
  }
  return s.trim();
}

const CARDINALS = ["north", "east", "south", "west"] as const;

/**
 * Where the numbered areas sit, in one sentence from the venue: "The 4 top areas are 13 km to 24 km from the room,
 * most of them to the east." A direction is named only when more than half the areas share it.
 */
export function spreadSentence(tiles: readonly Pick<LiftTile, "lat" | "lon">[], venue: { lat: number; lon: number }): string | null {
  if (tiles.length === 0) return null;
  const d = tiles.map((t) => ({ km: distanceKm(venue, t), dir: compassDirection(venue, t) }));
  if (d.length === 1) return `The one top area is ${formatKm(d[0]!.km)} ${d[0]!.dir} of the room.`;
  const min = Math.min(...d.map((x) => x.km));
  const max = Math.max(...d.map((x) => x.km));
  const counts = CARDINALS.map((c) => ({ c, n: d.filter((x) => x.dir.includes(c)).length })).sort((a, b) => b.n - a.n);
  const best = counts[0]!;
  const where = best.n * 2 > d.length ? (best.n === d.length ? `all of them to the ${best.c}` : `most of them to the ${best.c}`) : "in different directions";
  const span = formatKm(min) === formatKm(max) ? `about ${formatKm(min)}` : `${formatKm(min)} to ${formatKm(max)}`;
  return `The ${d.length} top areas are ${span} from the room, ${where}.`;
}
