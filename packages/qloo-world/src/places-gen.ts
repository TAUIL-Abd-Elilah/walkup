/**
 * Invented local businesses. Places are generated per geohash-5 cell from a
 * seeded hash, so the same id always describes the same place, in Qloo
 * responses and in Google Places responses alike. Names come from a
 * hand-written list (owner surnames and plain names, the way small businesses
 * are named) and are drawn without replacement inside a cell, so neighbours
 * never share a name; addresses use ordinary made-up street names and the town
 * the point actually sits in; phones use the metro's area codes with the
 * reserved 555-01xx range, also drawn without replacement inside a cell; and
 * websites the .example domain. Every sheet built from them says "Sample data".
 */
import { AMBIENCE, DENIED_CREDIT_CARD, DENIED_INCLUSIVITY, GOOD_FOR, categoryTagId } from "./catalog-tags";
import { NAMED_PLACES, VENUE_PLACES, catalogById, type CatalogEntity, type MetroKey } from "./catalog-entities";
import { cellsWithin, encodeGeohash, geohashBounds, geohashCenter, haversineKm } from "./geo";
import { generatedPlaceId, parseGeneratedPlaceId } from "./ids";
import { metroFor, metroModel, type MetroModel } from "./metro";
import { choose, clamp, pick, round, unit } from "./rng";
import { addScaled, taste, type Taste } from "./taste";

export type Hours = Record<string, { opens: string; closes: string }[]>;

export interface WorldPlace {
  id: string;
  name: string;
  category: string;
  lat: number;
  lon: number;
  metro: MetroKey;
  popularity: number;
  taste: Taste;
  /** Allowed tags (category, ambience, good_for). Denied example tags are added at response time. */
  tagIds: string[];
  priceLevel: number;
  rating: number;
  ratingCount: number;
  hours: Hours;
  address: string;
  phone: string;
  website: string;
  neighborhood: string | null;
  /** ZIP code (nearest ZCTA), sent in properties.localities like the live API. */
  zip: string | null;
  city: string;
  state: string;
  /** Uniform draws used by the scenario knobs at response time. */
  u: { closed: number; noHours: number; creditCard: number; inclusivity: number; sparse: number };
  named: boolean;
}

const WEEK = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

const CATEGORY_WEIGHTS: [string, number][] = [
  ["restaurant", 26],
  ["bar", 12],
  ["pub", 3],
  ["sports_bar", 3],
  ["soul_food", 3],
  ["cafe", 11],
  ["record_store", 4],
  ["book_store", 3],
  ["clothing_store", 9],
  ["barber_shop", 8],
  ["beauty_salon", 7],
  ["night_club", 3],
  ["bakery", 5],
];
const WEIGHT_TOTAL = CATEGORY_WEIGHTS.reduce((s, [, w]) => s + w, 0);

const CATEGORY_BIAS: Record<string, Taste> = {
  bar: taste({ roots: 0.3, comedy_night: 0.4, indie_alt: 0.3 }),
  pub: taste({ roots: 0.4, indie_alt: 0.3 }),
  sports_bar: taste({ family: 0.4, comedy_night: 0.3, hiphop_rnb: 0.3 }),
  restaurant: taste({ arts_dining: 0.4, family: 0.3 }),
  soul_food: taste({ hiphop_rnb: 0.4, family: 0.4, comedy_night: 0.3 }),
  cafe: taste({ indie_alt: 0.5, arts_dining: 0.4 }),
  record_store: taste({ indie_alt: 0.6, roots: 0.5, hiphop_rnb: 0.3 }),
  book_store: taste({ arts_dining: 0.6, indie_alt: 0.4 }),
  clothing_store: taste({ indie_alt: 0.4, hiphop_rnb: 0.4 }),
  barber_shop: taste({ hiphop_rnb: 0.6, comedy_night: 0.4 }),
  beauty_salon: taste({ hiphop_rnb: 0.4, family: 0.3, arts_dining: 0.3 }),
  night_club: taste({ hiphop_rnb: 0.6, latin: 0.5 }),
  bakery: taste({ family: 0.6, arts_dining: 0.3 }),
};

