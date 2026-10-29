/**
 * Ready-made changes for the recorded hero sheets: live revisions made ahead of time, so the hosted copy (recorded
 * mode, no keys) can answer "Change something" by reading the note and opening the version made for that change.
 *
 *   npx tsx scripts/precompute-revisions.ts seed   --dir .cache/record-2026-10-28-revisions \
 *        --from .cache/record-2026-10-21j --from .cache/record-2026-10-21-chicago
 *   npx tsx scripts/precompute-revisions.ts plan   --dir <dir>                 # the notes and their readings, no call
 *   npx tsx scripts/precompute-revisions.ts record --dir <dir> [--max-qloo 1500] [--max-model 40] [--only <planId|preset>] [--note <text>]
 *        [--reader rules] [--offline]
 *   npx tsx scripts/precompute-revisions.ts merge  --dir <dir>                 # appends the new revisions to plans.json
 *
 * seed    A fresh data dir: the recorded plans (deploy/vercel/plans.json, byte for byte) in its plans.sqlite, and the
 *         Qloo cache of the records that made them, so every request a revision shares with its parent is answered
 *         from the parent's own recorded answers (their 7-day cache dates are extended in this copy only).
 * plan    Lists each hero sheet's notes with what the fixed rules read in them. No network.
 * record  Live (WALKUP_MODE=live, WALKUP_RECORD=1, keys from .env): for each note, the model reads it with the strict
 *         revise tools; a note the fixed rules would read differently is skipped (the hosted copy reads with the
 *         rules). Then the parent's own request re-runs with the overrides on the real clock (the sheet says the day
 *         it was made), stored in <dir>/plans.sqlite. Stops before the Qloo or model budget is passed.
 * merge   Backs up deploy/vercel/plans.json to .cache/backup/, appends the new revisions of the hero sheets, and
 *         proves every plan already in the file is byte-identical afterwards (sha256 of each plan's JSON).
 *
 * Keys are read from .env and never printed. Raw Qloo bodies stay in <dir>/fixtures/raw (git-ignored).
 */
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { createMemoryLedger, type LedgerEntry, type LedgerSink, type OperatorInputs, type StreetSheet } from "@walkup/contracts";
import { readRevisionByRules } from "@walkup/narrator";
import {
  createDepsFromEnv,
  numberedTiles,
  overridesFor,
  radiusNoOp,
  parentRequest,
  planShow,
  readInstruction,
  revisedRequest,
  reviseStep,
  reviseSummary,
  type PlanDeps,
  type PlanRequest,
  type StoredPlan,
} from "@walkup/orchestrator";
import { createSqliteStores } from "@walkup/orchestrator/sqlite";
import { createQlooClient } from "@walkup/qloo";
import { createMemoryCounterStore, createTmClient } from "@walkup/tm";
import { findReadyMade, normaliseOverrides, overridesKey } from "../apps/web/lib/revise-match";

const ROOT = resolve(import.meta.dirname, "..");
const DAY_MS = 24 * 60 * 60 * 1000;

/** The recorded hero sheets that get ready-made changes, by preset. */
export const HERO_PRESETS = ["g1-a", "g1-b", "g4-a", "g4-b"] as const;

/**
 * The notes for one sheet: plain notes the fixed rules and the model both read the same way. "Skip <area>" names the
 * sheet's first named area.
 */
