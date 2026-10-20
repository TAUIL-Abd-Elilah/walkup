/**
 * Hand-written entities of the fixture world: acts, film/TV titles, the one
 * venue that is a Qloo place, the operator's named partner businesses,
 * podcasts and brands.
 *
 * Names: invented for every business, podcast, brand, act and film or TV
 * title. Only the three rooms are real places.
 */
import { catalogId, syntheticSpotifyId } from "./ids";
import { taste, type Taste } from "./taste";
import { categoryTagId } from "./catalog-tags";

export type CatalogSubtype =
  | "urn:entity:artist"
  | "urn:entity:person"
  | "urn:entity:movie"
  | "urn:entity:tv_show"
  | "urn:entity:place"
  | "urn:entity:podcast"
  | "urn:entity:brand";

export type MetroKey = "nashville" | "hampton_roads" | "tacoma";

export interface CatalogEntity {
  key: string;
  id: string;
  name: string;
  subtype: CatalogSubtype;
  popularity: number;
  taste: Taste;
  tagIds: string[];
  spotifyId?: string;
  shortDescription?: string;
  releaseYear?: number;
  /** Sparse signal: thin heatmaps, few place matches, few tags. */
  thin?: boolean;
  /**
   * Listed by /search and /entities, but Qloo has no taste data for it: as a signal id it is dropped
   * with a top-level not_found warning (entity insights), dropped silently (heatmaps, tags, compare),
   * a heatmap of only such ids is still a 200 with cells, and entity insights with only such ids and no
   * filter or signal.location are a 400 on signal.interests.entities (live behaviour, Oct 15).
   */
  noSignal?: boolean;
  /** Test-only entries: never offered by insights unless asked for by id (keeps preset sheets unchanged). */
  testOnly?: boolean;
  /** Places, venues and brands: home metro. */
  metro?: MetroKey;
  location?: { lat: number; lon: number };
  /** Place-only: category key (config/tags.json naming). */
  category?: string;
  address?: string;
  priceLevel?: number;
  hours?: Record<string, { opens: string; closes: string }[]>;
}

interface Opts {
  spotify?: boolean;
  short?: string;
  year?: number;
  thin?: boolean;
}

function ent(subtype: CatalogSubtype, key: string, name: string, popularity: number, vec: Taste, tagIds: string[], o: Opts = {}): CatalogEntity {
  const e: CatalogEntity = { key, id: catalogId(key), name, subtype, popularity, taste: vec, tagIds };
  if (o.spotify) e.spotifyId = syntheticSpotifyId(key);
  if (o.short) e.shortDescription = o.short;
  if (o.year !== undefined) e.releaseYear = o.year;
  if (o.thin) e.thin = true;
  return e;
}

const G = (k: string) => `urn:tag:genre:music:${k}`;
const KW = (k: string) => `urn:tag:keyword:media:${k}`;
const TH = (k: string) => `urn:tag:theme:qloo:${k}`;
const AU = (k: string) => `urn:tag:audience:qloo:${k}`;
const COMEDIAN = "urn:tag:genre:person:comedian";
const ACTOR = "urn:tag:occupation:person:actor";

function artist(key: string, name: string, pop: number, vec: Taste, tags: string[], o: Opts = {}): CatalogEntity {
  return ent("urn:entity:artist", key, name, pop, vec, tags, { spotify: true, ...o });
}

function comedian(key: string, name: string, pop: number, vec: Taste, o: Opts = {}): CatalogEntity {
  return ent("urn:entity:person", key, name, pop, vec, [COMEDIAN, ACTOR, KW("stand_up_comedy")], o);
}

// ---------------------------------------------------------------------------
// The Truth, Nashville: bills A and B (invented acts) and the house roster
// ---------------------------------------------------------------------------