/**
 * Owner surnames, the most common way small businesses are named ("Grimsley's", "Haskins Records"). Plain,
 * varied, and none shared with an act, a street below or a famous local business.
 */
const SURNAMES = [
  "Abernathy", "Ackerly", "Ashworth", "Balfour", "Barlow", "Bascom", "Beasley", "Birdsong", "Blevins", "Bostic",
  "Brannon", "Bristow", "Burkett", "Cantrell", "Carver", "Castellano", "Chisholm", "Coker", "Colquitt", "Corbin",
  "Crabtree", "Crenshaw", "Culpepper", "Dabney", "Dempsey", "Denning", "Dorsey", "Duvall", "Eckert", "Ellery",
  "Embry", "Estes", "Fairley", "Farris", "Fennell", "Fitch", "Flanagan", "Fontaine", "Gaddis", "Garrity",
  "Gentry", "Goforth", "Grimsley", "Hadley", "Hammond", "Haskins", "Hatfield", "Hensley", "Holcomb", "Ingram",
  "Iverson", "Jarrett", "Jessup", "Kimbro", "Kincaid", "Kowalski", "Lattimore", "Ledford", "Lomax", "Lowery",
  "Mabry", "Mallory", "McAdoo", "Merritt", "Nakamura", "Nance", "Okafor", "Ogle", "Overby", "Pettigrew",
  "Pickett", "Prater", "Quarles", "Ragland", "Redding", "Rucker", "Rutledge", "Sandoval", "Satterfield", "Shackleford",
  "Shipley", "Sisk", "Stroud", "Sumner", "Tackett", "Tidwell", "Tinsley", "Toombs", "Upchurch", "Varner",
  "Vasquez", "Voss", "Weatherly", "Whitlock", "Wofford", "Womack", "Yarbrough", "Yoder", "Zeller", "Delgado",
  "Okonkwo", "Lindqvist", "Petrakis", "Moreau", "Halvorsen", "Abara", "Ferreira", "Rinaldi", "Szabo", "Truong",
  "Haddad", "Mendoza", "Ostrowski", "Baptiste", "Kaminski", "Ambrose", "Bettis", "Dunlap", "Garvey", "Pruett",
  "Albright", "Atwater", "Beaumont", "Bledsoe", "Bowden", "Brightwell", "Cagle", "Cardenas", "Caudill", "Chandler",
  "Clements", "Conley", "Cowan", "Dalrymple", "Darby", "Dillard", "Easley", "Eldridge", "Fairbanks", "Fortner",
  "Fulton", "Galloway", "Gilliam", "Goins", "Greer", "Gunther", "Hagan", "Harlan", "Hearn", "Hightower",
  "Hollins", "Hooper", "Huckaby", "Isom", "Jansen", "Keel", "Kirby", "Lacy", "Langford", "Lusk",
  "Marchetti", "Maddox", "Mayfield", "McBride", "Meeks", "Minton", "Moody", "Nolan", "Norwood", "Oakley",
  "Odom", "Pace", "Paquette", "Peebles", "Pendergrass", "Ramsey", "Rhodes", "Rowe", "Sasser", "Shelton",
  "Simmons", "Slade", "Spears", "Stallings", "Talbot", "Teague", "Thornton", "Trammell", "Ulrich", "Vance",
  "Waddell", "Whitaker", "Wilder", "Winslow", "Wren", "Yates", "Acosta", "Becerra", "Cho", "Dimitrov",
];

/** How a surname becomes a business name, per kind of place. "{S}" is the surname. */
const SURNAME_FORMS: Record<string, string[]> = {
  restaurant: ["{S}'s", "{S}'s", "{S}'s Kitchen", "{S}'s Diner", "{S}'s Grill", "{S}'s Table", "{S} & Daughters"],
  soul_food: ["{S}'s Soul Food", "{S}'s Kitchen"],
  bar: ["{S}'s", "{S}'s Tavern", "{S}'s Bar"],
  pub: ["{S}'s Pub"],
  sports_bar: ["{S}'s Sports Bar", "{S}'s Grill"],
  cafe: ["{S} Coffee", "{S}'s Cafe"],
  record_store: ["{S} Records", "{S}'s Record Shop"],
  book_store: ["{S} Books", "{S}'s Bookshop"],
  clothing_store: ["{S} & Co.", "{S} Supply", "{S}'s"],
  barber_shop: ["{S}'s Barber Shop", "{S} Barbers"],
  beauty_salon: ["{S} Salon", "{S} Hair"],
  night_club: ["{S}'s"],
  bakery: ["{S}'s Bakery", "{S} Bread Co."],
};

