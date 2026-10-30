#!/usr/bin/env node
// @ts-check
/**
 * walkup: command-line client for a Walkup server.
 *
 * It sends only what you type (a Ticketmaster event URL or "Artist @ Venue, Date",
 * partner names, a plan id and optional what-if numbers) to the server named by
 * WALKUP_URL. It reads no API keys, forwards no environment variables, runs
 * no downloaded code, and writes a file only when you ask for a PDF.
 *
 * Node 22+ (global fetch). No dependencies. Run with --help for usage.
 */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** @typedef {{ input: string, entityId: string }} Pick */
/**
 * @typedef {object} Options
 * @property {boolean} json
 * @property {boolean} pdf
 * @property {boolean} help
 * @property {boolean} version
 * @property {string | null} out
 * @property {number | null} seatsLeft
 * @property {number | null} capacity
 * @property {number | null} radiusKm
 * @property {string[] | null} streetDays
 * @property {Pick[]} picks
 */
/**
 * Server JSON is read defensively field by field, so it is typed loosely on purpose
 * (`any`): the CLI must keep working if the server adds or omits fields.
 * @typedef {Record<string, any>} Json
 */

const VERSION = "0.1.0";
const DEFAULT_URL = "http://localhost:3000";
const TIMEOUT_MS = 90_000;
const MAX_PARTNERS = 20;

const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NEEDS_INPUT: 3,
  UNREACHABLE: 4,
  LIMIT: 5,
  FIXTURE: 6,
});

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const CARD_LABELS = {
  resolution: "Resolution",
  liftMap: "Lift map",
  partners: "Partners",
  declared: "Your list",
  prePost: "Before/after",
  media: "Media/sponsor",
  demographics: "Age mix",
  whatsDifferent: "Crowd differs",
  copyHooks: "Copy hooks",
};

const HELP = `walkup ${VERSION}: plan where to sell one booked show's remaining seats.

Usage:
  walkup plan <ticketmaster-event-url | "Artist @ Venue, Date"> [options]
  walkup rank-partners <event> <partner name> [<partner name> ...]
  walkup sheet <plan-id> [--pdf [--out <file>]]
  walkup health

Plan options (optional what-ifs, never sales data):
  --seats-left <n>        seats you still want to sell (marked HYPOTHETICAL on a sample run)
  --capacity <n>          room capacity
  --radius-km <km>        radius around the venue, 1-100 (server default 40)
  --street-days <days>    street-team days, e.g. thursday,saturday or thu,sat
  --pick <input>=<id>     answer a needs_input question with a candidate id (repeatable)

Output:
  --json                  print the server's JSON envelope as-is
  --pdf                   (sheet) download the Street Sheet PDF
  --out <file>            (sheet --pdf) where to save it (default street-sheet-<plan-id>.pdf)

Server: WALKUP_URL (default ${DEFAULT_URL}). No API keys are read or sent.
Exit codes: 0 ok, 1 error, 2 usage, 3 needs_input, 4 server unreachable,
            5 limit reached, 6 server in fixture or recorded mode (no new plans).`;

class CliError extends Error {
  /** @param {string} message @param {number} code */
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** @param {string} text */
function out(text) {
  process.stdout.write(`${text}\n`);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** @param {string[]} argv @returns {{ positionals: string[], opts: Options }} */
function parseArgs(argv) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Options} */
  const opts = {
    json: false,
    pdf: false,
    help: false,
    version: false,
    out: null,
    seatsLeft: null,
    capacity: null,
    radiusKm: null,
    streetDays: null,
    picks: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i]);
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new CliError(`--${name} needs a value.`, EXIT.USAGE);
      i += 1;
      return next;
    };
    switch (name) {
      case "json":
        opts.json = true;
        break;
      case "pdf":
        opts.pdf = true;
        break;
      case "help":
        opts.help = true;
        break;
      case "version":
        opts.version = true;
        break;
      case "out":
        opts.out = value();
        break;
      case "seats-left":
        opts.seatsLeft = toWholeNumber(value(), name);
        break;
      case "capacity":
        opts.capacity = toWholeNumber(value(), name);
        break;
      case "radius-km":
        opts.radiusKm = toRadius(value());
        break;
      case "street-days":
        opts.streetDays = toWeekdays(value());
        break;
      case "pick":
        opts.picks.push(toPick(value()));
        break;
      default:
        throw new CliError(`Unknown option --${name}. Try --help.`, EXIT.USAGE);
    }
  }
  return { positionals, opts };
}

