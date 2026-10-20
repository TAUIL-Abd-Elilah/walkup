/**
 * One P1 arms run, in the preregistered order (plan §8 "Order"): club entities and tags,
 * then every resolution (the coverage table is written before any arm call), then Q-pop,
 * Q-signal, F, L and Q-derby. Every answer is cached in the run store, so a run stopped by a
 * guard resumes where it stopped when the same command is run again.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LedgerSink } from "@walkup/contracts";
import { barId, selectQueries, type BarRow, type Query, type Selection } from "./bars";
import type { Geocoder } from "./census";
import { errorText, isStop, StopRunError, type StopKind } from "./errors";
import { newModelStats, runFConversation, runLCall, type FOutcome, type LOutcome, type ModelCallStats, type ModelDeps } from "./model-arms";
import {
  armsCsv,
  coverage,
  coverageLines,
  statusCsv,
  summaryMarkdown,
  writeJson,
  writeText,
  type PublicSummary,
  type StatusRow,
} from "./output";
import type { PlacesIo } from "./places-io";
import {
  ARMS,
  CLUB_DISPLAY_NAMES,
  CLUBS,
  CONFIG_TAG_KEYS,
  F_MAX_TOOL_CALLS,
  NAME_SIM_THRESHOLD,
  PIN_WORDS,
  PLACES_TOTAL_CAP,
  SEED,
  VIABILITY_MIN_RESOLVED,
  VIABILITY_MIN_TOP50,
  type ArmName,
  type BarStatus,
  type ClubKey,
} from "./protocol";
import { PyRandom } from "./pyrandom";
import { ownAnalyzed, runQDerby, runQPop, runQSignal, type QArmContext } from "./q-arms";
import { QLOO_LIVE_TOTAL_KEY, type QlooIo, type RankedEntry } from "./qloo-io";
import {
  decideStatus,
  pinTag,
  resolveBarInGoogle,
  resolveBarInQloo,
  resolveClubEntity,
  type ClubEntityRecord,
  type GoogleBarResolution,
  type QlooBarResolution,
  type TagPin,
} from "./resolve";
import { emptyStats, rowFor, type AnalyzedBar, type ArmRow, type ArmStats } from "./rows";
import { nameSimilarity } from "./similarity";
import { sha256, type RunStore } from "./store";

export interface Services {
  qloo: QlooIo;
  /** Null with --no-google (or no Places key): no closed check, no arm F. */
  places: PlacesIo | null;
  geocoder: Geocoder;
  /** Null when no model key: arms F and L cannot run. */
  model: ModelDeps | null;
  store: RunStore;
  ledger: LedgerSink;
  now: () => Date;
  log: (line: string) => void;
  /** Per-run Qloo cap, reported in the summary. */
  qlooCap: number;
}

export interface RunOptions {
  bars: BarRow[];
  /** True when the input is data/private/p1/bars_full.csv with its sealed hash; null when not checked. */
  inputIsSealedTable: boolean | null;
  planMatchesSealedHash: boolean | null;
  arms: ArmName[];
  limit: number | null;
  viability: boolean;
  noGoogle: boolean;
  retryFailed: boolean;
  llmConcurrency: number;
  /** Private outputs (git-ignored). */
  outDir: string;
  /** Public aggregate summary. */
  publicDir: string;
  /** Where club_entities.json and pinned_tags.json go (evals/p1 for the real run). */
  pinsDir: string;
  /** config/tags.json, cross-checked against the §8 pins; null to skip. */
  configTagsPath: string | null;
}

interface BarRecord {
  qloo: QlooBarResolution | null;
  google: GoogleBarResolution | null;
  googleChecked: boolean;
}

export interface Failure {
  arm: ArmName;
  key: string;
  reason: string;
}

export interface RunLog {
  generated_at: string;
  selection: { mode: string; queries: number; bars: number };
  arms: ArmName[];
  run_date: string | null;
  complete: boolean;
  stopped: { kind: StopKind; message: string } | null;
  club_entities: ClubEntityRecord[];
  tag_pins: TagPin[];
  config_tags_check: string[];
  coverage_provisional: boolean;
  arm_stats: Partial<Record<ArmName, ArmStats>>;
  failures: Failure[];
  f_subset: { population: number; drawn: boolean; size: number; remaining_places: number } | null;
  viability: (PublicSummary["viability"] & { details: { query: string; resolved: boolean; in_top50: boolean }[] }) | null;
  warnings: string[];
  files: string[];
}