export const TRUTH_ACTS: CatalogEntity[] = [
  artist("hollis_creek", "Hollis Creek String Band", 0.58, taste({ roots: 0.95, indie_alt: 0.25, arts_dining: 0.15 }), [G("americana"), G("bluegrass"), TH("storytelling"), AU("roots_music_fans")]),
  artist("marla_vane", "Marla Vane", 0.49, taste({ roots: 0.8, indie_alt: 0.3, family: 0.2 }), [G("country"), G("folk"), G("singer_songwriter"), TH("heartbreak")]),
  artist("ferry_lights", "The Ferry Lights", 0.37, taste({ roots: 0.6, indie_alt: 0.5 }), [G("folk"), TH("road_trip")]),
  artist("neon_orchard", "Neon Orchard", 0.61, taste({ indie_alt: 0.95, hiphop_rnb: 0.2, arts_dining: 0.2 }), [G("indie_pop"), TH("city_life"), AU("indie_fans"), KW("coming_of_age")]),
  artist("sable_sun", "Sable & Sun", 0.52, taste({ hiphop_rnb: 0.6, indie_alt: 0.5, arts_dining: 0.2 }), [G("r_and_b"), G("indie_pop")]),
  artist("kites_concrete", "Kites Over Concrete", 0.35, taste({ indie_alt: 0.8, hiphop_rnb: 0.3 }), [G("alternative_rock"), TH("friendship")]),
  artist("granite_static", "Granite Static", 0.55, taste({ indie_alt: 0.7, roots: 0.25 }), [G("alternative_rock")]),
  artist("juniper_tate", "Juniper Tate", 0.6, taste({ roots: 0.55, family: 0.5, indie_alt: 0.2 }), [G("country")]),
  artist("velvet_coast", "The Velvet Coast", 0.47, taste({ indie_alt: 0.6, arts_dining: 0.3 }), [G("alternative_rock")]),
  artist("mason_reyes", "Mason Reyes Band", 0.44, taste({ roots: 0.75, latin: 0.3 }), [G("country")]),
  artist("lowland_echo", "Lowland Echo", 0.4, taste({ roots: 0.7, indie_alt: 0.4 }), [G("folk")]),
  artist("brass_lantern", "Brass Lantern Revue", 0.38, taste({ arts_dining: 0.7, hiphop_rnb: 0.3 }), [G("jazz"), G("soul")]),
  artist("cold_harbor", "Cold Harbor Kings", 0.5, taste({ indie_alt: 0.5, roots: 0.35 }), [G("alternative_rock")]),
  artist("tessa_arden", "Tessa Blue Arden", 0.63, taste({ family: 0.6, roots: 0.4, indie_alt: 0.2 }), [G("country")]),
  artist("dusty_atlas", "Dusty Atlas", 0.42, taste({ roots: 0.6, indie_alt: 0.4 }), [G("americana"), G("alternative_rock")]),
  artist("paper_satellites", "Paper Satellites", 0.46, taste({ indie_alt: 0.85, arts_dining: 0.3 }), [G("indie_pop")]),
  artist("rivergate", "Rivergate Rollers", 0.39, taste({ roots: 0.5, indie_alt: 0.4, family: 0.2 }), [G("alternative_rock")]),
  artist("wren_wolfe", "Wren & Wolfe", 0.41, taste({ indie_alt: 0.6, roots: 0.4 }), [G("folk"), G("indie_pop")]),
  artist("sundown_kids", "The Sundown Kids", 0.57, taste({ indie_alt: 0.6, roots: 0.3 }), [G("alternative_rock")]),
  artist("arlo_finch", "Arlo Finch Trio", 0.33, taste({ roots: 1 }), [G("bluegrass")]),
  artist("big_sky_static", "Big Sky Static", 0.43, taste({ indie_alt: 0.6, roots: 0.3 }), [G("alternative_rock")]),
  artist("hayes_calloway", "Hayes Calloway", 0.52, taste({ roots: 0.85 }), [G("country")]),
  artist("marigold_exit", "Marigold Exit", 0.45, taste({ indie_alt: 0.85 }), [G("indie_pop")]),
  comedian("theo_marsh", "Theo Marsh", 0.4, taste({ comedy_night: 0.9, family: 0.2 })),
];

// ---------------------------------------------------------------------------
// Hampton Coliseum: an invented comedy bill (one ambiguous one-word name, one
// thin act with a TV proxy, proxy titles for the headliner) and the roster
// ---------------------------------------------------------------------------