/** Plain names, one list per kind of place. No first word appears twice across these lists or in SURNAMES. */
const PLAIN_NAMES: Record<string, string[]> = {
  restaurant: ["Blue Plate Kitchen", "Corner Table", "Sunday Supper", "Iron Skillet", "Long Table", "Red Door Diner", "Night Owl Diner", "Mockingbird Kitchen"],
  soul_food: ["Collard Greens Kitchen", "Mama Lou's", "Cornbread & Co."],
  bar: ["The Tin Cup", "Last Call", "Low Note", "Back Porch Tavern", "Half Moon Bar", "Two Bit Tavern", "Slow Burn"],
  pub: ["Brass Rail Pub", "Old Mill Pub"],
  sports_bar: ["Home Team Grill", "Sideline Sports Bar"],
  cafe: ["Early Bird Coffee", "Steady Pour", "Morning Glory Cafe", "Daily Grind", "Common Ground Coffee", "Cup & Saucer"],
  record_store: ["Third Coast Records", "Spin Cycle Records", "Crate & Needle", "Deep Cuts", "Wax Paper Records"],
  book_store: ["Dog-Eared Books", "Paper Moon Books", "Well Read", "Chapter House"],
  clothing_store: ["Hand Me Down", "Thread & Needle", "Patchwork Vintage", "Hemline"],
  barber_shop: ["Clean Cut", "Straight Razor", "Fresh Fade", "Main Line Barbers"],
  beauty_salon: ["Mane Street Salon", "Shear Joy", "Curl Up Salon", "Polished"],
  night_club: ["After Hours", "Velvet Room", "Basement"],
  bakery: ["Rise & Shine Bakery", "Sweet Crumb", "Flour Child", "Golden Crust"],
};

/** Area codes per metro: real codes with the reserved 555-01xx line numbers, so no number reaches anyone. */
const AREA_CODES: Record<MetroKey, string[]> = {
  nashville: ["615", "629"],
  hampton_roads: ["757", "948"],
  tacoma: ["253"],
};

/**
 * Salts for the name and phone draws. Changing one reshuffles every generated name or number (never which places
 * a Qloo search returns or how they rank). Chosen with packages/orchestrator/scripts/check-sample-names.ts so the
 * bundled sample sheets repeat no first word and no phone.
 */
const NAME_SALT = "names-2071";
const PHONE_SALT = "phones-88";

