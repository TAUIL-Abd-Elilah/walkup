/**
 * POST /api/plan/<id>/revise: the operator's note about a finished sheet.
 *
 *   1. Validate the note and the plan (a finished sheet; a paused or running
 *      plan answers 409; a sheet from the other mode answers 409; nothing is
 *      revised in recorded mode: 503). Rate-limited
 *      per network (lib/server/limits.ts); in live mode a revision that re-runs
 *      also takes a fresh-run unit, refunded when no fresh Qloo call was made.
 *   2. The orchestrator reads the note: the model with strict tools when an
 *      Anthropic key is set, the fixed rules otherwise. A question comes back
 *      as 200 needs_input with nothing re-run.
 *   3. Otherwise a new run starts (new plan id) through the same run registry
 *      as any plan, so it streams cards and steps over SSE, is stored, and
 *      reuses the Qloo cache for every request whose inputs did not change.
 */
import { randomUUID } from "node:crypto";
import type { SheetRevision, StreetSheet } from "@walkup/contracts";
import { parentRequest, readInstruction, revisedRequest, runRevision, type PlanDeps, type PlanRequest, type RevisionReading } from "@walkup/orchestrator";
import { errorEnvelope, PLAN_ID_RE, pausedEnvelope, sheetEnvelope } from "../api";
import { runtimeMode } from "../mode";
import { depsFor, publishLiveQuota, sessionChoices, stores } from "./engine";
import type { RequestContext } from "./http";
import { parseReviseBody } from "./input";
import { freshRuns, reviseAllowed } from "./limits";
import { startRun, type RunState, type WebPlanRequest } from "./runs";
import { freshRunsBody, loadPlan, recordedRefusal, SYNC_WAIT_MS, type ServiceResponse, type SheetView } from "./service";
import { addPartnerHouseRanks } from "./twin";

/** The revision as it stands before the re-run: who read the note and which tools they chose. */
export function pendingRevision(reading: RevisionReading): SheetRevision {
  return {
    parentPlanId: reading.parentPlanId,
    instruction: reading.instruction,
    interpreter: reading.interpreter,
    toolCalls: reading.toolCalls,
    changes: [],
    ...(reading.question ? { question: reading.question } : {}),
  };
}

/** The request the parent was made with (stored runs) or rebuilt from its preset. */
async function parentRequestOf(v: SheetView): Promise<WebPlanRequest | null> {
  const stored = v.source === "preset" ? null : await stores().plans.get(v.planId);
  const request = parentRequest(v.sheet, { stored: stored?.request ?? null, presetId: v.presetId ?? null });
  if (!request) return null;
  const extras = (stored?.request ?? {}) as WebPlanRequest;
  return { ...request, ...(extras.proxyPicks ? { proxyPicks: extras.proxyPicks } : {}) };
}

function questionBody(v: SheetView, reading: RevisionReading, mode: "live" | "fixture") {
  const question = reading.question ?? "What should I change?";
  return {
    status: "needs_input" as const,
    summary: question,
    question,
    planId: v.planId,
    parentPlanId: v.planId,
    mode,
    results: null,
    revision: pendingRevision(reading),
    reason: "Nothing was changed. Answer with a clearer note, e.g. \"All ages: no bars\", \"skip <area>\", \"only Saturday\" or \"within 10 km\".",
    provenance: reading.ledger.map((e) => e.id),
  };
}

function runningBody(run: RunState, reading: RevisionReading, origin: string) {
  return {
    status: "running" as const,
    summary: "Revising. Cards and steps stream from streamUrl; the revised sheet opens at planUrl.",
    planId: run.planId,
    parentPlanId: reading.parentPlanId,
    mode: run.mode,
    planUrl: `${origin}/plan/${run.planId}`,
    streamUrl: `${origin}/api/plan/${run.planId}/stream`,
    sheetUrl: `${origin}/s/${run.planId}`,
    results: null,
    revision: pendingRevision(reading),
  };
}

function finishedBody(run: RunState, reading: RevisionReading, origin: string): unknown {
  if (run.status === "complete" && run.sheet) {
    const sheet: StreetSheet = run.sheet;
    return { ...sheetEnvelope(sheet, origin), parentPlanId: reading.parentPlanId, revision: sheet.revision ?? pendingRevision(reading) };
  }
  if (run.status === "needs_input" && run.resolution && run.pending) {
    return { ...pausedEnvelope({ planId: run.planId, mode: run.mode, resolution: run.resolution, pending: run.pending }, origin), parentPlanId: reading.parentPlanId };
  }
  return { ...errorEnvelope(run.planId, run.mode, run.error ?? "The revision stopped before a sheet was ready."), parentPlanId: reading.parentPlanId };
}

