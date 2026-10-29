/**
 * The four tools as plain functions (services, caller, args) -> envelope, so
 * the MCP server and a host's REST routes can share them:
 *
 * - planShowTool:     a Street Sheet for a show (event text or link, preset, or a paused plan to resume)
 * - rankPartnersTool: the user's own partner list in call order for a bill
 * - billVsHouseTool:  where this bill's crowd differs from the room's usual crowd
 * - getSheetTool:     an existing plan's envelope
 * - revisePlanTool:   a finished sheet changed by the user's note (new plan id), or a question back
 *
 * Presets (and picks among the candidates a preset showed) are unlimited;
 * anything else that runs the planner is a fresh run and takes one unit from
 * the per-caller and daily caps. When the host serves recorded sheets only
 * (policy.recorded), the tools that only read stored sheets still answer (get_sheet,
 * bill_vs_house, plan_show for a preset or plan id); everything that would run
 * refuses with 503 (live runs are paused for judging), and revise_plan names any recorded revision of
 * the plan, saying whether it was made for the caller's note or a different one.
 */
import { createHash } from "node:crypto";
import { createMemoryLedger, type DeclaredPartnerScore, type EnvelopeStatus, type OperatorInputs, type Resolution, type StreetSheet } from "@walkup/contracts";
import {
  NO_LIVE_SHOW,
  parentRequest,
  planShow,
  presetById,
  presetFor,
  presetShowOf,
  questionRevision,
  readInstruction,
  runRevision,
  type PlanDeps,
  type PlanRequest,
  type PlanResult,
  type Preset,
  type PresetShow,
  type StoredPlan,
} from "@walkup/orchestrator";
import { baseLimits, cardStatuses, errorEnvelope, planUrlFor, sheetUrlFor, worstStatus, type PauseLike, type PendingPick, type PlanMode, type ToolEnvelope } from "./envelope";
import { lookupEvent } from "./event";
import { callerKey, type CapDecision } from "./limits";
import { inputProblem } from "./policy";
import { presetIdsFor, type PlanRefArgs, type PlanShowArgs, type RankPartnersArgs, type RevisePlanArgs } from "./schemas";
import type { McpServices } from "./services";
import { envelopeOfView, viewOfResult, viewOfStored, type PlanView } from "./views";

export interface Caller {
  /** The caller's address as the server saw it; limiters keep only a keyed hash. */
  ip: string;
  /** Public origin of the web app, for share links. Null when unknown. */
  origin: string | null;
  transport: "http" | "stdio" | "memory";
}

export interface ToolOutcome<T = unknown> {
  envelope: ToolEnvelope<T>;
  /** What a REST twin answers with: 200, 400 (bad input or policy), 404, 422 (run failed), 429 (caps), 503 (fixture or recorded mode). */
  httpStatus: number;
}

/** Presets stay cached this long (prewarmed, cached for 30 days). */
export const PRESET_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Picks = { input: string; entityId: string }[];
type Freshness = { leftForCaller: number; leftToday: number };

/** 200 for every answer the caller can act on; 422 when the run itself failed. */
function ok<T>(envelope: ToolEnvelope<T>): ToolOutcome<T> {
  return { envelope, httpStatus: envelope.status === "error" ? 422 : 200 };
}

/**
 * The mode an envelope reports. A recorded server sits on fixture deps (it runs nothing) but serves sheets recorded
 * from live runs, so its answers say "recorded", never "fixture" with the sample-data limits.
 */
export function envelopeMode(services: Pick<McpServices, "mode" | "policy">): PlanMode {
  return services.policy.recorded ? "recorded" : services.mode;
}

function fail(services: McpServices, httpStatus: number, reason: string, extras: Parameters<typeof errorEnvelope>[2] = {}): ToolOutcome<null> {
  return { envelope: errorEnvelope(reason, envelopeMode(services), extras), httpStatus };
}

/** Recorded state (recorded sheets served, live runs paused for judging): the refusal for anything that would run, or null. */
function recordedRefusal(services: McpServices): ToolOutcome<null> | null {
  const reason = services.policy.recorded;
  return reason ? { envelope: errorEnvelope(reason, "recorded"), httpStatus: 503 } : null;
}

function freshInfo(d: CapDecision): Freshness {
  return { leftForCaller: d.leftForCaller, leftToday: d.leftToday };
}

