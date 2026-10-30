/**
 * A sheet as the pages and the PDF show it: the narration's lines checked again at view time (a direction the map
 * doesn't back, "expected", "most concentrated", a partner line citing a tag that partner doesn't share), each
 * failing line swapped for the fixed template's line; fan copy lines that name the act and carry no
 * audience-describing tag; "How this crowd differs" without repeats or audience tags; the "Where buyers live"
 * limit said of the map this sheet has (`buyersLimit`); the popularity check said of where it searched
 * (`nearVenueLine`); and, with no lift map, the partner card's reason and the summary said as that rather than "no
 * area stood out".
 * The checks are @walkup/narrator's, the same ones a new run goes through. The stored sheet, sheet.json and the API
 * stay as recorded.
 */
import { buyersLimit, type StreetSheet } from "@walkup/contracts";
import { diffSummary, vetCopyHooks, vetNarration, vetWhatsDifferent } from "@walkup/narrator/vet";

/** The "How this crowd differs" summary counted from the checked lists; MCP's bill_vs_house uses the same one. */
export { diffSummary } from "@walkup/narrator/vet";

export interface VettedSheet {
  sheet: StreetSheet;
  /** One note per narration line replaced at view time ("tileWhy[1]: direction claim not backed by the map"). */
  replaced: string[];
}

/** "3 lines, each built ..." keeps its count true when lines were dropped. */
function hookSummary(summary: string, before: number, after: number): string {
  if (before === after) return summary;
  const n = `${after} ${after === 1 ? "line" : "lines"}`;
  return /^\d+ lines?\b/.test(summary) ? summary.replace(/^\d+ lines?\b/, n) : `${n}. ${summary}`;
}

/** No lift map on this run: nothing to compare with, or no areas. */
function noLift(sheet: Pick<StreetSheet, "cards">): boolean {
  const lift = sheet.cards.liftMap.results;
  return lift.diagnostics?.baseline === "none" || lift.tiles.length === 0;
}

/** The partner card's reason when no area was searched, as runs store it, and as said on a sheet with no lift map. */
const NO_AREA_PARTNERS = "No area stood out, so partners are picked near the venue.";
export const NO_LIFT_PARTNERS = "There is no lift map on this run, so partners are picked near the venue.";
/**
 * The template summary's sentence when no area was narrated, as runs stored it on a sheet with no lift map before
 * the orchestrator said "There is no lift map" there too.
 */
const NO_AREA_SUMMARY = "No area stands out on this run, so partners are picked near the venue.";

/** The "Where buyers live" limit said of the map this sheet has; a new run stores it the same way. */
export { buyersLimit, NO_LIFT_BUYERS_LIMIT } from "@walkup/contracts";

/** True when every partner was picked near the venue: no area was searched (no lift map, or no area held places). */
export function nearVenueOnly(sheet: Pick<StreetSheet, "cards">): boolean {
  const p = sheet.cards.partners.results;
  return p.length > 0 && p.every((x) => !x.tileGeohash);
}

/** The popularity check's method as runs store it, and as said when the only list was the one near the venue. */
const POPULARITY_HOW: [string, string][] = [
  ["runs the same Qloo search in each area without the bill", "runs the same Qloo search near the venue without the bill"],
  [
    "The same search in each area without the bill as the signal returns places in popularity order; each area's list is cut to as many places as it has partners.",
    "The same search near the venue without the bill as the signal returns places in popularity order; the list is cut to as many places as there are partners.",
  ],
];

/**
 * The partner card's popularity limit and the popularity step say the check searched "in each area". On a sheet whose
 * partners were all picked near the venue there are no areas, so they say it searched near the venue. Any other line is
 * kept.
 */
export function nearVenueLine(line: string): string {
  return POPULARITY_HOW.reduce((l, [area, venue]) => l.replace(area, venue), line);
}

export function vettedSheet(sheet: StreetSheet): VettedSheet {
  let replaced: string[] = [];
  let narration = sheet.narration;
  try {
    const v = vetNarration(sheet);
    narration = v.narration;
    replaced = v.replaced;
  } catch {
    // A sheet the checks can't read is shown as stored.
  }
  // With no lift map, the template summary's "No area stands out" says the same never-run comparison.
  if (narration && noLift(sheet) && narration.summary.includes(NO_AREA_SUMMARY)) {
    narration = { ...narration, summary: narration.summary.replace(NO_AREA_SUMMARY, NO_LIFT_PARTNERS) };
  }
  const cards = sheet.cards;
  const stored = cards.whatsDifferent.results;
  const diff = { ...stored, a: vetWhatsDifferent(stored.a), b: vetWhatsDifferent(stored.b), shared: vetWhatsDifferent(stored.shared) };
  let hooks = cards.copyHooks.results;
  try {
    hooks = vetCopyHooks(sheet);
  } catch {
    hooks = cards.copyHooks.results;
  }
  const venueOnly = nearVenueOnly(sheet);
  // With no lift map, "no area stood out" names a comparison the run never made: the reason is that there is no map.
  const partnersReason = cards.partners.reason && noLift(sheet) ? cards.partners.reason.replace(NO_AREA_PARTNERS, NO_LIFT_PARTNERS) : cards.partners.reason;
  return {
    sheet: {
      ...sheet,
      ...(narration ? { narration } : {}),
      limits: (sheet.limits ?? []).map((l) => buyersLimit(l, sheet)),
      ...(venueOnly && sheet.steps ? { steps: sheet.steps.map((s) => (s.id === "partners-popular" && s.cause ? { ...s, cause: nearVenueLine(s.cause) } : s)) } : {}),
      cards: {
        ...cards,
        partners: {
          ...cards.partners,
          ...(partnersReason ? { reason: partnersReason } : {}),
          limits: venueOnly ? cards.partners.limits.map(nearVenueLine) : cards.partners.limits,
        },
        copyHooks: { ...cards.copyHooks, results: hooks, summary: hookSummary(cards.copyHooks.summary, cards.copyHooks.results.length, hooks.length) },
        // The summary's counts follow the tags shown, not the lists before they were checked.
        whatsDifferent: { ...cards.whatsDifferent, results: diff, summary: diffSummary(cards.whatsDifferent.summary, diff) },
      },
    },
    replaced,
  };
}
