/**
 * The three prewarmed presets shown on the landing page. Plan ids point at the
 * synthetic fixtures today and at cached live runs once keys exist. Every
 * preset bill is invented, and no preset carries a seats-left count.
 */
export interface Preset {
  id: string;
  /** Text on the preset chip. */
  chip: string;
  planId: string;
  /** A real, publicly listed show: counts are what-ifs and no sales data is shown. */
  realShow: boolean;
  /** Show name when the listing has one. */
  showName?: string;
  /** One plain line for the top of the plan; {seats_left}, if used, is the operator's what-if count. */
  line: string;
}

export const PRESETS: Preset[] = [
  {
    id: "truth",
    chip: "The Truth, Nashville",
    planId: "g1-a",
    realShow: false,
    line: "Same room, two crowds: two bills at The Truth, planned side by side.",
  },
  {
    id: "hampton",
    chip: "Hampton Coliseum, comedy night",
    planId: "g2",
    realShow: false,
    showName: "Peninsula Comedy Night",
    line: "One act's name matches more than one catalog entry, so Walkup asks you to pick before it plans.",
  },
  {
    id: "tacoma",
    chip: "Super Funny, Tacoma",
    planId: "g3",
    realShow: false,
    line: "A small club with thin signal: each fallback says why it was taken.",
  },
];

export function presetForPlan(planId: string): Preset | undefined {
  return PRESETS.find((p) => p.planId === planId) ?? (planId.startsWith("g1-") ? PRESETS[0] : undefined);
}

export function presetLine(p: Preset, seatsLeft: number | null): string | null {
  if (p.line.includes("{seats_left}")) {
    if (seatsLeft === null) return null;
    return p.line.replace("{seats_left}", seatsLeft.toLocaleString("en-US"));
  }
  return p.line;
}