function operatorOverrides(op: PlanShowArgs["operator"]): Partial<OperatorInputs> | undefined {
  if (!op) return undefined;
  const out: Partial<OperatorInputs> = {};
  if (op.seatsLeft !== undefined) out.seatsLeft = op.seatsLeft;
  if (op.capacity !== undefined) out.capacity = op.capacity;
  if (op.mediaBudgetUsd !== undefined) out.mediaBudgetUsd = op.mediaBudgetUsd;
  if (op.radiusKm !== undefined) out.radiusKm = op.radiusKm;
  if (op.streetTeamDays !== undefined) out.streetTeamDays = [...new Set(op.streetTeamDays)];
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A server on the synthetic world only (fixture deps, no recorded sheets): what the web app calls sample mode. There
 * g4-a and g4-b, which plan real shows only, are refused and left out of every preset list.
 */
export function sampleOnly(services: Pick<McpServices, "mode"> & { policy: Pick<McpServices["policy"], "recorded"> }): boolean {
  return services.mode === "fixture" && !services.policy.recorded;
}

/**
 * Why a preset that plans a real show only (g4-a, g4-b: the fixture world has no copy of their room) is refused on a
 * sample-mode server, in the words of the web app's POST /api/plan, or null. A run there would plan another room's
 * sample bill under its id and hand out a share link the web app does not open.
 */
function liveOnlyReason(services: McpServices, presetId: string): string | null {
  return sampleOnly(services) && presetById(presetId)?.fixtureSameAs ? `${presetId} plans a real show only, and this copy of Walkup runs without keys.` : null;
}

function liveOnlyRefusal(services: McpServices, presetId: string): ToolOutcome<null> | null {
  const reason = liveOnlyReason(services, presetId);
  return reason ? fail(services, 503, reason) : null;
}

function unknownPreset(services: McpServices, id: string): ToolOutcome<null> {
  return fail(services, 404, `Unknown preset "${id}". Presets: ${presetIdsFor(sampleOnly(services)).join(", ")}.`);
}

/** Deps for one caller: the services' store and a pick cache of this caller's own (none for shared preset plans). */
function depsFor(services: McpServices, ip: string | null): PlanDeps {
  const deps: PlanDeps = { ...services.deps, store: services.store };
  if (ip !== null) deps.choices = services.choicesFor(callerKey(ip));
  else delete deps.choices;
  return deps;
}

type Exec = (request: PlanRequest, deps: PlanDeps) => Promise<PlanResult>;

/** One orchestrator run (planShow unless `exec` says otherwise), followed by the host's afterRun hook. */
async function run(services: McpServices, request: PlanRequest, deps: PlanDeps, exec?: Exec): Promise<PlanResult> {
  const result = exec ? await exec(request, deps) : await planShow(request, deps);
  if (services.afterRun) {
    try {
      await services.afterRun(result, deps);
    } catch {
      // Hooks are informational (quota display, key status).
    }
  }
  return result;
}

function isFresh(services: McpServices, stored: StoredPlan): boolean {
  if (stored.mode !== services.mode) return false;
  const at = Date.parse(stored.createdAt);
  return Number.isFinite(at) && services.now() - at < PRESET_TTL_MS;
}

/** A fresh stored run of the preset's show as it is now: a run of an event the preset no longer names is not that preset. */
function isCurrentPresetRun(services: McpServices, presetId: string, stored: StoredPlan): boolean {
  const preset = presetById(presetId);
  const bill = stored.sheet?.bill ?? stored.pause?.bill;
  return isFresh(services, stored) && preset !== null && presetShowOf(preset, stored.mode, bill) !== null;
}

async function once<T>(services: McpServices, key: string, fn: () => Promise<T>): Promise<T> {
  const running = services.inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fn().finally(() => services.inflight.delete(key));
  services.inflight.set(key, p);
  return p;
}

/** What a preset id shows: the host's loader when it has one, else the stored preset plan (plan id = preset id) of its current show, else one run. Unlimited. */
async function presetView(services: McpServices, presetId: string, view: "page" | "api"): Promise<PlanView> {
  if (services.presetView) {
    const hosted = await services.presetView(presetId, view);
    if (hosted) return hosted;
  }
  // Never a stored or fresh fixture run of a real-show-only preset (the tools refuse it before this; this holds it).
  const liveOnly = liveOnlyReason(services, presetId);
  if (liveOnly) return { kind: "error", planId: null, mode: services.mode, reason: liveOnly };
  const stored = await services.store.get(presetId);
  if (stored && isCurrentPresetRun(services, presetId, stored)) return viewOfStored(stored);
  // Recorded state never runs the planner, not even for a preset.
  if (services.policy.recorded) return { kind: "error", planId: presetId, mode: "recorded", reason: services.policy.recorded };
  const r = await once(services, `preset:${presetId}`, () => run(services, { presetId, planId: presetId }, depsFor(services, null)));
  return viewOfResult(r);
}

/** Picks must answer a pending input with one of the candidates shown for it. */
function checkPicks(pending: PendingPick[], picks: Picks): { resolutions: Record<string, string> } | { problem: string } {
  const resolutions: Record<string, string> = {};
  for (const pick of picks) {
    const row = pending.find((p) => p.input.trim().toLowerCase() === pick.input.trim().toLowerCase());
    if (!row) return { problem: `Nothing waits for a pick named "${pick.input}". Pending: ${pending.map((p) => p.input).join(", ") || "nothing"}.` };
    if (!row.candidates.some((c) => c.entityId === pick.entityId)) {
      const shown = row.candidates.map((c) => `${c.entityId} (${c.subtype})`).join(", ");
      return { problem: `Pick one of the candidates shown for "${row.input}": ${shown}.` };
    }
    resolutions[row.input] = pick.entityId;
  }
  return { resolutions };
}

function picksHash(resolutions: Record<string, string>): string {
  const canon = Object.entries(resolutions)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k.toLowerCase()}=${v}`)
    .join("|");
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}

/** A preset answered with picks among its own candidates: one stored plan per distinct answer. Unlimited. */
async function resumePreset(services: McpServices, presetId: string, picks: Picks, caller: Caller): Promise<ToolOutcome> {
  const base = await presetView(services, presetId, "page");
  if (base.kind !== "paused") return ok(envelopeOfView(base, caller.origin));
  const checked = checkPicks(base.pause.pending, picks);
  if ("problem" in checked) return fail(services, 400, checked.problem, { planId: presetId, resolution: base.pause.resolution.results });
  const planId = `${presetId}-${picksHash(checked.resolutions)}`;
  const stored = await services.store.get(planId);
  if (stored && isCurrentPresetRun(services, presetId, stored)) return ok(envelopeOfView(viewOfStored(stored), caller.origin));
  const r = await once(services, `preset:${planId}`, () => run(services, { presetId, planId, resolutions: checked.resolutions }, depsFor(services, null)));
  return ok(envelopeOfView(viewOfResult(r), caller.origin));
}

/** The preset's show in this server's mode, or the 404 for a live server and a preset with no live show yet. */
function showFor(services: McpServices, preset: Preset): { show: PresetShow } | { outcome: ToolOutcome<null> } {
  // Recorded state refuses before this (recordedRefusal); a recorded server has no show to run.
  if (services.policy.recorded || services.mode === "recorded") return { outcome: fail(services, 503, services.policy.recorded ?? NO_LIVE_SHOW) };
  const liveOnly = liveOnlyRefusal(services, preset.id);
  if (liveOnly) return { outcome: liveOnly };
  const show = presetFor(preset, services.mode);
  return show ? { show } : { outcome: fail(services, 404, NO_LIVE_SHOW) };
}

/**
 * A preset run with the caller's own changes (what-ifs, a partner list): the
 * event, date and what-ifs of the preset's show, and its seeds, sent as an
 * event request. It is not stored under the preset's id, so it never becomes
 * the sheet the preset shows to everyone else, and the quota guard's "serve the
 * stored preset" path cannot hand back a sheet that ignores the caller's changes.
 */
function presetAsEvent(preset: Preset, show: PresetShow, operator: Partial<OperatorInputs>, resolutions: Record<string, string> | undefined): PlanRequest {
  return {
    tmEventId: show.tmEventId,
    asOf: show.asOf,
    operator: { ...show.operator, ...operator },
    ...(preset.seeds ? { seeds: preset.seeds } : {}),
    ...(preset.categories ? { categories: preset.categories } : {}),
    ...(preset.pairedWith ? { pairedPlanId: preset.pairedWith } : {}),
    ...(resolutions ? { resolutions } : {}),
  };
}

const PICKS_ANSWER_A_PAUSE =
  "Picks answer a needs_input you were shown. Run without them; if the result is needs_input, show the candidates and call plan_show with its planId and picks.";

/** Picks sent with a preset run must answer the preset's own pause with a candidate it showed. */
async function presetPicks(services: McpServices, presetId: string, picks: Picks | undefined): Promise<{ resolutions?: Record<string, string> } | { problem: string }> {
  if (!picks || picks.length === 0) return {};
  const view = await presetView(services, presetId, "page");
  if (view.kind !== "paused") return { problem: `Nothing on ${presetId} waits for a pick. ${PICKS_ANSWER_A_PAUSE}` };
  const checked = checkPicks(view.pause.pending, picks);
  return "problem" in checked ? checked : { resolutions: checked.resolutions };
}

/** True when this run counts against the caps (live always; fixture unless the policy says otherwise). */
function capped(services: McpServices): boolean {
  return services.mode === "live" || services.policy.capFixtureRuns;
}

async function peekCaps(services: McpServices, caller: Caller): Promise<ToolOutcome<null> | null> {
  if (!capped(services)) return null;
  const d = await services.limiter.check(caller.ip, services.now());
  return d.allowed ? null : fail(services, 429, d.reason ?? "limit reached", { freshRuns: freshInfo(d) });
}

/** Runs the planner as a fresh run: takes one unit from the caps; gives it back if no Qloo request was sent. */
async function freshRun(services: McpServices, caller: Caller, request: PlanRequest, exec?: Exec): Promise<ToolOutcome & { result?: PlanResult; fresh?: Freshness }> {
  const counted = capped(services);
  let cap: CapDecision | null = null;
  if (counted) {
    cap = await services.limiter.take(caller.ip, services.now());
    if (!cap.allowed) return fail(services, 429, cap.reason ?? "limit reached", { freshRuns: freshInfo(cap) });
  }
  const planId = request.planId ?? services.idGen();
  let result: PlanResult;
  try {
    result = await run(services, { ...request, planId }, depsFor(services, caller.ip), exec);
  } catch (err) {
    if (counted) await services.limiter.refund(caller.ip, services.now());
    return fail(services, 500, `The plan could not be built: ${err instanceof Error ? err.message : String(err)}`, { planId });
  }
  let fresh: Freshness | undefined = cap ? freshInfo(cap) : undefined;
  // After a refund, report what the limiter now holds (an unlimited limiter stays at its ceiling).
  const giveBack = async (): Promise<Freshness> => {
    await services.limiter.refund(caller.ip, services.now());
    return freshInfo(await services.limiter.check(caller.ip, services.now()));
  };
  if (result.servedFromStore) {
    // The quota guard answered with a stored sheet: it does not carry this request's changes.
    const back = counted ? { freshRuns: await giveBack() } : {};
    return fail(services, 503, "Qloo's monthly quota guard is on, so fresh runs are paused. Presets and existing plans stay available.", back);
  }
  if (counted && fresh && result.status === "error" && result.budget.qlooFresh === 0) fresh = await giveBack();
  const envelope = envelopeOfView(viewOfResult(result), caller.origin);
  if (fresh) envelope.freshRuns = fresh;
  return { ...ok(envelope), result, ...(fresh ? { fresh } : {}) };
}

/** Resolves event text or a link to a Ticketmaster event, or the envelope to return instead. */
async function eventRequest(services: McpServices, event: string, picks: Picks | undefined): Promise<{ tmEventId: string; rest: Picks } | { outcome: ToolOutcome }> {
  if (services.mode === "fixture" && !services.policy.fixtureEventRuns) return { outcome: fail(services, 503, services.policy.fixtureRefusal) };
  const tmFactory = services.deps.tm;
  if (!tmFactory) return { outcome: fail(services, 503, "Ticketmaster is not configured on this server; use a presetId.") };
  const ledger = createMemoryLedger();
  const eventPick = picks?.find((p) => p.input.trim().toLowerCase() === event.trim().toLowerCase());
  const found = await lookupEvent(event, { tm: tmFactory(ledger), ledger, parse: (text) => services.parseShow(text, ledger), now: services.now }, eventPick?.entityId);
  const provenance = found.ledger.map((e) => e.id);
  if (found.kind === "error") return { outcome: fail(services, 404, found.reason, { provenance }) };
  if (found.kind === "needs_input") {
    const row: Resolution = { input: found.input, role: "headliner", status: "needs_input", candidates: found.candidates };
    const envelope: ToolEnvelope<null> = {
      status: "needs_input",
      summary: `${found.candidates.length} Ticketmaster events match "${event}". Which one?`,
      planId: null,
      sheetUrl: null,
      mode: envelopeMode(services),
      results: null,
      resolution: [row],
      pending: [{ input: found.input, candidates: found.candidates }],
      reason: `Show the events to the user, then call again with the same event text and picks: [{input: "${found.input}", entityId: "<event id>"}], or pass the event's link.`,
      provenance,
      limits: baseLimits(envelopeMode(services)),
    };
    return { outcome: ok(envelope) };
  }
  return { tmEventId: found.tmEventId, rest: (picks ?? []).filter((p) => p !== eventPick) };
}