export const HAMPTON_ACTS: CatalogEntity[] = [
  ent("urn:entity:person", "dorian_pike", "Dorian Pike", 0.88, taste({ comedy_night: 0.7, family: 0.6, hiphop_rnb: 0.3 }), [COMEDIAN, ACTOR, "urn:tag:genre:media:family", KW("sitcom")], { short: "Comedian and actor" }),
  ent("urn:entity:person", "sidecar_person", "Sidecar", 0.62, taste({ comedy_night: 0.9, hiphop_rnb: 0.4 }), [COMEDIAN, ACTOR, KW("stand_up_comedy")], { short: "Stand-up comedian" }),
  ent("urn:entity:artist", "sidecar_band", "Sidecar", 0.31, taste({ indie_alt: 0.6, roots: 0.3 }), [G("alternative_rock")], { spotify: true, short: "Rock band" }),
  ent("urn:entity:movie", "sidecar_film", "Sidecar", 0.55, taste({ family: 0.4, roots: 0.2 }), ["urn:tag:genre:media:family"], { short: "Road movie", year: 1987 }),
  ent("urn:entity:person", "reggie_collier", "Reggie Collier", 0.33, taste({ comedy_night: 0.8, hiphop_rnb: 0.4, family: 0.3 }), [COMEDIAN, ACTOR], { short: "Actor and comedian", thin: true }),
  ent("urn:entity:movie", "pier_stand_up", "Saturday Night at the Pier", 0.78, taste({ comedy_night: 0.9, hiphop_rnb: 0.5 }), ["urn:tag:genre:media:comedy", KW("stand_up_comedy")], { short: "Stand-up concert film", year: 2001 }),
  ent("urn:entity:tv_show", "corner_house", "Corner House", 0.81, taste({ comedy_night: 0.7, family: 0.5 }), ["urn:tag:genre:media:comedy", KW("sitcom")], { short: "Sitcom", year: 2018 }),
  ent("urn:entity:movie", "corner_house_short", "Corner House", 0.12, taste({ arts_dining: 0.5 }), [], { short: "Short film (synthetic decoy)", year: 2009 }),
  ent("urn:entity:tv_show", "late_shift_diner", "Late Shift Diner", 0.86, taste({ comedy_night: 0.9, hiphop_rnb: 0.5 }), ["urn:tag:genre:media:comedy", KW("sitcom")], { short: "Sitcom", year: 1994 }),
  artist("velvet_rhodes", "Velvet Rhodes", 0.66, taste({ hiphop_rnb: 0.8, arts_dining: 0.3 }), [G("r_and_b")]),
  artist("marlo_kane", "Marlo Kane", 0.7, taste({ hiphop_rnb: 0.9 }), [G("hip_hop")]),
  artist("carter_shaw", "Carter Lynn Shaw", 0.59, taste({ roots: 0.8, family: 0.4 }), [G("country")]),
  artist("peninsula_pops", "Peninsula Pops Orchestra", 0.35, taste({ arts_dining: 0.8, family: 0.5 }), [G("jazz")]),
  artist("kendra_vale", "Kendra Vale", 0.64, taste({ hiphop_rnb: 0.7, indie_alt: 0.2 }), [G("r_and_b")]),
  artist("otis_grey", "Otis Grey", 0.5, taste({ hiphop_rnb: 0.5, roots: 0.4 }), [G("soul")]),
  artist("lyle_banner", "Lyle Banner", 0.48, taste({ roots: 0.85 }), [G("country")]),
  artist("marcus_bell", "Marcus Bell Experience", 0.45, taste({ arts_dining: 0.6, hiphop_rnb: 0.4 }), [G("jazz"), G("soul")]),
  artist("nova_tide", "Nova Tide", 0.53, taste({ indie_alt: 0.6, family: 0.4 }), [G("indie_pop")]),
  artist("orquesta_brisa", "Orquesta Brisa", 0.47, taste({ latin: 0.9 }), [G("latin_pop")]),
  artist("harbor_kings", "The Harbor Kings", 0.44, taste({ indie_alt: 0.5, roots: 0.4 }), [G("alternative_rock")]),
];

// ---------------------------------------------------------------------------
// Super Funny Comedy Club, Tacoma (invented acts; thin signal)
// ---------------------------------------------------------------------------

export const TACOMA_ACTS: CatalogEntity[] = [
  comedian("ada_pell", "Ada Pell", 0.41, taste({ comedy_night: 0.6, indie_alt: 0.6, arts_dining: 0.3 }), { short: "Stand-up comedian", thin: true }),
  comedian("tamsin_rook", "Tamsin Rook", 0.3, taste({ comedy_night: 0.8, arts_dining: 0.2 }), { short: "Stand-up comedian", thin: true }),
];

// ---------------------------------------------------------------------------
// Venues that exist as Qloo places, and the operators' named partners
// ---------------------------------------------------------------------------

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

