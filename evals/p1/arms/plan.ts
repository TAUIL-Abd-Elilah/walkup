/**
 * --dry-run: the run plan from the bars table alone. No keys, no network, nothing written.
 * Call counts are upper bounds (every bar resolves and is analyzed); the real run makes fewer.
 */
import { selectQueries, type BarRow } from "./bars";
import {
  ARMS,
  CLUB_BRAND_NAMES,
  CLUBS,
  F_MAX_TOOL_CALLS,
  PIN_WORDS,
  PLACES_TOTAL_CAP,
  type ArmName,
  type ClubKey,
} from "./protocol";
import { isStalePage } from "./resolve";
import { hasStreetNumber } from "./similarity";

/** Expected Qloo calls for the whole run (plan §8 Budget: "about 1,300 calls"); above it the dry run says so. */
export const QLOO_SOFT_BUDGET = 1300;
/** Default per-run cap: a run stops (and later resumes from cache) once this many requests were sent. */
export const QLOO_DEFAULT_CAP = 900;

export interface DryRunPlan {
  selection: { mode: string; queries: number; bars: number; metros: number };
  arms: ArmName[];
  byClub: Partial<Record<ClubKey, { bars: number; queries: number }>>;
  knownBeforeCalls: { stale_page: number; no_metro: number; to_resolve: number; primary_path_candidates: number; fallback_path: number };
  derbyMetros: number;
  calls: {
    qloo: { brand_search_max: number; brand_entities_max: number; tags: number; resolution: number; q_pop: number; q_signal: number; q_derby: number; total_max: number };
    census_geocoder_max: number;
    places: { resolution_max: number; f_tools_max: number; total_max: number; plan_cap: number; f_subset_needed: boolean; f_subset_size: number | null };
    model: { f_conversations_max: number; l_calls_max: number };
  };
  budget: { qloo_soft: number; qloo_cap_per_run: number; runs_needed_at_cap: number; places_daily_cap: number; days_at_places_daily_cap: number };
  notes: string[];
}

export function planRun(
  bars: readonly BarRow[],
  opts: { arms: ArmName[]; limit: number | null; viability: boolean; noGoogle: boolean; qlooCap: number; placesDailyCap: number; today: string },
): DryRunPlan {
  const sel = selectQueries(bars, { limit: opts.limit, viability: opts.viability });
  const arms: ArmName[] = opts.viability ? ["Q-signal"] : ARMS.filter((a) => opts.arms.includes(a));
  const has = (a: ArmName): boolean => arms.includes(a);
  const notes: string[] = [];

  let stale = 0;
  let noMetro = 0;
  let toResolve = 0;
  let primary = 0;
  for (const b of sel.bars) {
    if (isStalePage(b.pageLastUpdated, opts.today)) stale += 1;
    else if (!b.metroPoint) noMetro += 1;
    else {
      toResolve += 1;
      if (hasStreetNumber(b.address)) primary += 1;
    }
  }
  const byClub: DryRunPlan["byClub"] = {};
  for (const c of CLUBS) {
    const n = sel.bars.filter((b) => b.club === c).length;
    if (n > 0) byClub[c] = { bars: n, queries: sel.queries.filter((q) => q.club === c).length };
  }
  const clubs = CLUBS.filter((c) => sel.bars.some((b) => b.club === c));
  const metros = new Set(sel.queries.map((q) => q.metro));
  const clubsPerMetro = new Map<string, number>();
  for (const q of sel.queries) clubsPerMetro.set(q.metro, (clubsPerMetro.get(q.metro) ?? 0) + 1);
  const derbyMetros = [...clubsPerMetro.values()].filter((n) => n >= 2);

  const brandMax = clubs.reduce((n, c) => n + CLUB_BRAND_NAMES[c].length, 0);
  const qloo = {
    brand_search_max: brandMax,
    brand_entities_max: brandMax,
    tags: PIN_WORDS.length,
    resolution: toResolve,
    q_pop: has("Q-pop") ? metros.size : 0,
    q_signal: has("Q-signal") ? sel.queries.length : 0,
    q_derby: has("Q-derby") ? derbyMetros.reduce((n, k) => n + k, 0) : 0,
    total_max: 0,
  };
  qloo.total_max = qloo.brand_search_max + qloo.brand_entities_max + qloo.tags + qloo.resolution + qloo.q_pop + qloo.q_signal + qloo.q_derby;

  const placesResolution = opts.noGoogle ? 0 : toResolve;
  const fQueries = has("F") && !opts.noGoogle ? sel.queries.length : 0;
  const fTools = F_MAX_TOOL_CALLS * fQueries;
  const remaining = PLACES_TOTAL_CAP - placesResolution;
  const subsetNeeded = fTools > remaining;
  const subsetSize = subsetNeeded ? Math.max(0, Math.floor(remaining / F_MAX_TOOL_CALLS)) : null;
  const placesTotal = placesResolution + (subsetNeeded ? (subsetSize ?? 0) * F_MAX_TOOL_CALLS : fTools);

  if (qloo.total_max > QLOO_SOFT_BUDGET) {
    notes.push(`Qloo upper bound ${qloo.total_max} is above the plan's expected ${QLOO_SOFT_BUDGET}; unresolved bars and empty queries lower it in the real run.`);
  }
  if (qloo.total_max > opts.qlooCap) {
    notes.push(`A run stops after ${opts.qlooCap} Qloo requests; run the same command again to resume from the cache (at most ${Math.ceil(qloo.total_max / opts.qlooCap)} runs).`);
  }
  if (opts.noGoogle) notes.push("--no-google: no closed check (coverage is provisional) and no arm F.");
  if (sel.mode !== "full") notes.push(`${sel.mode} run: part of the ground truth only; not the preregistered run.`);

  return {
    selection: { mode: sel.mode, queries: sel.queries.length, bars: sel.bars.length, metros: metros.size },
    arms,
    byClub,
    knownBeforeCalls: { stale_page: stale, no_metro: noMetro, to_resolve: toResolve, primary_path_candidates: primary, fallback_path: toResolve - primary },
    derbyMetros: derbyMetros.length,
    calls: {
      qloo,
      census_geocoder_max: primary,
      places: { resolution_max: placesResolution, f_tools_max: fTools, total_max: placesTotal, plan_cap: PLACES_TOTAL_CAP, f_subset_needed: subsetNeeded, f_subset_size: subsetSize },
      model: { f_conversations_max: subsetNeeded ? (subsetSize ?? 0) : fQueries, l_calls_max: has("L") ? sel.queries.length : 0 },
    },
    budget: {
      qloo_soft: QLOO_SOFT_BUDGET,
      qloo_cap_per_run: opts.qlooCap,
      runs_needed_at_cap: Math.max(1, Math.ceil(qloo.total_max / Math.max(1, opts.qlooCap))),
      places_daily_cap: opts.placesDailyCap,
      days_at_places_daily_cap: placesTotal === 0 ? 0 : Math.ceil(placesTotal / Math.max(1, opts.placesDailyCap)),
    },
    notes,
  };
}

