/**
 * planShow(): one Street Sheet, end to end (spec section 6.2, steps 1-8 up to
 * the human-confirmed action, which lives in the web app).
 *
 *  1. Intake: Ticketmaster event (or an operator-entered bill) + what-ifs.
 *  2. Resolve (Q1-Q3); ambiguity pauses the run with needs_input.
 *  3. Plan graph (Q4-Q14), each node with its coded fallback and status.
 *  4. Score with @walkup/engine (lift, partners, pre/post, budget).
 *  5. Balance check (probe-gated).
 *  6. Narrate with @walkup/narrator (template without a model).
 *  7. Guards: narrator guard for operator lines, engine guard for fan-facing copy.
 *  8. Sheet extras, from data already fetched (no extra calls): "why this
 *     place" on every partner, the step stream (`sheet.steps`, also streamed
 *     through opts.onStep) and the discovery picked by a fixed rule.
 * Cards stream through opts.onCard in CARD_ORDER.
 */
import { randomUUID } from "node:crypto";
import {
  createMemoryLedger,
  LIMITS_EVERY_SHEET,
  withoutControl,
  type Bill,
  type DeclaredPartner,
  type Envelope,
  type OperatorInputs,
  type QlooTag,
  type StreetSheet,
  type StreetSheetCards,
} from "@walkup/contracts";
import { annotateTile } from "@walkup/gazetteer";
import { tryToBill } from "@walkup/tm";
import { callBudget } from "./budget";
import { emit, failure, node, type RunContext } from "./context";
import { createRunLedger } from "./ledger";
import { deniedReceipt } from "./policy";
import { NO_LIVE_SHOW, presetById, presetFor, presetShowOf, type Preset, type PresetShow } from "./presets";
import { splitBudget, type BudgetShare } from "./steps/budget";
import { honestWording, partnerLinesWithinTags, runCopy, tidyAreaPhrases } from "./steps/copy";
import { runDeclared } from "./steps/declared";
import { discoverFor } from "./steps/discovery";
import { explainPartners } from "./steps/explain";
import { genreBaselinePhrase, runHeat } from "./steps/heat";
import { runMedia } from "./steps/media";
import { runPartners, type PartnersResult } from "./steps/partners";
import { runPrePost } from "./steps/prepost";
import { runCompare, runDemographics } from "./steps/profile";
import { resolveAll } from "./steps/resolve";
import {
  baselineTrace,
  checkTrace,
  createTrace,
  declaredTrace,
  guardTrace,
  heatTrace,
  mediaTrace,
  narrateTrace,
  partnersTrace,
  popularityTrace,
  prePostTrace,
  resolveTrace,
  usualCrowdTrace,
} from "./steps/trace";
import { diffSheets } from "./revise/diff";
import type { StoredPlan } from "./store";
import { EMPTY_PINS } from "./tags";
import {
  CARD_ORDER,
  DEFAULT_PROBES,
  type CallBudget,
  type GazetteerLike,
  type PlanDeps,
  type PlanOptions,
  type PlanRequest,
  type PlanResult,
} from "./types";

export const FIXTURE_LIMITS = [
  "Sample data: made-up places and numbers; no live service was called.",
  "Venue points for rooms without a public map point are approximate in sample data.",
] as const;

const DEFAULT_GAZETTEER: GazetteerLike = { annotateTile: (t) => annotateTile(t) };

