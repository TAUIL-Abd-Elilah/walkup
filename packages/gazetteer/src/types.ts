/**
 * Shapes of data/gazetteer/out/<metro>.json, written by data/gazetteer/build.py.
 * Optional fields are optional so older or hand-made files still load.
 */

export interface Bbox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type NeighbourhoodKind = "neighbourhood" | "suburb" | "quarter";

/** An OSM place=neighbourhood|suburb|quarter point (node, or way/relation centre). */
export interface NeighbourhoodRecord {
  name: string;
  lat: number;
  lon: number;
  kind: NeighbourhoodKind;
  /** "node/123", "way/456" or "relation/789". */
  osmId: string;
}

/** A Census Gazetteer place, located at its internal point. */
export interface PlaceRecord {
  /** Name without the legal suffix ("Franklin", not "Franklin city"). */
  name: string;
  geoid: string;
  lat: number;
  lon: number;
  kind?: "incorporated" | "cdp";
  /** Land area; used for the area-aware match. Null when the source had none. */
  landKm2?: number | null;
}

/** A Census ZCTA internal point joined to ACS 5-year estimates. Nulls mean "not available". */
export interface ZctaRecord {
  zcta: string;
  lat: number;
  lon: number;
  landKm2?: number | null;
  totalPop: number | null;
  /** B01001 total minus the under-21 bins. */
  adults21: number | null;
  medianAge: number | null;
  /** Median household income, ACS end-year dollars. */
  medianIncome: number | null;
}

export interface SourceStatus {
  status: "ok" | "failed" | "skipped";
  [key: string]: unknown;
}

export interface MetroGazetteer {
  metro: string;
  label?: string;
  center?: { lat: number; lon: number };
  bbox: Bbox;
  generatedAt: string;
  /** Present (true) only on test fixtures. */
  synthetic?: boolean;
  sources?: Record<string, SourceStatus>;
  errors?: string[];
  attribution: { osm: string; census: string };
  neighbourhoods: NeighbourhoodRecord[];
  places: PlaceRecord[];
  zctas: ZctaRecord[];
}

export type NameSource = "neighbourhood" | "place";

export interface PointName {
  name: string;
  source: NameSource;
  /** Distance from the query point to the named point (neighbourhood point or place internal point). */
  distanceKm: number;
  /** osmId for neighbourhoods, Census GEOID for places. */
  ref: string;
  /** False when the query point lies outside the metro box (the name is then only "nearest"). */
  insideMetro: boolean;
}

export interface ZctaHit extends ZctaRecord {
  distanceKm: number;
}

/** How the Census-place fallback picks a place. */
export type PlaceStrategy = "area-aware" | "nearest";

export interface NameOptions {
  /** A neighbourhood is used when it is at most this far away. Default 2.5 km. */
  neighbourhoodRadiusKm?: number;
  /**
   * "area-aware" (default): prefer the smallest place whose equivalent circle
   * (radius sqrt(landKm2 / pi)) contains the point, else the place with the nearest
   * circle edge. "nearest": nearest internal point, ignoring area.
   */
  placeStrategy?: PlaceStrategy;
}

export interface LoadOptions {
  /** Directory holding <metro>.json. Defaults to WALKUP_GAZETTEER_DIR, else data/gazetteer/out. */
  dir?: string;
}

/** A metro by name (loaded from `dir`) or an already-loaded gazetteer. */
export type MetroRef = string | MetroGazetteer;

export interface MultiMetroOptions extends LoadOptions {
  /** Use these gazetteers instead of every file in `dir`. */
  metros?: MetroGazetteer[];
}
