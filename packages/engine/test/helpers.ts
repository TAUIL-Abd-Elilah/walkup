/**
 * Synthetic builders for engine tests. Everything here is made up: no Qloo
 * response bodies are used anywhere in this package's tests.
 */
import ngeohash from "ngeohash";
import type { HeatCell, QlooEntity, QlooTag } from "@walkup/contracts";
import { mulberry32, type Rng } from "../src/rng";

/** Distinct geohash-6 tiles laid out on a grid around a point. */
export function gridGeohash6(n: number, lat = 36.16, lon = -86.78): string[] {
  const out = new Set<string>();
  const side = Math.ceil(Math.sqrt(n)) + 2;
  for (let i = 0; out.size < n && i < side * side * 4; i++) {
    const r = Math.floor(i / side);
    const c = i % side;
    out.add(ngeohash.encode(lat + r * 0.006, lon + c * 0.012, 6));
  }
  return [...out].slice(0, n);
}

/** One geohash-7 cell inside a geohash-6 tile (by child index 0..31). */
export function child7(gh6: string, i = 0): string {
  return gh6 + "0123456789bcdefghjkmnpqrstuvwxyz"[i % 32];
}

export function cell(geohash: string, affinity: number, popularity = 0.5, extra: Partial<HeatCell> = {}): HeatCell {
  const d = ngeohash.decode(geohash);
  return { geohash, lat: d.latitude, lon: d.longitude, affinity, affinityRank: affinity, popularity, ...extra };
}

/** A heat map with one geohash-7 cell per tile, values from a function of the tile index. */
export function heatMap(tiles: string[], aff: (i: number) => number, pop: (i: number) => number = () => 0.8): HeatCell[] {
  return tiles.map((t, i) => cell(child7(t, i), aff(i), pop(i)));
}

export function rng(seed: number): Rng {
  return mulberry32(seed);
}

export function tag(id: string, name?: string): QlooTag {
  return { id, name: name ?? id.split(":").at(-1) ?? id };
}

export function place(
  name: string,
  opts: {
    id?: string;
    category?: string;
    hours?: unknown;
    isClosed?: boolean;
    distanceM?: number | null;
    tags?: QlooTag[];
    properties?: Record<string, unknown>;
    subtype?: string;
  } = {},
): QlooEntity {
  const tags = opts.tags ?? (opts.category ? [tag(`urn:tag:category:place:${opts.category}`, opts.category)] : []);
  const properties: Record<string, unknown> = { address: `${name} Test St`, phone: "+1 555 0100", website: "https://example.test", ...opts.properties };
  if (opts.hours !== undefined) properties.hours = opts.hours;
  if (opts.isClosed !== undefined) properties.is_closed = opts.isClosed;
  const e: QlooEntity = {
    entityId: opts.id ?? `P-${name.replace(/\W+/g, "-")}`,
    name,
    subtype: opts.subtype ?? "urn:entity:place",
    popularity: 0.5,
    affinity: 0.5,
    tags,
    properties,
  };
  if (opts.distanceM !== undefined) e.distanceM = opts.distanceM;
  return e;
}