export function resolveMode(deps: PlanDeps): "live" | "fixture" {
  return deps.mode === "live" && deps.qloo.mode === "live" ? "live" : "fixture";
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function defaultOperator(bill: Bill | null): OperatorInputs {
  return {
    seatsLeft: null,
    capacity: null,
    mediaBudgetUsd: null,
    streetTeamDays: bill ? [bill.weekday] : [],
    radiusKm: 40,
    declaredPartners: [],
  };
}

function mergeOperator(base: OperatorInputs, ...over: (Partial<OperatorInputs> | undefined)[]): OperatorInputs {
  const out: OperatorInputs = { ...base };
  for (const o of over) {
    if (!o) continue;
    for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  }
  if (out.streetTeamDays.length === 0 && base.streetTeamDays.length > 0) out.streetTeamDays = base.streetTeamDays;
  if (!(out.radiusKm >= 1)) out.radiusKm = 40;
  return out;
}

function stripContact(d: DeclaredPartner): DeclaredPartner {
  return d.qlooEntityId ? { label: d.label, qlooEntityId: d.qlooEntityId } : { label: d.label };
}

/** Operator-typed contact emails are used only by the confirm-gated send; sheets and stored plans never hold them. */
export function withoutContacts(op: OperatorInputs): OperatorInputs {
  return { ...op, declaredPartners: op.declaredPartners.map(stripContact) };
}

function storedRequest(r: PlanRequest): PlanRequest {
  const dp = r.operator?.declaredPartners;
  return dp ? { ...r, operator: { ...r.operator, declaredPartners: dp.map(stripContact) } } : r;
}

function emptyBudget(): CallBudget {
  return { qlooFresh: 0, qlooCached: 0, qlooTotal: 0, billLevel: 0, venueLevel: 0, arms: 0, tm: 0, places: 0, anthropic: 0, byNode: {} };
}

async function safe<T>(fn: () => Promise<T>, onError: (err: unknown) => T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return onError(err);
  }
}

/** Sheet extras never break a run: a failure leaves that part out. */
function quiet<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * `opts.onStep` streams each step of `sheet.steps` as the run reaches it.
 * `opts.revise` (set by the revise loop) puts the revise step first and fills
 * `sheet.revision` with the differences from the parent sheet.
 */
