/**
 * Output files of a P1 arms run.
 *
 * Private (git-ignored evals/out/private/): the arms CSV and the bars status CSV that
 * evals/p1/analyze.py reads, the run log (failures by query, notes) and the call ledger.
 * Public (evals/out/): an aggregate-only summary with counts, never bar names, entity ids or ranks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { toCsv } from "./csv";
import { ARMS, ARMS_CSV_COLUMNS, BAR_STATUSES, BARS_STATUS_COLUMNS, CLUBS, type ArmName, type BarStatus, type ClubKey } from "./protocol";
import type { ArmRow, ArmStats } from "./rows";

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Arms CSV and bars status CSV
// ---------------------------------------------------------------------------

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortRows(rows: readonly ArmRow[]): ArmRow[] {
  const armIdx = (a: ArmName): number => ARMS.indexOf(a);
  return [...rows].sort(
    (x, y) =>
      armIdx(x.arm) - armIdx(y.arm) ||
      cmp(x.club, y.club) ||
      cmp(x.metro, y.metro) ||
      (x.barClub === x.club ? 0 : 1) - (y.barClub === y.club ? 0 : 1) ||
      cmp(x.barClub, y.barClub) ||
      cmp(x.barKey, y.barKey),
  );
}

export function armsCsv(rows: readonly ArmRow[]): string {
  return toCsv(
    ARMS_CSV_COLUMNS,
    sortRows(rows).map((r) => ({
      club: r.club,
      metro: r.metro,
      bar_key: r.barKey,
      arm: r.arm,
      rank_or_blank: r.rank === null ? "" : r.rank,
      candidates_n: r.candidatesN,
      bar_club: r.barClub,
      listing_role: r.listingRole,
      resolution_via: r.resolutionVia,
      entity_id: r.entityId,
    })),
  );
}

export interface StatusRow {
  club: ClubKey;
  barKey: string;
  metro: string;
  status: BarStatus;
  entityId: string | null;
  googlePlaceId: string | null;
  resolutionVia: string | null;
}

export function statusCsv(rows: readonly StatusRow[]): string {
  const sorted = [...rows].sort((a, b) => cmp(a.club, b.club) || cmp(a.barKey, b.barKey));
  return toCsv(
    BARS_STATUS_COLUMNS,
    sorted.map((r) => ({
      club: r.club,
      bar_key: r.barKey,
      metro: r.metro,
      status: r.status,
      entity_id: r.entityId ?? "",
      google_place_id: r.googlePlaceId ?? "",
      resolution_via: r.resolutionVia ?? "",
    })),
  );
}

// ---------------------------------------------------------------------------
// Coverage (same funnel and resolution rate as analyze.py)
// ---------------------------------------------------------------------------

export type CoverageCounts = Record<"listed" | BarStatus, number> & { resolution_rate: number | null };

function emptyCounts(): CoverageCounts {
  const c = { listed: 0, resolution_rate: null } as CoverageCounts;
  for (const s of BAR_STATUSES) c[s] = 0;
  return c;
}

function withRate(c: CoverageCounts): CoverageCounts {
  const eligible = c.listed - c.stale_page - c.no_metro - c.no_brand;
  return { ...c, resolution_rate: eligible > 0 ? Number(((eligible - c.unresolved) / eligible).toFixed(6)) : null };
}

export function coverage(rows: readonly StatusRow[]): { byClub: Partial<Record<ClubKey, CoverageCounts>>; total: CoverageCounts } {
  const byClub: Partial<Record<ClubKey, CoverageCounts>> = {};
  const total = emptyCounts();
  for (const r of rows) {
    const c = (byClub[r.club] ??= emptyCounts());
    c.listed += 1;
    c[r.status] += 1;
    total.listed += 1;
    total[r.status] += 1;
  }
  for (const k of Object.keys(byClub) as ClubKey[]) byClub[k] = withRate(byClub[k]!);
  return { byClub, total: withRate(total) };
}

export function coverageLines(cov: ReturnType<typeof coverage>): string[] {
  const cols = ["listed", ...BAR_STATUSES, "resolution_rate"] as const;
  const fmt = (v: number | null): string => (v === null ? "n/a" : String(v));
  const lines = [`| club | ${cols.join(" | ")} |`, `|${"---|".repeat(cols.length + 1)}`];
  for (const club of CLUBS) {
    const c = cov.byClub[club];
    if (c) lines.push(`| ${club} | ${cols.map((k) => fmt(c[k])).join(" | ")} |`);
  }
  lines.push(`| **total** | ${cols.map((k) => fmt(cov.total[k])).join(" | ")} |`);
  return lines;
}

// ---------------------------------------------------------------------------
// Public summary (aggregates only)
// ---------------------------------------------------------------------------

export interface PublicSummary {
  generated_at: string;
  what: string;
  plan_sha256_matches_file: boolean | null;
  input_is_sealed_table: boolean | null;
  selection: { mode: string; queries: number; bars: number };
  run_date: string | null;
  complete: boolean;
  stopped: string | null;
  coverage: ReturnType<typeof coverage> | null;
  coverage_provisional: boolean;
  setup: { club_entities_resolved: number; clubs: number; pinned_tags: number; tag_words: number };
  arms: Partial<Record<ArmName, { planned: number; completed: number; failed: number; refused: number; queries_with_rows: number; rows: number; extra: ArmStats["extra"] }>>;
  f_subset: { population: number; drawn: boolean; size: number } | null;
  viability: { combinations: number; resolved: number; in_q_signal_top50: number; passes: boolean } | null;
  calls: {
    qloo: { sent_this_run: number; cached_this_run: number; sent_all_runs: number; cap_per_run: number };
    places: { sent_this_run: number; cached_this_run: number; sent_all_runs: number; plan_cap: number } | null;
    census_geocoder: { sent_this_run: number; cached_this_run: number };
    model: { calls_this_run: number; est_usd_this_run: number };
  };
  warnings: number;
}

export function summaryMarkdown(s: PublicSummary): string {
  const L: string[] = ["# P1 Fan-Bar Test: arms run summary", ""];
  L.push(
    `Generated ${s.generated_at}. Aggregate counts only; results come from \`evals/p1/analyze.py\`. ` +
      `Plan file matches its sealed hash: ${s.plan_sha256_matches_file ?? "not checked"}. Input is the sealed table: ${s.input_is_sealed_table ?? "not checked"}.`,
  );
  L.push("", `Selection: ${s.selection.mode} (${s.selection.queries} queries, ${s.selection.bars} listed bars). Run date: ${s.run_date ?? "not set"}.`);
  L.push(`Status: ${s.complete ? "complete" : `stopped (${s.stopped ?? "unknown"}); re-run the same command to resume`}.`);
  if (s.coverage) {
    L.push("", "## Coverage", "");
    if (s.coverage_provisional) L.push("Provisional: the Google closed check did not run for every resolved bar.", "");
    L.push(...coverageLines(s.coverage));
  }
  L.push("", "## Arms", "", "| arm | planned | completed | failed | refused | queries with rows | rows |", "|---|---|---|---|---|---|---|");
  for (const arm of ARMS) {
    const a = s.arms[arm];
    if (a) L.push(`| ${arm} | ${a.planned} | ${a.completed} | ${a.failed} | ${a.refused} | ${a.queries_with_rows} | ${a.rows} |`);
  }
  if (s.f_subset) {
    L.push("", `F subset: ${s.f_subset.drawn ? `drawn with seed 20261013, ${s.f_subset.size} of ${s.f_subset.population} queries` : `not needed (${s.f_subset.population} queries)`}.`);
  }
  if (s.viability) {
    const v = s.viability;
    L.push("", `Viability gate: ${v.resolved} of ${v.combinations} combinations resolved, ${v.in_q_signal_top50} in the Q-signal top 50: ${v.passes ? "passes" : "does not pass"}.`);
  }
  const c = s.calls;
  L.push("", "## Calls", "");
  L.push(`- Qloo: ${c.qloo.sent_this_run} sent this run (cap ${c.qloo.cap_per_run}), ${c.qloo.cached_this_run} from cache, ${c.qloo.sent_all_runs} sent in all runs.`);
  if (c.places) L.push(`- Google Places: ${c.places.sent_this_run} sent this run, ${c.places.cached_this_run} from cache, ${c.places.sent_all_runs} of ${c.places.plan_cap} used in all runs.`);
  L.push(`- Census Geocoder: ${c.census_geocoder.sent_this_run} sent, ${c.census_geocoder.cached_this_run} from cache.`);
  L.push(`- Model: ${c.model.calls_this_run} calls, estimated $${c.model.est_usd_this_run.toFixed(2)}.`);
  if (s.warnings > 0) L.push("", `${s.warnings} warning(s); details in the private run log.`);
  return `${L.join("\n")}\n`;
}
