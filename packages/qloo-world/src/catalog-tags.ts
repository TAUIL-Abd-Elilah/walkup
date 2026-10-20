/** Tags of the fixture world. Ids follow Qloo's urn:tag:<namespace>:<key> pattern; names are plain words. */
import { taste, type Taste } from "./taste";

export interface WorldTag {
  id: string;
  name: string;
  /** Namespace, e.g. "urn:tag:genre:music". */
  type: string;
  vec: Taste;
  /** Parent entity types (for /v2/tags filter.parents.types). */
  parents: string[];
  popularity: number;
}

function t(ns: string, key: string, name: string, vec: Taste, parents: string[], popularity = 0.5): WorldTag {
  return { id: `${ns}:${key}`, name, type: ns, vec, parents, popularity };
}

const MUSIC = ["urn:entity:artist"];
const MEDIA = ["urn:entity:movie", "urn:entity:tv_show", "urn:entity:podcast"];
const PLACE = ["urn:entity:place"];
const BRAND = ["urn:entity:brand"];

export const GENRE_MUSIC = "urn:tag:genre:music";
export const KEYWORD_MEDIA = "urn:tag:keyword:media";
export const THEME = "urn:tag:theme:qloo";
export const AUDIENCE = "urn:tag:audience:qloo";
export const AMBIENCE = "urn:tag:ambience:qloo";
export const GOOD_FOR = "urn:tag:good_for:qloo";
export const CATEGORY_PLACE = "urn:tag:category:place";
export const GENRE_BRAND = "urn:tag:genre:brand";
export const GENRE_PODCAST = "urn:tag:genre:podcast";
export const GENRE_MEDIA = "urn:tag:genre:media";
export const PERSON_GENRE = "urn:tag:genre:person";

export const CONTENT_TAGS: WorldTag[] = [
  t(GENRE_MUSIC, "americana", "Americana", taste({ roots: 1, indie_alt: 0.15 }), MUSIC, 0.62),
  t(GENRE_MUSIC, "country", "Country", taste({ roots: 0.9, family: 0.35 }), MUSIC, 0.8),
  t(GENRE_MUSIC, "folk", "Folk", taste({ roots: 0.75, indie_alt: 0.35 }), MUSIC, 0.55),
  t(GENRE_MUSIC, "bluegrass", "Bluegrass", taste({ roots: 1 }), MUSIC, 0.4),
  t(GENRE_MUSIC, "singer_songwriter", "Singer-songwriter", taste({ roots: 0.5, indie_alt: 0.5 }), MUSIC, 0.5),
  t(GENRE_MUSIC, "hip_hop", "Hip-hop", taste({ hiphop_rnb: 1 }), MUSIC, 0.85),
  t(GENRE_MUSIC, "r_and_b", "R&B", taste({ hiphop_rnb: 0.8, arts_dining: 0.2 }), MUSIC, 0.75),
  t(GENRE_MUSIC, "soul", "Soul", taste({ hiphop_rnb: 0.55, roots: 0.25, arts_dining: 0.25 }), MUSIC, 0.6),
  t(GENRE_MUSIC, "indie_pop", "Indie pop", taste({ indie_alt: 1 }), MUSIC, 0.6),
  t(GENRE_MUSIC, "alternative_rock", "Alternative rock", taste({ indie_alt: 0.8, roots: 0.15 }), MUSIC, 0.65),
  t(GENRE_MUSIC, "latin_pop", "Latin pop", taste({ latin: 1 }), MUSIC, 0.6),
  t(GENRE_MUSIC, "jazz", "Jazz", taste({ arts_dining: 0.8, hiphop_rnb: 0.2 }), MUSIC, 0.5),
  t(KEYWORD_MEDIA, "stand_up_comedy", "Stand-up comedy", taste({ comedy_night: 1 }), MEDIA, 0.7),
  t(KEYWORD_MEDIA, "sitcom", "Sitcom", taste({ comedy_night: 0.6, family: 0.45 }), MEDIA, 0.7),
  t(KEYWORD_MEDIA, "road_trip", "Road trip", taste({ roots: 0.5, indie_alt: 0.3 }), MEDIA, 0.45),
  t(KEYWORD_MEDIA, "small_town", "Small town", taste({ roots: 0.6, family: 0.4 }), MEDIA, 0.45),
  t(KEYWORD_MEDIA, "late_night", "Late night", taste({ comedy_night: 0.5, hiphop_rnb: 0.3, indie_alt: 0.3 }), MEDIA, 0.5),
  t(KEYWORD_MEDIA, "game_night", "Game night", taste({ comedy_night: 0.45, family: 0.5, hiphop_rnb: 0.3 }), MEDIA, 0.4),
  t(KEYWORD_MEDIA, "coming_of_age", "Coming of age", taste({ indie_alt: 0.5, family: 0.3 }), MEDIA, 0.45),
  t(THEME, "storytelling", "Storytelling", taste({ roots: 0.6, comedy_night: 0.4 }), MUSIC, 0.5),
  t(THEME, "heartbreak", "Heartbreak", taste({ roots: 0.5, indie_alt: 0.45 }), MUSIC, 0.5),
  t(THEME, "celebration", "Celebration", taste({ hiphop_rnb: 0.4, latin: 0.45, family: 0.3 }), MUSIC, 0.5),
  t(THEME, "nostalgia", "Nostalgia", taste({ roots: 0.4, family: 0.4, comedy_night: 0.3 }), MUSIC, 0.5),
  t(THEME, "city_life", "City life", taste({ hiphop_rnb: 0.5, indie_alt: 0.4, arts_dining: 0.3 }), MUSIC, 0.5),
  t(THEME, "friendship", "Friendship", taste({ comedy_night: 0.5, indie_alt: 0.3, family: 0.3 }), MUSIC, 0.5),
  t(AUDIENCE, "roots_music_fans", "Roots music fans", taste({ roots: 1 }), MUSIC, 0.5),
  t(AUDIENCE, "comedy_fans", "Comedy fans", taste({ comedy_night: 1 }), MUSIC, 0.5),
  t(AUDIENCE, "indie_fans", "Indie fans", taste({ indie_alt: 1 }), MUSIC, 0.5),
  t(AUDIENCE, "rnb_fans", "R&B fans", taste({ hiphop_rnb: 1 }), MUSIC, 0.5),
  t(AUDIENCE, "latin_music_fans", "Latin music fans", taste({ latin: 1 }), MUSIC, 0.5),
  t(AUDIENCE, "family_audiences", "Family audiences", taste({ family: 1 }), MUSIC, 0.5),
  t(AUDIENCE, "arts_audiences", "Arts audiences", taste({ arts_dining: 1 }), MUSIC, 0.5),
  t(GENRE_MEDIA, "comedy", "Comedy", taste({ comedy_night: 0.9, family: 0.2 }), MEDIA, 0.8),
  t(GENRE_MEDIA, "family", "Family", taste({ family: 1 }), MEDIA, 0.7),
];

