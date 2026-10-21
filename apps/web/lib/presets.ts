/**
 * The prewarmed presets as the plan pages show them: the line at the top
 * of the plan, the show name, and whether the show is real. Plan ids point at
 * the synthetic fixtures today and at cached live runs once keys exist. Every
 * fixture bill is invented. A live sheet of a preset's live show (set on key
 * day in @walkup/orchestrator) takes its line from that show instead. No
 * preset carries a seats-left count.
 */
import { presetById, presetShowOf } from "@walkup/orchestrator";

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
    // A live example only: no sample sheet is bundled for it (the fixture world has no copy of the room).
    id: "basement-east",
    chip: "The Basement East, Nashville",
    planId: "g4-a",
    realShow: true,
    line: "Same room, two crowds: two real bills at The Basement East, planned side by side.",
  },
  {
    id: "tacoma",
    chip: "Super Funny, Tacoma",
    planId: "g3",
    realShow: false,
    line: "A small club with thin signal: each fallback says why it was taken.",
  },
];

/**
 * The preset behind a plan id, for a sheet made in `mode` of `bill`. A live
 * sheet of the event the preset's live show names is a real show with that
 * show's line, and the fixture show name does not apply to it. Any other live
 * sheet (one recorded before the live show changed, or while there was none)
 * gets no preset line or show facts: it reads like any other live run.
 */
export function presetForPlan(planId: string, mode: "live" | "fixture" = "fixture", bill?: { tmEventId?: string }): Preset | undefined {
  const pairOf = planId.match(/^(g[14])-b$/)?.[1];
  const p = PRESETS.find((x) => x.planId === planId) ?? (pairOf ? PRESETS.find((x) => x.planId === `${pairOf}-a`) : undefined);
  if (!p || mode === "fixture") return p;
  const preset = presetById(planId);
  const show = preset ? presetShowOf(preset, "live", bill) : null;
  if (!show) return undefined;
  const { showName: _fixtureName, ...rest } = p;
  return { ...rest, realShow: show.realShow, line: show.line };
}

export function presetLine(p: Preset, seatsLeft: number | null): string | null {
  if (p.line.includes("{seats_left}")) {
    if (seatsLeft === null) return null;
    return p.line.replace("{seats_left}", seatsLeft.toLocaleString("en-US"));
  }
  return p.line;
}