function hours(open: string, close: string, closedDays: string[] = []): Record<string, { opens: string; closes: string }[]> {
  const out: Record<string, { opens: string; closes: string }[]> = {};
  for (const d of WEEK) out[d] = closedDays.includes(d) ? [] : [{ opens: `T${open}`, closes: `T${close}` }];
  return out;
}

function place(
  key: string,
  name: string,
  metro: MetroKey,
  lat: number,
  lon: number,
  category: string,
  vec: Taste,
  address: string,
  h: Record<string, { opens: string; closes: string }[]> | undefined,
  pop = 0.5,
): CatalogEntity {
  const e = ent("urn:entity:place", key, name, pop, vec, category ? [categoryTagId(category)] : []);
  e.metro = metro;
  e.location = { lat, lon };
  if (category) e.category = category;
  e.address = address;
  e.priceLevel = 2;
  if (h) e.hours = h;
  return e;
}

export const VENUE_PLACES: CatalogEntity[] = [
  place("hampton_coliseum", "Hampton Coliseum", "hampton_roads", 37.0347001, -76.3813675, "", taste({ comedy_night: 0.4, family: 0.4, hiphop_rnb: 0.3 }), "Hampton, VA", undefined, 0.74),
];

export const NAMED_PLACES: CatalogEntity[] = [
  // Nashville: the bill-A/B operator's own partners (invented businesses).
  place("fernhollow_pizza", "Fernhollow Pizza Co.", "nashville", 36.1781, -86.7523, "restaurant", taste({ indie_alt: 0.5, roots: 0.4 }), "1012 Linden Ave, Nashville, TN", hours("11:00", "22:00", ["Monday"]), 0.55),
  place("bellhop_records", "Bellhop Records", "nashville", 36.1552, -86.7791, "record_store", taste({ roots: 0.6, indie_alt: 0.6 }), "218 Calloway St, Nashville, TN", hours("11:00", "19:00", ["Tuesday"]), 0.5),
  place("tin_heron_tavern", "Tin Heron Tavern", "nashville", 36.1502, -86.8004, "bar", taste({ roots: 0.7, comedy_night: 0.2 }), "3405 Harlow Rd, Nashville, TN", hours("16:00", "02:00", ["Monday"]), 0.52),
  place("larkspur_cup", "Larkspur Cup Coffee", "nashville", 36.1348, -86.7902, "cafe", taste({ indie_alt: 0.6, arts_dining: 0.4 }), "77 Alder St, Nashville, TN", hours("07:00", "15:00"), 0.48),
  place("quarter_note_books", "Quarter Note Books", "nashville", 36.1449, -86.8101, "book_store", taste({ arts_dining: 0.5, roots: 0.4 }), "1520 Prescott Ave, Nashville, TN", hours("10:00", "18:00", ["Sunday"]), 0.41),
  place("row_house_barbers", "Row House Barbers", "nashville", 36.1702, -86.7401, "barber_shop", taste({ hiphop_rnb: 0.5, comedy_night: 0.3 }), "906 Kimbrough St, Nashville, TN", hours("09:00", "19:00", ["Sunday"]), 0.44),
  // Hampton Roads: the comedy-bill operator's barbershops (invented businesses).
  place("crown_clipper", "Crown & Clipper Barbershop", "hampton_roads", 37.0301, -76.3602, "barber_shop", taste({ comedy_night: 0.5, hiphop_rnb: 0.5 }), "412 Bellamy Rd, Hampton, VA", hours("09:00", "19:00", ["Sunday"]), 0.46),
  place("tidewater_fade", "Tidewater Fade Studio", "hampton_roads", 36.8602, -76.2903, "barber_shop", taste({ hiphop_rnb: 0.6, comedy_night: 0.4 }), "1730 Mercer St, Norfolk, VA", hours("10:00", "20:00", ["Monday"]), 0.43),
  place("mercury_line_cuts", "Mercury Line Cuts", "hampton_roads", 37.0004, -76.4303, "barber_shop", taste({ hiphop_rnb: 0.5, family: 0.3 }), "2208 Whitfield Rd, Newport News, VA", hours("09:00", "18:00", ["Sunday"]), 0.39),
];

// ---------------------------------------------------------------------------
// Podcasts (national) and brands (some local to a metro)
// ---------------------------------------------------------------------------

const P = (k: string) => `urn:tag:genre:podcast:${k}`;

function podcast(key: string, name: string, pop: number, vec: Taste, genre: string): CatalogEntity {
  return ent("urn:entity:podcast", key, name, pop, vec, [P(genre)]);
}

