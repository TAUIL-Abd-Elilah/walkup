/**
 * The web app's plan service: everything the route handlers (and the MCP
 * route, which mounts at /mcp) need, behind small functions that return
 * { status, body } so they can be tested without a server.
 *
 *   startPlan(body, ctx)          POST /api/plan, POST /api/rank-partners
 *   resolvePlan(id, body, ctx)    POST /api/plan/<id>/resolve
 *   loadPlan(id, opts)            pages, GET /api/sheet/<id>, exports, SSE
 *   planSnapshot(id)              GET /api/plan/<id>
 *
 * Modes: in fixture mode the bundled presets run through the orchestrator on the
 * synthetic fixture world (free, unlimited); free-form runs are refused with
 * 503. In live mode fresh runs are capped per IP and per day; a preset with a
 * stored run is served from storage. In recorded mode (live runs are
 * paused) nothing runs: presets show their recorded live run, or the
 * bundled sample sheet, and every fresh path answers 503 (recordedRefusal).
 */
import { randomUUID } from "node:crypto";
import { withoutControl, type Bill, type Envelope, type LedgerEntry, type OperatorInputs, type Resolution, type StreetSheet } from "@walkup/contracts";
import { planShow, presetById, presetFor, presetShowOf, resolveMode, type PlanDeps, type StoredPlan } from "@walkup/orchestrator";
import { errorEnvelope, FIXTURE_FRESH_RUNS_REASON, PLAN_ID_RE, pausedEnvelope, RECORDED_REASON, sheetEnvelope } from "../api";
import { runtimeMode } from "../mode";
import { ALL_PRESET_IDS, getPlan, isLiveOnlyPresetId, isPresetId, type PresetFixture } from "../plans";
import { withSessionActions } from "./actions";
import { depsFor, pinnedFixtureDeps, publishLiveQuota, sessionChoices, stores } from "./engine";
import type { RequestContext } from "./http";
import { parsePicks, parsePlanBody, type Pick, type Wait } from "./input";
import { freshRuns, rateLimit, type FreshRunStatus } from "./limits";
import { recordedPresetRun } from "./recorded";
import { getRun, isCanonicalRequest, startRun, type Pending, type RunState, type StreamCard, type WebPlanRequest } from "./runs";
import { searchShows } from "./search";
import { addPartnerHouseRanks } from "./twin";

export interface ServiceResponse {
  status: number;
  body: unknown;
}

/** How long a synchronous POST waits for a run before answering 202 with the plan id. */
export const SYNC_WAIT_MS = 85_000;

/**
 * Fixture-world runs per network per hour. They cost no API call, but each one is stored
 * (a few hundred KB in plans.sqlite on the volume), so they are not unlimited.
 */
export const FIXTURE_RUNS_PER_HOUR = 30;
const HOUR_MS = 60 * 60 * 1000;

/** What every fresh path answers in recorded state: one plain reason, 503, mode "recorded". */
export function recordedRefusal(): ServiceResponse {
  return { status: 503, body: { mode: "recorded", reason: RECORDED_REASON } };
}

function fixtureRunAllowed(ctx: RequestContext): ServiceResponse | null {
  const rl = rateLimit("fixture-run", ctx.ip, FIXTURE_RUNS_PER_HOUR, HOUR_MS);
  if (rl.ok) return null;
  return { status: 429, body: { mode: "fixture", reason: `Too many fixture runs from this network; try again in ${rl.retryAfterS} s. The preset sheets stay open.` } };
}

// ---------------------------------------------------------------------------
// Loaded plans (what a page or the API shows for an id)
// ---------------------------------------------------------------------------

export interface PauseData {
  resolution: Envelope<Resolution[]>;
  pending: Pending[];
  bill: Bill;
  operator: OperatorInputs | null;
  /** The calls made before the pause (the resolution card's receipts). */
  ledger: LedgerEntry[];
}

