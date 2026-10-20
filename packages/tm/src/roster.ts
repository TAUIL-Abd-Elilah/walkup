import type { Act } from "@walkup/contracts";
import { actsOf } from "./bill";
import { daysBetween } from "./dates";
import type { TmEvent } from "./types";

/** Size of the house set: the room's top headliners by recency x frequency. */
export const HOUSE_SET_SIZE = 12;

export interface RosterHeadliner {
  act: Act; // role is always "headliner"
  /** tmAttractionId, or "name:<lowercased name>" when Discovery gave no id. */
  key: string;
  eventIds: string[];
  dates: string[]; // local dates of the counted events, ascending
  count: number; // frequency on the roster
  /** Sum of recency weights over the act's roster nights. */
  score: number;
  /** score / sum(score) over the returned set; sums to 1. */
  weight: number;
}

export interface RosterOptions {
  /** How many headliners to return. Default 12. */
  top?: number;
  /** Recency is measured from this local date. Default: earliest dated event in the list. */
  referenceDate?: string;
  /** A night `halfLifeDays` away from the reference counts half. Default 60. */
  halfLifeDays?: number;
  /** Leave out the bill being planned so it does not leak into its own baseline. */
  excludeEventIds?: string[];
  excludeAttractionIds?: string[];
  /** Skip parking passes, upgrades, gift cards and similar non-show listings. Default true. */
  skipAncillary?: boolean;
  /** Skip events whose status is canceled. Default true. */
  skipCanceled?: boolean;
}

const ANCILLARY =
  /\b(parking|upgrades?|vip (?:package|experience|lounge|upgrade)s?|suite rentals?|premium seating|gift cards?|vouchers?|season tickets?|memberships?|venue tours?|merch(?:andise)? bundles?)\b/i;

/** True for listings that are not shows (parking, upgrades, gift cards, ...). */
export function isAncillaryEvent(event: TmEvent): boolean {
  return ANCILLARY.test(event.name ?? "");
}

function isCanceled(event: TmEvent): boolean {
  const code = event.dates?.status?.code?.toLowerCase();
  return code === "canceled" || code === "cancelled";
}

/**
 * Unique headliners of a venue's upcoming roster, weighted by recency and frequency:
 * score = sum over the act's nights of 0.5 ^ (|days from reference| / halfLifeDays).
 * Undated nights take the smallest dated weight. Ties break by count, first date, name.
 */
export function rosterHeadliners(events: TmEvent[], opts: RosterOptions = {}): RosterHeadliner[] {
  const top = opts.top ?? HOUSE_SET_SIZE;
  const halfLife = opts.halfLifeDays ?? 60;
  if (!(halfLife > 0)) throw new RangeError("halfLifeDays must be > 0");
  const skipAncillary = opts.skipAncillary ?? true;
  const skipCanceled = opts.skipCanceled ?? true;
  const excludeEvents = new Set(opts.excludeEventIds ?? []);
  const excludeAttractions = new Set(opts.excludeAttractionIds ?? []);

  const kept = events.filter(
    (e) => !excludeEvents.has(e.id) && !(skipAncillary && isAncillaryEvent(e)) && !(skipCanceled && isCanceled(e)),
  );
  const dated = kept.map((e) => e.dates?.start?.localDate).filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const reference = opts.referenceDate ?? [...dated].sort()[0];
  const weightOf = (date: string | undefined): number | null =>
    date && reference && /^\d{4}-\d{2}-\d{2}$/.test(date) ? 0.5 ** (Math.abs(daysBetween(reference, date)) / halfLife) : null;
  const datedWeights = dated.map((d) => weightOf(d) as number);
  const undatedWeight = datedWeights.length > 0 ? Math.min(...datedWeights) : 1;

  const byKey = new Map<string, RosterHeadliner>();
  for (const e of kept) {
    const headliner = actsOf(e)[0];
    if (!headliner) continue;
    if (headliner.tmAttractionId && excludeAttractions.has(headliner.tmAttractionId)) continue;
    const key = headliner.tmAttractionId ?? `name:${headliner.name.toLowerCase().trim()}`;
    const date = e.dates?.start?.localDate;
    const w = weightOf(date) ?? undatedWeight;
    const row = byKey.get(key);
    if (!row) {
      const act: Act = { ...headliner, role: "headliner" };
      byKey.set(key, { act, key, eventIds: [e.id], dates: date ? [date] : [], count: 1, score: w, weight: 0 });
    } else {
      row.eventIds.push(e.id);
      if (date) row.dates.push(date);
      row.count += 1;
      row.score += w;
      if (!row.act.spotifyId && headliner.spotifyId) row.act.spotifyId = headliner.spotifyId;
    }
  }

  const ranked = [...byKey.values()]
    .map((r) => ({ ...r, dates: [...r.dates].sort() }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.count - a.count ||
        (a.dates[0] ?? "9999").localeCompare(b.dates[0] ?? "9999") ||
        a.act.name.localeCompare(b.act.name),
    )
    .slice(0, Math.max(0, top));
  const total = ranked.reduce((s, r) => s + r.score, 0);
  for (const r of ranked) r.weight = total > 0 ? r.score / total : 0;
  return ranked;
}