export function renderPlan(p: DryRunPlan): string[] {
  const L: string[] = [];
  L.push(`Selection: ${p.selection.mode}, ${p.selection.queries} queries over ${p.selection.metros} metros, ${p.selection.bars} listed bars. Arms: ${p.arms.join(", ")}.`);
  for (const [club, c] of Object.entries(p.byClub)) L.push(`  ${club}: ${c.bars} bars, ${c.queries} queries`);
  const k = p.knownBeforeCalls;
  L.push(`Before any call: ${k.stale_page} stale_page, ${k.no_metro} no_metro, ${k.to_resolve} to resolve (${k.primary_path_candidates} with a street number, ${k.fallback_path} fallback). Derby metros: ${p.derbyMetros}.`);
  const q = p.calls.qloo;
  L.push(
    `Qloo (upper bounds): brand search ${q.brand_search_max}, brand /entities ${q.brand_entities_max}, tags ${q.tags}, resolution ${q.resolution}, Q-pop ${q.q_pop}, Q-signal ${q.q_signal}, Q-derby ${q.q_derby}; total at most ${q.total_max}.`,
  );
  L.push(`Census Geocoder: at most ${p.calls.census_geocoder_max} requests (1 per second).`);
  const pl = p.calls.places;
  L.push(
    `Google Places: resolution at most ${pl.resolution_max}, F tools at most ${pl.f_tools_max}; total at most ${pl.total_max} of the plan's ${pl.plan_cap}.` +
      (pl.f_subset_needed ? ` F subset needed: ${pl.f_subset_size} queries drawn with seed 20261013.` : ""),
  );
  L.push(`Model: at most ${p.calls.model.f_conversations_max} F conversations and ${p.calls.model.l_calls_max} L calls.`);
  const b = p.budget;
  L.push(
    `Budget: Qloo expected about ${b.qloo_soft} (plan §8), cap ${b.qloo_cap_per_run} per run (${b.runs_needed_at_cap} run(s) at most); Places daily cap ${b.places_daily_cap} (${b.days_at_places_daily_cap} day(s) at most).`,
  );
  for (const n of p.notes) L.push(`Note: ${n}`);
  return L;
}
