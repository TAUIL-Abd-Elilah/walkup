/**
 * The revise loop: an operator's note about a finished sheet becomes a new
 * sheet (new plan id) with the change applied and the differences listed.
 *
 *   1. readInstruction(): the model (or, without one, the fixed rules) turns
 *      the note into tool calls over a compact summary of the sheet. A
 *      question means no change and no run.
 *   2. runRevision(): the calls become operator overrides on the parent's own
 *      request, and planShow runs again on the same deps, so every request
 *      whose inputs did not change is served from the Qloo cache. The new
 *      sheet carries `revision` (parent, note, reader, tool calls, changes)
 *      and a "revise" step at the top of its step stream.
 */
import { randomUUID } from "node:crypto";
import { createMemoryLedger, type LedgerEntry, type LedgerSink, type OperatorInputs, type RevisionToolCall, type SheetRevision, type StreetSheet } from "@walkup/contracts";
import { cleanInstruction, describeReviseCall, readRevision, type ReviseCall, type ReviseSummary, type RevisionFallback } from "@walkup/narrator";
import { planShow } from "../plan";
import type { PlanDeps, PlanOptions, PlanRequest, PlanResult } from "../types";
import { overridesFor } from "./apply";
import { revisedRequest } from "./request";
import { reviseStep } from "./step";
import { reviseSummary } from "./summary";

export { overridesFor } from "./apply";
export { diffSheets } from "./diff";
export { parentRequest, pausePicks, revisedRequest, type ParentRequestInput } from "./request";
export { reviseStep, REVISE_STEP_ID, type ReviseStepInput } from "./step";
export { reviseSummary, sheetAreas } from "./summary";

/** How a note was read, before anything re-runs. */
export interface RevisionReading {
  parentPlanId: string;
  /** The note as used (trimmed, at most 300 characters). */
  instruction: string;
  interpreter: "model" | "rules";
  fallback: RevisionFallback | null;
  /** The calls that change the plan (merged). Empty when a question came back. */
  calls: ReviseCall[];
  /** Every call the reader made, with its one-line summary, for the sheet's record. */
  toolCalls: RevisionToolCall[];
  /** The operator fields the calls set, merged over the parent's. */
  overrides: Partial<OperatorInputs>;
  question: string | null;
  notes: string[];
  /** Model calls made while reading (copied into the revised sheet's ledger). */
  ledger: LedgerEntry[];
  summary: ReviseSummary;
}

/** Reads a note about `parent`. Never throws; uses deps.narrator (client and spend guard) when a model is set up. */
export async function readInstruction(parent: StreetSheet, instruction: string, deps: Pick<PlanDeps, "narrator">): Promise<RevisionReading> {
  const summary = reviseSummary(parent);
  const note = cleanInstruction(instruction);
  const ledger = createMemoryLedger();
  const read = await readRevision(summary, note, {
    client: deps.narrator?.client ?? null,
    ...(deps.narrator?.spend ? { spend: deps.narrator.spend } : {}),
    ledger,
  });
  const toolCalls: RevisionToolCall[] = read.made.map((c) => ({ tool: c.tool, input: c.input, summary: describeReviseCall(c, summary) }));
  return {
    parentPlanId: parent.planId,
    instruction: note,
    interpreter: read.interpreter,
    fallback: read.fallback,
    calls: read.calls,
    toolCalls,
    overrides: read.question ? {} : overridesFor(read.calls, parent.operator),
    question: read.question,
    notes: read.notes,
    ledger: ledger.entries(),
    summary,
  };
}

/** The revision record for a question: what was asked back, nothing changed. */
export function questionRevision(reading: RevisionReading): SheetRevision {
  return {
    parentPlanId: reading.parentPlanId,
    instruction: reading.instruction,
    interpreter: reading.interpreter,
    toolCalls: reading.toolCalls,
    changes: [],
    ...(reading.question ? { question: reading.question } : {}),
  };
}

export interface ReviseParent {
  sheet: StreetSheet;
  /** The request to re-run (see parentRequest). */
  request: PlanRequest;
}