function exactlyOne(fields: Record<string, unknown>): string | null {
  const given = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (given.length === 1) return null;
  const names = Object.keys(fields).join(", ");
  return given.length === 0 ? `Give one of ${names}.` : `Give exactly one of ${names} (got ${given.map(([k]) => k).join(" and ")}).`;
}

// ---------------------------------------------------------------------------
// plan_show
// ---------------------------------------------------------------------------

async function resumeStored(services: McpServices, caller: Caller, stored: StoredPlan, picks: Picks): Promise<ToolOutcome> {
  if (!stored.pause) return ok(envelopeOfView(viewOfStored(stored), caller.origin));
  if (stored.mode !== services.mode) return fail(services, 409, `This ${stored.mode} plan cannot resume while the server runs in ${services.mode} mode.`, { planId: stored.planId });
  const checked = checkPicks(stored.pause.pending, picks);
  if ("problem" in checked) return fail(services, 400, checked.problem, { planId: stored.planId, resolution: stored.pause.resolution.results });
  // Resuming a paused fresh run finishes the run it already counted.
  const request: PlanRequest = { ...stored.request, planId: stored.planId, resolutions: { ...stored.request.resolutions, ...checked.resolutions } };
  return ok(envelopeOfView(viewOfResult(await run(services, request, depsFor(services, caller.ip))), caller.origin));
}