export interface RunResult {
  exitCode: number;
  stopped: { kind: StopKind; message: string } | null;
  rows: ArmRow[];
  statusRows: StatusRow[];
  summary: PublicSummary;
  log: RunLog;
  files: string[];
}

/** Runs async work over items with at most `n` in flight; the first error stops new work and is rethrown. */
async function forEachPool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        if (failure === null) failure = err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  if (failure !== null) throw failure;
}

export async function runP1(svc: Services, opt: RunOptions): Promise<RunResult> {
  const { store, log } = svc;
  const selection: Selection = selectQueries(opt.bars, { limit: opt.limit, viability: opt.viability });
  const arms: ArmName[] = opt.viability ? ["Q-signal"] : ARMS.filter((a) => opt.arms.includes(a));
  const warnings: string[] = [];
  const failures: Failure[] = [];
  const armStats: Partial<Record<ArmName, ArmStats>> = {};
  const rows: ArmRow[] = [];
  const statusRows: StatusRow[] = [];
  const records = new Map<string, BarRecord>();
  const analyzed = new Map<string, AnalyzedBar>();
  const modelStats: ModelCallStats = newModelStats();
  const files: string[] = [];
  let clubRecords: ClubEntityRecord[] = [];
  let pins: TagPin[] = [];
  const configCheck: string[] = [];
  let runDate: string | null = store.get<string>("run-date");
  let coverageDone = false;
  let coverageProvisional = false;
  let fSubset: RunLog["f_subset"] = null;
  let viability: RunLog["viability"] = null;
  let qSignalLists = new Map<string, RankedEntry[]>();
  let stopped: RunResult["stopped"] = null;

  log(`P1 arms run: ${selection.mode}, ${selection.queries.length} queries, ${selection.bars.length} listed bars; arms ${arms.join(", ") || "none"}.`);
  if (opt.inputIsSealedTable === false) warnings.push("input is not the sealed bars_full.csv: this is not the preregistered run");
  if (opt.planMatchesSealedHash === false) warnings.push("p1-plan.md does not match its sealed SHA-256");
  if (selection.mode !== "full") warnings.push(`${selection.mode} run: only part of the ground truth is covered`);

  const clubEntity = (club: ClubKey): string | null => clubRecords.find((r) => r.club === club)?.entityId ?? null;

  try {
    // ---- 1. club entities (§6) and tag pins (§8) ---------------------------------------
    const clubs = CLUBS.filter((c) => selection.bars.some((b) => b.club === c));
    for (const club of clubs) {
      let rec = store.get<ClubEntityRecord>(`club:${club}`);
      if (!rec) {
        rec = await resolveClubEntity(svc.qloo, club);
        store.set(`club:${club}`, rec);
        log(`  brand ${club}: ${rec.entityId ? `accepted (query "${rec.acceptedQuery}")` : "no accepted entity: its bars are no_brand"}`);
      }
      clubRecords.push(rec);
    }
    const allClubRecords = CLUBS.map((c) => store.get<ClubEntityRecord>(`club:${c}`)).filter((r): r is ClubEntityRecord => r !== null);
    const clubFile: Record<string, string | null> = {};
    for (const c of ["arsenal_america", "lfc_olsc", "american_outlaws"] as const) {
      const r = allClubRecords.find((x) => x.club === c);
      if (r) clubFile[c] = r.entityId;
    }
    const clubPath = join(opt.pinsDir, "club_entities.json");
    writeJson(clubPath, clubFile);
    files.push(clubPath);

    pins = store.get<TagPin[]>("tags") ?? [];
    if (pins.length !== PIN_WORDS.length) {
      pins = [];
      for (const word of PIN_WORDS) pins.push(await pinTag(svc.qloo, word));
      store.set("tags", pins);
      log(`  tags pinned: ${pins.filter((p) => p.tagId).length} of ${PIN_WORDS.length}`);
    }
    const tagFile: Record<string, string | null> = {};
    for (const p of pins) tagFile[p.word] = p.tagId;
    const tagPath = join(opt.pinsDir, "pinned_tags.json");
    writeJson(tagPath, tagFile);
    files.push(tagPath);
    for (const p of pins) if (!p.tagId) warnings.push(`no tag accepted for "${p.word}": dropped from the union (§8)`);
    configCheck.push(...crossCheckConfigTags(opt.configTagsPath, pins));
    for (const line of configCheck) if (line.startsWith("differs")) warnings.push(`config/tags.json ${line}`);
    const pinnedTags = pins.map((p) => p.tagId).filter((t): t is string => t !== null);

    // ---- 2. resolution (§5, §7): coverage table before any arm call ------------------------
    if (!runDate) {
      runDate = svc.now().toISOString().slice(0, 10);
      store.set("run-date", runDate);
    }
    const bars = [...selection.bars].sort((a, b) => (barId(a) < barId(b) ? -1 : 1));
    let done = 0;
    for (const bar of bars) {
      const id = barId(bar);
      const entity = clubEntity(bar.club);
      let status: BarStatus = decideStatus(bar, runDate, entity, null, null);
      const rec: BarRecord = store.get<BarRecord>(`bar:${id}`) ?? { qloo: null, google: null, googleChecked: false };
      if (status === "unresolved") {
        if (!rec.qloo) {
          rec.qloo = await resolveBarInQloo(bar, svc.qloo, svc.geocoder);
          store.set(`bar:${id}`, rec);
        }
        if (rec.qloo.status === "resolved" && !rec.googleChecked && svc.places && !opt.noGoogle) {
          rec.google = await resolveBarInGoogle(bar, rec.qloo.path, rec.qloo.pointA, svc.places);
          rec.googleChecked = true;
          store.set(`bar:${id}`, rec);
        }
        if (rec.qloo.status === "resolved" && !rec.googleChecked) coverageProvisional = true;
        status = decideStatus(bar, runDate, entity, rec.qloo, rec.googleChecked ? rec.google : null);
      }
      records.set(id, rec);
      statusRows.push({
        club: bar.club,
        barKey: bar.barKey,
        metro: bar.metroGeoid,
        status,
        entityId: rec.qloo?.status === "resolved" ? rec.qloo.entityId : null,
        googlePlaceId: rec.google?.status === "resolved" ? rec.google.placeId : null,
        resolutionVia: rec.qloo?.path ?? null,
      });
      if (status === "analyzed" && rec.qloo?.entityId) {
        analyzed.set(id, {
          bar,
          entityId: rec.qloo.entityId,
          via: rec.qloo.path,
          googlePlaceId: rec.google?.status === "resolved" ? rec.google.placeId : null,
        });
      }
      done += 1;
      if (done % 50 === 0) log(`  resolved ${done}/${bars.length}`);
    }
    coverageDone = true;
    const statusPath = join(opt.outDir, "p1_bars_status.csv");
    writeText(statusPath, statusCsv(statusRows));
    files.push(statusPath);
    log("Coverage (frozen before any arm call):");
    for (const line of coverageLines(coverage(statusRows))) log(`  ${line}`);
    if (coverageProvisional) warnings.push("coverage is provisional: the Google closed check did not run for every resolved bar");

    // ---- 3. arms ---------------------------------------------------------------------------
    const ctx: QArmContext = {
      qloo: svc.qloo,
      queries: selection.queries,
      analyzed,
      clubEntities: Object.fromEntries(clubRecords.map((r) => [r.club, r.entityId])),
      pinnedTags,
      log,
    };
    for (const arm of arms) {
      log(`Arm ${arm}...`);
      if (arm === "Q-pop" || arm === "Q-signal" || arm === "Q-derby") {
        const res = arm === "Q-pop" ? await runQPop(ctx) : arm === "Q-signal" ? await runQSignal(ctx) : await runQDerby(ctx);
        armStats[arm] = res.stats;
        rows.push(...res.rows);
        if (arm === "Q-signal") qSignalLists = res.lists;
        if (res.stats.failed > 0) failures.push({ arm, key: "*", reason: `${res.stats.failed} call(s) failed after retries` });
      } else if (arm === "F") {
        const res = await runFArm(svc, opt, selection, analyzed, modelStats, failures, warnings);
        armStats.F = res.stats;
        fSubset = res.subset;
        rows.push(...res.rows);
      } else {
        const res = await runLArm(svc, opt, selection, analyzed, modelStats, failures, warnings);
        armStats.L = res.stats;
        rows.push(...res.rows);
      }
      const st = armStats[arm]!;
      log(`  ${arm}: ${st.completed}/${st.planned} done, ${st.failed} failed, ${st.rows} rows`);
    }

    if (opt.viability) viability = viabilityReport(selection.queries, records, analyzed, qSignalLists);
  } catch (err) {
    if (!isStop(err)) throw err;
    stopped = { kind: err.kind, message: err.message };
    log(`STOPPED (${err.kind}): ${err.message}`);
  }

  // ---- 4. outputs ---------------------------------------------------------------------------
  const complete = stopped === null;
  const armsPath = join(opt.outDir, "p1_arms.csv");
  const partialPath = join(opt.outDir, "p1_arms.partial.csv");
  if (complete && arms.length > 0) {
    writeText(armsPath, armsCsv(rows));
    files.push(armsPath);
    if (existsSync(partialPath)) rmSync(partialPath);
  } else if (rows.length > 0) {
    writeText(partialPath, armsCsv(rows));
    files.push(partialPath);
  }

  const cov = coverageDone ? coverage(statusRows) : null;
  const generatedAt = svc.now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const summary: PublicSummary = {
    generated_at: generatedAt,
    what: "P1 Fan-Bar Test, arms run (docs/preregistration/p1-plan.md)",
    plan_sha256_matches_file: opt.planMatchesSealedHash,
    input_is_sealed_table: opt.inputIsSealedTable,
    selection: { mode: selection.mode, queries: selection.queries.length, bars: selection.bars.length },
    run_date: runDate,
    complete,
    stopped: stopped?.kind ?? null,
    coverage: cov,
    coverage_provisional: coverageProvisional,
    setup: {
      club_entities_resolved: clubRecords.filter((r) => r.entityId).length,
      clubs: clubRecords.length,
      pinned_tags: pins.filter((p) => p.tagId).length,
      tag_words: PIN_WORDS.length,
    },
    arms: Object.fromEntries(
      Object.entries(armStats).map(([arm, s]) => [
        arm,
        { planned: s.planned, completed: s.completed, failed: s.failed, refused: s.refused, queries_with_rows: s.queriesWithRows, rows: s.rows, extra: s.extra },
      ]),
    ),
    f_subset: fSubset ? { population: fSubset.population, drawn: fSubset.drawn, size: fSubset.size } : null,
    viability: viability ? { combinations: viability.combinations, resolved: viability.resolved, in_q_signal_top50: viability.in_q_signal_top50, passes: viability.passes } : null,
    calls: {
      qloo: { sent_this_run: svc.qloo.stats.live, cached_this_run: svc.qloo.stats.cached, sent_all_runs: store.number(QLOO_LIVE_TOTAL_KEY), cap_per_run: svc.qlooCap },
      places: svc.places
        ? { sent_this_run: svc.places.stats.live, cached_this_run: svc.places.stats.cached, sent_all_runs: svc.places.sentTotal(), plan_cap: svc.places.totalCap }
        : null,
      census_geocoder: { sent_this_run: svc.geocoder.stats.live, cached_this_run: svc.geocoder.stats.cached },
      model: { calls_this_run: modelStats.calls, est_usd_this_run: Number(modelStats.estUsd.toFixed(4)) },
    },
    warnings: warnings.length,
  };

  const runLog: RunLog = {
    generated_at: generatedAt,
    selection: summary.selection,
    arms,
    run_date: runDate,
    complete,
    stopped,
    club_entities: clubRecords,
    tag_pins: pins,
    config_tags_check: configCheck,
    coverage_provisional: coverageProvisional,
    arm_stats: armStats,
    failures,
    f_subset: fSubset,
    viability,
    warnings,
    files: [],
  };

  const stamp = generatedAt.replace(/[-:]/g, "").replace(/T/, "-").replace(/Z$/, "");
  const ledgerPath = join(opt.outDir, `p1_ledger_${stamp}.json`);
  writeJson(ledgerPath, svc.ledger.entries());
  files.push(ledgerPath);
  const summaryJson = join(opt.publicDir, "p1_arms_summary.json");
  const summaryMd = join(opt.publicDir, "p1_arms_summary.md");
  writeJson(summaryJson, summary);
  writeText(summaryMd, summaryMarkdown(summary));
  files.push(summaryJson, summaryMd);
  const logPath = join(opt.outDir, "p1_run_log.json");
  files.push(logPath);
  runLog.files = [...files];
  writeJson(logPath, runLog);

  const exitCode = stopped ? new StopRunError(stopped.kind, stopped.message).exitCode : 0;
  return { exitCode, stopped, rows, statusRows, summary, log: runLog, files };
}

