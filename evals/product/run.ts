/**
 * The product eval runner: runs the 20 cases (cases.ts) through
 * @walkup/orchestrator on the fixture world, applies the universal checks
 * (checks.ts) to every sheet, and writes evals/product/out/score.json and
 * score.md. With --source recorded it re-checks stored plans (recorded live
 * runs or replays) instead: only the golden cases apply there.
 *
 *   npx tsx evals/product/run.ts                       # fixture world, writes out/
 *   npx tsx evals/product/run.ts --only C01,C05        # a subset
 *   npx tsx evals/product/run.ts --source recorded --plans <dir | plans.sqlite>
 *   npx tsx evals/product/run.ts --out <dir> --quiet
 *
 * Exit code 0 when every failure is a known product gap (known-gaps.ts) or there is none,
 * 1 on any other failure, 2 on bad usage. --strict-hours also fails partners Qloo lists
 * without hours (the sheet shows them as "call first"). Nothing calls a live API.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutControl, type StreetSheet } from "@walkup/contracts";
import { type CallBudget, type PlanResult } from "@walkup/orchestrator";
import { DEFAULT_WORLD_SEED } from "@walkup/qloo-world";
import { CASES, type CaseEnv, type ProductCase, type RecordedRun } from "./cases";
import { CLAUSES, checkSubject, type CheckResult, type ClauseId, type SubjectMetrics } from "./checks";
import { knownGapFor } from "./known-gaps";

export const SCORE_FORMAT = "walkup.product-eval";
export const SCORE_VERSION = 1;
export const DEFAULT_OUT_DIR = fileURLToPath(new URL("./out", import.meta.url));

export type CaseStatus = "passed" | "failed" | "skipped";

export interface CaseScore {
  id: string;
  slug: string;
  title: string;
  covers: string;
  clauses: ClauseId[];
  /** A golden case: the definition-of-done clauses are scored on these. */
  golden: boolean;
  status: CaseStatus;
  /** Failed only on known, reported product gaps (known-gaps.ts). */
  knownGapsOnly: boolean;
  /** Why the case was skipped or errored. */
  note?: string;
  checks: CheckResult[];
  counts: { pass: number; fail: number; skip: number };
  metrics: Record<string, number | string | boolean | null>;
}

export interface ClauseScore {
  id: ClauseId;
  text: string;
  source: string;
  checkedBy: "eval" | "ci";
  /** "goldens": scored on the golden cases only; "all": on every case. */
  scope: "goldens" | "all";
  /** verified: checks ran and passed; failed: a check failed; not verified: only skipped or no check; ci: a CI step outside this eval. */
  status: "verified" | "failed" | "not verified" | "ci";
  cases: string[];
  pass: number;
  fail: number;
  skip: number;
  note?: string;
}

export interface Score {
  format: typeof SCORE_FORMAT;
  formatVersion: typeof SCORE_VERSION;
  /** "fixture-world": every answer came from @walkup/qloo-world. "recorded": stored plans. */
  source: "fixture-world" | "recorded";
  worldSeed: string | null;
  /** Recorded source only: each plan read, with the mode its sheet carries (a fixture sheet never reads as live). */
  recordedPlans: { presetId: string; source: string; planId: string; mode: "live" | "fixture"; createdAt: string | null }[] | null;
  generatedAt: string;
  passed: number;
  /** Every failed case, known gaps included. */
  failed: number;
  /** Failed cases whose every failing check is a known, reported product gap. */
  knownGaps: number;
  /** Failed cases with at least one failure that is not a known gap. */
  unexpectedFailures: number;
  skipped: number;
  total: number;
  /** Partners pass only with hours from Qloo for the day (no "call first" allowance). */
  strictHours: boolean;
  clauses: ClauseScore[];
  cases: CaseScore[];
}

export interface RunOptions {
  source?: "fixture" | "recorded";
  /** Stored plans for the recorded source: a directory of JSON files or a SQLite plans file. */
  plans?: string;
  /** Case ids or slugs to run (others are reported as skipped). */
  only?: string[];
  /** See GroundingOptions.strictHours. */
  strictHours?: boolean;
  now?: () => Date;
  /** Progress lines (default: none). */
  log?: (line: string) => void;
}

