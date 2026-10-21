/**
 * The prewarmed presets, in one place: venue, the bill the selection rule
 * picked, the operator's what-if inputs and any seed plan.
 *
 * Each preset has a fixture show and room for a live one. The top-level
 * fields are the fixture show: event ids point at the fixture world and every
 * bill there is invented. `live` is a real Ticketmaster bill picked by
 * HERO_RULE (one independent room, HERO_WINDOW): g1-a and g1-b carry the two
 * hero bills at The Anthem, Washington DC, and g4-a and g4-b the two bills the
 * same rule picks at The Salt Shed, Chicago; g2 and g3 have none. The fixture
 * world has no copy of The Salt Shed, so g4-a and g4-b plan The Truth's
 * invented bills in fixture mode (`fixtureSameAs`) and the app bundles no
 * sample sheet for them.
 * presetFor(preset, mode) is the one reader of either show: a live run of a
 * preset with no live show stops with NO_LIVE_SHOW before any call. Presets carry no seats-left count; capacity and budget are
 * operator what-ifs, never sales data.
 */
import type { OperatorInputs } from "@walkup/contracts";
import type { TmEvent } from "@walkup/tm";
import { WORLD_EVENT_IDS, WORLD_VENUES, catalogByKey } from "@walkup/qloo-world";
import type { PresetId, SeedPlan } from "./types";

/**
 * A real Ticketmaster bill for a preset (npm run tm:room prints the
 * HERO_RULE picks). Real-only inputs: no fixture-world ids, and
 * declared partners by label unless a real Qloo id is known. Seeds,
 * categories and the pairing stay on the preset and apply in both modes (a
 * seed plan only applies to an act of that exact name).
 */
export interface LivePreset {
  /** Ticketmaster event the rule picked on the room's real calendar. */
  tmEventId: string;
  tmVenueId: string;
  /** Planning and recording date (YYYY-MM-DD): the roster window starts here. */
  asOf: string;
  title: string;
  venue: { name: string; city: string; state: string };
  selection: { rule: string; result: string };
  operator: OperatorInputs;
  line: string;
}

export interface Preset {
  id: PresetId;
  title: string;
  venue: { name: string; city: string; state: string; tmVenueId: string };
  /** Ticketmaster event the selection rule picked. */
  tmEventId: string;
  /** Planning date: the roster window starts here. */
  asOf: string;
  selection: { rule: string; result: string };
  operator: OperatorInputs;
  seeds?: SeedPlan[];
  categories?: string[];
  pairedWith?: PresetId;
  /** A real, publicly listed show (public facts only; counts are what-ifs). */
  realShow: boolean;
  /** One plain line for the top of the plan; {seats_left}, if used, is the operator's what-if. */
  line: string;
  /** The real bill a live run plans; null when the preset has none (see LivePreset). */
  live: LivePreset | null;
  /**
   * Set when the fixture show is another preset's (the fixture world has no copy of this room): the fixture
   * sheet generators skip this preset and the app bundles no sample sheet for it. It is a live example only.
   */
  fixtureSameAs?: PresetId;
}

/** What a preset plans in one mode: its fixture show or its live show. */
export interface PresetShow {
  tmEventId: string;
  asOf: string;
  title: string;
  venue: { name: string; city: string; state: string; tmVenueId: string };
  selection: { rule: string; result: string };
  operator: OperatorInputs;
  line: string;
  realShow: boolean;
}

/** Why a live run of a preset stopped before any call. */
export const NO_LIVE_SHOW = "This preset has no live show yet.";

/** The live hero window. The fixture presets keep G1_RULE's Nov 20 - Dec 20 window. */
export const HERO_WINDOW: Readonly<{ from: string; to: string }> = { from: "2026-12-20", to: "2027-02-28" };

/** The docs/spec.md G1 rule for the live hero bills: explainG1Rule(events, HERO_WINDOW) applies it. */
export const HERO_RULE =
  "One independent room, Dec 20 2026 to Feb 28 2027. Bill A: the first Americana, country or folk headliner on the room's Ticketmaster calendar in that window. Bill B: the bill in the same window whose genre is most distant from A (hip-hop/R&B, Latin, indie-pop or comedy). A bill whose headliner Qloo cannot match exactly is skipped, because both headliners must resolve exactly, and so is a ticket package for shows already on the calendar (a two-night pass).";