export interface SheetView {
  kind: "sheet";
  planId: string;
  sheet: StreetSheet;
  /** About-this-sheet note (fixtures). */
  note: string | null;
  /** preset = a bundled preset sheet; store = a stored run; run = a run of this process. */
  source: "preset" | "store" | "run";
  fixtureSource?: "engine" | "hand-built";
  presetId?: string;
  title: string;
}

export interface PausedView {
  kind: "paused";
  planId: string;
  mode: "live" | "fixture";
  presetId?: string;
  title: string;
  pause: PauseData;
  source: "preset" | "store" | "run";
}

export interface RunningView {
  kind: "running";
  planId: string;
  mode: "live" | "fixture";
  presetId?: string;
  title: string;
  cards: StreamCard[];
}

export interface ErrorView {
  kind: "error";
  planId: string;
  mode: "live" | "fixture";
  title: string;
  error: string;
}

export type LoadedPlan = SheetView | PausedView | RunningView | ErrorView;

export interface LoadOptions {
  /** "page": a preset whose recorded run paused for a pick shows the pick first. "api": always the sheet. */
  view: "page" | "api";
  sessionId?: string | null;
}

/**
 * The title of the preset's show in this mode (its fixture title while it has
 * no live show). Given the bill a run planned, only that show's own event
 * takes the title: a run of an event the preset no longer names is titled by
 * its bill.
 */
function presetTitle(id: string | undefined, mode: "live" | "fixture", bill?: Bill): string | undefined {
  const preset = id ? presetById(id) : null;
  if (!preset) return undefined;
  if (bill) return presetShowOf(preset, mode, bill)?.title;
  return (presetFor(preset, mode) ?? presetFor(preset, "fixture")).title;
}

function billTitle(bill: Bill | undefined): string {
  if (!bill) return "Street Sheet";
  return `${bill.acts.map((a) => a.name).join(", ")} at ${bill.venue.name}`;
}

interface Memo {
  sheets: Map<string, Promise<PresetFixture>>;
  pauses: Map<string, Promise<PauseData | null>>;
  /** The bundled fixture each entry was built from; a regenerated fixture (dev reload) invalidates it. */
  source?: Map<string, PresetFixture>;
}

const MEMO_KEY = "__walkupPresetMemo";

function memo(): Memo {
  const g = globalThis as Record<string, unknown>;
  let m = g[MEMO_KEY] as Memo | undefined;
  if (!m) {
    m = { sheets: new Map(), pauses: new Map() };
    g[MEMO_KEY] = m;
  }
  return m;
}

/** The bundled preset sheet, with the partner house ranks added on the fixture world (once per process). */
export function presetSheet(id: string): Promise<PresetFixture> | null {
  const fx = getPlan(id);
  if (!fx) return null;
  const m = memo();
  m.source ??= new Map();
  if (m.source.get(id) !== fx) {
    m.sheets.delete(id);
    m.pauses.delete(id);
    m.source.set(id, fx);
  }
  let p = m.sheets.get(id);
  if (!p) {
    p = (async () => {
      if (fx.source !== "engine") return fx;
      try {
        const deps = pinnedFixtureDeps(`enrich:${id}`, Date.parse(fx.sheet.createdAt));
        const out = await addPartnerHouseRanks(fx.sheet, deps.qloo, { fixture: true });
        return { ...fx, sheet: out.sheet };
      } catch {
        return fx;
      }
    })();
    m.sheets.set(id, p);
  }
  return p;
}

/** True when the generated preset answered a needs_input pause on the operator's behalf. */
export function presetPausedInRecording(fx: PresetFixture): boolean {
  return fx.source === "engine" && /sample run picked .+ the way an operator would|pick for .+ was made by the generator/i.test(fx.note);
}

/** The pause a preset's run reaches before the operator picks (fixture world, computed once). */
export function presetPause(id: string): Promise<PauseData | null> {
  const m = memo();
  let p = m.pauses.get(id);
  if (!p) {
    p = (async () => {
      const preset = presetById(id);
      if (!preset) return null;
      try {
        const deps = pinnedFixtureDeps(`pause:${id}`, Date.parse(`${presetFor(preset, "fixture").asOf}T15:00:00Z`));
        const r = await planShow({ presetId: id, planId: id }, deps, { persist: false });
        if (r.status !== "needs_input" || !r.pause) return null;
        return { resolution: r.pause.resolution, pending: r.pause.pending, bill: r.pause.bill, operator: r.pause.operator, ledger: r.pause.ledger };
      } catch {
        return null;
      }
    })();
    m.pauses.set(id, p);
  }
  return p;
}

