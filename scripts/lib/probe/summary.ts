/** Renders SUMMARY.md: run facts, the verdict table and the KG1-KG4 go/no-go lines. */

import type { ProbeRun, RunResult } from "./runner.js";
import type { GateId, ProbeStatus } from "./types.js";

const GATES: { gate: GateId; probe: number; name: string; go: string }[] = [
  { gate: "KG1", probe: 1, name: "taste moves partners", go: "Build partner ranking as the core of the sheet." },
  { gate: "KG2", probe: 2, name: "lift differs from heat", go: "Keep the lift map as the street-team plan." },
  { gate: "KG3", probe: 6, name: "comedy headliner signal density", go: "The comedy scenario runs on the headliner's own heatmap." },
  { gate: "KG4", probe: 3, name: "fan-bar test viability", go: "Run the fan-bar test as the headline proof." },
];

export type GateVerdict = "GO" | "NO-GO" | "INCONCLUSIVE" | "NOT RUN";

export function gateVerdict(status: ProbeStatus | undefined): GateVerdict {
  switch (status) {
    case "pass":
      return "GO";
    case "fail":
      return "NO-GO";
    case undefined:
    case "aborted":
    case "planned":
      return "NOT RUN";
    default:
      return "INCONCLUSIVE";
  }
}

export function gateLines(result: RunResult): string[] {
  return GATES.map((g) => {
    const run = result.runs.find((r) => r.def.id === g.probe);
    const verdict = gateVerdict(run?.outcome.status);
    const why = run ? `${run.outcome.headline}` : "probe not selected";
    const next =
      verdict === "GO" ? g.go : verdict === "NO-GO" ? (run?.def.ifFails ?? "") : "Re-run this probe once its inputs are filled; no decision yet.";
    return `- **${g.gate} (${g.name}, probe #${g.probe}): ${verdict}**: ${why}. Next: ${next}`;
  });
}

export function renderSummary(result: RunResult, meta: { baseHost: string; configPath: string; only: readonly number[] | null }): string {
  const out: string[] = [];
  out.push(`# Probe run ${result.startedAt}`);
  out.push("");
  out.push(`- Mode: ${result.dryRun ? "dry run (no calls made)" : "live"}`);
  out.push(`- Host: ${meta.baseHost}`);
  out.push(`- Config: ${meta.configPath}`);
  out.push(`- Probes selected: ${meta.only ? meta.only.join(", ") : "all"}`);
  out.push(`- ${result.dryRun ? "Requests planned" : "API calls made (retries included)"}: ${result.calls} of a ${result.budgetMax}-call cap`);
  if (result.monthRemaining !== null) out.push(`- Monthly quota remaining after the run: ${result.monthRemaining}`);
  if (result.aborted) out.push(`- **Run aborted:** ${result.aborted}`);
  const rl = Object.entries(result.rateHeaders);
  out.push(`- Rate-limit headers (last seen): ${rl.length ? rl.map(([k, v]) => `\`${k}: ${v}\``).join(", ") : "none seen"}`);
  out.push("");
  out.push("## Go / no-go");
  out.push("");
  out.push(...gateLines(result));
  out.push("");
  out.push("## Verdicts");
  out.push("");
  out.push("| # | Probe | Pass criterion | Result | Numbers | Calls | If it fails |");
  out.push("|---|---|---|---|---|---|---|");
  for (const r of [...result.runs].sort((a, b) => a.def.id - b.def.id)) {
    const fresh = r.requests.filter((q) => !q.memo).length;
    out.push(
      `| ${r.def.id} | ${cell(r.def.title)} | ${cell(r.def.criterion)} | ${r.outcome.status.toUpperCase()} | ${cell(r.outcome.headline)} | ${fresh} | ${cell(
        r.def.ifFails,
      )} |`,
    );
  }
  out.push("");
  out.push("## Details");
  for (const r of [...result.runs].sort((a, b) => a.def.id - b.def.id)) out.push(...details(r));
  out.push("");
  out.push(
    "Outputs hold request parameters (no key) and derived numbers only: counts, ranks, overlaps, correlations, flags and ids. No response bodies are saved.",
  );
  out.push("");
  return out.join("\n");
}

function details(r: ProbeRun): string[] {
  const out = ["", `### #${r.def.id} ${r.def.title}: ${r.outcome.status}`, ""];
  if (r.outcome.lines.length === 0) out.push("- (no detail lines)");
  for (const l of r.outcome.lines) out.push(`- ${l}`);
  const statuses = r.requests.filter((q) => !q.memo).map((q) => q.status ?? "ERR");
  if (statuses.length > 0) out.push(`- HTTP statuses: ${statuses.join(", ")}`);
  const reused = r.requests.filter((q) => q.memo).length;
  if (reused > 0) out.push(`- Reused ${reused} response(s) already fetched earlier in this run (no new calls)`);
  return out;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
