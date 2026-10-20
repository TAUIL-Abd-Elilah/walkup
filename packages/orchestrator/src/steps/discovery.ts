/**
 * The sheet's discovery (`StreetSheet.discovery`): one area or partner picked
 * by the fixed rule in @walkup/engine `discovery.ts`, from the lift card and
 * the partner list this run already has. No Qloo calls, never the model.
 *
 * The area rule runs only on a map that passed its checks: the room's own
 * crowd as the baseline, a split-half check that ran and cleared the bar,
 * lift not following raw foot traffic, and a heatmap that was not thin.
 */
import type { Partner, SheetDiscovery } from "@walkup/contracts";
import { LIFT_DEFAULTS, pickDiscovery } from "@walkup/engine";
import type { RunContext } from "../context";
import { MIN_BILL_PCT, MIN_SPLIT_HALF, NARRATED_TILES, type HeatResult } from "./heat";
import type { PartnersResult } from "./partners";

/** True when the lift map may steer a discovery (see the module comment). */
export function liftTrusted(heat: HeatResult): boolean {
  const d = heat.liftDiagnostics;
  if (!d || heat.liftWeak || heat.thin) return false;
  return d.splitHalfSpearman !== null && d.splitHalfSpearman > MIN_SPLIT_HALF;
}

export function discoverFor(ctx: RunContext, heat: HeatResult, partners: PartnersResult, list: readonly Partner[] = partners.partners): SheetDiscovery | null {
  const entries = new Map(ctx.ledger.entries().map((e) => [e.id, e]));
  const twinOf = (p: Partner) => {
    const ref = p.chips[0]?.ledgerRef;
    return partners.pools.find((x) => x.ledgerRef === ref && x.tileGeohash === p.tileGeohash)?.house ?? null;
  };
  return pickDiscovery({
    tiles: heat.card.results.tiles,
    // The same 1-5 the map, the area list and the partner table use.
    numbered: heat.spread.slice(0, NARRATED_TILES),
    baseline: heat.card.results.diagnostics.baseline,
    liftTrusted: liftTrusted(heat),
    minLift: LIFT_DEFAULTS.minLift,
    billFloor: heat.liftDiagnostics?.billFloor ?? MIN_BILL_PCT,
    ledgerRefs: [heat.billRef, heat.houseRef].filter((r): r is string => !!r),
    partners: list,
    twinSize: (p) => {
      const twin = twinOf(p);
      if (!twin) return null;
      return entries.get(twin.ledgerRef)?.resultCount ?? twin.size;
    },
    partnerRefs: (p) => p.explain?.ledgerRefs ?? p.chips.map((c) => c.ledgerRef),
  });
}
