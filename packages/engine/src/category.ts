/**
 * Shared helpers for place entities: the display category, the non-venue
 * check, the closed flag and the contact properties shown on the sheet.
 *
 * Display category (`resolveCategory`). Qloo tags a place with many place
 * types at once: a Vietnamese restaurant with a bar carries `bar` and
 * `vietnamese_restaurant`, a bookstore with an in-store cafe carries
 * `book_store` and `cafe`, and nearly everything carries the generic
 * `genre:place:restaurant`. The first matching pinned tag is therefore often
 * the wrong answer. The category comes instead from every
 * `urn:tag:category:place:<key>` and `urn:tag:genre:place:...:<key>` tag the
 * place carries, read in this order:
 *
 *  1. Shops and services (book store, record store, clothing store, barber
 *     shop, beauty salon) decide on their own, in that order.
 *  2. Amusements (bowling alley, arcade, ...) decide when no bar tag is
 *     present, or when two or more amusement tags are (a bowling alley with
 *     a bar and an arcade).
 *  3. Food and drink: bar subtypes score 2 each, a bare `bar` 0.5; each
 *     specific kind of restaurant (`pho_restaurant`, `steak_house`,
 *     `bar_grill`, ...) 1, a bare `restaurant` 0.5; cafe and bakery kinds 2
 *     each. A family the name names ("Lounge", "Tavern", "Kitchen", "Cafe",
 *     "Bakery") gets 3 more, but only when the tags already point to it, so
 *     the name breaks a tie and never invents a type. The highest family wins
 *     (ties: bar, restaurant, cafe, bakery: an unclear place is treated as a
 *     bar, the cautious reading on an all-ages show). A bar is then named by
 *     its most specific subtype: the one its name names, else sports bar, pub,
 *     brewery, wine bar, cocktail bar, lounge, dive bar, bar; a dance club tag
 *     makes it a night club only when no plain `bar` tag is present.
 *
 * Tags it does not know fall back to the pinned tag map, then to the first
 * `urn:tag:category:place:<key>` tag, then "other". A custom resolver wins.
 *
 * Non-venues (`isNonVenue`): malls, plazas, parking, stations, airports and
 * supermarkets always; parks, office and apartment buildings and government buildings
 * when nothing marks a business there; and a place whose name ends in
 * "Plaza", "Mall", "Station", "Metro", "Square", "Park" or "... Center" with
 * only generic place tags. None of them is a door a street team can knock on.
 */
import type { QlooEntity } from "@walkup/contracts";

export interface CategoryOptions {
  /** Custom resolver; wins when it returns a non-empty string. */
  categoryOf?: (e: QlooEntity) => string | null | undefined;
  /** Pinned category key -> tag ids (from config/tags.json). Checked in insertion order, after the tag reading. */
  categoryTags?: Readonly<Record<string, readonly string[]>>;
  /** Categories that count as bars for the "at least one non-bar" rule and all-ages pages. */
  barCategories?: readonly string[];
}

export const DEFAULT_BAR_CATEGORIES: readonly string[] = [
  "bar",
  "pub",
  "sports_bar",
  "irish_pub",
  "wine_bar",
  "cocktail_bar",
  "beer_bar",
  "brewery",
  "brewpub",
  "lounge",
  "night_club",
  "nightclub",
  "dive_bar",
];

const PLACE_CATEGORY_RE = /^urn:tag:category:place:([a-z0-9_]+)/i;
const PLACE_GENRE_RE = /^urn:tag:genre:place:(?:[a-z0-9_]+:)*([a-z0-9_]+)$/i;

type Family = "retail" | "fun" | "bar" | "food" | "cafe" | "bakery";

interface Kind {
  /** Display key. */
  key: string;
  family: Family;
  /** False for bare tags that say little ("bar", "restaurant", "takeout_restaurant"). */
  specific: boolean;
}

const k = (key: string, family: Family, specific = true): Kind => ({ key, family, specific });

