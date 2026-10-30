"use client";
import { useMemo } from "react";
import type { StreetSheet } from "@walkup/contracts";
import { LiftLegend } from "../LiftLegend";
import { LiftMap, squareSizeLine } from "../LiftMap";
import { TileList } from "../TileList";
import { formatPct, formatUsd } from "../../lib/format";
import { allTiles, areaName, baselineName, crowdBaseline, liftWeak, plainText, spreadSentence, tileWhy, topTiles } from "../../lib/sheet-utils";
import { PlanCard } from "./PlanCard";
import { Refs } from "./receipts";

const rho = (v: number | null): string => (v === null ? "not enough areas to check" : v.toFixed(2));

/** The lift card's own definition of lift, said once in the hint; the run's limits line repeats it, so it is dropped there. */
const LIFT_DEFINITION = /^Lift compares percentile ranks/;

/** Said instead of the trust checks when the run built no lift map (no usual crowd, or no areas). */
export const NO_LIFT_TRUST = "No lift map on this run, so there is nothing to check.";

/** True when the split-half check had no second half (the run's note says so, as the sheet model reads it). */
export function oneActSplit(note: string | undefined): boolean {
  return /\bone act\b/.test(note ?? "");
}

/** True when the run built no lift map: nothing to compare with, or no areas at all. */
export function noLiftMap(sheet: StreetSheet): boolean {
  return sheet.cards.liftMap.results.diagnostics.baseline === "none" || sheet.cards.liftMap.results.tiles.length === 0;
}

/**
 * How far to trust the map, in one sentence: "The map holds up when the bill is split in two (0.71) and isn't just
 * where people go anyway."
 */
export function trustSentence(split: number | null | undefined, weak: boolean, oneAct = false): string {
  const anyway = weak ? "but it mostly follows where people go anyway" : "and isn't just where people go anyway";
  // On a one-act bill the run's note, printed right under this sentence, already says there was no second half.
  if (split === undefined || (split === null && oneAct)) return weak ? "The map mostly follows where people go anyway." : "The map isn't just where people go anyway.";
  if (split === null) {
    // The check also comes back empty when a half's heatmap fails.
    return `The map couldn't be checked by splitting the bill in two this time; it ${weak ? "mostly follows" : "isn't just"} where people go anyway.`;
  }
  if (split > 0.5) return `The map holds up when the bill is split in two (${split.toFixed(2)}) ${anyway}.`;
  return `The two halves of the bill point to different areas (${split.toFixed(2)}), so treat the map as rough, ${weak ? "and it mostly follows where people go anyway" : "though it isn't just where people go anyway"}.`;
}