/** A preset's view; in the recorded state a preset with nothing recorded answers like any refusal (503). */
function recordedOr(services: McpServices, caller: Caller, v: PlanView): ToolOutcome {
  if (services.policy.recorded && v.kind === "error") return recordedRefusal(services) as ToolOutcome;
  return ok(envelopeOfView(v, caller.origin, { recorded: Boolean(services.policy.recorded) }));
}

export async function planShowTool(services: McpServices, caller: Caller, args: PlanShowArgs): Promise<ToolOutcome> {
  // Recorded state: reading a preset's recorded sheet or a stored plan still works; anything that would run does not.
  const reads = args.event === undefined && args.picks === undefined && !operatorOverrides(args.operator) && (args.presetId !== undefined || args.planId !== undefined);
  const off = reads ? null : recordedRefusal(services);
  if (off) return off;
  const rec = { recorded: Boolean(services.policy.recorded) };
  const which = exactlyOne({ event: args.event, presetId: args.presetId, planId: args.planId });
  if (which) return fail(services, 400, which);
  const problem = inputProblem([{ field: "event", value: args.event }, ...(args.picks ?? []).map((p) => ({ field: "picks", value: p.input }))]);
  if (problem) return fail(services, 400, problem.reason);
  const overrides = operatorOverrides(args.operator);

  if (args.presetId !== undefined) {
    const preset = presetById(args.presetId);
    if (!preset) return unknownPreset(services, args.presetId);
    const liveOnly = liveOnlyRefusal(services, preset.id);
    if (liveOnly) return liveOnly;
    if (overrides) {
      const shown = showFor(services, preset);
      if ("outcome" in shown) return shown.outcome;
      const blocked = await peekCaps(services, caller);
      if (blocked) return blocked;
      const picked = await presetPicks(services, preset.id, args.picks);
      if ("problem" in picked) return fail(services, 400, picked.problem);
      return freshRun(services, caller, presetAsEvent(preset, shown.show, overrides, picked.resolutions));
    }
    if (args.picks) return resumePreset(services, preset.id, args.picks, caller);
    return recordedOr(services, caller, await presetView(services, preset.id, "page"));
  }

  if (args.planId !== undefined) {
    if (overrides) return fail(services, 400, "Operator what-ifs start a new plan: pass them with event or presetId, not planId.");
    const preset = presetById(args.planId);
    if (preset) {
      const liveOnly = liveOnlyRefusal(services, preset.id);
      if (liveOnly) return liveOnly;
      return args.picks ? resumePreset(services, preset.id, args.picks, caller) : recordedOr(services, caller, await presetView(services, preset.id, "page"));
    }
    const stored = await services.store.get(args.planId);
    if (!stored) return fail(services, 404, `No plan with id ${args.planId}.`);
    if (!args.picks || stored.status === "complete") return ok(envelopeOfView(viewOfStored(stored), caller.origin, rec));
    return resumeStored(services, caller, stored, args.picks);
  }

  // event
  const blocked = await peekCaps(services, caller);
  if (blocked) return blocked;
  const ev = await eventRequest(services, args.event as string, args.picks);
  if ("outcome" in ev) return ev.outcome;
  if (ev.rest.length > 0) return fail(services, 400, `Nothing waits for a pick named "${ev.rest[0]?.input}". ${PICKS_ANSWER_A_PAUSE}`);
  return freshRun(services, caller, { tmEventId: ev.tmEventId, ...(overrides ? { operator: overrides } : {}) });
}