// ---------------------------------------------------------------------------
// Arm F and arm L
// ---------------------------------------------------------------------------

/**
 * The F subset (§8 Budget): when 5 Places calls per query would exceed what is left of the
 * 2,500-request cap, draw floor(remaining / 5) queries with random.Random(20261013).sample over
 * the F-eligible query keys in sorted order. Decided once per query set, before any F call, and
 * stored so a resumed run keeps the same draw.
 */
export function decideFSubset(
  store: RunStore,
  keys: readonly string[],
  remainingPlaces: number,
): { selected: Set<string>; population: number; drawn: boolean; size: number; remaining_places: number } {
  const sorted = [...keys].sort();
  const id = `f-subset:${sha256(sorted.join("\n"))}`;
  const stored = store.get<{ selected: string[] | null; remaining: number }>(id);
  if (stored) {
    const sel = stored.selected ?? sorted;
    return { selected: new Set(sel), population: sorted.length, drawn: stored.selected !== null, size: sel.length, remaining_places: stored.remaining };
  }
  let selected: string[] | null = null;
  if (F_MAX_TOOL_CALLS * sorted.length > remainingPlaces) {
    const k = Math.max(0, Math.min(sorted.length, Math.floor(remainingPlaces / F_MAX_TOOL_CALLS)));
    selected = new PyRandom(SEED).sample(sorted, k);
  }
  store.set(id, { selected, remaining: remainingPlaces });
  const sel = selected ?? sorted;
  return { selected: new Set(sel), population: sorted.length, drawn: selected !== null, size: sel.length, remaining_places: remainingPlaces };
}