/** @param {string} raw @param {string} name */
function toWholeNumber(raw, name) {
  if (!/^\d{1,7}$/.test(raw)) throw new CliError(`--${name} must be a whole number.`, EXIT.USAGE);
  return Number(raw);
}

/** @param {string} raw */
function toRadius(raw) {
  const km = Number(raw);
  if (!Number.isFinite(km) || km < 1 || km > 100) throw new CliError("--radius-km must be between 1 and 100.", EXIT.USAGE);
  return km;
}

/** @param {string} raw */
function toWeekdays(raw) {
  const days = raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .map((d) => {
      const day = WEEKDAYS.find((w) => w === d || (d.length >= 3 && w.startsWith(d)));
      if (!day) throw new CliError(`Unknown weekday "${d}" in --street-days.`, EXIT.USAGE);
      return day;
    });
  if (days.length === 0) throw new CliError("--street-days needs at least one weekday.", EXIT.USAGE);
  return [...new Set(days)];
}

/** @param {string} raw @returns {Pick} */
function toPick(raw) {
  const at = raw.lastIndexOf("=");
  const input = at === -1 ? "" : raw.slice(0, at).trim();
  const entityId = at === -1 ? "" : raw.slice(at + 1).trim();
  if (!input || !/^[A-Za-z0-9-]{1,64}$/.test(entityId)) {
    throw new CliError('--pick takes "<input>=<entity id>", e.g. --pick "Name=1a2b3c4d-...".', EXIT.USAGE);
  }
  return { input, entityId };
}

/**
 * This skill never carries contact details. Refuse anything that looks like an email address.
 * @param {string[]} values
 */
