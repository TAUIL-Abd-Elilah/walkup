/**
 * Numbered map markers that never stack. Points closer than `minPx` on screen
 * merge into one marker labelled with every rank ("3, 4"), placed at the first
 * rank's point. Pure, so the WebGL map, the static SVG map and tests share it.
 */
export interface MarkerPoint {
  rank: number;
  x: number;
  y: number;
}

export interface MarkerGroup {
  ranks: number[];
  /** "3" or "3, 4". */
  label: string;
  x: number;
  y: number;
}

/** Markers this close (px) are drawn as one. */
export const MARKER_MERGE_PX = 22;

/**
 * One look for an area number everywhere: a 20 px ink circle with a white 12 px numeral and a thin white ring.
 * The maps are light in both themes, so these are fixed hex; the `.marker` class in globals.css uses the same
 * values, so the list beside a map matches it in light and dark mode.
 */
export const MARKER = { fill: "#111111", text: "#ffffff", radius: 10, fontSize: 12, ring: 1.5 } as const;

/**
 * Frame padding (px) shared by the street map's fitBounds and the static drawing, so the street map fades in
 * over the same positions. Top and right leave room for a number drawn up and to the right of an edge tile.
 */
export const MAP_PAD = { top: 69, right: 69, bottom: 56, left: 56 } as const;

export function groupMarkers(points: readonly MarkerPoint[], minPx = MARKER_MERGE_PX): MarkerGroup[] {
  const groups: MarkerGroup[] = [];
  for (const p of [...points].sort((a, b) => a.rank - b.rank)) {
    const g = groups.find((x) => Math.hypot(x.x - p.x, x.y - p.y) < minPx);
    if (g) {
      g.ranks.push(p.rank);
      g.label = g.ranks.join(", ");
    } else groups.push({ ranks: [p.rank], label: String(p.rank), x: p.x, y: p.y });
  }
  return groups;
}

/** A bounding box in degrees. */
export interface Extent {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/** The union of several extents (null entries skipped), so two maps can share one frame and one scale. */
export function unionExtents(list: readonly (Extent | null | undefined)[]): Extent | null {
  const xs = list.filter((e): e is Extent => !!e);
  if (xs.length === 0) return null;
  return {
    minLat: Math.min(...xs.map((e) => e.minLat)),
    maxLat: Math.max(...xs.map((e) => e.maxLat)),
    minLon: Math.min(...xs.map((e) => e.minLon)),
    maxLon: Math.max(...xs.map((e) => e.maxLon)),
  };
}