const G1_RULE =
  "Bill A: the first Americana, country or folk headliner on the room's Ticketmaster calendar between Nov 20 and Dec 20 2026. Bill B: the bill in the same window whose genre is most distant from A (hip-hop/R&B, Latin, indie-pop or comedy).";

const G1_OPERATOR: OperatorInputs = {
  seatsLeft: null,
  capacity: 4400,
  mediaBudgetUsd: 6000,
  streetTeamDays: ["thursday", "saturday"],
  radiusKm: 40,
  declaredPartners: [
    { label: "Fernhollow Pizza Co.", qlooEntityId: catalogByKey("fernhollow_pizza").id },
    { label: "Bellhop Records", qlooEntityId: catalogByKey("bellhop_records").id },
    { label: "Tin Heron Tavern", qlooEntityId: catalogByKey("tin_heron_tavern").id },
    { label: "Larkspur Cup Coffee", qlooEntityId: catalogByKey("larkspur_cup").id },
    { label: "Quarter Note Books", qlooEntityId: catalogByKey("quarter_note_books").id },
    { label: "Row House Barbers", qlooEntityId: catalogByKey("row_house_barbers").id },
    { label: "Riverside Spoke Bike Co." },
    { label: "Westside Screen Printers" },
  ],
};

/**
 * The live hero room: The Anthem, Washington DC (I.M.P., an independent promoter and venue operator).
 * The rule was run with npm run tm:room on 2026-10-20 over the room's Ticketmaster calendar:
 *   npm run tm:room -- --venue-id=KovZ917A3Y7 --as-of=2026-10-20
 * Both picks are the rule's own; no bill was skipped. Rhiannon Giddens resolves by her Spotify id and FLO by an
 * exact name search with one match; both pass the signal check.
 */
const HERO_VENUE = { name: "The Anthem", city: "Washington", state: "DC" } as const;
const HERO_VENUE_ID = "KovZ917A3Y7";
const HERO_AS_OF = "2026-10-20";
const HERO_LINE = "Same room, two crowds: two real bills at The Anthem, planned side by side.";

/** What-ifs for the hero room: the capacity is the room's published 6,000; the budget is an example. */
const HERO_OPERATOR: OperatorInputs = {
  seatsLeft: null,
  capacity: 6000,
  mediaBudgetUsd: 6000,
  streetTeamDays: ["thursday", "saturday"],
  radiusKm: 40,
  declaredPartners: [],
};

/**
 * The second live room: The Salt Shed, Chicago (the indoor Shed, 3,600). It is owned and run by 16" On Center, the
 * Chicago group behind the Empty Bottle and Thalia Hall, and is a member of the Chicago Independent Venue League;
 * Ticketmaster lists 36 of its next 44 shows (Oct 21 2026) as promoted by the venue, both picks among them.
 * The same rule, over the same window, run with npm run tm:room on 2026-10-21:
 *   npm run tm:room -- --venue-id=KovZ917AI5F --as-of=2026-10-21 --package=vvG18Z_CM8Huwe
 * The first listing in the window is a two-night pass for Greensky Bluegrass's Dec 30 and 31 shows, skipped as a
 * ticket package; bill A is the Dec 30 show itself. Greensky Bluegrass resolves by its Spotify id. The Roots'
 * Spotify id on Ticketmaster is not in Qloo, so they resolve by an exact name search with one match; both pass the
 * signal check.
 */
const CHICAGO_VENUE = { name: "The Salt Shed", city: "Chicago", state: "IL" } as const;
const CHICAGO_VENUE_ID = "KovZ917AI5F";
const CHICAGO_AS_OF = "2026-10-21";
const CHICAGO_LINE = "Same room, two crowds: two real bills at The Salt Shed, planned side by side.";

/** What-ifs for the Chicago room: the capacity is the indoor Shed's published 3,600; the budget is an example. */
const CHICAGO_OPERATOR: OperatorInputs = {
  seatsLeft: null,
  capacity: 3600,
  mediaBudgetUsd: 5000,
  streetTeamDays: ["thursday", "saturday"],
  radiusKm: 40,
  declaredPartners: [],
};

const truth = WORLD_VENUES.truth;
const hampton = WORLD_VENUES.hampton;
const superfunny = WORLD_VENUES.superfunny;

