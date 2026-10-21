#!/usr/bin/env node
/**
 * Exports the stored plans of a plan store (plans.sqlite) to one JSON file that the web app loads with
 * WALKUP_PLAN_SEED (recorded mode on a host with no lasting disk, e.g. Vercel; see docs/deploy-vercel.md).
 *
 *   node scripts/export-plans.mjs <plans.sqlite> [out.json]      # default out: deploy/vercel/plans.json
 *
 * Only complete live plans are exported: the recorded sheets and their revisions. The output holds the sheets
 * Walkup derived from Qloo answers (what the site shows), never raw Qloo response bodies. It is git-ignored and
 * must stay out of git; it ships with a deployment only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

const [src, outArg] = process.argv.slice(2);
if (!src) {
  console.error("usage: node scripts/export-plans.mjs <plans.sqlite> [out.json]");
  process.exit(2);
}
const out = resolve(outArg ?? "deploy/vercel/plans.json");
const db = new Database(resolve(src), { readonly: true, fileMustExist: true });
const rows = db.prepare("SELECT json FROM plans ORDER BY createdAt").all();
db.close();
const plans = rows.map((r) => JSON.parse(r.json)).filter((p) => p.mode === "live" && p.status === "complete" && p.sheet);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(plans)}\n`, "utf8");
for (const p of plans) console.log(`${p.planId}  ${p.createdAt}  ${p.presetId ?? "-"}${p.sheet?.revision ? "  revision" : ""}`);
console.log(`${plans.length} plans -> ${out}`);
