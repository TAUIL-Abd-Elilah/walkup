/**
 * P1 "Fan-Bar Test" arm runner (docs/preregistration/p1-plan.md, contract evals/p1/ARMS.md).
 *
 *   npx tsx evals/p1/run_arms.ts --dry-run              plan and call counts; no keys, nothing sent
 *   npx tsx evals/p1/run_arms.ts --viability            §13 probe: Houston, Chicago, Durham (Q-signal)
 *   npx tsx evals/p1/run_arms.ts                        the preregistered run (all arms)
 *   npx tsx evals/p1/run_arms.ts --arms Q-pop,Q-signal  only these arms (resolution always runs first)
 *
 * Writes evals/out/private/p1_arms.csv and p1_bars_status.csv (git-ignored; the inputs of
 * evals/p1/analyze.py), a private run log and ledger, evals/out/p1_arms_summary.{json,md}
 * (aggregate counts only), and evals/p1/club_entities.json and pinned_tags.json (ids only).
 * Every response is cached under data/private/p1/run/, so a stopped run resumes.
 *
 * Exit codes: 0 done; 2 usage or configuration; 3 stopped by a guard (re-run to resume);
 * 4 the location filter was not honoured (plan §8: stop and log a deviation); 1 other errors.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { parseBars } from "./arms/bars";
import { errorText, isStop } from "./arms/errors";
import type { ModelClient } from "./arms/model-arms";
import { planRun, QLOO_DEFAULT_CAP, renderPlan } from "./arms/plan";
import { ARMS, canonicalArm, type ArmName } from "./arms/protocol";
import { runP1 } from "./arms/runner";
import { barsMatchSeal, createServices, planMatchesSeal } from "./arms/services";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
/** Per-request timeout for Google Places and the Census Geocoder. */
const HTTP_TIMEOUT_MS = 30_000;

export interface CliArgs {
  help: boolean;
  dryRun: boolean;
  json: boolean;
  limit: number | null;
  arms: ArmName[];
  viability: boolean;
  noGoogle: boolean;
  retryFailed: boolean;
  bars: string;
  out: string;
  publicOut: string;
  pinsDir: string;
  stateDir: string;
  maxQlooCalls: number;
  placesDailyCap: number;
  llmDailyCapUsd: number;
  llmConcurrency: number;
}

export function defaultArgs(root: string = ROOT): CliArgs {
  return {
    help: false,
    dryRun: false,
    json: false,
    limit: null,
    arms: [...ARMS],
    viability: false,
    noGoogle: false,
    retryFailed: false,
    bars: join(root, "data", "private", "p1", "bars_full.csv"),
    out: join(root, "evals", "out", "private"),
    publicOut: join(root, "evals", "out"),
    pinsDir: join(root, "evals", "p1"),
    stateDir: join(root, "data", "private", "p1", "run"),
    maxQlooCalls: QLOO_DEFAULT_CAP,
    placesDailyCap: 300,
    llmDailyCapUsd: 5,
    llmConcurrency: 1,
  };
}

function positiveInt(flag: string, v: string | undefined): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer`);
  return n;
}

export function parseArgs(argv: readonly string[], root: string = ROOT): CliArgs {
  const a = defaultArgs(root);
  const takesValue = new Set([
    "--limit",
    "--arms",
    "--bars",
    "--out",
    "--public-out",
    "--pins-dir",
    "--state-dir",
    "--max-qloo-calls",
    "--places-daily-cap",
    "--llm-daily-cap-usd",
    "--llm-concurrency",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] as string;
    const eq = raw.indexOf("=");
    const flag = raw.startsWith("--") && eq > 0 ? raw.slice(0, eq) : raw;
    let value: string | undefined = raw.startsWith("--") && eq > 0 ? raw.slice(eq + 1) : undefined;
    if (takesValue.has(flag) && value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
    }
    switch (flag) {
      case "--help":
      case "-h":
        a.help = true;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--viability":
        a.viability = true;
        break;
      case "--no-google":
        a.noGoogle = true;
        break;
      case "--retry-failed":
        a.retryFailed = true;
        break;
      case "--limit":
        a.limit = positiveInt(flag, value);
        break;
      case "--arms": {
        const list = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(canonicalArm);
        if (list.length === 0) throw new Error("--arms needs at least one arm");
        a.arms = ARMS.filter((x) => list.includes(x));
        break;
      }
      case "--bars":
        a.bars = resolve(value as string);
        break;
      case "--out":
        a.out = resolve(value as string);
        break;
      case "--public-out":
        a.publicOut = resolve(value as string);
        break;
      case "--pins-dir":
        a.pinsDir = resolve(value as string);
        break;
      case "--state-dir":
        a.stateDir = resolve(value as string);
        break;
      case "--max-qloo-calls":
        a.maxQlooCalls = positiveInt(flag, value);
        break;
      case "--places-daily-cap":
        a.placesDailyCap = positiveInt(flag, value);
        break;
      case "--llm-concurrency":
        a.llmConcurrency = Math.min(8, positiveInt(flag, value));
        break;
      case "--llm-daily-cap-usd": {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) throw new Error("--llm-daily-cap-usd needs a positive number");
        a.llmDailyCapUsd = n;
        break;
      }
      default:
        throw new Error(`unknown argument "${raw}" (see --help)`);
    }
  }
  if (a.viability && a.limit !== null) throw new Error("--viability and --limit cannot be combined");
  return a;
}

export const USAGE = `usage: npx tsx evals/p1/run_arms.ts [options]

  --dry-run                plan and call counts from the bars table; no keys, nothing sent or written
  --json                   with --dry-run: print the plan as JSON
  --limit N                smoke run: the first N (club, metro) queries only
  --arms LIST              arms to run, e.g. Q-signal,Q-pop (default: Q-pop,Q-signal,F,L,Q-derby)
  --viability              plan §13 probe: Houston, Chicago and Durham queries, Q-signal only
  --no-google              no Google Places: provisional coverage (no closed check), no arm F
  --retry-failed           re-run F / L conversations recorded as failed
  --max-qloo-calls N       Qloo requests per run before it stops to resume later (default 900)
  --places-daily-cap N     Google Places requests per Pacific day (default 300; plan cap 2,500 in total)
  --llm-daily-cap-usd X    model spend per UTC day (default 5)
  --llm-concurrency N      F / L conversations in parallel (default 1, max 8)
  --bars PATH              ground truth (default data/private/p1/bars_full.csv)
  --out DIR                private outputs (default evals/out/private)
  --public-out DIR         aggregate summary (default evals/out)
  --pins-dir DIR           club_entities.json and pinned_tags.json (default evals/p1)
  --state-dir DIR          cache and run state (default data/private/p1/run)