export const PRESETS: Record<PresetId, Preset> = {
  "g1-a": {
    id: "g1-a",
    title: "The Truth, Nashville: bill A",
    venue: { name: truth.name, city: truth.city, state: truth.state, tmVenueId: truth.id },
    tmEventId: WORLD_EVENT_IDS.g1a,
    asOf: "2026-10-30",
    selection: { rule: G1_RULE, result: "Bill A" },
    operator: G1_OPERATOR,
    pairedWith: "g1-b",
    realShow: false,
    line: "Same room, two crowds: two bills at The Truth, planned side by side.",
    live: {
      tmEventId: "1AvfZ_3Gkmo647x",
      tmVenueId: HERO_VENUE_ID,
      asOf: HERO_AS_OF,
      title: "The Anthem, Washington DC: bill A",
      venue: HERO_VENUE,
      selection: { rule: HERO_RULE, result: "Bill A: Rhiannon Giddens, Sun Feb 28 2027 (Country), the only Americana, country or folk bill in the window." },
      operator: HERO_OPERATOR,
      line: HERO_LINE,
    },
  },
  "g1-b": {
    id: "g1-b",
    title: "The Truth, Nashville: bill B",
    venue: { name: truth.name, city: truth.city, state: truth.state, tmVenueId: truth.id },
    tmEventId: WORLD_EVENT_IDS.g1b,
    asOf: "2026-10-30",
    selection: { rule: G1_RULE, result: "Bill B" },
    operator: G1_OPERATOR,
    pairedWith: "g1-a",
    realShow: false,
    line: "Same room, two crowds: two bills at The Truth, planned side by side.",
    live: {
      tmEventId: "1A4Zk4vGkemjaL_",
      tmVenueId: HERO_VENUE_ID,
      asOf: HERO_AS_OF,
      title: "The Anthem, Washington DC: bill B",
      venue: HERO_VENUE,
      selection: { rule: HERO_RULE, result: "Bill B: FLO, Therapy At The Club Tour, Wed Feb 17 2027 (R&B), the genre most distant from bill A." },
      operator: HERO_OPERATOR,
      line: HERO_LINE,
    },
  },
  g2: {
    id: "g2",
    title: "Hampton Coliseum: Peninsula Comedy Night",
    venue: { name: hampton.name, city: hampton.city, state: hampton.state, tmVenueId: hampton.id },
    tmEventId: WORLD_EVENT_IDS.g2,
    asOf: "2026-10-17",
    selection: { rule: "An invented three-act comedy bill at Hampton Coliseum on Sat Dec 19 2026, with a one-word act name that matches more than one catalog entry.", result: "Peninsula Comedy Night" },
    operator: {
      seatsLeft: null,
      capacity: null,
      mediaBudgetUsd: null,
      streetTeamDays: ["thursday", "friday"],
      radiusKm: 40,
      declaredPartners: [
        { label: "HBCU alumni chapter, Peninsula (operator contact)" },
        { label: "Divine Nine graduate chapter, Norfolk (operator contact)" },
        { label: "Congregation outreach team, Newport News (operator contact)" },
        { label: "Crown & Clipper Barbershop", qlooEntityId: catalogByKey("crown_clipper").id },
        { label: "Tidewater Fade Studio", qlooEntityId: catalogByKey("tidewater_fade").id },
        { label: "Mercury Line Cuts", qlooEntityId: catalogByKey("mercury_line_cuts").id },
        { label: "Southside Social Hall" },
      ],
    },
    // Stand-ins only for a thin act. The headliner is his own seed: on Oct 15 a well-known
    // comedian's own map had 335 areas (probe 6) and no sign of a skewed profile (probe 7).
    seeds: [
      {
        act: "Reggie Collier",
        proxies: [{ query: "Late Shift Diner", type: "tv_show", releaseYear: 1994 }],
        reason: "Qloo has little on Reggie Collier, so his TV series stands in.",
      },
    ],
    categories: ["restaurant", "bar", "barber_shop", "record_store", "beauty_salon"],
    realShow: false,
    line: "One act's name matches more than one catalog entry, so Walkup asks you to pick before it plans.",
    // No live show: only g1-a, g1-b, g4-a and g4-b carry real bills.
    live: null,
  },
  g3: {
    id: "g3",
    title: "Super Funny, Tacoma",
    venue: { name: superfunny.name, city: superfunny.city, state: superfunny.state, tmVenueId: superfunny.id },
    tmEventId: WORLD_EVENT_IDS.g3,
    asOf: "2026-11-20",
    selection: { rule: "An invented two-night bill at Super Funny Comedy Club, Tacoma: Fri Dec 4 2026, the first of the two nights.", result: "Friday show" },
    operator: {
      seatsLeft: null,
      capacity: 320,
      mediaBudgetUsd: 600,
      streetTeamDays: ["wednesday", "thursday"],
      radiusKm: 40,
      declaredPartners: [],
    },
    realShow: false,
    line: "A small club with thin signal: each fallback says why it was taken.",
    // No live show: only g1-a, g1-b, g4-a and g4-b carry real bills.
    live: null,
  },
  "g4-a": {
    id: "g4-a",
    title: "The Truth, Nashville: bill A",
    venue: { name: truth.name, city: truth.city, state: truth.state, tmVenueId: truth.id },
    tmEventId: WORLD_EVENT_IDS.g1a,
    asOf: "2026-10-30",
    selection: { rule: G1_RULE, result: "Bill A" },
    operator: G1_OPERATOR,
    pairedWith: "g4-b",
    realShow: false,
    line: "Same room, two crowds: two bills at The Truth, planned side by side.",
    fixtureSameAs: "g1-a",
    live: {
      tmEventId: "vvG18Z_CM8zcsl",
      tmVenueId: CHICAGO_VENUE_ID,
      asOf: CHICAGO_AS_OF,
      title: "The Salt Shed, Chicago: bill A",
      venue: CHICAGO_VENUE,
      selection: {
        rule: HERO_RULE,
        result:
          "Bill A: Greensky Bluegrass, Wed Dec 30 2026 (Bluegrass), the first Americana, country or folk bill in the window (the two-night pass listed the same day is a ticket package, not a show).",
      },
      operator: CHICAGO_OPERATOR,
      line: CHICAGO_LINE,
    },
  },
  "g4-b": {
    id: "g4-b",
    title: "The Truth, Nashville: bill B",
    venue: { name: truth.name, city: truth.city, state: truth.state, tmVenueId: truth.id },
    tmEventId: WORLD_EVENT_IDS.g1b,
    asOf: "2026-10-30",
    selection: { rule: G1_RULE, result: "Bill B" },
    operator: G1_OPERATOR,
    pairedWith: "g4-a",
    realShow: false,
    line: "Same room, two crowds: two bills at The Truth, planned side by side.",
    fixtureSameAs: "g1-b",
    live: {
      tmEventId: "vv1kvZvPodGA5phKX",
      tmVenueId: CHICAGO_VENUE_ID,
      asOf: CHICAGO_AS_OF,
      title: "The Salt Shed, Chicago: bill B",
      venue: CHICAGO_VENUE,
      selection: {
        rule: HERO_RULE,
        result: "Bill B: The Roots, Fri Jan 15 2027 (Hip-Hop/Rap), the genre most distant from bill A.",
      },
      operator: CHICAGO_OPERATOR,
      line: CHICAGO_LINE,
    },
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export function presetById(id: string): Preset | null {
  return (PRESETS as Record<string, Preset>)[id] ?? null;
}

/**
 * The show a preset plans in this mode: the fixture fields in fixture mode,
 * the live block in live mode (a real show), or null in live mode while the
 * preset has no live show.
 */
export function presetFor(preset: Preset, mode: "fixture"): PresetShow;
export function presetFor(preset: Preset, mode: "live" | "fixture"): PresetShow | null;
export function presetFor(preset: Preset, mode: "live" | "fixture"): PresetShow | null {
  if (mode === "fixture") {
    const { tmEventId, asOf, title, venue, selection, operator, line, realShow } = preset;
    return { tmEventId, asOf, title, venue, selection, operator, line, realShow };
  }
  const live = preset.live;
  if (!live) return null;
  return {
    tmEventId: live.tmEventId,
    asOf: live.asOf,
    title: live.title,
    venue: { ...live.venue, tmVenueId: live.tmVenueId },
    selection: live.selection,
    operator: live.operator,
    line: live.line,
    realShow: true,
  };
}

/**
 * The name a preset gives the Ticketmaster venue `tmVenueId` in `mode`, or null when no preset plans a show there.
 * Ticketmaster's own venue name can be a box-office label ("The Salt Shed Indoors (Shed)").
 */
export function presetVenueName(mode: "live" | "fixture", tmVenueId: string): string | null {
  for (const preset of Object.values(PRESETS)) {
    const show = presetFor(preset, mode);
    if (show && show.venue.tmVenueId === tmVenueId && show.venue.name.trim() !== "") return show.venue.name;
  }
  return null;
}

/**
 * The preset's show in `mode` when `bill` is that show's event, else null. A
 * run recorded before the preset's show changed (a postponed pick replaced on
 * key day, a live block set back to null) planned another event: it is not
 * the preset any more and takes none of the show's title, line or inputs.
 */
export function presetShowOf(preset: Preset, mode: "live" | "fixture", bill: { tmEventId?: string } | undefined): PresetShow | null {
  const show = presetFor(preset, mode);
  return show && bill?.tmEventId === show.tmEventId ? show : null;
}

// ---------------------------------------------------------------------------
// The G1 bill selection rule, as code
// ---------------------------------------------------------------------------

export type GenreClass = "roots" | "hiphop" | "rnb" | "latin" | "comedy" | "indie_pop" | "other";

/** Distance of each eligible genre from a roots bill (higher = more distant). */
export const DISTANCE_FROM_ROOTS: Readonly<Record<GenreClass, number>> = {
  hiphop: 1,
  rnb: 0.95,
  latin: 0.9,
  comedy: 0.85,
  indie_pop: 0.8,
  roots: 0,
  other: 0,
};

const GENRE_WORDS: Record<GenreClass, string> = {
  roots: "Americana, country or folk",
  hiphop: "hip-hop",
  rnb: "R&B",
  latin: "Latin",
  comedy: "comedy",
  indie_pop: "indie pop",
  other: "other",
};

/** G1_RULE's window, the default for the fixture presets. */
const G1_WINDOW = { from: "2026-11-20", to: "2026-12-20" };

export function genreClass(e: TmEvent): GenreClass {
  const c = e.classifications?.[0];
  const names = [c?.genre?.name, c?.subGenre?.name].filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (has(/americana|country|folk|bluegrass/)) return "roots";
  if (has(/hip-hop|rap/)) return "hiphop";
  if (has(/r&b|rnb/)) return "rnb";
  if (has(/latin|salsa|reggaeton/)) return "latin";
  if (has(/comedy/)) return "comedy";
  if (has(/indie pop|^pop$/)) return "indie_pop";
  return "other";
}

/** One event dated in the rule's window, as the rule saw it. */
export interface G1Candidate {
  id: string;
  /** Venue-local date (YYYY-MM-DD). */
  localDate: string;
  name: string;
  /** Ticketmaster status code (onsale, offsale, canceled, postponed, rescheduled); null when absent. */
  status: string | null;
  genre: string | null;
  subGenre: string | null;
  genreClass: GenreClass;
  /** DISTANCE_FROM_ROOTS of its class; 0 never makes bill B. */
  distance: number;
  /** False for a canceled event or one listed as unresolved: the rule skips it. */
  eligible: boolean;
  /** Why the rule skipped it, when it did. */
  skipped?: string;
}

export interface G1Options {
  /**
   * Events whose headliner Qloo cannot match exactly, by Ticketmaster event id, with the reason
   * (the spec needs both hero headliners to resolve exactly). The rule skips them, and says so.
   */
  unresolved?: Readonly<Record<string, string>>;
}

export interface G1Pick {
  /** Ticketmaster event id; null when nothing qualifies. */
  id: string | null;
  /** One line: why this bill, or why none. */
  reason: string;
}

export interface G1Explanation {
  window: { from: string; to: string };
  /** Every event dated in the window, by date. */
  candidates: G1Candidate[];
  billA: G1Pick;
  billB: G1Pick;
}

const localDateOf = (e: TmEvent): string => e.dates?.start?.localDate ?? "";

function isCanceled(e: TmEvent): boolean {
  const code = e.dates?.status?.code?.toLowerCase();
  return code === "canceled" || code === "cancelled";
}

/** Discovery's "Undefined" placeholder is not a label. */
const label = (s: string | undefined): string | null => (s && s.trim() !== "" && s !== "Undefined" ? s : null);

function candidateOf(e: TmEvent): G1Candidate {
  const c = e.classifications?.[0];
  const cls = genreClass(e);
  return {
    id: e.id,
    localDate: localDateOf(e),
    name: e.name ?? e.id,
    status: e.dates?.status?.code ?? null,
    genre: label(c?.genre?.name),
    subGenre: label(c?.subGenre?.name),
    genreClass: cls,
    distance: DISTANCE_FROM_ROOTS[cls],
    eligible: !isCanceled(e),
  };
}

function billWords(c: G1Candidate): string {
  const genre = [c.genre, c.subGenre].filter((x): x is string => x !== null);
  return `${c.name} on ${c.localDate}${genre.length > 0 ? ` (${genre.join(" / ")})` : ""}`;
}

/**
 * The G1 rule with its working shown: every event dated in the window and a
 * one-line reason for each pick. applyG1Rule returns the same picks.
 */
export function explainG1Rule(events: readonly TmEvent[], window: { from: string; to: string } = G1_WINDOW, opts: G1Options = {}): G1Explanation {
  const span = `${window.from} to ${window.to}`;
  const unresolved = opts.unresolved ?? {};
  const skippedWhy = (e: TmEvent): string | undefined => unresolved[e.id];
  const inside = events.filter((e) => {
    const d = localDateOf(e);
    return d >= window.from && d <= window.to;
  });
  const candidates = [...inside]
    .sort((a, b) => localDateOf(a).localeCompare(localDateOf(b)))
    .map((e) => {
      const c = candidateOf(e);
      const why = skippedWhy(e);
      return why && c.eligible ? { ...c, eligible: false, skipped: why } : c;
    });
  const base = { window: { from: window.from, to: window.to }, candidates };
  // The rule's own order: events still on, by local date (the sort applyG1Rule has always used).
  const ranked = inside.filter((e) => !isCanceled(e) && !skippedWhy(e)).sort((a, b) => (localDateOf(a) < localDateOf(b) ? -1 : 1));
  const a = ranked.find((e) => genreClass(e) === "roots") ?? null;
  // Roots bills on or before A's date that the rule skipped, named in A's reason.
  const passedOver = inside
    .filter((e) => !isCanceled(e) && skippedWhy(e) && genreClass(e) === "roots" && (!a || localDateOf(e) <= localDateOf(a)))
    .map((e) => ` Skipped ${billWords(candidateOf(e))}: ${skippedWhy(e)}.`)
    .join("");
  if (!a) {
    return { ...base, billA: { id: null, reason: `No Americana, country or folk bill from ${span}.${passedOver}` }, billB: { id: null, reason: "No bill A, so no bill B." } };
  }
  const billA: G1Pick = { id: a.id, reason: `First Americana, country or folk bill from ${span}: ${billWords(candidateOf(a))}.${passedOver}` };
  let best: { e: TmEvent; d: number; date: string } | null = null;
  for (const e of ranked) {
    if (e.id === a.id) continue;
    const d = DISTANCE_FROM_ROOTS[genreClass(e)];
    const date = localDateOf(e);
    if (d > 0 && (!best || d > best.d || (d === best.d && date < best.date))) best = { e, d, date };
  }
  if (!best) return { ...base, billA, billB: { id: null, reason: `No hip-hop, R&B, Latin, comedy or indie-pop bill from ${span} besides bill A.` } };
  const b = candidateOf(best.e);
  const d = best.d;
  const tied = ranked.filter((e) => e.id !== a.id && DISTANCE_FROM_ROOTS[genreClass(e)] === d).length;
  const tie = tied > 1 ? `, the earliest of ${tied} at that distance` : "";
  return { ...base, billA, billB: { id: b.id, reason: `Genre most distant from bill A (${GENRE_WORDS[b.genreClass]}, distance ${d}${tie}): ${billWords(b)}.` } };
}

/**
 * Applies the G1 rule to a room's calendar. Null fields when no event
 * qualifies (the spec then falls back to another Nashville room).
 */
export function applyG1Rule(events: readonly TmEvent[], window = G1_WINDOW, opts: G1Options = {}): { billA: string | null; billB: string | null } {
  const { billA, billB } = explainG1Rule(events, window, opts);
  return { billA: billA.id, billB: billB.id };
}