const CI_NOTES: Partial<Record<ClauseId, string>> = {
  D5: "evals/product/product.eval.test.ts runs this eval under vitest; CI runs it once the root vitest include covers evals/product (see evals/product/README.md).",
  D6: "The P1 analysis tests run in the Python CI job (python evals/p1/test_analyze.py); not part of this eval.",
  D7: "Committing evals/product/out/score.json needs a CI step with write permission; not part of this eval.",
};

// ---------------------------------------------------------------------------
// Recorded plans
// ---------------------------------------------------------------------------

function emptyBudget(): CallBudget {
  return { qlooFresh: 0, qlooCached: 0, qlooTotal: 0, billLevel: 0, venueLevel: 0, arms: 0, tm: 0, places: 0, anthropic: 0, byNode: {} };
}

/** A stored plan (orchestrator StoredPlan) or a fixture wrapper ({synthetic, fixtureId, sheet, budget}) as a plan result. */
export function recordedFromJson(raw: unknown, source: string): RecordedRun | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sheet = o.sheet as StreetSheet | undefined;
  if (!sheet || typeof sheet !== "object" || !sheet.cards) return null;
  const request = (o.request ?? {}) as Record<string, unknown>;
  const presetId = [o.presetId, o.fixtureId, request.presetId].find((x): x is string => typeof x === "string");
  if (!presetId) return null;
  const status = o.status === "needs_input" ? "needs_input" : "complete";
  const result: PlanResult = {
    status,
    planId: typeof o.planId === "string" ? o.planId : sheet.planId,
    mode: sheet.mode,
    // As the product serves it: an older run's Google Places list is dropped.
    sheet: withoutControl(sheet),
    budget: (o.budget as CallBudget) ?? emptyBudget(),
    citations: (o.citations as Record<string, string>) ?? {},
    servedFromStore: false,
    presetId,
  };
  return { presetId, result, source };
}

