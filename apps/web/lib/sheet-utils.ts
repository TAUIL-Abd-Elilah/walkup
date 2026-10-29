import type { GuardReport, LedgerEntry, LiftTile, Partner, PopularityCheck, PopularPlace, QlooEntity, StreetSheet, TraceStep } from "@walkup/contracts";
import { areaState, DISTANCE_SUFFIX, partnerAreaLabel, withState } from "@walkup/exports/format";
import { tileWhyLine } from "@walkup/exports/sheet-model";
import { formatClockUtc, formatDayMonth, formatStamp, headlinerName, joinAnd, possessive } from "./format";
import { TOP_LIFT } from "./lift";
import { CATEGORY_LABEL, LEDGER_SOURCE_SHORT, tagFallbackName } from "./labels";

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
 * same rule, so these numbers match them everywhere. Each name carries the area's own state ("Silver Spring, MD",
 * the same label as the street sheet, the PDF, the CSVs and the calendar); names that still clash get a distance
 * and direction.
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
  return distinctNames(
    out.map((t) => (t.name ? { ...t, name: areaName(t) } : t)),
    sheet.bill.venue,
  );
}

/** Gives areas that still share a name a distance and direction from the venue ("Nashville-Davidson, 17 km west"). */
export function distinctNames(tiles: LiftTile[], venue: { lat: number; lon: number }): LiftTile[] {
  const count = new Map<string, number>();
  for (const t of tiles) if (t.name) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  return tiles.map((t) =>
    t.name && (count.get(t.name) ?? 0) > 1 ? { ...t, name: `${t.name}, ${formatKm(distanceKm(venue, t))} ${compassDirection(venue, t)}` } : t,
  );
}

type Located = { tiles: LiftTile[]; venue: { lat: number; lon: number } };

/**
 * Two area lists shown side by side (the landing's two bills): a name on both lists gets each area's distance and
 * direction from its own venue, as `distinctNames` does within one list, so "Nashville, TN" on both sides never reads
 * as one area when they are different squares. A name that already carries a distance keeps it.
 */
export function distinctAcross(a: Located, b: Located): [LiftTile[], LiftTile[]] {
  const bare = (name: string) => name.replace(DISTANCE_SUFFIX, "");
  const inB = new Set(b.tiles.flatMap((t) => (t.name ? [bare(t.name)] : [])));
  const both = new Set(a.tiles.flatMap((t) => (t.name && inB.has(bare(t.name)) ? [bare(t.name)] : [])));
  const tag = ({ tiles, venue }: Located): LiftTile[] =>
    tiles.map((t) =>
      t.name && both.has(t.name) && !DISTANCE_SUFFIX.test(t.name) ? { ...t, name: `${t.name}, ${formatKm(distanceKm(venue, t))} ${compassDirection(venue, t)}` } : t,
    );
  return [tag(a), tag(b)];
}

/**
 * An area's display name: its gazetteer name with its own state ("Arlington, VA", from the area's ZIPs, never the
 * venue's), never a geohash. A name that already carries the state, or a tile without ZIPs, is left as it is; a
 * distance suffix ("..., 17 km west") stays last. The state is added by the downloads' own rule (`withState`), so
 * the page and the files can't name an area differently.
 */
export function areaName(t: (Pick<LiftTile, "name"> & Partial<Pick<LiftTile, "zctas">>) | undefined, number?: number): string {
  if (t?.name) return withState(t.name, areaState(t));
  return number ? `Area ${number}` : "Unnamed area";
}

export function allTiles(sheet: StreetSheet): LiftTile[] {
  return [...sheet.cards.liftMap.results.tiles].sort((a, b) => b.lift - a.lift);
}

/**
 * The line under a numbered area, by the downloads' own rule (`tileWhyLine`): the narration's line, else the area's
 * two percentiles, so an area whose line the checks left out still has one, as on the print view and the PDF.
 */
export function tileWhy(sheet: StreetSheet, geohash: string): string | undefined {
  const tile = sheet.cards.liftMap.results.tiles.find((t) => t.geohash === geohash);
  return tile ? tileWhyLine(sheet, tile) : sheet.narration?.tileWhy.find((t) => t.geohash === geohash)?.text;
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
  return tagLabel(index.get(id) ?? tagFallbackName(id));
}

