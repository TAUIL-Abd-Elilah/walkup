/**
 * Checks the bundled sample sheets for names and phones that read as generated: no first word twice among a
 * sheet's partners and spots, and no phone twice among its partners. Runs the four presets and the "All ages,
 * no bars" revision of G1-A on the fixture world.
 *
 *   npx tsx packages/orchestrator/scripts/check-sample-names.ts [--try-salts 40]
 *
 * With --try-salts N it also tries the first N alternative salts on the same places (a name or phone never changes
 * which places a Qloo search returns) and prints a few that pass, so NAME_SALT and PHONE_SALT in places-gen.ts can be
 * chosen. A revision's spots can depend on names (all ages drops drink-led spots), so re-run without the flag after
 * changing a salt.
 * No network is used.
 */
import type { StreetSheet } from "@walkup/contracts";
import { parseGeneratedPlaceId, placeName, placePhone, type MetroKey } from "@walkup/qloo-world";
import { createFixtureDeps, parentRequest, planShow, PRESET_IDS, PRESETS, revisePlan, type PlanResult } from "../src/index";

const METRO: Record<string, MetroKey> = { "g1-a": "nashville", "g1-b": "nashville", "g1-a-rev": "nashville", g2: "hampton_roads", g3: "tacoma" };

async function preset(id: string): Promise<StreetSheet> {
  const deps = createFixtureDeps({ clock: () => Date.parse("2026-10-30T15:00:00Z"), idGen: () => id });
  let r: PlanResult = await planShow({ presetId: id, planId: id }, deps);
  if (r.status === "needs_input" && r.pause) {
    const resolutions: Record<string, string> = {};
    for (const p of r.pause.pending) {
      const pick = p.candidates.find((c) => c.subtype === "urn:entity:person") ?? p.candidates[0];
      if (pick) resolutions[p.input] = pick.entityId;
    }
    r = await planShow({ presetId: id, planId: id, resolutions }, deps);
  }
  if (!r.sheet) throw new Error(`${id}: ${r.status}`);
  return r.sheet;
}

async function revision(parent: StreetSheet): Promise<StreetSheet> {
  const deps = createFixtureDeps({ clock: () => Date.parse("2026-10-30T15:00:00Z"), idGen: () => "g1-a-rev" });
  const request = parentRequest(parent, { presetId: "g1-a" });
  if (!request) throw new Error("no parent request");
  const r = await revisePlan({ sheet: parent, request }, "All ages, no bars", deps);
  if (r.status === "question" || !r.result.sheet) throw new Error("revision did not complete");
  return r.result.sheet;
}

interface Row {
  id: string;
  category: string;
  partner: boolean;
}

function rowsOf(s: StreetSheet): Row[] {
  return [
    ...s.cards.partners.results.map((p) => ({ id: p.entity.entityId, category: p.category, partner: true })),
    ...s.cards.prePost.results.map((p) => ({ id: p.entity.entityId, category: p.category ?? "other", partner: false })),
  ];
}

function firstWord(name: string): string {
  return name.replace(/^The /, "").split(/[\s']/)[0]!.toLowerCase();
}

/** First-word repeats on one sheet under one name salt (catalog places keep their hand-written names and are skipped). */
function nameProblems(sheetId: string, rows: Row[], salt: string | undefined): string[] {
  const out: string[] = [];
  const words = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const g = parseGeneratedPlaceId(r.id);
    if (!g) continue;
    const name = placeName(g.gh5, g.index, r.category, salt);
    const w = firstWord(name);
    if (words.has(w)) out.push(`${sheetId}: "${name}" and "${words.get(w)}" share a first word`);
    else words.set(w, name);
  }
  return out;
}

/** Repeated phones among one sheet's partners under one phone salt. */
function phoneProblems(sheetId: string, rows: Row[], salt: string | undefined): string[] {
  const out: string[] = [];
  const phones = new Map<string, string>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.partner || seen.has(r.id)) continue;
    seen.add(r.id);
    const g = parseGeneratedPlaceId(r.id);
    if (!g) continue;
    const ph = placePhone(g.gh5, g.index, METRO[sheetId] ?? "nashville", salt);
    if (phones.has(ph)) out.push(`${sheetId}: ${r.id} and ${phones.get(ph)} share ${ph}`);
    else phones.set(ph, r.id);
  }
  return out;
}

/** The first salts (prefix-1, prefix-2, ...) with no problem on any sheet. */
function search(prefix: string, n: number, rows: Record<string, Row[]>, check: typeof nameProblems): string[] {
  const ok: string[] = [];
  for (let k = 1; k <= n && ok.length < 5; k++) {
    const salt = `${prefix}-${k}`;
    if (Object.entries(rows).every(([id, r]) => check(id, r, salt).length === 0)) ok.push(salt);
  }
  return ok;
}

async function main(): Promise<void> {
  const sheets: Record<string, StreetSheet> = {};
  // A live-only preset plans another preset's sample bills (fixtureSameAs): nothing of its own to check.
  for (const id of PRESET_IDS) if (!PRESETS[id].fixtureSameAs) sheets[id] = await preset(id);
  sheets["g1-a-rev"] = await revision(sheets["g1-a"]!);
  const rows = Object.fromEntries(Object.entries(sheets).map(([id, s]) => [id, rowsOf(s)]));
  const now = Object.entries(rows).flatMap(([id, r]) => [...nameProblems(id, r, undefined), ...phoneProblems(id, r, undefined)]);
  console.log(now.length === 0 ? "ok: no repeated first word or phone on the sample sheets" : now.join("\n"));
  const i = process.argv.indexOf("--try-salts");
  const n = i >= 0 ? Number(process.argv[i + 1] ?? 40) : 0;
  if (n > 0) {
    console.log(`name salts that pass: ${search("names", n, rows, nameProblems).join(", ") || "none"}`);
    console.log(`phone salts that pass: ${search("phones", n, rows, phoneProblems).join(", ") || "none"}`);
  }
  if (now.length > 0) process.exitCode = 1;
}

void main();
