"use client";
/**
 * Lift map: the static drawing renders first (server, print, no WebGL), and the interactive MapLibre layer fades
 * in on top once it has loaded. Same box either way, so nothing shifts. The drawing is sized to the frame it is
 * measured in, so its text and numbers draw at their real size and match the list. The caption credits the
 * basemap (and the data, when `source` is given); a failed street map is said in words above it.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { LiftTile } from "@walkup/contracts";
import { cellSizeKm, type Bbox } from "../lib/geohash";
import { MAP_ATTRIBUTION } from "../lib/webgl";
import { SIMPLIFIED_NOTE, StaticLiftMap } from "./StaticLiftMap";

const MapCanvas = dynamic(() => import("./MapCanvas"), { ssr: false, loading: () => null });

export interface LiftMapProps {
  tiles: LiftTile[];
  venue: { lat: number; lon: number; name: string };
  ranked: string[];
  idBase: string;
  title: string;
  selected?: string | null;
  onSelect?: (geohash: string) => void;
  /** Tailwind aspect/height classes for the frame. Default: about 4:5 on a phone, 16:10 from 640px. */
  frameClass?: string;
  interactive?: boolean;
  /** A frame shared with another map, so both use one scale. */
  extent?: Bbox | null;
  /** Print the caption under the map (off when one caption covers two maps). */
  caption?: boolean;
  /** "Data: ..." at the start of the caption's source line, e.g. "Data: Qloo, Q3 and Q4." Left out when not given. */
  source?: ReactNode;
  /** A muted line printed above the credit line, e.g. what a square is ("Each square is about 1.0 km by 0.6 km. ..."). */
  captionLead?: string;
  /**
   * The id of the area list (TileList `id`) that numbers these tiles. A tap on a numbered area then scrolls its
   * row into view, where it is shaded; the map shows no popup.
   */
  listId?: string;
}

/** "Each square is about 1.0 km by 0.6 km." from the tiles themselves (a geohash cell narrows away from the equator). */
export function squareSizeLine(tiles: readonly Pick<LiftTile, "geohash">[]): string | null {
  const t = tiles[0];
  if (!t) return null;
  const { widthKm, heightKm } = cellSizeKm(t.geohash);
  return `Each square is about ${widthKm.toFixed(1)} km by ${heightKm.toFixed(1)} km.`;
}

/**
 * The muted caption under a map (or under a pair of maps). With `tiles`, a first line says what a square is and
 * the privacy limit; the last line gives the data source (when given) and the basemap credit. A single map's
 * caption is the credit line only: the plan page prints its own square-size line under the map.
 */
export function MapCaption({
  tiles,
  source,
  lead,
  whose = "this bill's",
}: {
  tiles?: readonly Pick<LiftTile, "geohash">[];
  source?: ReactNode;
  /** A sentence put first on the first line ("Both maps use the same frame and scale."). */
  lead?: string;
  /** "this bill's" or "each bill's". */
  whose?: string;
}) {
  const first = tiles ? [lead, squareSizeLine(tiles), `Shading shows where ${whose} fans stand out, not where buyers live.`].filter(Boolean).join(" ") : lead;
  return (
    <>
      {first ? <span className="block">{first}</span> : null}
      <span className="block">
        {source ? <>{source} </> : null}Map:{" "}
        {MAP_ATTRIBUTION.map((a, i) => (
          <span key={a.href}>
            {i > 0 ? ", " : null}
            <a className="underline underline-offset-2 hover:text-ink" href={a.href}>
              {a.label}
            </a>
          </span>
        ))}
        .
      </span>
    </>
  );
}

/** The frame's inner size in px, measured after hydration (null on the server and before the first layout). */
function useFrameSize(): [RefObject<HTMLDivElement | null>, { w: number; h: number } | null] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  return [ref, size];
}

export function LiftMap({
  tiles,
  venue,
  ranked,
  idBase,
  title,
  selected = null,
  onSelect,
  frameClass = "aspect-[4/5] sm:aspect-[16/10]",
  interactive = true,
  extent = null,
  caption = true,
  source,
  captionLead,
  listId,
}: LiftMapProps) {
  const [state, setState] = useState<"loading" | "ready" | "fallback">(interactive ? "loading" : "fallback");
  const [why, setWhy] = useState<string>("");
  const [frameRef, size] = useFrameSize();

  // A tap on the map selects the area and brings its row into view; the row is the only place the details live.
  const pick = useCallback(
    (geohash: string) => {
      onSelect?.(geohash);
      if (!listId) return;
      const row = document.getElementById(listId)?.querySelector<HTMLElement>(`[data-geohash="${geohash}"]`);
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      row?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    },
    [onSelect, listId],
  );

  const note = state === "loading" ? "Simplified drawing while the street map loads." : SIMPLIFIED_NOTE;

  return (
    <figure className="m-0">
      <div ref={frameRef} className={`relative w-full overflow-hidden rounded-[4px] border border-rule bg-[#f8f8f6] ${frameClass}`}>
        <StaticLiftMap
          tiles={tiles}
          venue={venue}
          ranked={ranked}
          selected={selected}
          idBase={idBase}
          title={title}
          width={size?.w ?? 480}
          height={size?.h ?? 360}
          className="absolute inset-0 h-full w-full"
          extent={extent}
          note={note}
          onSelect={onSelect ? pick : undefined}
        />
        {interactive && state !== "fallback" ? (
          <div className={`absolute inset-0 transition-opacity duration-200 ${state === "ready" ? "opacity-100" : "pointer-events-none opacity-0"}`}>
            <MapCanvas
              tiles={tiles}
              venue={venue}
              ranked={ranked}
              selected={selected}
              onSelect={onSelect ? pick : undefined}
              label={`${title} (interactive map)`}
              extent={extent}
              onReady={() => setState("ready")}
              onUnavailable={(reason) => {
                setWhy(reason);
                setState("fallback");
              }}
            />
          </div>
        ) : null}
      </div>
      {caption || (interactive && state === "fallback") ? (
        <figcaption className="mt-1.5 text-sm leading-snug text-muted">
          {interactive && state === "fallback" ? (
            <span className="block">
              The street map didn&apos;t load. {why} The list has the same areas.
            </span>
          ) : null}
          {caption ? <MapCaption source={source} lead={captionLead} /> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}
