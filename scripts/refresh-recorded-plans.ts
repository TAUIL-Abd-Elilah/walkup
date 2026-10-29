/**
 * Re-applies Walkup's current post-processing to recorded plans, offline: no Qloo, Ticketmaster or model call.
 *
 *   npx tsx scripts/refresh-recorded-plans.ts [--in deploy/vercel/plans.json] [--out <file>] [--dry-run] [--recheck]
 *        [--drop <planId>]...
 *
 * Reads the exported plans (scripts/export-plans.mjs writes them; git-ignored), runs `refreshSheet` from
 * @walkup/orchestrator on every sheet (a revision after its parent, so its change list is rebuilt against the
 * refreshed parent), and writes the result. Default output: the input file, after a copy of the original is kept
 * next to it as <name>.before-refresh.json (also git-ignored under deploy/vercel/*.json). Prints, per plan, what
 * changed and anything only a live re-record can fix. Never prints place details beyond names.
 *
 * --recheck runs `recheckSheet` instead: only the checks that change nothing the run found (tile states, "near" the
 * area, the narration guard, the Checks step, the change lists), no rename, re-scoring or re-categorising.
 * --drop removes a plan first (a ready-made change that changed nothing); a revision of it can't stay.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { StreetSheet } from "@walkup/contracts";
import { recheckSheet, refreshSheet, type RecheckReport, type RefreshReport } from "@walkup/orchestrator";

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

function args(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === name && process.argv[i + 1] ? [process.argv[i + 1] as string] : []));
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

function summarizeRecheck(id: string, r: RecheckReport): string[] {
  const out = [`${id}`];
  for (const s of r.states) out.push(`  area ${s.geohash} ${s.name}: state ${s.state} by its point (first ZIP says ${s.firstZip ?? "none"})`);
  for (const p of r.droppedPartners) out.push(`  partner dropped: ${p.name} (${p.why})`);
  for (const s of r.droppedSpots) out.push(`  spot dropped: ${s.name} (${s.why})`);
  for (const x of r.replaced) out.push(`  replaced by the template: ${x}`);
  if (r.nearArea > 0) out.push(`  ${r.nearArea} partner line(s) now say "near" the area`);
  for (const w of r.rewritten) out.push(`  rewritten: ${w}`);
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
  const recheck = process.argv.includes("--recheck");
  const loaded = JSON.parse(readFileSync(input, "utf8")) as StoredPlanLike[];
  if (!Array.isArray(loaded)) throw new Error(`${input}: expected an array of stored plans`);
  const drop = new Set(args("--drop"));
  for (const id of drop) if (!loaded.some((p) => p.planId === id)) throw new Error(`--drop ${id}: no such plan`);
  const orphans = loaded.filter((p) => !drop.has(p.planId) && p.sheet?.revision && drop.has(p.sheet.revision.parentPlanId));
  if (orphans.length > 0) throw new Error(`--drop would leave revisions without their parent: ${orphans.map((p) => p.planId).join(", ")}`);
  const plans = loaded.filter((p) => !drop.has(p.planId));

  const refreshed = new Map<string, StreetSheet>();
  const byId = new Map(plans.map((p) => [p.planId, p]));
  const done = new Set<string>();
  const lines: string[] = [...[...drop].map((id) => `${id} removed`)];
  let needsLive = 0;
  const run = (p: StoredPlanLike): void => {
    if (done.has(p.planId) || !p.sheet) return;
    const parentId = p.sheet.revision?.parentPlanId;
    if (parentId && byId.has(parentId) && !done.has(parentId)) run(byId.get(parentId) as StoredPlanLike);
    const parent = parentId ? (refreshed.get(parentId) ?? null) : null;
    const label = `${p.planId} ${p.presetId ?? (p.sheet.revision ? "revision" : "-")}`;
    if (recheck) {
      const { sheet, report } = recheckSheet(p.sheet, { parent });
      refreshed.set(p.planId, sheet);
      p.sheet = sheet;
      lines.push(...summarizeRecheck(label, report));
    } else {
      const { sheet, report } = refreshSheet(p.sheet, { parent });
      refreshed.set(p.planId, sheet);
      p.sheet = sheet;
      needsLive += report.needsLiveRun.length > 0 ? 1 : 0;
      lines.push(...summarize(label, report));
    }
    done.add(p.planId);
  };
  for (const p of plans) run(p);
  console.log(lines.join("\n"));
  console.log(recheck ? `${done.size} sheets rechecked.` : `${done.size} sheets refreshed; ${needsLive} would differ further after a live re-record.`);
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