async function runFArm(
  svc: Services,
  opt: RunOptions,
  selection: Selection,
  analyzed: ReadonlyMap<string, AnalyzedBar>,
  modelStats: ModelCallStats,
  failures: Failure[],
  warnings: string[],
): Promise<{ rows: ArmRow[]; stats: ArmStats; subset: RunLog["f_subset"] }> {
  const stats = emptyStats();
  const rows: ArmRow[] = [];
  if (!svc.places || opt.noGoogle) {
    stats.notes.push("skipped: arm F needs Google Places (resolved Google places and the places_search tool)");
    warnings.push("arm F skipped: no Google Places");
    return { rows, stats, subset: null };
  }
  if (!svc.model) {
    stats.notes.push("skipped: no model client");
    warnings.push("arm F skipped: no model client");
    return { rows, stats, subset: null };
  }
  const places = svc.places;
  const model = svc.model;
  const eligible = selection.queries.filter((q) => ownAnalyzed(q, analyzed).some((a) => a.googlePlaceId));
  const subset = decideFSubset(svc.store, eligible.map((q) => q.key), places.totalCap - places.sentTotal());
  const work = eligible.filter((q) => subset.selected.has(q.key));
  stats.planned = work.length;
  const outcomes = new Map<string, FOutcome>();
  let toolCalls = 0;
  let toolErrors = 0;
  let droppedUnseen = 0;
  await forEachPool(work, opt.llmConcurrency, async (q) => {
    const key = `arm:F:${q.key}`;
    let out = svc.store.get<FOutcome>(key);
    if (!out || (opt.retryFailed && out.status === "failed")) {
      out = await runFConversation(
        { metroDisplay: q.metroDisplay, state: q.metroState, clubDisplay: CLUB_DISPLAY_NAMES[q.club], point: q.point },
        model,
        places,
        modelStats,
      );
      svc.store.set(key, out);
    }
    outcomes.set(q.key, out);
  });
  for (const q of work) {
    const out = outcomes.get(q.key);
    if (!out) continue;
    toolCalls += out.toolCalls;
    toolErrors += out.toolErrors;
    droppedUnseen += out.droppedUnseen;
    if (out.status === "failed") {
      stats.failed += 1;
      failures.push({ arm: "F", key: q.key, reason: out.reason ?? "failed" });
      continue;
    }
    stats.completed += 1;
    if (out.status === "refused") stats.refused += 1;
    const own = ownAnalyzed(q, analyzed).filter((a) => a.googlePlaceId);
    stats.queriesWithRows += 1;
    for (const a of own) {
      const idx = out.placeIds.indexOf(a.googlePlaceId!);
      rows.push(rowFor("F", q.club, q.metro, a, idx >= 0 ? idx + 1 : null, out.placeIds.length));
    }
  }
  stats.rows = rows.length;
  stats.extra = { eligible_queries: eligible.length, tool_calls: toolCalls, tool_errors_to_model: toolErrors, dropped_unseen_ids: droppedUnseen, places_cap: PLACES_TOTAL_CAP };
  return { rows, stats, subset: { population: subset.population, drawn: subset.drawn, size: subset.size, remaining_places: subset.remaining_places } };
}