/**
 * A tag name as the sheet writes it: Qloo's spaced hyphen closed up ("Hip - Hop" reads "Hip-Hop", as Ticketmaster
 * lists the genre; "Lo - Fi" reads "Lo-Fi") and a shouted name in sentence case, so "VERSATILE" and "work-life
 * balance" read alike. For tag names only: a place name keeps its own dash ("Yolk - South Loop").
 */
export function tagLabel(name: string): string {
  const n = name.trim().replace(/(\w) - (?=\w)/g, "$1-");
  const shouted = n.length > 3 && /[A-Z]{3}/.test(n) && n === n.toUpperCase();
  const s = shouted ? n.toLowerCase() : n;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Proper adjectives a tag name keeps capitalised inside a sentence: the narrator's list (`PROPER_WORD_RE` in
 * packages/narrator/src/template.ts, kept the same here so no client bundle loads the narrator), so "Tags it shares"
 * says "Mexican" where the partner line beside it does.
 */
const PROPER_TAG_WORD =
  /^(?:American|African|Afro|Latin|Latino|Latina|Caribbean|Irish|Italian|Mexican|Asian|British|English|French|Spanish|Cajun|Creole|Appalachian|Celtic|Black|Southern|Ethiopian|Jamaican|Korean|Japanese|Chinese|Indian|Thai|Vietnamese|Cuban|Mediterranean|Greek|German|Polish|Persian|Peruvian|Brazilian|Hawaiian|Filipino|Turkish|Lebanese)$/;

/**
 * A tag name inside a sentence ("shares the cozy and Mexican tags"): lower case, except a word with two capitals
 * ("R&B", "Hip-Hop") and a proper adjective ("Mexican", "Middle Eastern"), which keep or get their capital.
 */
