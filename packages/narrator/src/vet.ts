/**
 * A deterministic guard for model-written narration and for fan copy, used twice: by narrate() right after
 * the model answers, and by the web app when it shows a stored sheet (so older sheets get the same checks).
 * Pure: no SDK, no network, no clock. Imports only contracts and this package's pure modules.
 *
 * Narration (summary, tile lines, partner lines): a line that fails is replaced by the template's line for
 * the same slot (the builders in template.ts), or dropped when the template has none.
 * - Directions: "western suburbs", "north of", "southeast" must match the compass bearing from the venue of
 *   the area the line is about (8 points, the neighbouring point allowed). In the summary, the bearing of an
 *   area named in the same sentence, or, when none is named, of most of the sheet's top areas.
 * - Unbacked claims: forecasts ("expected", "projected"), "concentrated" / "most common" and where a crowd lives
 *   or comes from ("draws a crowd from outer suburbs") always fail. A superlative ("the most", "largest",
 *   "highest", "strongest") passes only when it is about lift, bill percentile, adult population or the budget
 *   split and the area it is about really has the maximum. The room's usual crowd placed in areas ("sits closer
 *   to Oak Park") passes only for areas below a lift of 1; "the South Side of <city>" always fails. "Stands out
 *   most in A, B and C" passes only when no area left out of the list stands out more than one in it.
 * - An area's own numbers: a percentile an area line cites must be one of that area's two (for this crowd, for
 *   the room's usual crowd, as the template rounds them), "about N times" its lift, a budget percent its share. A
 *   figure written just after another area's name or set against another ("more than 2 times") is not the area's
 *   own; in the summary, only figures within a few words of the one area a sentence names are. An "equal" or "same"
 *   budget split must be equal on the sheet ("about evenly" and "the other four areas": within half a point). "The
 *   Midlothian spots" fails: an area's places are partners, and the sheet's spots are near the room.
 * - Partner lines: may name only the tags the partner panel shows as "Tags it shares" (`explain.tags`; the
 *   place's own tags on sheets without them). Any genre or audience word known to the sheet that is not one
 *   of them fails the line, as does a weekday other than the street-team day, "close to the room" for a place
 *   more than 2 km from it (3.5 km for the near-venue list), opening hours that are not one of the place's
 *   own spans for the day, and a before- or after-show stop for a place not on the sheet's spots list.
 *
 * Fan copy: audience and identity tags never appear, no line calls the room small or close ("an intimate room"),
 * and every line names the act.
 */
import { aboutTimes, type CopyHook, type LiftTile, type Partner, type StreetSheet } from "@walkup/contracts";
import { audienceWordIn, isAudienceTag, normalizeWords } from "./audience";
import { displayDate, headlinerName, type PreparedRun } from "./facts";
import { blankProtected, isDeniedTag } from "./policy";
import { ordinal, templatePartnerLine, templateSummary, templateTileWhy } from "./template";
import type { NarrateInput } from "./types";

export { isAudienceTag } from "./audience";

/** The narration block a sheet carries. */
export type Narration = NonNullable<StreetSheet["narration"]>;

type TagLike = { id: string; name?: string };

// ---------------------------------------------------------------------------
// Geography
// ---------------------------------------------------------------------------

const GEOHASH_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
export const COMPASS_POINTS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;

