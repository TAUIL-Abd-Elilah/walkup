/**
 * Re-applies Walkup's current post-processing to recorded plans, offline: no Qloo, Ticketmaster or model call.
 *
 *   npx tsx scripts/refresh-recorded-plans.ts [--in deploy/vercel/plans.json] [--out <file>] [--dry-run]
 *
 * Reads the exported plans (scripts/export-plans.mjs writes them; git-ignored), runs `refreshSheet` from
 * @walkup/orchestrator on every sheet (a revision after its parent, so its change list is rebuilt against the
 * refreshed parent), and writes the result. Default output: the input file, after a copy of the original is kept
 * next to it as <name>.before-refresh.json (also git-ignored under deploy/vercel/*.json). Prints, per plan, what
 * changed and anything only a live re-record can fix. Never prints place details beyond names.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { StreetSheet } from "@walkup/contracts";
import { refreshSheet, type RefreshReport } from "@walkup/orchestrator";

interface StoredPlanLike {
  planId: string;
  presetId?: string;
  mode?: string;
  status?: string;
  sheet?: StreetSheet;
  [key: string]: unknown;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function summarize(id: string, r: RefreshReport): string[] {
  const out = [`${id}`];
  for (const a of r.renamedAreas) out.push(`  area ${a.geohash}: ${a.from} -> ${a.to}`);
  for (const p of r.droppedPartners) out.push(`  partner dropped: ${p.name} (${p.why})`);
  for (const s of r.droppedSpots) out.push(`  spot dropped: ${s.name} (${s.why})`);
  for (const w of r.droppedWebsites) out.push(`  website dropped: ${w.name}`);
  for (const p of r.droppedPodcasts) out.push(`  podcast dropped: ${p}`);
  for (const p of r.backCatalogue) out.push(`  podcast marked back catalogue: ${p}`);
  if (r.renamedSponsor) out.push(`  sponsor: ${r.renamedSponsor.from} -> ${r.renamedSponsor.to}`);
  if (r.discovery.before !== r.discovery.after) out.push(`  discovery: ${r.discovery.before ?? "(none)"}\n          -> ${r.discovery.after ?? "(none)"}`);
  if (r.numberedAreas) out.push(`  numbered areas: ${r.numberedAreas.before.join(", ")} -> ${r.numberedAreas.after.join(", ")} (budget split follows; no area "why" line for a new one)`);
  for (const n of r.needsLiveRun) out.push(`  needs a live run: ${n}`);
  return out;
}

function main(): void {
  const input = resolve(arg("--in") ?? "deploy/vercel/plans.json");
  if (!existsSync(input)) {
    console.error(`No recorded plans at ${input} (scripts/export-plans.mjs writes them).`);
    process.exit(2);
  }
  const output = resolve(arg("--out") ?? input);
  const dry = process.argv.includes("--dry-run");
  const plans = JSON.parse(readFileSync(input, "utf8")) as StoredPlanLike[];
  if (!Array.isArray(plans)) throw new Error(`${input}: expected an array of stored plans`);

  const refreshed = new Map<string, StreetSheet>();
  const byId = new Map(plans.map((p) => [p.planId, p]));
  const done = new Set<string>();
  const lines: string[] = [];
  let needsLive = 0;
  const run = (p: StoredPlanLike): void => {
    if (done.has(p.planId) || !p.sheet) return;
    const parentId = p.sheet.revision?.parentPlanId;
    if (parentId && byId.has(parentId) && !done.has(parentId)) run(byId.get(parentId) as StoredPlanLike);
    const parent = parentId ? (refreshed.get(parentId) ?? null) : null;
    const { sheet, report } = refreshSheet(p.sheet, { parent });
    refreshed.set(p.planId, sheet);
    p.sheet = sheet;
    done.add(p.planId);
    needsLive += report.needsLiveRun.length > 0 ? 1 : 0;
    lines.push(...summarize(`${p.planId} ${p.presetId ?? (p.sheet.revision ? "revision" : "-")}`, report));
  };
  for (const p of plans) run(p);
  console.log(lines.join("\n"));
  console.log(`${done.size} sheets refreshed; ${needsLive} would differ further after a live re-record.`);
  if (dry) return;
  if (output === input) {
    const backup = join(dirname(input), `${basename(input, ".json")}.before-refresh.json`);
    if (!existsSync(backup)) copyFileSync(input, backup);
    console.log(`original kept at ${backup}`);
  }
  writeFileSync(output, `${JSON.stringify(plans)}\n`, "utf8");
  console.log(`-> ${output}`);
}

main();