export function notesFor(sheet: StreetSheet): string[] {
  const first = reviseSummary(sheet).areas.find((a) => a.name)?.name;
  return ["All ages, no bars", "Street team only on Saturday", "Within 10 km of the room", ...(first ? [`Skip ${first}`] : []), "No restaurants"];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function readPlans(file: string): StoredPlan[] {
  const plans = JSON.parse(readFileSync(file, "utf8")) as StoredPlan[];
  if (!Array.isArray(plans)) throw new Error(`${file}: expected an array of stored plans`);
  return plans;
}

function heroParents(plans: readonly StoredPlan[]): StoredPlan[] {
  return plans.filter((p) => p.sheet && p.mode === "live" && p.status === "complete" && p.presetId && (HERO_PRESETS as readonly string[]).includes(p.presetId));
}

// ---------------------------------------------------------------------------
// seed
// ---------------------------------------------------------------------------

function seed(dir: string, from: string[], plansFile: string): void {
  if (existsSync(join(dir, "plans.sqlite")) || existsSync(join(dir, "qloo-cache.sqlite"))) throw new Error(`${dir} already has a plan store or cache; seed a fresh directory.`);
  mkdirSync(join(dir, "fixtures", "raw"), { recursive: true });
  const plans = readPlans(plansFile);
  const st = createSqliteStores(join(dir, "plans.sqlite"));
  for (const p of plans) st.plans.put(p);
  st.close();
  console.log(`plans.sqlite: ${plans.length} plans from ${plansFile}`);

  const out = new Database(join(dir, "qloo-cache.sqlite"));
  out.pragma("journal_mode = WAL");
  out.exec(`CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, cls TEXT NOT NULL, body TEXT NOT NULL, status INTEGER NOT NULL, stored_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  // A week from now for the 7-day classes, so the parents' answers serve every request a revision shares with them.
  const until = Date.now() + 7 * DAY_MS;
  const put = out.prepare("INSERT OR IGNORE INTO responses (key, cls, body, status, stored_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  let quota: { value: string; at: number } | null = null;
  for (const src of from) {
    const db = new Database(join(src, "qloo-cache.sqlite"), { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT key, cls, body, status, stored_at, expires_at FROM responses").all() as {
      key: string;
      cls: string;
      body: string;
      status: number;
      stored_at: number;
      expires_at: number;
    }[];
    for (const r of rows) put.run(r.key, r.cls, r.body, r.status, r.stored_at, Math.max(r.expires_at, until));
    const meta = db.prepare("SELECT value FROM meta WHERE name = 'qloo.quota'").get() as { value: string } | undefined;
    if (meta) {
      const at = Number((JSON.parse(meta.value) as { updatedAt?: number }).updatedAt ?? 0);
      if (!quota || at > quota.at) quota = { value: meta.value, at };
    }
    db.close();
    console.log(`qloo-cache.sqlite: ${rows.length} responses from ${src}`);
  }
  if (quota) out.prepare("INSERT OR REPLACE INTO meta (name, value) VALUES ('qloo.quota', ?)").run(quota.value);
  console.log(`qloo-cache.sqlite: ${(out.prepare("SELECT count(*) AS n FROM responses").get() as { n: number }).n} responses in ${dir}`);
  out.close();
}

// ---------------------------------------------------------------------------
// plan / record
// ---------------------------------------------------------------------------

interface Planned {
  parent: StoredPlan;
  note: string;
  rulesKey: string | null;
  rulesQuestion: string | null;
}

function planned(plans: readonly StoredPlan[], only?: string, onlyNote?: string): Planned[] {
  const out: Planned[] = [];
  for (const parent of heroParents(plans)) {
    if (only && !parent.planId.startsWith(only) && parent.presetId !== only) continue;
    const sheet = parent.sheet as StreetSheet;
    for (const note of notesFor(sheet)) {
      if (onlyNote && !note.toLowerCase().includes(onlyNote.toLowerCase())) continue;
      const rules = readRevisionByRules(reviseSummary(sheet), note);
      out.push({
        parent,
        note,
        rulesKey: rules.question ? null : overridesKey(normaliseOverrides(overridesFor(rules.calls, sheet.operator), sheet.operator)),
        rulesQuestion: rules.question,
      });
    }
  }
  return out;
}

/** The ready-made revision of `parent` the stored plans already hold for these overrides, if any. */
function existing(parent: StreetSheet, overrides: Partial<OperatorInputs>, stored: readonly StoredPlan[]): StoredPlan | null {
  return findReadyMade(parent, overrides, stored.filter((p) => p.mode === "live" && p.status === "complete"));
}

function liveEnv(dir: string): void {
  const envFile = join(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.env.WALKUP_MODE = "live";
  process.env.WALKUP_RECORD = "1";
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_FIXTURES_DIR = join(dir, "fixtures");
  for (const k of ["QLOO_API_KEY", "TICKETMASTER_API_KEY"]) if (!(process.env[k] ?? "").trim()) throw new Error(`${k} is not set (.env)`);
}

/** The reading's model calls copied into the run's ledger first, as the revise loop does. */
function seedLedger(entries: readonly LedgerEntry[]): { sink: LedgerSink; refs: string[] } {
  const sink = createMemoryLedger();
  const refs: string[] = [];
  for (const e of entries) {
    const { id: _old, ...rest } = e;
    refs.push(sink.add({ ...rest, note: `node revise; ${rest.note ?? ""}`.replace(/; $/, "") }));
  }
  return { sink, refs };
}

// ---------------------------------------------------------------------------
// The room's roster, as the parent saw it
// ---------------------------------------------------------------------------

/** One headliner on a room's roster, in the order the parent's house set went through them. */
interface RosterHead {
  name: string;
  spotifyId?: string;
  attractionId?: string;
  comedian?: boolean;
}

/**
 * Ticketmaster no longer lists the shows that played since the parents were recorded, so today's roster gives a
 * different usual crowd (and different areas) than the parent's. A revision must change only what its note asks
 * for, so the roster call is answered with the headliners the parent's house set was built from, rebuilt from the
 * parent's own receipts: the Spotify ids of its Q3 /entities call and the names of its Q3 searches, in an order that
 * gives the same Q3, Q1 and Q5 requests (checked on every run: no new request may appear at those nodes). The
 * parent's roster receipt (T2) stands in the revision's ledger, marked as reused. `shows` is the parent's roster size.
 */
const ROOM_ROSTERS: Record<string, { shows: number; heads: RosterHead[] }> = {
  // The Anthem, Washington DC (g1-a, g1-b): 41 shows from 2026-10-20.
  KovZ917A3Y7: {
    shows: 41,
    heads: [
      { name: "Jerry Seinfeld", comedian: true },
      { name: "UNDERTALE Symphony" },
      { name: "Geese" },
      { name: "Rodrigo y Gabriela", spotifyId: "7vX3cMVyW8gtDA4y855ynF" },
      { name: "Jesse Welles", spotifyId: "366xgdzfRGQoiDRGidGlDJ" },
      { name: "Hudson Westbrook" },
      { name: "Beck", spotifyId: "3vbKDsSS70ZX9D2OcvbZmS" },
      { name: "Yebba" },
      { name: "Trey Anastasio", spotifyId: "3Felk6Y6jjU00yE1XTOqKZ" },
      { name: "Gregory Porter", spotifyId: "06nevPmNVfWUXyZkccahL8" },
      { name: "Roster act", spotifyId: "4VjljDo2biBRVJ1WEXZ8GE" },
    ],
  },
  // The Salt Shed, Chicago (g4-a, g4-b): 44 shows from 2026-10-21.
  KovZ917AI5F: {
    shows: 44,
    heads: [
      { name: "Daily Bread" },
      { name: "Geese" },
      { name: "Greensky Bluegrass", spotifyId: "33bzrYoIWLx5uox3y0VtHn", attractionId: "K8vZ917GiAV" },
      { name: "Angine de Poitrine" },
      { name: "The Black Keys" },
      { name: "Sylvan Esso", spotifyId: "39vA9YljbnOApXKniLWBZv" },
      { name: "Sammy Rae & The Friends" },
      { name: "Fruit Bats" },
      { name: "Sleeping with Sirens", spotifyId: "3N8Hy6xQnQv1F1XCiyGQqA" },
      { name: "Roster act", spotifyId: "4H4M0Y4cN39zIVDHvdW53x" },
      { name: "The Dresden Dolls", spotifyId: "5JqX1glXPg6428ubI1w72i" },
      { name: "Orville Peck", spotifyId: "46auOkH1pk28rWrSoUNhLo" },
      { name: "Charles Wesley Godwin", spotifyId: "2ErsJAz6qJ5cqjoVAvfvaC" },
      { name: "The Menzingers", spotifyId: "7HWFXU9pHBj0u58yoRwwOJ" },
      { name: "Slow Pulp", spotifyId: "2JFTRDi5v7JtqoouVe1z5D" },
      { name: "Fetty Wap", spotifyId: "6PXS4YHDkKvl1wkIl4V8DL" },
      { name: "Death Cab for Cutie", spotifyId: "0YrtvWJMgSdVrk3SfNjTbx" },
      { name: "Sabaton", spotifyId: "3o2dn2O0FCVsWDFSh8qxgG" },
    ],
  },
};

function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** A Discovery events.json body: the room's heads in order (one night each), padded to the parent's show count. */
function rosterBody(venueId: string, from: string): unknown {
  const room = ROOM_ROSTERS[venueId];
  if (!room) throw new Error(`No recorded roster for venue ${venueId}.`);
  const night = (i: number) => ({ localDate: addDays(from, i + 1) });
  const events: unknown[] = room.heads.map((h, i) => ({
    id: `walkup-roster-${venueId}-${i + 1}`,
    name: h.name,
    dates: { start: night(i), status: { code: "onsale" } },
    classifications: [{ segment: { name: h.comedian ? "Arts & Theatre" : "Music" }, genre: { name: h.comedian ? "Comedy" : "Rock" } }],
    _embedded: {
      attractions: [
        {
          name: h.name,
          ...(h.attractionId ? { id: h.attractionId } : {}),
          ...(h.spotifyId ? { externalLinks: { spotify: [{ url: `https://open.spotify.com/artist/${h.spotifyId}` }] } } : {}),
        },
      ],
    },
  }));
  // The parent's other shows add no headliner its house set reached: listed without an attraction.
  for (let i = room.heads.length; i < room.shows; i++) {
    events.push({ id: `walkup-roster-${venueId}-${i + 1}`, name: "Show", dates: { start: night(i), status: { code: "onsale" } } });
  }
  return { _embedded: { events }, page: { size: 60, totalElements: events.length, totalPages: 1, number: 0 } };
}

