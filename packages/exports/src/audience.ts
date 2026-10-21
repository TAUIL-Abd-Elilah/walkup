/**
 * Which places may face fans: one rule for the plan page's "Show what fans see", the web street sheet, the
 * PDF and every fan-facing list, so they never disagree.
 *
 * On a show not known to be 21+ (Ticketmaster's age policy, made stricter by the operator's all-ages setting),
 * a place is operator-only when it is a bar by category or has a drinking word in its name ("Whiskey Charlie",
 * "21st Amendment Bar & Grill"). A spot the plan already marked `fanFacingAllowed: false` stays operator-only.
 * Operator-only places stay on the operator's sheet, marked "not for fans".
 */
import type { Bill, OperatorInputs, Partner, PrePostSpot, StreetSheet } from "@walkup/contracts";
import { findAlcoholTerm, isBarCategory } from "@walkup/engine";
import { isAllAgesForCopy } from "./format";

export interface FanFacingPlace {
  name: string;
  category?: string | null;
  /** The plan's own verdict on a spot; false always wins. */
  fanFacingAllowed?: boolean;
}

/** True when the place may appear in fan-facing text for this bill. */
export function isFanFacing(place: FanFacingPlace, bill: Pick<Bill, "legalAgeEnforced">, operator?: Pick<OperatorInputs, "allAges"> | null): boolean {
  if (place.fanFacingAllowed === false) return false;
  if (!isAllAgesForCopy(bill, operator)) return true;
  const barLike = place.category ? isBarCategory(place.category) : false;
  return !barLike && findAlcoholTerm(place.name) === null;
}

/** A before-and-after spot through the shared rule. */
export function spotIsFanFacing(spot: Pick<PrePostSpot, "entity" | "category" | "fanFacingAllowed">, sheet: Pick<StreetSheet, "bill" | "operator">): boolean {
  return isFanFacing({ name: spot.entity.name, category: spot.category ?? null, fanFacingAllowed: spot.fanFacingAllowed }, sheet.bill, sheet.operator);
}

/** A suggested partner through the shared rule. */
export function partnerIsFanFacing(p: Pick<Partner, "entity" | "category">, sheet: Pick<StreetSheet, "bill" | "operator">): boolean {
  return isFanFacing({ name: p.entity.name, category: p.category }, sheet.bill, sheet.operator);
}

/** The spots a fan-facing list shows, in the sheet's order. */
export function fanFacingSpots<T extends Pick<PrePostSpot, "entity" | "category" | "fanFacingAllowed">>(spots: readonly T[], sheet: Pick<StreetSheet, "bill" | "operator">): T[] {
  return spots.filter((s) => spotIsFanFacing(s, sheet));
}