// ---------------------------------------------------------------------------
// rank_partners
// ---------------------------------------------------------------------------

function cleanNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim().replace(/\s+/g, " ");
    const k = n.toLowerCase();
    if (!n || seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}

export const NOT_AFFILIATED = "Suggested, not affiliated: no partner has agreed to anything.";

function rankEnvelope(sheet: StreetSheet, caller: Caller): ToolEnvelope<DeclaredPartnerScore[]> {
  const card = sheet.cards.declared;
  return {
    status: card.status,
    summary: card.summary,
    planId: sheet.planId,
    sheetUrl: sheetUrlFor(caller.origin, sheet.planId),
    planUrl: planUrlFor(caller.origin, sheet.planId),
    mode: sheet.mode,
    results: card.results,
    resolution: sheet.cards.resolution.results,
    cards: cardStatuses(sheet),
    ...(card.status !== "ok" && card.reason ? { reason: card.reason } : {}),
    provenance: card.provenance.length > 0 ? [...card.provenance] : sheet.ledger.map((e) => e.id),
    limits: unique([...card.limits, ...sheet.limits, NOT_AFFILIATED]),
  };
}

export async function rankPartnersTool(services: McpServices, caller: Caller, args: RankPartnersArgs): Promise<ToolOutcome> {
  const off = recordedRefusal(services);
  if (off) return off;
  const which = exactlyOne({ planId: args.planId, event: args.event, presetId: args.presetId });
  if (which) return fail(services, 400, which);
  const names = cleanNames(args.partnerNames);
  if (names.length === 0) return fail(services, 400, "Give at least one partner name.");
  const problem = inputProblem([
    { field: "event", value: args.event },
    ...names.map((n) => ({ field: "partnerNames", value: n })),
    ...(args.picks ?? []).map((p) => ({ field: "picks", value: p.input })),
  ]);
  if (problem) return fail(services, 400, problem.reason);
  const blocked = await peekCaps(services, caller);
  if (blocked) return blocked;

  const overrides = operatorOverrides(args.operator);
  const declaredPartners = names.map((label) => ({ label }));
  let request: PlanRequest;
  const presetId = args.presetId ?? (args.planId !== undefined && presetById(args.planId) ? args.planId : undefined);
  if (presetId !== undefined) {
    const preset = presetById(presetId);
    if (!preset) return unknownPreset(services, presetId);
    const shown = showFor(services, preset);
    if ("outcome" in shown) return shown.outcome;
    const picked = await presetPicks(services, preset.id, args.picks);
    if ("problem" in picked) return fail(services, 400, picked.problem);
    request = presetAsEvent(preset, shown.show, { ...overrides, declaredPartners }, picked.resolutions);
  } else if (args.planId !== undefined) {
    const stored = await services.store.get(args.planId);
    if (!stored) return fail(services, 404, `No plan with id ${args.planId}.`);
    if (stored.status !== "complete") {
      const env = envelopeOfView(viewOfStored(stored), caller.origin);
      env.reason = "Resolve this plan first (plan_show with planId and picks), then rank partners against the plan id it returns.";
      return ok(env);
    }
    if (args.picks && args.picks.length > 0) return fail(services, 400, `Plan ${args.planId} is complete: nothing waits for a pick. Rank against it without picks.`);
    const { planId: _drop, presetId: storedPresetId, ...rest } = stored.request;
    const operator = { ...rest.operator, ...overrides, declaredPartners };
    if (storedPresetId === undefined) request = { ...rest, operator };
    else {
      // A plan made from a preset (e.g. a preset answered with a pick): rank on its event, never in the preset's slot.
      const fromPreset = presetById(storedPresetId);
      if (!fromPreset) return unknownPreset(services, storedPresetId);
      const shown = showFor(services, fromPreset);
      if ("outcome" in shown) return shown.outcome;
      request = { ...presetAsEvent(fromPreset, shown.show, operator, undefined), ...rest, operator: { ...shown.show.operator, ...operator } };
    }
  } else {
    const ev = await eventRequest(services, args.event as string, args.picks);
    if ("outcome" in ev) return ev.outcome;
    if (ev.rest.length > 0) return fail(services, 400, `Nothing waits for a pick named "${ev.rest[0]?.input}". ${PICKS_ANSWER_A_PAUSE}`);
    request = { tmEventId: ev.tmEventId, operator: { ...overrides, declaredPartners } };
  }

  const r = await freshRun(services, caller, request);
  if (!r.result || r.result.status !== "complete" || !r.result.sheet) return r;
  const envelope = rankEnvelope(r.result.sheet, caller);
  if (r.fresh) envelope.freshRuns = r.fresh;
  return ok(envelope);
}