function sheetFromStored(s: StoredPlan, source: SheetView["source"]): SheetView | null {
  if (!s.sheet) return null;
  // A run that may not stand for its preset keeps the preset only in its request.
  const presetId = s.presetId ?? (typeof s.request?.presetId === "string" ? s.request.presetId : undefined);
  return {
    kind: "sheet",
    planId: s.planId,
    sheet: s.sheet,
    note: null,
    source,
    ...(presetId ? { presetId } : {}),
    title: presetTitle(presetId, s.mode, s.sheet.bill) ?? billTitle(s.sheet.bill),
  };
}

/**
 * The stored run every visitor sees as a preset in live mode: the latest complete run made by
 * the deps that run live presets now (a run stored while the server was in fixture mode does
 * not count), with the preset's own inputs (no what-ifs, partner lists or up-front picks, no
 * proxy), of the event the preset's live show names now (a run recorded before that show
 * changed does not count). Anything else leaves the bundled sheet in place, or lets a fresh
 * run start.
 */
export async function storedPresetRun(id: string): Promise<StoredPlan | null> {
  const preset = presetById(id);
  const stored = preset ? await stores().plans.latestForPreset(id) : null;
  if (!preset || !stored?.sheet || !isCanonicalRequest(stored.request as WebPlanRequest)) return null;
  const mode = resolveMode(depsFor("live"));
  return stored.mode === mode && presetShowOf(preset, mode, stored.sheet.bill) ? stored : null;
}