/** Centre of a geohash cell, or null for an invalid hash. */
export function geohashCenter(geohash: string): { lat: number; lon: number } | null {
  const gh = (geohash ?? "").trim().toLowerCase();
  if (!gh) return null;
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let even = true;
  for (const c of gh) {
    const v = GEOHASH_BASE32.indexOf(c);
    if (v < 0) return null;
    for (let b = 4; b >= 0; b--) {
      const bit = (v >> b) & 1;
      if (even) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid;
        else latMax = mid;
      }
      even = !even;
    }
  }
  return { lat: (latMin + latMax) / 2, lon: (lonMin + lonMax) / 2 };
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** 0 = north, 1 = northeast, ... 7 = northwest (the same rule as the web app's compassDirection). Null for one point. */
export function compassIndex(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number | null {
  const dy = to.lat - from.lat;
  const dx = (to.lon - from.lon) * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return Math.round(deg / 45) % 8;
}

function tilePoint(t: Pick<LiftTile, "lat" | "lon" | "geohash">): { lat: number; lon: number } | null {
  if (finite(t.lat) && finite(t.lon)) return { lat: t.lat, lon: t.lon };
  return geohashCenter(t.geohash);
}

const POINT_INDEX: Record<string, number> = { north: 0, northeast: 1, east: 2, southeast: 3, south: 4, southwest: 5, west: 6, northwest: 7 };
const DIRECTION_RE = /\b(?:(north|south)[\s-]?(east|west)|(north|south|east|west))(?:ern|erly|wards?|side)?\b/gi;

/** Compass points claimed in `text` (after names were blanked). */
function directionClaims(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(DIRECTION_RE)) {
    const word = (m[1] && m[2] ? `${m[1]}${m[2]}` : (m[3] ?? "")).toLowerCase();
    const i = POINT_INDEX[word];
    if (i !== undefined) out.push(i);
  }
  return out;
}

function pointDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 8;
  return Math.min(d, 8 - d);
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const ALWAYS_UNBACKED: ReadonlyArray<[RegExp, string]> = [
  [/\bexpected\b/i, 'forecast ("expected") not backed by the sheet'],
  [/\b(?:projected|forecast(?:ed|s)?|predicted|predicts?)\b/i, "forecast not backed by the sheet"],
  [/\bwill (?:draw|sell|fill|buy|attend|come|show up)\b/i, "forecast not backed by the sheet"],
  [/\bconcentrat(?:ed|ion|es)\b/i, '"concentrated" is not backed by the map'],
  [/\bmost common\b/i, '"most common" is not backed by the sheet'],
  [/\bmost likely\b/i, '"most likely" is not backed by the sheet'],
  // The map shows where this crowd stands out, never where anyone lives or travels from. "Draws a different crowd
  // from the room's usual one" is a comparison, not a place.
  [
    /\bdraws?\s+(?:a|its|the|this)?\s*(?:(?!(?:different|other|distinct|separate)\b)\w+\s+)?crowd\s+from\b(?!\s+(?:the\s+)?(?:(?:room|venue)['’]s\s+|its\s+|their\s+)?(?:usual|regular)\b|\s+['’]s\s+(?:usual|regular)\b|\s+that\s+of\b)|\bcrowd\s+(?:comes?|travels?)\s+from\b|\b(?:fans|crowd|buyers)\s+(?:live|lives|living)\s+in\b/i,
    "where the crowd lives or comes from is not on the sheet",
  ],
];

/**
 * "the room's usual crowd sits closer to Evanston and Oak Park": a place for the usual crowd, named after it. The usual
 * crowd must be the verb's subject ("... the room's usual crowd and is in the 96th percentile" is about the area; in
 * "the usual crowd that sits near Shaw" it still is), and a percentile is not a place.
 */
const USUAL_CROWD_PLACED_RE =
  /\busual crowd(?:'s)?\s+(?:(?!(?:and|but|while|whereas)\b)\w+\s+){0,2}?(?:sits?|is|are|lives?|leans?|skews?|clusters?|cent(?:er|re)s?)\s+(?:\w+\s+)?(?:closer to|near|in|around|towards?)\b(?!\s+(?:the\s+|its\s+|about\s+)?\d)/i;

/**
 * The room's usual crowd put in areas: backed only when every area named after it has a lift below 1 (the usual
 * crowd ranks it higher than this bill's crowd does). Oak Park at about 2.1 times is where this crowd stands out.
 * Not checked when no area on the sheet is named after it.
 */
function usualCrowdPlacedProblem(ctx: VetContext, sentence: string): string | null {
  const m = USUAL_CROWD_PLACED_RE.exec(sentence);
  if (!m) return null;
  const named = tilesNamedIn(ctx, sentence.slice((m.index ?? 0) + m[0].length));
  if (named.length === 0 || named.every((t) => finite(t.lift) && t.lift < 1)) return null;
  return "places the room's usual crowd in areas where this crowd stands out";
}

const SIDE_WORDS = "north|south|east|west|northwest|southwest|northeast|southeast|near\\s+(?:north|south|east|west)";

/**
 * "areas on the South Side of Chicago": a city's sides are not on the map, and a suburb in the list makes it false.
 * Checked on the raw sentence (the city's name is blanked in the other checks).
 */
function citySideProblem(ctx: VetContext, sentence: string): string | null {
  const city = ctx.venueCity ? `|${escapeRe(ctx.venueCity)}` : "";
  const re = new RegExp(`\\b(?:${SIDE_WORDS})(?:\\s+and\\s+(?:${SIDE_WORDS}))?\\s+sides?\\s+of\\s+(?:the\\s+city${city})\\b`, "i");
  return re.test(sentence) ? "places the areas on a side of the city, which the map doesn't show" : null;
}

/** "is close to the room", "a short walk from the venue": nearness to the room the sheet must back with its distance. */
const NEAR_ROOM_RE =
  /\b(?:close to|near(?:by)?|next to|steps from|a short walk (?:from|to)|walking distance (?:of|from|to)|around the corner from|minutes from)\s+(?:the\s+)?(?:room|venue|show|hall|club|theater|theatre)\b/i;
/** The farthest a partner from an area's search can be from the room for a line to call it close. */
const NEAR_ROOM_KM = 2;
/**
 * The near-venue list (partners with no area) is searched within 3.5 km of the venue (the orchestrator's
 * TILE_RADIUS_WIDE_M), and the template calls those places "near the venue": a line may too.
 */
const NEAR_VENUE_LIST_KM = 3.5;

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * A partner line calling the place close to the room when the sheet puts it farther than NEAR_ROOM_KM away
 * (NEAR_VENUE_LIST_KM for the near-venue list).
 */
function nearRoomProblem(ctx: VetContext, text: string, partner: Partner | undefined): string | null {
  const venueName = ctx.venueName ? new RegExp(`\\b(?:close to|near|next to|steps from|around the corner from|minutes from)\\s+${escapeRe(ctx.venueName)}`, "i") : null;
  if (!NEAR_ROOM_RE.test(text) && !(venueName && venueName.test(text))) return null;
  const loc = partner?.entity?.location;
  const listed = partner?.explain?.distanceKm;
  const km = finite(listed) ? listed : ctx.venue && loc && finite(loc.lat) && finite(loc.lon) ? haversineKm(ctx.venue, loc) : null;
  const limit = partner && !partner.tileGeohash ? NEAR_VENUE_LIST_KM : NEAR_ROOM_KM;
  if (km !== null && km <= limit) return null;
  return km === null ? "says the place is near the room; the sheet has no distance for it" : `says the place is near the room; the sheet puts it ${km.toFixed(1)} km away`;
}

/** "10:00:00-14:00:00, 17:00:00-21:30:00" (optionally after "Sat ") as ["10:00-14:00", "17:00-21:30"]. */
function hourSpans(hoursOnDay: string | null | undefined): string[] {
  return (hoursOnDay ?? "")
    .replace(/^[A-Z][a-z]{2} /, "")
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s
        .split(/\s*[-–]\s*/)
        .map((t) => t.slice(0, 5).padStart(5, "0"))
        .join("-"),
    );
}

/**
 * Opening hours quoted as one span ("10:00 to 21:30") must be one of the place's own spans for the day: "open
 * Saturday 10:00 to 21:30" for a place closed from 14:00 to 17:00 fails. Not checked when the sheet lists no hours.
 */
function hoursProblem(text: string, partner: Partner | undefined): string | null {
  const spans = hourSpans(partner?.hoursOnDay);
  if (spans.length === 0) return null;
  for (const m of text.matchAll(/\b(\d{1,2}:\d{2})\s*(?:to|-|–)\s*(\d{1,2}:\d{2})\b/g)) {
    const span = `${m[1]!.padStart(5, "0")}-${m[2]!.padStart(5, "0")}`;
    if (!spans.includes(span)) return spans.length > 1 ? "merges split opening hours into one span" : "quotes hours the place doesn't list";
  }
  return null;
}

const SUPERLATIVE_RE = /\bthe\s+most\b|\b(?:largest|highest|biggest|greatest|strongest)\b/gi;

type Metric = "lift" | "billPct" | "adults" | "budget";

const METRIC_CUES: ReadonlyArray<[Metric, RegExp]> = [
  ["budget", /\bbudget\b|\bsplit\b/i],
  ["adults", /\badults?\b|\bpopulation\b|\bresidents\b/i],
  ["billPct", /\bbill(?:'s)?\s+(?:crowd(?:'s)?\s+)?(?:share|percentile)\b|\bshare of (?:the |this )?(?:bill|crowd)\b|\bpercentile\b/i],
  ["lift", /\blift\b|\btimes\b|\bstands? out\b|\bover-?index/i],
];

/**
 * The metric a superlative is about: the one named first after it. "The largest lift on the sheet, about 2.2 times
 * the room's usual crowd, at the 98th percentile" is about lift, not the percentile named later.
 */
function metricOf(window: string): Metric | null {
  let best: { metric: Metric; at: number } | null = null;
  for (const [metric, re] of METRIC_CUES) {
    const at = window.search(re);
    if (at >= 0 && (best === null || at < best.at)) best = { metric, at };
  }
  return best?.metric ?? null;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Partner tags and weekdays
// ---------------------------------------------------------------------------

/** Namespaces whose tag names count as genre or audience words in a partner line. Place genres are not genres. */
function isVocabTag(t: TagLike): boolean {
  const id = t.id.toLowerCase();
  if (id.startsWith("urn:tag:genre:place")) return false;
  if (id.startsWith("urn:tag:genre:") || id.startsWith("urn:tag:subgenre:") || id.startsWith("urn:tag:influence:")) return true;
  // Audience tags count only when their name describes people ("Diverse"), not everyday words ("Engaged").
  return isAudienceTag({ id }) && audienceWordIn(t.name ?? id.split(":").pop() ?? "") !== null;
}

/** Genre words a partner line may not use unless the place shares that tag, even when no tag on the sheet names them. */
const GENRE_WORDS = [
  "country",
  "folk",
  "jazz",
  "blues",
  "rhythm and blues",
  "r and b",
  "soul",
  "gospel",
  "hip hop",
  "rap",
  "americana",
  "bluegrass",
  "reggae",
  "punk",
  "funk",
  "edm",
  "techno",
  "dubstep",
  "zydeco",
  "dancehall",
  "afrobeats",
  "classical",
  "alt country",
  "singer songwriter",
];

/** Everyday phrases that contain a genre word without meaning the genre. Removed before the check. */
const NOT_GENRE_PHRASES = ["soul food", "country club", "country style", "country fried", "country breakfast", "folk art", "pop up", "rap sheet"].map(
  (p) => normalizeWords(p),
);

/** Words that may sit around tag names in "shares the bill's X and Y tags". */
const TAG_PHRASE_FILLER = new Set(["the", "a", "an", "and", "or", "its", "it", "this", "that", "bill", "bill's", "bills", "crowd", "crowd's", "show's", "same", "also", "both", "with", "of", "music", "genre", "s"]);
const TAG_PHRASE_RE = /\b(?:shar\w*|cit\w*|carr\w*|with|has|have)\s+(.{1,80}?)\s+tags?\b/gi;

const WEEKDAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/gi;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface VetContext {
  venue: { lat: number; lon: number } | null;
  venueName: string;
  venueCity: string;
  /** Every area the sheet shows (superlatives are checked against these). */
  pool: LiftTile[];
  /** The areas the narration is about (the summary's majority rule uses these). */
  top: LiftTile[];
  partners: Map<string, Partner>;
  /** The spots list (before and after the show), by entity id and by lower-case name. */
  spots: Set<string>;
  protectedNames: string[];
  /** Normalized genre and audience words (" country ", " rhythm and blues "). */
  vocab: string[];
  streetDay: string;
  showDay: string;
  budget: Map<string, number>;
  /** True only when the sheet's counts are what-ifs (a sample sheet): otherwise "what-if" wording fails a line. */
  whatIfs: boolean;
  summaryTemplate: () => string;
  tileTemplate: (t: LiftTile) => string;
  partnerTemplate: (p: Partner) => string;
}

function dedupeStrings(xs: Iterable<string>): string[] {
  return [...new Set([...xs].map((x) => (typeof x === "string" ? x.trim() : "")).filter((x) => x.length > 1))];
}

function buildVocab(tags: Iterable<TagLike>): string[] {
  const out = new Set<string>(GENRE_WORDS.map((w) => normalizeWords(w)));
  for (const t of tags) {
    if (!t?.id || !isVocabTag(t)) continue;
    const name = normalizeWords((t.name ?? t.id.split(":").pop() ?? "").replace(/\s+fans$/i, ""));
    if (name.trim().length >= 3) out.add(name);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function partnerShared(p: Partner): string[] {
  const tags: ReadonlyArray<TagLike> = p.explain ? p.explain.tags : (p.entity?.tags ?? []);
  return tags.map((t) => normalizeWords(t.name ?? "")).filter((s) => s.trim().length > 0);
}

function spotKeys(spots: ReadonlyArray<{ entity?: { entityId?: string; name?: string } }> | undefined): Set<string> {
  return new Set((spots ?? []).flatMap((s) => [s.entity?.entityId ?? "", (s.entity?.name ?? "").trim().toLowerCase()]).filter(Boolean));
}

function entityNames(...lists: ReadonlyArray<ReadonlyArray<{ entity?: { name?: string } }> | undefined>): string[] {
  return lists.flatMap((l) => (l ?? []).map((x) => x.entity?.name ?? ""));
}

// ---------------------------------------------------------------------------
// Line checks
// ---------------------------------------------------------------------------

function tilesNamedIn(ctx: VetContext, sentence: string): LiftTile[] {
  return ctx.pool.filter((t) => {
    const name = t.name?.trim();
    return !!name && name.length >= 3 && new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, "i").test(sentence);
  });
}

function metricValue(ctx: VetContext, t: LiftTile, m: Metric): number | null {
  const v = m === "lift" ? t.lift : m === "billPct" ? t.billPct : m === "adults" ? t.adultPopulation : ctx.budget.get(t.geohash);
  return finite(v) ? v : null;
}

function isMax(ctx: VetContext, t: LiftTile, m: Metric): boolean {
  const v = metricValue(ctx, t, m);
  if (v === null) return false;
  const all = ctx.pool.map((x) => metricValue(ctx, x, m)).filter((x): x is number => x !== null);
  const max = Math.max(...all);
  return Math.round(v * 1000) >= Math.round(max * 1000);
}

/**
 * A rank the sheet doesn't show as such ("a seafood restaurant ranked first on the sheet"): a partner's rank is its
 * rank in its own area's search, never a place on the sheet, and lines are told not to repeat it.
 */
const RANK_CLAIM_RE = /\b(?:ranked|ranks?|ranking)\s+(?:first|1st|top|number one|highest|best)\b|\b(?:first|top)\s+(?:on|of)\s+the\s+(?:sheet|list)\b/i;

/** "differs most", "stands out most", "most different", "most strongly": a superlative about lift in other words. */
const MOST_RE = /\b(?:differs?|stands?\s+out|lifts?|over-?index(?:es)?)\s+(?:the\s+)?most\b|\bmost\s+(?:different|strongly)\b/gi;

/** Area names in a list right after a phrase ("in the Kenilworth, H Street NE and U Street / Shaw areas"), in order. */
function listedAreas(ctx: VetContext, text: string): string[] {
  const names = [...new Set(ctx.pool.map((t) => t.name?.trim() ?? "").filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length);
  let rest = text.replace(/^\s*(?:in|across|around)?\s*(?:the\s+)?/i, "");
  const out: string[] = [];
  for (;;) {
    const name = names.find((n) => rest.slice(0, n.length).toLowerCase() === n.toLowerCase() && !/[A-Za-z0-9]/.test(rest.charAt(n.length)));
    if (!name) break;
    out.push(name);
    rest = rest.slice(name.length);
    const sep = /^\s*(?:,\s*(?:and\s+)?|and\s+)(?:the\s+)?/i.exec(rest);
    if (!sep) break;
    rest = rest.slice(sep[0].length);
  }
  return out;
}

/**
 * The first area the sheet shows that stands out more than one of `names` and is not among them (by each name's
 * strongest square, at the sheet's 2 decimals), or null when the names are the top of the map.
 */
function outranking(ctx: VetContext, names: readonly string[]): LiftTile | null {
  const key = (s: string | undefined) => (s ?? "").trim().toLowerCase();
  const inList = new Set(names.map(key));
  const best = (name: string) => Math.max(-Infinity, ...ctx.pool.filter((t) => key(t.name) === key(name) && finite(t.lift)).map((t) => t.lift));
  const floor = Math.min(...names.map(best));
  const above = ctx.pool.filter((t) => !inList.has(key(t.name)) && finite(t.lift) && Math.round(t.lift * 100) > Math.round(floor * 100));
  return above.sort((a, b) => b.lift - a.lift)[0] ?? null;
}

/**
 * "then work Laurel and Bowie, where the crowd differs most", "stands out most in Kenilworth, H Street NE and U Street
 * / Shaw": the areas such a phrase is about (listed just after it, else named before the next comma, else in the same
 * clause before it) must be the top of the map: no area left out of them stands out more. A bare "most strongly" is
 * about lift only when a list of areas follows it ("most strongly in Hilltop and Riverbend"); "leans most strongly
 * toward soul" or "ranks most strongly among bars" is not.
 */
function mostProblem(ctx: VetContext, sentence: string): string | null {
  for (const m of sentence.matchAll(MOST_RE)) {
    const at = m.index ?? 0;
    const rest = sentence.slice(at + m[0].length);
    const namesOf = (ts: LiftTile[]) => [...new Set(ts.map((t) => t.name?.trim() ?? "").filter(Boolean))];
    let names = listedAreas(ctx, rest);
    if (names.length === 0 && /^most\s+strongly$/i.test(m[0])) continue;
    if (names.length === 0) names = namesOf(tilesNamedIn(ctx, (rest.split(/[,;]/)[0] ?? "").slice(0, 60)));
    if (names.length === 0) {
      const before = sentence.slice(0, at);
      const clause = before.split(/,\s*(?:then|and then|then\s+work)\b|[;:]/i).pop() ?? before;
      names = namesOf(tilesNamedIn(ctx, clause));
    }
    const above = names.length > 0 ? outranking(ctx, names) : null;
    if (names.length === 0 || above) {
      return `"${m[0].toLowerCase()}" not backed by the sheet's numbers${above ? ` (${above.name ?? "an unnamed area"} stands out more)` : ""}`;
    }
  }
  return null;
}

/** Forecasts, "concentrated" and superlatives; `subjects` are the areas the text is about. */
function claimProblem(ctx: VetContext, text: string, subjects: LiftTile[]): string | null {
  const plain = blankProtected(text, ctx.protectedNames);
  for (const [re, why] of ALWAYS_UNBACKED) if (re.test(plain)) return why;
  if (RANK_CLAIM_RE.test(plain)) return "a rank the sheet doesn't show";
  for (const sentence of splitSentences(text)) {
    const most = mostProblem(ctx, sentence);
    if (most) return most;
  }
  // "The house" is internal shorthand; the sheet always says "the room's usual crowd".
  if (/\bhouse\b/i.test(plain)) return '"house" instead of the room\'s usual crowd';
  // A live sheet's numbers are the operator's own inputs, never what-ifs.
  if (!ctx.whatIfs && /\bwhat[- ]ifs?\b|\bhypothetical\b/i.test(plain)) return 'calls the numbers "what-ifs" on a live sheet';
  const hits = [...plain.matchAll(SUPERLATIVE_RE)];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i]!.index ?? 0;
    const end = Math.min(hits[i + 1]?.index ?? plain.length, start + 90);
    const window = plain.slice(start, end);
    const metric = metricOf(window);
    const word = hits[i]![0].replace(/\s+/g, " ").toLowerCase();
    if (!metric) return `superlative "${word}" not backed by the sheet`;
    if (!subjects.some((t) => isMax(ctx, t, metric))) return `superlative "${word}" not backed by the sheet's numbers`;
  }
  return null;
}

function directionProblemForTiles(ctx: VetContext, text: string, tiles: LiftTile[], majority: boolean): string | null {
  const claims = directionClaims(blankProtected(text, ctx.protectedNames));
  if (claims.length === 0) return null;
  const venue = ctx.venue;
  const bearings = venue ? tiles.map((t) => tilePoint(t)).map((p) => (p ? compassIndex(venue, p) : null)) : [];
  const known = bearings.filter((b): b is number => b !== null);
  for (const c of claims) {
    if (known.length === 0) return "direction claim not backed by the map";
    const near = known.filter((b) => pointDistance(b, c) <= 1).length;
    if (majority ? near * 2 <= known.length : near === 0) return "direction claim not backed by the map";
  }
  return null;
}

/**
 * An area's percentile written as a share of the crowd ("the bill's share of the crowd is about 96%"), or any other
 * percent or share the map doesn't show. Only the budget split is a share; a percentile is said as one.
 */
function shareProblem(ctx: VetContext, sentence: string): string | null {
  const plain = blankProtected(sentence, ctx.protectedNames);
  if (/\bbudget\b|\bsplit\b/i.test(plain)) return null;
  if (/\bshare\b(?!s)|\bshares\s+of\b/i.test(plain) || /\d\s*(?:%|per ?cent\b)/i.test(plain)) {
    return "a share or percent of the crowd the map doesn't show (the map ranks areas by percentile)";
  }
  return null;
}

function summaryProblem(ctx: VetContext, summary: string): string | null {
  for (const sentence of splitSentences(summary)) {
    const named = tilesNamedIn(ctx, sentence);
    const dir = named.length > 0 ? directionProblemForTiles(ctx, sentence, named, false) : directionProblemForTiles(ctx, sentence, ctx.top, true);
    if (dir) return dir;
    const claim = claimProblem(ctx, sentence, named);
    if (claim) return claim;
    const share = shareProblem(ctx, sentence);
    if (share) return share;
    const placed = usualCrowdPlacedProblem(ctx, sentence) ?? citySideProblem(ctx, sentence);
    if (placed) return placed;
    const equal = equalSplitProblem(ctx, sentence, undefined) ?? areaSpotsProblem(ctx, sentence);
    if (equal) return equal;
    // A sentence about one area holds that area's numbers (any of its squares, when a name has more than one), for the
    // figures written within a few words of its name: "Five areas sit at the 73rd percentile or higher, led by U Street /
    // Shaw" is about the five.
    const one = new Set(named.map((t) => t.name?.trim().toLowerCase()));
    if (named.length > 0 && one.size === 1) {
      const masked = maskProtected(sentence, ctx.protectedNames);
      const problem = (t: LiftTile) => ownNumbersProblem(ctx, sentence, masked, t, true);
      if (!named.some((t) => problem(t) === null)) return problem(named[0]!);
    }
  }
  return null;
}

/** `blankProtected` with each name replaced by as many spaces, so a position in the result is the same in `text`. */
function maskProtected(text: string, names: ReadonlyArray<string>): string {
  let out = text;
  const sorted = [...new Set(names.filter((s) => s.trim().length > 1))].sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    const body = escapeRe(s);
    out = out.replace(new RegExp(s.trim().length <= 3 ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, "gi"), (m) => " ".repeat(m.length));
  }
  return out;
}

/** The sentences of `text` (as `splitSentences` cuts them) with where each starts. */
function sentencesAt(text: string): { s: string; start: number }[] {
  const out: { s: string; start: number }[] = [];
  let cursor = 0;
  for (const part of text.split(/(?<=[.!?])\s+/)) {
    const at = text.indexOf(part, cursor);
    cursor = at + part.length;
    const s = part.trim();
    if (s) out.push({ s, start: at + (part.length - part.trimStart().length) });
  }
  return out;
}

/** An area name written in a line: where, and whether it is the line's own area. */
interface Mention {
  at: number;
  end: number;
  own: boolean;
}

/** The names an area goes by in a line: its name, and the part before a comma ("Des Plaines, 19 km northwest"). */
function nameForms(t: LiftTile | undefined): string[] {
  const name = t?.name?.trim() ?? "";
  return dedupeStrings([name, name.split(",")[0] ?? ""]).filter((n) => n.length >= 3);
}

/** Each area name of the sheet written in `text`, in order (longest name first where two overlap). */
function areaMentions(ctx: VetContext, text: string, own: LiftTile | undefined): Mention[] {
  const ownForms = new Set(nameForms(own).map((n) => n.toLowerCase()));
  const names = dedupeStrings(ctx.pool.flatMap((t) => nameForms(t))).sort((a, b) => b.length - a.length);
  const out: Mention[] = [];
  for (const name of names) {
    for (const m of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, "gi"))) {
      const at = m.index ?? 0;
      const end = at + m[0].length;
      if (out.some((x) => at < x.end && end > x.at)) continue;
      out.push({ at, end, own: ownForms.has(name.toLowerCase()) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/** Words that set a figure against another: "more than 2 times", "over 40%", "clears the 1.3x cutoff". */
const COMPARED_BEFORE_RE =
  /\b(?:(?:more|less|fewer|higher|lower)\s+than|over|under|nearly|almost|above|below|at\s+least|up\s+to|clears?|clearing|past|beyond|exceeds?|exceeding)\s+(?:the\s+)?(?:about\s+|around\s+|roughly\s+)?$/i;
const COMPARED_AFTER_RE = /^\s*(?:percentile\s+)?(?:or|and)\s+(?:higher|above|more|over|up|better|lower|below|less|under)\b/i;
/** A figure that is a threshold, not the area's own: "the 1.3x line", "the 1.3x cutoff for a numbered area". */
const THRESHOLD_AFTER_RE = /^\s*(?:line|cutoff|cut-off|threshold|bar|mark|floor|minimum|limit)\b/i;
/** The words between a figure and another area's name that make the figure that area's: "42.7% for U Street / Shaw". */
const FIGURE_OF_NEXT_RE = /^[\s,]*(?:(?:percentile|of\s+the\s+(?:budget|split)|the\s+room's\s+usual\s+crowd)\s+)?(?:for|in|at)\s+(?:the\s+)?$/i;

/**
 * Which figures in an area line are the area's own: not one set against another ("more than 2 times", "the 73rd
 * percentile or higher"), not a threshold ("clears the 1.3x cutoff"), and not one written just after another area's
 * name ("behind U Street / Shaw at about 2.8 times", "U Street / Shaw gets 42.7%") or just before it ("against 42.7%
 * for U Street / Shaw"). With `near` (a summary sentence), only a figure within a few words of the area's own name.
 * `masked` is `text` with the protected names blanked (`maskProtected`), so positions match.
 */
function ownFigure(ctx: VetContext, text: string, masked: string, tile: LiftTile, near: boolean): (at: number, len: number) => boolean {
  const mentions = areaMentions(ctx, text, tile);
  const unbroken = (a: number, b: number) => !/[.;!?]/.test(masked.slice(a, b));
  return (at, len) => {
    if (COMPARED_BEFORE_RE.test(masked.slice(Math.max(0, at - 40), at)) || COMPARED_AFTER_RE.test(masked.slice(at + len, at + len + 40))) return false;
    if (THRESHOLD_AFTER_RE.test(masked.slice(at + len, at + len + 20))) return false;
    const prev = mentions.filter((m) => m.end <= at).pop();
    if (prev && !prev.own && unbroken(prev.end, at) && wordCount(masked.slice(prev.end, at)) <= 5) return false;
    const next = mentions.find((m) => m.at >= at + len);
    if (next && !next.own && FIGURE_OF_NEXT_RE.test(masked.slice(at + len, next.at))) return false;
    if (!near) return true;
    return mentions.some(
      (m) => m.own && ((m.at >= at + len && unbroken(at + len, m.at) && wordCount(masked.slice(at + len, m.at)) <= 4) || (m.end <= at && unbroken(m.end, at) && wordCount(masked.slice(m.end, at)) <= 8)),
    );
  };
}

/** The area's own percentiles, lift and budget share, for the figures that are its own (`ownFigure`). */
function ownNumbersProblem(ctx: VetContext, text: string, masked: string, tile: LiftTile, near: boolean): string | null {
  const keep = ownFigure(ctx, text, masked, tile, near);
  return percentileProblem(masked, tile, keep) ?? liftFigureProblem(masked, tile, keep) ?? budgetShareProblem(ctx, masked, tile, keep);
}

/** Percentile on a 0..100 scale, as the template prints it. */
function pct100(v: number): number {
  return Math.round(v <= 1 ? v * 100 : v);
}

/** An ordinal used as a percentile: "81st percentile", "the 5th for the usual crowd", "a 82nd percentile bill rank". */
const ORDINAL_RE = /\b(\d{1,3})(?:st|nd|rd|th)\b/g;

/** The words straight after an ordinal that make it this crowd's percentile ("percentile for this bill", "for this crowd"). */
const BILL_PCT_RE = /^\s*(?:percentile\s*(?:rank\s*)?,?\s*)?(?:(?:for|among|in|of)\s+(?:this|the)\s+(?:bill|crowd|show)\b|bill\b)/i;
/** ...and the room's usual crowd's ("percentile for the room's usual crowd", "for the usual crowd"). */
const HOUSE_PCT_RE = /^\s*(?:percentile\s*(?:rank\s*)?,?\s*)?(?:for|among|in|of)\s+(?:(?:the|this)\s+)?(?:\s*'s\s+)?(?:room|usual|house|venue|regular)/i;

/**
 * "at the 81st percentile for this bill" for an area at the 80th: a percentile an area line cites must be one of the
 * area's own two, rounded as the template prints them. The words straight after it say whose it is ("percentile for
 * this bill" for this crowd's; "for the room's usual crowd" for the room's); either when they only say "percentile".
 * An ordinal followed by neither ("2nd for lift") is not a percentile.
 */
function percentileProblem(text: string, tile: LiftTile, keep: (at: number, len: number) => boolean = () => true): string | null {
  if (!finite(tile.billPct) || !finite(tile.housePct)) return null;
  const bill = pct100(tile.billPct);
  const house = pct100(tile.housePct);
  for (const { s, start } of sentencesAt(text)) {
    if (!/\bpercentile/i.test(s)) continue;
    for (const m of s.matchAll(ORDINAL_RE)) {
      const after = s.slice((m.index ?? 0) + m[0].length);
      const whose = BILL_PCT_RE.test(after) ? "bill" : HOUSE_PCT_RE.test(after) ? "house" : /^\s*percentile\b/i.test(after) ? null : undefined;
      if (whose === undefined || !keep(start + (m.index ?? 0), m[0].length)) continue;
      const n = Number(m[1]);
      if (whose === "bill" ? n === bill : whose === "house" ? n === house : n === bill || n === house) continue;
      if (whose && n === (whose === "bill" ? house : bill)) {
        return whose === "bill"
          ? `says the ${m[0]} percentile for this crowd, which is the room's usual crowd's; this crowd's is ${ordinal(bill)}`
          : `says the ${m[0]} percentile for the room's usual crowd, which is this crowd's; the room's is ${ordinal(house)}`;
      }
      return `says the ${m[0]} percentile, the area's are ${ordinal(bill)} for this crowd and ${ordinal(house)} for the room's usual crowd`;
    }
  }
  return null;
}

/**
 * "about 2.4 times the room's usual crowd" for an area at 2.2: a lift an area line cites must round to the area's own
 * at the precision written ("about 2 times" for 2.04 is the same figure, "about 2.2" for 2.15 is the sheet's rule).
 */
function liftFigureProblem(text: string, tile: LiftTile, keep: (at: number, len: number) => boolean = () => true): string | null {
  if (!finite(tile.lift)) return null;
  for (const m of text.matchAll(/\b(\d+(?:\.(\d{1,2}))?)\s*(?:times\b|x\b)/gi)) {
    if (m[1] === aboutTimes(tile.lift) || !keep(m.index ?? 0, m[0].length)) continue;
    const step = 10 ** -(m[2]?.length ?? 0);
    if (Math.abs(Number(m[1]) - tile.lift) > step / 2 + 0.006) return `says about ${m[1]} times, the area's lift is about ${aboutTimes(tile.lift)} times`;
  }
  return null;
}

/** "a rough split of the budget of 14.3%": a percent in a budget sentence must round to the area's own share. */
function budgetShareProblem(ctx: VetContext, text: string, tile: LiftTile, keep: (at: number, len: number) => boolean = () => true): string | null {
  const share = ctx.budget.get(tile.geohash);
  if (!finite(share)) return null;
  for (const { s, start } of sentencesAt(text)) {
    if (!/\bbudget\b|\bsplit\b/i.test(s)) continue;
    for (const m of s.matchAll(/\b(\d+(?:\.(\d+))?)\s*(?:%|per ?cent\b)/gi)) {
      if (!keep(start + (m.index ?? 0), m[0].length)) continue;
      const step = 10 ** -(m[2]?.length ?? 0);
      if (Math.abs(Number(m[1]) - share * 100) > step / 2 + 1e-6) return `says ${m[1]}% of the budget, the area's share is ${roundShare(share)}%`;
    }
  }
  return null;
}

function roundShare(share: number): string {
  return String(Math.round(share * 1000) / 10);
}

/**
 * "equal to the other Chicago-area tiles", "the same rough split as Bowie", "split evenly": a claim the shares are equal.
 * "part of the same rough split of the budget" names the sheet's one split, not equal shares; "the same rough split of
 * the budget as Bowie" still claims them.
 */
const EQUAL_SPLIT_RE =
  /\b(?:split|share|part|portion|budget)\b[^.;]{0,60}?\b(?:equal(?:ly)?|evenly|the same as|identical|matching)\b|\b(?:equal|identical|matching)\s+(?:\w+\s+){0,2}?(?:split|share|part|portion)\b|(?<!\b(?:part\s+of|in|within|from|under)\s+the\s+)\bsame\s+(?:\w+\s+){0,2}?(?:split|share|part|portion)\b|\bsame\s+(?:\w+\s+){0,2}?(?:split|share|part|portion)\b(?:\s+of\s+the\s+budget)?\s+as\b|\b(?:equally|evenly)\b[^.;]{0,40}?\b(?:split|share|budget)\b/i;

/** "about evenly", "roughly equal": a split said to be near equal, not equal. */
const ROUGHLY_EQUAL_RE = /\b(?:about|roughly|nearly|almost|close\s+to|more\s+or\s+less|fairly|broadly|largely)\s+(?:even(?:ly)?|equal(?:ly)?|the\s+same)\b/i;
/** "the other four areas", "the remaining tiles", "the rest": the areas a sentence doesn't name. */
const REST_RE = /\bthe\s+(?:other|remaining)\s+(?:(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:[\w-]+\s+){0,3}(?:areas?|tiles?|squares?|neighbou?rhoods?)\b|\bthe\s+rest\b/i;

/**
 * An equal budget split the sheet doesn't show: the areas named beside `subject` (or, when none is named, every area
 * in the split) must have the subject's share; with no subject, every share must be the same. A sentence about "the
 * other four areas" or "the rest" covers the areas it doesn't name (the four whose shares are closest, when it gives a
 * count); with that wording, or "about evenly", shares within half a point count as equal.
 */
function equalSplitProblem(ctx: VetContext, sentence: string, subject: LiftTile | undefined): string | null {
  const plain = blankProtected(sentence, ctx.protectedNames);
  if (!EQUAL_SPLIT_RE.test(plain)) return null;
  const sameName = (t: LiftTile) => !!subject?.name && t.name?.trim().toLowerCase() === subject.name.trim().toLowerCase();
  const named = tilesNamedIn(ctx, sentence).filter((t) => ctx.budget.has(t.geohash));
  const others = named.filter((t) => t.geohash !== subject?.geohash && !sameName(t));
  const share = (geohash: string) => {
    const s = ctx.budget.get(geohash);
    return finite(s) ? Math.round(s * 1000) : null;
  };
  const rest = REST_RE.exec(plain);
  let shares: (number | null)[];
  if (rest) {
    const left = [...ctx.budget.keys()].filter((g) => g !== subject?.geohash && !named.some((t) => t.geohash === g)).map(share);
    const count = Math.min(left.length, (rest[1] ? (COUNT_WORDS[rest[1].toLowerCase()] ?? Number(rest[1])) : 0) || left.length);
    const own = subject ? share(subject.geohash) : null;
    const known = left.filter((s): s is number => s !== null);
    // The `count` shares a claim could be about: closest to the subject's, or the tightest run of them.
    const picked =
      own !== null
        ? [...known].sort((a, b) => Math.abs(a - own) - Math.abs(b - own)).slice(0, count)
        : [...known].sort((a, b) => a - b).reduce<number[]>((best, _s, i, all) => {
            const run = all.slice(i, i + count);
            return run.length === count && (best.length === 0 || run[run.length - 1]! - run[0]! < best[best.length - 1]! - best[0]!) ? run : best;
          }, []);
    shares = own !== null ? [own, ...picked] : picked;
  } else if (subject) {
    shares = others.length > 0 ? [subject, ...others].map((t) => share(t.geohash)) : [...ctx.budget.keys()].map(share);
  } else {
    // No subject (a summary sentence): the areas it says split equally. Those named before the claim ("Midlothian,
    // South Shore, Auburn Gresham and Englewood split most of the budget equally, with less for Des Plaines"), else
    // every area it names, else every area in the split.
    const claimAt = EQUAL_SPLIT_RE.exec(sentence)?.index ?? sentence.length;
    const before = named.filter((t) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(t.name?.trim() ?? "")}(?![A-Za-z0-9])`, "i").exec(sentence.slice(0, claimAt)));
    const areas = before.length >= 2 ? before : named.length >= 2 ? named : null;
    shares = areas ? areas.map((t) => share(t.geohash)) : [...ctx.budget.keys()].map(share);
  }
  const slack = rest || ROUGHLY_EQUAL_RE.test(plain) ? 5 : 0;
  const known = shares.filter((s): s is number => s !== null);
  if (known.length >= 2 && known.length === shares.length && Math.max(...known) - Math.min(...known) <= slack) return null;
  return "claims an equal budget split the sheet doesn't show";
}

/**
 * "Start with the Bronzeville partners and the Midlothian and South Shore spots": the sheet's spots are its list for
 * before and after the show, near the room; an area's places are partners. An area name (or a list of them) put
 * straight before "spots" fails.
 */
function areaSpotsProblem(ctx: VetContext, sentence: string): string | null {
  const names = [...new Set(ctx.pool.map((t) => t.name?.trim() ?? "").filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length).map(escapeRe);
  if (names.length === 0) return null;
  const one = `(?:${names.join("|")})`;
  const re = new RegExp(`(?<![A-Za-z0-9])${one}(?:\\s*(?:,\\s*(?:and\\s+)?|and\\s+)${one})*\\s+spots?\\b`, "i");
  return re.test(sentence) ? "calls an area's places spots; the sheet's spots are near the room" : null;
}

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PARTNER_COUNT_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:partner(?:s| places?)?|places? on the (?:sheet|list|street team's route))\b/gi;

function tileProblem(ctx: VetContext, text: string, tile: LiftTile | undefined): string | null {
  const subjects = tile ? [tile] : [];
  const base = directionProblemForTiles(ctx, text, subjects, false) ?? claimProblem(ctx, text, subjects);
  if (base) return base;
  for (const sentence of splitSentences(text)) {
    const share = shareProblem(ctx, sentence) ?? usualCrowdPlacedProblem(ctx, sentence) ?? citySideProblem(ctx, sentence);
    if (share) return share;
  }
  const plain = blankProtected(text, ctx.protectedNames);
  // An area has no tags of its own: a genre named for it ("a strong match to country and folk listeners") is invented.
  let hay = normalizeWords(plain);
  for (const p of NOT_GENRE_PHRASES) hay = hay.split(p).join(" ");
  for (const term of ctx.vocab) if (hay.includes(term)) return `names "${term.trim()}" for an area, which the map doesn't measure`;
  // A partner count for the area must be the sheet's own count.
  if (tile) {
    const have = [...ctx.partners.values()].filter((p) => p.tileGeohash === tile.geohash).length;
    for (const m of plain.matchAll(PARTNER_COUNT_RE)) {
      const raw = m[1]!.toLowerCase();
      const n = COUNT_WORDS[raw] ?? Number(raw);
      if (n !== have) return `says ${m[1]} ${n === 1 ? "partner" : "partners"}, the sheet has ${have} in this area`;
    }
  }
  // The area's own percentiles, lift and budget share; an equal split only when the shares are equal.
  const own = tile ? ownNumbersProblem(ctx, text, maskProtected(text, ctx.protectedNames), tile, false) : null;
  if (own) return own;
  for (const sentence of splitSentences(text)) {
    const equal = equalSplitProblem(ctx, sentence, tile) ?? areaSpotsProblem(ctx, sentence);
    if (equal) return equal;
  }
  return null;
}

/**
 * A diet or style tag turned into the kind of place ("Vegan restaurant" for a Swiss restaurant that has a vegan
 * dish): the line may say the place shares the tag, not that the place is one. Kept when the place's own name or
 * category says it ("Organic Cafe", a vegan_restaurant).
 */
const DIET_TYPE_RE =
  /\b(vegan|vegetarian|plant[- ]based|organic|healthy|gluten[- ]free|halal|kosher)(?:[- ]friendly)?\s+(restaurant|cafe|café|bar|bakery|deli|spot|place|eatery|diner|shop|lounge)\b/i;

function dietTypeProblem(text: string, partner: Partner | undefined): string | null {
  const m = DIET_TYPE_RE.exec(text);
  if (!m || !partner) return null;
  const word = m[1]!.toLowerCase().replace(/[- ]/g, "");
  const own = `${partner.entity?.name ?? ""} ${partner.category ?? ""}`.toLowerCase().replace(/[-_ ]/g, "");
  return own.includes(word) ? null : `calls the place a "${m[0].toLowerCase()}" from a shared tag`;
}

/**
 * "a good before-show stop", "also a before-show spot", "a daytime before or after stop": the sheet's places for before
 * and after the show are its spots list (near the room, open on show night). A partner is where the street team leaves
 * flyers, with hours for the street-team day; a line may call it a stop before or after the show only when it is also
 * on that list.
 */
const SPOT_CLAIM_RE =
  /\b(?:before|after|pre|post)(?:\s+(?:or|and)\s+(?:before|after))?(?:[- ]?(?:show|concert|gig))?\s+(?:stop|spot)s?\b|\b(?:stop|spot)s?\s+(?:for\s+)?(?:before|after)(?:\s+(?:or|and)\s+(?:before|after))?\s+(?:the\s+)?(?:show|concert|gig)\b/i;

function spotClaimProblem(ctx: VetContext, text: string, partner: Partner | undefined): string | null {
  if (!SPOT_CLAIM_RE.test(blankProtected(text, ctx.protectedNames))) return null;
  if (partner && (ctx.spots.has(partner.entity.entityId) || ctx.spots.has((partner.entity.name ?? "").trim().toLowerCase()))) return null;
  return "calls the place a stop before or after the show; it is not on the sheet's spots list";
}

function partnerProblem(ctx: VetContext, text: string, partner: Partner | undefined): string | null {
  const tile = partner?.tileGeohash ? ctx.pool.find((t) => t.geohash === partner.tileGeohash) : undefined;
  const claim = claimProblem(ctx, text, tile ? [tile] : []);
  if (claim) return claim;
  const diet = dietTypeProblem(text, partner) ?? spotClaimProblem(ctx, text, partner);
  if (diet) return diet;
  const near = nearRoomProblem(ctx, text, partner) ?? hoursProblem(text, partner);
  if (near) return near;
  const shared = partner ? partnerShared(partner) : [];
  const covered = (term: string) => shared.some((s) => s.includes(term) || term.includes(s));
  const plain = blankProtected(text, ctx.protectedNames);
  let hay = normalizeWords(plain);
  for (const p of NOT_GENRE_PHRASES) hay = hay.split(p).join(" ");
  for (const term of ctx.vocab) {
    if (hay.includes(term) && !covered(term)) return `names "${term.trim()}", which is not among the place's shared tags`;
  }
  for (const m of plain.matchAll(TAG_PHRASE_RE)) {
    let rest = normalizeWords(m[1] ?? "");
    for (const s of [...shared].sort((a, b) => b.length - a.length)) rest = rest.split(s).join(" ");
    const left = rest.split(" ").filter((w) => w && !TAG_PHRASE_FILLER.has(w));
    if (left.length > 0) return `names tags the place does not share ("${left.join(" ")}")`;
  }
  if (shared.length === 0 && /\btags?\b/i.test(plain)) return "names a tag, but the place shares none";
  for (const m of plain.matchAll(WEEKDAY_RE)) {
    const day = m[1]!.toLowerCase();
    if (day === ctx.streetDay) continue;
    const after = plain.slice((m.index ?? 0) + m[0].length);
    if (day === ctx.showDay && /^(?:'s)?\s+(?:show|night|concert|gig)\b/i.test(after)) continue;
    return `names ${m[1]}, not the street-team day`;
  }
  return null;
}

interface Lines {
  summary: string | null;
  tileWhy: { geohash: string; text: string }[];
  partnerLines: { entityId: string; text: string }[];
}

function vetLines(ctx: VetContext, n: Lines): { lines: Lines; replaced: string[] } {
  const replaced: string[] = [];
  let summary = n.summary;
  if (typeof summary === "string") {
    const p = summaryProblem(ctx, summary);
    if (p) {
      const rep = ctx.summaryTemplate();
      if (rep.trim() !== summary.trim()) {
        replaced.push(`summary: ${p}`);
        summary = rep;
      }
    }
  }

  const tileWhy: Lines["tileWhy"] = [];
  (n.tileWhy ?? []).forEach((t, i) => {
    const tile = ctx.pool.find((x) => x.geohash === t.geohash);
    const p = tileProblem(ctx, t.text ?? "", tile);
    if (!p) return void tileWhy.push(t);
    const rep = tile ? ctx.tileTemplate(tile) : null;
    if (rep !== null && rep.trim() === (t.text ?? "").trim()) return void tileWhy.push(t);
    replaced.push(`tileWhy[${i}]: ${p}${rep === null ? " (dropped)" : ""}`);
    if (rep !== null) tileWhy.push({ geohash: t.geohash, text: rep });
  });

  const partnerLines: Lines["partnerLines"] = [];
  (n.partnerLines ?? []).forEach((l, i) => {
    const partner = ctx.partners.get(l.entityId);
    const p = partnerProblem(ctx, l.text ?? "", partner);
    if (!p) return void partnerLines.push(l);
    const rep = partner ? ctx.partnerTemplate(partner) : null;
    if (rep !== null && rep.trim() === (l.text ?? "").trim()) return void partnerLines.push(l);
    replaced.push(`partnerLines[${i}]: ${p}${rep === null ? " (dropped)" : ""}`);
    if (rep !== null) partnerLines.push({ entityId: l.entityId, text: rep });
  });

  return { lines: { summary, tileWhy, partnerLines }, replaced };
}

// ---------------------------------------------------------------------------
// Contexts: a stored sheet (view time) or a narrate() input (generation time)
// ---------------------------------------------------------------------------

/** The template summary's sentence when no area was narrated, and what it says on a run with no lift map. */
const NO_AREA_SUMMARY = "No area stands out on this run, so partners are picked near the venue.";
const NO_LIFT_SUMMARY = "There is no lift map on this run, so partners are picked near the venue.";

/**
 * The sheet's own words for what ran: a genre baseline, non-local sponsors and a run with no lift map (as the
 * orchestrator's honestWording).
 */
function honestFor(sheet: StreetSheet): (s: string) => string {
  const lift = sheet.cards?.liftMap?.results;
  const tagBaseline = lift?.diagnostics?.baseline === "tag";
  const noLiftMap = lift?.diagnostics?.baseline === "none" || (lift?.tiles ?? []).length === 0;
  const localSponsor = (sheet.cards?.media?.results ?? []).some((m) => m.kind === "sponsor" && m.scope === "local");
  return (s) => {
    let out = s;
    if (noLiftMap) out = out.replace(NO_AREA_SUMMARY, NO_LIFT_SUMMARY);
    if (tagBaseline) out = out.replace(/\bthe room's usual crowd\b/g, "the genre baseline");
    if (!localSponsor) out = out.replace(/\b(\d+) local sponsor(s?)\b/g, "$1 sponsor brand$2");
    return out;
  };
}

function sheetTags(sheet: StreetSheet): TagLike[] {
  const c = sheet.cards;
  const wd = c?.whatsDifferent?.results;
  const out: TagLike[] = [...(wd?.a ?? []), ...(wd?.b ?? []), ...(wd?.shared ?? [])];
  for (const r of c?.resolution?.results ?? []) out.push(...(r.entity?.tags ?? []), ...(r.proxy?.entity?.tags ?? []));
  for (const p of c?.partners?.results ?? []) out.push(...(p.explain?.tags ?? []), ...(p.entity?.tags ?? []));
  for (const s of c?.prePost?.results ?? []) out.push(...(s.entity?.tags ?? []));
  for (const m of c?.media?.results ?? []) out.push(...(m.entity?.tags ?? []));
  const known = new Map(out.filter((t) => t?.id).map((t) => [t.id, t.name]));
  for (const h of c?.copyHooks?.results ?? []) for (const id of h.tagIds ?? []) out.push({ id, name: known.get(id) ?? id.split(":").pop()?.replace(/_/g, " ") ?? "" });
  return out.filter((t) => t && typeof t.id === "string");
}

const SUMMARY_TAG_NAMESPACES = ["urn:tag:genre:music", "urn:tag:genre:media", "urn:tag:theme:", "urn:tag:keyword:media"];

function sheetContext(sheet: StreetSheet, narration: Narration | undefined): VetContext {
  const c = sheet.cards;
  const pool = c?.liftMap?.results?.tiles ?? [];
  const partners = c?.partners?.results ?? [];
  const narrated = (narration?.tileWhy ?? []).map((t) => pool.find((x) => x.geohash === t.geohash)).filter((t): t is LiftTile => !!t);
  const top = narrated.length > 0 ? narrated : [...pool].sort((a, b) => b.lift - a.lift || a.geohash.localeCompare(b.geohash)).slice(0, 5);
  const streetDay = (sheet.operator?.streetTeamDays?.[0] ?? sheet.bill.weekday ?? "").toLowerCase();
  const honest = honestFor(sheet);
  const wdA = vetWhatsDifferent(c?.whatsDifferent?.results?.a ?? []).filter((t) => SUMMARY_TAG_NAMESPACES.some((ns) => t.id.startsWith(ns)));
  // The run's copy allowlist, as far as the sheet keeps it: the tags its copy lines cite. The template's "leans toward"
  // names only those, as the run's own template would ("michigan" is a distinctive tag no copy line could use).
  const hookTags = new Set((c?.copyHooks?.results ?? []).flatMap((h) => h.tagIds ?? []));
  const allowed = wdA.filter((t) => hookTags.has(t.id));
  // The template summary counts and names the run's numbered areas (the budget split's order), as the run's own template
  // did, even when Claude left one of them without a line.
  const numbered = (sheet.budgetSplit ?? []).map((b) => pool.find((x) => x.geohash === b.geohash)).filter((t): t is LiftTile => !!t);
  const input: NarrateInput = {
    bill: sheet.bill,
    tiles: numbered.length > 0 ? numbered : top,
    partners,
    prePost: c?.prePost?.results ?? [],
    media: c?.media?.results ?? [],
    compareTags: { shared: [], a: wdA, b: [], fromTagDiff: c?.whatsDifferent?.results?.fromTagDiff ?? false },
    allowlistTags: allowed.map((t) => ({ id: t.id, name: t.name })),
    numbers: [],
    hypothetical: sheet.hypothetical,
    streetTeamDay: streetDay,
  };
  let summary: string | null = null;
  return {
    venue: finite(sheet.bill?.venue?.lat) && finite(sheet.bill?.venue?.lon) ? { lat: sheet.bill.venue.lat, lon: sheet.bill.venue.lon } : null,
    venueName: sheet.bill?.venue?.name?.trim() ?? "",
    venueCity: sheet.bill?.venue?.city?.trim() ?? "",
    pool,
    top,
    partners: new Map(partners.map((p) => [p.entity.entityId, p])),
    spots: spotKeys(c?.prePost?.results),
    protectedNames: dedupeStrings([
      ...sheet.bill.acts.map((a) => a.name),
      sheet.bill.venue.name,
      sheet.bill.venue.city,
      sheet.bill.venue.state ?? "",
      ...pool.map((t) => t.name ?? ""),
      ...partners.flatMap((p) => [p.entity.name, p.address ?? "", p.tileName ?? "", p.hoursOnDay ?? "", p.explain?.areaName ?? ""]),
      ...entityNames(c?.prePost?.results, c?.media?.results),
    ]),
    vocab: buildVocab(sheetTags(sheet)),
    streetDay,
    showDay: (sheet.bill.weekday ?? "").toLowerCase(),
    budget: new Map((sheet.budgetSplit ?? []).map((b) => [b.geohash, b.share])),
    whatIfs: sheet.mode === "fixture" && sheet.hypothetical === true,
    summaryTemplate: () => (summary ??= honest(templateSummary(input))),
    tileTemplate: (t) => honest(templateTileWhy(t)),
    partnerTemplate: (p) => honest(templatePartnerLine(p)),
  };
}

function inputContext(input: NarrateInput, prepared: PreparedRun): VetContext {
  const tags: TagLike[] = [
    ...input.allowlistTags,
    ...(input.compareTags?.a ?? []),
    ...(input.compareTags?.b ?? []),
    ...(input.compareTags?.shared ?? []),
    ...input.partners.flatMap((p) => [...(p.explain?.tags ?? []), ...(p.entity?.tags ?? [])]),
    ...input.prePost.flatMap((s) => s.entity?.tags ?? []),
    ...input.media.flatMap((m) => m.entity?.tags ?? []),
  ];
  const budget = new Map<string, number>();
  for (const n of input.numbers) {
    const m = /budget share for (\S+)/.exec(n.label);
    if (m && finite(n.value)) budget.set(m[1]!, n.value);
  }
  const { bill } = input;
  let summary: string | null = null;
  return {
    venue: finite(bill.venue?.lat) && finite(bill.venue?.lon) ? { lat: bill.venue.lat, lon: bill.venue.lon } : null,
    venueName: bill.venue?.name?.trim() ?? "",
    venueCity: bill.venue?.city?.trim() ?? "",
    pool: input.tiles,
    top: input.tiles,
    partners: new Map(input.partners.map((p) => [p.entity.entityId, p])),
    spots: spotKeys(input.prePost),
    protectedNames: dedupeStrings([
      ...bill.acts.map((a) => a.name),
      bill.venue.name,
      bill.venue.city,
      bill.venue.state ?? "",
      ...input.tiles.map((t) => t.name ?? ""),
      ...input.partners.flatMap((p) => [p.entity.name, p.address ?? "", p.tileName ?? "", p.hoursOnDay ?? "", p.explain?.areaName ?? ""]),
      ...entityNames(input.prePost, input.media),
    ]),
    vocab: buildVocab(tags),
    streetDay: (input.streetTeamDay ?? bill.weekday ?? "").toLowerCase(),
    showDay: (bill.weekday ?? "").toLowerCase(),
    budget,
    whatIfs: input.hypothetical === true,
    summaryTemplate: () => (summary ??= templateSummary(input, prepared)),
    tileTemplate: (t) => templateTileWhy(t),
    partnerTemplate: (p) => templatePartnerLine(p),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks a sheet's narration (default: `sheet.narration`) line by line. A failing summary, tile line or
 * partner line is replaced by the template's line for that slot (a partner or tile the sheet does not have
 * is dropped). `replaced` holds one note per replaced line, e.g. "tileWhy[1]: direction claim not backed by
 * the map". `templated` is left as it was.
 */
export function vetNarration(sheet: StreetSheet, narration?: Narration | null): { narration: Narration | undefined; replaced: string[] } {
  const n = narration ?? sheet.narration;
  if (!n) return { narration: undefined, replaced: [] };
  const ctx = sheetContext(sheet, n);
  const { lines, replaced } = vetLines(ctx, { summary: n.summary ?? "", tileWhy: n.tileWhy ?? [], partnerLines: n.partnerLines ?? [] });
  if (replaced.length === 0) return { narration: n, replaced };
  return { narration: { ...n, summary: lines.summary ?? n.summary, tileWhy: lines.tileWhy, partnerLines: lines.partnerLines }, replaced };
}

/**
 * The same checks inside narrate(), on the guarded model lines, with the narrate input as the facts.
 * A null summary (the guard already rejected it) is left null.
 */
export function vetGeneratedLines(
  input: NarrateInput,
  prepared: PreparedRun,
  lines: { summary: string | null; tileWhy: { geohash: string; text: string }[]; partnerLines: { entityId: string; text: string }[] },
): { summary: string | null; tileWhy: { geohash: string; text: string }[]; partnerLines: { entityId: string; text: string }[]; replaced: string[] } {
  const { lines: out, replaced } = vetLines(inputContext(input, prepared), lines);
  return { summary: out.summary, tileWhy: out.tileWhy, partnerLines: out.partnerLines, replaced };
}

/**
 * "with a 82nd percentile bill rank" -> "with an 82nd percentile bill rank": "an" before a number said with a vowel
 * sound (8, 11, 18, 80 to 89, 800 to 899, with or without an ordinal ending). Nothing else in the text changes.
 */
export function anBeforeNumber(text: string): string {
  return text.replace(/\b([Aa]) (?=(?:8\d*|11|18)(?:st|nd|rd|th)?\b)/g, "$1n ");
}

/**
 * "about 2 times the room's usual crowd" for an area at 2.04 reads "about 2.0 times": the figure the sheet, the
 * calendar and the template print for it (`aboutTimes`). Only a whole number that is that figure changes.
 */
export function liftFigureStyle(text: string, lift: number): string {
  if (!finite(lift)) return text;
  const figure = aboutTimes(lift);
  if (!figure.endsWith(".0")) return text;
  return text.replace(new RegExp(`(?<![\\d.,])${figure.slice(0, -2)} times\\b`, "g"), `${figure} times`);
}

/** Act names in billing order, headliner first. */
function actsOf(bill: { acts?: ReadonlyArray<{ name: string; role: string }> }): string[] {
  const order: Record<string, number> = { headliner: 0, co: 1, support: 2 };
  return dedupeStrings([...(bill.acts ?? [])].sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3)).map((a) => a.name));
}

export interface HookVetOptions {
  /** Act names; a line naming none of them gets the headliner put in front. */
  acts: string[];
  headliner: string;
  /** Strings blanked before the audience-word check (act, venue and city names). */
  protectedNames: string[];
  /** Tag names by id, for tags the hook cites. */
  tagNames?: ReadonlyMap<string, string>;
  /** Extra audience words, e.g. the names of audience tags seen on the sheet. */
  extraAudienceWords?: string[];
}

/**
 * Claims fan copy can't make from the sheet: that the act has played the room before ("returns", "is back"), that
 * tickets are scarce or selling ("sold out", "last chance", "selling fast"), or that it is a farewell. Nothing on
 * the sheet says any of them.
 */
export const HOOK_CLAIM_RE =
  /\b(?:returns?|returning|is back|comes back|back again|once again|sold[- ]out|selling fast|last chance|limited tickets|few tickets|tickets? going fast|don't miss|farewell|final show)\b/i;

/**
 * A size or closeness word put on the room ("an intimate room", "a cozy, welcoming venue"). The ambience tags a copy
 * line is built from describe this crowd's taste, not the room, and the sheet prints the room's capacity. "A lively
 * room" and "a cozy, lively feel" stay.
 */
export const HOOK_ROOM_SIZE_RE =
  /\b(?:intimate|cozy|cosy|small|tiny|snug)(?:[\s,]+(?:and\s+)?[a-z][a-z-]*){0,2}?[\s-]+(?:rooms?|venues?|halls?|clubs?|spaces?|settings?|theat(?:er|re)s?)\b/i;

/**
 * Drops hooks that cite an audience, identity or denied tag, use an audience word, make a claim the sheet can't
 * back (`HOOK_CLAIM_RE`) or call the room small (`HOOK_ROOM_SIZE_RE`), puts the headliner in
 * front of a line that names no act ("<Act>: <line>"), and drops repeats. No fallback line.
 */
export function vetHookList(hooks: ReadonlyArray<CopyHook>, opts: HookVetOptions): { hooks: CopyHook[]; reasons: string[] } {
  const out: CopyHook[] = [];
  const reasons: string[] = [];
  const acts = opts.acts.map((a) => a.toLowerCase()).filter(Boolean);
  hooks.forEach((h, i) => {
    const where = `copyHooks[${i}]`;
    const text = (h?.text ?? "").trim();
    const tagIds = [...new Set(h?.tagIds ?? [])];
    if (!text) return void reasons.push(`${where}: empty line`);
    const tags = tagIds.map((id) => ({ id, name: opts.tagNames?.get(id) ?? "" }));
    if (tags.some((t) => isAudienceTag(t.name ? t : { id: t.id }) || isDeniedTag(t))) return void reasons.push(`${where}: audience or identity tag in copy`);
    if (audienceWordIn(blankProtected(text, opts.protectedNames), opts.extraAudienceWords ?? []) !== null) {
      return void reasons.push(`${where}: audience word in copy`);
    }
    const claim = HOOK_CLAIM_RE.exec(blankProtected(text, opts.protectedNames));
    if (claim) return void reasons.push(`${where}: claim the sheet can't back ("${claim[0].toLowerCase()}")`);
    const size = HOOK_ROOM_SIZE_RE.exec(blankProtected(text, opts.protectedNames));
    if (size) return void reasons.push(`${where}: a room size from a taste tag ("${size[0].toLowerCase()}")`);
    const lower = text.toLowerCase();
    const named = acts.length === 0 || acts.some((a) => lower.includes(a));
    // "<Act>: <line>", or "<Act>. <line>" when the line has a colon of its own (never two colons in one line).
    const line = named || !opts.headliner ? text : text.includes(":") ? `${opts.headliner}. ${text}` : `${opts.headliner}: ${text}`;
    if (out.some((x) => x.text.toLowerCase() === line.toLowerCase())) return void reasons.push(`${where}: repeat`);
    out.push({ text: line, tagIds });
  });
  return { hooks: out, reasons };
}

/**
 * `vetHookList` on a sheet's fan copy (default: the copy card's lines), with the sheet's acts, venue, city and tag
 * names: the lines that pass and, for each line dropped, the reason narrate()'s guard gives ("copyHooks[0]: a room
 * size from a taste tag ("intimate room")"). No fallback line. The offline re-check uses it to drop the same lines.
 */
export function vetSheetHooks(sheet: StreetSheet, hooks?: ReadonlyArray<CopyHook>): { hooks: CopyHook[]; reasons: string[] } {
  const list = hooks ?? sheet.cards?.copyHooks?.results ?? [];
  const tags = sheetTags(sheet);
  const tagNames = new Map<string, string>();
  for (const t of tags) if (t.name && !tagNames.has(t.id)) tagNames.set(t.id, t.name);
  // Names of the sheet's audience tags ("Passionate", "Youthful") also mark a line as describing the crowd.
  const extraAudienceWords = dedupeStrings(tags.filter((t) => t.id.startsWith("urn:tag:audience:") && t.name).map((t) => t.name ?? ""));
  const acts = actsOf(sheet.bill);
  const venue = sheet.bill.venue?.name?.trim() ?? "";
  return vetHookList(list, {
    acts,
    headliner: headlinerName(sheet.bill),
    protectedNames: dedupeStrings([...acts, venue, sheet.bill.venue?.city ?? ""]),
    tagNames,
    extraAudienceWords,
  });
}

/**
 * Fan copy for a sheet (default: the copy card's lines). Drops any line that cites an audience or identity
 * tag or uses an audience word, and makes every remaining line name the act. When nothing is left, one
 * line built only from the act, the venue and the date: "<Act> at <Venue>, <Weekday, Mon D>."
 */
export function vetCopyHooks(sheet: StreetSheet, hooks?: CopyHook[]): CopyHook[] {
  const { hooks: out } = vetSheetHooks(sheet, hooks);
  const headliner = headlinerName(sheet.bill);
  const venue = sheet.bill.venue?.name?.trim() ?? "";
  if (out.length > 0 || !headliner) return out;
  const when = displayDate(sheet.bill.weekday, sheet.bill.date);
  return [{ text: `${headliner} at ${venue}${when ? `, ${when}` : ""}.`, tagIds: [] }];
}

/** "What's different" tags to show: each id (and each name) once, no audience, identity or denied tags. */
export function vetWhatsDifferent<T extends { id: string; name?: string }>(tags: ReadonlyArray<T> | null | undefined): T[] {
  const out: T[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const t of tags ?? []) {
    if (!t || typeof t.id !== "string" || !t.id) continue;
    const key = (t.name ?? "").trim().toLowerCase();
    if (ids.has(t.id) || (key && names.has(key))) continue;
    ids.add(t.id);
    if (key) names.add(key);
    if (isAudienceTag(t) || isDeniedTag({ id: t.id, name: t.name ?? "" })) continue;
    out.push(t);
  }
  return out;
}

/**
 * "21 tags rank higher for this bill, 14 for the room's usual crowd, and 9 rank high for both." counted again from
 * the lists shown under it (after `vetWhatsDifferent`): each lean column without the tags listed under "Both rank
 * high", as the plan page shows them. A summary in other words ("There is no usual crowd to compare this bill with.")
 * is kept as it is. The plan page and the MCP bill_vs_house tool both use it.
 */
export function diffSummary(summary: string, r: { a: { id: string }[]; b: { id: string }[]; shared: { id: string }[] }): string {
  const m = /^[\d,]+ tags? ranks? higher for this bill, [\d,]+ for (.+), and [\d,]+ ranks? high for both\.$/.exec(summary ?? "");
  if (!m) return summary;
  const both = new Set(r.shared.map((t) => t.id));
  const a = r.a.filter((t) => !both.has(t.id)).length;
  const b = r.b.filter((t) => !both.has(t.id)).length;
  const s = r.shared.length;
  const verb = (n: number) => (n === 1 ? "ranks" : "rank");
  return `${a} ${a === 1 ? "tag" : "tags"} ${verb(a)} higher for this bill, ${b} for ${m[1]}, and ${s} ${verb(s)} high for both.`;
}