// ---------------------------------------------------------------------------
// bill_vs_house and get_sheet (reads; a preset not stored yet is run once)
// ---------------------------------------------------------------------------

async function readView(services: McpServices, planId: string): Promise<PlanView | null> {
  if (presetById(planId)) return presetView(services, planId, "api");
  const stored = await services.store.get(planId);
  return stored ? viewOfStored(stored) : null;
}

export interface BillVsHouse {
  planId: string;
  bill: { acts: { name: string; role: string }[]; venue: { name: string; city: string; state?: string }; date: string; weekday: string };
  /**
   * "house": the room's own roster; "tag": a pinned genre tag stood in (labelled degraded); "none": neither, so there
   * is no lift map (G3: too few comedians on the roster matched and comedy has no genre-wide map).
   */
  baseline: "house" | "tag" | "none";
  tiles: StreetSheet["cards"]["liftMap"]["results"]["tiles"];
  diagnostics: StreetSheet["cards"]["liftMap"]["results"]["diagnostics"];
  whatsDifferent: StreetSheet["cards"]["whatsDifferent"]["results"];
  demographics: StreetSheet["cards"]["demographics"]["results"];
  cards: Record<"liftMap" | "whatsDifferent" | "demographics", { status: EnvelopeStatus; summary: string; reason?: string }>;
}

export function billVsHouseOf(sheet: StreetSheet): BillVsHouse {
  const { liftMap, whatsDifferent, demographics } = sheet.cards;
  const head = (c: { status: EnvelopeStatus; summary: string; reason?: string }) => ({ status: c.status, summary: c.summary, ...(c.reason ? { reason: c.reason } : {}) });
  const venue: BillVsHouse["bill"]["venue"] = { name: sheet.bill.venue.name, city: sheet.bill.venue.city };
  if (sheet.bill.venue.state) venue.state = sheet.bill.venue.state;
  return {
    planId: sheet.planId,
    bill: { acts: sheet.bill.acts.map((a) => ({ name: a.name, role: a.role })), venue, date: sheet.bill.date, weekday: sheet.bill.weekday },
    baseline: liftMap.results.diagnostics.baseline,
    tiles: liftMap.results.tiles,
    diagnostics: liftMap.results.diagnostics,
    whatsDifferent: whatsDifferent.results,
    demographics: demographics.results,
    cards: { liftMap: head(liftMap), whatsDifferent: head(whatsDifferent), demographics: head(demographics) },
  };
}

