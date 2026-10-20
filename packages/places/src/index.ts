/**
 * @walkup/places: Google Places API (New) Text Search for the control arm and
 * grounding checks. Every request writes one "places" ledger entry.
 */
export * from "./types";
export * from "./client";
export * from "./hours";
export * from "./match";
export {
  createMemoryCacheStore,
  createMemoryCounterStore,
  MAX_CACHE_TTL_MS,
  pacificDayKey,
} from "./stores";
export type { Clock, Sleep, DailyCounterStore, PlacesCacheEntry, PlacesCacheStore } from "./stores";

/**
 * Text attribution for Places content. Google's policy for Places data shown without
 * a Google map asks for the Google Maps logo or, where a logo does not fit, this text.
 */
export const PLACES_ATTRIBUTION = "Google Maps";
/** Provider name for source lists ("Data sources: ..."). */
export const PLACES_PROVIDER = "Google";
