import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Bbox,
  LoadOptions,
  MetroGazetteer,
  MetroRef,
  MultiMetroOptions,
  NeighbourhoodKind,
  NeighbourhoodRecord,
  PlaceRecord,
  ZctaRecord,
} from "./types";

export class GazetteerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GazetteerError";
  }
}

/**
 * data/gazetteer/out, resolved from this file (packages/gazetteer/src -> repo root). Built with path.resolve
 * rather than a literal `new URL(..., import.meta.url)`, which bundlers read as an asset reference. A bundled
 * server moves this module, so WALKUP_GAZETTEER_DIR (set by the image and by the web app) wins at runtime.
 */
export const DEFAULT_GAZETTEER_DIR: string = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "gazetteer", "out");

/** Files in the output directory that are not metros. */
const NON_METRO_FILES = new Set(["manifest.json"]);

const cache = new Map<string, MetroGazetteer>();
/** Files already reported as unloadable by loadAllMetros (one warning each until cleared). */
const warned = new Set<string>();

export function gazetteerDir(opts?: LoadOptions): string {
  const fromEnv = process.env.WALKUP_GAZETTEER_DIR;
  return resolve(opts?.dir ?? (fromEnv && fromEnv.trim() ? fromEnv : DEFAULT_GAZETTEER_DIR));
}

/** Drop cached metros (tests, or after a rebuild in a long-lived process). */
export function clearGazetteerCache(): void {
  cache.clear();
  warned.clear();
}

/**
 * Load one metro (synchronous, cached per directory). Throws GazetteerError when the
 * file is missing or malformed. Metro names are file stems: "nashville", "hampton_roads", ...
 */
export function loadMetro(name: string, opts?: LoadOptions): MetroGazetteer {
  if (!/^[a-z0-9_-]+$/i.test(name)) throw new GazetteerError(`invalid metro name: ${JSON.stringify(name)}`);
  const dir = gazetteerDir(opts);
  const file = join(dir, `${name}.json`);
  const hit = cache.get(file);
  if (hit) return hit;
  if (!existsSync(file)) {
    const known = listMetros(opts);
    throw new GazetteerError(
      `no gazetteer for metro "${name}" in ${dir}` + (known.length ? ` (available: ${known.join(", ")})` : " (run data/gazetteer/build.py)"),
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new GazetteerError(`${file}: not valid JSON (${(e as Error).message})`);
  }
  const metro = parseMetro(raw, file);
  cache.set(file, metro);
  return metro;
}

/** Metro names available in the directory (file stems, sorted). */
export function listMetros(opts?: LoadOptions): string[] {
  const dir = gazetteerDir(opts);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !NON_METRO_FILES.has(f))
    .map((f) => f.slice(0, -".json".length))
    .filter((n) => /^[a-z0-9_-]+$/i.test(n))
    .sort();
}

/**
 * Every loadable metro in the directory. A malformed file is skipped, not fatal, but it is
 * reported once through process.emitWarning (type "GazetteerWarning") so a broken metro
 * does not silently turn into "no metro covers this point".
 */
export function loadAllMetros(opts?: LoadOptions): MetroGazetteer[] {
  const out: MetroGazetteer[] = [];
  for (const name of listMetros(opts)) {
    try {
      out.push(loadMetro(name, opts));
    } catch (e) {
      // A broken file must not take down naming for the other metros, but it must be visible.
      const file = join(gazetteerDir(opts), `${name}.json`);
      if (!warned.has(file)) {
        warned.add(file);
        process.emitWarning(`skipped metro "${name}": ${(e as Error).message}`, { type: "GazetteerWarning" });
      }
    }
  }
  return out;
}

export function resolveMetro(ref: MetroRef, opts?: LoadOptions): MetroGazetteer {
  return typeof ref === "string" ? loadMetro(ref, opts) : ref;
}

export function resolveMetros(opts?: MultiMetroOptions): MetroGazetteer[] {
  return opts?.metros ?? loadAllMetros(opts);
}

// ---------------------------------------------------------------------------
// Validation (hand-rolled: this package has no runtime dependencies)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);

function fail(origin: string, msg: string): never {
  throw new GazetteerError(`${origin}: ${msg}`);
}

