/**
 * Geometry for the panel 1 map: geohash cells projected into a fixed SVG box.
 * Pure numbers, no rendering, so it is easy to test.
 *
 * Projection: equirectangular, longitude scaled by cos(mid latitude), aspect
 * preserved and centred. The view is framed on the top tiles and the venue
 * (padded), so the tiles that matter are legible; other tiles are drawn faintly
 * where they fall inside the frame. There is no basemap: a light kilometre grid
 * and a scale bar give distance instead.
 *
 * Colour: one ink (the accent red, as on the web maps) at rising strength, the
 * same steps as the web app's lib/lift.ts, blended over white so print and
 * screen agree.
 */
import type { LiftTile } from "@walkup/contracts";
import { geohashPolygon, isValidGeohash } from "@walkup/engine";
import { TOP_LIFT } from "./format";

export type LiftBand = "top" | "mild" | "under";

export interface MapRect {
  geohash: string;
  x: number;
  y: number;
  w: number;
  h: number;
  lift: number;
  band: LiftBand;
  /** 1-based rank among the top tiles; null for context tiles. */
  rank: number | null;
  fill: string;
}

export interface TileMapLayout {
  width: number;
  height: number;
  /** Context tiles first, then top tiles from rank N down to rank 1 (drawn last, on top). */
  rects: MapRect[];
  venue: { x: number; y: number } | null;
  /**
   * One numbered label per top tile: (x, y) is the label centre, placed beside
   * the cell so it never hides it and kept clear of other labels and the venue;
   * (anchorX, anchorY) is the cell centre, for a leader line.
   */
  labels: { rank: number; text: string; x: number; y: number; anchorX: number; anchorY: number }[];
  /**
   * The venue's name under its square (above it near the bottom edge), kept inside the frame: (x, y) is the text's
   * centre on its baseline, `half` its half width. The markers keep clear of it. Null without a venue or a name.
   */
  venueLabel: { text: string; x: number; y: number; half: number } | null;
  /** Map units per kilometre (0 when nothing was laid out), for the grid and the scale bar. */
  unitsPerKm: number;
}

/** Type size of the venue's name on the map, in map units, and the most characters printed. */
export const VENUE_LABEL_SIZE = 5.2;
export const VENUE_LABEL_MAX_CHARS = 32;

/** A box on the map the markers keep clear of. */
export interface MapBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Where the venue's name goes: centred under the venue square (above it when that would run off the bottom), kept
 * inside the frame. The width is estimated from the character count (Helvetica at 5.2 units).
 */
export function venueLabelSpot(text: string, venue: { x: number; y: number }, width: number, height: number): { text: string; x: number; y: number; half: number } {
  const name = text.slice(0, VENUE_LABEL_MAX_CHARS);
  const half = name.length * 1.35;
  const x = Math.max(half + 2, Math.min(width - half - 2, venue.x));
  const y = venue.y + 9 > height - 2 ? venue.y - 5 : venue.y + 9;
  return { text: name, x, y, half };
}

/** The box a venue label covers, with a small margin: from the tops of the capitals to below the descenders. */
export function venueLabelBox(l: { x: number; y: number; half: number }): MapBox {
  return { x0: l.x - l.half - 1, x1: l.x + l.half + 1, y0: l.y - 4.2, y1: l.y + 1.5 };
}

/** Radius of a rank label, in map units. */
export const LABEL_RADIUS = 4.3;
/** Cells drawn smaller than this (either side) also get a ring so they stay visible. */
export const MIN_VISIBLE_CELL = 5;

/**
 * Groups anchors closer than `minDist` map units into one marker labelled with every rank ("3, 4"), so two
 * areas too close to tell apart at this scale never stack. The group sits at the first rank's anchor.
 */
export function groupAnchors(anchors: readonly { rank: number; x: number; y: number }[], minDist = 2 * LABEL_RADIUS + 1): { rank: number; text: string; x: number; y: number }[] {
  const groups: { ranks: number[]; x: number; y: number }[] = [];
  for (const a of [...anchors].sort((p, q) => p.rank - q.rank)) {
    const g = groups.find((x) => Math.hypot(x.x - a.x, x.y - a.y) < minDist);
    if (g) g.ranks.push(a.rank);
    else groups.push({ ranks: [a.rank], x: a.x, y: a.y });
  }
  return groups.map((g) => ({ rank: g.ranks[0] as number, text: g.ranks.join(", "), x: g.x, y: g.y }));
}

/**
 * Places rank labels beside their cells: tries a ring of offsets around each
 * cell and keeps the first spot that stays inside the box and clear of earlier
 * labels, the cells' centres, the venue and `avoidBoxes` (the venue's name);
 * otherwise the spot with the most room. Deterministic.
 */
