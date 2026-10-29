"use client";
/**
 * MapLibre GL layer for the lift map. Loaded with next/dynamic (ssr: false),
 * so maplibre-gl is only ever evaluated in the browser. Draws geohash-6 tiles
 * as GeoJSON polygons in the accent at rising opacity over OpenFreeMap's light
 * "positron" style (with a small dot under each tile so a tile never shrinks
 * below a few pixels when zoomed out), numbers the ranked tiles to match the
 * list (markers closer than 22 px merge into one, "3, 4"), marks the venue
 * with the same small square as the static drawing, carries a metric scale bar,
 * and reports back if WebGL or the basemap is unavailable. Attribution is shown
 * in the figure caption (LiftMap), so the MapLibre control is off. The page
 * scrolls past the map freely: wheel zoom is off and +/- buttons zoom instead.
 * A tap on a tile or its number selects it (LiftMap scrolls the list row into
 * view); there are no popups.
 */
import { useEffect, useRef } from "react";
import type { FeatureCollection, Point, Polygon } from "geojson";
import type { ExpressionSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { GeoJSONSource, Map as MlMap, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LiftTile } from "@walkup/contracts";
import { bboxRing, decodeBbox, unionBbox, type Bbox } from "../lib/geohash";
import { LIFT_INK, liftAlpha } from "../lib/lift";
import { MAP_PAD, MARKER, groupMarkers } from "../lib/markers";
import { areaName } from "../lib/sheet-utils";
import { MAP_FONT_BOLD, MAP_FONT_REGULAR, MAP_TIMEOUT_REASON, MAPLIBRE_WORKER_URL, OPENFREEMAP_STYLE, hasWebGL } from "../lib/webgl";

export interface MapCanvasProps {
  tiles: LiftTile[];
  venue: { lat: number; lon: number; name: string };
  ranked: string[];
  selected: string | null;
  onSelect?: (geohash: string) => void;
  onReady: () => void;
  onUnavailable: (reason: string) => void;
  label: string;
  /** A frame shared with another map (the landing page's two bills), so both use one scale. */
  extent?: Bbox | null;
}

const INK = "#111111";
const WHITE = "#ffffff";
/** Pixel offset of the number markers from the tile centre (up and to the right); MAP_PAD leaves room for it. */
const MARKER_OFFSET: [number, number] = [13, -13];
/** A single number's circle (px across); a merged marker's circle is a multiple of it, by label length. */
const RANK_BOX_PX = MARKER.radius * 2;
/** Label length ("3", "3, 4", "1, 3, 5", ...) to circle size in RANK_BOX_PX: wide enough for every number in it. */
const RANK_SCALE: [number, number][] = [
  [1, 1],
  [4, 1.4],
  [7, 2],
  [10, 2.6],
  [13, 3.2],
];

/** A layout or paint value per label length, from the circle's scale (a step expression: labels come in fixed lengths). */
function rankStep(value: (scale: number) => unknown): ExpressionSpecification {
  const [first, ...rest] = RANK_SCALE;
  return ["step", ["length", ["get", "label"]], value(first![1]), ...rest.flatMap(([len, s]) => [len, value(s)])] as unknown as ExpressionSpecification;
}

/** How long the street map may take to come up, counted in painted frames (see the wait in MapCanvas). */
const MAP_WAIT_MS = 15_000;
/** The most one frame adds to that wait: a longer gap is time the page was not painted. */
const MAX_FRAME_GAP_MS = 250;
/** Layers a click or tap can select, top first: a number, then the tile under it. */
const PICKABLE = ["wk-rank", "wk-tiles-fill"];

/** The venue mark: an 8 px ink square in a 2 px white ring, drawn at 2x, like the static drawing's square. */
function venueSquare(): { width: number; height: number; data: Uint8Array } {
  const size = 24;
  const ring = 4;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const edge = x < ring || y < ring || x >= size - ring || y >= size - ring;
      const i = (y * size + x) * 4;
      const v = edge ? 255 : 17;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

type TileProps = { geohash: string; alpha: number; name: string };

/** A tile's name with its own state ("Langston, DC"), the same label as the area list and the partner table. */
function tileName(t: LiftTile): string {
  return t.name ? areaName(t) : "";
}

function tileCollection(tiles: LiftTile[]): FeatureCollection<Polygon, TileProps> {
  return {
    type: "FeatureCollection",
    features: [...tiles]
      .sort((a, b) => a.lift - b.lift)
      .map((t) => ({
        type: "Feature",
        properties: { geohash: t.geohash, alpha: liftAlpha(t.lift), name: tileName(t) },
        geometry: { type: "Polygon", coordinates: [bboxRing(decodeBbox(t.geohash))] },
      })),
  };
}

function dotCollection(tiles: LiftTile[]): FeatureCollection<Point, TileProps> {
  return {
    type: "FeatureCollection",
    features: [...tiles]
      .sort((a, b) => a.lift - b.lift)
      .map((t) => ({
        type: "Feature",
        properties: { geohash: t.geohash, alpha: liftAlpha(t.lift), name: tileName(t) },
        geometry: { type: "Point", coordinates: [t.lon, t.lat] },
      })),
  };
}

/** One feature per marker group at the current zoom ("3, 4" when two ranked tiles sit within 22 px). */
function rankCollection(map: MlMap, tiles: LiftTile[], ranked: string[]): FeatureCollection<Point, { label: string; geohash: string }> {
  const points = tiles
    .filter((t) => ranked.includes(t.geohash))
    .map((t) => {
      const p = map.project([t.lon, t.lat]);
      return { rank: ranked.indexOf(t.geohash) + 1, x: p.x, y: p.y, lon: t.lon, lat: t.lat, geohash: t.geohash };
    });
  const byRank = new Map(points.map((p) => [p.rank, p]));
  return {
    type: "FeatureCollection",
    features: groupMarkers(points).map((g) => {
      const first = byRank.get(g.ranks[0]!)!;
      return { type: "Feature", properties: { label: g.label, geohash: first.geohash }, geometry: { type: "Point", coordinates: [first.lon, first.lat] } };
    }),
  };
}

export default function MapCanvas({ tiles, venue, ranked, selected, onSelect, onReady, onUnavailable, label, extent = null }: MapCanvasProps) {
  // Content key, not array identity: parents may rebuild the tiles array on every
  // render, and the map must only be rebuilt when the tiles themselves change.
  const tilesKey = tiles.map((t) => `${t.geohash}:${t.lift}:${t.name ?? ""}`).join("|");
  const extentKey = extent ? `${extent.minLat},${extent.minLon},${extent.maxLat},${extent.maxLon}` : "";
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const loadedRef = useRef(false);
  // Keep the latest callbacks without re-creating the map.
  const cb = useRef({ onSelect, onReady, onUnavailable });
  useEffect(() => {
    cb.current = { onSelect, onReady, onUnavailable };
  });

  useEffect(() => {
    if (!hasWebGL()) {
      cb.current.onUnavailable("WebGL is not available in this browser.");
      return;
    }
    let cancelled = false;
    let frame: number | undefined;
    let ready = false;
    const readyNow = () => {
      if (ready || cancelled) return;
      ready = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      cb.current.onReady();
    };

    (async () => {
      const ml = await import("maplibre-gl");
      if (cancelled || !containerRef.current) return;
      ml.setWorkerUrl(MAPLIBRE_WORKER_URL);
      // Frame the ranked tiles and the venue (or the shared frame); the rest of the grid is there when you zoom out.
      const framed = tiles.filter((t) => ranked.includes(t.geohash));
      const ext = extent ?? unionBbox((framed.length > 0 ? framed : tiles).map((t) => decodeBbox(t.geohash)), [venue]);
      const map = new ml.Map({
        container: containerRef.current,
        style: OPENFREEMAP_STYLE,
        ...(ext
          ? {
              bounds: [
                [ext.minLon, ext.minLat],
                [ext.maxLon, ext.maxLat],
              ] as [[number, number], [number, number]],
              fitBoundsOptions: { padding: { ...MAP_PAD } },
            }
          : { center: [venue.lon, venue.lat] as [number, number], zoom: 10 }),
        attributionControl: false,
        // On a touch screen one finger scrolls the page and two move the map, so the page never gets stuck on it.
        cooperativeGestures: typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true,
        scrollZoom: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        maxZoom: 15,
      });
      mapRef.current = map;
      map.touchZoomRotate.disableRotation();
      // A frame too small for the padding when the map was made (a narrow or still-hidden column) leaves MapLibre at
      // its whole-world view. Re-fit to the frame whenever the box changes size, until the reader moves the map.
      if (ext) {
        let moved = false;
        const fit = () => {
          if (moved || cancelled) return;
          const box = containerRef.current?.getBoundingClientRect();
          if (!box || box.width <= MAP_PAD.left + MAP_PAD.right || box.height <= MAP_PAD.top + MAP_PAD.bottom) return;
          map.resize();
          map.fitBounds(
            [
              [ext.minLon, ext.minLat],
              [ext.maxLon, ext.maxLat],
            ],
            { padding: { ...MAP_PAD }, animate: false },
          );
        };
        map.on("dragstart", () => (moved = true));
        map.on("zoomstart", (e: { originalEvent?: unknown }) => {
          if (e.originalEvent) moved = true;
        });
        map.on("load", fit);
        if (typeof ResizeObserver !== "undefined" && containerRef.current) {
          const ro = new ResizeObserver(() => fit());
          ro.observe(containerRef.current);
          map.on("remove", () => ro.disconnect());
        }
      }
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      // Datawrapper's locator maps always carry a scale; so does the static drawing.
      map.addControl(new ml.ScaleControl({ maxWidth: 100, unit: "metric" }), "bottom-left");

      // The wait counts painted frames, not the clock. MapLibre fires "load" from an animation frame, and a page that
      // paints none (a background tab, a minimised window, a hidden app pane that still reports "visible") would
      // otherwise give up on the map before anyone looked at it. A long gap between frames is unpainted time.
      let waited = 0;
      let last: number | null = null;
      const tick = (now: number) => {
        frame = undefined;
        if (ready || cancelled) return;
        if (last !== null) waited += Math.min(now - last, MAX_FRAME_GAP_MS);
        last = now;
        if (waited < MAP_WAIT_MS) {
          frame = requestAnimationFrame(tick);
          return;
        }
        // Style up but tiles still coming: show the street map anyway; nothing up at all: keep the drawing.
        if (loadedRef.current) readyNow();
        else cb.current.onUnavailable(MAP_TIMEOUT_REASON);
      };
      frame = requestAnimationFrame(tick);

      map.on("error", () => {
        // Individual tile/sprite errors are not fatal once the style is up.
        if (!loadedRef.current) cb.current.onUnavailable("The base map could not be reached.");
      });

      map.on("load", () => {
        loadedRef.current = true;
        // Tiles go under the basemap's labels so street and place names stay readable.
        const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
        map.addSource("wk-tiles", { type: "geojson", data: tileCollection(tiles) });
        map.addSource("wk-dots", { type: "geojson", data: dotCollection(tiles) });
        // A minimum on-screen size: a small dot under each tile, fading out as the tiles grow on zoom in.
        map.addLayer(
          {
            id: "wk-tiles-dot",
            type: "circle",
            source: "wk-dots",
            paint: {
              "circle-color": LIFT_INK,
              "circle-opacity": ["get", "alpha"],
              "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 11, 3, 12.5, 0],
            },
          },
          firstSymbol,
        );
        map.addLayer(
          {
            id: "wk-tiles-fill",
            type: "fill",
            source: "wk-tiles",
            paint: { "fill-color": LIFT_INK, "fill-opacity": ["get", "alpha"] },
          },
          firstSymbol,
        );
        map.addLayer(
          {
            id: "wk-tiles-line",
            type: "line",
            source: "wk-tiles",
            paint: { "line-color": WHITE, "line-width": 0.6, "line-opacity": 0.9 },
          },
          firstSymbol,
        );
        map.addLayer({
          id: "wk-tiles-selected",
          type: "line",
          source: "wk-tiles",
          filter: ["==", ["get", "geohash"], selected ?? ""],
          paint: { "line-color": INK, "line-width": 2.5 },
        });
        map.addSource("wk-venue", {
          type: "geojson",
          data: { type: "Feature", properties: { name: venue.name }, geometry: { type: "Point", coordinates: [venue.lon, venue.lat] } },
        });
        if (!map.hasImage("wk-venue-square")) map.addImage("wk-venue-square", venueSquare(), { pixelRatio: 2 });
        // Transparent: only its size matters (the area numbers' collision box).
        if (!map.hasImage("wk-rank-box")) map.addImage("wk-rank-box", { width: RANK_BOX_PX, height: RANK_BOX_PX, data: new Uint8Array(RANK_BOX_PX * RANK_BOX_PX * 4) });
        // Our marks are placed before the basemap's labels (they sit above them), so a place name under the venue square
        // or an area number gives way ("Chicago" under the square is hidden) instead of being drawn half covered.
        map.addLayer({
          id: "wk-venue",
          type: "symbol",
          source: "wk-venue",
          layout: { "icon-image": "wk-venue-square", "icon-allow-overlap": true, "icon-ignore-placement": false },
        });
        // Under the square by default; on another side when an area number sits there.
        map.addLayer({
          id: "wk-venue-label",
          type: "symbol",
          source: "wk-venue",
          layout: {
            "text-field": ["get", "name"],
            "text-font": MAP_FONT_REGULAR,
            "text-size": 12,
            "text-variable-anchor": ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"],
            "text-radial-offset": 1.1,
          },
          paint: { "text-color": INK, "text-halo-color": WHITE, "text-halo-width": 1.5 },
        });
        // The widest tile buffer, so a number whose point sits near a vector-tile edge is never cut off in one tile and
        // left as a bare dot (the circle and the numeral are drawn per tile).
        map.addSource("wk-rank", { type: "geojson", data: rankCollection(map, tiles, ranked), buffer: 512 });
        map.addLayer({
          id: "wk-rank",
          type: "circle",
          source: "wk-rank",
          // Beside the tile's centre, not on it, so a small tile stays visible under its number. A merged marker grows
          // with its label ("3, 4", "1, 3, 4, 5"), so every number sits inside the circle.
          paint: {
            "circle-radius": rankStep((s) => s * RANK_BOX_PX / 2),
            "circle-color": MARKER.fill,
            "circle-stroke-color": MARKER.text,
            "circle-stroke-width": MARKER.ring,
            "circle-translate": MARKER_OFFSET,
          },
        });
        map.addLayer({
          id: "wk-rank-num",
          type: "symbol",
          source: "wk-rank",
          // Always drawn, and counted in placement, so basemap labels and the venue's name give way to a number. The
          // collision box is an invisible square the circle's size, placed where the circle is drawn (layout offsets,
          // which placement uses; paint translates are not).
          layout: {
            "text-field": ["get", "label"],
            "text-font": MAP_FONT_BOLD,
            "text-size": MARKER.fontSize,
            "text-offset": [MARKER_OFFSET[0] / MARKER.fontSize, MARKER_OFFSET[1] / MARKER.fontSize],
            "text-allow-overlap": true,
            "text-ignore-placement": false,
            "text-padding": 0,
            "icon-image": "wk-rank-box",
            "icon-size": rankStep((s) => s),
            // An icon offset is scaled by the icon size, so it is divided back out.
            "icon-offset": rankStep((s) => ["literal", [MARKER_OFFSET[0] / s, MARKER_OFFSET[1] / s]]),
            "icon-allow-overlap": true,
            "icon-ignore-placement": false,
            "icon-padding": 0,
            "symbol-avoid-edges": false,
          },
          paint: { "text-color": MARKER.text },
        });
        // Regroup the markers whenever the zoom changes what is too close to tell apart.
        map.on("moveend", () => {
          (map.getSource("wk-rank") as GeoJSONSource | undefined)?.setData(rankCollection(map, tiles, ranked));
        });

        // One handler for numbers and tiles, so a tap on a number over its tile selects once (not on, then off).
        const hit = (e: MapMouseEvent): unknown => map.queryRenderedFeatures(e.point, { layers: PICKABLE })[0]?.properties?.geohash;
        map.on("click", (e: MapMouseEvent) => {
          const gh = hit(e);
          if (typeof gh === "string") cb.current.onSelect?.(gh);
        });
        map.on("mousemove", (e: MapMouseEvent) => {
          map.getCanvas().style.cursor = cb.current.onSelect && typeof hit(e) === "string" ? "pointer" : "";
        });
        // Fade in once the tiles and numbers are drawn, not before: the basemap alone would hide the drawing's marks.
        map.once("idle", readyNow);
      });
    })().catch(() => cb.current.onUnavailable("The map library failed to load."));

    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      mapRef.current?.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // The map is built once per tile set; selection updates go through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesKey, ranked.join(","), venue.lat, venue.lon, venue.name, extentKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loadedRef.current || !map.getLayer("wk-tiles-selected")) return;
    map.setFilter("wk-tiles-selected", ["==", ["get", "geohash"], selected ?? ""]);
  }, [selected]);

  return <div ref={containerRef} className="h-full w-full" role="region" aria-label={label} />;
}