Keys (from .env): QLOO_API_KEY; GOOGLE_PLACES_API_KEY unless --no-google; ANTHROPIC_API_KEY for F and L.`;

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  try {
    process.loadEnvFile(p);
  } catch {
    console.error("warning: could not read .env; using the process environment only");
  }
}

function anthropicClient(): ModelClient | null {
  if (!process.env["ANTHROPIC_API_KEY"] && !process.env["ANTHROPIC_AUTH_TOKEN"]) return null;
  // SDK retries off: the runner retries 3 times with the plan's 1 s / 2 s / 4 s backoff itself.
  const sdk = new Anthropic({ maxRetries: 0 });
  return { messages: { create: (params) => sdk.messages.create(params) } };
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(errorText(err));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!existsSync(args.bars)) {
    console.error(`bars table not found: ${args.bars} (it is git-ignored; run evals/p1/collect_bars.py and centroids.py first)`);
    return 2;
  }
  let bars;
  try {
    bars = parseBars(readFileSync(args.bars, "utf8"));
  } catch (err) {
    console.error(errorText(err));
    return 2;
  }
  const planSealed = planMatchesSeal(ROOT);
  const barsSealed = barsMatchSeal(ROOT, args.bars);
  console.log(`p1-plan.md matches its sealed hash: ${planSealed ?? "not checked"}; input is the sealed table: ${barsSealed ?? "not checked"}.`);

  if (args.dryRun) {
    const plan = planRun(bars, {
      arms: args.arms,
      limit: args.limit,
      viability: args.viability,
      noGoogle: args.noGoogle,
      qlooCap: args.maxQlooCalls,
      placesDailyCap: args.placesDailyCap,
      today: new Date().toISOString().slice(0, 10),
    });
    if (args.json) console.log(JSON.stringify(plan, null, 2));
    else for (const line of renderPlan(plan)) console.log(line);
    console.log("DRY RUN: nothing was sent and nothing was written.");
    return 0;
  }

  loadDotEnv();
  const runArms: ArmName[] = args.viability ? ["Q-signal"] : args.arms;
  const needsModel = runArms.includes("F") || runArms.includes("L");
  const model = needsModel ? anthropicClient() : null;
  if (needsModel && !model) {
    console.error("ANTHROPIC_API_KEY is not set: arms F and L need it (or pass --arms without F and L).");
    return 2;
  }
  mkdirSync(args.stateDir, { recursive: true });
  let handle;
  try {
    handle = createServices({
      stateFile: join(args.stateDir, "p1-run.sqlite"),
      spendFile: join(args.stateDir, "anthropic-spend.json"),
      env: process.env,
      // Qloo's transport sets its own 30 s timeout. Places and the Census Geocoder get one here,
      // so a hung request fails as a network error and is retried (plan §8: timeouts are retried).
      qlooFetch: (url, init) => fetch(url, init),
      placesFetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }),
      censusFetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) }),
      modelClient: model,
      usePlaces: !args.noGoogle,
      maxQlooCalls: args.maxQlooCalls,
      placesDailyCap: args.placesDailyCap,
      llmDailyCapUsd: args.llmDailyCapUsd,
    });
  } catch (err) {
    console.error(errorText(err));
    return isStop(err) ? err.exitCode : 1;
  }
  try {
    const res = await runP1(handle.services, {
      bars,
      inputIsSealedTable: barsSealed,
      planMatchesSealedHash: planSealed,
      arms: args.arms,
      limit: args.limit,
      viability: args.viability,
      noGoogle: args.noGoogle,
      retryFailed: args.retryFailed,
      llmConcurrency: args.llmConcurrency,
      outDir: args.out,
      publicDir: args.publicOut,
      pinsDir: args.pinsDir,
      configTagsPath: join(ROOT, "config", "tags.json"),
    });
    for (const f of res.files) console.log(`wrote ${f}`);
    if (res.log.viability) {
      const v = res.log.viability;
      console.log(`Viability gate: ${v.resolved}/${v.combinations} resolved, ${v.in_q_signal_top50} in the Q-signal top 50: ${v.passes ? "passes" : "does not pass"}.`);
    }
    if (res.stopped) console.log(`Stopped (${res.stopped.kind}). Re-run the same command to resume from the cache.`);
    else if (!args.viability) console.log(`Next: python evals/p1/analyze.py --arms ${join(args.out, "p1_arms.csv")} --bars ${join(args.out, "p1_bars_status.csv")} --out evals/p1/out`);
    return res.exitCode;
  } finally {
    handle.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(errorText(err));
      process.exit(1);
    },
  );
}