export function placeLabels(
  anchors: readonly { rank: number; x: number; y: number; text?: string }[],
  avoid: readonly { x: number; y: number }[],
  width: number,
  height: number,
  avoidBoxes: readonly MapBox[] = [],
): TileMapLayout["labels"] {
  const r = LABEL_RADIUS;
  const d = 2 * r + 1.2;
  const offsets: [number, number][] = [
    [d, -d],
    [-d, -d],
    [d, d],
    [-d, d],
    [d * 1.3, 0],
    [-d * 1.3, 0],
    [0, -d * 1.3],
    [0, d * 1.3],
    [d * 2, -d * 2],
    [-d * 2, -d * 2],
    [d * 2, d * 2],
    [-d * 2, d * 2],
  ];
  const placed: { x: number; y: number }[] = [];
  const out: TileMapLayout["labels"] = [];
  const clampX = (x: number) => Math.max(r + 0.5, Math.min(width - r - 0.5, x));
  const clampY = (y: number) => Math.max(r + 0.5, Math.min(height - r - 0.5, y));
  for (const a of anchors) {
    let best: { x: number; y: number; room: number } | null = null;
    for (const [ox, oy] of offsets) {
      const x = clampX(a.x + ox);
      const y = clampY(a.y + oy);
      const others = [
        ...placed.map((p) => Math.hypot(p.x - x, p.y - y) - 2 * r),
        ...avoid.map((p) => Math.hypot(p.x - x, p.y - y) - r - 2.5),
        // Inside or touching a box: negative room, so the next offset is tried.
        ...avoidBoxes.map((b) => Math.hypot(x - Math.max(b.x0, Math.min(b.x1, x)), y - Math.max(b.y0, Math.min(b.y1, y))) - r - 0.5),
      ];
      const room = others.length > 0 ? Math.min(...others) : Number.POSITIVE_INFINITY;
      if (room >= 0.5) {
        best = { x, y, room };
        break;
      }
      if (!best || room > best.room) best = { x, y, room };
    }
    const spot = best ?? { x: clampX(a.x), y: clampY(a.y), room: 0 };
    placed.push({ x: spot.x, y: spot.y });
    out.push({ rank: a.rank, text: a.text ?? String(a.rank), x: spot.x, y: spot.y, anchorX: a.x, anchorY: a.y });
  }
  return out;
}

export interface TileMapOptions {
  width: number;
  height: number;
  /** Fraction of the framed span added on each side. Default 0.18. */
  padding?: number;
  /** Smallest framed span in degrees of latitude (keeps one tile from filling the box). Default 0.03. */
  minSpanDeg?: number;
  /** Most context tiles drawn. Default 400. */
  maxContextTiles?: number;
  /** The venue's name as printed under its square; the markers keep clear of it. */
  venueLabel?: string;
}

/** The accent ink the tiles are drawn in (the web app's LIFT_INK and --color-accent). */
export const LIFT_INK = "#b42318";

export function liftBand(lift: number): LiftBand {
  if (lift >= TOP_LIFT) return "top";
  if (lift >= 1) return "mild";
  return "under";
}

/** Strength of the accent for a tile with this lift: top tiles 0.55 to 1.0, mild 0.22, under 0.08 (as the web maps). */
export function liftAlpha(lift: number): number {
  const band = liftBand(lift);
  if (band === "top") {
    const k = Math.max(0, Math.min(1, (lift - TOP_LIFT) / 0.9));
    return Math.round((0.55 + 0.45 * k) * 100) / 100;
  }
  return band === "mild" ? 0.22 : 0.08;
}