export async function planShow(request: PlanRequest, deps: PlanDeps, opts: PlanOptions = {}): Promise<PlanResult> {
  const now = deps.clock ?? (() => Date.now());
  const idGen = deps.idGen ?? (() => randomUUID());
  const mode = resolveMode(deps);
  const sources = [request.tmEventId, request.presetId, request.bill].filter((x) => x !== undefined).length;
  const planId = request.planId ?? idGen();
  const errorResult = (msg: string, extra: Partial<PlanResult> = {}): PlanResult => ({
    status: "error",
    planId,
    mode,
    error: msg,
    budget: emptyBudget(),
    citations: {},
    servedFromStore: false,
    ...extra,
  });
  if (sources !== 1) return errorResult("A plan request needs exactly one of tmEventId, presetId or bill.");

  let preset: Preset | null = null;
  let show: PresetShow | null = null;
  if (request.presetId) {
    preset = presetById(request.presetId);
    if (!preset) return errorResult(`Unknown preset ${request.presetId}.`);
    // A live run plans the preset's live show. Without one it stops here, before any call.
    show = presetFor(preset, mode);
    if (!show) return errorResult(NO_LIVE_SHOW);
  }

  // Quota guard: fresh runs stop; a preset is served from the last stored sheet of its current show.
  if (preset && deps.store && deps.qloo.guardTripped() && opts.serveFromStoreWhenGuarded !== false) {
    const stored = await deps.store.latestForPreset(preset.id);
    if (stored?.sheet && stored.sheet.mode === mode && presetShowOf(preset, mode, stored.sheet.bill)) {
      // Stream the stored cards too, so a listener sees the same order as a fresh run.
      for (const key of CARD_ORDER) {
        try {
          opts.onCard?.(key, stored.sheet.cards[key] as Envelope<unknown>);
        } catch {
          // A failing listener never breaks the run.
        }
      }
      return {
        status: "complete",
        planId: stored.planId,
        mode: stored.mode,
        // An older stored sheet may carry a Google Places list; it is no longer shown.
        sheet: withoutControl(stored.sheet),
        budget: stored.budget ?? emptyBudget(),
        citations: stored.citations ?? {},
        servedFromStore: true,
        presetId: preset.id,
      };
    }
  }

  const base = deps.ledger ? deps.ledger() : createMemoryLedger();
  const ledger = createRunLedger(base, { fixture: mode === "fixture" });
  const tm = deps.tm ? deps.tm(ledger) : null;

  // ---- 1. Intake -------------------------------------------------------------
  let bill: Bill | null = request.bill ?? null;
  const tmEventId = request.tmEventId ?? show?.tmEventId;
  if (!bill && tmEventId) {
    if (!tm) return errorResult("A Ticketmaster event needs a Ticketmaster client.");
    ledger.node("T intake", "intake");
    try {
      const ev = await tm.getEvent(tmEventId);
      if (!ev.data) return errorResult(`Ticketmaster event ${tmEventId} was not found.`);
      const mapped = tryToBill(ev.data);
      if (!mapped.bill) return errorResult(`Cannot build a bill from event ${tmEventId}: ${mapped.issues.join("; ")}`);
      bill = mapped.bill;
    } catch (err) {
      return errorResult(`Ticketmaster lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!bill) return errorResult("No bill to plan.");
  const operator = withoutContacts(mergeOperator(defaultOperator(bill), show?.operator, request.operator));
  const asOf = request.asOf ?? show?.asOf ?? isoDate(now());

  const ctx: RunContext = {
    request,
    options: opts,
    ledger,
    qloo: deps.qloo.withLedger(ledger),
    tm,
    gazetteer: deps.gazetteer ?? DEFAULT_GAZETTEER,
    narrator: deps.narrator ?? { client: null },
    pins: deps.tags ?? EMPTY_PINS,
    probes: { ...DEFAULT_PROBES, ...deps.probes },
    mode,
    now,
    planId,
    asOf,
    bill,
    operator,
    seeds: request.seeds ?? preset?.seeds ?? [],
    categories: request.categories ?? preset?.categories ?? null,
    cards: {},
    citations: new Map(),
    limits: [],
    guardReasons: [],
    seenTags: [],
    personTagsStripped: false,
    thinSignal: false,
    billHeatRef: null,
  };
  const presetId = preset?.id;
  const persist = async (rec: StoredPlan) => {
    if (deps.store && opts.persist !== false) await deps.store.put(rec);
  };

  // ---- 2. Resolve --------------------------------------------------------------
  const trace = createTrace(opts.onStep);
  if (opts.revise) trace.add(opts.revise.step);
  const resolved = await resolveAll(ctx, deps.choices);
  emit(ctx, "resolution", resolved.card);
  trace.add(...quiet(() => resolveTrace(ctx, resolved), []));
  if (resolved.pending.length > 0) {
    const pause = { resolution: resolved.card, pending: resolved.pending, bill: ctx.bill, operator, ledger: ledger.entries() };
    const budget = callBudget(ledger.entries(), ledger);
    await persist({ planId, createdAt: new Date(now()).toISOString(), mode, status: "needs_input", ...(presetId ? { presetId } : {}), request: storedRequest(request), pause, budget });
    return { status: "needs_input", planId, mode, pause, budget, citations: Object.fromEntries(ctx.citations), servedFromStore: false, ...(presetId ? { presetId } : {}) };
  }
  if (resolved.card.status === "error") {
    return errorResult(resolved.card.reason ?? "Resolution failed.", { budget: callBudget(ledger.entries(), ledger), ledger: ledger.entries() });
  }
  const seeds = resolved.seeds;

  // ---- 3-4. Plan graph and scoring -------------------------------------------------
  const heat = await runHeat(ctx, seeds, resolved.house);
  emit(ctx, "liftMap", heat.card);
  // On a genre-tag baseline, every step names the genre ("comedy fans in general").
  const genre = genreBaselinePhrase(ctx.bill.classification);
  if (heat.card.results.diagnostics.baseline === "tag") trace.setWording((s) => s.replace(/\b(fans of )?the genre baseline( in general)?\b/g, genre));
  trace.add(
    quiet(() => baselineTrace(ctx, resolved, heat), null),
    quiet(() => heatTrace(ctx, heat), null),
    quiet(() => checkTrace(ctx, heat), null),
  );
  const budgetSplit: BudgetShare[] = splitBudget(heat.spread);

  const partners: PartnersResult = await safe(
    () => runPartners(ctx, seeds, heat.spread, heat.liftWeak, resolved.venueEntityId, resolved.house),
    (err) => ({ card: failure(err, [], "Partners"), partners: [], report: null, pools: [], poolSpecs: [], categories: [] }),
  );
  // "Why this place" on every partner, before the card streams.
  const thinPartners = ctx.thinSignal || heat.thin || heat.widened || partners.partners.length < 15;
  const explained = quiet(() => explainPartners(ctx, partners, seeds, { thinSignal: thinPartners }), partners.partners);
  partners.partners = explained;
  partners.card = { ...partners.card, results: explained };
  emit(ctx, "partners", partners.card);
  trace.add(
    quiet(() => partnersTrace(ctx, partners), null),
    quiet(() => usualCrowdTrace(ctx, resolved, heat, partners), null),
    quiet(() => popularityTrace(partners), null),
  );

  const declared = await safe(() => runDeclared(ctx, seeds), (err) => failure(err, [], "Your list, in call order"));
  emit(ctx, "declared", declared);
  trace.add(quiet(() => declaredTrace(ctx, declared), null));
  // The partner pools ride along so a name seen at 3+ places reads as a chain on the pre/post list too.
  const seenPlaces = partners.pools.flatMap((p) => p.entities);
  const prePost = await safe(() => runPrePost(ctx, seeds, resolved.house, resolved.venueEntityId, seenPlaces), (err) => failure(err, [], "Before and after the show"));
  emit(ctx, "prePost", prePost);
  trace.add(quiet(() => prePostTrace(ctx, prePost), null));
  const media = await safe(() => runMedia(ctx, seeds), (err) => failure(err, [], "Podcasts and a sponsor"));
  emit(ctx, "media", media);
  trace.add(quiet(() => mediaTrace(ctx, media), null));
  emit(ctx, "demographics", await safe(() => runDemographics(ctx, seeds, resolved.house), (err) => failure(err, { bill: [], house: [] }, "Age mix")));
  const compare = await safe(() => runCompare(ctx, seeds, resolved.house), (err) => failure(err, { shared: [], a: [], b: [], fromTagDiff: false }, "How this crowd differs"));
  emit(ctx, "whatsDifferent", compare);

  // ---- 6-7. Narration and guards ------------------------------------------------------
  const rawPartnerTags: QlooTag[] = [];
  for (const pool of partners.pools) for (const e of pool.entities) rawPartnerTags.push(...e.tags);
  for (const t of rawPartnerTags) ctx.seenTags.push({ id: t.id, name: t.name });
  // Seats and capacity typed as what-ifs: the narration calls them what-ifs. The sheet itself is marked hypothetical
  // only on sample data: a live sheet is a real show, whatever capacity the operator assumed.
  const whatIfs = operator.seatsLeft !== null || operator.capacity !== null;
  const hypothetical = mode === "fixture" && whatIfs;
  const copy = await runCopy(ctx, {
    seeds,
    tiles: heat.spread.slice(0, 5),
    partners: partners.partners,
    rawPartnerTags,
    prePost: prePost.results,
    media: media.results,
    compare: compare.status === "ok" || compare.status === "degraded" ? compare.results : null,
    budget: budgetSplit,
    // Only a sample sheet's counts are what-ifs: a live sheet's capacity and budget are the operator's own inputs,
    // and the narration never calls them what-ifs.
    hypothetical,
  });
  emit(ctx, "copyHooks", copy.card);
  trace.add(quiet(() => narrateTrace(copy), null));

  // ---- Assemble -----------------------------------------------------------------------
  node(ctx, "assemble", "intake");
  const cards = ctx.cards as StreetSheetCards;
  const receipt = deniedReceipt(ctx.seenTags);
  const reasons = [...copy.guardReasons, ...ctx.guardReasons];
  if (receipt.line) reasons.unshift(receipt.line);
  if (ctx.personTagsStripped) reasons.push("Person-entity tags stripped before storage.");

  const limits: string[] = [...LIMITS_EVERY_SHEET];
  if (whatIfs) limits.push("Planning tool; no sales data for this show is known or shown.");
  if (ctx.thinSignal || heat.thin || heat.widened || partners.partners.length < 15) limits.push("Thin signal: treat as a starting list.");
  if (mode === "fixture") limits.push(...FIXTURE_LIMITS);
  limits.push(...ctx.limits);

  const entries = ledger.entries();
  const ledgerIds = new Set(entries.map((e) => e.id));
  // Citation check: every cited entity traces to a ledger entry of this run.
  const worded = honestWording(copy.narration, {
    tagBaseline: cards.liftMap.results.diagnostics.baseline === "tag",
    genre,
    localSponsor: media.results.some((m) => m.kind === "sponsor" && m.scope === "local"),
  });
  const areaNames = cards.liftMap.results.tiles.map((t) => t.name ?? "").filter(Boolean);
  const tidy = (t: string) => tidyAreaPhrases(t, areaNames);
  const narration = {
    ...worded,
    summary: tidy(worded.summary),
    tileWhy: worded.tileWhy.map((t) => ({ ...t, text: tidy(t.text) })),
    partnerLines: worded.partnerLines.map((l) => ({ ...l, text: tidy(l.text) })),
  };
  const citedIds = new Set([
    ...partners.partners.map((p) => p.entity.entityId),
    ...prePost.results.map((s) => s.entity.entityId),
    ...media.results.map((m) => m.entity.entityId),
  ]);
  let citationDrops = 0;
  const partnerLines = narration.partnerLines.filter((l) => {
    const ok = citedIds.has(l.entityId) && ledgerIds.has(ctx.citations.get(l.entityId) ?? "");
    if (!ok) citationDrops++;
    return ok;
  });
  if (citationDrops > 0) reasons.push(`${citationDrops} partner line(s) dropped: cited entity not traced to this run's ledger.`);
  // A partner line names only the tags listed under that partner's shared tags.
  const withinTags = partnerLinesWithinTags(partnerLines, partners.partners);
  if (withinTags.changed + withinTags.dropped > 0) {
    reasons.push(`${withinTags.changed + withinTags.dropped} partner line(s) trimmed: a tag the place doesn't list as shared was cut.`);
  }

  const sheet: StreetSheet = {
    planId,
    createdAt: new Date(now()).toISOString(),
    mode,
    hypothetical,
    bill: ctx.bill,
    operator,
    cards,
    narration: { ...narration, partnerLines: withinTags.lines },
    ledger: entries,
    guard: {
      dropped: copy.guardDropped + citationDrops,
      reasons,
      deniedTagCount: receipt.count,
      ...(receipt.count > 0 ? { deniedByNamespace: receipt.byClass } : {}),
    },
    limits,
  };
  if (budgetSplit.length > 0) sheet.budgetSplit = budgetSplit;
  if (partners.popularity?.check) sheet.popularityCheck = partners.popularity.check;
  const paired = request.pairedPlanId ?? preset?.pairedWith;
  if (paired) sheet.pairedPlanId = paired;

  // ---- 8. Sheet extras: the last steps, the step stream and the discovery ---------------------
  trace.add(quiet(() => guardTrace(sheet.guard, reasons, ctx.operator.allAges === true), null));
  sheet.steps = trace.steps();
  const discovery = quiet(() => discoverFor(ctx, heat, partners), null);
  if (discovery) sheet.discovery = discovery;
  if (opts.revise) {
    const rv = opts.revise;
    sheet.revision = {
      parentPlanId: rv.parent.planId,
      instruction: rv.instruction,
      interpreter: rv.interpreter,
      toolCalls: rv.toolCalls,
      changes: quiet(() => diffSheets(rv.parent, sheet, rv.settingRefs), []),
    };
  }

  const budget = callBudget(entries, ledger);
  const citations = Object.fromEntries([...ctx.citations.entries()].filter(([, ref]) => ledgerIds.has(ref)));
  const result: PlanResult = { status: "complete", planId, mode, sheet, budget, citations, servedFromStore: false, ...(presetId ? { presetId } : {}) };
  await persist({ planId, createdAt: sheet.createdAt, mode, status: "complete", ...(presetId ? { presetId } : {}), request: storedRequest(request), sheet, budget, citations });
  return result;
}
