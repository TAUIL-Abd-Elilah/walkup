"use client";
import { useState } from "react";
import type { LiftTile } from "@walkup/contracts";
import { formatInt, formatLift } from "../lib/format";
import { LIFT_INK, liftRuleShare } from "../lib/lift";

/** Rows shown before the rest fold behind "+ N more areas". */
export const AREA_ROWS_SHOWN = 5;

/**
 * Ranked, named lift tiles: the keyboard-accessible twin of the map. The numbers match the ones drawn on the map.
 * Each row has the lift right-aligned and a 2px rule under the name whose width is the row's lift over the top
 * lift in the list (the map's lift ink in both themes; the control grey under 1.0x). With `onSelect`, each row is a toggle button that
 * highlights its tile on the map; `data-geohash` lets a tap on the map bring the row into view (LiftMap `listId`).
 */
export function TileList({
  tiles,
  selected,
  onSelect,
  why,
  compact = false,
  id,
}: {
  tiles: LiftTile[];
  selected?: string | null;
  onSelect?: (geohash: string) => void;
  why?: (geohash: string) => string | undefined;
  compact?: boolean;
  /** Id of the list, for LiftMap's `listId`. */
  id?: string;
}) {
  // null until the reader uses the button: then their choice wins over the selection.
  const [open, setOpen] = useState<boolean | null>(null);
  if (tiles.length === 0) return <p className="text-muted">No area reached a lift of 1.3, so there is nothing to number.</p>;
  const topLift = Math.max(...tiles.map((t) => t.lift));
  // A row picked on the map is never hidden behind the fold.
  const selectedIndex = selected ? tiles.findIndex((t) => t.geohash === selected) : -1;
  const expanded = open ?? selectedIndex >= AREA_ROWS_SHOWN;
  const shown = expanded ? tiles : tiles.slice(0, AREA_ROWS_SHOWN);
  const hidden = tiles.length - AREA_ROWS_SHOWN;
  return (
    <>
      <ol id={id} className="border-t border-rule">
        {shown.map((t, i) => {
          const isSel = selected === t.geohash;
          const reason = !compact ? why?.(t.geohash) : undefined;
          const meta = !compact
            ? [t.zctas?.length ? `ZIP ${t.zctas.join(", ")}` : null, typeof t.adultPopulation === "number" ? `${formatInt(t.adultPopulation)} adults` : null]
                .filter(Boolean)
                .join(" · ")
            : "";
          const body = (
            <>
              <span className="marker mt-0.5" aria-hidden="true">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 font-semibold">{t.name ?? `Area ${i + 1}`}</span>
                  <span className="tabular shrink-0">
                    <span className="sr-only">lift </span>
                    {formatLift(t.lift)}
                  </span>
                </span>
                <span
                  aria-hidden="true"
                  className="area-rule"
                  data-under={t.lift < 1 ? "" : undefined}
                  // The map's own ink in both themes, so the rule matches the tile it describes.
                  style={{ width: `${Math.round(liftRuleShare(t.lift, topLift) * 1000) / 10}%`, ...(t.lift < 1 ? {} : { background: LIFT_INK }) }}
                />
                {meta ? <span className="mt-1 block text-sm text-muted">{meta}</span> : null}
                {reason ? <span className="mt-0.5 block text-sm">{reason}</span> : null}
              </span>
            </>
          );
          return (
            <li key={t.geohash} data-geohash={t.geohash} className="scroll-my-4 border-b border-rule">
              {onSelect ? (
                <button
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => onSelect(t.geohash)}
                  className={`flex w-full items-start gap-3 px-1 py-2 text-left hover:bg-subtle ${isSel ? "bg-subtle shadow-[inset_3px_0_0_var(--color-ink)]" : ""}`}
                >
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-3 px-1 py-2">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
      {hidden > 0 ? (
        <p className="mt-2 text-sm">
          <button type="button" className="text-button" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!expanded)}>
            {expanded ? "Show the top 5 only" : `+ ${hidden} more ${hidden === 1 ? "area" : "areas"}`}
          </button>
        </p>
      ) : null}
    </>
  );
}
