/**
 * The step stream ("What Walkup decided"), from what the run already has: the
 * cards, the run results and the ledger. No Qloo calls. Each function returns
 * the step(s) for one part of the run; plan.ts adds them as the run reaches
 * that part (so `onStep` can stream them) and writes the list to
 * `sheet.steps`. The wording lives in @walkup/engine `steps.ts`.
 *
 * Numbers in the steps come from the sheet: card fields and summaries, ledger
 * result counts and parameters, and the lift card's diagnostics.
 */
import type { LedgerEntry, StreetSheet, StreetSheetCards, TraceStep } from "@walkup/contracts";
import {
  baselineStep,
  categoryWord,
  checkStep,
  declaredStep,
  guardStep,
  heatStep,
  LIFT_DEFAULTS,
  mediaStep,
  narrateStep,
  PARTNER_DEFAULTS,
  partnersStep,
  pauseStep,
  popularityStep,
  prePostStep,
  resolveStep,
  ubiquityDrops,
  usualCrowdStep,
} from "@walkup/engine";
import { normalizeName } from "@walkup/qloo";
import { categoryTagMap, categoryUrns, isComedyClassification } from "../tags";
import type { RunContext } from "../context";
import type { CopyResult } from "./copy";
import { MIN_BILL_PCT, MIN_SPLIT_HALF, SPLIT_HALF_NODE, THIN_CELLS, type HeatResult } from "./heat";
import {
  excludedCategoriesFor,
  HOUSE_TWIN_NODE,
  PARTNER_TILES,
  partnerCategories,
  POPULARITY_TWIN_NODE,
  streetDay,
  TILE_RADIUS_M,
  TILE_RADIUS_WIDE_M,
  type PartnersResult,
} from "./partners";
import { CALL_AHEAD_CHIP, MIN_SPOTS, PREPOST_RADIUS_M, prePostChainMoves, prePostTypeDrops } from "./prepost";
import { CHAINS } from "../chains";
import { HOUSE_MIN_RESOLVED, type ResolveResult } from "./resolve";

/** Streams each step as the run reaches it (SSE "step" events). */
export interface TraceOptions {
  onStep?: (step: TraceStep) => void;
}

export interface Trace {
  add(...steps: (TraceStep | null | undefined)[]): void;
  steps(): TraceStep[];
  /** Rewrites the words of every step added from now on (e.g. naming the genre on a tag baseline). */
  setWording(fn: (s: string) => string): void;
}

export function createTrace(onStep?: (step: TraceStep) => void): Trace {
  const list: TraceStep[] = [];
  let wording: ((s: string) => string) | null = null;
  return {
    setWording(fn) {
      wording = fn;
    },
    add(...steps) {
      for (const raw of steps) {
        if (!raw) continue;
        const w = wording;
        const s: TraceStep = w ? { ...raw, decision: w(raw.decision), ...(raw.cause ? { cause: w(raw.cause) } : {}) } : raw;
        list.push(s);
        try {
          onStep?.(s);
        } catch {
          // A failing listener (closed SSE stream) never breaks the run.
        }
      }
    },
    steps() {
      return [...list];
    },
  };
}

function ledgerIndex(ctx: RunContext): Map<string, LedgerEntry> {
  return new Map(ctx.ledger.entries().map((e) => [e.id, e]));
}

/** The node label the run ledger wrote into an entry's note ("node Q9 partners, tile 1; ..."). */
export function nodeOf(e: LedgerEntry | undefined): string {
  const m = /(?:^|; )node ([^;]+)/.exec(e?.note ?? "");
  return m?.[1]?.trim() ?? "";
}

function failed(e: LedgerEntry | undefined): boolean {
  return !!e && (e.envelopeStatus === "error" || e.envelopeStatus === "degraded");
}

/** The result count of the act search for a name (the last /search call whose query is that name). */
function searchCount(entries: readonly LedgerEntry[], name: string): number | null {
  const want = normalizeName(name);
  const hits = entries.filter((e) => e.endpoint === "/search" && typeof e.params.query === "string" && normalizeName(e.params.query) === want);
  const last = hits[hits.length - 1];
  return last ? last.resultCount : null;
}