/** Shops and services, in the order they decide. */
const RETAIL_ORDER = ["book_store", "record_store", "clothing_store", "barber_shop", "beauty_salon"] as const;
/** Amusements, in the order they name a place that has several. */
const FUN_ORDER = ["bowling_alley", "comedy_club", "movie_theater", "escape_room", "pool_hall", "mini_golf_course", "amusement_center", "video_arcade"] as const;
/** Bar subtypes, most specific first. */
const BAR_ORDER = ["sports_bar", "pub", "brewery", "wine_bar", "cocktail_bar", "lounge", "dive_bar", "night_club", "bar"] as const;

const KINDS: Readonly<Record<string, Kind>> = {
  // Shops and services.
  book_store: k("book_store", "retail"),
  bookstore: k("book_store", "retail"),
  used_book_store: k("book_store", "retail"),
  childrens_book_store: k("book_store", "retail"),
  comic_book_store: k("book_store", "retail"),
  rare_book_store: k("book_store", "retail"),
  record_store: k("record_store", "retail"),
  record_shop: k("record_store", "retail"),
  music_store: k("record_store", "retail"),
  vinyl_record_store: k("record_store", "retail"),
  clothing_store: k("clothing_store", "retail"),
  mens_clothing_store: k("clothing_store", "retail"),
  womens_clothing_store: k("clothing_store", "retail"),
  childrens_clothing_store: k("clothing_store", "retail"),
  vintage_clothing_store: k("clothing_store", "retail"),
  boutique: k("clothing_store", "retail"),
  thrift_store: k("clothing_store", "retail"),
  consignment_shop: k("clothing_store", "retail"),
  shoe_store: k("clothing_store", "retail"),
  sneaker_store: k("clothing_store", "retail"),
  sportswear_store: k("clothing_store", "retail"),
  department_store: k("clothing_store", "retail"),
  barber_shop: k("barber_shop", "retail"),
  barbershop: k("barber_shop", "retail"),
  beauty_salon: k("beauty_salon", "retail"),
  hair_salon: k("beauty_salon", "retail"),
  hairdresser: k("beauty_salon", "retail"),
  nail_salon: k("beauty_salon", "retail"),
  // Amusements: the tag itself is the display key.
  bowling_alley: k("bowling_alley", "fun"),
  video_arcade: k("video_arcade", "fun"),
  amusement_center: k("amusement_center", "fun"),
  billiards_hall: k("pool_hall", "fun"),
  pool_hall: k("pool_hall", "fun"),
  escape_room: k("escape_room", "fun"),
  mini_golf_course: k("mini_golf_course", "fun"),
  comedy_club: k("comedy_club", "fun"),
  movie_theater: k("movie_theater", "fun"),
  // Bars.
  bar: k("bar", "bar", false),
  beer_bar: k("bar", "bar"),
  karaoke_bar: k("bar", "bar"),
  piano_bar: k("bar", "bar"),
  rooftop_bar: k("bar", "bar"),
  sports_bar: k("sports_bar", "bar"),
  pub: k("pub", "bar"),
  irish_pub: k("pub", "bar"),
  british_pub: k("pub", "bar"),
  gastropub: k("pub", "bar"),
  tavern: k("pub", "bar"),
  brewery: k("brewery", "bar"),
  brewpub: k("brewery", "bar"),
  microbrewery: k("brewery", "bar"),
  beer_garden: k("brewery", "bar"),
  beer_hall: k("brewery", "bar"),
  taproom: k("brewery", "bar"),
  wine_bar: k("wine_bar", "bar"),
  cocktail_bar: k("cocktail_bar", "bar"),
  speakeasy: k("cocktail_bar", "bar"),
  tiki_bar: k("cocktail_bar", "bar"),
  lounge: k("lounge", "bar"),
  lounge_bar: k("lounge", "bar"),
  hookah_bar: k("lounge", "bar"),
  cigar_bar: k("lounge", "bar"),
  cigar_lounge: k("lounge", "bar"),
  dive_bar: k("dive_bar", "bar"),
  night_club: k("night_club", "bar"),
  nightclub: k("night_club", "bar"),
  dance_club: k("night_club", "bar"),
  disco: k("night_club", "bar"),
  // Food. Any other "<x>_restaurant" key is a specific restaurant too (see kindOf).
  restaurant: k("restaurant", "food", false),
  takeout_restaurant: k("restaurant", "food", false),
  delivery_restaurant: k("restaurant", "food", false),
  caterer: k("restaurant", "food", false),
  cafeteria: k("restaurant", "food", false),
  food_court: k("restaurant", "food", false),
  steak_house: k("restaurant", "food"),
  steakhouse: k("restaurant", "food"),
  bistro: k("restaurant", "food"),
  brasserie: k("restaurant", "food"),
  trattoria: k("restaurant", "food"),
  taqueria: k("restaurant", "food"),
  diner: k("restaurant", "food"),
  pizzeria: k("restaurant", "food"),
  sandwich_shop: k("restaurant", "food"),
  deli: k("restaurant", "food"),
  delicatessen: k("restaurant", "food"),
  food_truck: k("restaurant", "food"),
  buffet: k("restaurant", "food"),
  bar_grill: k("restaurant", "food"),
  grill: k("restaurant", "food"),
  noodle_shop: k("restaurant", "food"),
  salad_shop: k("restaurant", "food"),
  salad_bar: k("restaurant", "food"),
  creperie: k("restaurant", "food"),
  tapas_bar: k("restaurant", "food"),
  oyster_bar: k("restaurant", "food"),
  sushi_bar: k("restaurant", "food"),
  raw_bar: k("restaurant", "food"),
  dessert_shop: k("restaurant", "food"),
  ice_cream_shop: k("restaurant", "food"),
  frozen_yogurt_shop: k("restaurant", "food"),
  // Cafes and bakeries.
  cafe: k("cafe", "cafe"),
  coffee_shop: k("cafe", "cafe"),
  coffee_house: k("cafe", "cafe"),
  coffee_bar: k("cafe", "cafe"),
  espresso_bar: k("cafe", "cafe"),
  coffee_roaster: k("cafe", "cafe"),
  coffee_roasters: k("cafe", "cafe"),
  tea_house: k("cafe", "cafe"),
  tea_room: k("cafe", "cafe"),
  bubble_tea_shop: k("cafe", "cafe"),
  juice_shop: k("cafe", "cafe"),
  juice_bar: k("cafe", "cafe"),
  acai_shop: k("cafe", "cafe"),
  smoothie_shop: k("cafe", "cafe"),
  internet_cafe: k("cafe", "cafe"),
  bakery: k("bakery", "bakery"),
  pastry_shop: k("bakery", "bakery"),
  wedding_bakery: k("bakery", "bakery"),
  patisserie: k("bakery", "bakery"),
  donut_shop: k("bakery", "bakery"),
  doughnut_shop: k("bakery", "bakery"),
  bagel_shop: k("bakery", "bakery"),
  cupcake_shop: k("bakery", "bakery"),
  cake_shop: k("bakery", "bakery"),
  cookie_shop: k("bakery", "bakery"),
};