export function tagInSentence(name: string): string {
  return tagLabel(name)
    .split(/(\s+)/)
    .map((w) =>
      (w.match(/[A-Z]/g)?.length ?? 0) >= 2
        ? w
        : w
            .split("-")
            .map((part) => {
              const cap = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
              return PROPER_TAG_WORD.test(cap) ? cap : part.toLowerCase();
            })
            .join("-"),
    )
    .join("")
    .replace(/\bmiddle eastern\b/gi, "Middle Eastern");
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

/**
 * "comedy fans in general" for a sheet that fell back to a genre tag ("R&B fans in general": a genre with two capitals
 * keeps its case, as the run's steps write it); "the room's usual crowd" otherwise.
 */
export function baselineName(sheet: StreetSheet): string {
  if (sheet.cards.liftMap.results.diagnostics?.baseline !== "tag") return "the room's usual crowd";
  const raw = sheet.bill.classification ?? "";
  const g = (/\(([^)]+)\)\s*$/.exec(raw)?.[1] ?? raw.split("/").pop() ?? "").trim();
  if (!g || /^(undefined|other|miscellaneous)$/i.test(g)) return "fans of this genre in general";
  return `${/[A-Z].*[A-Z]/.test(g) ? g : g.toLowerCase()} fans in general`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st ... */
export function ordinal(n: number): string {
  const i = Math.round(n);
  const m100 = Math.abs(i) % 100;
  const m10 = Math.abs(i) % 10;
  return `${i}${m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`;
}

/** "16:00-02:00" -> "4 pm to 2 am" (same wording as the printed sheet). */
function clock(hh: number, mm: number): string {
  const h = hh % 24;
  if (mm === 0 && h === 0) return "midnight";
  if (mm === 0 && h === 12) return "noon";
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

/**
 * The numbered area (1-5) of the area line a "replaced by the template: tileWhy[i]" note names, found by that line's
 * geohash, or null when it can't be placed. The index counts the lines the checks were given, and those are the
 * sheet's stored lines (narration.tileWhy) less any the checks dropped outright ("(dropped)"), so each dropped line
 * before it shifts it down by one. It is not the area number: a line Claude's draft lost earlier leaves a gap.
 */
export function replacedLineArea(sheet: StreetSheet): (index: number) => number | null {
  const top = topTiles(sheet);
  const tiles = sheet.cards.liftMap.results.tiles;
  const lines = sheet.narration?.tileWhy ?? [];
  const gone = (sheet.guard?.reasons ?? []).flatMap((r) => {
    const m = /^replaced by the template: tileWhy\[(\d+)\]: .*\(dropped\)$/.exec(r);
    return m ? [Number(m[1])] : [];
  });
  return (i) => {
    if (gone.includes(i)) return null;
    const gh = lines[i - gone.filter((d) => d < i).length]?.geohash;
    if (!gh) return null;
    const k = top.findIndex((t) => t.geohash === gh);
    if (k >= 0) return k + 1;
    // A square merged into a numbered area (within 3 km or sharing a ZIP) is that area.
    const tile = tiles.find((t) => t.geohash === gh);
    const merged = tile ? top.findIndex((t) => sameArea(t, tile)) : -1;
    return merged >= 0 ? merged + 1 : null;
  };
}

/**
 * A narration check's note in plain words: "replaced by the template: tileWhy[1]: ..." becomes "Claude's line for
 * area 2 was replaced with fixed wording: ...". Notes it does not recognise come back unchanged.
 *
 * With `areaOfLine` (the sheet's `replacedLineArea`), a replaced area line is placed by its geohash. A line left out
 * ("tileWhy[0]: number 94 is not in this run") counts Claude's own draft, which the sheet doesn't keep, so it is
 * "One of Claude's area lines". Without it, the index is read as the area order ("tileWhy[4]" is area 5).
 */
export function guardNoteText(note: string, areaOfLine?: (index: number) => number | null): string {
  // "replaced by the template: tileWhy[1]: ..." -> the line was swapped for fixed wording, not left out.
  const swapped = /^replaced by the template: (.+)$/.exec(note.trim());
  const m = /^(summary|tileWhy|partnerLines|copyHooks)(?:\[(\d+)\])?: (.+)$/.exec(swapped ? swapped[1]! : note.trim());
  if (!m) return note;
  const [, field, idx, why] = m;
  const n = idx === undefined ? null : !areaOfLine ? Number(idx) + 1 : swapped ? areaOfLine(Number(idx)) : null;
  const what =
    field === "summary"
      ? "Claude's summary"
      : field === "tileWhy"
        ? n === null
          ? "One of Claude's area lines"
          : `Claude's line for area ${n}`
        : field === "partnerLines"
          ? "One of Claude's partner lines"
          : "One of Claude's copy lines";
  const num = /^number (\S+) is not in this run$/.exec(why!);
  const reason = num
    ? `it had a number (${num[1]}) that isn't from this run`
    : why!
        .replace(/geohash not in this run/, "it named an area that isn't on this sheet")
        .replace(/entityId not in this run/, "it named a place that isn't on this sheet")
        .replace(/^duplicate (tile|entity)$/, "it repeated another line");
  const plainReason = reason.replace(/\s*\(dropped\)$/, "");
  // A summary that fails never leaves a gap: the template's summary always stands in (narrator `narrate`).
  if ((swapped || field === "summary") && !/\(dropped\)$/.test(reason)) return `${what} was replaced with fixed wording: ${plainReason}.`;
  return `${what} was left out: ${plainReason}.`;
}

/**
 * 24-hour times inside a sentence ("open 17:00 to 02:00") in the hours column's style ("open 5 pm to 2 am"). For the
 * narration's partner lines, which quote the run's hours as the data has them. A line that already says am or pm
 * anywhere ("9:30 pm", "11:30 AM", "7:30 a.m.", "4:30 to 8 pm") is in 12-hour time and is left as written: a range
 * that shares one suffix has a time with none ("4:30" in "4:30 to 8 pm") that is not 24-hour time.
 */
export function humanTimes(text: string): string {
  // A clock time with am or pm after it: "8 pm", "9:30pm", "11:30 AM", "7:30 a.m.", "9:30:00 pm".
  if (/\b\d{1,2}(?::\d\d){0,2}\s*[AaPp]\.?[Mm]\b/.test(text)) return text;
  return text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/g, (_m, h: string, m: string) => clock(Number(h), Number(m)));
}

export function formatHours(s: string): string {
  // Live Qloo hours carry seconds ("17:00:00-00:00:00"); they are dropped.
  return s.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*[-–]\s*(\d{1,2}):(\d{2})(?::\d{2})?\b/g, (_m, a: string, b: string, c: string, d: string) => `${clock(Number(a), Number(b))} to ${clock(Number(c), Number(d))}`);
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
      : `${some(c.sharedPartners, "their suggested partners")} (${c.partnersA} and ${c.partnersB})`;
  const shared = `The two bills share ${areas ? `${areas} and ${partners}` : partners}`;
  if (!c.a || !c.b) return `${shared}.`;
  const ba = c.a.baseline ?? "house";
  const bb = c.b.baseline ?? "house";
  const liftA = liftPhrase(c.a.lift, ba);
  // The second phrase drops the baseline when it is the same one ("about 2.5 times"); "below" and "a little above"
  // keep it, since they don't read without it.
  const liftB =
    ba === bb
      ? liftPhrase(c.b.lift, bb).replace(/^(about [\d.]+ times) (?:the room's usual crowd|the genre baseline|.+ fans in general)$/, "$1")
      : liftPhrase(c.b.lift, bb);
  return (
    `${shared}: ${possessive(names.a)} crowd stands out most in ${c.a.name}, ${formatKm(c.a.km)} ${c.a.direction} of ${names.venue}, ${liftA}, ` +
    `and ${possessive(names.b)} in ${c.b.name}, ${formatKm(c.b.km)} ${c.b.direction}, ${liftB}.`
  );
}

/**
 * The landing's sheets section in recorded mode (live runs are paused): its heading and why nothing new
 * runs, said from what is served. Recordings are called recordings; a sheet marked sample is not one, and when no
 * live run was recorded the section says they are all samples.
 */
export function recordedSheetsSection(sheets: readonly Pick<StreetSheet, "mode">[]): { heading: string; intro: string } {
  const lead = "Live runs are paused for judging.";
  const live = sheets.filter((s) => s.mode === "live").length;
  if (live === 0) {
    return {
      heading: "Sample sheets",
      intro: `${lead} No live run was recorded on this server, so these are sample sheets with made-up places and numbers.`,
    };
  }
  const intro = `${lead} ${live === sheets.length ? "These sheets were" : "The sheets not marked sample were"} recorded from live Qloo and Ticketmaster runs on the dates shown; any change since was made offline, with no API call.`;
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

/**
 * The tab title of a finished sheet: "Sample: Hollis Creek String Band at The Truth, street sheet (draft)". A revision
 * names its change note, so its tab and history entry differ from the sheet it revises:
 * "... street sheet, revised: “No restaurants” (draft)".
 */
export function sheetTitle(sheet: StreetSheet, entries: readonly LedgerEntry[] = sheet.ledger): string {
  const who = headlinerName(sheet.bill) || "Untitled bill";
  const note = sheet.revision?.instruction?.trim();
  const rev = note ? `, revised: “${note}”` : "";
  return `${sheet.mode === "fixture" ? "Sample: " : ""}${who} at ${sheet.bill.venue.name}, street sheet${rev} (${sendStatus(entries).title})`;
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
    s += ` Places ${baselineName(sheet)} ranks as high are marked down; ${one ? "1 of them dropped off the list and comes" : `${n} of them dropped off the list and come`} back only if nothing better is open nearby.`;
  }
  return s.trim();
}

/** "POINT(-77.01965 38.921814)", a Qloo location filter: longitude first. */
const WKT_POINT = /^POINT\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)$/;

/**
 * The lift-map areas a partner search ran in, read from the partner section's receipts: each search is centred on its
 * area's point, so an area whose places were all left out later (an exclusion, a closed day) still counts as searched.
 * The areas that kept a partner are always in it.
 */
export function partnerSearchAreas(sheet: StreetSheet): Set<string> {
  const env = sheet.cards.partners;
  const out = new Set(env.results.map((p) => p.tileGeohash).filter((g): g is string => !!g));
  const byId = ledgerMap(sheet.ledger);
  const tiles = sheet.cards.liftMap.results.tiles;
  for (const id of env.provenance) {
    const loc = byId.get(id)?.params["filter.location"];
    const m = typeof loc === "string" ? WKT_POINT.exec(loc.trim()) : null;
    if (!m) continue;
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    const t = tiles.find((x) => Math.abs(x.lat - lat) < 1e-6 && Math.abs(x.lon - lon) < 1e-6);
    if (t) out.add(t.geohash);
  }
  return out;
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

/** "3,500 m" -> "3.5 km"; "2,000 m" -> "2 km". Distances of a kilometre or more read in km, as everywhere else. */
function metresToKm(text: string): string {
  return text.replace(/\b(\d{1,3}(?:,\d{3})+|\d{4,})\s?m\b/g, (_, n: string) => {
    const km = Number(n.replace(/,/g, "")) / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1).replace(/\.0$/, "")} km`;
  });
}

/**
 * A run's own words (a section's "Why", a step's decision, a map note) for the page: internal keys become the
 * words the rest of the sheet uses ("record_store" -> "record store"), metres over 1,000 become km, a lone "seed"
 * is an act, and "1 type of place that have" agrees. Never changes a name or a number's value.
 */
export function plainText(text: string): string {
  let s = metresToKm(text);
  s = s.replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (key) => (CATEGORY_LABEL[key] ?? key.replace(/_/g, " ")).toLowerCase());
  s = s.replace(/\b1 (type|kind) of place that have\b/g, "1 $1 of place that has");
  s = s.replace(/\bone seed\b/g, "one act").replace(/\bseeds\b/g, "acts").replace(/\bseed\b/g, "act");
  s = s
    .replace(/\b(?:wouldn't|would not) make a list of the most popular places\b/g, "aren't among the most popular places")
    .replace(/\bwould also make a list of the most popular places\b/g, "are also among the most popular places")
    .replace(/\bno pinned tag yet\b/g, "no Qloo tag set up for it yet");
  return s;
}

/**
 * The popularity check in one plain sentence: how many partners are not among the most popular places in their
 * areas, so a list built on popularity alone would leave them out.
 */
export function popularityLine(c: Pick<PopularityCheck, "partners" | "notInPopularTop" | "perArea">): string {
  const near = c.perArea.length === 1 && c.perArea[0]?.tileGeohash === null;
  const where = near ? "near the venue" : c.perArea.length === 1 ? "in their area" : "in their areas";
  const n = c.notInPopularTop;
  if (c.partners === 1) {
    return n === 1
      ? `The one partner isn't among the most popular places ${near ? "near the venue" : "in its area"}, so a popularity list would miss it.`
      : `The one partner is also among the most popular places ${near ? "near the venue" : "in its area"}.`;
  }
  if (n === 0) return `All ${c.partners} partners are also among the most popular places ${where}.`;
  if (n === c.partners) return `None of the ${c.partners} partners is among the most popular places ${where}, so a popularity list would miss all of them.`;
  if (n === 1) return `1 of the ${c.partners} partners isn't among the most popular places ${where}, so a popularity list would miss it.`;
  return `${n} of the ${c.partners} partners aren't among the most popular places ${where}, so a popularity list would miss them.`;
}

// ---------------------------------------------------------------------------
// The landing's story: one real pick a popularity list would miss, and one area side by side
// ---------------------------------------------------------------------------

/** One partner as the landing names it: where, and its rank for this crowd and for the room's usual crowd. */
export interface RankedPick {
  entityId: string;
  name: string;
  /** Its area, named as on the map ("Langston, DC"). */
  area: string;
  /** Rank in the partner search with this bill as the signal (1 = best). */
  billRank: number;
  /** Rank in the same search for the room's usual crowd, or null when it isn't in that list. */
  houseRank: number | null;
  /** The receipts: the partner search, the usual-crowd search and the popularity-only search. */
  refs: string[];
}

/** One partner area of the popularity check with the picks Walkup made there, best first. */
export interface PopularityArea {
  geohash: string;
  area: string;
  /** How many places the popularity-only list was cut to (as many as the area has partners). */
  k: number;
  /** Of Walkup's picks here, how many are not in that list. */
  notInPopularTop: number;
  /** Ledger id of the popularity-only search for this area. */
  popularRef: string;
  picks: RankedPick[];
  /**
   * The places the picks were compared with, by name: the area's popularity-only list, best first (the sheet's
   * `popularTop`). Null on sheets made before it was stored, or when a name is missing.
   */
  popular: PopularPlace[] | null;
}

function rankedPick(p: Partner, popularRef: string, tiles: ReadonlyMap<string, LiftTile>): RankedPick | null {
  if (typeof p.qlooRank !== "number") return null;
  const refs = [...new Set([...(p.explain?.ledgerRefs ?? p.chips.map((c) => c.ledgerRef)), popularRef])];
  return {
    entityId: p.entity.entityId,
    name: p.entity.name,
    area: partnerAreaLabel(p, tiles) || "its area",
    billRank: p.qlooRank,
    houseRank: typeof p.houseRank === "number" ? p.houseRank : null,
    refs,
  };
}

/**
 * The popularity check's partner areas, in the sheet's order, each with Walkup's picks there and their two ranks.
 * Only areas with a tile (not the near-venue list) and at least one ranked pick.
 */
export function popularityAreas(sheet: StreetSheet): PopularityArea[] {
  const pc = sheet.popularityCheck;
  if (!pc) return [];
  const tiles = new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  const out: PopularityArea[] = [];
  for (const a of pc.perArea) {
    if (!a.tileGeohash || a.partners <= 0) continue;
    const picks = sheet.cards.partners.results
      .filter((p) => p.tileGeohash === a.tileGeohash)
      .map((p) => rankedPick(p, a.ledgerRef, tiles))
      .filter((x): x is RankedPick => x !== null)
      .sort((x, y) => x.billRank - y.billRank);
    if (picks.length === 0) continue;
    const tile = tiles.get(a.tileGeohash);
    out.push({
      geohash: a.tileGeohash,
      area: tile?.name ? areaName(tile) : a.tileName ? areaName({ name: a.tileName, ...(tile?.zctas ? { zctas: tile.zctas } : {}) }) : "this area",
      k: a.partners,
      notInPopularTop: a.notInPopularTop,
      popularRef: a.ledgerRef,
      picks,
      popular: a.popularTop && a.popularTop.length > 0 && a.popularTop.every((x) => x.name.trim() !== "") ? [...a.popularTop].sort((x, y) => x.rank - y.rank) : null,
    });
  }
  return out;
}

/**
 * One real pick a popularity list would miss: from an area where none of Walkup's picks is among the area's most
 * popular places (so this one surely isn't), the pick this crowd ranks furthest above the room's usual crowd. A pick
 * with both ranks beats one the usual crowd doesn't rank at all (two numbers say more); ties go to the better rank
 * for this crowd. National chains are skipped. Null when no area qualifies.
 */
export function missedPick(sheet: StreetSheet): (RankedPick & { k: number }) | null {
  let best: (RankedPick & { k: number }) | null = null;
  const key = (p: RankedPick): [number, number, number] => (p.houseRank === null ? [0, 0, -p.billRank] : [1, p.houseRank - p.billRank, -p.billRank]);
  const better = (x: RankedPick, y: RankedPick) => {
    const [a, b] = [key(x), key(y)];
    return a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  };
  // A national chain is never the example: a popularity list missing a Ross or a Starbucks says little.
  const chains = new Set(sheet.cards.partners.results.filter((p) => p.chain).map((p) => p.entity.entityId));
  for (const a of popularityAreas(sheet)) {
    if (a.notInPopularTop < a.k) continue;
    for (const p of a.picks) {
      if (chains.has(p.entityId)) continue;
      if (p.houseRank !== null && p.houseRank <= p.billRank) continue;
      if (!best || better(p, best)) best = { ...p, k: a.k };
    }
  }
  return best;
}

/** "Stable DC in Langston, DC: 7th for this crowd, 14th for the room's usual crowd, and not among the area's 4 most popular places." */
export function missedPickLine(p: RankedPick & { k: number }): string {
  const house = p.houseRank === null ? "not ranked for the room's usual crowd" : `${ordinal(p.houseRank)} for the room's usual crowd`;
  return `${p.name} in ${p.area}: ${ordinal(p.billRank)} for this crowd, ${house}, and not among the area's ${p.k} most popular places.`;
}

// ---------------------------------------------------------------------------
// With Qloo and without: one area's popularity-only list beside Walkup's picks there
// ---------------------------------------------------------------------------

/** One area of a sheet, both lists by name: what popularity alone gives and what Walkup picked for this crowd. */
export interface WithWithoutArea {
  /** The area's tile; null for the near-venue list. */
  geohash: string | null;
  /** "Laurel, MD", or "near the room" for the near-venue list. */
  area: string;
  /** How many places each list holds (the area's partners; the popularity list is cut to the same length). */
  k: number;
  /** Places on both lists. */
  overlap: number;
  /** The popularity-only list, best first (Qloo's no-signal place search, after the same eligibility rules). */
  popular: PopularPlace[];
  /** Walkup's picks in the area, by rank for this crowd. */
  picks: RankedPick[];
  /** Ledger id of the popularity-only search. */
  popularRef: string;
  /** Ledger ids of the partner searches behind the picks (this crowd, the room's usual crowd). */
  pickRefs: string[];
  /** The measured fact, as a heading: "None of the 8 most popular places in Laurel, MD made Walkup's list". */
  headline: string;
}

/** The headline for one area: how many of its k most popular places are also Walkup picks, counted on the sheet. */
export function withWithoutHeadline(area: string, k: number, overlap: number): string {
  const where = area === "near the room" ? "near the room" : `in ${area}`;
  if (k === 1) return overlap === 0 ? `The most popular place ${where} didn't make Walkup's list` : `The most popular place ${where} is also on Walkup's list`;
  if (overlap === 0) return `None of the ${k} most popular places ${where} made Walkup's list`;
  if (overlap === k) return `All ${k} of the most popular places ${where} are also on Walkup's list`;
  return `${overlap * 2 <= k ? "Only " : ""}${overlap} of the ${k} most popular places ${where} made Walkup's list`;
}

/**
 * One area per sheet for the "with Qloo and without" table: of the sheet's partner areas whose popularity-only list
 * is stored by name (`popularTop`), the one where the most picks are not among its most popular places (then the
 * larger share, then the sheet's order). The near-venue list counts only when no numbered area has one. Null when
 * the sheet has no popularity check, or no names were stored.
 */
export function withWithout(sheet: StreetSheet): WithWithoutArea | null {
  const pc = sheet.popularityCheck;
  if (!pc) return null;
  const tiles = new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  const rows: WithWithoutArea[] = [];
  for (const a of pc.perArea) {
    if (a.partners <= 0 || !a.popularTop || a.popularTop.length === 0 || a.popularTop.some((x) => x.name.trim() === "")) continue;
    const parts = sheet.cards.partners.results.filter((p) => (p.tileGeohash ?? null) === a.tileGeohash);
    const picks = parts
      .map((p) => rankedPick(p, a.ledgerRef, tiles))
      .filter((x): x is RankedPick => x !== null)
      .sort((x, y) => x.billRank - y.billRank);
    if (picks.length === 0) continue;
    const tile = a.tileGeohash ? tiles.get(a.tileGeohash) : undefined;
    const area = !a.tileGeohash
      ? "near the room"
      : tile?.name
        ? areaName(tile)
        : a.tileName
          ? areaName({ name: a.tileName, ...(tile?.zctas ? { zctas: tile.zctas } : {}) })
          : "this area";
    const popular = [...a.popularTop].sort((x, y) => x.rank - y.rank);
    const overlap = popular.filter((x) => x.onSheet).length;
    const pickRefs = [...new Set(parts.flatMap((p) => p.explain?.ledgerRefs ?? p.chips.map((c) => c.ledgerRef)))].filter((r) => r && r !== a.ledgerRef);
    rows.push({
      geohash: a.tileGeohash,
      area,
      k: a.partners,
      overlap,
      popular,
      picks,
      popularRef: a.ledgerRef,
      pickRefs,
      headline: withWithoutHeadline(area, a.partners, overlap),
    });
  }
  const numbered = rows.filter((r) => r.geohash !== null);
  const pool = numbered.length > 0 ? numbered : rows;
  let best: WithWithoutArea | null = null;
  for (const r of pool) {
    const missed = r.k - r.overlap;
    if (!best) {
      best = r;
      continue;
    }
    const bMissed = best.k - best.overlap;
    if (missed > bMissed || (missed === bMissed && missed / r.k > bMissed / best.k)) best = r;
  }
  return best;
}

/** "3rd for this crowd · 25th for the room's usual crowd" (or "not in the usual crowd's list"). */
export function pickRanksLine(p: Pick<RankedPick, "billRank" | "houseRank">): string {
  return `${ordinal(p.billRank)} for this crowd · ${p.houseRank === null ? "not ranked for the room's usual crowd" : `${ordinal(p.houseRank)} for the room's usual crowd`}`;
}

// ---------------------------------------------------------------------------
// The run's footprint, counted from the sheet's own ledger
// ---------------------------------------------------------------------------

/** What one run sent, counted from its ledger: never typed in by hand. */
export interface RunFootprint {
  /** Qloo requests. */
  qloo: number;
  /** Kinds of Qloo request: the endpoint, and for /v2/insights the entity or output type asked for. */
  kinds: number;
  /** Qloo requests answered from Walkup's own cache of earlier live answers. */
  cached: number;
  /** Ticketmaster requests. */
  tm: number;
  /** Model calls (narration, reading a change note). */
  model: number;
}

/** "/v2/insights urn:heatmap", "/search": one Qloo request kind. */
function requestKind(e: LedgerEntry): string {
  const path = e.endpoint.split("?")[0] ?? e.endpoint;
  const type = e.params?.["filter.type"];
  return typeof type === "string" && type !== "" ? `${path} ${type}` : path;
}

export function runFootprint(entries: readonly LedgerEntry[]): RunFootprint {
  const qloo = entries.filter((e) => e.kind === "qloo");
  return {
    qloo: qloo.length,
    kinds: new Set(qloo.map(requestKind)).size,
    cached: qloo.filter((e) => e.cacheHit).length,
    tm: entries.filter((e) => e.kind === "tm").length,
    model: entries.filter((e) => e.kind === "anthropic").length,
  };
}

/**
 * The footprint in one plain line for the top of a live sheet: "Made with 30 Qloo requests of 9 kinds (19 answered
 * from Walkup's cache of earlier live calls), 2 Ticketmaster requests and 1 Claude call. Keys stay on the server."
 * Null when the run made no Qloo request.
 */
export function footprintLine(f: RunFootprint): string | null {
  if (f.qloo === 0) return null;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const cache =
    f.cached === 0
      ? "none answered from cache"
      : f.cached === f.qloo
        ? `${f.qloo === 1 ? "answered" : `all ${f.qloo} answered`} from Walkup's cache of earlier live calls`
        : `${f.cached} answered from Walkup's cache of earlier live calls`;
  const others = [f.tm > 0 ? n(f.tm, "Ticketmaster request", "Ticketmaster requests") : null, f.model > 0 ? n(f.model, "Claude call", "Claude calls") : null].filter(
    (x): x is string => x !== null,
  );
  const qloo = `${n(f.qloo, "Qloo request", "Qloo requests")}${f.kinds > 1 ? ` of ${f.kinds} kinds` : ""} (${cache})`;
  return `Made with ${joinAnd([qloo, ...others])}. Keys stay on the server.`;
}

// ---------------------------------------------------------------------------
// The landing's rooms
// ---------------------------------------------------------------------------

/**
 * Which room pair the landing opens on and which it shows second, from the pairs in page order (null where either
 * sheet is not served): the first served pair is the worked example; the next one served as two live recordings is
 * the second room (a second room is never a sample).
 */
export function landingRooms<T extends Pick<StreetSheet, "mode">>(
  pairs: readonly ({ a: T; b: T } | null)[],
): { hero: { a: T; b: T } | null; second: { a: T; b: T } | null } {
  const served = pairs.filter((p): p is { a: T; b: T } => p !== null);
  const hero = served[0] ?? null;
  const second = served.slice(1).find((p) => p.a.mode === "live" && p.b.mode === "live") ?? null;
  return { hero, second };
}