function assertNoContactDetails(values) {
  const email = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/;
  for (const v of values) {
    if (email.test(v)) {
      throw new CliError(
        "That argument contains an email address. This skill sends no contact details; " +
          "add contacts in the web app's send dialog, which asks you to confirm.",
        EXIT.USAGE,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function serverUrl() {
  const raw = (process.env.WALKUP_URL ?? "").trim() || DEFAULT_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`WALKUP_URL is not a valid URL: ${raw}`, EXIT.USAGE);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError("WALKUP_URL must start with https:// or http://.", EXIT.USAGE);
  }
  if (url.username || url.password) {
    throw new CliError("WALKUP_URL must not contain credentials.", EXIT.USAGE);
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

/**
 * @param {string} base
 * @param {"GET" | "POST"} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [accept]
 * @returns {Promise<Response>}
 */
async function request(base, method, path, body, accept = "application/json") {
  /** @type {Record<string, string>} */
  const headers = { accept, "user-agent": `walkup-skill/${VERSION}` };
  /** @type {RequestInit} */
  const init = { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  try {
    return await fetch(`${base}${path}`, init);
  } catch (caught) {
    const error = /** @type {{ name?: string, cause?: { code?: string } } | undefined} */ (caught);
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new CliError(
        `No answer from ${base} after ${TIMEOUT_MS / 1000} s. A fresh sheet makes about 30 Qloo calls and can take a while; try again or open the web app.`,
        EXIT.UNREACHABLE,
      );
    }
    const code = error?.cause?.code ? ` (${error.cause.code})` : "";
    throw new CliError(
      `Walkup server unreachable at ${base}${code}.\n` +
        'Set WALKUP_URL to a running Walkup server, or start one locally with "npm run dev" in the repository.',
      EXIT.UNREACHABLE,
    );
  }
}

/** @param {Response} res @returns {Promise<Json | null>} */
async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    return data !== null && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/** @param {Response} res @param {string} base @returns {Promise<Json>} */
async function readJson(res, base) {
  const data = await readBody(res);
  if (!res.ok) throw httpError(res, data, base);
  if (data === null) {
    throw new CliError(
      `Unexpected response from ${base} (HTTP ${res.status}, not JSON). Is WALKUP_URL pointing at a Walkup server?`,
      EXIT.ERROR,
    );
  }
  return data;
}

/** @param {Json | null} data @returns {string | null} */
function reasonOf(data) {
  if (!data) return null;
  for (const key of ["reason", "summary", "error", "message"]) {
    if (typeof data[key] === "string" && data[key].trim()) return data[key].trim();
  }
  return null;
}

/** @param {Json | null} data */
function isFixture(data) {
  return data?.mode === "fixture" || /fixture/i.test(reasonOf(data) ?? "");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A recorded sheet's day, "Oct 21 2026" style (UTC), or null.
 * @param {unknown} createdAt
 */
function recordedDay(createdAt) {
  if (typeof createdAt !== "string") return null;
  const at = new Date(createdAt);
  if (!Number.isFinite(at.getTime())) return null;
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()} ${at.getUTCFullYear()}`;
}

/** @param {string} text */
function withoutStop(text) {
  return text.replace(/\.+$/, "");
}

/** @param {Response} res @param {Json | null} data @param {string} base */
function httpError(res, data, base) {
  const reason = reasonOf(data);
  if (res.status === 429) {
    return new CliError(
      `Limit reached: ${withoutStop(reason ?? "fresh runs are capped per IP and per day")}. Cached presets still open in the web app.`,
      EXIT.LIMIT,
    );
  }
  if (res.status === 503 && data?.mode === "recorded") {
    return new CliError(
      `Recorded sheets only: ${withoutStop(reason ?? "live runs are paused for judging; this server serves sheets recorded from live Qloo and Ticketmaster runs")}. Read one with: walkup sheet <plan-id>`,
      EXIT.FIXTURE,
    );
  }
  if (res.status === 503 && isFixture(data)) {
    return new CliError(
      `The server is in fixture mode: ${withoutStop(reason ?? "fresh runs are disabled")}. Sample presets still open in the web app.`,
      EXIT.FIXTURE,
    );
  }
  if (res.status === 404) {
    return new CliError(
      `Not found at ${base} (HTTP 404)${reason ? `: ${withoutStop(reason)}` : ""}. Check the plan id and that WALKUP_URL is a Walkup server.`,
      EXIT.ERROR,
    );
  }
  return new CliError(`Server error (HTTP ${res.status})${reason ? `: ${withoutStop(reason)}` : ""}.`, EXIT.ERROR);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** @param {string} status */
function exitFor(status) {
  if (status === "needs_input") return EXIT.NEEDS_INPUT;
  if (status === "error") return EXIT.ERROR;
  return EXIT.OK;
}

/** @param {unknown} chips */
function refs(chips) {
  if (!Array.isArray(chips)) return "";
  const ids = [...new Set(chips.map((c) => c?.ledgerRef).filter((r) => typeof r === "string"))];
  return ids.length ? ` [${ids.join(", ")}]` : "";
}

/** @param {unknown} resolution @param {string | null} resumeEvent */
function needsInputLines(resolution, resumeEvent) {
  /** @type {string[]} */
  const lines = [];
  for (const r of Array.isArray(resolution) ? resolution : []) {
    if (r?.status !== "needs_input") continue;
    lines.push(`"${r.input}" (${r.role}) matches more than one entity. Candidates:`);
    for (const c of Array.isArray(r.candidates) ? r.candidates : []) {
      const bits = [c.name, c.subtype];
      if (typeof c.popularity === "number") bits.push(`popularity ${c.popularity.toFixed(2)}`);
      if (c.releaseYear) bits.push(String(c.releaseYear));
      if (c.shortDescription) bits.push(c.shortDescription);
      lines.push(`  - ${bits.filter(Boolean).join(" · ")}  (id ${c.entityId})`);
    }
    if (resumeEvent) {
      lines.push(`  Pick one: walkup plan "${resumeEvent}" --pick "${r.input}=<id>"`);
    } else {
      lines.push("  Pick one in the web app, or retype the name more specifically.");
    }
  }
  return lines;
}

/** @param {Json | null} sheet */
function sheetLines(sheet) {
  /** @type {string[]} */
  const lines = [];
  const cards = sheet?.cards;
  if (cards && typeof cards === "object") {
    lines.push("Cards:");
    for (const [key, card] of Object.entries(cards)) {
      if (!card || typeof card !== "object") continue;
      const label = (/** @type {Record<string, string>} */ (CARD_LABELS)[key] ?? key).padEnd(17);
      const status = String(card.status ?? "?").padEnd(12);
      lines.push(`  ${label}${status}${card.summary ?? ""}`);
    }
    const partners = Array.isArray(cards.partners?.results) ? cards.partners.results : [];
    if (partners.length) {
      lines.push(`Top partners (of ${partners.length}; suggested, not affiliated):`);
      partners.slice(0, 5).forEach((/** @type {Json} */ p, /** @type {number} */ i) => {
        const where = [p.category ? String(p.category).replace(/_/g, " ") : null, p.tileName].filter(Boolean).join(", ");
        lines.push(`  ${i + 1}. ${p.entity?.name ?? "?"}${where ? ` (${where})` : ""}${refs(p.chips)}`);
      });
    }
  }
  if (sheet?.guard && typeof sheet.guard.dropped === "number") {
    const dropped = sheet.guard.dropped;
    const denied = sheet.guard.deniedTagCount ?? 0;
    lines.push(`Guard: ${dropped} claim${dropped === 1 ? "" : "s"} dropped, ${denied} tag${denied === 1 ? "" : "s"} denied by policy.`);
  }
  if (Array.isArray(sheet?.ledger)) {
    const qloo = sheet.ledger.filter((/** @type {Json} */ e) => e?.kind === "qloo");
    const hits = qloo.filter((/** @type {Json} */ e) => e?.cacheHit).length;
    lines.push(`Ledger: ${sheet.ledger.length} entries, ${qloo.length} Qloo calls (${hits} from cache).`);
  }
  return lines;
}

/** @param {Json} data @param {Options} opts @param {string} base @param {string | null} resumeEvent */
function report(data, opts, base, resumeEvent) {
  const status = typeof data.status === "string" ? data.status : "unknown";
  if (opts.json) {
    out(JSON.stringify(data, null, 2));
    return exitFor(status);
  }
  /** @type {Json | null} */
  const sheet = data.results && typeof data.results === "object" && !Array.isArray(data.results) ? data.results : null;
  /** @type {string[]} */
  const lines = [];
  if ((data.mode ?? sheet?.mode) === "fixture") lines.push("FIXTURE: sample data (synthetic), not a live run.");
  else if (data.mode === "recorded" && sheet) {
    const day = recordedDay(sheet.createdAt);
    lines.push(`RECORDED: recorded from live Qloo and Ticketmaster runs${day ? ` on ${day}` : ""}. Live runs are paused for judging; this sheet comes from a live run, and any change since was made offline, with no API call.`);
  }
  if (sheet?.hypothetical) lines.push("HYPOTHETICAL COUNT: seats left and capacity are what-ifs.");
  lines.push(`Status: ${status}${data.planId ? ` · plan ${data.planId}` : ""}`);
  if (data.summary) lines.push(String(data.summary));
  if (data.reason && status !== "ok") lines.push(`Reason: ${data.reason}`);
  if (status === "needs_input") {
    lines.push(...needsInputLines(data.resolution ?? sheet?.cards?.resolution?.results, resumeEvent));
  }
  if (sheet) lines.push(...sheetLines(sheet));
  const limits = Array.isArray(data.limits) && data.limits.length ? data.limits : sheet?.limits;
  if (Array.isArray(limits) && limits.length) {
    lines.push("What this does not establish:");
    for (const l of limits) lines.push(`  - ${l}`);
  }
  const sheetUrl = typeof data.sheetUrl === "string" ? data.sheetUrl : data.planId ? `${base}/s/${data.planId}` : null;
  if (sheetUrl) lines.push(`Street Sheet: ${sheetUrl}`);
  out(lines.join("\n"));
  return exitFor(status);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** @param {Options} opts */
function operatorInputs(opts) {
  /** @type {Record<string, number | string[]>} */
  const operator = {};
  if (opts.seatsLeft !== null) operator.seatsLeft = opts.seatsLeft;
  if (opts.capacity !== null) operator.capacity = opts.capacity;
  if (opts.radiusKm !== null) operator.radiusKm = opts.radiusKm;
  if (opts.streetDays !== null) operator.streetTeamDays = opts.streetDays;
  return Object.keys(operator).length ? operator : null;
}

/** @param {string} base @param {string[]} args @param {Options} opts */
async function cmdPlan(base, args, opts) {
  const event = args.join(" ").trim();
  if (!event) throw new CliError('plan needs a Ticketmaster event URL or "Artist @ Venue, Date".', EXIT.USAGE);
  assertNoContactDetails([event, ...opts.picks.map((p) => p.input)]);
  /** @type {Json} */
  const body = { event };
  const operator = operatorInputs(opts);
  if (operator) body.operator = operator;
  if (opts.picks.length) body.picks = opts.picks;
  const data = await readJson(await request(base, "POST", "/api/plan", body), base);
  return report(data, opts, base, event);
}

/** @param {string} base @param {string[]} args @param {Options} opts */
async function cmdRankPartners(base, args, opts) {
  const [event, ...partners] = args.map((a) => a.trim()).filter(Boolean);
  if (!event || partners.length === 0) {
    throw new CliError('rank-partners needs an event and at least one partner name, e.g. rank-partners "<event>" "Name One" "Name Two".', EXIT.USAGE);
  }
  if (partners.length > MAX_PARTNERS) throw new CliError(`At most ${MAX_PARTNERS} partner names per run.`, EXIT.USAGE);
  assertNoContactDetails([event, ...partners]);
  const data = await readJson(await request(base, "POST", "/api/rank-partners", { event, partners }), base);
  if (opts.json) return report(data, opts, base, null);

  const status = typeof data.status === "string" ? data.status : "unknown";
  /** @type {Json[]} */
  const rows = Array.isArray(data.results) ? data.results : [];
  const lines = [`Status: ${status}`];
  if (data.summary) lines.push(String(data.summary));
  if (data.reason && status !== "ok") lines.push(`Reason: ${data.reason}`);
  const scored = rows.filter((r) => typeof r?.rank === "number").sort((a, b) => a.rank - b.rank);
  const unscored = rows.filter((r) => typeof r?.rank !== "number");
  if (scored.length) {
    lines.push("Call order (ranked by this bill's crowd; suggested, not affiliated):");
    for (const r of scored) lines.push(`  ${r.rank}. ${r.entity?.name ?? r.declared?.label ?? "?"}${refs(r.chips)}`);
  }
  if (unscored.length) {
    lines.push("Declared, not scored (not in Qloo's catalog):");
    for (const r of unscored) lines.push(`  - ${r.declared?.label ?? "?"}`);
  }
  if (status === "needs_input") lines.push(...needsInputLines(data.resolution, null));
  out(lines.join("\n"));
  return exitFor(status);
}

/** @param {string} base @param {string[]} args @param {Options} opts */
async function cmdSheet(base, args, opts) {
  const [planId] = args;
  if (!planId) throw new CliError("sheet needs a plan id.", EXIT.USAGE);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(planId)) {
    throw new CliError("Plan ids contain only letters, digits, - and _.", EXIT.USAGE);
  }
  if (!opts.pdf) {
    const data = await readJson(await request(base, "GET", `/api/sheet/${planId}`), base);
    return report(data, opts, base, null);
  }
  const res = await request(base, "GET", `/api/sheet/${planId}/pdf`, undefined, "application/pdf");
  if (!res.ok) throw httpError(res, await readBody(res), base);
  const type = res.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/pdf")) {
    throw new CliError(`Expected a PDF from ${base} but got "${type || "no content type"}".`, EXIT.ERROR);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  const target = resolve(opts.out ?? `street-sheet-${planId}.pdf`);
  await writeFile(target, bytes);
  out(`Saved ${target} (${bytes.length} bytes).`);
  return EXIT.OK;
}

/** @param {string} base @param {Options} opts */
async function cmdHealth(base, opts) {
  const data = await readJson(await request(base, "GET", "/healthz"), base);
  out(opts.json ? JSON.stringify(data, null, 2) : `Walkup at ${base}\n${JSON.stringify(data, null, 2)}`);
  return EXIT.OK;
}

/**
 * Options are never silently ignored: one that a command does not use is a usage
 * error (e.g. --pick on rank-partners, --out without --pdf).
 * @param {string} command @param {Options} opts
 */
function assertOptionsApply(command, opts) {
  if (!["plan", "rank-partners", "sheet", "health"].includes(command)) return;
  /** @type {string[]} */
  const unused = [];
  if (command !== "plan") {
    if (opts.seatsLeft !== null) unused.push("--seats-left");
    if (opts.capacity !== null) unused.push("--capacity");
    if (opts.radiusKm !== null) unused.push("--radius-km");
    if (opts.streetDays !== null) unused.push("--street-days");
    if (opts.picks.length) unused.push("--pick");
  }
  if (command !== "sheet" && opts.pdf) unused.push("--pdf");
  if (opts.out !== null && !(command === "sheet" && opts.pdf)) unused.push("--out");
  if (unused.length) {
    const extra = command === "rank-partners" && opts.picks.length
      ? " To answer a partner's needs_input, retype the name more specifically or pick it in the web app."
      : "";
    throw new CliError(`${unused.join(", ")} cannot be used with "${command}".${extra} Try --help.`, EXIT.USAGE);
  }
}

/** @param {string[]} argv @returns {Promise<number>} */
async function main(argv) {
  const { positionals, opts } = parseArgs(argv);
  if (opts.version) {
    out(VERSION);
    return EXIT.OK;
  }
  const [command, ...rest] = positionals;
  if (opts.help || command === "help") {
    out(HELP);
    return EXIT.OK;
  }
  if (!command) {
    process.stderr.write(`${HELP}\n`);
    return EXIT.USAGE;
  }
  assertOptionsApply(command, opts);
  const base = serverUrl();
  switch (command) {
    case "plan":
      return cmdPlan(base, rest, opts);
    case "rank-partners":
      return cmdRankPartners(base, rest, opts);
    case "sheet":
      return cmdSheet(base, rest, opts);
    case "health":
      return cmdHealth(base, opts);
    default:
      throw new CliError(`Unknown command "${command}". Try --help.`, EXIT.USAGE);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof CliError) {
      process.stderr.write(`walkup: ${error.message}\n`);
      process.exitCode = error.code;
    } else {
      process.stderr.write(`walkup: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT.ERROR;
    }
  },
);
