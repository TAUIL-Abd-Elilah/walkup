/**
 * Day-one API probe. Self-contained: raw fetch, its own 3 req/s pacing and a
 * hard call cap (100). Outputs go to probe_out/<timestamp>/ (git-ignored):
 * one JSON per probe with request params (no key) and derived numbers, plus
 * SUMMARY.md with the verdict table and the KG1-KG4 go/no-go lines.
 *
 *   npm run probe -- --dry-run              print every planned request; no key needed
 *   npm run probe -- --only=1,2,3           the three gates first
 *   npm run probe                           full run (all 20 probes)
 *
 * Flags: --dry-run, --only=<list>, --verbose, --budget=<n<=100>, --config=<path>, --out=<dir>, --help
 * Env:   QLOO_API_KEY (required for live runs), QLOO_BASE_URL (default as in .env.example). A .env at
 *        the repo root is loaded for live runs. The key is sent only as the X-Api-Key header.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProbeConfig, loadConfig } from "./lib/probe/config.js";
import { writeOutputs } from "./lib/probe/output.js";
import { parseOnly, runOrder } from "./lib/probe/registry.js";
import { DEFAULT_BASE_URL } from "./lib/probe/requests.js";
import { runProbes } from "./lib/probe/runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

interface Args {
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
  only: number[] | null;
  budget: number;
  config: string;
  out: string;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    dryRun: false,
    verbose: false,
    help: false,
    only: null,
    budget: 100,
    config: resolve(HERE, "probe.config.json"),
    out: resolve(ROOT, "probe_out"),
  };
  for (const a of argv) {
    const [flag, value] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    switch (flag) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--verbose":
      case "-v":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--only":
        if (!value) throw new Error("--only needs a value, e.g. --only=1,2,3");
        args.only = parseOnly(value);
        break;
      case "--budget": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("--budget must be an integer from 1 to 100");
        args.budget = n;
        break;
      }
      case "--config":
        if (!value) throw new Error("--config needs a path");
        args.config = resolve(value);
        break;
      case "--out":
        if (!value) throw new Error("--out needs a directory");
        args.out = resolve(value);
        break;
      default:
        throw new Error(`unknown argument "${a}" (see --help)`);
    }
  }
  return args;
}

function usage(): string {
  const list = runOrder()
    .map((p) => `  #${String(p.id).padStart(2)} ${p.title}${p.gate ? ` [${p.gate}]` : ""}`)
    .join("\n");
  return [
    "usage: npm run probe -- [--dry-run] [--only=1,2,3] [--verbose] [--budget=N] [--config=path] [--out=dir]",
    "",
    "Run order (gates first):",
    list,
  ].join("\n");
}

function loadDotEnv(): void {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  try {
    process.loadEnvFile(p);
  } catch {
    console.error("warning: could not read .env; using the process environment only");
  }
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(usage());
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }

  let cfg: ProbeConfig;
  try {
    cfg = loadConfig(args.config);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }

  if (!args.dryRun) loadDotEnv();
  const apiKey = args.dryRun ? null : (process.env.QLOO_API_KEY ?? "").trim() || null;
  const baseUrl = (process.env.QLOO_BASE_URL ?? "").trim() || DEFAULT_BASE_URL;
  if (!args.dryRun && !apiKey) {
    console.error("QLOO_API_KEY is not set. Put it in .env or the environment, or run with --dry-run to see the plan.");
    return 2;
  }
  if (!baseUrl.startsWith("https://")) {
    console.error(`QLOO_BASE_URL must be https (got a non-https URL)`);
    return 2;
  }

  const readOptionalJson = (rel: string): unknown => {
    const p = isAbsolute(rel) ? rel : resolve(ROOT, rel);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      console.error(`warning: ${rel} is not valid JSON; ignoring it`);
      return null;
    }
  };

  console.log(`${args.dryRun ? "DRY RUN: nothing is sent" : "LIVE"} | host ${new URL(baseUrl).host} | cap ${args.budget} calls | 3 req/s`);
  const result = await runProbes({
    cfg,
    dryRun: args.dryRun,
    only: args.only,
    verbose: args.verbose,
    budgetMax: args.budget,
    apiKey,
    baseUrl,
    log: (line) => console.log(line),
    readOptionalJson,
  });

  console.log("");
  if (args.dryRun) {
    console.log(`Planned ${result.calls} requests (cap ${result.budgetMax}). Nothing was sent and nothing was written.`);
    if (result.calls > result.budgetMax) console.log("warning: the plan exceeds the cap; a live run would abort before the end.");
    return 0;
  }
  const dir = writeOutputs(args.out, result, { baseUrl, configPath: relative(ROOT, args.config), only: args.only, apiKey });
  console.log(`Calls made: ${result.calls}/${result.budgetMax}. Monthly quota remaining: ${result.monthRemaining ?? "unknown"}.`);
  console.log(`Wrote ${relative(ROOT, dir)}${"/"}SUMMARY.md`);
  if (result.aborted) {
    console.log(`Run aborted: ${result.aborted}`);
    return 3;
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