/**
 * The note on the parent's roster receipt when a revision reuses it. The run's ledger names the node itself ("node Q3
 * house roster (Ticketmaster)"), so the parent's node name is left off here: only its own detail and the reuse are
 * added. Exported for the test.
 */
export function reusedRosterNote(parentEntry: Pick<LedgerEntry, "note" | "startedAt">): string {
  const detail = (parentEntry.note ?? "").replace(/^node [^;]*(?:; )?/, "");
  return `${detail ? `${detail}; ` : ""}the parent sheet's answer (${parentEntry.startedAt.slice(0, 10)}), reused so the room's usual crowd stays the same`;
}

/** Ticketmaster for a revision: the event itself live, the room's roster answered as the parent saw it. */
function replayTm(parent: StreetSheet, apiKey: string): PlanDeps["tm"] {
  const counter = createMemoryCounterStore();
  const t2 = parent.ledger.find((e) => e.kind === "tm" && e.endpoint === "/discovery/v2/events.json");
  return (ledger: LedgerSink) => {
    const sink: LedgerSink = {
      add(entry) {
        if (entry.kind === "tm" && entry.endpoint === "/discovery/v2/events.json" && t2) {
          const { id: _id, ...kept } = t2;
          return ledger.add({ ...kept, cacheHit: true, note: reusedRosterNote(kept) });
        }
        return ledger.add(entry);
      },
      entries: () => ledger.entries(),
    };
    return createTmClient({
      apiKey,
      ledger: sink,
      counterStore: counter,
      fetch: async (url, init) => {
        const u = new URL(url);
        const venueId = u.searchParams.get("venueId");
        if (u.pathname.endsWith("/discovery/v2/events.json") && venueId) {
          const from = (u.searchParams.get("startDateTime") ?? "").slice(0, 10);
          return new Response(JSON.stringify(rosterBody(venueId, from)), { status: 200, headers: { "content-type": "application/json" } });
        }
        return fetch(url, init);
      },
    });
  };
}

