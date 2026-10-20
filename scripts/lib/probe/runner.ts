/** Runs the selected probes in order with one shared client, memo, pacing and budget. */

import { type Transport, ProbeClient } from "./client.js";
import type { ProbeConfig } from "./config.js";
import { BudgetExceededError, CallBudget, type Clock, QuotaGuardError, RateLimiter, realClock } from "./limiter.js";
import { runOrder } from "./registry.js";
import type { CallRecord, ProbeContext, ProbeDef, ProbeOutcome, RequestSpec, SharedState } from "./types.js";

export interface RunOptions {
  cfg: ProbeConfig;
  dryRun: boolean;
  only?: readonly number[] | null;
  verbose: boolean;
  budgetMax: number;
  apiKey: string | null;
  baseUrl: string;
  transport?: Transport;
  clock?: Clock;
  log: (line: string) => void;
  readOptionalJson: (relPath: string) => unknown;
}

export interface ProbeRun {
  def: ProbeDef;
  outcome: ProbeOutcome;
  requests: CallRecord[];
  startedAt: string;
  finishedAt: string;
}

export interface RunResult {
  dryRun: boolean;
  runs: ProbeRun[];
  /** API calls made (live) or requests planned (dry run). */
  calls: number;
  budgetMax: number;
  aborted: string | null;
  rateHeaders: Record<string, string>;
  monthRemaining: number | null;
  startedAt: string;
  finishedAt: string;
}

export async function runProbes(o: RunOptions): Promise<RunResult> {
  const clock = o.clock ?? realClock;
  const budgetMax = Math.min(o.budgetMax, o.cfg.run.maxCalls, 100);
  const budget = new CallBudget(budgetMax);
  const client = new ProbeClient({
    baseUrl: o.baseUrl,
    apiKey: o.apiKey,
    dryRun: o.dryRun,
    budget,
    limiter: new RateLimiter(Math.min(o.cfg.run.ratePerSecond, 3), clock),
    clock,
    maxRetries: o.cfg.run.maxRetries,
    timeoutMs: o.cfg.run.timeoutMs,
    minMonthRemaining: o.cfg.run.minMonthRemaining,
    ...(o.transport ? { transport: o.transport } : {}),
    onCall: (record, spec, curl) => logCall(o, record, spec, curl),
  });
  const state: SharedState = {};
  const ctx: ProbeContext = {
    dryRun: o.dryRun,
    cfg: o.cfg,
    call: (spec) => client.call(spec),
    state,
    log: o.log,
    readOptionalJson: o.readOptionalJson,
  };

  const startedAt = new Date(clock.now()).toISOString();
  const runs: ProbeRun[] = [];
  let aborted: string | null = null;
  for (const def of runOrder(o.only)) {
    const requests: CallRecord[] = [];
    const t0 = new Date(clock.now()).toISOString();
    if (aborted) {
      runs.push({ def, outcome: notRun(aborted), requests, startedAt: t0, finishedAt: t0 });
      continue;
    }
    client.setSink(requests);
    o.log(`\n#${def.id} ${def.title}${def.gate ? ` [${def.gate}]` : ""}`);
    let outcome: ProbeOutcome;
    try {
      outcome = await def.run(ctx);
    } catch (err) {
      if (err instanceof BudgetExceededError || err instanceof QuotaGuardError) {
        aborted = err.message;
        outcome = { status: "aborted", headline: "aborted mid-probe", lines: [err.message], derived: {} };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        outcome = { status: "error", headline: "error", lines: [redact(msg, o.apiKey)], derived: {} };
      }
    }
    outcome = flagDroppedSignals(outcome, requests);
    const fresh = requests.filter((r) => !r.memo).length;
    for (const line of outcome.lines) o.log(`  - ${line}`);
    o.log(`  -> ${outcome.status}: ${outcome.headline} (${fresh} new ${o.dryRun ? "planned" : "calls"}, ${client.callCount} total)`);
    runs.push({ def, outcome, requests, startedAt: t0, finishedAt: new Date(clock.now()).toISOString() });
  }
  return {
    dryRun: o.dryRun,
    runs,
    calls: client.callCount,
    budgetMax,
    aborted,
    rateHeaders: { ...client.rateHeaders },
    monthRemaining: client.monthRemaining,
    startedAt,
    finishedAt: new Date(clock.now()).toISOString(),
  };
}

/**
 * A probe whose calls had a signal id dropped by Qloo (not_found) did not test what it meant to:
 * pass, partial and fail become inconclusive, with one line per call. The resolver's own signal
 * checks are expected to report drops and are left out.
 */
export function flagDroppedSignals(outcome: ProbeOutcome, requests: CallRecord[]): ProbeOutcome {
  const hit = requests.filter((r) => r.purpose !== "signal-check" && (r.notFound?.length ?? 0) > 0);
  if (hit.length === 0) return outcome;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of hit) {
    const key = `${r.label}|${(r.notFound ?? []).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`Qloo ignored signal ${(r.notFound ?? []).join(", ")} on '${r.label}' (not_found)`);
  }
  const downgrade = outcome.status === "pass" || outcome.status === "partial" || outcome.status === "fail";
  return {
    ...outcome,
    status: downgrade ? "inconclusive" : outcome.status,
    headline: downgrade ? `${outcome.headline} (signal dropped: inconclusive)` : outcome.headline,
    lines: [...outcome.lines, ...lines],
    derived: { ...outcome.derived, droppedSignals: [...new Set(hit.flatMap((r) => r.notFound ?? []))] },
  };
}

function notRun(reason: string): ProbeOutcome {
  return { status: "aborted", headline: "not run", lines: [`not run: ${reason}`], derived: {} };
}

function logCall(o: RunOptions, r: CallRecord, spec: RequestSpec, curl: string): void {
  if (o.dryRun) {
    if (r.memo) {
      if (o.verbose) o.log(`  (reuses [${r.seq}]) ${r.label}`);
      return;
    }
    o.log(`  [${r.seq}] ${spec.method} ${spec.path}  ${r.label}`);
    for (const [k, v] of Object.entries(spec.params)) o.log(`        ${k} = ${String(v)}`);
    if (spec.body) o.log(`        body = ${JSON.stringify(spec.body)}`);
    if (o.verbose) o.log(`        ${curl}`);
    return;
  }
  if (r.memo) {
    if (o.verbose) o.log(`  (memo [${r.seq}]) ${r.label}`);
    return;
  }
  const rl = Object.entries(r.headers)
    .filter(([k]) => /ratelimit|rate-limit|retry-after/i.test(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const line = `  [${r.seq}] ${r.status ?? "ERR"} ${spec.method} ${spec.path} ${r.ms} ms ${(r.bytes / 1024).toFixed(1)} KB${
    r.attempts > 1 ? ` (${r.attempts} attempts)` : ""
  }  ${r.label}`;
  o.log(o.verbose ? `${line}\n        ${rl || "(no rate-limit headers)"}` : line);
  if (o.verbose) {
    const other = Object.entries(r.headers)
      .filter(([k]) => !/ratelimit|rate-limit|retry-after/i.test(k))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (other) o.log(`        headers: ${other}`);
    for (const [k, v] of Object.entries(spec.params)) o.log(`        ${k} = ${String(v)}`);
    if (spec.body) o.log(`        body = ${JSON.stringify(spec.body)}`);
  }
  if (r.error) o.log(`        error: ${redact(r.error, o.apiKey)}`);
}

function redact(text: string, key: string | null): string {
  return key && key.length >= 4 ? text.split(key).join("[REDACTED]") : text;
}
