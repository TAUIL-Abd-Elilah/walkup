/**
 * Ticketmaster side of the fixture world: three venues and a roster of
 * upcoming events per venue. Bodies follow the Discovery v2 shapes that
 * @walkup/tm reads. Venue points for the two rooms without a public map
 * point are approximate; Hampton Coliseum uses its OpenStreetMap point.
 */
import { catalogByKey, type MetroKey } from "./catalog-entities";
import { tmId } from "./ids";

export interface WorldVenue {
  key: string;
  id: string;
  name: string;
  city: string;
  state: string;
  stateName: string;
  postalCode: string;
  timezone: string;
  /** Hours to add to local time to get UTC in Nov-Dec. */
  utcOffsetHours: number;
  lat: number;
  lon: number;
  metro: MetroKey;
  address: string;
}

export const WORLD_VENUES: Record<"truth" | "hampton" | "superfunny", WorldVenue> = {
  truth: {
    key: "truth",
    id: tmId("ven", "truth"),
    name: "The Truth",
    city: "Nashville",
    state: "TN",
    stateName: "Tennessee",
    postalCode: "37203",
    timezone: "America/Chicago",
    utcOffsetHours: 6,
    lat: 36.1612,
    lon: -86.7745,
    metro: "nashville",
    address: "Example address (synthetic)",
  },
  hampton: {
    key: "hampton",
    id: tmId("ven", "hampton"),
    name: "Hampton Coliseum",
    city: "Hampton",
    state: "VA",
    stateName: "Virginia",
    postalCode: "23666",
    timezone: "America/New_York",
    utcOffsetHours: 5,
    lat: 37.0347001,
    lon: -76.3813675,
    metro: "hampton_roads",
    address: "Coliseum Dr",
  },
  superfunny: {
    key: "superfunny",
    id: tmId("ven", "superfunny"),
    name: "Super Funny Comedy Club",
    city: "Tacoma",
    state: "WA",
    stateName: "Washington",
    postalCode: "98402",
    timezone: "America/Los_Angeles",
    utcOffsetHours: 8,
    lat: 47.244,
    lon: -122.453,
    metro: "tacoma",
    address: "Example address (synthetic)",
  },
};

/** An attraction on a bill: a catalog act, or a name Qloo does not know. */
export interface WorldAttraction {
  key: string;
  name: string;
  /** Catalog key when the act exists in the Qloo side of the world. */
  catalogKey?: string;
  /** Whether Ticketmaster lists a Spotify link for it. */
  spotify: boolean;
  comedy?: boolean;
}

function act(catalogKey: string, spotify = true): WorldAttraction {
  const e = catalogByKey(catalogKey);
  const a: WorldAttraction = { key: catalogKey, name: e.name, catalogKey, spotify: spotify && !!e.spotifyId };
  if (e.subtype === "urn:entity:person") a.comedy = true;
  return a;
}

function unknownAct(key: string, name: string, comedy = false): WorldAttraction {
  const a: WorldAttraction = { key, name, spotify: false };
  if (comedy) a.comedy = true;
  return a;
}

export interface WorldEvent {
  key: string;
  id: string;
  venue: keyof typeof WORLD_VENUES;
  name: string;
  localDate: string;
  localTime: string;
  segment: string;
  genre: string;
  subGenre?: string;
  attractions: WorldAttraction[];
  /** Ticketmaster ageRestrictions.legalAgeEnforced; undefined = field absent. */
  legalAgeEnforced?: boolean;
  status?: string;
}

function ev(
  venue: keyof typeof WORLD_VENUES,
  key: string,
  localDate: string,
  name: string,
  attractions: WorldAttraction[],
  cls: [string, string, string?],
  extra: Partial<WorldEvent> = {},
): WorldEvent {
  const time = venue === "truth" ? "20:00:00" : venue === "hampton" ? "19:30:00" : "19:00:00";
  const e: WorldEvent = {
    key,
    id: tmId("ev", key),
    venue,
    name,
    localDate,
    localTime: time,
    segment: cls[0],
    genre: cls[1],
    attractions,
    ...extra,
  };
  if (cls[2]) e.subGenre = cls[2];
  return e;
}

const ROCK: [string, string, string] = ["Music", "Rock", "Alternative Rock"];
const COUNTRY: [string, string, string] = ["Music", "Country", "Country"];
const FOLK: [string, string, string] = ["Music", "Folk", "Folk"];
const COMEDY: [string, string] = ["Arts & Theatre", "Comedy"];