export async function billVsHouseTool(services: McpServices, caller: Caller, args: PlanRefArgs): Promise<ToolOutcome> {
  // Reads a stored sheet only, so it works in the recorded state too.
  const liveOnly = liveOnlyRefusal(services, args.planId);
  if (liveOnly) return liveOnly;
  const v = await readView(services, args.planId);
  if (!v) return fail(services, 404, `No plan with id ${args.planId}.`);
  if (v.kind !== "sheet") {
    const env = envelopeOfView(v, caller.origin);
    if (env.status === "needs_input") env.reason = "Resolve this plan first (plan_show with planId and picks), then compare against the plan id it returns.";
    return ok(env);
  }
  const sheet = v.sheet;
  const cards = [sheet.cards.liftMap, sheet.cards.whatsDifferent, sheet.cards.demographics];
  const status = worstStatus(cards.map((c) => c.status));
  const reason = cards.find((c) => c.status === status && c.reason)?.reason ?? cards.find((c) => c.status !== "ok" && c.status !== "empty" && c.reason)?.reason;
  const results = billVsHouseOf(sheet);
  // With no baseline the lift card's own summary says the same thing, so it is said once, with the reason.
  const summary =
    results.baseline === "none"
      ? `Bill vs house at ${sheet.bill.venue.name}: there is no usual crowd to compare this bill with (the room's roster did not resolve and no genre tag is pinned).`
      : `Bill vs house at ${sheet.bill.venue.name}, compared with ${results.baseline === "house" ? "the room's usual crowd" : "a genre baseline (the room's roster did not resolve)"}: ${sheet.cards.liftMap.summary}`;
  const envelope: ToolEnvelope<BillVsHouse> = {
    status,
    summary,
    planId: sheet.planId,
    sheetUrl: sheetUrlFor(caller.origin, sheet.planId),
    planUrl: planUrlFor(caller.origin, sheet.planId),
    mode: services.policy.recorded && sheet.mode === "live" ? "recorded" : sheet.mode,
    results,
    resolution: sheet.cards.resolution.results,
    ...(status !== "ok" && reason ? { reason } : {}),
    provenance: unique(cards.flatMap((c) => c.provenance)),
    limits: unique([...cards.flatMap((c) => c.limits), ...sheet.limits]),
  };
  return ok(envelope);
}

export async function getSheetTool(services: McpServices, caller: Caller, args: PlanRefArgs): Promise<ToolOutcome> {
  const liveOnly = liveOnlyRefusal(services, args.planId);
  if (liveOnly) return liveOnly;
  const v = await readView(services, args.planId);
  if (!v) return fail(services, 404, `No plan with id ${args.planId}.`);
  // Recorded state: a live sheet is a recording, and its envelope says so.
  return ok(envelopeOfView(v, caller.origin, { recorded: Boolean(services.policy.recorded) }));
}

// ---------------------------------------------------------------------------
// revise_plan
// ---------------------------------------------------------------------------

/** How many recent live sheets the recorded state searches for revisions of a plan. */
const RECORDED_REVISION_LOOKBACK = 30;

/** A note as the user typed it, on one line. */
function noteText(note: string): string {
  return note.replace(/\s+/g, " ").trim();
}

/** Two notes are the same note when they differ only in case, spacing and punctuation ("All ages: no bars"). */
function sameNote(a: string, b: string): boolean {
  const key = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
  return key(a) === key(b);
}

/**
 * The recorded state cannot revise (live runs are paused), but a revision made while the server was live is still
 * stored. The refusal gives the host's reason first, says the caller's note was not run, and names each recorded
 * revision (plan id, its note, sheet link) so an agent can read it with get_sheet. A revision counts as the caller's
 * when its note is the same words (case, spacing and punctuation aside) or when the host's reader
 * (services.recordedMatch, the one the web page's box uses) reads the note as the change that revision made. Without
 * that reading, a revision for other words is not called a different change: the agent is told to read its note.
 * An id with no plan behind it answers 404 "No plan with id ...", never the paused text alone.
 */
