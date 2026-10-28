/**
 * The "Claude alone" baseline (protocol: evals/llm-baseline/protocol.md; pure parts in llm-baseline-lib.ts).
 *
 *   npx tsx scripts/llm-baseline.ts --prepare [--plans deploy/vercel/plans.json]
 *       Freezes what is asked into evals/llm-baseline/out/inputs.json. No network.
 *   npx tsx scripts/llm-baseline.ts --run
 *       Checks the protocol's hash against the README, then asks the model once per area (one retry on a failed
 *       call or a malformed answer) and checks every returned name, and every Walkup pick, with one Qloo /search.
 *       Stops at 40 model calls or 400 Qloo calls. Resumable: answers and Qloo bodies are cached.
 *       --no-temperature leaves `temperature` out (deviation 2 in results.md); --max-model-calls N lowers the cap;
 *       --max-tokens N raises max_tokens for areas not yet answered (deviation 3).
 *   npx tsx scripts/llm-baseline.ts --score
 *       The same scoring from the caches only; any request the caches cannot answer fails.
 *   npx tsx scripts/llm-baseline.ts --explore
 *       Exploratory counts, not in the protocol: areas 1.5 times as wide, and names searched without a trailing note
 *       such as "(unverified)" (one Qloo search per such name). Writes out/exploratory.json.
 *
 * Raw model answers and raw Qloo bodies stay in .cache/llm-baseline/ (git-ignored). evals/llm-baseline/out/ gets
 * only what the protocol publishes: the names and reasons the model gave, per-name check flags and counts.
 * Keys are read from .env and never printed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createMemoryLedger, type LedgerEntry, type QlooEntity, type StreetSheet } from "@walkup/contracts";
import { compileChains, type ChainIndex, type ChainList } from "@walkup/engine";
import { buildSearch, createQlooClient, createSqliteCache, normalizeEntityList, type QlooClient } from "@walkup/qloo";
import CHAIN_FILE from "../config/chains.json";
import {
  addCounts,
  answerSchema,
  BASELINE_PLANS,
  buildPrompt,
  chainFlags,
  chainPool,
  checkName,
  countChecks,
  dayName,
  DOES_NOT_SHOW,
  extractBill,
  MAX_ATTEMPTS_PER_AREA,
  MAX_MODEL_CALLS,
  MAX_QLOO_CALLS,
  MODEL_MAX_TOKENS,
  MODEL_TEMPERATURE,
  parseAnswer,
  pickMatch,
  resultSentences,
  SEARCH_RADIUS_MILES,
  SEARCH_TAKE,
  SHOWS,
  stripNote,
  walkupCounts,
  type AreaAsk,
  type BillAsk,
  type Counts,
  type NameCheck,
  type ParsedAnswer,
  type ReturnedPlace,
  type WalkupCounts,
} from "./llm-baseline-lib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "evals/llm-baseline/out");
const PRIVATE = join(ROOT, ".cache/llm-baseline");
const MODEL_DIR = join(PRIVATE, "model");
const PROTOCOL = join(ROOT, "evals/llm-baseline/protocol.md");
const README = join(ROOT, "evals/llm-baseline/README.md");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Leaves `temperature` out of the request (deviation 2 in results.md). */
function sendTemperature(): boolean {
  return !process.argv.includes("--no-temperature");
}

/** max_tokens for this invocation: the protocol's 2,000, or --max-tokens N (deviation 3 in results.md). */
function maxTokens(): number {
  const v = Number(arg("--max-tokens"));
  return Number.isInteger(v) && v > 0 ? v : MODEL_MAX_TOKENS;
}

/** Model calls this invocation may make: the protocol's 40, or fewer with --max-model-calls (calls already spent). */
function maxModelCalls(): number {
  const v = Number(arg("--max-model-calls"));
  return Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_MODEL_CALLS) : MAX_MODEL_CALLS;
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function loadDotEnv(): void {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  try {
    process.loadEnvFile(p);
  } catch {
    console.error("warning: could not read .env; using the process environment only");
  }
}

interface Inputs {
  protocol: string;
  preparedAt: string;
  plansFile: string;
  plansSha256: string;
  chainsSha256: string;
  bills: BillAsk[];
  prompts: Array<{ bill: string; area: number; system: string; user: string }>;
}

