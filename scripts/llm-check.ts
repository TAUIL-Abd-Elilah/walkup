/**
 * Live check of the narrator's LLM route (`npm run llm:check`): which provider
 * the environment selects, then three small requests through it, each on
 * synthetic inputs (no Qloo call, no real show):
 *
 *   1. tools: readRevision() on "All ages, no bars" must come back from the model
 *      (not the rules) with set_all_ages and the bar exclusion;
 *   2. tool loop: an invalid area, then the model's correction after the
 *      is_error result (a second turn with the first turn echoed);
 *   3. structured output: narrate() must parse the schema-bound JSON (not the template).
 *
 * Prints one line per check plus the ledger (endpoint, status, model, cost), and
 * exits 1 when any check fails. Keys are read from .env and never printed.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryLedger, type LedgerEntry } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES } from "@walkup/engine";
import {
  createMemorySpendStore,
  createNarratorClient,
  llmProvider,
  narrate,
  readRevision,
  SpendGuard,
  type ReviseSummary,
} from "@walkup/narrator";
// The narrator's synthetic test input (same shape the orchestrator sends).
import { makeInput } from "../packages/narrator/test/helpers";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(): void {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  try {
    process.loadEnvFile(p);
  } catch {
    console.error("warning: could not read .env; using the process environment only");
  }
}

function summary(): ReviseSummary {
  const cats = ["bar", "restaurant", "cafe", "record_store", "book_store", ...DEFAULT_BAR_CATEGORIES];
  return {
    show: { acts: ["Test Headliner"], venue: "Sample Hall", city: "Exampleton", date: "2026-12-12", weekday: "saturday", agePolicy: "21+" },
    settings: { allAges: false, streetTeamDays: ["thursday", "saturday"], radiusKm: 40, excludeCategories: [], excludeAreas: [] },
    areas: [
      { name: "North Example", geohash: "dn6m9q", partners: 6 },
      { name: "West Example", geohash: "dn6m9r", partners: 5 },
    ],
    categories: [...new Set(cats)].map((key) => ({ key, partners: key === "bar" ? 4 : 1, spots: key === "bar" ? 2 : 0 })),
    partners: 13,
    spots: 6,
  };
}

function line(ok: boolean, name: string, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  return ok;
}

async function main(): Promise<number> {
  loadDotEnv();
  const provider = llmProvider(process.env);
  const client = createNarratorClient(process.env);
  if (!client || !provider) {
    console.error("No LLM key set (OPENROUTER_API_KEY or ANTHROPIC_API_KEY): narration would use the template.");
    return 2;
  }
  console.log(`provider: ${provider}${client.model ? `, model ${client.model}` : ""}`);
  const ledger = createMemoryLedger();
  const spend = new SpendGuard({ store: createMemorySpendStore(), dailyCapUsd: 1 });
  const opts = { client, ledger, spend };
  const results: boolean[] = [];

  const s = summary();
  const bars = DEFAULT_BAR_CATEGORIES.filter((k) => s.categories.some((c) => c.key === k));
  const r1 = await readRevision(s, "All ages, no bars", opts);
  const allAges = r1.calls.some((c) => c.tool === "set_all_ages" && c.input.allAges === true);
  const excl = r1.calls.find((c) => c.tool === "exclude_partner_categories");
  const barsOut = !!excl && excl.tool === "exclude_partner_categories" && bars.every((b) => excl.input.categories.includes(b));
  results.push(
    line(
      r1.interpreter === "model" && allAges && barsOut,
      "tool calling",
      `interpreter=${r1.interpreter}${r1.fallback ? ` (${r1.fallback}: ${r1.notes.join(" ")})` : ""}; calls=${JSON.stringify(r1.calls)}${r1.question ? `; question=${r1.question}` : ""}`,
    ),
  );

  const r2 = await readRevision(s, "Skip the area called Southside Example, and keep it within 10 miles", opts);
  results.push(
    line(
      r2.interpreter === "model",
      "tool loop",
      `interpreter=${r2.interpreter}; turns=${r2.ledgerRefs.length}; calls=${JSON.stringify(r2.calls)}; question=${r2.question ?? "none"}`,
    ),
  );

  const n = await narrate(makeInput(), opts);
  results.push(
    line(
      !n.templated,
      "structured output",
      n.templated ? `templated (${n.templateReason}; ${n.guard.reasons.join("; ")})` : `parsed; guard dropped ${n.guard.dropped}; summary: ${n.summary.slice(0, 120)}`,
    ),
  );

  console.log("\nledger:");
  for (const e of ledger.entries() as LedgerEntry[]) {
    console.log(`  ${e.id} ${e.endpoint} http=${e.httpStatus ?? "-"} ${e.envelopeStatus} ${e.latencyMs} ms model=${String(e.params["model"])} ${e.note ?? ""}`);
  }
  return results.every(Boolean) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