async function withRecordedRevisions(services: McpServices, caller: Caller, planId: string, instruction: string, off: ToolOutcome<null>): Promise<ToolOutcome<null>> {
  const asked = noteText(instruction);
  const lead = asked ? `Your note "${asked}" was not run.` : "Your note was not run.";
  const refuse = (detail: string): ToolOutcome<null> => {
    const reason = [off.envelope.reason ?? "", lead, detail].filter(Boolean).join(" ");
    return { ...off, envelope: { ...off.envelope, summary: reason, reason } };
  };
  let revisions: StoredPlan[] = [];
  let parentId = planId;
  try {
    const parent = await readView(services, planId);
    // An id with no plan behind it is said to be unknown, as get_sheet and POST /api/plan/<id>/revise say it.
    if (!parent) return fail(services, 404, `No plan with id ${planId}.`);
    parentId = parent.kind === "sheet" ? parent.sheet.planId : planId;
    const recent = await services.store.listComplete({ mode: "live" }, RECORDED_REVISION_LOOKBACK);
    // Up to six: a hosted hero sheet has up to five ready-made changes, and an agent should see each one.
    revisions = recent.filter((p) => p.sheet?.revision?.parentPlanId === parentId).slice(0, 6);
  } catch {
    revisions = [];
  }
  if (revisions.length === 0) return refuse("");
  // The host's reading of the note: null when there is none (no hook, an unclear note, a failure).
  let reading: { planId: string | null } | null = null;
  if (asked && services.recordedMatch) {
    try {
      reading = await services.recordedMatch(parentId, asked, caller.ip);
    } catch {
      reading = null;
    }
  }
  const where = (p: StoredPlan): string => {
    const url = sheetUrlFor(caller.origin, p.planId);
    return `plan ${p.planId}${url ? `, ${url}` : ""}`;
  };
  const noteOf = (p: StoredPlan): string => noteText(p.sheet?.revision?.instruction ?? "");
  const listed = (ps: StoredPlan[]) => ps.map((p) => `"${noteOf(p)}" (${where(p)})`).join("; ");
  const same = asked ? revisions.filter((p) => sameNote(noteOf(p), asked)) : [];
  const matchId = reading?.planId ?? null;
  const meant = matchId ? revisions.filter((p) => p.planId === matchId && !same.includes(p)) : [];
  const other = revisions.filter((p) => !same.includes(p) && !meant.includes(p));
  const parts: string[] = [];
  if (same.length > 0) {
    parts.push(`This plan has a recorded run of that same note (${same.map(where).join("; ")}), readable with get_sheet.`);
  }
  if (meant.length > 0) {
    const head = same.length > 0 ? "It also has" : "This plan has";
    parts.push(`${head} a recorded revision that makes the change your note asks for: ${listed(meant)}, readable with get_sheet.`);
  }
  if (other.length > 0) {
    const found = same.length > 0 || meant.length > 0;
    const head = found ? "It also has" : "This plan has";
    const one = other.length === 1;
    // Only a reading of the note can say a revision makes a different change; otherwise the agent reads the note.
    const tail = found ? "" : reading ? (one ? " It does not make the change your note asks for." : " None of them makes the change your note asks for.") : one ? " Read its note to see whether it makes your change." : " Read their notes to see whether one makes your change.";
    parts.push(`${head} ${one ? "a recorded revision for a different note" : "recorded revisions for different notes"}: ${listed(other)}, readable with get_sheet.${tail}`);
  }
  return refuse(parts.join(" "));
}

export const REVISE_QUESTION_REASON = "Nothing was changed. Put the question to the user, then call revise_plan again with their clearer note.";

/**
 * Changes a finished sheet with the user's note. The note is read by the model
 * with strict tools (or by fixed rules when no model is set up); a question
 * comes back as needs_input with nothing run. Otherwise the plan re-runs with
 * the new operator inputs under a new plan id (a fresh run for the caps; the
 * Qloo cache answers every request whose inputs did not change).
 */
export async function revisePlanTool(services: McpServices, caller: Caller, args: RevisePlanArgs): Promise<ToolOutcome> {
  const off = recordedRefusal(services);
  if (off) return withRecordedRevisions(services, caller, args.planId, args.instruction, off);
  const problem = inputProblem([{ field: "instruction", value: args.instruction }]);
  if (problem) return fail(services, 400, problem.reason);
  const liveOnly = liveOnlyRefusal(services, args.planId);
  if (liveOnly) return liveOnly;
  const v = await readView(services, args.planId);
  if (!v) return fail(services, 404, `No plan with id ${args.planId}.`);
  if (v.kind !== "sheet") {
    const env = envelopeOfView(v, caller.origin);
    if (env.status === "needs_input") env.reason = "Resolve this plan first (plan_show with planId and picks), then revise the plan id it returns.";
    return ok(env);
  }
  const parent = v.sheet;
  if (parent.mode !== services.mode) return fail(services, 409, `This ${parent.mode} sheet cannot be revised while the server runs in ${services.mode} mode.`, { planId: parent.planId });
  const isPreset = presetById(args.planId) !== null;
  const stored = isPreset ? null : await services.store.get(args.planId);
  const request = parentRequest(parent, { stored: stored?.request ?? null, presetId: isPreset ? args.planId : (v.presetId ?? null) });
  if (!request) return fail(services, 409, `Plan ${args.planId} cannot be re-run: its request is no longer known.`, { planId: parent.planId });
  const blocked = await peekCaps(services, caller);
  if (blocked) return blocked;

  const reading = await readInstruction(parent, args.instruction, depsFor(services, caller.ip));
  if (reading.question || reading.calls.length === 0) {
    const revision = questionRevision(reading);
    const question = revision.question ?? "What should change on the sheet?";
    const envelope: ToolEnvelope<null> = {
      status: "needs_input",
      summary: question,
      planId: parent.planId,
      sheetUrl: sheetUrlFor(caller.origin, parent.planId),
      planUrl: planUrlFor(caller.origin, parent.planId),
      mode: envelopeMode(services),
      results: null,
      resolution: [],
      reason: REVISE_QUESTION_REASON,
      provenance: [],
      limits: baseLimits(envelopeMode(services)),
      parentPlanId: parent.planId,
      question,
      revision,
    };
    return ok(envelope);
  }
  const r = await freshRun(services, caller, request, (req, deps) => runRevision({ sheet: parent, request }, reading, deps, req.planId ? { planId: req.planId } : {}));
  if (r.result?.sheet?.revision) {
    r.envelope.revision = r.result.sheet.revision;
    r.envelope.parentPlanId = parent.planId;
  }
  return r;
}

/** For hosts: a paused plan's envelope from the orchestrator's pause (re-exported shape). */
export type { PauseLike };