function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const k = Math.max(0, Math.min(1, t));
  const ch = (shift: number) => {
    const x = (pa >> shift) & 255;
    const y = (pb >> shift) & 255;
    return Math.round(x + (y - x) * k);
  };
  return `#${[ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Print palette: black on white, thin light rules, the tiles in the accent at rising strength. */
export const MAP_COLORS = {
  /** Lowest top tile (1.3x). */
  topLow: mixHex("#ffffff", LIFT_INK, 0.55),
  /** Highest top tiles (2.2x and up). */
  topHigh: LIFT_INK,
  mild: mixHex("#ffffff", LIFT_INK, 0.22),
  under: mixHex("#ffffff", LIFT_INK, 0.08),
  venue: "#111111",
  frame: "#e3e3e3",
  grid: "#efefef",
  muted: "#555555",
} as const;

/** The tile colour as an opaque blend of the accent over white. */
export function liftFill(lift: number): string {
  return mixHex("#ffffff", LIFT_INK, liftAlpha(lift));
}

/** A round distance for the scale bar and grid, near `targetKm` (0.5, 1, 2, 5, 10, 20 or 50 km). */
export function niceKm(targetKm: number): number {
  const steps = [0.5, 1, 2, 5, 10, 20, 50];
  return steps.reduce((best, s) => (Math.abs(s - targetKm) < Math.abs(best - targetKm) ? s : best), 1);
}

interface BBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

function bboxOf(geohash: string): BBox | null {
  if (!isValidGeohash(geohash)) return null;
  const ring = geohashPolygon(geohash);
  const sw = ring[0];
  const ne = ring[2];
  if (!sw || !ne) return null;
  return { minLon: sw[0], minLat: sw[1], maxLon: ne[0], maxLat: ne[1] };
}

function validPoint(p: { lat: number; lon: number } | null | undefined): p is { lat: number; lon: number } {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

/**
 * Lays out `top` (ranked) and `all` tiles around the venue in a width x height
 * box. Tiles with an invalid geohash are skipped.
 */
export function layoutTileMap(
  all: readonly LiftTile[],
  top: readonly LiftTile[],
  venue: { lat: number; lon: number } | null,
  opts: TileMapOptions,
): TileMapLayout {
  const { width, height } = opts;
  const pad = opts.padding ?? 0.18;
  const minSpan = opts.minSpanDeg ?? 0.03;
  const empty: TileMapLayout = { width, height, rects: [], venue: null, labels: [], venueLabel: null, unitsPerKm: 0 };

  // Ranks come from the position in `top` before invalid cells are dropped, so
  // map label N always matches tile N in the list beside it.
  const topBoxes = top
    .map((t, i) => ({ t, b: bboxOf(t.geohash), rank: i + 1 }))
    .filter((x): x is { t: LiftTile; b: BBox; rank: number } => x.b !== null);
  const frameFrom: BBox[] = topBoxes.map((x) => x.b);
  if (frameFrom.length === 0) {
    for (const t of all) {
      const b = bboxOf(t.geohash);
      if (b) frameFrom.push(b);
    }
  }
  const v = validPoint(venue) ? venue : null;
  if (v) frameFrom.push({ minLat: v.lat, maxLat: v.lat, minLon: v.lon, maxLon: v.lon });
  if (frameFrom.length === 0) return empty;

  let minLat = Math.min(...frameFrom.map((b) => b.minLat));
  let maxLat = Math.max(...frameFrom.map((b) => b.maxLat));
  let minLon = Math.min(...frameFrom.map((b) => b.minLon));
  let maxLon = Math.max(...frameFrom.map((b) => b.maxLon));
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));

  // Enforce a minimum span, then pad.
  const latSpan0 = Math.max(maxLat - minLat, minSpan);
  const lonSpan0 = Math.max(maxLon - minLon, minSpan / kx);
  const cLat = (minLat + maxLat) / 2;
  const cLon = (minLon + maxLon) / 2;
  minLat = cLat - (latSpan0 / 2) * (1 + 2 * pad);
  maxLat = cLat + (latSpan0 / 2) * (1 + 2 * pad);
  minLon = cLon - (lonSpan0 / 2) * (1 + 2 * pad);
  maxLon = cLon + (lonSpan0 / 2) * (1 + 2 * pad);

  const spanX = (maxLon - minLon) * kx;
  const spanY = maxLat - minLat;
  const scale = Math.min(width / spanX, height / spanY);
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const px = (lon: number) => offX + (lon - minLon) * kx * scale;
  const py = (lat: number) => offY + (maxLat - lat) * scale;

  const toRect = (t: LiftTile, b: BBox, rank: number | null): MapRect => ({
    geohash: t.geohash,
    x: px(b.minLon),
    y: py(b.maxLat),
    w: (b.maxLon - b.minLon) * kx * scale,
    h: (b.maxLat - b.minLat) * scale,
    lift: t.lift,
    band: liftBand(t.lift),
    rank,
    fill: liftFill(t.lift),
  });
  const inside = (r: MapRect) => r.x + r.w > 0 && r.y + r.h > 0 && r.x < width && r.y < height;

  const topSet = new Set(topBoxes.map((x) => x.t.geohash));
  const context: MapRect[] = [];
  for (const t of all) {
    if (topSet.has(t.geohash)) continue;
    const b = bboxOf(t.geohash);
    if (!b) continue;
    const r = toRect(t, b, null);
    if (inside(r)) context.push(r);
    if (context.length >= (opts.maxContextTiles ?? 400)) break;
  }
  const ranked = topBoxes.map((x) => toRect(x.t, x.b, x.rank));
  const venuePt = v ? { x: px(v.lon), y: py(v.lat) } : null;
  const anchors = ranked.map((r) => ({ rank: r.rank as number, x: r.x + r.w / 2, y: r.y + r.h / 2 }));
  const avoid = [...anchors.map((a) => ({ x: a.x, y: a.y })), ...(venuePt ? [venuePt] : [])];
  const name = (opts.venueLabel ?? "").trim();
  const venueLabel = venuePt && name !== "" ? venueLabelSpot(name, venuePt, width, height) : null;
  return {
    width,
    height,
    rects: [...context, ...[...ranked].reverse()],
    venue: venuePt,
    labels: placeLabels(groupAnchors(anchors), avoid, width, height, venueLabel ? [venueLabelBox(venueLabel)] : []),
    venueLabel,
    // One degree of latitude is about 110.57 km; `scale` is map units per degree of latitude.
    unitsPerKm: scale / 110.57,
  };
}