async function runLArm(
  svc: Services,
  opt: RunOptions,
  selection: Selection,
  analyzed: ReadonlyMap<string, AnalyzedBar>,
  modelStats: ModelCallStats,
  failures: Failure[],
  warnings: string[],
): Promise<{ rows: ArmRow[]; stats: ArmStats }> {
  const stats = emptyStats();
  const rows: ArmRow[] = [];
  if (!svc.model) {
    stats.notes.push("skipped: no model client");
    warnings.push("arm L skipped: no model client");
    return { rows, stats };
  }
  const model = svc.model;
  const work = selection.queries.filter((q) => ownAnalyzed(q, analyzed).length > 0);
  stats.planned = work.length;
  const outcomes = new Map<string, LOutcome>();
  await forEachPool(work, opt.llmConcurrency, async (q) => {
    const key = `arm:L:${q.key}`;
    let out = svc.store.get<LOutcome>(key);
    if (!out || (opt.retryFailed && out.status === "failed")) {
      out = await runLCall({ metroDisplay: q.metroDisplay, state: q.metroState, clubDisplay: CLUB_DISPLAY_NAMES[q.club] }, model, modelStats);
      svc.store.set(key, out);
    }
    outcomes.set(q.key, out);
  });
  let named = 0;
  for (const q of work) {
    const out = outcomes.get(q.key);
    if (!out) continue;
    if (out.status === "failed") {
      stats.failed += 1;
      failures.push({ arm: "L", key: q.key, reason: out.reason ?? "failed" });
      continue;
    }
    stats.completed += 1;
    if (out.status === "refused") stats.refused += 1;
    stats.queriesWithRows += 1;
    let any = false;
    for (const a of ownAnalyzed(q, analyzed)) {
      const idx = out.names.findIndex((n) => nameSimilarity(n, a.bar.barName) >= NAME_SIM_THRESHOLD);
      if (idx >= 0) any = true;
      rows.push(rowFor("L", q.club, q.metro, a, idx >= 0 ? idx + 1 : null, out.names.length));
    }
    if (any) named += 1;
  }
  stats.rows = rows.length;
  stats.extra = { queries_where_l_named_a_listed_bar: named };
  return { rows, stats };
}

