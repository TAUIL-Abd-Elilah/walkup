/**
 * "Change something" while live runs are paused (recorded mode).
 *
 * The note is read exactly as in live mode: the model with the strict revise tools when a model key is set, the
 * fixed rules otherwise (the hosted copy has no key, so the rules read it there). The reading becomes operator
 * overrides, and a revision of the same sheet recorded from a live run answers it when its own tool calls give the
 * same overrides (lib/revise-match.ts). Nothing is sent to Qloo or Ticketmaster and nothing new is stored:
 *
 *   200 {status: "recorded", planId: <the stored revision>, recorded: {instruction, recordedAt}, revision}
 *   200 {status: "not_recorded", reason, readyMade}: the change needs new Qloo requests; the ready-made changes
 *   200 {status: "unchanged", reason}: the sheet already is that way
 *   200 {status: "needs_input", question}: the note was unclear (as in live mode)
 *   503 recordedRefusal(): the sheet has no ready-made change, or WALKUP_RECORDED_REVISE=off
 *
 * Server-only.
 */
import { join } from "node:path";
import type { SheetRevision, StreetSheet } from "@walkup/contracts";
import { createFileSpendStore, createNarratorClient, SpendGuard } from "@walkup/narrator";
import { readInstruction, type PlanDeps, type RevisionReading, type StoredPlan } from "@walkup/orchestrator";
import { changesNothing, findReadyMade, normaliseOverrides } from "../revise-match";
import { runtimeMode } from "../mode";
import { stores } from "./engine";
import { dataDir } from "./env";
import type { RequestContext } from "./http";
import { reviseAllowed } from "./limits";
import { readyMadeActive, REVISION_LOOKBACK } from "./recorded";
import { loadPlan, recordedRefusal, type ServiceResponse } from "./service";

export { readyMadeActive, RECORDED_REVISE_ENV, recordedReviseOn } from "./recorded";

/** One ready-made change of a sheet, as the box lists it. */
export interface ReadyMadeChange {
  planId: string;
  /** The note it was made for. */
  instruction: string;
  /** When the revision was recorded (ISO). */
  createdAt: string;
}

export const NOT_RECORDED_REASON =
  "That change wasn't recorded ahead, and making it now would need new Qloo requests. Live runs are paused for judging, so it can't run here. The changes below were recorded ahead for this sheet.";

export const UNCHANGED_REASON = "That's how this sheet already is, so there's nothing to change.";

/** Who reads notes on this server: "model" when a model key is set, else "rules". */
export function recordedReader(env: NodeJS.ProcessEnv = process.env): "model" | "rules" {
  return recordedNarrator(env).client ? "model" : "rules";
}

type NarratorDeps = NonNullable<PlanDeps["narrator"]>;

const NARRATOR_KEY = "__walkupRecordedNarrator";

/** The narrator deps a recorded server reads notes with (no Qloo or Ticketmaster client is made). */
function recordedNarrator(env: NodeJS.ProcessEnv = process.env): NarratorDeps {
  const g = globalThis as Record<string, unknown>;
  let n = g[NARRATOR_KEY] as NarratorDeps | undefined;
  if (!n) {
    const client = createNarratorClient(env);
    n = client ? { client, spend: new SpendGuard({ store: createFileSpendStore(join(dataDir(env), "anthropic-spend.json")) }) } : { client: null };
    g[NARRATOR_KEY] = n;
  }
  return n;
}

/** Tests: forget the cached narrator deps (after changing the environment). */
export function resetRecordedReviseForTests(): void {
  delete (globalThis as Record<string, unknown>)[NARRATOR_KEY];
}

/**
 * The stored revisions of `parentPlanId` the box can open: complete live sheets whose revision names it as parent
 * and that read as a change (no question), oldest first, one per note.
 */
