/**
 * The "revise" step at the top of a revised sheet's step stream: what the
 * note was, who read it (the model or the fixed rules) and which tools that
 * reader chose. The changes themselves are listed in `sheet.revision.changes`.
 */
import type { TraceStep } from "@walkup/contracts";
import { countOf, joinAnd, traceStep } from "@walkup/engine";
import type { ReviseCall, RevisionFallback } from "@walkup/narrator";

export const REVISE_STEP_ID = "revise";

export interface ReviseStepInput {
  instruction: string;
  interpreter: "model" | "rules";
  fallback: RevisionFallback | null;
  calls: readonly ReviseCall[];
  ledgerRefs: readonly string[];
}

function quoted(note: string): string {
  const t = note.length > 80 ? `${note.slice(0, 79).trimEnd()}…` : note;
  return `"${t}"`;
}

function reader(i: ReviseStepInput): string {
  if (i.interpreter === "model") return "The model read it";
  switch (i.fallback) {
    case "refusal":
      return "The model declined, so fixed rules read it";
    case "api_error":
      return "The model call failed, so fixed rules read it";
    case "over_budget":
      return "The day's model budget is spent, so fixed rules read it";
    default:
      return "Fixed rules read it (no model is set up here)";
  }
}

export function reviseStep(i: ReviseStepInput): TraceStep {
  const words: Record<ReviseCall["tool"], string> = {
    set_all_ages: "the age setting",
    exclude_partner_categories: "the types of place to leave out",
    exclude_areas: "the areas to skip",
    set_street_team_days: "the street-team days",
    set_radius: "the search radius",
    ask_operator: "a question for you",
  };
  const what = [...new Set(i.calls.map((c) => words[c.tool] ?? "a setting"))];
  const decision = `Changed ${countOf(i.calls.length, "setting")} from your note ${quoted(i.instruction)}`;
  // How many requests came from the cache is only known after the run; the sheet's ledger shows it.
  const cause = `${reader(i)} and changed ${what.length > 0 ? joinAnd(what) : "nothing"}.`;
  return traceStep(REVISE_STEP_ID, "revise", "Your change", decision, "ok", i.ledgerRefs, cause);
}