/** Place categories: the key is what config/tags.json calls a category. */
export const PLACE_CATEGORIES = [
  "bar",
  "pub",
  "sports_bar",
  "restaurant",
  "soul_food",
  "cafe",
  "record_store",
  "book_store",
  "clothing_store",
  "barber_shop",
  "beauty_salon",
  "night_club",
  "bakery",
  "place_of_worship",
] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  bar: "Bar",
  pub: "Pub",
  sports_bar: "Sports bar",
  restaurant: "Restaurant",
  soul_food: "Soul food restaurant",
  cafe: "Cafe",
  record_store: "Record store",
  book_store: "Book store",
  clothing_store: "Clothing store",
  barber_shop: "Barber shop",
  beauty_salon: "Beauty salon",
  night_club: "Night club",
  bakery: "Bakery",
  place_of_worship: "Place of worship",
};

export function categoryTagId(c: string): string {
  return `${CATEGORY_PLACE}:${c}`;
}

export const CATEGORY_TAGS: WorldTag[] = PLACE_CATEGORIES.map((c) => t(CATEGORY_PLACE, c, CATEGORY_LABEL[c], taste({}), PLACE, 0.6));

export const AMBIENCE_TAGS: WorldTag[] = [
  t(AMBIENCE, "cozy", "Cozy", taste({ roots: 0.4, arts_dining: 0.4 }), PLACE),
  t(AMBIENCE, "lively", "Lively", taste({ hiphop_rnb: 0.4, latin: 0.4, comedy_night: 0.3 }), PLACE),
  t(AMBIENCE, "laid_back", "Laid-back", taste({ roots: 0.5, indie_alt: 0.3 }), PLACE),
  t(AMBIENCE, "intimate", "Intimate", taste({ arts_dining: 0.5, indie_alt: 0.3 }), PLACE),
  t(AMBIENCE, "trendy", "Trendy", taste({ indie_alt: 0.5, arts_dining: 0.4 }), PLACE),
  t(AMBIENCE, "retro", "Retro", taste({ roots: 0.4, indie_alt: 0.4 }), PLACE),
  t(AMBIENCE, "neighborhood_feel", "Neighborhood feel", taste({ family: 0.4, comedy_night: 0.3 }), PLACE),
];