/**
 * A ledger sink whose entries are dated on the revision's clock: the clients stamp requests with the real time,
 * and a revision of a parent planned at a fixed as-of date runs just after that parent. Without the shift the
 * sheet would say "Planned Oct 30" while its requests said Oct 14.
 */
function shiftedSink(sink: LedgerSink, offsetMs: number): LedgerSink {
  if (offsetMs === 0) return sink;
  return {
    add(entry) {
      const t = Date.parse(entry.startedAt);
      return sink.add(Number.isFinite(t) ? { ...entry, startedAt: new Date(t + offsetMs).toISOString() } : entry);
    },
    entries: () => sink.entries(),
  };
}

/** Copies the reading's model calls into the run's ledger sink; returns the sink and the ids they got there. */
function seedLedger(deps: PlanDeps, entries: readonly LedgerEntry[], offsetMs = 0): { sink: LedgerSink; refs: string[] } {
  const sink = shiftedSink(deps.ledger ? deps.ledger() : createMemoryLedger(), offsetMs);
  const refs: string[] = [];
  for (const e of entries) {
    const { id: _old, ...rest } = e;
    refs.push(sink.add({ ...rest, note: `node revise; ${rest.note ?? ""}`.replace(/; $/, "") }));
  }
  return { sink, refs };
}

/**
 * The clock a revision runs on. A parent planned at a fixed as-of date (a
 * preset, or any request that carries `asOf`) keeps that clock: the revision
 * is dated just after its parent (the parent's createdAt plus the time the
 * revision takes), so both count the days to the show from the same day. A
 * parent planned on the live clock (no `asOf`) is revised on the live clock.
 */
export function revisionClock(parent: ReviseParent, now: () => number = Date.now): () => number {
  const parentMs = Date.parse(parent.sheet.createdAt);
  if (!parent.request.asOf || !Number.isFinite(parentMs)) return now;
  const start = now();
  return () => parentMs + Math.max(0, now() - start);
}

/**
 * Re-runs the parent's request with the reading's overrides (new plan id, the
 * same deps so the cache answers unchanged requests, the parent's as-of clock).
 * The reading must have calls and no question.
 */
export async function runRevision(parent: ReviseParent, reading: RevisionReading, deps: PlanDeps, opts: PlanOptions & { planId?: string } = {}): Promise<PlanResult> {
  const { planId: wanted, ...planOpts } = opts;
  const planId = wanted ?? (deps.idGen ?? (() => randomUUID()))();
  const realNow = deps.clock ?? (() => Date.now());
  const clock = revisionClock(parent, realNow);
  // How far the revision's clock sits from the clients' clock (0 on the live clock).
  const offsetMs = clock() - realNow();
  const { sink, refs } = seedLedger(deps, reading.ledger, Math.abs(offsetMs) < 1000 ? 0 : offsetMs);
  const step = reviseStep({ instruction: reading.instruction, interpreter: reading.interpreter, fallback: reading.fallback, calls: reading.calls, ledgerRefs: refs });
  const request = revisedRequest(parent.request, reading.overrides, planId);
  // A revision never stands in for a stored preset sheet when the quota guard trips.
  return planShow(request, { ...deps, clock, ledger: () => sink }, {
    ...planOpts,
    serveFromStoreWhenGuarded: false,
    revise: { parent: parent.sheet, instruction: reading.instruction, interpreter: reading.interpreter, toolCalls: reading.toolCalls, step, settingRefs: refs },
  });
}

export type ReviseResult =
  | { status: "question"; reading: RevisionReading; revision: SheetRevision }
  | { status: "complete" | "needs_input" | "error"; reading: RevisionReading; result: PlanResult };

/** Both steps: read the note, then re-run unless a question came back. */
export async function revisePlan(parent: ReviseParent, instruction: string, deps: PlanDeps, opts: PlanOptions & { planId?: string } = {}): Promise<ReviseResult> {
  const reading = await readInstruction(parent.sheet, instruction, deps);
  if (reading.question || reading.calls.length === 0) return { status: "question", reading, revision: questionRevision(reading) };
  const result = await runRevision(parent, reading, deps, opts);
  return { status: result.status, reading, result };
}