/** Place-type keys that are never a business a street team can visit, whatever else the place carries. */
const NON_VENUE_ALWAYS: ReadonlySet<string> = new Set([
  "shopping_mall",
  "shopping_center",
  "outlet_mall",
  "strip_mall",
  "plaza",
  "town_square",
  "public_square",
  "parking_garage",
  "parking_lot",
  "parking_facility",
  "train_station",
  "subway_station",
  "metro_station",
  "transit_station",
  "transit_stop",
  "light_rail_station",
  "railway_station",
  "bus_station",
  "bus_stop",
  "airport",
  "ferry_terminal",
  // A supermarket (Safeway, Whole Foods) is a store a street team can walk into, but not a partner it can ask to
  // take flyers or a poster: the decision sits with a chain's head office.
  "supermarket",
  "hypermarket",
  "warehouse_club",
]);

/** Place-type keys that are not a venue unless something marks a business there. */
const NON_VENUE_UNLESS_BUSINESS: ReadonlySet<string> = new Set([
  "park",
  "city_park",
  "national_park",
  "state_park",
  "public_park",
  "dog_park",
  "playground",
  "office_building",
  "office_space",
  "corporate_office",
  "business_center",
  "business_park",
  "coworking_space",
  "apartment_building",
  "apartment_complex",
  "condominium_complex",
  "housing_complex",
  "residential_building",
  "government_office",
  "city_hall",
  "courthouse",
  "monument",
  "memorial",
]);

