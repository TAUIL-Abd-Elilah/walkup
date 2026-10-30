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
 * area, the narration guard, the fan copy checks, the Checks step, the change lists, the "about N times" the code
 * itself wrote), no rename, re-scoring or re-categorising. A place whose kind was read again after its run gets
 * back the kind the show's other recorded runs gave it (`recordedKinds`) when its area lists more than 2 of a kind.
 * --drop removes a plan first (a ready-made change that changed nothing); a revision of it can't stay.
 * Nothing is written when a sheet still lists more than 2 of a kind in an area.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { StreetSheet } from "@walkup/contracts";
import { kindsOverCap, recheckSheet, refreshSheet, type RecheckReport, type RefreshReport } from "@walkup/orchestrator";

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
  if (r.nearArea > 0) out.push(`  ${r.nearArea} partner ${r.nearArea === 1 ? "line now says" : "lines now say"} "near" the area`);
  for (const k of r.kinds) out.push(`  kind: ${k.name} ${k.from} -> ${k.to} (as another run of this show recorded it)`);
  for (const w of r.websites) out.push(`  website ${w}`);
  for (const w of r.rewritten) out.push(`  rewritten: ${w}`);
  return out;
}

/**
 * The kinds each place carries across one show's recorded sheets (a parent and its changes), by entity id: what the
 * recheck gives back to a place whose kind was read again after its run.
 */
export function kindsByShow(plans: readonly StoredPlanLike[]): (planId: string) => (entityId: string) => readonly string[] {
  const byId = new Map(plans.map((p) => [p.planId, p]));
  const rootOf = (p: StoredPlanLike): string => {
    const seen = new Set<string>();
    let at = p;
    while (at.sheet?.revision?.parentPlanId && byId.has(at.sheet.revision.parentPlanId) && !seen.has(at.planId)) {
      seen.add(at.planId);
      at = byId.get(at.sheet.revision.parentPlanId) as StoredPlanLike;
    }
    return at.planId;
  };
  const kinds = new Map<string, Map<string, string[]>>();
  for (const p of plans) {
    const root = rootOf(p);
    const show = kinds.get(root) ?? new Map<string, string[]>();
    kinds.set(root, show);
    for (const row of p.sheet?.cards.partners.results ?? []) {
      const list = show.get(row.entity.entityId) ?? [];
      if (!list.includes(row.category)) list.push(row.category);
      show.set(row.entity.entityId, list);
    }
  }
  return (planId) => {
    const p = byId.get(planId);
    const show = p ? kinds.get(rootOf(p)) : undefined;
    return (entityId) => show?.get(entityId) ?? [];
  };
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
  // Read before any sheet changes: the kinds the runs themselves recorded.
  const recordedKinds = kindsByShow(plans);
  const run = (p: StoredPlanLike): void => {
    if (done.has(p.planId) || !p.sheet) return;
    const parentId = p.sheet.revision?.parentPlanId;
    if (parentId && byId.has(parentId) && !done.has(parentId)) run(byId.get(parentId) as StoredPlanLike);
    const parent = parentId ? (refreshed.get(parentId) ?? null) : null;
    const label = `${p.planId} ${p.presetId ?? (p.sheet.revision ? "revision" : "-")}`;
    if (recheck) {
      const { sheet, report } = recheckSheet(p.sheet, { parent, recordedKinds: recordedKinds(p.planId) });
      refreshed.set(p.planId, sheet);
      p.sheet = sheet;
      lines.push(...summarizeRecheck(label, report));
    } else {
      const { sheet, report } = refreshSheet(p.sheet, { parent, recordedKinds: recordedKinds(p.planId) });
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
  // The sheet says "at most 2 of a kind per area": a recorded sheet that breaks it is not written.
  const over = plans.flatMap((p) => (p.sheet ? kindsOverCap(p.sheet).map((x) => `${p.planId} ${x}`) : []));
  if (over.length > 0) {
    console.error(`More than 2 of a kind in an area; nothing written:\n${over.map((x) => `  ${x}`).join("\n")}`);
    process.exit(1);
  }
  if (dry) return;
  if (output === input) {
    const backup = join(dirname(input), `${basename(input, ".json")}.before-refresh.json`);
    if (!existsSync(backup)) copyFileSync(input, backup);
    console.log(`original kept at ${backup}`);
  }
  writeFileSync(output, `${JSON.stringify(plans)}\n`, "utf8");
  console.log(`-> ${output}`);
}

// Run only as the script itself, so a test can import `kindsByShow` without touching the recorded plans.
if (/refresh-recorded-plans\.ts$/.test(process.argv[1] ?? "")) main();