/** Reads the latest complete stored plan per preset from a directory of JSON files or a SQLite plans file. */
export async function loadRecordedPlans(path: string): Promise<Map<string, RecordedRun>> {
  const out = new Map<string, RecordedRun>();
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`No recorded plans at ${abs}`);
  if (statSync(abs).isDirectory()) {
    const files = readdirSync(abs)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files) {
      const rec = recordedFromJson(JSON.parse(readFileSync(join(abs, f), "utf8")) as unknown, f);
      if (!rec || rec.result.status !== "complete") continue;
      const prev = out.get(rec.presetId);
      if (!prev || (prev.result.sheet?.createdAt ?? "") <= (rec.result.sheet?.createdAt ?? "")) out.set(rec.presetId, rec);
    }
    return out;
  }
  // SQLite (server-side store); loaded only here so the fixture path never opens a database file.
  const { createSqlitePlanStore } = await import("@walkup/orchestrator/sqlite");
  const store = createSqlitePlanStore(abs);
  try {
    for (const id of ["g1-a", "g1-b", "g2", "g3"]) {
      const rec = recordedFromJson(await store.latestForPreset(id), `plans table, ${id}`);
      if (rec) out.set(id, rec);
    }
  } finally {
    store.close();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function selected(c: ProductCase, only: string[] | undefined): boolean {
  if (!only || only.length === 0) return true;
  return only.some((x) => x.toLowerCase() === c.id.toLowerCase() || x.toLowerCase() === c.slug.toLowerCase());
}

function countChecks(checks: CheckResult[]): CaseScore["counts"] {
  return {
    pass: checks.filter((x) => x.status === "pass").length,
    fail: checks.filter((x) => x.status === "fail").length,
    skip: checks.filter((x) => x.status === "skip").length,
  };
}

function metricsOf(label: string, m: SubjectMetrics | null, out: CaseScore["metrics"]): void {
  if (!m) return;
  for (const [k, v] of Object.entries(m)) out[`${label}.${k}`] = v;
}

function skippedCase(c: ProductCase, note: string): CaseScore {
  return { id: c.id, slug: c.slug, title: c.title, covers: c.covers, clauses: [...c.clauses], golden: c.golden === true, status: "skipped", knownGapsOnly: false, note, checks: [], counts: { pass: 0, fail: 0, skip: 0 }, metrics: {} };
}

async function runCase(c: ProductCase, env: CaseEnv, log: (s: string) => void, strictHours: boolean): Promise<CaseScore> {
  const base = { id: c.id, slug: c.slug, title: c.title, covers: c.covers, clauses: [...c.clauses], golden: c.golden === true };
  if (env.source === "recorded") {
    const missing = (c.recorded ?? []).filter((id) => !env.recorded?.has(id));
    if (!c.recorded || c.recorded.length === 0) return skippedCase(c, "fixture world only (needs a scenario knob or a world variant)");
    const needsAll = (c.recordedNeeds ?? "all") === "all";
    if (missing.length === c.recorded.length || (needsAll && missing.length > 0)) return skippedCase(c, `no recorded plan for ${missing.join(", ")}`);
  }
  const checks: CheckResult[] = [];
  const metrics: CaseScore["metrics"] = {};
  try {
    const out = await c.run(env);
    checks.push(...out.checks);
    for (const s of out.subjects) {
      const r = await checkSubject(s, { strictHours });
      checks.push(...r.checks);
      metricsOf(s.label, r.metrics, metrics);
    }
    Object.assign(metrics, out.metrics ?? {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: "case ran to the end", status: "fail", detail: msg });
  }
  for (const x of checks) {
    const gap = knownGapFor(c.id, x);
    if (gap) x.knownGap = `${gap.owner}: ${gap.note}`;
  }
  const counts = countChecks(checks);
  const status: CaseStatus = counts.fail > 0 || checks.length === 0 ? "failed" : "passed";
  const fails = checks.filter((x) => x.status === "fail");
  const knownGapsOnly = status === "failed" && fails.length > 0 && fails.every((x) => !!x.knownGap);
  log(`${c.id} ${status.padEnd(6)} ${c.slug} (${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip)${knownGapsOnly ? " [known gap]" : ""}`);
  for (const f of fails) log(`    ${f.knownGap ? "KNOWN GAP" : "FAIL"} ${f.subject ? `[${f.subject}] ` : ""}${f.name}: ${f.detail}`);
  return { ...base, status, knownGapsOnly, checks, counts, metrics };
}

function tally(cases: CaseScore[], id: ClauseId): { pass: number; fail: number; skip: number; failedIn: string[] } {
  const checks = cases.flatMap((c) => c.checks.filter((x) => x.clause === id).map((x) => ({ x, c: c.id })));
  return {
    pass: checks.filter(({ x }) => x.status === "pass").length,
    fail: checks.filter(({ x }) => x.status === "fail").length,
    skip: checks.filter(({ x }) => x.status === "skip").length,
    failedIn: [...new Set(checks.filter(({ x }) => x.status === "fail").map(({ c }) => c))],
  };
}

/**
 * Definition-of-done clauses (D1-D4) speak about the goldens, so they are
 * scored on the golden cases; the same checks on the edge-case sheets are
 * reported in the note. Spec clauses (S1-S4) are scored on every case.
 */
function clauseScores(cases: CaseScore[]): ClauseScore[] {
  return CLAUSES.map((cl) => {
    const goldensOnly = cl.scope === "goldens";
    const scoped = goldensOnly ? cases.filter((c) => c.golden) : cases;
    const covering = scoped.filter((c) => c.clauses.includes(cl.id) && c.status !== "skipped").map((c) => c.id);
    const t = tally(scoped, cl.id);
    let status: ClauseScore["status"];
    if (cl.checkedBy === "ci") status = "ci";
    else if (t.fail > 0) status = "failed";
    else if (t.pass > 0 && t.skip === 0) status = "verified";
    else status = "not verified";
    const score: ClauseScore = { id: cl.id, text: cl.text, source: cl.source, checkedBy: cl.checkedBy, scope: cl.scope, status, cases: covering, pass: t.pass, fail: t.fail, skip: t.skip };
    const notes: string[] = [];
    if (CI_NOTES[cl.id]) notes.push(CI_NOTES[cl.id] as string);
    if (status === "not verified" && t.skip > 0) notes.push(`${t.skip} check(s) skipped: see the case details`);
    if (cl.id === "D3") {
      // The default reading passes a partner Qloo lists without hours when the sheet says "call first"; say how many.
      const callAhead = scoped.flatMap((c) => Object.entries(c.metrics).filter(([k, v]) => k.endsWith(".partnersCallAhead") && typeof v === "number" && v > 0).map(([k, v]) => `${k.slice(0, -".partnersCallAhead".length)}: ${String(v)}`));
      if (callAhead.length > 0) notes.push(`partners with no hours from Qloo, passed as "call first" (--strict-hours fails them): ${callAhead.join(", ")}`);
    }
    if (goldensOnly) {
      const other = tally(cases.filter((c) => !c.golden), cl.id);
      if (other.pass + other.fail > 0) {
        notes.push(`outside the goldens: ${other.pass} pass, ${other.fail} fail${other.failedIn.length ? ` (${other.failedIn.join(", ")})` : ""}`);
      }
    }
    if (notes.length > 0) score.note = notes.join("; ");
    return score;
  });
}

export async function runProductEval(opts: RunOptions = {}): Promise<Score> {
  const source = opts.source ?? "fixture";
  const log = opts.log ?? (() => {});
  const env: CaseEnv = { source };
  if (source === "recorded") {
    if (!opts.plans) throw new Error("--source recorded needs --plans <dir | plans.sqlite>");
    env.recorded = await loadRecordedPlans(opts.plans);
    log(`recorded plans: ${[...env.recorded.keys()].join(", ") || "none"}`);
  }
  const cases: CaseScore[] = [];
  for (const c of CASES) {
    if (!selected(c, opts.only)) {
      cases.push(skippedCase(c, "not selected"));
      continue;
    }
    cases.push(await runCase(c, env, log, opts.strictHours === true));
  }
  const failed = cases.filter((c) => c.status === "failed");
  return {
    format: SCORE_FORMAT,
    formatVersion: SCORE_VERSION,
    source: source === "fixture" ? "fixture-world" : "recorded",
    worldSeed: source === "fixture" ? DEFAULT_WORLD_SEED : null,
    recordedPlans: env.recorded
      ? [...env.recorded.values()].map((r) => ({
          presetId: r.presetId,
          source: r.source,
          planId: r.result.planId,
          mode: r.result.sheet?.mode ?? r.result.mode,
          createdAt: r.result.sheet?.createdAt ?? null,
        }))
      : null,
    generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    passed: cases.filter((c) => c.status === "passed").length,
    failed: failed.length,
    knownGaps: failed.filter((c) => c.knownGapsOnly).length,
    unexpectedFailures: failed.filter((c) => !c.knownGapsOnly).length,
    skipped: cases.filter((c) => c.status === "skipped").length,
    total: cases.length,
    strictHours: opts.strictHours === true,
    clauses: clauseScores(cases),
    cases,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function scoreMarkdown(score: Score): string {
  const lines: string[] = [];
  lines.push("# Product eval score", "");
  lines.push(
    `Source: ${
      score.source === "fixture-world"
        ? `fixture world (synthetic stand-in for Qloo and Ticketmaster; seed \`${score.worldSeed}\`). No live API was called.`
        : `recorded plans (${(score.recordedPlans ?? []).map((p) => `${p.presetId}: ${p.mode} sheet from ${p.source}`).join("; ") || "none"}).`
    }`,
  );
  lines.push(`Generated: ${score.generatedAt}`, "");
  lines.push(
    `**${score.passed} passed, ${score.failed} failed (${score.knownGaps} on known product gaps only, ${score.unexpectedFailures} unexpected), ${score.skipped} skipped, of ${score.total} cases.**`,
    "",
  );
  if (score.strictHours) lines.push("Strict hours: a partner with no hours from Qloo counts as not shown open, even when the sheet says call first.", "");
  lines.push("## Definition of done", "", "Clauses D1-D4 are scored on the golden cases; S1-S4 on every case.", "", "| Clause | Status | Cases | Checks (pass / fail / skip) |", "|---|---|---|---|");
  for (const cl of score.clauses) {
    lines.push(`| ${cl.id}. ${cell(cl.text)} | ${cl.status}${cl.note ? ` (${cell(cl.note)})` : ""} | ${cl.cases.join(", ") || "-"} | ${cl.pass} / ${cl.fail} / ${cl.skip} |`);
  }
  lines.push("", "## Cases", "", "| Case | Status | Checks (pass / fail / skip) | Clauses |", "|---|---|---|---|");
  for (const c of score.cases) {
    const status = `${c.status}${c.knownGapsOnly ? " (known gap)" : ""}${c.note ? ` (${cell(c.note)})` : ""}`;
    lines.push(`| ${c.id} ${cell(c.title)} | ${status} | ${c.counts.pass} / ${c.counts.fail} / ${c.counts.skip} | ${c.clauses.join(", ")} |`);
  }
  const failed = score.cases.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    lines.push("", "## Failures", "");
    for (const c of failed) {
      lines.push(`### ${c.id} ${c.title}`, "");
      for (const x of c.checks.filter((k) => k.status === "fail")) {
        lines.push(`- ${x.knownGap ? "Known gap. " : ""}${x.subject ? `[${x.subject}] ` : ""}${x.name}: ${x.detail}.${x.knownGap ? ` Owner: ${x.knownGap}` : ""}`);
      }
      lines.push("");
    }
  }
  lines.push("", "## Key numbers", "");
  const keys = ["partners", "prePost", "grounded", "hoursUnverified", "qlooFresh", "coreBillCalls", "venueCalls", "fallbackCalls", "guardDropped", "citationDrops"];
  lines.push(`| Case | Sheet | ${keys.join(" | ")} |`, `|---|---|${keys.map(() => "---").join("|")}|`);
  for (const c of score.cases) {
    const labels = [...new Set(Object.keys(c.metrics).filter((k) => k.endsWith(".partners")).map((k) => k.slice(0, -".partners".length)))];
    for (const l of labels) lines.push(`| ${c.id} | ${cell(l)} | ${keys.map((k) => String(c.metrics[`${l}.${k}`] ?? "-")).join(" | ")} |`);
  }
  lines.push(
    "",
    "Core bill-level calls exclude coded fallbacks (shown on their cards) and the per-name lookups of typed partners. Grounding checks every partner and pre/post spot against the place data Qloo returned for it (closed flag and hours, as stored on the sheet); it is not an independent source.",
    "",
  );
  return lines.join("\n");
}

export function writeScore(score: Score, outDir = DEFAULT_OUT_DIR): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const json = join(outDir, "score.json");
  const md = join(outDir, "score.md");
  writeFileSync(json, `${JSON.stringify(score, null, 2)}\n`, "utf8");
  writeFileSync(md, scoreMarkdown(score), "utf8");
  return { json, md };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  source: "fixture" | "recorded";
  plans?: string;
  out: string;
  only?: string[];
  quiet: boolean;
  strictHours: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { source: "fixture", out: DEFAULT_OUT_DIR, quiet: false, strictHours: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--source") {
      const v = next();
      if (v !== "fixture" && v !== "recorded") throw new Error(`--source must be fixture or recorded, not ${v}`);
      args.source = v;
    } else if (a === "--plans") args.plans = next();
    else if (a === "--out") args.out = resolve(next());
    else if (a === "--only") args.only = next().split(",").map((x) => x.trim()).filter(Boolean);
    else if (a === "--quiet") args.quiet = true;
    else if (a === "--strict-hours") args.strictHours = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  if (args.source === "recorded" && !args.plans) throw new Error("--source recorded needs --plans <dir | plans.sqlite>");
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const log = args.quiet ? () => {} : (s: string) => console.log(s);
  const opts: RunOptions = { source: args.source, log, strictHours: args.strictHours };
  if (args.plans) opts.plans = args.plans;
  if (args.only) opts.only = args.only;
  let score: Score;
  try {
    score = await runProductEval(opts);
  } catch (err) {
    // Only reading the recorded plans throws here (each case reports its own errors).
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const files = writeScore(score, args.out);
  console.log(`${score.passed} passed, ${score.failed} failed (${score.knownGaps} known gap), ${score.skipped} skipped -> ${files.json}`);
  return score.unexpectedFailures > 0 ? 1 : 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