// ---------------------------------------------------------------------------
// Resolve: the pause (when a name was picked or still waits) and the acts
// ---------------------------------------------------------------------------

export function resolveTrace(ctx: RunContext, resolved: ResolveResult): TraceStep[] {
  const entries = ctx.ledger.entries();
  const byId = new Map(entries.map((e) => [e.id, e]));
  const rows = resolved.card.results;
  const steps: TraceStep[] = [];
  let pauseIndex = 0;
  const picks = ctx.request.resolutions ?? {};
  const pendingNames = resolved.pending.map((p) => p.input);
  for (const act of ctx.bill.acts) {
    const row = rows.find((r) => r.input === act.name);
    if (pendingNames.includes(act.name)) {
      pauseIndex++;
      steps.push(pauseStep({ name: act.name, matches: searchCount(entries, act.name), answered: false, ledgerRefs: row?.ledgerRef ? [row.ledgerRef] : [], index: pauseIndex }));
    } else if (picks[act.name] && row?.entity) {
      pauseIndex++;
      steps.push(pauseStep({ name: act.name, matches: searchCount(entries, act.name), answered: true, ledgerRefs: row.ledgerRef ? [row.ledgerRef] : [], index: pauseIndex }));
    }
  }
  const acts = ctx.bill.acts.map((act) => {
    const row = rows.find((r) => r.input === act.name);
    const matched = !!row && (row.status === "exact" || row.status === "proxy") && !resolved.missingActs.includes(act.name);
    if (matched || pendingNames.includes(act.name)) return { name: act.name, matched };
    const e = row?.ledgerRef ? byId.get(row.ledgerRef) : undefined;
    const reason = resolved.noDataActs.includes(act.name)
      ? "Qloo lists this name but has no taste data for it"
      : !e
      ? "no exact match"
      : failed(e)
        ? "the search failed"
        : e.resultCount === 0
          ? "not in Qloo's catalog"
          : act.isComedian
            ? "no exact match tagged as a comedian"
            : "no exact match";
    return { name: act.name, matched, reason };
  });
  const houseRefs = new Set(resolved.house.ledgerRefs);
  const viaTitles = [...new Set(resolved.seeds.filter((s) => s.kind === "proxy").map((s) => s.act))];
  steps.push(
    resolveStep({
      acts,
      pending: pendingNames,
      thin: resolved.thinActs.filter((n) => !resolved.missingActs.includes(n)),
      viaTitles,
      swapped: resolved.swappedActs,
      venueMatched: resolved.venueEntityId !== null,
      status: resolved.card.status,
      ledgerRefs: resolved.card.provenance.filter((r) => !houseRefs.has(r)),
    }),
  );
  return steps;
}

// ---------------------------------------------------------------------------
// Baseline, lift map and the map check
// ---------------------------------------------------------------------------

export function baselineTrace(ctx: RunContext, resolved: ResolveResult, heat: HeatResult): TraceStep {
  const byId = ledgerIndex(ctx);
  const house = resolved.house;
  const rosterRef = house.ledgerRefs.find((r) => r.startsWith("T"));
  const shows = rosterRef ? (byId.get(rosterRef)?.resultCount ?? null) : null;
  const mapBaseline = heat.card.results.diagnostics.baseline;
  let heatFallback: string | null = null;
  if (house.baseline === "house" && mapBaseline === "tag") {
    const q5 = ctx.ledger.entries().find((e) => nodeOf(e) === "Q5 house heat");
    heatFallback = q5 && !failed(q5) && q5.resultCount === 0 ? "came back empty" : "failed";
  }
  const refs = [...house.ledgerRefs, ...(heat.houseRef ? [heat.houseRef] : [])];
  return baselineStep({
    kind: house.baseline,
    headliners: house.resolved,
    shows,
    minHeadliners: HOUSE_MIN_RESOLVED,
    heatFallback,
    comedy: isComedyClassification(ctx.bill.classification),
    status: house.baseline === "house" ? "ok" : "degraded",
    ledgerRefs: refs,
  });
}