export async function readyMadeRevisions(parentPlanId: string): Promise<StoredPlan[]> {
  let runs: StoredPlan[];
  try {
    runs = await stores().plans.listComplete({ mode: "live" }, REVISION_LOOKBACK);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: StoredPlan[] = [];
  for (const r of [...runs].reverse()) {
    const rev = r.sheet?.revision;
    if (!r.sheet || !rev || rev.parentPlanId !== parentPlanId || r.sheet.planId === parentPlanId || rev.question) continue;
    const key = (rev.instruction ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function changeOf(p: StoredPlan): ReadyMadeChange {
  const sheet = p.sheet as StreetSheet;
  return { planId: sheet.planId, instruction: (sheet.revision?.instruction ?? "").trim(), createdAt: sheet.createdAt };
}

/** The ready-made changes of a plan (by plan or preset id), or none when the box should not show. */
export async function readyMadeChanges(id: string): Promise<ReadyMadeChange[]> {
  if (!readyMadeActive()) return [];
  const v = await loadPlan(id, { view: "api" });
  if (v?.kind !== "sheet" || v.sheet.mode !== "live" || v.sheet.revision) return [];
  return (await readyMadeRevisions(v.sheet.planId)).map(changeOf);
}

/** GET /api/plan/<id>/ready-made: what the recorded revise box shows. */
export async function readyMadeFor(id: string): Promise<ServiceResponse> {
  const on = readyMadeActive();
  const changes = on ? await readyMadeChanges(id) : [];
  return { status: 200, body: { mode: runtimeMode().kind, enabled: on && changes.length > 0, reader: recordedReader(), changes } };
}

function pending(reading: RevisionReading): SheetRevision {
  return {
    parentPlanId: reading.parentPlanId,
    instruction: reading.instruction,
    interpreter: reading.interpreter,
    toolCalls: reading.toolCalls,
    changes: [],
    ...(reading.question ? { question: reading.question } : {}),
  };
}

/** POST /api/plan/<id>/revise in recorded mode (the caller checked the mode and the switch). */
export async function reviseRecorded(id: string, instruction: string, ctx: RequestContext): Promise<ServiceResponse> {
  const v = await loadPlan(id, { view: "api", sessionId: ctx.sessionId });
  if (!v) return { status: 404, body: { reason: `No plan with id ${id}.` } };
  if (v.kind !== "sheet") return { status: 409, body: { mode: "recorded", reason: "This plan has no finished sheet to change." } };
  // A sample sheet, a revision itself, or a sheet nothing was made for: the plain recorded-mode refusal.
  if (v.sheet.mode !== "live" || v.sheet.revision) return recordedRefusal();
  const parent = v.sheet;
  const ready = await readyMadeRevisions(parent.planId);
  if (ready.length === 0) return recordedRefusal();

  const allowed = reviseAllowed(ctx.ip, "live");
  if (!allowed.ok) return { status: 429, body: { mode: "recorded", reason: `Changes are capped at ${allowed.limit} per network per hour; try again in ${allowed.retryAfterS} s.` } };

  const reading = await readInstruction(parent, instruction, { narrator: recordedNarrator() });
  const readyMade = ready.map(changeOf);
  const base = {
    parentPlanId: parent.planId,
    mode: "recorded" as const,
    results: null,
    revision: pending(reading),
    reader: reading.interpreter,
    readyMade,
  };
  if (reading.question || reading.calls.length === 0) {
    const question = reading.question ?? "What should change?";
    return { status: 200, body: { ...base, status: "needs_input", summary: question, question, planId: parent.planId, reason: "Nothing was changed. Say it another way, or pick one of the ready-made changes." } };
  }
  const match = findReadyMade(parent, reading.overrides, [...ready].reverse());
  if (match?.sheet) {
    const made = changeOf(match);
    return {
      status: 200,
      body: {
        ...base,
        status: "recorded",
        summary: `Opening the version recorded ahead for "${made.instruction}" (recorded ${made.createdAt.slice(0, 10)}). Nothing was sent to Qloo.`,
        planId: made.planId,
        planUrl: `${ctx.origin}/plan/${made.planId}`,
        sheetUrl: `${ctx.origin}/s/${made.planId}`,
        recorded: { instruction: made.instruction, recordedAt: made.createdAt },
      },
    };
  }
  if (changesNothing(normaliseOverrides(reading.overrides, parent.operator))) {
    return { status: 200, body: { ...base, status: "unchanged", summary: UNCHANGED_REASON, reason: UNCHANGED_REASON, planId: parent.planId } };
  }
  return { status: 200, body: { ...base, status: "not_recorded", summary: NOT_RECORDED_REASON, reason: NOT_RECORDED_REASON, planId: parent.planId } };
}