// ---------------------------------------------------------------------------
// §13 viability gate and the config/tags.json cross-check
// ---------------------------------------------------------------------------

function viabilityReport(
  queries: readonly Query[],
  records: ReadonlyMap<string, BarRecord>,
  analyzed: ReadonlyMap<string, AnalyzedBar>,
  lists: ReadonlyMap<string, RankedEntry[]>,
): NonNullable<RunLog["viability"]> {
  const details = queries.map((q) => {
    const resolved = q.bars.some((b) => records.get(barId(b))?.qloo?.status === "resolved");
    const list = lists.get(q.key) ?? [];
    const inTop50 = ownAnalyzed(q, analyzed).some((a) => list.some((e) => e.entityId === a.entityId && e.position <= 50));
    return { query: q.key, resolved, in_top50: inTop50 };
  });
  const resolved = details.filter((d) => d.resolved).length;
  const top = details.filter((d) => d.in_top50).length;
  return {
    combinations: details.length,
    resolved,
    in_q_signal_top50: top,
    passes: resolved >= VIABILITY_MIN_RESOLVED && top >= VIABILITY_MIN_TOP50,
    details,
  };
}

/** Lines comparing the §8 pins with config/tags.json (the product's pins); P1 always uses its own §8 pins. */
export function crossCheckConfigTags(path: string | null, pins: readonly TagPin[]): string[] {
  if (!path) return [];
  let cfg: { categories?: { key?: string; urn?: string | null; status?: string }[] };
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as typeof cfg;
  } catch (err) {
    return [`not read (${errorText(err)})`];
  }
  const out: string[] = [];
  for (const p of pins) {
    const key = CONFIG_TAG_KEYS[p.word];
    const entry = (cfg.categories ?? []).find((c) => c.key === key);
    if (!entry || entry.status !== "pinned" || !entry.urn) out.push(`${key}: not pinned in config (P1 pin ${p.tagId ? "present" : "missing"})`);
    else if (entry.urn === p.tagId) out.push(`${key}: same as the P1 pin`);
    else out.push(`differs for ${key}: config ${entry.urn}, P1 ${p.tagId ?? "none"}`);
  }
  return out;
}