/** A Qloo request as one comparable string (endpoint and params, keys sorted). */
function requestKey(e: LedgerEntry): string {
  const params = Object.fromEntries(Object.entries(e.params ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${e.endpoint} ${JSON.stringify(params)}`;
}

/** Qloo requests of the revision that the parent did not make, and the parent's that the revision did not repeat. */
function requestDiff(parent: StreetSheet, child: StreetSheet): { added: LedgerEntry[]; dropped: LedgerEntry[] } {
  const q = (s: StreetSheet) => s.ledger.filter((e) => e.kind === "qloo");
  const before = new Set(q(parent).map(requestKey));
  const after = new Set(q(child).map(requestKey));
  return { added: q(child).filter((e) => !before.has(requestKey(e))), dropped: q(parent).filter((e) => !after.has(requestKey(e))) };
}

/** Nodes no revise note reaches (the bill, the room, its usual crowd, the lift map's inputs): a new request there is drift. */
function noteFreeNode(radiusChanged: boolean): RegExp {
  // The bill, the room and its usual crowd (Q1-Q3) never move; the heat, demographics and comparison calls (Q4-Q8)
  // move only with the search radius.
  return radiusChanged ? /^node (Q1|Q2|Q3)\b/ : /^node (Q1|Q2|Q3|Q4|Q5|Q6|Q7|Q8)\b/;
}

/**
 * Why a revision shows its parent's results again (the same numbered areas, partners and spots), or null when it
 * changes something a reader can see. Exported for the test.
 */
export function sameResults(parent: StreetSheet, child: StreetSheet): string | null {
  const ids = <T>(xs: readonly T[], id: (x: T) => string) => xs.map(id).join(",");
  const areas = (s: StreetSheet) => ids(numberedTiles(s.cards.liftMap.results.tiles), (t) => t.geohash);
  const partners = (s: StreetSheet) => ids(s.cards.partners.results, (p) => p.entity.entityId);
  const spots = (s: StreetSheet) => ids(s.cards.prePost.results, (x) => x.entity.entityId);
  if (areas(parent) !== areas(child) || partners(parent) !== partners(child) || spots(parent) !== spots(child)) return null;
  return radiusNoOp(parent, child)
    ? "the map search widened to the parent's reach, so the areas, partners and spots are the parent's"
    : "the areas, partners and spots are the parent's";
}

function modelCalls(ledger: readonly LedgerEntry[]): number {
  return ledger.filter((e) => e.kind === "anthropic").length;
}

async function record(
  dir: string,
  opts: { maxQloo: number; maxModel: number; only?: string; note?: string; plansFile: string; offline?: boolean; rulesReader?: boolean },
): Promise<void> {
  liveEnv(dir);
  // --offline: no Qloo or model call (a request the cache cannot answer fails, which is the point) and a scratch store.
  const st = createSqliteStores(join(dir, opts.offline ? "plans-offline-check.sqlite" : "plans.sqlite"));
  const live = createDepsFromEnv(process.env, { store: st.plans, choices: st.choices }) as PlanDeps;
  if (live.mode !== "live") throw new Error("Live deps did not load (keys or WALKUP_MODE).");
  const offlineFetch = (async () => {
    throw new Error("offline check: not in the Qloo cache");
  }) as unknown as typeof fetch;
  const deps: PlanDeps = opts.offline ? { ...live, qloo: createQlooClient({ env: process.env, fetch: offlineFetch }), narrator: { client: null } } : live;
  if (!deps.narrator?.client) console.log("note: no model key here; the fixed rules read every note.");
  const tmKey = (process.env.TICKETMASTER_API_KEY ?? "").trim();
  const fromFile = readPlans(opts.plansFile);
  let qloo = 0;
  let model = 0;
  const rows: string[] = [];
  try {
    for (const item of planned(fromFile, opts.only, opts.note)) {
      const parent = item.parent;
      const sheet = parent.sheet as StreetSheet;
      const tag = `${parent.presetId} ${JSON.stringify(item.note)}`;
      if (item.rulesQuestion || !item.rulesKey) {
        rows.push(`${tag}: skipped, the fixed rules ask "${item.rulesQuestion}"`);
        continue;
      }
      const stored = [...fromFile, ...((await st.plans.listComplete({ mode: "live" }, 500)) as StoredPlan[])];
      const rules = readRevisionByRules(reviseSummary(sheet), item.note);
      const have = existing(sheet, overridesFor(rules.calls, sheet.operator), stored);
      if (have) {
        rows.push(`${tag}: already stored as ${have.planId} ("${have.sheet?.revision?.instruction}")`);
        continue;
      }
      if (qloo + 40 > opts.maxQloo || model + 3 > opts.maxModel) {
        rows.push(`${tag}: not run, budget (${qloo} Qloo, ${model} model calls spent)`);
        continue;
      }
      if (deps.qloo.guardTripped()) throw new Error("Qloo's month guard tripped; stopping.");

      // --reader rules: the fixed rules read the note (as the hosted copy does); the sheet is still narrated as usual.
      const reading = await readInstruction(sheet, item.note, opts.rulesReader ? { narrator: { client: null } } : deps);
      model += modelCalls(reading.ledger);
      if (reading.question || reading.calls.length === 0) {
        rows.push(`${tag}: skipped, the ${reading.interpreter} asked "${reading.question ?? "nothing to change"}"`);
        continue;
      }
      const key = overridesKey(normaliseOverrides(reading.overrides, sheet.operator));
      if (key !== item.rulesKey) {
        rows.push(`${tag}: skipped, the ${reading.interpreter} read ${key} but the rules read ${item.rulesKey}`);
        continue;
      }

      const base = parentRequest(sheet, { stored: parent.request as PlanRequest });
      if (!base) {
        rows.push(`${tag}: skipped, the parent's request cannot be rebuilt`);
        continue;
      }
      const planId = randomUUID();
      const { sink, refs } = seedLedger(reading.ledger);
      const step = reviseStep({
        instruction: reading.instruction,
        interpreter: reading.interpreter,
        fallback: reading.fallback,
        calls: reading.calls,
        ledgerRefs: refs,
        ...(opts.rulesReader ? { rulesChosen: true } : {}),
      });
      // The real clock (no as-of shift): the revised sheet says the day it was made.
      const result = await planShow(revisedRequest(base, reading.overrides, planId), { ...deps, tm: replayTm(sheet, tmKey), ledger: () => sink }, {
        serveFromStoreWhenGuarded: false,
        revise: { parent: sheet, instruction: reading.instruction, interpreter: reading.interpreter, toolCalls: reading.toolCalls, step, settingRefs: refs },
      });
      qloo += result.budget.qlooFresh;
      const runModel = result.sheet ? modelCalls(result.sheet.ledger) - modelCalls(reading.ledger) : 0;
      model += Math.max(0, runModel);
      if (result.status !== "complete" || !result.sheet) {
        rows.push(`${tag}: run ${result.status}${result.error ? ` (${result.error})` : ""}; ${result.budget.qlooFresh} fresh Qloo calls`);
        continue;
      }
      // Nothing outside the note's reach may move: no new request at a node no note touches, and the same bill.
      const diff = requestDiff(sheet, result.sheet);
      const free = noteFreeNode(reading.overrides.radiusKm !== undefined);
      const drift = diff.added.filter((e) => free.test(e.note ?? ""));
      const billMoved = JSON.stringify(result.sheet.bill) !== JSON.stringify(sheet.bill);
      const nodes = (es: LedgerEntry[]) => [...new Set(es.map((e) => (e.note ?? "").replace(/^node /, "").replace(/;.*$/, "")))].join(", ");
      const kept = await st.plans.get(planId);
      if (drift.length > 0 || billMoved || opts.offline) {
        // Never exported: export and merge read complete plans only.
        if (kept) await st.plans.put({ ...kept, status: "needs_input" });
        const why = [...drift.map((e) => `new ${nodes([e])} request`), ...(billMoved ? ["the bill changed on Ticketmaster"] : [])];
        rows.push(
          `${tag}: ${opts.offline ? "offline check" : "NOT KEPT"}; ${why.join(", ") || "nothing outside the note's reach changed"}; ` +
            `requests added ${diff.added.length} (${nodes(diff.added)}), dropped ${diff.dropped.length} (${nodes(diff.dropped)}); ${result.budget.qlooCached} cached`,
        );
        console.log(rows.at(-1));
        if (drift.length > 0 || billMoved) throw new Error("A revision drifted from its parent; stopping before more calls.");
        continue;
      }
      // A change a reader can't see is no ready-made change: FLO's "Within 10 km" widened back to the same 60 km map.
      const same = sameResults(sheet, result.sheet);
      if (same) {
        if (kept) await st.plans.put({ ...kept, status: "needs_input" });
        rows.push(`${tag}: NOT KEPT; ${same}`);
        console.log(rows.at(-1));
        continue;
      }
      // As the web app stores a revision: the caller's own inputs, never the preset's slot.
      if (kept) {
        const { presetId: _p, ...rest } = kept;
        await st.plans.put({ ...rest, request: { ...kept.request, customInputs: true } as PlanRequest });
      }
      const changes = result.sheet.revision?.changes ?? [];
      const kinds = new Map<string, number>();
      for (const c of changes) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
      const fresh = Object.entries(result.budget.byNode ?? {}).map(([n, k]) => `${n}:${k}`).join(", ");
      rows.push(
        `${tag}: ${planId} ${result.sheet.createdAt} by ${reading.interpreter}; ${result.budget.qlooFresh} fresh / ${result.budget.qlooCached} cached Qloo; ` +
          `changes ${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}${fresh ? `; fresh by node: ${fresh}` : ""}`,
      );
      console.log(rows.at(-1));
    }
  } finally {
    st.close();
  }
  console.log("\n" + rows.join("\n"));
  console.log(`\nSpent: ${qloo} fresh Qloo calls, ${model} model calls.`);
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

