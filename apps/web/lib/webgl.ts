/** Browser-only: true when a WebGL context can be created. Always false on the server. */
export function hasWebGL(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * Why the street map gave up when its basemap was not up within the wait (counted in painted frames, so a page
 * nobody is looking at never runs out of time). LiftMap tries again when the page is shown next, since a slow load
 * can still finish.
 */
export const MAP_TIMEOUT_REASON = "Map tiles did not load in time.";

/** Same-origin copy of the MapLibre worker (served by app/vendor/maplibre-gl-worker.mjs/route.ts). */
export const MAPLIBRE_WORKER_URL = "/vendor/maplibre-gl-worker.mjs";

/** OpenFreeMap's light basemap: grey streets and labels, so the accent tiles carry the colour. */
export const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";

/** Fonts served by OpenFreeMap's glyph endpoint (used for our own labels on top of the style). */
export const MAP_FONT_REGULAR = ["Noto Sans Regular"];
export const MAP_FONT_BOLD = ["Noto Sans Bold"];

/** What the basemap needs credited, shown under every map (the MapLibre control is off). */
export const MAP_ATTRIBUTION = [
  { label: "OpenFreeMap", href: "https://openfreemap.org" },
  { label: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
  { label: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
] as const;
