/**
 * Static lift map: a quiet locator drawing, not a street map. Geohash cells are drawn to scale around the venue
 * in the accent at rising opacity (the same steps as the street map), the numbered areas as ink circles that
 * match the list, the venue as a small labelled square, a scale bar, and one muted line saying what this is.
 * No grid and no basemap. Pure render (no hooks, no window), so it works on the server, in print, and as the
 * stand-in while the street map loads or when it can't. Light in every theme, like the basemap it stands in
 * for. On screen its frame padding matches MapCanvas, so the street map fades in over the same positions.
 */
import type { LiftTile } from "@walkup/contracts";
import { formatLift } from "../lib/format";
import { decodeBbox, unionBbox, type Bbox } from "../lib/geohash";
import { LIFT_INK, liftAlpha } from "../lib/lift";
import { MAP_PAD, MARKER, groupMarkers } from "../lib/markers";

export interface StaticLiftMapProps {
  tiles: LiftTile[];
  venue: { lat: number; lon: number; name: string };
  /** Geohashes to number, in rank order (usually the top 5). */
  ranked: string[];
  selected?: string | null;
  /**
   * "paper" is the print sheet's narrow column: white, slightly larger marks, and no note (the sheet prints its
   * own caption). "web" (also accepted under its old name "dark") is the screen drawing. Both are light.
   */
  theme?: "web" | "dark" | "paper";
  /** Size in px. LiftMap passes the frame's measured size, so text and markers draw at their real size. */
  width?: number;
  height?: number;
  idBase: string;
  title: string;
  className?: string;
  /** Only draw ranked tiles (the print sheet shows the top 5 only). */
  rankedOnly?: boolean;
  /** A frame shared with another map (the landing page's two bills), so both use one scale. */
  extent?: Bbox | null;
  /** The muted line in the top-left corner. Defaults to SIMPLIFIED_NOTE on screen and to none on paper; null hides it. */
  note?: string | null;
  /** Click or tap on a numbered area or its number. The list beside the map is the keyboard route. */
  onSelect?: (geohash: string) => void;
  /** The run built no lift map (nothing to compare with). Defaults to "no tiles at all". */
  noLift?: boolean;
}

/** The drawing's description when the run built no lift map: no area was measured, so none "fell short" of 1.3. */
export const NO_LIFT_DESC = "No lift map for this bill.";

/** What the drawing is, said once inside it. */
export const SIMPLIFIED_NOTE = "Simplified drawing: areas to scale, no streets.";

/** The same, for a drawing with no lift map: it has no areas to draw to scale, only the venue. */
export const NO_LIFT_NOTE = "Simplified drawing: the venue only, no streets.";

const KM_PER_DEG_LAT = 110.57;
const INK = "#111111";
const MUTED = "#555555";
/** Close to the street map's land colour, so the swap to the street map is quiet. Paper stays white. */
const WEB_BG = "#f8f8f6";
const PAPER_BG = "#ffffff";

/** A round scale-bar length (km) near `target`. */
export function niceKm(target: number): number {
  const steps = [0.5, 1, 2, 5, 10, 20, 50, 100];
  return steps.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), 1);
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `v` to `places` decimals. */
const round = (v: number, places: number) => {
  const k = 10 ** places;
  return Math.round(v * k) / k;
};

/** Rough width of a line of system-font text, enough to keep marks off it. */
const textWidth = (s: string, size: number) => s.length * size * 0.55;