/** A stride coprime with `n`, from a key: walking i * stride mod n visits every slot once. */
function strideFor(key: string, n: number): number {
  for (let k = 0; k < n; k++) {
    const s = 1 + ((pick(key, n - 1) + k) % (n - 1));
    if (gcd(s, n) === 1) return s;
  }
  return 1;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Made-up but ordinary street names. Paired with a house number, the town and the 555 phone range. */
const STREETS = [
  "Linden Ave", "Harlow Rd", "3rd St", "Alder St", "Calloway St", "Pruitt Ave", "Ashby Ln", "Sycamore Ave",
  "Whitfield Rd", "5th Ave", "Kimbrough St", "Birchwood Dr", "Tolliver Ln", "Bellamy Rd", "Hawthorn St", "9th St",
  "Prescott Ave", "Mercer St", "Oakhurst Ave", "Garrison St", "Holloway Rd", "14th St", "Delmar St", "Cedar Ln",
  "Hartley Rd", "Lowell Ave", "Willard St", "Juniper Way",
];

const HOURS_BY_CATEGORY: Record<string, [string, string, string[]]> = {
  restaurant: ["11:00", "22:00", ["Monday"]],
  soul_food: ["11:00", "21:00", ["Monday"]],
  bar: ["16:00", "02:00", ["Monday"]],
  pub: ["12:00", "01:00", []],
  sports_bar: ["11:00", "01:00", []],
  cafe: ["07:00", "16:00", []],
  record_store: ["11:00", "19:00", ["Tuesday"]],
  book_store: ["10:00", "19:00", ["Monday"]],
  clothing_store: ["10:00", "20:00", []],
  barber_shop: ["09:00", "19:00", ["Sunday"]],
  beauty_salon: ["09:00", "18:00", ["Sunday", "Monday"]],
  night_club: ["21:00", "03:00", ["Monday", "Tuesday", "Wednesday"]],
  bakery: ["06:00", "14:00", ["Monday"]],
};

const AMBIENCE_KEYS = ["cozy", "lively", "laid_back", "intimate", "trendy", "retro", "neighborhood_feel"];
const GOOD_FOR_BY_CATEGORY: Record<string, string[]> = {
  bar: ["late_night", "happy_hour", "craft_beer", "groups", "live_music"],
  pub: ["groups", "craft_beer", "live_music"],
  sports_bar: ["groups", "happy_hour", "late_night"],
  restaurant: ["groups", "date_night", "brunch", "kids"],
  soul_food: ["groups", "kids", "brunch"],
  cafe: ["brunch", "groups"],
  record_store: ["live_music"],
  book_store: ["kids"],
  clothing_store: [],
  barber_shop: ["groups"],
  beauty_salon: [],
  night_club: ["late_night", "groups"],
  bakery: ["kids", "brunch"],
};

function categoryFor(key: string): string {
  let x = unit(`${key}|cat`) * WEIGHT_TOTAL;
  for (const [c, w] of CATEGORY_WEIGHTS) {
    x -= w;
    if (x <= 0) return c;
  }
  return "restaurant";
}

/**
 * The i-th generated place's name in its cell. Surnames are drawn without replacement inside the cell (a
 * keyed permutation), so no two places in one cell share a first word; about one place in four gets a plain
 * name for its kind instead.
 */
export function placeName(gh5: string, i: number, category: string, salt: string = NAME_SALT): string {
  const key = `${salt}|${gh5}`;
  const plain = PLAIN_NAMES[category] ?? [];
  if (plain.length > 0 && unit(`${key}|${i}|plain`) < 0.15) return choose(`${key}|${i}|pn`, plain);
  const n = SURNAMES.length;
  const slot = (pick(`${key}|off`, n) + i * strideFor(`${key}|stride`, n)) % n;
  const surname = SURNAMES[slot] as string;
  const forms = SURNAME_FORMS[category] ?? ["{S}'s"];
  return choose(`${key}|${i}|form`, forms)
    .replace("{S}'s", possessive(surname))
    .replace("{S}", surname);
}

/** "Grimsley's", but "Toombs'" and "Rhodes'": a name ending in s takes the apostrophe alone. */
function possessive(name: string): string {
  return /s$/.test(name) ? `${name}'` : `${name}'s`;
}

/** The i-th generated place's phone in its cell: the metro's area codes, 555-01xx, drawn without replacement in the cell. */
export function placePhone(gh5: string, i: number, metro: MetroKey, salt: string = PHONE_SALT): string {
  const codes = AREA_CODES[metro] ?? ["555"];
  const n = 100 * codes.length;
  const key = `${salt}|${gh5}|phone`;
  const slot = (pick(`${key}|off`, n) + i * strideFor(`${key}|stride`, n)) % n;
  return phoneText(codes[Math.floor(slot / 100)] as string, slot % 100);
}

function phoneText(areaCode: string, line: number): string {
  return `+1 ${areaCode}-555-01${String(line).padStart(2, "0")}`;
}

/** The town an address names: the Census place the point sits in, by its postal name. */
function postalTown(m: MetroModel, lat: number, lon: number): string {
  const town = m.townFor(lat, lon);
  return POSTAL_NAME[town] ?? town;
}

/** Census place names that differ from the name on an envelope. */
const POSTAL_NAME: Record<string, string> = { "Nashville-Davidson": "Nashville" };

function hoursFor(key: string, category: string): Hours {
  const [open, close, closed] = HOURS_BY_CATEGORY[category] ?? ["10:00", "18:00", []];
  const extraClosed = unit(`${key}|closedday`) < 0.25 ? [choose(`${key}|cd`, WEEK)] : [];
  const out: Hours = {};
  for (const d of WEEK) {
    const isClosed = closed.includes(d) || extraClosed.includes(d);
    out[d] = isClosed ? [] : [{ opens: `T${open}`, closes: `T${close}` }];
  }
  return out;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function baseTags(key: string, category: string): string[] {
  const tags = [categoryTagId(category)];
  const n = 1 + pick(`${key}|namb`, 2);
  const amb = new Set<string>();
  for (let i = 0; i < n; i++) amb.add(choose(`${key}|amb${i}`, AMBIENCE_KEYS));
  for (const a of [...amb].sort()) tags.push(`${AMBIENCE}:${a}`);
  const goodFor = GOOD_FOR_BY_CATEGORY[category] ?? [];
  if (goodFor.length > 0) {
    const g = new Set<string>();
    const m = 1 + pick(`${key}|ngf`, 2);
    for (let i = 0; i < m; i++) g.add(choose(`${key}|gf${i}`, goodFor));
    for (const x of [...g].sort()) tags.push(`${GOOD_FOR}:${x}`);
  }
  return tags;
}

function uDraws(key: string): WorldPlace["u"] {
  return {
    closed: unit(`${key}|u:closed`),
    noHours: unit(`${key}|u:nohours`),
    creditCard: unit(`${key}|u:cc`),
    inclusivity: unit(`${key}|u:incl`),
    sparse: unit(`${key}|u:sparse`),
  };
}

function fromCatalog(e: CatalogEntity, seed: string): WorldPlace {
  const metro = e.metro ?? "nashville";
  const m = metroModel(metro, seed);
  const loc = e.location ?? m.center;
  const key = `${seed}|named|${e.key}`;
  const category = e.category ?? "other";
  return {
    id: e.id,
    name: e.name,
    category,
    lat: loc.lat,
    lon: loc.lon,
    metro,
    popularity: e.popularity,
    taste: e.taste,
    tagIds: category === "other" ? [] : baseTags(key, category),
    priceLevel: e.priceLevel ?? 2,
    rating: round(4.2 + unit(`${key}|r`) * 0.6, 1),
    ratingCount: 120 + Math.round(unit(`${key}|rc`) * 900),
    hours: e.hours ?? hoursFor(key, category),
    address: e.address ?? `${100 + pick(`${key}|num`, 800)} ${choose(`${key}|st`, STREETS)}, ${postalTown(m, loc.lat, loc.lon)}, ${m.state}`,
    phone: phoneText((AREA_CODES[metro] ?? ["555"])[0] as string, 50 + pick(`${PHONE_SALT}|${key}|ph`, 50)),
    website: `https://${slug(e.name)}.example`,
    neighborhood: m.neighbourhoodFor(loc.lat, loc.lon),
    zip: m.zipFor(loc.lat, loc.lon),
    city: postalTown(m, loc.lat, loc.lon),
    state: m.state,
    // Named places are always open and fully described.
    u: { closed: 1, noHours: 1, creditCard: unit(`${key}|u:cc`), inclusivity: 1, sparse: 0 },
    named: true,
  };
}

const CELL_CACHE = new Map<string, WorldPlace[]>();

/** Every place in one geohash-5 cell (named places first). */
export function placesInCell(gh5: string, seed: string): WorldPlace[] {
  const cacheKey = `${seed}|${gh5}`;
  const hit = CELL_CACHE.get(cacheKey);
  if (hit) return hit;
  const center = geohashCenter(gh5);
  const m = metroFor(center.lat, center.lon, seed);
  const out: WorldPlace[] = [];
  if (m) {
    for (const e of [...VENUE_PLACES, ...NAMED_PLACES]) {
      if (e.location && encodeGeohash(e.location.lat, e.location.lon, 5) === gh5) out.push(fromCatalog(e, seed));
    }
    const d = m.inBox(center.lat, center.lon) ? m.density(center.lat, center.lon) : 0;
    const n = d < 0.08 ? 0 : Math.min(170, Math.round(4 + 170 * d * d));
    const b = geohashBounds(gh5);
    for (let i = 0; i < n; i++) out.push(generatePlace(gh5, i, m, b, seed));
  }
  CELL_CACHE.set(cacheKey, out);
  return out;
}

function generatePlace(gh5: string, i: number, m: MetroModel, b: { south: number; north: number; west: number; east: number }, seed: string): WorldPlace {
  const key = `${seed}|${gh5}|${i}`;
  // Best of three candidate points by density, so shops cluster where people are.
  let best = { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2, d: -1 };
  for (let k = 0; k < 3; k++) {
    const lat = b.south + unit(`${key}|y${k}`) * (b.north - b.south);
    const lon = b.west + unit(`${key}|x${k}`) * (b.east - b.west);
    const d = m.density(lat, lon);
    if (d > best.d) best = { lat, lon, d };
  }
  const category = categoryFor(key);
  const vec = addScaled(addScaled(m.field(best.lat, best.lon).map((x) => x * 0.65), CATEGORY_BIAS[category] ?? taste({}), 0.35), [0, 1, 2, 3, 4, 5, 6].map((j) => unit(`${key}|n${j}`) * 0.12), 1);
  const name = placeName(gh5, i, category);
  const popularity = round(clamp(0.2 + 0.5 * best.d + 0.3 * unit(`${key}|pop`), 0.02, 0.99), 3);
  const price = unit(`${key}|price`) < 0.05 ? 4 : 1 + pick(`${key}|pl`, 3);
  const city = postalTown(m, best.lat, best.lon);
  return {
    id: generatedPlaceId(gh5, i),
    name,
    category,
    lat: round(best.lat, 6),
    lon: round(best.lon, 6),
    metro: m.key,
    popularity,
    taste: vec,
    tagIds: baseTags(key, category),
    priceLevel: price,
    rating: round(3.6 + unit(`${key}|rating`) * 1.3, 1),
    ratingCount: 10 + Math.round(popularity * popularity * 2400 * (0.5 + unit(`${key}|rc`))),
    hours: hoursFor(key, category),
    address: `${100 + pick(`${key}|num`, 4800)} ${choose(`${key}|st`, STREETS)}, ${city}, ${m.state}`,
    phone: placePhone(gh5, i, m.key),
    website: `https://${slug(name)}.example`,
    neighborhood: m.neighbourhoodFor(best.lat, best.lon),
    zip: m.zipFor(best.lat, best.lon),
    city,
    state: m.state,
    u: uDraws(key),
    named: false,
  };
}

/** Places whose point is within radiusM of the center. */
export function placesWithin(center: { lat: number; lon: number }, radiusM: number, seed: string): WorldPlace[] {
  const radiusKm = radiusM / 1000;
  const cells = cellsWithin(center, radiusKm + 3.6, 5);
  const out: WorldPlace[] = [];
  for (const gh5 of cells) {
    for (const p of placesInCell(gh5, seed)) {
      if (haversineKm(center, p) <= radiusKm) out.push(p);
    }
  }
  return out;
}

/** Any place by id (named, venue or generated). */
export function placeById(id: string, seed: string): WorldPlace | null {
  const named = catalogById(id);
  if (named && named.subtype === "urn:entity:place") return fromCatalog(named, seed);
  const g = parseGeneratedPlaceId(id);
  if (!g) return null;
  return placesInCell(g.gh5, seed).find((p) => p.id === id) ?? null;
}

/** The denied example tags a place carries when the knob is on (credit card and inclusivity namespaces). */
export function deniedTagsFor(p: WorldPlace, enabled: boolean): string[] {
  if (!enabled) return [];
  const out: string[] = [];
  if (p.u.creditCard < 0.35) out.push(DENIED_CREDIT_CARD.id);
  if (p.u.inclusivity < 0.08) out.push(DENIED_INCLUSIVITY.id);
  return out;
}