export function heatTrace(ctx: RunContext, heat: HeatResult): TraceStep {
  const byId = ledgerIndex(ctx);
  const card = heat.card;
  const refs = card.provenance.filter((r) => !nodeOf(byId.get(r)).endsWith(SPLIT_HALF_NODE));
  const baseline = card.results.diagnostics.baseline;
  const noMap = card.results.tiles.length === 0 && heat.liftDiagnostics === null;
  const failure = noMap
    ? card.status === "error"
      ? "No lift map: the heatmap request failed"
      : `No lift map: ${card.summary.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase())}`
    : null;
  const first = heat.spread[0] ?? heat.top[0] ?? null;
  const cells = heat.billRef ? (byId.get(heat.billRef)?.resultCount ?? null) : null;
  return heatStep({
    status: card.status,
    baseline,
    first: first ? { name: first.name ?? "Area 1", lift: first.lift } : null,
    topCount: heat.top.length,
    minLift: LIFT_DEFAULTS.minLift,
    billFloor: MIN_BILL_PCT,
    excludedAreas: heat.excludedAreas,
    widened: heat.widened ? { fromKm: ctx.operator.radiusKm, toKm: heat.radiusKm, minCells: THIN_CELLS } : null,
    thinCells: heat.thin && !heat.widened ? cells : null,
    failure,
    ledgerRefs: refs,
  });
}

/** The split-half and foot-traffic checks; null when no lift was computed. */
export function checkTrace(ctx: RunContext, heat: HeatResult): TraceStep | null {
  const d = heat.liftDiagnostics;
  if (!d) return null;
  const byId = ledgerIndex(ctx);
  const refs = heat.card.provenance.filter((r) => nodeOf(byId.get(r)).endsWith(SPLIT_HALF_NODE));
  const followsTraffic = d.liftVsHeatSpearman !== null && d.liftVsHeatSpearman > LIFT_DEFAULTS.weakThreshold;
  return checkStep({
    splitHalf: d.splitHalfSpearman,
    threshold: MIN_SPLIT_HALF,
    ...(d.note && d.splitHalfSpearman === null ? { note: d.note } : {}),
    liftVsHeat: d.liftVsHeatSpearman,
    followsTraffic,
    liftVsOwnHeat: heat.liftVsOwnHeat,
    tracksOwnHeat: heat.tracksOwnHeat,
    ledgerRefs: refs,
  });
}

// ---------------------------------------------------------------------------
// Partners and the usual-crowd overlap
// ---------------------------------------------------------------------------

function poolWhere(heat: HeatResult, tileGeohash: string | null, index: number): string {
  if (tileGeohash === null) return "the list near the venue";
  const t = heat.top.find((x) => x.geohash === tileGeohash) ?? heat.spread.find((x) => x.geohash === tileGeohash);
  return t?.name ?? `area ${index + 1}`;
}