export async function revisePlanFor(id: string, raw: unknown, ctx: RequestContext): Promise<ServiceResponse> {
  if (!PLAN_ID_RE.test(id)) return { status: 400, body: { reason: "Plan ids match ^[A-Za-z0-9_-]{1,64}$." } };
  const parsed = parseReviseBody(raw);
  if (!parsed.ok) return { status: 400, body: { reason: parsed.reason } };
  const { instruction, wait } = parsed.value;
  const mode = runtimeMode().kind;
  if (mode === "recorded") return recordedRefusal();

  const v = await loadPlan(id, { view: "api", sessionId: ctx.sessionId });
  if (!v) return { status: 404, body: { reason: `No plan with id ${id}.` } };
  if (v.kind === "running") return { status: 409, body: { reason: "This plan is still running. Revise it once the sheet is ready." } };
  if (v.kind === "paused") return { status: 409, body: { reason: "This plan is waiting for a pick. Answer it first, then revise the sheet." } };
  if (v.kind === "error") return { status: 409, body: { reason: `This run stopped: ${v.error}` } };

  // Never mix modes: a live parent on a fixture server, or a sample parent (with sample ids) on a live server.
  if (v.sheet.mode !== mode) {
    return {
      status: 409,
      body: {
        reason: v.sheet.mode === "live" ? "This live sheet cannot be revised while the server is in fixture mode." : "This sample sheet cannot be revised while the server is live. Plan the show again instead.",
      },
    };
  }
  const allowed = reviseAllowed(ctx.ip, mode);
  if (!allowed.ok) return { status: 429, body: { mode, reason: `Revisions are capped at ${allowed.limit} per network per hour; try again in ${allowed.retryAfterS} s.` } };

  const base = depsFor(mode);
  if (mode === "live" && base.qloo.guardTripped()) {
    return { status: 429, body: { mode, reason: "Qloo's monthly quota is at its safety floor, so revisions are paused. Existing sheets stay open." } };
  }
  const parent = await parentRequestOf(v);
  if (!parent) return { status: 409, body: { reason: `Plan ${id} cannot be re-run: its request is no longer known.` } };
  const deps: PlanDeps = { ...base, choices: sessionChoices(stores().choices, ctx.sessionId) };

  const reading = await readInstruction(v.sheet, instruction, deps);
  if (reading.question || reading.calls.length === 0) return { status: 200, body: questionBody(v, reading, mode) };

  // A live revision re-runs most Qloo requests, so it counts as a fresh run (same caps as
  // POST /api/plan and MCP revise_plan), refunded when it made no fresh Qloo call.
  const counted = mode === "live" ? freshRuns().take(ctx.ip) : null;
  if (counted && !counted.allowed) return { status: 429, body: { mode, reason: counted.reason, freshRuns: freshRunsBody(counted) } };

  const planId = randomUUID();
  const { proxyPicks, ...plain } = parent;
  const request: WebPlanRequest = { ...revisedRequest(plain as PlanRequest, reading.overrides, planId), customInputs: true, ...(proxyPicks ? { proxyPicks } : {}) };
  const run = startRun({
    request,
    deps,
    mode,
    title: `${v.title} (revised)`,
    run: (opts) => runRevision({ sheet: v.sheet, request: plain as PlanRequest }, reading, deps, { ...opts, planId }),
    enrich: async (sheet) => (await addPartnerHouseRanks(sheet, deps.qloo, { fixture: mode === "fixture" })).sheet,
    onFinish: (finished) => {
      if (mode !== "live") return;
      publishLiveQuota(deps);
      if (counted && (finished.result?.budget.qlooFresh ?? 0) === 0) freshRuns().refund(ctx.ip, counted.day);
    },
  });

  if (wait === "none") return { status: 202, body: runningBody(run, reading, ctx.origin) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), SYNC_WAIT_MS);
  });
  const done = await Promise.race([run.done, timeout]);
  if (timer) clearTimeout(timer);
  if (!done) return { status: 202, body: runningBody(run, reading, ctx.origin) };
  return { status: done.status === "error" ? 422 : 200, body: finishedBody(done, reading, ctx.origin) };
}