export function StaticLiftMap({
  tiles,
  venue,
  ranked,
  selected = null,
  theme = "web",
  width = 800,
  height = 520,
  idBase,
  title,
  className = "",
  rankedOnly = false,
  extent = null,
  note,
  onSelect,
  noLift = tiles.length === 0,
}: StaticLiftMapProps) {
  const paper = theme === "paper";
  const bg = paper ? PAPER_BG : WEB_BG;
  // With no lift map there are no areas, so the drawing's own note doesn't promise them.
  const simplified = noLift ? NO_LIFT_NOTE : SIMPLIFIED_NOTE;
  const given = note === undefined ? (paper ? null : SIMPLIFIED_NOTE) : note;
  const noteText = given === SIMPLIFIED_NOTE ? simplified : given;
  const shown = rankedOnly ? tiles.filter((t) => ranked.includes(t.geohash)) : tiles;
  const boxes = shown.map((t) => ({ t, b: decodeBbox(t.geohash) }));
  // Frame the ranked tiles and the venue (or the shared frame); other tiles outside it are clipped.
  const framed = boxes.filter((x) => ranked.includes(x.t.geohash));
  const ext = extent ??
    unionBbox(
      (framed.length > 0 ? framed : boxes).map((x) => x.b),
      [venue],
    ) ?? { minLat: venue.lat - 0.05, maxLat: venue.lat + 0.05, minLon: venue.lon - 0.05, maxLon: venue.lon + 0.05 };

  const lat0 = (ext.minLat + ext.maxLat) / 2;
  // Rounded: Node and the browser may differ in the last digit of Math.cos, and the drawing is rendered on both, so an
  // unrounded value gives the rects different attributes on each side (a hydration mismatch).
  const kmPerDegLon = round(111.32 * Math.cos((lat0 * Math.PI) / 180), 6);
  const spanX = Math.max((ext.maxLon - ext.minLon) * kmPerDegLon, 2);
  const spanY = Math.max((ext.maxLat - ext.minLat) * KM_PER_DEG_LAT, 2);
  const pad = paper ? { top: 52, right: 52, bottom: 52, left: 52 } : MAP_PAD;
  const availW = Math.max(width - pad.left - pad.right, 40);
  const availH = Math.max(height - pad.top - pad.bottom, 40);
  const scale = Math.min(availW / spanX, availH / spanY); // px per km
  const offX = pad.left + (availW - spanX * scale) / 2;
  const offY = pad.top + (availH - spanY * scale) / 2;
  const cx = (ext.minLon + ext.maxLon) / 2;
  const cy = (ext.minLat + ext.maxLat) / 2;
  const px = (lon: number) => offX + (spanX / 2 + (lon - cx) * kmPerDegLon) * scale;
  const py = (lat: number) => offY + (spanY / 2 - (lat - cy) * KM_PER_DEG_LAT) * scale;

  const cells = boxes
    .map(({ t, b }) => {
      let x = px(b.minLon);
      let y = py(b.maxLat);
      let w = px(b.maxLon) - x;
      let h = py(b.minLat) - y;
      // A tile never shrinks below a small square, so it reads as a place, not a speck.
      const min = 7;
      if (w < min) {
        x -= (min - w) / 2;
        w = min;
      }
      if (h < min) {
        y -= (min - h) / 2;
        h = min;
      }
      // Two decimals is far below a pixel, and keeps the markup short.
      return { t, x: round(x, 2), y: round(y, 2), w: round(w, 2), h: round(h, 2), rank: ranked.indexOf(t.geohash) + 1 };
    })
    // Draw low lift first so the ranked tiles sit on top.
    .sort((a, b) => a.t.lift - b.t.lift);
  const rankedCells = cells.filter((c) => c.rank > 0).sort((a, b) => a.rank - b.rank);

  // Marks: the print sheet draws the map in a narrow column, so its marks are a little larger.
  const r = paper ? 11 : MARKER.radius;
  const numSize = MARKER.fontSize;
  const labelSize = paper ? 13 : 12;
  const smallSize = paper ? 12 : 12;
  const vx = px(venue.lon);
  const vy = py(venue.lat);

  // Scale bar, bottom left: a round length near a fifth of the drawing's width.
  const barKm = niceKm(width / scale / 5);
  const barPx = barKm * scale;
  const barLabel = `${barKm} km`;
  const barX = 12;
  const barY = height - 14;

  // Things the numbers must not cover: the venue, its label, the note and the scale bar.
  const venueLabelW = textWidth(venue.name, labelSize);
  const obstacles: Rect[] = [
    { x: vx - 7, y: vy - 7, w: 14, h: 14 },
    { x: vx - venueLabelW / 2, y: vy + 8, w: venueLabelW, h: labelSize + 4 },
    { x: barX, y: barY - 10, w: barPx + 8 + textWidth(barLabel, smallSize), h: 18 },
  ];
  // A screen-only note ("... while the street map loads") gives way to SIMPLIFIED_NOTE (or NO_LIFT_NOTE) on paper,
  // where the drawing is always what prints: the street map never does.
  const paperNote = noteText && noteText !== simplified && !paper ? simplified : null;
  if (noteText) obstacles.push({ x: 10, y: 8, w: Math.max(textWidth(noteText, smallSize), paperNote ? textWidth(paperNote, smallSize) : 0) + 4, h: smallSize + 8 });

  // Number markers sit beside their tile (right, then left, above, below) so the tile stays visible, and never
  // on the venue, a label or another marker. Tiles too close to tell apart share one marker ("3, 4").
  const groups = groupMarkers(
    rankedCells.map((c) => ({ rank: c.rank, x: c.x + c.w / 2, y: c.y + c.h / 2 })),
    r * 2 + 2,
  );
  const placed: { x: number; y: number; halfW: number }[] = [];
  const markers = groups.map((g) => {
    const c = rankedCells.find((x) => x.rank === g.ranks[0])!;
    const halfW = g.label.length > 2 ? r + g.label.length * 2.6 : r;
    const mx = c.x + c.w / 2;
    const my = c.y + c.h / 2;
    const gap = halfW + 2;
    const tries: [number, number][] = [
      [c.x + c.w + gap, my],
      [c.x - gap, my],
      [mx, c.y - r - 2],
      [mx, c.y + c.h + r + 2],
      [c.x + c.w + gap, c.y - r - 2],
      [c.x - gap, c.y + c.h + r + 2],
      [c.x + c.w + gap, c.y + c.h + r + 2],
      [c.x - gap, c.y - r - 2],
    ];
    const inside = (x: number, y: number) => x > halfW + 2 && y > r + 2 && x < width - halfW - 2 && y < height - r - 2;
    const onTile = (x: number, y: number) => rankedCells.some((o) => x > o.x - halfW && x < o.x + o.w + halfW && y > o.y - r && y < o.y + o.h + r);
    const onMark = (x: number, y: number) => obstacles.some((o) => x + halfW > o.x && x - halfW < o.x + o.w && y + r > o.y && y - r < o.y + o.h);
    const clear = (x: number, y: number) => placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.halfW + halfW + 2);
    const free = ([x, y]: [number, number]) => inside(x, y) && !onTile(x, y) && !onMark(x, y) && clear(x, y);
    const loose = ([x, y]: [number, number]) => inside(x, y) && !onMark(x, y) && clear(x, y);
    const fallback: [number, number] = [Math.min(width - halfW - 3, Math.max(halfW + 3, tries[0]![0])), Math.min(height - r - 3, Math.max(r + 3, tries[0]![1]))];
    const [x, y] = tries.find(free) ?? tries.find(loose) ?? fallback;
    placed.push({ x, y, halfW });
    return { c, g, x, y, halfW, ax: mx, ay: my };
  });

  const titleId = `${idBase}-title`;
  const descId = `${idBase}-desc`;
  const desc = rankedCells.map((c) => `${c.rank}. ${c.t.name ?? `Area ${c.rank}`}, lift ${formatLift(c.t.lift)}`).join("; ");
  const pick = (geohash: string) => (onSelect ? () => onSelect(geohash) : undefined);
  const pointer = onSelect ? { cursor: "pointer" } : undefined;
  const halo = { stroke: bg, strokeWidth: 3, paintOrder: "stroke" as const, strokeLinejoin: "round" as const };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      className={className}
      style={{ background: bg, fontFamily: "var(--font-sans)" }}
      data-drawing="static"
    >
      <title id={titleId}>{title}</title>
      <desc id={descId}>
        {noLift ? NO_LIFT_DESC : desc ? `Numbered areas: ${desc}.` : "No area reached a lift of 1.3."} {noteText ?? ""}
      </desc>
      <rect x="0" y="0" width={width} height={height} fill={bg} />
      <g>
        {cells.map((c) => (
          <rect
            key={c.t.geohash}
            x={c.x}
            y={c.y}
            width={c.w}
            height={c.h}
            fill={LIFT_INK}
            fillOpacity={liftAlpha(c.t.lift)}
            stroke={bg}
            strokeWidth="1"
            onClick={c.rank > 0 ? pick(c.t.geohash) : undefined}
            style={c.rank > 0 ? pointer : undefined}
          />
        ))}
        {cells
          .filter((c) => c.t.geohash === selected)
          .map((c) => (
            <rect key={`sel-${c.t.geohash}`} x={c.x - 1.5} y={c.y - 1.5} width={c.w + 3} height={c.h + 3} fill="none" stroke={INK} strokeWidth="2.5" />
          ))}
      </g>
      {/* Venue: a small labelled square */}
      <g>
        <rect x={vx - 5} y={vy - 5} width="10" height="10" fill={INK} stroke={bg} strokeWidth="2" />
        <text x={vx} y={vy + 8 + labelSize} textAnchor="middle" fontSize={labelSize} fill={INK} {...halo}>
          {venue.name}
        </text>
      </g>
      {/* Numbers that match the list */}
      <g>
        {markers.map(({ c, g, x, y, halfW, ax, ay }) => (
          <g key={c.t.geohash} onClick={pick(c.t.geohash)} style={pointer}>
            {Math.hypot(ax - x, ay - y) > halfW + 6 ? <line x1={ax} y1={ay} x2={x} y2={y} stroke={MUTED} strokeWidth="0.8" /> : null}
            {g.label.length > 2 ? (
              <rect x={x - halfW} y={y - r} width={halfW * 2} height={r * 2} rx={r} fill={MARKER.fill} stroke={MARKER.text} strokeWidth={MARKER.ring} />
            ) : (
              <circle cx={x} cy={y} r={r} fill={MARKER.fill} stroke={MARKER.text} strokeWidth={MARKER.ring} />
            )}
            <text x={x} y={y + numSize * 0.36} textAnchor="middle" fontSize={numSize} fontWeight="600" fill={MARKER.text}>
              {g.label}
            </text>
          </g>
        ))}
      </g>
      {/* Scale bar */}
      <g aria-hidden="true">
        <path d={`M${barX} ${barY - 4}V${barY}H${barX + barPx}V${barY - 4}`} fill="none" stroke={MUTED} strokeWidth="1.5" />
        <text x={barX + barPx + 6} y={barY + 4} fontSize={smallSize} fill={MUTED} {...halo}>
          {barLabel}
        </text>
      </g>
      {noteText ? (
        <text x={12} y={12 + smallSize} fontSize={smallSize} fill={MUTED} {...halo} aria-hidden="true" className={paperNote ? "print:hidden" : undefined}>
          {noteText}
        </text>
      ) : null}
      {paperNote ? (
        <text x={12} y={12 + smallSize} fontSize={smallSize} fill={MUTED} {...halo} aria-hidden="true" className="hidden print:inline">
          {paperNote}
        </text>
      ) : null}
    </svg>
  );
}
