/**
 * Live-mode tests run the fixture world in place of the live transports, so a
 * preset's live show must be one of the world's events. These helpers give
 * every preset a live block that points at its own fixture show (same event,
 * date and inputs) while a suite runs, and put the real blocks back after.
 */
import { PRESETS, type LivePreset, type Preset } from "@walkup/orchestrator";

function worldLive(p: Preset): LivePreset {
  return {
    tmEventId: p.tmEventId,
    tmVenueId: p.venue.tmVenueId,
    asOf: p.asOf,
    title: p.title,
    venue: { name: p.venue.name, city: p.venue.city, state: p.venue.state },
    selection: p.selection,
    operator: p.operator,
    line: p.line,
  };
}

const saved = new Map<string, LivePreset | null>();

export function useWorldLiveShows(): void {
  for (const p of Object.values(PRESETS)) {
    if (!saved.has(p.id)) saved.set(p.id, p.live);
    p.live = worldLive(p);
  }
}

export function restoreLiveShows(): void {
  for (const p of Object.values(PRESETS)) if (saved.has(p.id)) p.live = saved.get(p.id) ?? null;
  saved.clear();
}