export const PODCASTS: CatalogEntity[] = [
  podcast("long_porch_hour", "The Long Porch Hour", 0.52, taste({ roots: 0.8, comedy_night: 0.2 }), "music"),
  podcast("back_booth_banter", "Back Booth Banter", 0.6, taste({ comedy_night: 0.8, indie_alt: 0.2 }), "comedy"),
  podcast("two_mics_deep", "Two Mics Deep", 0.57, taste({ comedy_night: 0.7, hiphop_rnb: 0.4 }), "comedy"),
  podcast("crate_diggers_weekly", "Crate Diggers Weekly", 0.45, taste({ indie_alt: 0.5, hiphop_rnb: 0.5 }), "music"),
  podcast("fiddle_and_steel", "Fiddle and Steel", 0.4, taste({ roots: 0.9 }), "music"),
  podcast("night_shift_laughs", "Night Shift Laughs", 0.55, taste({ comedy_night: 0.9 }), "comedy"),
  podcast("supper_club_notes", "Supper Club Notes", 0.42, taste({ arts_dining: 0.8 }), "food"),
  podcast("bassline_office_hours", "Bassline Office Hours", 0.5, taste({ hiphop_rnb: 0.8 }), "music"),
  podcast("b_side_room", "The B-Side Room", 0.47, taste({ indie_alt: 0.8 }), "music"),
  podcast("sunday_dinner_table", "Sunday Dinner Table", 0.44, taste({ family: 0.6, comedy_night: 0.4 }), "food"),
  podcast("courtside_chatter", "Courtside Chatter", 0.58, taste({ family: 0.3, hiphop_rnb: 0.3, comedy_night: 0.3 }), "sports"),
  podcast("riverbend_dispatch", "Riverbend Dispatch", 0.3, taste({ family: 0.4, roots: 0.3 }), "local_news"),
  podcast("open_mic_diaries", "Open Mic Diaries", 0.43, taste({ comedy_night: 0.8, indie_alt: 0.3 }), "comedy"),
  podcast("rhythm_rotation", "Rhythm and Rotation", 0.49, taste({ hiphop_rnb: 0.7, latin: 0.3 }), "music"),
  podcast("ritmo_semanal", "Ritmo Semanal", 0.41, taste({ latin: 0.9 }), "music"),
  podcast("harmony_road", "Harmony Road", 0.46, taste({ roots: 0.6, family: 0.4 }), "music"),
  podcast("story_hour_after_dark", "Story Hour After Dark", 0.39, taste({ comedy_night: 0.4, roots: 0.4 }), "storytelling"),
  podcast("indie_hours", "Indie Hours", 0.48, taste({ indie_alt: 0.9 }), "music"),
  podcast("soul_kitchen_radio", "Soul Kitchen Radio", 0.44, taste({ hiphop_rnb: 0.5, arts_dining: 0.5 }), "food"),
  podcast("punchline_pantry", "Punchline Pantry", 0.4, taste({ comedy_night: 0.8, family: 0.2 }), "comedy"),
  podcast("vinyl_saturdays", "Vinyl Saturdays", 0.38, taste({ indie_alt: 0.5, roots: 0.4 }), "music"),
  podcast("laugh_track_lounge", "Laugh Track Lounge", 0.5, taste({ comedy_night: 0.7, family: 0.4 }), "comedy"),
  podcast("family_plan_pod", "The Family Plan Pod", 0.36, taste({ family: 0.9 }), "storytelling"),
  podcast("gallery_hours", "Gallery Hours", 0.34, taste({ arts_dining: 0.9 }), "storytelling"),
];

const B = (k: string) => `urn:tag:genre:brand:${k}`;

function brand(key: string, name: string, pop: number, vec: Taste, genre: string, metro?: MetroKey): CatalogEntity {
  const e = ent("urn:entity:brand", key, name, pop, vec, [B(genre)]);
  if (metro) e.metro = metro;
  return e;
}

