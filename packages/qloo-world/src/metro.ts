/**
 * Geography of the fixture world, anchored on the offline gazetteer: the three
 * metros, a population-density surface built from ZCTA adult counts, and a
 * smooth latent taste field (a few Gaussian blobs per dimension, centred on
 * populated ZCTA points). Map cells and places read both surfaces, so the
 * same neighbourhood "likes" the same things in every response.
 */
import { loadMetro, nameForPoint, nearestZcta, type MetroGazetteer } from "@walkup/gazetteer";
import type { MetroKey } from "./catalog-entities";
import { cellsWithin, geohashCenter, haversineKm } from "./geo";
import { clamp, unit } from "./rng";
import { DIMS, type Taste } from "./taste";

export const METRO_KEYS: MetroKey[] = ["nashville", "hampton_roads", "tacoma"];

interface Blob {
  lat: number;
  lon: number;
  sigmaKm: number;
  amp: number;
}

interface Kernel {
  lat: number;
  lon: number;
  w: number;
  sigmaKm: number;
}

export interface GridCell {
  geohash: string;
  lat: number;
  lon: number;
  /** 0..1 relative population density. */
  density: number;
  field: Taste;
}

export interface MetroModel {
  key: MetroKey;
  gaz: MetroGazetteer;
  center: { lat: number; lon: number };
  inBox(lat: number, lon: number): boolean;
  density(lat: number, lon: number): number;
  field(lat: number, lon: number): Taste;
  /** Nearest Census place name by its internal point. */
  cityFor(lat: number, lon: number): string;
  /** The Census place the point sits in (area-aware, as the map names areas), else the nearest: the town on an address. */
  townFor(lat: number, lon: number): string;
  /** Neighbourhood or place name from the gazetteer. */
  neighbourhoodFor(lat: number, lon: number): string | null;
  /** ZIP code (the ZCTA with the nearest internal point), or null. */
  zipFor(lat: number, lon: number): string | null;
  state: string;
}

/** Taste blobs sit on neighbourhood points within this distance of the metro centre. */
const BLOB_RADIUS_KM = 20;
/** Spread of the commercial core around the metro centre. */
const CORE_SIGMA_KM = 4;

const STATE: Record<MetroKey, string> = { nashville: "TN", hampton_roads: "VA", tacoma: "WA" };

function kmDist2(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dy = (aLat - bLat) * 110.57;
  const dx = (aLon - bLon) * 111.32 * Math.cos((bLat * Math.PI) / 180);
  return dx * dx + dy * dy;
}

function weightedPick<T>(items: readonly T[], weight: (t: T) => number, u: number): T {
  const total = items.reduce((s, t) => s + Math.max(0, weight(t)), 0);
  let x = u * total;
  for (const t of items) {
    x -= Math.max(0, weight(t));
    if (x <= 0) return t;
  }
  return items[items.length - 1] as T;
}

