/**
 * Where each audience lives, for heatmaps only. The shared preference field
 * (metro.ts) describes what a neighbourhood's places are like, and its blobs
 * overlap across dimensions. Heat also needs "where fans of this kind of act
 * live": a few hotspots per dimension, each on a cell no other dimension uses
 * (at least MIN_APART_KM apart while the pool allows), in the lower-middle
 * band of the metro's density so a hotspot can move a cell's rank. Invented
 * for tests: it models no real audience.
 */
import { populatedGrid, type MetroModel } from "./metro";
import { clamp, unit } from "./rng";
import { DIMS, type Taste } from "./taste";

/** Hotspots per dimension. */
const HOTSPOTS = 3;
/** Hotspots sit within this distance of the metro centre. */
const HOTSPOT_RADIUS_KM = 22;
/** No two hotspots closer than this, while the pool allows. */
const MIN_APART_KM = 3.5;
/** Hotspots sit on cells between these density quantiles of the metro's 2,600 densest cells within 30 km. */
const DENSITY_BAND: [number, number] = [0.15, 0.55];

interface Hotspot {
  lat: number;
  lon: number;
  sigmaKm: number;
  amp: number;
}

function kmDist2(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dy = (aLat - bLat) * 110.57;
  const dx = (aLon - bLon) * 111.32 * Math.cos((bLat * Math.PI) / 180);
  return dx * dx + dy * dy;
}

export type AudienceField = (lat: number, lon: number) => Taste;

function build(m: MetroModel, seed: string): AudienceField {
  const ascending = [...populatedGrid(m, m.center, 30, seed).slice(0, 2600)].reverse();
  const pool = ascending
    .slice(Math.floor(DENSITY_BAND[0] * ascending.length), Math.floor(DENSITY_BAND[1] * ascending.length))
    .filter((c) => kmDist2(c.lat, c.lon, m.center.lat, m.center.lon) < HOTSPOT_RADIUS_KM * HOTSPOT_RADIUS_KM);
  const taken: { lat: number; lon: number }[] = [];
  const spots: Hotspot[][] = DIMS.map((dim) => {
    const out: Hotspot[] = [];
    for (let b = 0; b < HOTSPOTS; b++) {
      const k = `${seed}|${m.key}|audience|${dim}|${b}`;
      const free = pool.filter((p) => taken.every((t) => kmDist2(p.lat, p.lon, t.lat, t.lon) >= MIN_APART_KM * MIN_APART_KM));
      const from = free.length > 0 ? free : pool;
      if (from.length === 0) break;
      const anchor = from[Math.min(from.length - 1, Math.floor(unit(`${k}|anchor`) * from.length))] as (typeof from)[number];
      taken.push(anchor);
      out.push({ lat: anchor.lat, lon: anchor.lon, sigmaKm: 1.5 + unit(`${k}|s`) * 1.5, amp: 0.7 + unit(`${k}|a`) * 0.3 });
    }
    return out;
  });
  return (lat, lon) =>
    spots.map((list) => {
      let s = 0;
      for (const h of list) s += h.amp * Math.exp(-kmDist2(lat, lon, h.lat, h.lon) / (2 * h.sigmaKm * h.sigmaKm));
      return clamp(s, 0, 1);
    });
}

const FIELDS = new Map<string, AudienceField>();

/** The audience field of a metro (cached per world seed). */
export function audienceField(m: MetroModel, seed: string): AudienceField {
  const k = `${seed}|${m.key}`;
  let f = FIELDS.get(k);
  if (!f) {
    f = build(m, seed);
    FIELDS.set(k, f);
  }
  return f;
}