function merge(dir: string, plansFile: string): void {
  const originalText = readFileSync(plansFile, "utf8");
  const original = JSON.parse(originalText) as StoredPlan[];
  const backupDir = join(ROOT, ".cache", "backup");
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `plans.json.${stamp()}.before-ready-made`);
  copyFileSync(plansFile, backup);
  console.log(`backup: ${backup}`);

  const parents = new Set(heroParents(original).map((p) => p.planId));
  const have = new Set(original.map((p) => p.planId));
  const db = new Database(join(dir, "plans.sqlite"), { readonly: true, fileMustExist: true });
  const rows = (db.prepare("SELECT json FROM plans ORDER BY createdAt").all() as { json: string }[]).map((r) => JSON.parse(r.json) as StoredPlan);
  db.close();
  const added = rows.filter((p) => p.mode === "live" && p.status === "complete" && p.sheet?.revision && parents.has(p.sheet.revision.parentPlanId) && !have.has(p.planId));
  const next = [...original, ...added];
  // The old bytes stay as they are (line ending included); the new plans go in before the closing bracket.
  const head = originalText.replace(/\]\s*$/, "");
  const ending = /\](\s*)$/.exec(originalText)?.[1] ?? "\n";
  const text = `${head}${added.map((p) => `,${JSON.stringify(p)}`).join("")}]${ending}`;
  writeFileSync(plansFile, text, "utf8");

  // Proof: each plan already in the file serialises to the same bytes, and the old file is a prefix of the new one.
  const backupPlans = JSON.parse(readFileSync(backup, "utf8")) as StoredPlan[];
  const written = new Map((JSON.parse(readFileSync(plansFile, "utf8")) as StoredPlan[]).map((p) => [p.planId, p]));
  let same = 0;
  for (const p of backupPlans) {
    const before = sha(JSON.stringify(p));
    const after = written.get(p.planId);
    const ok = after !== undefined && sha(JSON.stringify(after)) === before;
    if (ok) same += 1;
    console.log(`${ok ? "same" : "CHANGED"}  ${p.planId}  ${p.presetId ?? (p.sheet?.revision ? "revision" : "-")}  sha256 ${before.slice(0, 16)}`);
  }
  const prefix = text.startsWith(head) && readFileSync(plansFile, "utf8").startsWith(head);
  console.log(`${same} of ${backupPlans.length} plans byte-identical; old file is a prefix of the new one: ${prefix}`);
  for (const p of added) console.log(`added  ${p.planId}  ${p.sheet?.revision?.parentPlanId.slice(0, 8)}  "${p.sheet?.revision?.instruction}"  ${p.createdAt}`);
  console.log(`${added.length} revisions added -> ${plansFile} (${next.length} plans)`);
  if (same !== backupPlans.length || !prefix) {
    copyFileSync(backup, plansFile);
    throw new Error("A plan already in the file changed; restored the backup.");
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const dir = resolve(arg("--dir") ?? join(ROOT, ".cache", `record-${new Date().toISOString().slice(0, 10)}-revisions`));
  const plansFile = resolve(arg("--plans") ?? join(ROOT, "deploy", "vercel", "plans.json"));
  switch (cmd) {
    case "seed":
      return seed(dir, args("--from").map((f) => resolve(f)), plansFile);
    case "plan": {
      for (const p of planned(readPlans(plansFile), arg("--only"))) {
        console.log(`${p.parent.presetId} ${p.parent.planId.slice(0, 8)} ${JSON.stringify(p.note)} -> ${p.rulesQuestion ? `question: ${p.rulesQuestion}` : p.rulesKey}`);
      }
      return;
    }
    case "record":
      return record(dir, {
        maxQloo: Number(arg("--max-qloo") ?? 1500),
        maxModel: Number(arg("--max-model") ?? 40),
        plansFile,
        offline: process.argv.includes("--offline"),
        rulesReader: arg("--reader") === "rules",
        ...(arg("--only") ? { only: arg("--only") as string } : {}),
        ...(arg("--note") ? { note: arg("--note") as string } : {}),
      });
    case "merge":
      return merge(dir, plansFile);
    default:
      console.error("usage: npx tsx scripts/precompute-revisions.ts seed|plan|record|merge --dir <data dir> [--from <record dir>]... [--plans deploy/vercel/plans.json]");
      process.exit(2);
  }
}

if (/precompute-revisions\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