function buildModel(key: MetroKey, seed: string): MetroModel {
  const gaz = loadMetro(key);
  const center = gaz.center ?? { lat: (gaz.bbox.south + gaz.bbox.north) / 2, lon: (gaz.bbox.west + gaz.bbox.east) / 2 };
  const kernels: Kernel[] = gaz.zctas
    .filter((z) => (z.adults21 ?? 0) > 0)
    .map((z) => ({
      lat: z.lat,
      lon: z.lon,
      w: z.adults21 ?? 0,
      sigmaKm: clamp(Math.sqrt(Math.max(1, z.landKm2 ?? 20) / Math.PI) * 0.75, 1.2, 6),
    }));
  const rawDensity = (lat: number, lon: number): number => {
    let s = 0;
    for (const k of kernels) {
      const d2 = kmDist2(lat, lon, k.lat, k.lon);
      if (d2 > 900) continue;
      s += k.w * Math.exp(-d2 / (2 * k.sigmaKm * k.sigmaKm));
    }
    return s;
  };
  let maxD = 1;
  for (const k of kernels) maxD = Math.max(maxD, rawDensity(k.lat, k.lon));

  // Taste blobs: centres on gazetteer neighbourhood points near the core,
  // weighted by how many people live around them, so lift peaks carry names.
  const near = gaz.neighbourhoods
    .filter((n) => kmDist2(n.lat, n.lon, center.lat, center.lon) < BLOB_RADIUS_KM * BLOB_RADIUS_KM)
    .map((n) => ({ lat: n.lat, lon: n.lon, w: rawDensity(n.lat, n.lon) }));
  const pool = near.length >= 8 ? near : kernels.map((k) => ({ lat: k.lat, lon: k.lon, w: k.w }));
  const blobs: Blob[][] = DIMS.map((dim) => {
    const out: Blob[] = [];
    for (let b = 0; b < 4; b++) {
      const k = `${seed}|${key}|${dim}|blob${b}`;
      const anchor = weightedPick(pool, (z) => Math.sqrt(z.w), unit(`${k}|anchor`));
      out.push({
        lat: anchor.lat + (unit(`${k}|jy`) - 0.5) * 0.01,
        lon: anchor.lon + (unit(`${k}|jx`) - 0.5) * 0.01,
        sigmaKm: 2 + unit(`${k}|s`) * 3,
        amp: 0.6 + unit(`${k}|a`) * 0.4,
      });
    }
    return out;
  });

  const inBox = (lat: number, lon: number) => lat >= gaz.bbox.south && lat <= gaz.bbox.north && lon >= gaz.bbox.west && lon <= gaz.bbox.east;

  return {
    key,
    gaz,
    center,
    state: STATE[key],
    inBox,
    density(lat, lon) {
      // Residents (ZCTA adults) plus a commercial core around the metro centre:
      // downtown is busy for every audience even where few people live.
      const resident = Math.sqrt(rawDensity(lat, lon) / maxD);
      const core = 0.95 * Math.exp(-kmDist2(lat, lon, center.lat, center.lon) / (2 * CORE_SIGMA_KM * CORE_SIGMA_KM));
      return clamp(Math.max(resident, core), 0, 1);
    },
    field(lat, lon) {
      return blobs.map((list) => {
        let s = 0.06;
        for (const b of list) s += b.amp * Math.exp(-kmDist2(lat, lon, b.lat, b.lon) / (2 * b.sigmaKm * b.sigmaKm));
        return clamp(s, 0, 1);
      });
    },
    cityFor(lat, lon) {
      let best: { name: string; d: number } | null = null;
      for (const p of gaz.places) {
        const d = haversineKm({ lat, lon }, p);
        if (!best || d < best.d) best = { name: p.name, d };
      }
      return best?.name ?? gaz.label ?? key;
    },
    townFor(lat, lon) {
      // Census places carry a point and a land area, not a boundary. Treat each as a circle of that area and take
      // the place the point sits deepest in, relative to its size: inside a small town beats the edge of a big
      // city, and a point just past a big city's edge keeps the city's name instead of a far-off town's.
      let best: { name: string; rel: number } | null = null;
      for (const p of gaz.places) {
        const r = p.landKm2 != null && p.landKm2 > 0 ? Math.sqrt(p.landKm2 / Math.PI) : 1;
        const rel = haversineKm({ lat, lon }, p) / r;
        if (!best || rel < best.rel) best = { name: p.name, rel };
      }
      return best?.name ?? gaz.label ?? key;
    },
    neighbourhoodFor(lat, lon) {
      try {
        return nameForPoint(lat, lon, gaz)?.name ?? null;
      } catch {
        return null;
      }
    },
    zipFor(lat, lon) {
      try {
        return nearestZcta(lat, lon, gaz)?.zcta ?? null;
      } catch {
        return null;
      }
    },
  };
}

const MODELS = new Map<string, MetroModel>();

export function metroModel(key: MetroKey, seed: string): MetroModel {
  const k = `${seed}|${key}`;
  let m = MODELS.get(k);
  if (!m) {
    m = buildModel(key, seed);
    MODELS.set(k, m);
  }
  return m;
}

/** The metro covering a point (box first, else nearest centre within 80 km). */
export function metroFor(lat: number, lon: number, seed: string): MetroModel | null {
  let best: { m: MetroModel; d: number } | null = null;
  for (const key of METRO_KEYS) {
    const m = metroModel(key, seed);
    const d = haversineKm({ lat, lon }, m.center);
    if (m.inBox(lat, lon)) {
      if (!best || d < best.d || !best.m.inBox(lat, lon)) best = { m, d };
    } else if (d < 80 && (!best || (!best.m.inBox(lat, lon) && d < best.d))) {
      best = { m, d };
    }
  }
  return best?.m ?? null;
}

const GRIDS = new Map<string, GridCell[]>();

/**
 * Populated geohash-6 cells within the radius, densest first. Cells outside the
 * metro box or with almost nobody around are left out, as a real heatmap
 * returns only cells with signal.
 */
export function populatedGrid(m: MetroModel, center: { lat: number; lon: number }, radiusKm: number, seed: string): GridCell[] {
  const key = `${seed}|${m.key}|${center.lat.toFixed(4)}|${center.lon.toFixed(4)}|${radiusKm.toFixed(1)}`;
  const hit = GRIDS.get(key);
  if (hit) return hit;
  const out: GridCell[] = [];
  for (const gh of cellsWithin(center, radiusKm, 6)) {
    const c = geohashCenter(gh);
    if (!m.inBox(c.lat, c.lon)) continue;
    const density = m.density(c.lat, c.lon);
    if (density < 0.12) continue;
    out.push({ geohash: gh, lat: c.lat, lon: c.lon, density, field: m.field(c.lat, c.lon) });
  }
  out.sort((a, b) => b.density - a.density || (a.geohash < b.geohash ? -1 : 1));
  GRIDS.set(key, out);
  return out;
}