/** The trust checks in full, for "More about this crowd" (the lift card says them in one sentence). */
export function TrustTable({ sheet }: { sheet: StreetSheet }) {
  const env = sheet.cards.liftMap;
  const diag = env.results.diagnostics;
  const extra = env.results.liftDiagnostics;
  const weak = liftWeak(sheet);
  const against = baselineName(sheet);
  const overlap = extra ? extra.liftVsHeatSpearman : diag.spearmanLiftVsHeat;
  const noLift = noLiftMap(sheet);
  return (
    <table className="table mt-2">
      <tbody>
        <tr>
          <th scope="row" className="font-normal">
            Compared with
          </th>
          <td>
            {diag.baseline === "house"
              ? "The room's own upcoming shows"
              : diag.baseline === "none"
                ? "Nothing: too few of the room's headliners matched Qloo and no genre-wide map stands in"
                : // The genre stood in either because the room's own heatmap failed or because too few headliners matched.
                  `${against.charAt(0).toUpperCase()}${against.slice(1)}: ${crowdBaseline(sheet) === "house" ? "the room's own crowd couldn't be mapped" : "too few of the room's headliners matched Qloo"}`}
          </td>
        </tr>
        {extra ? (
          <tr>
            <th scope="row" className="font-normal">
              Split-half agreement
            </th>
            <td className="tabular">
              {extra.splitHalfSpearman === null ? (oneActSplit(extra.note) ? "Too few acts to split in two" : "No result this time") : extra.splitHalfSpearman.toFixed(2)}
              {/* With no number, say what the check does, not that it was done. */}
              <span className="block text-sm text-muted">
                {extra.splitHalfSpearman === null ? "The check splits the bill in two and maps each half apart." : "The bill split in two halves and mapped apart."} Near 1
                means the map holds up.
              </span>
            </td>
          </tr>
        ) : null}
        <tr>
          <th scope="row" className="font-normal">
            Overlap with general popularity
          </th>
          <td className="tabular">
            {/* With no lift map there are no areas to count, so the reason is the map, not too few areas. */}
            {noLift ? "No lift map, so nothing to check" : rho(overlap)}
            {/* With no number there is nothing to read as high or low. */}
            {overlap === null || noLift ? null : (
              <span className="block text-sm text-muted">
                {weak ? "High: the map mostly shows where people go anyway." : "Near 0 or below: the map isn't just where people go anyway."}
              </span>
            )}
          </td>
        </tr>
        {extra ? (
          <tr>
            <th scope="row" className="font-normal">
              Method
            </th>
            <td>{extra.method}</td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

/** The lift map, its numbered areas, how far to trust it (one sentence), and the heuristic budget split. */
export function LiftCard({ sheet, selected, onSelect }: { sheet: StreetSheet; selected: string | null; onSelect: (geohash: string | null) => void }) {
  const env = sheet.cards.liftMap;
  // Stable across re-renders (drawer, compare toggle, tile selection) so the map is not rebuilt.
  const top = useMemo(() => topTiles(sheet), [sheet]);
  const tiles = useMemo(() => allTiles(sheet), [sheet]);
  const ranked = useMemo(() => top.map((t) => t.geohash), [top]);
  const extra = env.results.liftDiagnostics;
  const weak = liftWeak(sheet);
  const split = sheet.budgetSplit ?? [];
  const budget = sheet.operator.mediaBudgetUsd;
  const toggle = (gh: string) => onSelect(selected === gh ? null : gh);
  const against = baselineName(sheet);
  // One takeaway after the list, from the same numbered areas: how far out and which way.
  const spread = spreadSentence(top, { lat: sheet.bill.venue.lat, lon: sheet.bill.venue.lon });
  const square = squareSizeLine(tiles);
  const listId = `lift-${sheet.planId}-areas`;
  // No lift map on this run (nothing to compare with, or no areas): no legend, no lift hint, no trust sentence.
  const noLift = noLiftMap(sheet);
  // The budget rows use the same numbers and names as the map and the area list.
  const area = (gh: string) => {
    const i = top.findIndex((t) => t.geohash === gh);
    return { number: i >= 0 ? i + 1 : null, name: i >= 0 ? areaName(top[i]) : areaName(tiles.find((t) => t.geohash === gh)) };
  };

  return (
    // With no usual crowd there is nothing to name after "compared with" (the sheet model's heading, for /s and the PDF).
    <PlanCard
      id="lift"
      title={env.results.diagnostics.baseline === "none" ? "Where this crowd stands out" : `Where this crowd stands out, compared with ${against}`}
      envelope={{ ...env, limits: env.limits.filter((l) => !LIFT_DEFINITION.test(l)) }}
      wide
    >
      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* Under 1024px the numbered list comes first and the map draws the same rows under it. */}
        <div className="min-w-0 max-lg:order-2">
          {noLift ? null : <LiftLegend className="mb-2" caption={`Fans compared with ${against}`} />}
          <LiftMap
            tiles={tiles}
            venue={{ lat: sheet.bill.venue.lat, lon: sheet.bill.venue.lon, name: sheet.bill.venue.name }}
            ranked={ranked}
            selected={selected}
            onSelect={toggle}
            idBase={`lift-${sheet.planId}`}
            title={noLift ? `The area around ${sheet.bill.venue.name}` : `Areas around ${sheet.bill.venue.name} by lift`}
            listId={listId}
            noLift={noLift}
            {...(square ? { captionLead: `${square} Walkup shows where this crowd stands out, never where one fan lives.` } : {})}
            source={
              <>
                {sheet.mode === "fixture" ? "Data: sample data in Qloo's format" : "Data: Qloo"}
                <Refs ids={env.provenance} />.
              </>
            }
          />
        </div>
        <div className="min-w-0 max-lg:order-1">
          {noLift ? (
            <p className="text-muted">With no lift map on this run, no area is numbered.</p>
          ) : (
            <>
              {/* No heading over an empty list: the list's own line says why nothing is numbered. */}
              {top.length > 0 ? <h3 className="mb-2 text-base">{top.length === 1 ? "Top area" : `Top ${top.length} areas`}</h3> : null}
              <TileList id={listId} tiles={top} selected={selected} onSelect={toggle} why={(gh) => tileWhy(sheet, gh)} />
              {spread ? <p className="mt-3">{spread}</p> : null}
              <p className="hint mt-3">
                Lift compares where this bill&apos;s crowd ranks each area with where {against} {against.endsWith("crowd") ? "ranks" : "rank"} it; it
                isn&apos;t a count of people. Above 1.0, this crowd ranks the area higher.
                {/* Paper has no area to select. */}
                {top.length > 0 ? <span className="no-print"> Select an area to find it on the map.</span> : null}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="mt-8 grid gap-x-8 gap-y-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="text-base">How far to trust this map</h3>
          <p className="mt-1">{noLift ? NO_LIFT_TRUST : trustSentence(extra ? extra.splitHalfSpearman : undefined, weak, oneActSplit(extra?.note))}</p>
          {extra?.note ? <p className="mt-2 text-base">{plainText(extra.note)}</p> : null}
          <p className="hint mt-1">
            <a href="#different" className="underline underline-offset-2 hover:text-ink">
              More about this crowd
            </a>{" "}
            {/* Promise only what that section has: with nothing to compare with, why (its "Compared with" row); with a
                baseline but no areas, only what the map was compared with; without the map's diagnostics, no Method row. */}
            {env.results.diagnostics.baseline === "none"
              ? "says why there is no lift map."
              : noLift
                ? "says what the map was compared with."
                : extra
                  ? "has the checks in full and the method."
                  : "has the checks in full."}
          </p>
        </div>

        {split.length > 0 ? (
          <div className="min-w-0">
            <h3 className="text-base">Budget split</h3>
            <p className="hint mt-0.5">
              A rule of thumb from lift and adult counts, not a forecast.{budget !== null ? ` The ${formatUsd(budget)} is an assumed budget.` : ""}
            </p>
            <table className="table mt-2">
              <thead>
                <tr>
                  <th scope="col">Area</th>
                  <th scope="col" className="num">
                    Share
                  </th>
                  {budget !== null ? (
                    <th scope="col" className="num">
                      Of {formatUsd(budget)}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {split.map((s) => {
                  const a = area(s.geohash);
                  return (
                  <tr key={s.geohash}>
                    <td>
                      <span className="inline-flex items-start gap-1.5">
                        {a.number ? (
                          <span className="marker mt-0.5" aria-hidden="true">
                            {a.number}
                          </span>
                        ) : null}
                        <span>
                          {a.number ? <span className="sr-only">Area {a.number}: </span> : null}
                          {a.name}
                        </span>
                      </span>
                    </td>
                    {/* One decimal, as the narration quotes shares: the column then adds up to 100%. */}
                    <td className="num">{formatPct(s.share, 1)}</td>
                    {budget !== null ? <td className="num">{formatUsd(budget * s.share)}</td> : null}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </PlanCard>
  );
}