export const BRANDS: CatalogEntity[] = [
  brand("larkspur_roasting", "Larkspur Roasting Co.", 0.4, taste({ roots: 0.3, arts_dining: 0.4, indie_alt: 0.3 }), "coffee", "nashville"),
  brand("fiddleback_denim", "Fiddleback Denim", 0.36, taste({ roots: 0.6, indie_alt: 0.3 }), "apparel", "nashville"),
  brand("cumbria_guitar", "Cumbria Guitar Works", 0.33, taste({ roots: 0.7, indie_alt: 0.4 }), "music_gear", "nashville"),
  brand("hickory_barrel", "Hickory Barrel Spirits", 0.5, taste({ roots: 0.7 }), "alcohol", "nashville"),
  brand("bellwether_grocers", "Bellwether Grocers", 0.45, taste({ family: 0.5, arts_dining: 0.3 }), "grocery", "nashville"),
  brand("tidewater_sneaker_lab", "Tidewater Sneaker Lab", 0.38, taste({ hiphop_rnb: 0.7, comedy_night: 0.3 }), "sneakers", "hampton_roads"),
  brand("harborline_coffee", "Harborline Coffee", 0.37, taste({ arts_dining: 0.4, comedy_night: 0.3, family: 0.2 }), "coffee", "hampton_roads"),
  brand("chesapeake_smoke", "Bayfront Smoke Shop", 0.3, taste({ comedy_night: 0.5, hiphop_rnb: 0.3 }), "tobacco", "hampton_roads"),
  brand("peninsula_sportsbook", "Peninsula Sportsbook", 0.42, taste({ comedy_night: 0.6, hiphop_rnb: 0.3 }), "gambling", "hampton_roads"),
  brand("bayside_market", "Bayside Market", 0.44, taste({ family: 0.6, comedy_night: 0.2 }), "grocery", "hampton_roads"),
  brand("seawall_apparel", "Seawall Apparel", 0.35, taste({ hiphop_rnb: 0.4, comedy_night: 0.4 }), "apparel", "hampton_roads"),
  brand("narrows_coffee", "Narrows Coffee Co.", 0.39, taste({ indie_alt: 0.4, arts_dining: 0.4 }), "coffee", "tacoma"),
  brand("commencement_outfitters", "Commencement Outfitters", 0.34, taste({ family: 0.4, indie_alt: 0.3 }), "outdoor", "tacoma"),
  brand("tideflats_brewing", "Tideflats Brewing", 0.41, taste({ indie_alt: 0.5, comedy_night: 0.3 }), "alcohol", "tacoma"),
  brand("northbound_outdoor", "Northbound Outdoor", 0.55, taste({ family: 0.4, roots: 0.3 }), "outdoor"),
  brand("steady_groove_audio", "Steady Groove Audio", 0.5, taste({ indie_alt: 0.5, hiphop_rnb: 0.4 }), "music_gear"),
  brand("lantern_sneakers", "Lantern Sneakers", 0.58, taste({ hiphop_rnb: 0.6, indie_alt: 0.3 }), "sneakers"),
  brand("bright_day_grocery", "Bright Day Grocery", 0.6, taste({ family: 0.7 }), "grocery"),
];

// ---------------------------------------------------------------------------
// The scripted not_found case (tests only): a solo entry Qloo lists but cannot use
// as a signal, and the same act's billing name, which it can. Invented names.
// ---------------------------------------------------------------------------

export const NOT_FOUND_PAIR: CatalogEntity[] = [
  { ...artist("wade_corley", "Wade Corley", 0.8, taste({ roots: 0.9, indie_alt: 0.2 }), [G("americana"), G("country")], { short: "Singer-songwriter" }), noSignal: true, testOnly: true },
  { ...artist("wade_corley_low_ten", "Wade Corley and The Low Ten", 0.74, taste({ roots: 0.85, indie_alt: 0.3 }), [G("americana"), G("alternative_rock")], { short: "Americana band" }), testOnly: true },
];

export const CATALOG: CatalogEntity[] = [...TRUTH_ACTS, ...HAMPTON_ACTS, ...TACOMA_ACTS, ...VENUE_PLACES, ...NAMED_PLACES, ...PODCASTS, ...BRANDS, ...NOT_FOUND_PAIR];

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));
const BY_KEY = new Map(CATALOG.map((e) => [e.key, e]));
const BY_SPOTIFY = new Map(CATALOG.filter((e) => e.spotifyId).map((e) => [e.spotifyId as string, e]));

export function catalogById(id: string): CatalogEntity | undefined {
  return BY_ID.get(id);
}

export function catalogByKey(key: string): CatalogEntity {
  const e = BY_KEY.get(key);
  if (!e) throw new Error(`unknown catalog key ${key}`);
  return e;
}

export function catalogBySpotify(spotifyId: string): CatalogEntity | undefined {
  return BY_SPOTIFY.get(spotifyId);
}
