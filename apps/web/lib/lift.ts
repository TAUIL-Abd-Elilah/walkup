/**
 * Lift colour scale shared by the WebGL map, the SVG map, the print sheet and the legend:
 * one hue (the accent red) at rising opacity. Top tiles (lift >= 1.3) run from 55% to 100%;
 * mild lift is a pale tint and under-index is barely there. The maps are light in both
 * themes, so the scale is fixed hex, not a CSS variable.
 */
export const TOP_LIFT = 1.3;

/** The accent ink the tiles are drawn in (same as --color-accent in light mode). */
export const LIFT_INK = "#b42318";

export type LiftBand = "top" | "mild" | "under";

export function liftBand(lift: number): LiftBand {
  if (lift >= TOP_LIFT) return "top";
  if (lift >= 1) return "mild";
  return "under";
}

/** Opacity of the accent for a tile with this lift. */
export function liftAlpha(lift: number): number {
  const band = liftBand(lift);
  if (band === "top") {
    const k = Math.max(0, Math.min(1, (lift - TOP_LIFT) / 0.9));
    return Math.round((0.55 + 0.45 * k) * 100) / 100;
  }
  if (band === "mild") return 0.22;
  return 0.08;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The accent at `alpha` over white, as an opaque colour (legend swatches, bars, small marks). */
export function liftColor(lift: number): string {
  const a = liftAlpha(lift);
  const ink = hexToRgb(LIFT_INK);
  const rgb = ink.map((c) => Math.round(255 + (c - 255) * a));
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Share (0-1) of the row width for the 2px rule under an area row: its lift divided by the highest lift in the
 * list, so the top area's rule runs full width (Felt's location rows).
 */
export function liftRuleShare(lift: number, topLift: number): number {
  if (!Number.isFinite(lift) || !Number.isFinite(topLift) || topLift <= 0) return 0;
  return Math.max(0, Math.min(1, lift / topLift));
}

export const LIFT_LEGEND: { label: string; band: LiftBand; sample: number }[] = [
  { label: "under 1.0x", band: "under", sample: 0.8 },
  { label: "1.0 to 1.3x", band: "mild", sample: 1.1 },
  { label: "1.3 to 2.2x", band: "top", sample: 1.6 },
  { label: "2.2x and up", band: "top", sample: 2.2 },
];