export function partnersTrace(ctx: RunContext, partners: PartnersResult): TraceStep {
  const byId = ledgerIndex(ctx);
  const card = partners.card;
  const list = partners.partners;
  const refs = card.provenance.filter((r) => !nodeOf(byId.get(r)).startsWith(HOUSE_TWIN_NODE) && !nodeOf(byId.get(r)).startsWith(POPULARITY_TWIN_NODE));
  const keys = partnerCategories(ctx);
  const cats = categoryUrns(ctx.pins, keys);
  const tilePools = partners.poolSpecs.filter((s) => s.tileGeohash !== null);
  const r = partners.report;
  const failure =
    !r && (card.status === "error" || card.status === "degraded")
      ? `The partner search didn't finish${card.reason ? ` (${card.reason.replace(/\.$/, "")})` : ""}`
      : null;
  const droppedCategory = r?.droppedCategory ?? 0;
  return partnersStep({
    status: card.status,
    kept: list.length,
    inAreas: list.filter((p) => p.tileGeohash !== null).length,
    areas: new Set(list.filter((p) => p.tileGeohash !== null).map((p) => p.tileGeohash)).size,
    nearVenue: list.filter((p) => p.tileGeohash === null).length,
    areasWanted: PARTNER_TILES,
    areasUsed: tilePools.length,
    day: streetDay(ctx),
    hoursUnknown: r?.hoursUnknown ?? 0,
    droppedClosed: r?.droppedClosed ?? 0,
    droppedHoursClosed: r?.droppedHoursClosed ?? 0,
    droppedCategory,
    categoryReason: droppedCategory > 0 ? (ctx.operator.allAges === true ? "all-ages show" : "your exclusions") : null,
    widenedRadius: tilePools.filter((s) => s.radiusM > TILE_RADIUS_M).length,
    widenedRadiusM: TILE_RADIUS_WIDE_M,
    widenedCategories: partners.poolSpecs.filter((s) => s.tags.length > cats.urns.length).length,
    belowMinimum: r?.belowMinimum ?? false,
    minTotal: PARTNER_DEFAULTS.minTotal,
    skippedCategories: cats.skipped.length,
    skippedCategoryNames: cats.skipped.map((k) => categoryWord(k, true)),
    chainsKept: r?.chainsKept ?? 0,
    chainsOffList: r?.chainsOffList ?? [],
    chainsCapped: r?.chainsCapped ?? 0,
    chainsCap: r?.maxChains ?? 0,
    droppedNotVenue: r?.droppedNotVenue ?? 0,
    droppedAdult: r?.droppedAdult ?? 0,
    failure,
    ledgerRefs: refs,
  });
}

/**
 * The house twin's effect: the places the ubiquity penalty pushed off the list
 * (scoring replayed without the twins, same options as the partner step), or
 * how many were marked down. Null when no house signal exists or no pool ran.
 */
export function usualCrowdTrace(ctx: RunContext, resolved: ResolveResult, heat: HeatResult, partners: PartnersResult): TraceStep | null {
  const house = resolved.house;
  if (house.baseline === "none" || partners.pools.length === 0) return null;
  const pools = partners.pools;
  const compared = pools.filter((p) => p.house).length;
  const failedWhere = pools
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.entities.length > 0 && !p.house)
    .map(({ p, i }) => poolWhere(heat, p.tileGeohash, i));
  const drops = ubiquityDrops(pools, heat.spread, {
    weekday: streetDay(ctx),
    categoryTags: categoryTagMap(ctx.pins),
    excludeEntityIds: resolved.venueEntityId ? [resolved.venueEntityId] : [],
    excludeCategories: excludedCategoriesFor(ctx),
    chains: CHAINS,
  });
  const refs = [...pools.flatMap((p) => (p.house ? [p.house.ledgerRef] : [])), ...drops.map((d) => d.ledgerRef)];
  return usualCrowdStep({
    baseline: house.baseline === "house" ? "house" : "tag",
    compared,
    failed: failedWhere,
    dropped: drops.map((d) => d.entity.name),
    penalized: partners.report?.penalized ?? 0,
    kept: partners.partners.length,
    ledgerRefs: refs,
  });
}

/** The popularity check: the number, or why there is none. Null when no partner was picked (no check ran). */
export function popularityTrace(partners: PartnersResult): TraceStep | null {
  const run = partners.popularity;
  if (!run || partners.partners.length === 0) return null;
  const c = run.check;
  return popularityStep({
    partners: c ? c.partners : null,
    notInPopularTop: c ? c.notInPopularTop : null,
    areas: c ? c.perArea.length : 0,
    nearVenueOnly: !!c && c.perArea.length === 1 && c.perArea[0]?.tileGeohash === null,
    failed: run.failed,
    ledgerRefs: run.ledgerRefs,
  });
}