export const GOOD_FOR_TAGS: WorldTag[] = [
  t(GOOD_FOR, "groups", "Groups", taste({ comedy_night: 0.4, family: 0.4 }), PLACE),
  t(GOOD_FOR, "live_music", "Live music", taste({ roots: 0.5, indie_alt: 0.4 }), PLACE),
  t(GOOD_FOR, "late_night", "Late night", taste({ hiphop_rnb: 0.4, comedy_night: 0.4 }), PLACE),
  t(GOOD_FOR, "date_night", "Date night", taste({ arts_dining: 0.6 }), PLACE),
  t(GOOD_FOR, "brunch", "Brunch", taste({ arts_dining: 0.5, family: 0.3 }), PLACE),
  t(GOOD_FOR, "kids", "Kids", taste({ family: 1 }), PLACE),
  t(GOOD_FOR, "happy_hour", "Happy hour", taste({ comedy_night: 0.3, indie_alt: 0.3 }), PLACE),
  t(GOOD_FOR, "craft_beer", "Craft beer", taste({ roots: 0.3, indie_alt: 0.4 }), PLACE),
];

export const BRAND_GENRES = ["coffee", "apparel", "sneakers", "grocery", "outdoor", "music_gear", "alcohol", "tobacco", "gambling", "local_bank"] as const;
export type BrandGenre = (typeof BRAND_GENRES)[number];

function label(key: string): string {
  const s = key.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const BRAND_TAGS: WorldTag[] = BRAND_GENRES.map((g) => t(GENRE_BRAND, g, label(g), taste({}), BRAND));

export const PODCAST_GENRES = ["music", "comedy", "food", "sports", "local_news", "storytelling"] as const;
export const PODCAST_TAGS: WorldTag[] = PODCAST_GENRES.map((g) => t(GENRE_PODCAST, g, label(g), taste({}), ["urn:entity:podcast"]));

export const PERSON_TAGS: WorldTag[] = [
  t(PERSON_GENRE, "comedian", "Comedian", taste({ comedy_night: 1 }), ["urn:entity:person"]),
  t("urn:tag:occupation:person", "actor", "Actor", taste({ family: 0.3, comedy_night: 0.3 }), ["urn:entity:person"]),
];

/**
 * Tags in denied namespaces, present only to exercise the policy code (the
 * "denied tags present" knob). Names say they are examples.
 */
export const DENIED_EXAMPLE_TAGS: WorldTag[] = [
  t("urn:tag:ethnicity:qloo", "synthetic_example", "Synthetic ethnicity example", taste({}), PLACE, 0.1),
  t("urn:tag:inclusivity:qloo", "synthetic_example", "Synthetic inclusivity example", taste({}), PLACE, 0.1),
  t("urn:tag:credit_card:qloo", "visa", "Visa", taste({}), PLACE, 0.9),
  t(KEYWORD_MEDIA, "synthetic_ethnic_heritage_example", "Synthetic ethnic heritage example", taste({}), MEDIA, 0.1),
];
export const DENIED_ETHNICITY = DENIED_EXAMPLE_TAGS[0] as WorldTag;
export const DENIED_INCLUSIVITY = DENIED_EXAMPLE_TAGS[1] as WorldTag;
export const DENIED_CREDIT_CARD = DENIED_EXAMPLE_TAGS[2] as WorldTag;
/** A keyword tag whose name carries a denied term (denied by keyword, not namespace). */
export const DENIED_KEYWORD = DENIED_EXAMPLE_TAGS[3] as WorldTag;

export const ALL_TAGS: WorldTag[] = [
  ...CONTENT_TAGS,
  ...CATEGORY_TAGS,
  ...AMBIENCE_TAGS,
  ...GOOD_FOR_TAGS,
  ...BRAND_TAGS,
  ...PODCAST_TAGS,
  ...PERSON_TAGS,
  ...DENIED_EXAMPLE_TAGS,
];

const BY_ID = new Map(ALL_TAGS.map((x) => [x.id, x]));
export function tagById(id: string): WorldTag | undefined {
  return BY_ID.get(id);
}

/** The tag in Qloo's raw entity-tag shape (id/name/type). */
export function rawTag(tag: WorldTag): { id: string; name: string; type: string } {
  return { id: tag.id, name: tag.name, type: tag.type };
}

/** Namespace of a tag id: "urn:tag:genre:music:americana" -> "urn:tag:genre:music". */
export function tagNamespace(id: string): string {
  const parts = id.split(":");
  return parts.slice(0, -1).join(":");
}
