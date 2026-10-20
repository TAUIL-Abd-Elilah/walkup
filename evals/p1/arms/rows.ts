/** Shared row and bar shapes for the arm modules and the output writers. */
import type { BarRow } from "./bars";
import type { ArmName, ClubKey } from "./protocol";
import type { ResolutionPath } from "./resolve";

/** A bar whose status is "analyzed". */
export interface AnalyzedBar {
  bar: BarRow;
  entityId: string;
  via: ResolutionPath;
  googlePlaceId: string | null;
}

/** One row of the arms CSV (ARMS.md §7). */
export interface ArmRow {
  club: ClubKey;
  metro: string;
  barKey: string;
  arm: ArmName;
  /** 1-based rank, or null when absent from the list. */
  rank: number | null;
  candidatesN: number;
  barClub: ClubKey;
  listingRole: string;
  resolutionVia: ResolutionPath;
  entityId: string;
}

export function rowFor(arm: ArmName, club: ClubKey, metro: string, a: AnalyzedBar, rank: number | null, candidatesN: number): ArmRow {
  return {
    club,
    metro,
    barKey: a.bar.barKey,
    arm,
    rank,
    candidatesN,
    barClub: a.bar.club,
    listingRole: a.bar.listingRole,
    resolutionVia: a.via,
    entityId: a.entityId,
  };
}

/** Per-arm counters for the run log and the public summary (aggregates only). */
export interface ArmStats {
  /** Calls (Q arms) or conversations (F, L) this run needed. */
  planned: number;
  /** Completed calls or conversations with an answer (including refusals). */
  completed: number;
  /** Calls or conversations that still failed after retries: no rows. */
  failed: number;
  refused: number;
  rows: number;
  queriesWithRows: number;
  notes: string[];
  extra: Record<string, number | string | boolean | null>;
}

export function emptyStats(): ArmStats {
  return { planned: 0, completed: 0, failed: 0, refused: 0, rows: 0, queriesWithRows: 0, notes: [], extra: {} };
}

/** analyze.py _primary_bar: official (or unmarked) listing first, then the smallest bar_key. */
export function primaryBar(bars: readonly AnalyzedBar[]): AnalyzedBar | null {
  const sorted = [...bars].sort((x, y) => {
    const rx = x.bar.listingRole === "" || x.bar.listingRole === "official" ? 0 : 1;
    const ry = y.bar.listingRole === "" || y.bar.listingRole === "official" ? 0 : 1;
    if (rx !== ry) return rx - ry;
    return x.bar.barKey < y.bar.barKey ? -1 : x.bar.barKey > y.bar.barKey ? 1 : 0;
  });
  return sorted[0] ?? null;
}
