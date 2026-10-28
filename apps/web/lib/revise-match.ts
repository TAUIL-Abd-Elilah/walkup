/**
 * Ready-made changes (recorded mode): which stored revision of a sheet a note asks for.
 *
 * While live runs are paused, the revise box still reads the note the way live mode does (the model with strict
 * tools, or the fixed rules without a model key) and turns it into operator overrides. A stored revision of the
 * same parent answers it when its own tool calls give the same overrides after normalising: the same fields,
 * place types and areas compared as sets, days in the order given (partner hours are checked against the first),
 * repeats dropped, the radius to 0.1 km, and fields left as the parent already had them
 * dropped. Nothing else (the note's wording, who read it) has to match.
 *
 * Pure: no server or Next imports, so the precompute script (scripts/precompute-revisions.ts) checks its notes with
 * the same functions. Never import it from a client component (it loads the orchestrator).
 */
import { WEEKDAYS, type OperatorInputs, type SheetRevision, type StreetSheet, type Weekday } from "@walkup/contracts";
import { checkReviseCall, type ReviseCall } from "@walkup/narrator";
import { overridesFor, reviseSummary } from "@walkup/orchestrator";

/** The operator fields a revision can change, in a form two readings can be compared in. */
export interface NormalOverrides {
  allAges?: boolean;
  excludeCategories?: string[];
  excludeAreas?: string[];
  streetTeamDays?: Weekday[];
  radiusKm?: number;
}

const FIELDS = ["allAges", "excludeCategories", "excludeAreas", "streetTeamDays", "radiusKm"] as const;

function sortedSet(values: readonly string[], fold: (s: string) => string = (s) => s): string[] {
  return [...new Set(values.map((v) => fold(v.trim())).filter(Boolean))].sort();
}

function normalField(key: (typeof FIELDS)[number], value: unknown): NormalOverrides[typeof key] | undefined {
  switch (key) {
    case "allAges":
      return typeof value === "boolean" ? value : undefined;
    case "excludeCategories":
      return Array.isArray(value) ? sortedSet(value.filter((v): v is string => typeof v === "string"), (s) => s.toLowerCase()) : undefined;
    case "excludeAreas":
      // Area names and geohashes as the tools accept them; case and spacing aside.
      return Array.isArray(value) ? sortedSet(value.filter((v): v is string => typeof v === "string"), (s) => s.toLowerCase().replace(/\s+/g, " ")) : undefined;
    case "streetTeamDays":
      // Order kept: partner hours are checked against the first day, so Saturday-then-Thursday is another sheet.
      return Array.isArray(value) ? [...new Set(value.filter((d): d is Weekday => (WEEKDAYS as readonly unknown[]).includes(d)))] : undefined;
    case "radiusKm":
      return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : undefined;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The overrides as they differ from the parent: every field normalised, and a field set to what the parent already
 * had left out (so "within 40 km, only Saturday" on a 40 km sheet is the same change as "only Saturday").
 */
export function normaliseOverrides(overrides: Partial<OperatorInputs>, parent: Partial<OperatorInputs>): NormalOverrides {
  const out: NormalOverrides = {};
  for (const key of FIELDS) {
    if (!(key in overrides) || overrides[key] === undefined) continue;
    const value = normalField(key, overrides[key]);
    if (value === undefined) continue;
    const before = normalField(key, parent[key] ?? (key === "excludeCategories" || key === "excludeAreas" ? [] : key === "allAges" ? false : undefined));
    if (before !== undefined && sameValue(value, before)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** One stable string per set of normalised overrides ("" when nothing changes). */
export function overridesKey(n: NormalOverrides): string {
  const parts = FIELDS.filter((k) => n[k] !== undefined).map((k) => `${k}=${JSON.stringify(n[k])}`);
  return parts.join(";");
}

/** True when the normalised overrides change nothing on the parent. */
export function changesNothing(n: NormalOverrides): boolean {
  return overridesKey(n) === "";
}

/**
 * The tool calls a stored revision was made with, checked again against its parent (as a fresh reading's calls are),
 * or null when one of them no longer reads (a sheet edited by hand, an unknown tool). A question is no change.
 */
export function revisionCalls(revision: Pick<SheetRevision, "toolCalls" | "question">, parent: StreetSheet): ReviseCall[] | null {
  if (revision.question) return null;
  const summary = reviseSummary(parent);
  const calls: ReviseCall[] = [];
  for (const t of revision.toolCalls ?? []) {
    if (t.tool === "ask_operator") continue;
    const checked = checkReviseCall(t.tool, t.input, summary);
    if (!checked.ok) return null;
    calls.push(checked.call);
  }
  return calls.length > 0 ? calls : null;
}

/** The normalised overrides a stored revision of `parent` stands for, or null when they cannot be rebuilt. */
export function revisionOverrides(revision: Pick<SheetRevision, "toolCalls" | "question">, parent: StreetSheet): NormalOverrides | null {
  const calls = revisionCalls(revision, parent);
  if (!calls) return null;
  return normaliseOverrides(overridesFor(calls, parent.operator), parent.operator);
}

/** A stored revision as the matcher sees it. */
export interface StoredRevisionLike {
  planId: string;
  createdAt?: string;
  sheet?: StreetSheet;
}

/**
 * The stored revision of `parent` that the overrides ask for: same parent, a finished sheet whose own tool calls
 * normalise to the same overrides. Several: the newest (the store lists newest first). Null when none does, or when
 * the overrides change nothing.
 */
export function findReadyMade<T extends StoredRevisionLike>(parent: StreetSheet, overrides: Partial<OperatorInputs>, stored: readonly T[]): T | null {
  const wanted = overridesKey(normaliseOverrides(overrides, parent.operator));
  if (wanted === "") return null;
  for (const s of stored) {
    const rev = s.sheet?.revision;
    if (!s.sheet || !rev || rev.parentPlanId !== parent.planId || s.sheet.planId === parent.planId) continue;
    const have = revisionOverrides(rev, parent);
    if (have && overridesKey(have) === wanted) return s;
  }
  return null;
}
