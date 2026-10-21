/**
 * A sheet as the pages and the PDF show it: the narration's lines checked again at view time (a direction the map
 * doesn't back, "expected", "most concentrated", a partner line citing a tag that partner doesn't share), each
 * failing line swapped for the fixed template's line; fan copy lines that name the act and carry no
 * audience-describing tag; and "How this crowd differs" without repeats or audience tags. The checks are
 * @walkup/narrator's, the same ones a new run goes through. The stored sheet, sheet.json and the API stay as recorded.
 */
import type { StreetSheet } from "@walkup/contracts";
import { vetCopyHooks, vetNarration, vetWhatsDifferent } from "@walkup/narrator/vet";

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
  const cards = sheet.cards;
  const diff = cards.whatsDifferent.results;
  let hooks = cards.copyHooks.results;
  try {
    hooks = vetCopyHooks(sheet);
  } catch {
    hooks = cards.copyHooks.results;
  }
  return {
    sheet: {
      ...sheet,
      ...(narration ? { narration } : {}),
      cards: {
        ...cards,
        copyHooks: { ...cards.copyHooks, results: hooks, summary: hookSummary(cards.copyHooks.summary, cards.copyHooks.results.length, hooks.length) },
        whatsDifferent: {
          ...cards.whatsDifferent,
          results: { ...diff, a: vetWhatsDifferent(diff.a), b: vetWhatsDifferent(diff.b), shared: vetWhatsDifferent(diff.shared) },
        },
      },
    },
    replaced,
  };
}
