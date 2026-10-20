/**
 * The four prewarmed presets, in one place: venue, the bill the selection rule
 * picked, the operator's what-if inputs and any seed plan.
 *
 * Event ids point at the fixture world until key day; live runs use the
 * Ticketmaster ids the same rules pick from the real calendars. Every bill
 * here is invented. Presets carry no seats-left count; capacity and budget
 * are operator what-ifs, never sales data.
 */
import type { OperatorInputs } from "@walkup/contracts";
import type { TmEvent } from "@walkup/tm";
import { WORLD_EVENT_IDS, WORLD_VENUES, catalogByKey } from "@walkup/qloo-world";
import type { PresetId, SeedPlan } from "./types";

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
}

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
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export function presetById(id: string): Preset | null {
  return (PRESETS as Record<string, Preset>)[id] ?? null;
}

// ---------------------------------------------------------------------------
// The G1 bill selection rule, as code
// ---------------------------------------------------------------------------

type GenreClass = "roots" | "hiphop" | "rnb" | "latin" | "comedy" | "indie_pop" | "other";

/** Distance of each eligible genre from a roots bill (higher = more distant). */
const DISTANCE_FROM_ROOTS: Record<GenreClass, number> = {
  hiphop: 1,
  rnb: 0.95,
  latin: 0.9,
  comedy: 0.85,
  indie_pop: 0.8,
  roots: 0,
  other: 0,
};

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

/**
 * Applies the G1 rule to a room's calendar. Null fields when no event
 * qualifies (the spec then falls back to another Nashville room).
 */
export function applyG1Rule(events: readonly TmEvent[], window = { from: "2026-11-20", to: "2026-12-20" }): { billA: string | null; billB: string | null } {
  const inWindow = events
    .filter((e) => {
      const d = e.dates?.start?.localDate ?? "";
      const code = e.dates?.status?.code?.toLowerCase();
      return d >= window.from && d <= window.to && code !== "canceled" && code !== "cancelled";
    })
    .sort((a, b) => ((a.dates?.start?.localDate ?? "") < (b.dates?.start?.localDate ?? "") ? -1 : 1));
  const a = inWindow.find((e) => genreClass(e) === "roots") ?? null;
  if (!a) return { billA: null, billB: null };
  let best: { id: string; d: number; date: string } | null = null;
  for (const e of inWindow) {
    if (e.id === a.id) continue;
    const d = DISTANCE_FROM_ROOTS[genreClass(e)];
    const date = e.dates?.start?.localDate ?? "";
    if (d > 0 && (!best || d > best.d || (d === best.d && date < best.date))) best = { id: e.id, d, date };
  }
  return { billA: a.id, billB: best?.id ?? null };
}
