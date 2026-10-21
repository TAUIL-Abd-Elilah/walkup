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
 * - Unbacked claims: forecasts ("expected", "projected") and "concentrated" / "most common" always fail.
 *   A superlative ("the most", "largest", "highest", "strongest") passes only when it is about lift, bill
 *   percentile, adult population or the budget split and the area it is about really has the maximum.
 * - Partner lines: may name only the tags the partner panel shows as "Tags it shares" (`explain.tags`; the
 *   place's own tags on sheets without them). Any genre or audience word known to the sheet that is not one
 *   of them fails the line, as does a weekday other than the street-team day.
 *
 * Fan copy: audience and identity tags never appear, and every line names the act.
 */
import type { CopyHook, LiftTile, Partner, StreetSheet } from "@walkup/contracts";
import { audienceWordIn, isAudienceTag, normalizeWords } from "./audience";
import { displayDate, headlinerName, type PreparedRun } from "./facts";
import { blankProtected, isDeniedTag } from "./policy";
import { templatePartnerLine, templateSummary, templateTileWhy } from "./template";
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
];

const SUPERLATIVE_RE = /\bthe\s+most\b|\b(?:largest|highest|biggest|greatest|strongest)\b/gi;

type Metric = "lift" | "billPct" | "adults" | "budget";

function metricOf(window: string): Metric | null {
  if (/\bbudget\b|\bsplit\b/i.test(window)) return "budget";
  if (/\badults?\b|\bpopulation\b|\bresidents\b/i.test(window)) return "adults";
  if (/\bbill(?:'s)?\s+(?:crowd(?:'s)?\s+)?(?:share|percentile)\b|\bshare of (?:the |this )?(?:bill|crowd)\b|\bpercentile\b/i.test(window)) return "billPct";
  if (/\blift\b|\btimes\b|\bstands? out\b|\bover-?index/i.test(window)) return "lift";
  return null;
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
  /** Every area the sheet shows (superlatives are checked against these). */
  pool: LiftTile[];
  /** The areas the narration is about (the summary's majority rule uses these). */
  top: LiftTile[];
  partners: Map<string, Partner>;
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

/** "differs most", "stands out most", "most different": a superlative about lift in other words. */
const MOST_RE = /\b(?:differs?|stands?\s+out|lifts?|over-?index(?:es)?)\s+(?:the\s+)?most\b|\bmost\s+different\b/gi;

/**
 * "then work Laurel and Bowie, where the crowd differs most": the areas such a phrase is about (named just after
 * it, else in the same clause before it) must have the highest lift on the sheet.
 */
function mostProblem(ctx: VetContext, sentence: string): string | null {
  for (const m of sentence.matchAll(MOST_RE)) {
    const at = m.index ?? 0;
    const after = sentence.slice(at + m[0].length).split(/[,;]/)[0] ?? "";
    let about = tilesNamedIn(ctx, after.slice(0, 60));
    if (about.length === 0) {
      const before = sentence.slice(0, at);
      const clause = before.split(/,\s*(?:then|and then|then\s+work)\b|[;:]/i).pop() ?? before;
      about = tilesNamedIn(ctx, clause);
    }
    if (about.length === 0 || !about.every((t) => isMax(ctx, t, "lift"))) return `"${m[0].toLowerCase()}" not backed by the sheet's numbers`;
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
  }
  return null;
}

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PARTNER_COUNT_RE = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:partner(?:s| places?)?|places? on the (?:sheet|list|street team's route))\b/gi;

function tileProblem(ctx: VetContext, text: string, tile: LiftTile | undefined): string | null {
  const subjects = tile ? [tile] : [];
  const base = directionProblemForTiles(ctx, text, subjects, false) ?? claimProblem(ctx, text, subjects);
  if (base) return base;
  for (const sentence of splitSentences(text)) {
    const share = shareProblem(ctx, sentence);
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
      if (n !== have) return `says ${m[1]} partners, the sheet has ${have} in this area`;
    }
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

function partnerProblem(ctx: VetContext, text: string, partner: Partner | undefined): string | null {
  const tile = partner?.tileGeohash ? ctx.pool.find((t) => t.geohash === partner.tileGeohash) : undefined;
  const claim = claimProblem(ctx, text, tile ? [tile] : []);
  if (claim) return claim;
  const diet = dietTypeProblem(text, partner);
  if (diet) return diet;
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

/** The sheet's own words for what ran: a genre baseline and non-local sponsors (as the orchestrator's honestWording). */
function honestFor(sheet: StreetSheet): (s: string) => string {
  const tagBaseline = sheet.cards?.liftMap?.results?.diagnostics?.baseline === "tag";
  const localSponsor = (sheet.cards?.media?.results ?? []).some((m) => m.kind === "sponsor" && m.scope === "local");
  return (s) => {
    let out = s;
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
  const input: NarrateInput = {
    bill: sheet.bill,
    tiles: top,
    partners,
    prePost: c?.prePost?.results ?? [],
    media: c?.media?.results ?? [],
    compareTags: { shared: [], a: wdA, b: [], fromTagDiff: c?.whatsDifferent?.results?.fromTagDiff ?? false },
    allowlistTags: wdA.map((t) => ({ id: t.id, name: t.name })),
    numbers: [],
    hypothetical: sheet.hypothetical,
    streetTeamDay: streetDay,
  };
  let summary: string | null = null;
  return {
    venue: finite(sheet.bill?.venue?.lat) && finite(sheet.bill?.venue?.lon) ? { lat: sheet.bill.venue.lat, lon: sheet.bill.venue.lon } : null,
    pool,
    top,
    partners: new Map(partners.map((p) => [p.entity.entityId, p])),
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
    pool: input.tiles,
    top: input.tiles,
    partners: new Map(input.partners.map((p) => [p.entity.entityId, p])),
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
 * Drops hooks that cite an audience, identity or denied tag, use an audience word or make a claim the sheet can't
 * back (`HOOK_CLAIM_RE`), puts the headliner in
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
 * Fan copy for a sheet (default: the copy card's lines). Drops any line that cites an audience or identity
 * tag or uses an audience word, and makes every remaining line name the act. When nothing is left, one
 * line built only from the act, the venue and the date: "<Act> at <Venue>, <Weekday, Mon D>."
 */
export function vetCopyHooks(sheet: StreetSheet, hooks?: CopyHook[]): CopyHook[] {
  const list = hooks ?? sheet.cards?.copyHooks?.results ?? [];
  const tags = sheetTags(sheet);
  const tagNames = new Map<string, string>();
  for (const t of tags) if (t.name && !tagNames.has(t.id)) tagNames.set(t.id, t.name);
  // Names of the sheet's audience tags ("Passionate", "Youthful") also mark a line as describing the crowd.
  const extraAudienceWords = dedupeStrings(tags.filter((t) => t.id.startsWith("urn:tag:audience:") && t.name).map((t) => t.name ?? ""));
  const acts = actsOf(sheet.bill);
  const headliner = headlinerName(sheet.bill);
  const venue = sheet.bill.venue?.name?.trim() ?? "";
  const { hooks: out } = vetHookList(list, {
    acts,
    headliner,
    protectedNames: dedupeStrings([...acts, venue, sheet.bill.venue?.city ?? ""]),
    tagNames,
    extraAudienceWords,
  });
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