export function declaredTrace(ctx: RunContext, card: StreetSheetCards["declared"]): TraceStep | null {
  if ((ctx.operator.declaredPartners ?? []).length === 0) return null;
  return declaredStep({ status: card.status, declared: card.results.length, ranked: card.results.filter((r) => r.rank !== null).length, ledgerRefs: card.provenance });
}

// ---------------------------------------------------------------------------
// Pre/post, media, narration, guards, the list without Qloo
// ---------------------------------------------------------------------------

export function prePostTrace(ctx: RunContext, card: StreetSheetCards["prePost"]): TraceStep {
  const byId = ledgerIndex(ctx);
  const billCalls = card.provenance.map((r) => byId.get(r)).filter((e): e is LedgerEntry => !!e && nodeOf(e).startsWith("Q10 pre/post"));
  const last = billCalls[billCalls.length - 1];
  const rawRadius = last?.params["filter.location.radius"];
  const radiusM = typeof rawRadius === "number" ? rawRadius : typeof rawRadius === "string" && Number.isFinite(Number(rawRadius)) ? Number(rawRadius) : null;
  const failure = card.status === "error" || (card.status === "degraded" && card.results.length === 0) ? "The search for spots near the room didn't finish" : null;
  return prePostStep({
    status: card.status,
    spots: card.results.length,
    unknownHours: card.results.filter((s) => s.chips.some((c) => c.label === CALL_AHEAD_CHIP)).length,
    radiusM,
    widened: radiusM !== null && radiusM > PREPOST_RADIUS_M ? { fromM: PREPOST_RADIUS_M, minSpots: MIN_SPOTS } : null,
    barsOperatorOnly: card.results.filter((s) => !s.fanFacingAllowed).length,
    legalAgeEnforced: ctx.bill.legalAgeEnforced,
    typeDrops: prePostTypeDrops(ctx),
    chainsKept: prePostChainMoves(ctx)?.chainsKept ?? 0,
    chainsOffList: prePostChainMoves(ctx)?.chainsOffList ?? [],
    chainsCapped: prePostChainMoves(ctx)?.chainsCapped ?? 0,
    chainsCap: prePostChainMoves(ctx)?.maxChains ?? 0,
    droppedNotVenue: prePostChainMoves(ctx)?.droppedNotVenue ?? 0,
    droppedAdult: prePostChainMoves(ctx)?.droppedAdult ?? 0,
    failure,
    ledgerRefs: card.provenance,
  });
}

export function mediaTrace(ctx: RunContext, card: StreetSheetCards["media"]): TraceStep {
  return mediaStep({
    status: card.status,
    podcasts: card.results.filter((m) => m.kind === "podcast").length,
    sponsor: card.results.some((m) => m.kind === "sponsor"),
    local: card.results.some((m) => m.scope === "local"),
    adultBrandsExcluded: (ctx.bill.legalAgeEnforced !== true || ctx.operator.allAges === true) && Object.keys(ctx.pins.sponsorExclusions).length > 0,
    legalAgeEnforced: ctx.bill.legalAgeEnforced,
    allAgesByOperator: ctx.operator.allAges === true,
    ledgerRefs: card.provenance,
  });
}

export function narrateTrace(copy: CopyResult): TraceStep {
  return narrateStep({ templated: copy.templated, hooks: copy.card.results.length, hooksStatus: copy.card.status, ledgerRefs: copy.card.provenance });
}

/** Alcohol tags the copy step held back (from its own guard reason). */
function alcoholHeld(reasons: readonly string[]): number {
  for (const r of reasons) {
    const m = /^([\d,]+) tags? held back from copy/.exec(r);
    if (m?.[1]) return Number(m[1].replace(/,/g, ""));
  }
  return 0;
}

export function guardTrace(guard: StreetSheet["guard"], reasons: readonly string[], allAgesByOperator = false): TraceStep {
  return guardStep({ dropped: guard.dropped, denied: guard.deniedTagCount, alcoholHeld: alcoholHeld(reasons), allAgesByOperator, reasons, ledgerRefs: [] });
}

