/**
 * Writes probe_out/<timestamp>/ (git-ignored): one JSON per probe (request
 * params, statuses, headers, derived numbers), run.json and SUMMARY.md.
 * Response bodies are never written. Every file is checked for the key first.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toCurl } from "./requests.js";
import type { RunResult } from "./runner.js";
import { renderSummary } from "./summary.js";

export function timestampDir(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

export function writeOutputs(
  outRoot: string,
  result: RunResult,
  meta: { baseUrl: string; configPath: string; only: readonly number[] | null; apiKey: string | null },
): string {
  const dir = join(outRoot, timestampDir(new Date(result.startedAt)));
  mkdirSync(dir, { recursive: true });
  const write = (name: string, text: string): void => {
    writeFileSync(join(dir, name), assertNoKey(text, meta.apiKey), "utf8");
  };

  for (const r of result.runs) {
    const doc = {
      probe: r.def.id,
      slug: r.def.slug,
      title: r.def.title,
      gate: r.def.gate ?? null,
      criterion: r.def.criterion,
      ifFails: r.def.ifFails,
      status: r.outcome.status,
      headline: r.outcome.headline,
      lines: r.outcome.lines,
      derived: r.outcome.derived,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      requests: r.requests.map((q) => ({
        ...q,
        curl: toCurl(meta.baseUrl, { method: q.method, path: q.path, params: q.params, label: q.label, ...(q.body ? { body: q.body } : {}) }),
      })),
    };
    write(`probe-${String(r.def.id).padStart(2, "0")}-${r.def.slug}.json`, `${JSON.stringify(doc, jsonSafe, 2)}\n`);
  }
  const run = {
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    dryRun: result.dryRun,
    host: new URL(meta.baseUrl).host,
    calls: result.calls,
    budgetMax: result.budgetMax,
    aborted: result.aborted,
    monthRemaining: result.monthRemaining,
    rateHeaders: result.rateHeaders,
    /** Every response header name seen in this run (values are in the per-probe files). */
    headerNames: [...new Set(result.runs.flatMap((r) => r.requests.flatMap((q) => Object.keys(q.headers))))].sort(),
    only: meta.only,
    statuses: Object.fromEntries(result.runs.map((r) => [r.def.id, r.outcome.status])),
  };
  write("run.json", `${JSON.stringify(run, jsonSafe, 2)}\n`);
  write("SUMMARY.md", renderSummary(result, { baseHost: new URL(meta.baseUrl).host, configPath: meta.configPath, only: meta.only }));
  return dir;
}

/** Throws if the key appears anywhere in text that is about to be written. */
export function assertNoKey(text: string, apiKey: string | null): string {
  if (apiKey && apiKey.length >= 4 && text.includes(apiKey)) {
    throw new Error("refusing to write output: it contains the API key");
  }
  return text;
}

function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value instanceof Set) return [...value];
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}