export async function loadPlan(id: string, opts: LoadOptions): Promise<LoadedPlan | null> {
  if (!PLAN_ID_RE.test(id)) return null;
  const mode = runtimeMode().kind;
  const withActions = (v: LoadedPlan): LoadedPlan => {
    if (v.kind !== "sheet") return v;
    // An older stored sheet may carry a Google Places list; it is no longer shown or handed out.
    return { ...v, sheet: withSessionActions(withoutControl(v.sheet), opts.sessionId ?? null) };
  };

  if (isPresetId(id) || isLiveOnlyPresetId(id)) {
    // Live: the stored run live presets are served from. Recorded: the latest usable live recording.
    const stored = mode === "live" ? await storedPresetRun(id) : mode === "recorded" ? await recordedPresetRun(id) : null;
    const v = stored ? sheetFromStored(stored, "store") : null;
    if (v) return withActions(v);
    // A live-only preset has no bundled sample to fall back on.
    if (!isPresetId(id)) return null;
    const fxPromise = presetSheet(id);
    if (!fxPromise) return null;
    const fx = await fxPromise;
    if (opts.view === "page" && mode === "fixture" && presetPausedInRecording(fx)) {
      const pause = await presetPause(id);
      if (pause) return { kind: "paused", planId: id, mode, presetId: id, title: fx.title, pause, source: "preset" };
    }
    return withActions({
      kind: "sheet",
      planId: id,
      sheet: fx.sheet,
      note: fx.note,
      source: "preset",
      fixtureSource: fx.source,
      presetId: id,
      title: fx.title,
    });
  }

  const run = getRun(id);
  if (run) {
    const runBill = run.sheet?.bill ?? run.bill;
    const title = presetTitle(run.presetId, run.mode, runBill) ?? (run.presetId && runBill ? billTitle(runBill) : run.title);
    const base = { planId: id, mode: run.mode, title, ...(run.presetId ? { presetId: run.presetId } : {}) };
    if (run.status === "running") return { kind: "running", ...base, cards: [...run.cards] };
    if (run.status === "error") return { kind: "error", planId: id, mode: run.mode, title, error: run.error ?? "The run stopped." };
    if (run.status === "needs_input" && run.pending && run.resolution && run.bill) {
      const ledger = run.result?.pause?.ledger ?? [];
      return { kind: "paused", ...base, pause: { resolution: run.resolution, pending: run.pending, bill: run.bill, operator: null, ledger }, source: "run" };
    }
    if (run.status === "complete" && run.sheet) {
      // The stored copy carries actions recorded after the run (A# sends).
      const stored = await stores().plans.get(id);
      const sheet = stored?.sheet ?? run.sheet;
      return withActions({ kind: "sheet", ...base, sheet, note: null, source: "run" });
    }
  }

  const stored = await stores().plans.get(id);
  if (!stored) return null;
  if (stored.status === "complete") {
    const v = sheetFromStored(stored, "store");
    return v ? withActions(v) : null;
  }
  if (stored.status === "needs_input" && stored.pause) {
    return {
      kind: "paused",
      planId: id,
      mode: stored.mode,
      ...(stored.presetId ? { presetId: stored.presetId } : {}),
      title: presetTitle(stored.presetId, stored.mode, stored.pause.bill) ?? billTitle(stored.pause.bill),
      pause: { resolution: stored.pause.resolution, pending: stored.pause.pending, bill: stored.pause.bill, operator: stored.pause.operator, ledger: stored.pause.ledger },
      source: "store",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/** `recorded`: the server serves recorded sheets only, so a live sheet's envelope says mode "recorded". */
export function envelopeOf(v: LoadedPlan, origin: string, opts: { recorded?: boolean } = {}): unknown {
  switch (v.kind) {
    case "sheet":
      return { ...sheetEnvelope(v.sheet, origin, opts), source: v.source };
    case "paused":
      return pausedEnvelope({ planId: v.planId, mode: v.mode, resolution: v.pause.resolution, pending: v.pause.pending }, origin);
    case "running":
      return {
        status: "running",
        summary: `Planning: ${v.cards.length} of 9 cards ready.`,
        planId: v.planId,
        mode: v.mode,
        planUrl: `${origin}/plan/${v.planId}`,
        streamUrl: `${origin}/api/plan/${v.planId}/stream`,
        results: null,
        cards: Object.fromEntries(v.cards.map((c) => [c.key, c.envelope.status])),
      };
    case "error":
      return errorEnvelope(v.planId, v.mode, v.error);
  }
}

function runEnvelope(run: RunState, origin: string): unknown {
  if (run.status === "complete" && run.sheet) return sheetEnvelope(run.sheet, origin);
  if (run.status === "needs_input" && run.resolution && run.pending) {
    return pausedEnvelope({ planId: run.planId, mode: run.mode, resolution: run.resolution, pending: run.pending }, origin);
  }
  if (run.status === "error") return errorEnvelope(run.planId, run.mode, run.error ?? "The run stopped.");
  return accepted(run, origin);
}

function accepted(run: RunState, origin: string, fresh?: FreshRunStatus | null) {
  return {
    status: "running",
    summary: "Planning. Cards stream from streamUrl; the sheet opens at planUrl.",
    planId: run.planId,
    mode: run.mode,
    planUrl: `${origin}/plan/${run.planId}`,
    streamUrl: `${origin}/api/plan/${run.planId}/stream`,
    sheetUrl: `${origin}/s/${run.planId}`,
    results: null,
    ...(fresh ? { freshRuns: freshRunsBody(fresh) } : {}),
  };
}

export function freshRunsBody(s: FreshRunStatus) {
  return { youRemaining: s.you.remaining, youLimit: s.you.limit, todayRemaining: s.total.remaining, todayLimit: s.total.limit, day: s.day };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

interface LaunchInput {
  request: WebPlanRequest;
  mode: "live" | "fixture";
  ctx: RequestContext;
  title: string;
  /** The fresh-run slot this run used (refunded when it fails before calling Qloo). */
  counted: FreshRunStatus | null;
}

function launch(i: LaunchInput): RunState {
  const base = depsFor(i.mode);
  const deps: PlanDeps = { ...base, choices: sessionChoices(stores().choices, i.ctx.sessionId) };
  return startRun({
    request: i.request,
    deps,
    mode: i.mode,
    title: i.title,
    enrich: async (sheet) => (await addPartnerHouseRanks(sheet, deps.qloo, { fixture: i.mode === "fixture" })).sheet,
    onFinish: (run) => {
      if (i.mode !== "live") return;
      publishLiveQuota(deps);
      if (i.counted && run.status === "error" && (run.result?.budget.qlooFresh ?? 0) === 0) freshRuns().refund(i.ctx.ip, i.counted.day);
    },
  });
}

async function respond(run: RunState, wait: Wait, ctx: RequestContext, fresh: FreshRunStatus | null, shape?: (env: unknown) => unknown): Promise<ServiceResponse> {
  if (wait === "none") return { status: 202, body: accepted(run, ctx.origin, fresh) };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((res) => {
    timer = setTimeout(() => res(null), SYNC_WAIT_MS);
  });
  const done = await Promise.race([run.done, timeout]);
  if (timer) clearTimeout(timer);
  if (!done) return { status: 202, body: accepted(run, ctx.origin, fresh) };
  const env = runEnvelope(done, ctx.origin) as Record<string, unknown>;
  const body = shape ? shape(env) : env;
  return { status: 200, body: fresh ? { ...(body as Record<string, unknown>), freshRuns: freshRunsBody(freshRuns().status(ctx.ip)) } : body };
}

function splitPicks(picks: Pick[]): { resolutions: Record<string, string>; proxyPicks: Record<string, string> } {
  const resolutions: Record<string, string> = {};
  const proxyPicks: Record<string, string> = {};
  for (const p of picks) {
    resolutions[p.input] = p.entityId;
    if (p.proxy) proxyPicks[p.input] = p.entityId;
  }
  return { resolutions, proxyPicks };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** For rank-partners: the envelope narrowed to the operator's own list. */
function declaredOnly(env: unknown): unknown {
  const e = env as { results?: StreetSheet | null } & Record<string, unknown>;
  const sheet = e.results;
  if (!sheet || typeof sheet !== "object" || !("cards" in sheet)) return env;
  const card = sheet.cards.declared;
  return {
    ...e,
    status: card.status,
    summary: card.summary,
    results: card.results,
    ...(card.reason ? { reason: card.reason } : {}),
    provenance: card.provenance,
    limits: [...card.limits, ...sheet.limits],
  };
}

/** POST /api/plan (and /api/rank-partners with `partners`). */
export async function startPlan(raw: unknown, ctx: RequestContext, opts: { rankPartners?: boolean; operator?: boolean } = {}): Promise<ServiceResponse> {
  const parsed = parsePlanBody(raw, ALL_PRESET_IDS);
  if (!parsed.ok) return { status: 400, body: { reason: parsed.reason } };
  const body = parsed.value;
  if (opts.rankPartners && !body.partners) return { status: 400, body: { reason: "partners: list the partner names to rank (1 to 20)." } };
  const mode = runtimeMode();
  if (mode.kind === "recorded") return recordedRefusal();
  const presetId = body.presetId;
  if (body.rerecord) {
    if (!opts.operator) return { status: 403, body: { reason: "Re-recording a preset needs the operator token." } };
    if (mode.kind !== "live") return { status: 409, body: { mode: mode.kind, reason: "Only a live server re-records a preset." } };
  }

  if (!presetId && mode.kind === "fixture") return { status: 503, body: { mode: "fixture", reason: FIXTURE_FRESH_RUNS_REASON } };
  if (presetId && isLiveOnlyPresetId(presetId) && mode.kind === "fixture") {
    return { status: 503, body: { mode: "fixture", reason: `${presetId} plans a real show only, and this copy of Walkup runs without keys.` } };
  }
  if (mode.kind === "fixture") {
    const limited = fixtureRunAllowed(ctx);
    if (limited) return limited;
  }

  const operator: Partial<OperatorInputs> = { ...body.operator };
  if (body.partners) operator.declaredPartners = body.partners.map((label) => ({ label }));
  const overrides = Object.keys(operator).length > 0 || body.picks.length > 0;

  // Live presets: the stored run is served when nothing is overridden (unlimited), unless the operator re-records.
  if (presetId && mode.kind === "live" && !overrides && !body.rerecord) {
    const stored = await storedPresetRun(presetId);
    const v = stored ? sheetFromStored(stored, "store") : null;
    if (v) {
      const env = { ...sheetEnvelope(v.sheet, ctx.origin), servedFromStore: true };
      return { status: 200, body: opts.rankPartners ? declaredOnly(env) : env };
    }
  }

  let counted: FreshRunStatus | null = null;
  let tmEventId = body.tmEventId;
  if (mode.kind === "live") {
    const deps = depsFor("live");
    if (deps.qloo.guardTripped()) {
      return { status: 429, body: { reason: "Qloo's monthly quota is at its safety floor, so fresh runs are paused. Presets are served from stored runs." } };
    }
    const st = freshRuns().status(ctx.ip);
    if (!st.allowed) return { status: 429, body: { reason: st.reason, freshRuns: freshRunsBody(st) } };
    if (body.freeText) {
      let hits;
      try {
        hits = (await searchShows(deps, body.freeText, todayIso())).hits;
      } catch (err) {
        return { status: 502, body: { reason: `Ticketmaster search failed: ${err instanceof Error ? err.message : String(err)}` } };
      }
      if (hits.length === 0) return { status: 404, body: { reason: `No upcoming Ticketmaster event matches "${body.freeText}". Paste the event's Ticketmaster URL instead.` } };
      if (hits.length > 1) {
        return {
          status: 409,
          body: { reason: `${hits.length} Ticketmaster events match "${body.freeText}". Send the one you mean as tmEventId (or its URL).`, events: hits },
        };
      }
      tmEventId = hits[0]?.tmEventId;
    }
    counted = freshRuns().take(ctx.ip);
    if (!counted.allowed) return { status: 429, body: { reason: counted.reason, freshRuns: freshRunsBody(counted) } };
  }

  const { resolutions, proxyPicks } = splitPicks(body.picks);
  const planId = randomUUID();
  const request: WebPlanRequest = {
    planId,
    ...(presetId ? { presetId } : { tmEventId: tmEventId as string }),
    ...(Object.keys(operator).length > 0 ? { operator } : {}),
    ...(Object.keys(resolutions).length > 0 ? { resolutions } : {}),
    ...(Object.keys(proxyPicks).length > 0 ? { proxyPicks } : {}),
    ...(overrides ? { customInputs: true } : {}),
  };
  const title = presetTitle(presetId, mode.kind) ?? `Ticketmaster event ${tmEventId}`;
  const run = launch({ request, mode: mode.kind, ctx, title, counted });
  return respond(run, body.wait, ctx, counted, opts.rankPartners ? declaredOnly : undefined);
}

/** POST /api/plan/<id>/resolve: the operator's pick(s) for a paused plan. */
export async function resolvePlan(id: string, raw: unknown, ctx: RequestContext): Promise<ServiceResponse> {
  if (!PLAN_ID_RE.test(id)) return { status: 400, body: { reason: "Plan ids match ^[A-Za-z0-9_-]{1,64}$." } };
  const runtime = runtimeMode().kind;
  if (runtime === "recorded") return recordedRefusal();
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const parsed = parsePicks(obj.picks ?? obj.resolutions);
  if (!parsed.ok) return { status: 400, body: { reason: parsed.reason } };
  const picks = parsed.value;
  if (picks.length === 0) return { status: 400, body: { reason: "Send picks: [{input, entityId}] for the names waiting for a pick." } };
  const wait: Wait = obj.wait === "complete" ? "complete" : "none";

  const loaded = await loadPlan(id, { view: "page", sessionId: ctx.sessionId });
  if (!loaded) return { status: 404, body: { reason: `No plan with id ${id}.` } };
  if (loaded.kind === "running") return { status: 409, body: { reason: "This plan is still running." } };
  if (loaded.kind === "error") return { status: 409, body: { reason: `This run stopped: ${loaded.error}` } };
  if (loaded.kind === "sheet") return { status: 409, body: { reason: "This plan is complete; nothing is waiting for a pick." } };

  const pending = new Map(loaded.pause.pending.map((p) => [p.input, p]));
  for (const p of picks) {
    const row = pending.get(p.input);
    if (!row) return { status: 400, body: { reason: `"${p.input}" is not waiting for a pick. Waiting: ${[...pending.keys()].join(", ") || "nothing"}.` } };
    if (!p.proxy && !row.candidates.some((c) => c.entityId === p.entityId)) {
      return { status: 400, body: { reason: `Pick one of the candidates shown for "${p.input}", or choose "None of these: use a proxy".` } };
    }
  }
  if (loaded.mode === "live" && runtime !== "live") return { status: 409, body: { reason: "This live plan cannot resume while the server is in fixture mode." } };

  const { resolutions, proxyPicks } = splitPicks(picks);
  let request: WebPlanRequest;
  let mode: "live" | "fixture";
  if (loaded.source === "preset") {
    // A preset's recorded pause: answering it starts a new run of the preset with the pick.
    mode = runtime;
    if (mode === "fixture") {
      const limited = fixtureRunAllowed(ctx);
      if (limited) return limited;
    }
    request = {
      planId: randomUUID(),
      presetId: id,
      resolutions,
      ...(Object.keys(proxyPicks).length > 0 ? { proxyPicks } : {}),
    };
  } else {
    const stored = await stores().plans.get(id);
    if (!stored) return { status: 404, body: { reason: `Plan ${id} is no longer stored; start it again.` } };
    const prev = stored.request as WebPlanRequest;
    mode = stored.mode;
    const mergedProxy = { ...(prev.proxyPicks ?? {}), ...proxyPicks };
    for (const p of picks) if (!p.proxy) delete mergedProxy[p.input];
    request = {
      ...prev,
      planId: id,
      resolutions: { ...(prev.resolutions ?? {}), ...resolutions },
      ...(Object.keys(mergedProxy).length > 0 ? { proxyPicks: mergedProxy } : {}),
    };
  }
  const run = launch({ request, mode, ctx, title: loaded.title, counted: null });
  return respond(run, wait, ctx, null);
}

/** GET /api/plan/<id>: where a plan stands (for clients that poll instead of streaming). */
export async function planSnapshot(id: string, ctx: RequestContext): Promise<ServiceResponse> {
  if (!PLAN_ID_RE.test(id)) return { status: 400, body: { reason: "Plan ids match ^[A-Za-z0-9_-]{1,64}$." } };
  const v = await loadPlan(id, { view: "api", sessionId: ctx.sessionId });
  if (!v) return { status: 404, body: { reason: `No plan with id ${id}.` } };
  const base = { planId: v.planId, planUrl: `${ctx.origin}/plan/${v.planId}`, streamUrl: `${ctx.origin}/api/plan/${v.planId}/stream` };
  switch (v.kind) {
    case "sheet": {
      // Recorded state: a live sheet is a recording (the mode its envelope reports too).
      const mode = v.sheet.mode === "live" && runtimeMode().kind === "recorded" ? "recorded" : v.sheet.mode;
      // sheetUrl is the street-team page, as in every other answer; the JSON envelope has its own field.
      return { status: 200, body: { ...base, status: "complete", mode, sheetUrl: `${ctx.origin}/s/${v.planId}`, envelopeUrl: `${ctx.origin}/api/sheet/${v.planId}` } };
    }
    case "paused":
      return { status: 200, body: { ...base, status: "needs_input", mode: v.mode, pending: v.pause.pending, resolveUrl: `${ctx.origin}/api/plan/${v.planId}/resolve` } };
    case "running":
      return { status: 200, body: { ...base, status: "running", mode: v.mode, cards: v.cards.map((c) => ({ key: c.key, status: c.envelope.status })) } };
    case "error":
      return { status: 200, body: { ...base, status: "error", mode: v.mode, reason: v.error } };
  }
}