/** A name that is a place, not a business: "L'Enfant Plaza", "Union Station", "Pentagon City Mall". */
const NON_VENUE_NAME_RE = /\b(?:plaza|mall|station|metro|square|park|(?:shopping|town|transit|trade|office) cent(?:er|re))\s*$/i;

/** The place-type keys a place carries (category and genre tags), lower case, in first-seen order. */
export function placeTypeKeys(e: Pick<QlooEntity, "tags">): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of e.tags ?? []) {
    const id = typeof t?.id === "string" ? t.id : "";
    const m = PLACE_CATEGORY_RE.exec(id) ?? PLACE_GENRE_RE.exec(id);
    const key = m?.[1]?.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function kindOf(key: string): Kind | null {
  const known = KINDS[key];
  if (known) return known;
  if (key.endsWith("_restaurant")) return k("restaurant", "food");
  if (key.endsWith("_pub")) return k("pub", "bar");
  if (key.endsWith("_bar") && !key.endsWith("_snack_bar")) return k("bar", "bar");
  return null;
}

interface NameHints {
  families: Set<Family>;
  barKey: string | null;
}

/** What the name says about the kind of place ("Red Lounge Bar & Grill": a bar, and a lounge). */
function nameHints(name: string | undefined): NameHints {
  const n = ` ${(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const families = new Set<Family>();
  let barKey: string | null = null;
  const has = (re: RegExp) => re.test(n);
  if (has(/ (bar|pub|tavern|saloon|lounge|taproom|brewery|brewing|brewpub|biergarten|speakeasy|nightclub) /)) families.add("bar");
  if (has(/ sports (bar|grill|pub) /)) barKey = "sports_bar";
  else if (has(/ (pub|tavern) /)) barKey = "pub";
  else if (has(/ (brewery|brewing|brewpub|taproom|biergarten) /)) barKey = "brewery";
  else if (has(/ wine bar /)) barKey = "wine_bar";
  else if (has(/ (cocktail|cocktails|speakeasy) /)) barKey = "cocktail_bar";
  else if (has(/ lounge /)) barKey = "lounge";
  else if (has(/ nightclub|night club /)) barKey = "night_club";
  if (has(/ (restaurant|kitchen|grill|bistro|diner|eatery|steakhouse|pizzeria|pizza|taqueria|trattoria|cuisine|bbq|barbecue) /)) families.add("food");
  if (has(/ (cafe|caf|coffee|espresso|tea house|teahouse|roasters?) /)) families.add("cafe");
  if (has(/ (bakery|bakeshop|patisserie|boulangerie|donuts?|doughnuts?|bagels?) /)) families.add("bakery");
  return { families, barKey };
}

/**
 * The display category from the place's own Qloo place-type tags (see the
 * module comment), or null when none of its tags is one this reading knows.
 */
export function categoryFromTags(e: Pick<QlooEntity, "tags" | "name">): string | null {
  const kinds = placeTypeKeys(e)
    .map(kindOf)
    .filter((x): x is Kind => x !== null);
  if (kinds.length === 0) return null;
  const keys = new Set(kinds.map((x) => x.key));
  for (const r of RETAIL_ORDER) if (keys.has(r)) return r;

  const barKinds = kinds.filter((x) => x.family === "bar");
  const funKeys = new Set(kinds.filter((x) => x.family === "fun").map((x) => x.key));
  const fun = FUN_ORDER.find((f) => funKeys.has(f)) ?? null;
  // An amusement with a bar counter (a bowling alley) stays an amusement; one bar-arcade tag alone reads as a bar.
  if (fun && (barKinds.length === 0 || funKeys.size >= 2)) return fun;

  const distinct = (fam: Family, specific: boolean) => new Set(kinds.filter((x) => x.family === fam && x.specific === specific).map((x) => x.key)).size;
  // Specific restaurant kinds are counted by tag, not by display key (they all display as "restaurant").
  const foodSpecific = new Set(placeTypeKeys(e).filter((key) => {
    const x = kindOf(key);
    return x?.family === "food" && x.specific;
  })).size;
  const score: Record<"bar" | "food" | "cafe" | "bakery", number> = {
    bar: 2 * distinct("bar", true) + (keys.has("bar") ? 0.5 : 0),
    food: foodSpecific + (kinds.some((x) => x.family === "food" && !x.specific) ? 0.5 : 0),
    cafe: 2 * distinct("cafe", true),
    bakery: 2 * distinct("bakery", true),
  };
  const hints = nameHints(e.name);
  for (const f of ["bar", "food", "cafe", "bakery"] as const) if (score[f] > 0 && hints.families.has(f)) score[f] += 3;
  const best = (["bar", "food", "cafe", "bakery"] as const).reduce((a, b) => (score[b] > score[a] ? b : a));
  if (score[best] <= 0) return fun;
  if (best === "food") return "restaurant";
  if (best === "cafe") return "cafe";
  if (best === "bakery") return "bakery";
  const barKeys = new Set(barKinds.map((x) => x.key));
  if (hints.barKey && barKeys.has(hints.barKey)) return hints.barKey;
  for (const b of BAR_ORDER) {
    if (b === "night_club" && keys.has("bar")) continue;
    if (barKeys.has(b)) return b;
  }
  return "bar";
}

/**
 * Category key for a place: the custom resolver, then the place-type tags
 * (see the module comment), then the pinned tag map, then the first
 * `urn:tag:category:place:<key>` tag, else "other".
 */
export function resolveCategory(e: QlooEntity, opts: CategoryOptions = {}): string {
  if (opts.categoryOf) {
    const v = opts.categoryOf(e);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  const fromTags = categoryFromTags(e);
  if (fromTags) return fromTags;
  const tagIds = new Set((e.tags ?? []).map((t) => t.id));
  if (opts.categoryTags) {
    for (const [key, ids] of Object.entries(opts.categoryTags)) {
      if (ids.some((id) => tagIds.has(id))) return key;
    }
  }
  for (const t of e.tags ?? []) {
    const m = PLACE_CATEGORY_RE.exec(t.id ?? "");
    if (m && m[1]) return m[1].toLowerCase();
  }
  return "other";
}

/**
 * True for a place that is not a business a street team can walk into: a
 * mall, plaza, station, parking garage or airport; a park, office, apartment
 * or government building with no business tag; or a name like "Union
 * Station" with only generic place tags. See the module comment.
 */
export function isNonVenue(e: Pick<QlooEntity, "tags" | "name">): boolean {
  const keys = placeTypeKeys(e);
  if (keys.some((x) => NON_VENUE_ALWAYS.has(x))) return true;
  const business = keys.some((x) => {
    const kind = kindOf(x);
    return kind !== null && (kind.specific || kind.family === "bar");
  });
  if (business) return false;
  if (keys.some((x) => NON_VENUE_UNLESS_BUSINESS.has(x))) return true;
  return typeof e.name === "string" && NON_VENUE_NAME_RE.test(e.name.trim());
}

export function isBarCategory(category: string, barCategories: readonly string[] = DEFAULT_BAR_CATEGORIES): boolean {
  return barCategories.includes(category);
}

/** True when the excluded categories leave out bars (an all-ages show, or the operator's "no bars"). */
export function barsExcluded(excludedCategories: Iterable<string>, barCategories: readonly string[] = DEFAULT_BAR_CATEGORIES): boolean {
  for (const c of excludedCategories) if (barCategories.includes(c.trim().toLowerCase())) return true;
  return false;
}

/** Drinking words in a place name. Food counters called a bar ("Salad Bar", "Sushi Bar", "Juice Bar") and barbecue are not. */
const DRINK_NAME_RE = /\b(bar|bars|pub|pubs|karaoke|lounge|tavern|saloon|taproom|tap room|brewery|brewing|brewpub|biergarten|beer hall|beer garden|alehouse|ale house|cantina|speakeasy|nightclub|night club)\b/i;
const FOOD_BAR_RE =
  /\b(salad|juice|sushi|oyster|raw|snack|coffee|espresso|tea|smoothie|acai|açaí|poke|taco|nail|brow|lash|blow ?dry|blowout|candy|cereal|yogurt|protein|dessert|milkshake|waffle|noodle|ramen|dumpling|crepe|cookie|chocolate|granola|bowl|fruit|soup|cupcake|donut|doughnut|mezze|burrito|pizza|sandwich|hot ?pot)\s+bar\b/gi;
const BBQ_RE = /\bbar[\s-]?b[\s-]?(q|que|cue)\b/gi;

/** True when a place's name says it is a drinking place ("Live-K Karaoke Bar", "Town Tavern", "Amsterdam Lounge"). */
export function nameSaysDrinking(name: string | null | undefined): boolean {
  const n = (name ?? "").normalize("NFKC").replace(BBQ_RE, " ").replace(FOOD_BAR_RE, " ");
  // A name that ends by saying what the shop sells ("Laurel Tavern Donuts") is that shop, not a drinking place.
  if (FOOD_SHOP_TAIL_RE.test(n.trim())) return false;
  return DRINK_NAME_RE.test(n);
}

/** A shop name's last word(s) when they say it sells baked goods or ice cream. */
const FOOD_SHOP_TAIL_RE = /\b(?:donuts?|doughnuts?|bakery|bake ?shop|creamery|ice cream)$/i;

/**
 * Qloo tags that say a place is a bar at heart, whatever its category: a dive bar's decor or feel ("Lively Wicker Park
 * bar with daily food and drink specials" is a bar_grill with both). A bar culinary style alone does not count: a pho
 * house and a Vietnamese eatery carry it.
 */
const DRINK_IDENTITY_TAGS: ReadonlySet<string> = new Set(["urn:tag:decor:qloo:dive_bar", "urn:tag:ambience:qloo:dive_bar_vibe"]);

/**
 * True for a place a "no bars" note should leave out whatever its display category: its name says bar, pub,
 * karaoke, lounge, tavern, saloon, taproom, brewery or cantina (`nameSaysDrinking`), it carries a specific
 * bar-type place tag (an Irish pub, a lounge bar, a karaoke bar, a gastropub, a bar and grill; a bare `bar` tag
 * alone does not count: many restaurants carry it), or a dive-bar tag (DRINK_IDENTITY_TAGS).
 */
export function isDrinkLed(e: Pick<QlooEntity, "tags" | "name">): boolean {
  if (nameSaysDrinking(e.name)) return true;
  if ((e.tags ?? []).some((t) => DRINK_IDENTITY_TAGS.has(t?.id))) return true;
  return placeTypeKeys(e).some((key) => {
    if (key === "bar_grill") return true;
    const kind = kindOf(key);
    return kind !== null && kind.family === "bar" && kind.specific;
  });
}

/** Place-type keys of a cart, kiosk, stand or truck: somewhere to buy food, not a room a crowd can sit in. */
const STAND_KEYS: ReadonlySet<string> = new Set(["food_truck", "food_cart", "food_stand", "food_kiosk", "kiosk", "hot_dog_stand", "street_food", "concession_stand", "market_stall"]);
const STAND_NAME_RE = /\b(carts?|kiosks?|food trucks?|trucks?|stands?|stalls?)\b/i;

/** True for a food cart, kiosk, stand or truck (by place-type tag or by name: "Sami's Hot Dog Cart"). */
export function isFoodStand(e: Pick<QlooEntity, "tags" | "name">): boolean {
  if (placeTypeKeys(e).some((k) => STAND_KEYS.has(k))) return true;
  return STAND_NAME_RE.test((e.name ?? "").normalize("NFKC"));
}

/** An address line that says the place has closed ("FOOD TRUCK ONLY RESTAURANT CLOSED 951 W Wise Rd", Oct 21 2026). */
const CLOSED_ADDRESS_RE = /\b(?:(?:permanently|restaurant|store|now)\s+closed|closed\s+permanently)\b/i;

/**
 * True when Qloo marks the place closed (`is_closed: true`, also accepts "true" and `isClosed`), or when its
 * address says it has closed.
 */
export function isClosedEntity(e: QlooEntity): boolean {
  const p = e.properties ?? {};
  const v = p.is_closed ?? p.isClosed;
  if (v === true || v === "true" || v === 1) return true;
  const address = p.address;
  return typeof address === "string" && CLOSED_ADDRESS_RE.test(address);
}

export function propString(e: QlooEntity, ...keys: string[]): string | null {
  const p = e.properties ?? {};
  for (const k of keys) {
    const v = p[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

export function distanceOf(e: QlooEntity): number {
  const d = e.distanceM;
  return typeof d === "number" && Number.isFinite(d) && d >= 0 ? d : Number.POSITIVE_INFINITY;
}
