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

/**
 * "21 tags rank higher for this bill, 14 for the room's usual crowd, and 9 rank high for both." counted again from
 * the lists shown under it: each lean column without the tags listed under "Both rank high" (as DifferentCard shows
 * them). A summary in other words ("There is no usual crowd to compare this bill with.") is kept as it is.
 */
export function diffSummary(summary: string, r: { a: { id: string }[]; b: { id: string }[]; shared: { id: string }[] }): string {
  const m = /^[\d,]+ tags? ranks? higher for this bill, [\d,]+ for (.+), and [\d,]+ ranks? high for both\.$/.exec(summary ?? "");
  if (!m) return summary;
  const both = new Set(r.shared.map((t) => t.id));
  const a = r.a.filter((t) => !both.has(t.id)).length;
  const b = r.b.filter((t) => !both.has(t.id)).length;
  const s = r.shared.length;
  const verb = (n: number) => (n === 1 ? "ranks" : "rank");
  return `${a} ${a === 1 ? "tag" : "tags"} ${verb(a)} higher for this bill, ${b} for ${m[1]}, and ${s} ${verb(s)} high for both.`;
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
  const stored = cards.whatsDifferent.results;
  const diff = { ...stored, a: vetWhatsDifferent(stored.a), b: vetWhatsDifferent(stored.b), shared: vetWhatsDifferent(stored.shared) };
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
        // The summary's counts follow the tags shown, not the lists before they were checked.
        whatsDifferent: { ...cards.whatsDifferent, results: diff, summary: diffSummary(cards.whatsDifferent.summary, diff) },
      },
    },
    replaced,
  };
}