function parseBbox(v: unknown, origin: string): Bbox {
  if (!isObj(v) || !isNum(v.south) || !isNum(v.west) || !isNum(v.north) || !isNum(v.east)) {
    fail(origin, "bbox must be {south, west, north, east} numbers");
  }
  if (v.south > v.north || v.west > v.east) fail(origin, "bbox is inverted");
  return { south: v.south, west: v.west, north: v.north, east: v.east };
}

function arrayOf<T>(v: unknown, key: string, origin: string, item: (x: Obj, i: number) => T | null): T[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(origin, `${key} must be an array`);
  const out: T[] = [];
  v.forEach((x, i) => {
    if (!isObj(x)) fail(origin, `${key}[${i}] must be an object`);
    const parsed = item(x, i);
    if (parsed) out.push(parsed);
  });
  return out;
}

const HOOD_KINDS: readonly NeighbourhoodKind[] = ["neighbourhood", "suburb", "quarter"];

/** Validate and normalise a parsed gazetteer document. Records without coordinates are dropped. */
export function parseMetro(raw: unknown, origin = "gazetteer"): MetroGazetteer {
  if (!isObj(raw)) fail(origin, "top level must be an object");
  if (typeof raw.metro !== "string" || !raw.metro) fail(origin, "metro must be a non-empty string");
  const bbox = parseBbox(raw.bbox, origin);

  const neighbourhoods = arrayOf<NeighbourhoodRecord>(raw.neighbourhoods, "neighbourhoods", origin, (x) => {
    if (typeof x.name !== "string" || !x.name.trim() || !isNum(x.lat) || !isNum(x.lon)) return null;
    const kind = HOOD_KINDS.includes(x.kind as NeighbourhoodKind) ? (x.kind as NeighbourhoodKind) : "neighbourhood";
    return { name: x.name.trim(), lat: x.lat, lon: x.lon, kind, osmId: typeof x.osmId === "string" ? x.osmId : "" };
  });

  const places = arrayOf<PlaceRecord>(raw.places, "places", origin, (x) => {
    if (typeof x.name !== "string" || !x.name.trim() || !isNum(x.lat) || !isNum(x.lon)) return null;
    const rec: PlaceRecord = {
      name: x.name.trim(),
      geoid: typeof x.geoid === "string" ? x.geoid : String(x.geoid ?? ""),
      lat: x.lat,
      lon: x.lon,
      landKm2: numOrNull(x.landKm2),
    };
    if (x.kind === "incorporated" || x.kind === "cdp") rec.kind = x.kind;
    return rec;
  });

  const zctas = arrayOf<ZctaRecord>(raw.zctas, "zctas", origin, (x) => {
    if (typeof x.zcta !== "string" || !isNum(x.lat) || !isNum(x.lon)) return null;
    return {
      zcta: x.zcta,
      lat: x.lat,
      lon: x.lon,
      landKm2: numOrNull(x.landKm2),
      totalPop: numOrNull(x.totalPop),
      adults21: numOrNull(x.adults21),
      medianAge: numOrNull(x.medianAge),
      medianIncome: numOrNull(x.medianIncome),
    };
  });

  const attribution = isObj(raw.attribution) ? raw.attribution : {};
  const center =
    isObj(raw.center) && isNum(raw.center.lat) && isNum(raw.center.lon)
      ? { lat: raw.center.lat, lon: raw.center.lon }
      : { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };

  const out: MetroGazetteer = {
    metro: raw.metro,
    center,
    bbox,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
    attribution: {
      osm: typeof attribution.osm === "string" ? attribution.osm : "© OpenStreetMap contributors, ODbL",
      census: typeof attribution.census === "string" ? attribution.census : "U.S. Census Bureau, public domain",
    },
    neighbourhoods,
    places,
    zctas,
  };
  if (typeof raw.label === "string") out.label = raw.label;
  if (raw.synthetic === true) out.synthetic = true;
  if (isObj(raw.sources)) out.sources = raw.sources as MetroGazetteer["sources"];
  if (Array.isArray(raw.errors)) out.errors = raw.errors.filter((e): e is string => typeof e === "string");
  return out;
}