export const WORLD_EVENTS: WorldEvent[] = [
  // ---- The Truth, Nashville ---------------------------------------------------
  ev("truth", "truth-1031-granite", "2026-10-31", "Granite Static", [act("granite_static")], ROCK),
  ev("truth", "truth-1101-velvet", "2026-11-01", "The Velvet Coast", [act("velvet_coast")], ROCK),
  ev("truth", "truth-1102-wren", "2026-11-02", "Wren & Wolfe", [act("wren_wolfe")], FOLK),
  ev("truth", "truth-1103-wren", "2026-11-03", "Wren & Wolfe", [act("wren_wolfe")], FOLK),
  ev("truth", "truth-1104-tessa", "2026-11-04", "Tessa Blue Arden", [act("tessa_arden")], COUNTRY),
  ev("truth", "truth-1105-tessa", "2026-11-05", "Tessa Blue Arden", [act("tessa_arden")], COUNTRY),
  ev("truth", "truth-1106-juniper", "2026-11-06", "Juniper Tate", [act("juniper_tate")], COUNTRY),
  ev("truth", "truth-1107-juniper", "2026-11-07", "Juniper Tate", [act("juniper_tate")], COUNTRY),
  ev("truth", "truth-1108-theo", "2026-11-08", "Theo Marsh: Live", [act("theo_marsh", false)], COMEDY),
  ev("truth", "truth-1109-bigsky", "2026-11-09", "Big Sky Static", [act("big_sky_static")], ROCK),
  ev("truth", "truth-1110-sundown", "2026-11-10", "The Sundown Kids", [act("sundown_kids")], ROCK),
  ev("truth", "truth-1111-sundown", "2026-11-11", "The Sundown Kids", [act("sundown_kids")], ROCK),
  ev("truth", "truth-1113-mason", "2026-11-13", "Mason Reyes Band", [act("mason_reyes")], COUNTRY),
  ev("truth", "truth-1114-lowland", "2026-11-14", "Lowland Echo", [act("lowland_echo")], FOLK),
  ev("truth", "truth-1115-parking", "2026-11-15", "The Truth Premium Parking Pass", [], ["Miscellaneous", "Undefined"]),
  ev("truth", "truth-1116-brass", "2026-11-16", "Brass Lantern Revue", [act("brass_lantern")], ["Music", "Jazz", "Soul"]),
  ev("truth", "truth-1117-cold", "2026-11-17", "Cold Harbor Kings", [act("cold_harbor")], ROCK),
  ev("truth", "truth-1118-cold", "2026-11-18", "Cold Harbor Kings", [act("cold_harbor")], ROCK),
  ev(
    "truth",
    "truth-1120-hollis",
    "2026-11-20",
    "Hollis Creek String Band & Marla Vane with The Ferry Lights",
    [act("hollis_creek"), act("marla_vane"), act("ferry_lights", false)],
    ["Music", "Country", "Americana"],
    { legalAgeEnforced: true },
  ),

  ev("truth", "truth-1122-velvet", "2026-11-22", "The Velvet Coast", [act("velvet_coast")], ROCK, { status: "canceled" }),
  ev("truth", "truth-1201-granite", "2026-12-01", "Granite Static", [act("granite_static")], ROCK),
  ev(
    "truth",
    "truth-1205-neon",
    "2026-12-05",
    "Neon Orchard and Sable & Sun with Kites Over Concrete",
    [act("neon_orchard"), act("sable_sun"), act("kites_concrete", false)],
    ["Music", "Pop", "Indie Pop"],
    { legalAgeEnforced: false },
  ),
  ev("truth", "truth-1210-dusty", "2026-12-10", "Dusty Atlas", [act("dusty_atlas")], ROCK),
  ev("truth", "truth-1212-juniper", "2026-12-12", "Juniper Tate", [act("juniper_tate")], COUNTRY),
  ev("truth", "truth-1218-paper", "2026-12-18", "Paper Satellites", [act("paper_satellites")], ["Music", "Rock", "Indie Rock"]),
  ev("truth", "truth-1219-rivergate", "2026-12-19", "Rivergate Rollers", [act("rivergate")], ROCK),
  ev("truth", "truth-1231-tessa", "2026-12-31", "Tessa Blue Arden: New Year's Eve", [act("tessa_arden")], COUNTRY),
  ev("truth", "truth-0108-wren", "2027-01-08", "Wren & Wolfe", [act("wren_wolfe")], FOLK),
  ev("truth", "truth-0115-arlo", "2027-01-15", "Arlo Finch Trio", [act("arlo_finch")], ["Music", "Folk", "Bluegrass"]),
  ev("truth", "truth-0122-bigsky", "2027-01-22", "Big Sky Static", [act("big_sky_static")], ROCK),
  ev("truth", "truth-0129-hayes", "2027-01-29", "Hayes Calloway", [act("hayes_calloway")], COUNTRY),
  ev("truth", "truth-0205-marigold", "2027-02-05", "Marigold Exit", [act("marigold_exit")], ["Music", "Rock", "Indie Rock"]),
  ev("truth", "truth-0206-granite", "2027-02-06", "Granite Static", [act("granite_static")], ROCK),

  // ---- Hampton Coliseum (an invented comedy bill and invented house acts) -------
  ev("hampton", "hampton-1024-velvet", "2026-10-24", "Velvet Rhodes", [act("velvet_rhodes")], ["Music", "R&B", "Soul"]),
  ev("hampton", "hampton-1031-marlo", "2026-10-31", "Marlo Kane", [act("marlo_kane")], ["Music", "Hip-Hop/Rap", "Urban"]),
  ev("hampton", "hampton-1107-carter", "2026-11-07", "Carter Lynn Shaw", [act("carter_shaw")], COUNTRY),
  ev("hampton", "hampton-1114-trucks", "2026-11-14", "Bayline Monster Trucks", [unknownAct("bayline_trucks", "Bayline Monster Trucks")], ["Miscellaneous", "Family"]),
  ev("hampton", "hampton-1115-trucks", "2026-11-15", "Bayline Monster Trucks", [unknownAct("bayline_trucks", "Bayline Monster Trucks")], ["Miscellaneous", "Family"]),
  ev("hampton", "hampton-1121-kendra", "2026-11-21", "Kendra Vale", [act("kendra_vale")], ["Music", "R&B", "R&B"]),
  ev("hampton", "hampton-1126-parking", "2026-11-26", "Hampton Coliseum Parking", [], ["Miscellaneous", "Undefined"]),
  ev("hampton", "hampton-1128-lyle", "2026-11-28", "Lyle Banner", [act("lyle_banner")], COUNTRY),
  ev("hampton", "hampton-1205-otis", "2026-12-05", "Otis Grey", [act("otis_grey")], ["Music", "R&B", "Soul"]),
  ev("hampton", "hampton-1212-pops", "2026-12-12", "Peninsula Pops Orchestra: Holiday Pops", [act("peninsula_pops")], ["Arts & Theatre", "Classical", "Orchestra"]),
  ev(
    "hampton",
    "hampton-1219-comedy",
    "2026-12-19",
    "Peninsula Comedy Night",
    [act("dorian_pike"), act("sidecar_person"), act("reggie_collier")],
    ["Arts & Theatre", "Comedy", "Comedy"],
  ),
  ev("hampton", "hampton-0109-brisa", "2027-01-09", "Orquesta Brisa", [act("orquesta_brisa")], ["Music", "Latin", "Salsa"]),
  ev("hampton", "hampton-0116-marcus", "2027-01-16", "Marcus Bell Experience", [act("marcus_bell")], ["Music", "Jazz", "Funk"]),
  ev("hampton", "hampton-0123-nova", "2027-01-23", "Nova Tide", [act("nova_tide")], ["Music", "Pop", "Pop"]),
  ev("hampton", "hampton-0130-harbor", "2027-01-30", "The Harbor Kings", [act("harbor_kings")], ROCK),

  // ---- Super Funny Comedy Club, Tacoma (invented comedians) -------------------
  ev("superfunny", "superfunny-1127-tamsin", "2026-11-27", "Tamsin Rook", [act("tamsin_rook")], COMEDY),
  ev("superfunny", "superfunny-1204-ada", "2026-12-04", "Ada Pell with Margo Vint", [act("ada_pell"), unknownAct("margo_vint", "Margo Vint", true)], COMEDY),
  ev("superfunny", "superfunny-1205-ada", "2026-12-05", "Ada Pell with Margo Vint", [act("ada_pell"), unknownAct("margo_vint", "Margo Vint", true)], COMEDY),
  ev("superfunny", "superfunny-0115-benny", "2027-01-15", "Benny Okafor", [unknownAct("benny_okafor", "Benny Okafor", true)], COMEDY),
];

const EVENT_BY_ID = new Map(WORLD_EVENTS.map((e) => [e.id, e]));
export function worldEventById(id: string): WorldEvent | undefined {
  return EVENT_BY_ID.get(id);
}

export function worldEventByKey(key: string): WorldEvent {
  const e = WORLD_EVENTS.find((x) => x.key === key);
  if (!e) throw new Error(`unknown world event ${key}`);
  return e;
}

/** Event ids the presets use. */
export const WORLD_EVENT_IDS = {
  g1a: tmId("ev", "truth-1120-hollis"),
  g1b: tmId("ev", "truth-1205-neon"),
  g2: tmId("ev", "hampton-1219-comedy"),
  g3: tmId("ev", "superfunny-1204-ada"),
} as const;