// ---------------------------------------------------------------------------
// --prepare
// ---------------------------------------------------------------------------

function prepare(): void {
  const plansPath = resolve(ROOT, arg("--plans") ?? "deploy/vercel/plans.json");
  const buf = readFileSync(plansPath);
  const plans = JSON.parse(buf.toString("utf8")) as Array<{ planId: string; sheet?: StreetSheet }>;
  const bills = BASELINE_PLANS.map(({ key, planId }) => {
    const sheet = plans.find((p) => p.planId === planId)?.sheet;
    if (!sheet) throw new Error(`plan ${planId} (${key}) is not in ${plansPath}`);
    return extractBill(key, planId, sheet);
  });
  const prompts = bills.flatMap((b) => b.areas.map((a) => ({ bill: b.key, area: a.area, ...buildPrompt(b, a) })));
  const inputs: Inputs = {
    protocol: "evals/llm-baseline/protocol.md",
    preparedAt: new Date().toISOString(),
    plansFile: "deploy/vercel/plans.json",
    plansSha256: sha256(buf),
    chainsSha256: sha256(readFileSync(join(ROOT, "config/chains.json"))),
    bills,
    prompts,
  };
  writeJson(join(OUT, "inputs.json"), inputs);
  for (const b of bills) {
    console.log(`${b.key}: ${b.headliner} at ${b.venue}; check day ${b.checkDay}`);
    for (const a of b.areas) {
      console.log(`  area ${a.area} ${a.label}: ${a.asked} (${a.types.map((t) => `${t.count} ${t.label}`).join(", ")}), ${a.radiusM} m`);
    }
  }
  console.log(`wrote evals/llm-baseline/out/inputs.json (${prompts.length} prompts)`);
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

interface AreaAnswer {
  bill: string;
  area: number;
  model: string | null;
  attempts: number;
  ok: boolean;
  error: string | null;
  parsed: ParsedAnswer | null;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** max_tokens the area was asked with (absent: the protocol's 2,000). */
  maxTokens?: number;
  /** temperature sent with the request (null: left out, deviation 2). */
  temperature?: number | null;
}

interface ChatBody {
  model?: string;
  error?: { message?: string };
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

async function callModel(model: string, apiKey: string, bill: BillAsk, area: AreaAsk): Promise<{ body: ChatBody | null; status: number | null; error: string | null }> {
  const { system, user } = buildPrompt(bill, area);
  const req = {
    model,
    // Deviation 2 (results.md): no OpenRouter endpoint for this model accepts `temperature`, so --no-temperature leaves it out.
    ...(sendTemperature() ? { temperature: MODEL_TEMPERATURE } : {}),
    max_tokens: maxTokens(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name: "places", strict: true, schema: answerSchema(area) } },
    provider: { require_parameters: true },
    usage: { include: true },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-title": "Walkup llm-baseline" },
      body: JSON.stringify(req),
      signal: ac.signal,
    });
    const text = await res.text();
    let body: ChatBody | null = null;
    try {
      body = JSON.parse(text) as ChatBody;
    } catch {
      return { body: null, status: res.status, error: `HTTP ${res.status}: not JSON` };
    }
    if (!res.ok || body.error) return { body, status: res.status, error: `HTTP ${res.status}: ${body.error?.message ?? "error"}` };
    return { body, status: res.status, error: null };
  } catch (err) {
    return { body: null, status: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function answers(inputs: Inputs, offline: boolean, spend: { modelCalls: number; costUsd: number }): Promise<AreaAnswer[]> {
  const model = process.env["OPENROUTER_MODEL"]?.trim() || DEFAULT_MODEL;
  const apiKey = process.env["OPENROUTER_API_KEY"]?.trim() ?? "";
  if (!offline && !apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const out: AreaAnswer[] = [];
  for (const bill of inputs.bills) {
    for (const area of bill.areas) {
      const file = join(MODEL_DIR, `${bill.key}-area${area.area}.json`);
      if (existsSync(file)) {
        out.push(JSON.parse(readFileSync(file, "utf8")) as AreaAnswer);
        continue;
      }
      // Deviation 3: only areas with no stored answer are asked; record the token limit they were asked with.
      if (offline) throw new Error(`no cached answer for ${bill.key} area ${area.area}`);
      const rec: AreaAnswer = { bill: bill.key, area: area.area, model: null, attempts: 0, ok: false, error: null, parsed: null, costUsd: 0, promptTokens: 0, completionTokens: 0, maxTokens: maxTokens(), temperature: sendTemperature() ? MODEL_TEMPERATURE : null };
      for (let k = 1; k <= MAX_ATTEMPTS_PER_AREA; k++) {
        if (spend.modelCalls >= maxModelCalls()) throw new Error(`model call budget (${maxModelCalls()} this run) reached`);
        spend.modelCalls++;
        rec.attempts = k;
        const r = await callModel(model, apiKey, bill, area);
        writeJson(join(MODEL_DIR, `${bill.key}-area${area.area}-try${k}.raw.json`), { status: r.status, error: r.error, body: r.body });
        const cost = r.body?.usage?.cost;
        if (typeof cost === "number" && Number.isFinite(cost)) {
          rec.costUsd += cost;
          spend.costUsd += cost;
        }
        rec.promptTokens += r.body?.usage?.prompt_tokens ?? 0;
        rec.completionTokens += r.body?.usage?.completion_tokens ?? 0;
        rec.model = r.body?.model ?? rec.model;
        if (r.error) {
          rec.error = r.error;
          console.log(`  ${bill.key} area ${area.area} try ${k}: ${r.error}`);
          continue;
        }
        const text = r.body?.choices?.[0]?.message?.content ?? "";
        const parsed = parseAnswer(text ?? "", area.asked);
        if (!parsed) {
          rec.error = `answer is not the JSON shape (finish ${r.body?.choices?.[0]?.finish_reason ?? "?"})`;
          console.log(`  ${bill.key} area ${area.area} try ${k}: ${rec.error}`);
          continue;
        }
        rec.ok = true;
        rec.error = null;
        rec.parsed = parsed;
        break;
      }
      writeJson(file, rec);
      console.log(`model ${bill.key} area ${area.area}: ${rec.ok ? `${rec.parsed?.places.length} of ${area.asked} names` : `no answer (${rec.error})`} after ${rec.attempts} call(s)`);
      out.push(rec);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Qloo checks
// ---------------------------------------------------------------------------

interface Searcher {
  search(name: string, area: AreaAsk): Promise<QlooEntity[]>;
  networkCalls(): number;
  cacheHits(): number;
  close(): void;
}

/** Description text as Walkup's chain rule reads it: /search places carry `description`, not `short_description`. */
function withDescriptions(body: unknown, entities: QlooEntity[]): QlooEntity[] {
  const raw = (body as { results?: unknown })?.results;
  if (!Array.isArray(raw)) return entities;
  const desc = new Map<string, string>();
  for (const r of raw as Array<Record<string, unknown>>) {
    const id = typeof r?.entity_id === "string" ? r.entity_id : null;
    const d = (r?.properties as Record<string, unknown> | undefined)?.description;
    if (id && typeof d === "string" && d.trim()) desc.set(id, d.trim());
  }
  return entities.map((e) => {
    const d = desc.get(e.entityId);
    if (!d || e.properties?.short_description) return e;
    return { ...e, properties: { ...(e.properties ?? {}), description: d } };
  });
}

function makeSearcher(offline: boolean): Searcher {
  mkdirSync(PRIVATE, { recursive: true });
  const cache = createSqliteCache(join(PRIVATE, "qloo-cache.sqlite"));
  const ledger = createMemoryLedger();
  const env = { ...process.env, WALKUP_MODE: "live", WALKUP_RECORD: "", WALKUP_DATA_DIR: PRIVATE };
  const client: QlooClient = createQlooClient({
    env,
    cache,
    ledger,
    ...(offline
      ? {
          fetch: async () => {
            throw new Error("--score is offline: this search is not in the cache");
          },
        }
      : {}),
  });
  const entries = (): LedgerEntry[] => ledger.entries() as LedgerEntry[];
  const network = () => entries().filter((e) => !e.cacheHit && e.httpStatus !== null).length;
  return {
    async search(name, area) {
      if (network() >= MAX_QLOO_CALLS) throw new Error(`Qloo call budget (${MAX_QLOO_CALLS}) reached`);
      const req = buildSearch(name, ["urn:entity:place"], { location: { lat: area.lat, lon: area.lon }, radiusMiles: SEARCH_RADIUS_MILES, take: SEARCH_TAKE });
      const raw = await client.request(req);
      return withDescriptions(raw.body, normalizeEntityList(raw.body).value);
    },
    networkCalls: network,
    cacheHits: () => entries().filter((e) => e.cacheHit).length,
    close: () => cache.close(),
  };
}

interface BillResult {
  key: string;
  planId: string;
  headliner: string;
  venue: string;
  checkDay: string;
  areas: Array<{ area: number; label: string; radiusM: number; asked: number; returned: number; answered: boolean }>;
  claude: Counts;
  walkup: WalkupCounts;
}

/**
 * Section 4 for one bill: one search per kept name, the chain pool over this bill's searches, then the checks.
 * Exploratory variants (never the published count): `radiusFactor` widens every area; `stripNotes` searches a
 * name without a trailing note in brackets such as "(unverified)".
 */
async function checkBillNames(
  bill: BillAsk,
  areaAnswers: readonly AreaAnswer[],
  searcher: Searcher,
  chains: ChainIndex,
  opts: { radiusFactor?: number; stripNotes?: boolean } = {},
): Promise<NameCheck[]> {
  const widen = (a: AreaAsk): AreaAsk => (opts.radiusFactor ? { ...a, radiusM: a.radiusM * opts.radiusFactor } : a);
  const searched: Array<{ area: AreaAsk; place: ReturnedPlace; results: QlooEntity[] }> = [];
  for (const base of bill.areas) {
    const area = widen(base);
    const ans = areaAnswers.find((a) => a.bill === bill.key && a.area === area.area);
    for (const p of ans?.parsed?.places ?? []) {
      const place = opts.stripNotes ? { ...p, name: stripNote(p.name) } : p;
      searched.push({ area, place, results: await searcher.search(place.name, base) });
    }
  }
  const flags = chainFlags(chainPool(searched), chains);
  const walkupIds = new Set(bill.areas.flatMap((a) => a.walkup.map((w) => w.entityId)));
  const seen = new Set<string>();
  return searched.map(({ area, place, results }) =>
    checkName(
      { area, place, match: pickMatch(place.name, results, area), checkDay: bill.checkDay, otherDays: bill.streetTeamDays.filter((d) => d !== bill.checkDay) },
      flags,
      walkupIds,
      seen,
    ),
  );
}

/** Every model request and Qloo call this test has made, from the private caches (refused and truncated runs included). */
function tallyRequests(): { modelRequests: number; refusedAtRouting: number; answeredByModel: number; stoppedAtTokenLimit: number; modelCostUsd: number; qlooCalls: number } {
  const files: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith(".raw.json")) files.push(p);
    }
  };
  walk(MODEL_DIR);
  let refused = 0;
  let length = 0;
  let cost = 0;
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, "utf8")) as { status: number | null; body: ChatBody | null };
    if (j.status === 404 || !j.body?.choices) {
      refused++;
      continue;
    }
    if (j.body.choices[0]?.finish_reason === "length") length++;
    const c = j.body.usage?.cost;
    if (typeof c === "number" && Number.isFinite(c)) cost += c;
  }
  const db = new Database(join(PRIVATE, "qloo-cache.sqlite"), { readonly: true, fileMustExist: true });
  let qloo = 0;
  try {
    qloo = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM responses").get()?.n ?? 0;
  } finally {
    db.close();
  }
  return {
    modelRequests: files.length,
    refusedAtRouting: refused,
    answeredByModel: files.length - refused,
    stoppedAtTokenLimit: length,
    modelCostUsd: Math.round(cost * 10_000) / 10_000,
    qlooCalls: qloo,
  };
}

async function score(offline: boolean): Promise<void> {
  const inputs = JSON.parse(readFileSync(join(OUT, "inputs.json"), "utf8")) as Inputs;
  const chains = compileChains(CHAIN_FILE as ChainList);
  if (sha256(readFileSync(join(ROOT, "config/chains.json"))) !== inputs.chainsSha256) {
    console.log("note: config/chains.json changed since --prepare; the run uses the current list (log it as a deviation)");
  }
  const spend = { modelCalls: 0, costUsd: 0 };
  const areaAnswers = await answers(inputs, offline, spend);
  const searcher = makeSearcher(offline);
  const allChecks: Array<NameCheck & { bill: string }> = [];
  const calibration: Array<{ bill: string; area: number; name: string; found: boolean; inArea: boolean; sameEntity: boolean; distanceM: number | null }> = [];
  const bills: BillResult[] = [];
  try {
    for (const bill of inputs.bills) {
      const checks = await checkBillNames(bill, areaAnswers, searcher, chains);
      for (const c of checks) allChecks.push({ bill: bill.key, ...c });
      // Calibration: Walkup's own picks through the same name search.
      let calFound = 0;
      let calIn = 0;
      for (const area of bill.areas) {
        for (const w of area.walkup) {
          const results = await searcher.search(w.name, area);
          const m = pickMatch(w.name, results, area);
          const inArea = !!m && m.distanceM !== null && m.distanceM <= area.radiusM;
          if (m) calFound++;
          if (inArea) calIn++;
          calibration.push({ bill: bill.key, area: area.area, name: w.name, found: !!m, inArea, sameEntity: m?.entity.entityId === w.entityId, distanceM: m?.distanceM == null ? null : Math.round(m.distanceM) });
        }
      }
      const asked = bill.areas.reduce((n, a) => n + a.asked, 0);
      bills.push({
        key: bill.key,
        planId: bill.planId,
        headliner: bill.headliner,
        venue: bill.venue,
        checkDay: bill.checkDay,
        areas: bill.areas.map((a) => {
          const ans = areaAnswers.find((x) => x.bill === bill.key && x.area === a.area);
          return { area: a.area, label: a.label, radiusM: a.radiusM, asked: a.asked, returned: ans?.parsed?.places.length ?? 0, answered: !!ans?.ok };
        }),
        claude: countChecks(asked, checks),
        walkup: walkupCounts(bill, { found: calFound, inArea: calIn }),
      });
      console.log(`checked ${bill.key}: ${checks.length} names, ${bill.areas.reduce((n, a) => n + a.walkup.length, 0)} Walkup picks; Qloo network calls so far ${searcher.networkCalls()}`);
    }
  } finally {
    searcher.close();
  }

  const total = bills.map((b) => b.claude).reduce(addCounts);
  const walkupTotal: WalkupCounts = bills.map((b) => b.walkup).reduce((a, b) => ({
    listed: a.listed + b.listed,
    chains: a.chains + b.chains,
    usable: a.usable + b.usable,
    calibrationFound: (a.calibrationFound ?? 0) + (b.calibrationFound ?? 0),
    calibrationInArea: (a.calibrationInArea ?? 0) + (b.calibrationInArea ?? 0),
  }));
  const days = [...new Set(inputs.bills.map((b) => dayName(b.checkDay)))];
  const sentences = resultSentences(total, walkupTotal, days.join(" or "));
  const model = areaAnswers.find((a) => a.model)?.model ?? null;
  const protocolSha = sha256(readFileSync(PROTOCOL));

  writeJson(join(OUT, "answers.json"), {
    protocolSha256: protocolSha,
    modelRequested: process.env["OPENROUTER_MODEL"]?.trim() || DEFAULT_MODEL,
    modelServed: model,
    temperaturesSent: [...new Set(areaAnswers.map((a) => a.temperature ?? null))],
    maxTokensProtocol: MODEL_MAX_TOKENS,
    areas: areaAnswers.map((a) => ({
      bill: a.bill,
      area: a.area,
      ok: a.ok,
      attempts: a.attempts,
      maxTokens: a.maxTokens ?? MODEL_MAX_TOKENS,
      temperature: a.temperature ?? null,
      error: a.error,
      extraNamesDropped: a.parsed?.extra ?? 0,
      repeatsInAnswer: a.parsed?.repeatsInAnswer ?? 0,
      places: a.parsed?.places ?? [],
    })),
  });
  writeJson(join(OUT, "checks.json"), { protocolSha256: protocolSha, checks: allChecks, walkupCalibration: calibration });
  const modelCallsTotal = areaAnswers.reduce((n, a) => n + a.attempts, 0);
  const modelCostTotal = areaAnswers.reduce((n, a) => n + a.costUsd, 0);
  writeJson(join(OUT, "summary.json"), {
    protocolSha256: protocolSha,
    scoredAt: new Date().toISOString(),
    model,
    checkDays: days,
    bills,
    total: { claude: total, walkup: walkupTotal },
    sentences,
    shows: SHOWS,
    doesNotShow: DOES_NOT_SHOW,
    spent: {
      modelCallsForTheseAnswers: modelCallsTotal,
      modelCostForTheseAnswersUsd: Math.round(modelCostTotal * 10_000) / 10_000,
      allRuns: tallyRequests(),
      qlooNetworkCallsThisInvocation: searcher.networkCalls(),
    },
  });
  console.log(`\n${sentences.join(" ")}`);
  console.log(`model calls this invocation ${spend.modelCalls} (all areas ${modelCallsTotal}), cost $${modelCostTotal.toFixed(4)}; Qloo network calls this invocation ${searcher.networkCalls()}, cache hits ${searcher.cacheHits()}`);
}

// ---------------------------------------------------------------------------
// --explore: exploratory counts, not in the protocol (labelled so wherever shown)
// ---------------------------------------------------------------------------

async function explore(): Promise<void> {
  const inputs = JSON.parse(readFileSync(join(OUT, "inputs.json"), "utf8")) as Inputs;
  const chains = compileChains(CHAIN_FILE as ChainList);
  const areaAnswers = await answers(inputs, true, { modelCalls: 0, costUsd: 0 });
  const searcher = makeSearcher(false);
  const sum = (list: Counts[]) => list.reduce(addCounts);
  const out: Record<string, unknown> = { note: "Exploratory, not in the protocol: never the published count." };
  try {
    const noted = areaAnswers.flatMap((a) => a.parsed?.places ?? []).filter((p) => stripNote(p.name) !== p.name).length;
    const asked = (b: BillAsk) => b.areas.reduce((n, a) => n + a.asked, 0);
    const wide: Counts[] = [];
    const stripped: Counts[] = [];
    for (const bill of inputs.bills) {
      wide.push(countChecks(asked(bill), await checkBillNames(bill, areaAnswers, searcher, chains, { radiusFactor: 1.5 })));
      stripped.push(countChecks(asked(bill), await checkBillNames(bill, areaAnswers, searcher, chains, { stripNotes: true })));
    }
    out["namesWithANote"] = noted;
    out["areasOneAndAHalfTimesAsWide"] = sum(wide);
    out["notesRemovedBeforeSearch"] = sum(stripped);
    out["qlooNetworkCalls"] = searcher.networkCalls();
  } finally {
    searcher.close();
  }
  writeJson(join(OUT, "exploratory.json"), out);
  console.log(JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------

function checkSeal(): void {
  const readme = readFileSync(README, "utf8");
  const m = /protocol\.md[^\n]*?`([0-9a-f]{64})`/.exec(readme);
  if (!m) throw new Error("README.md does not record the protocol's sha256");
  const actual = sha256(readFileSync(PROTOCOL));
  if (actual !== m[1]) throw new Error(`protocol.md does not match its recorded sha256 (${actual})`);
  console.log(`protocol.md matches its recorded sha256 ${actual.slice(0, 12)}...`);
}

async function main(): Promise<void> {
  loadDotEnv();
  if (process.argv.includes("--prepare")) return prepare();
  if (process.argv.includes("--run")) {
    checkSeal();
    return score(false);
  }
  if (process.argv.includes("--score")) {
    checkSeal();
    return score(true);
  }
  if (process.argv.includes("--explore")) return explore();
  console.error("usage: npx tsx scripts/llm-baseline.ts --prepare | --run | --score | --explore");
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
