/**
 * @walkup/qloo-world
 *
 * A deterministic, clearly labelled FIXTURE stand-in for Qloo, Ticketmaster
 * Discovery and Google Places Text Search, served through fetch-compatible
 * transports. Every body says "synthetic": true; every business, podcast and
 * brand is invented. Inject the transports into the real clients to run the
 * whole pipeline offline.
 */
export { createWorld, isWorldTransport, DEFAULT_WORLD_SEED, WORLD_HOSTS, WORLD_TRANSPORT } from "./world";
export type { World, WorldOptions, WorldStats } from "./world";
export { DEFAULT_SCENARIO } from "./scenario";
export type { Scenario } from "./scenario";
export type { FetchLike } from "./http";
export { WORLD_TAG_PINS } from "./pins";
export type { WorldTagPins } from "./pins";
export { WORLD_VENUES, WORLD_EVENTS, WORLD_EVENT_IDS, worldEventById, worldEventByKey } from "./catalog-tm";
export type { WorldVenue, WorldEvent, WorldAttraction } from "./catalog-tm";
export { CATALOG, catalogById, catalogByKey, catalogBySpotify, NAMED_PLACES, VENUE_PLACES, PODCASTS, BRANDS, NOT_FOUND_PAIR } from "./catalog-entities";
export type { CatalogEntity, MetroKey } from "./catalog-entities";
export { ALL_TAGS, CONTENT_TAGS, DENIED_EXAMPLE_TAGS, tagById, categoryTagId, PLACE_CATEGORIES } from "./catalog-tags";
export type { WorldTag } from "./catalog-tags";
export { placeById, placesWithin, placeName, placePhone } from "./places-gen";
export type { WorldPlace } from "./places-gen";
export { catalogId, generatedPlaceId, parseGeneratedPlaceId, syntheticSpotifyId } from "./ids";
export { encodeGeohash, geohashCenter, haversineKm } from "./geo";
export { googlePlaceId } from "./places-transport";
