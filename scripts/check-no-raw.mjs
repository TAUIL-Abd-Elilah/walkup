#!/usr/bin/env node
/**
 * check-no-raw: refuses a commit (or fails CI) when the git index would publish
 * private data or raw API response bodies.
 *
 * Exit 1 when:
 *  - git tracks or stages anything under fixtures/raw/ or data/private/ (also the
 *    other private outputs: probe_out/, .cache/, evals/out/private/, *.sqlite files);
 *  - any tracked or staged file outside fixtures/synthetic/ parses as JSON that looks
 *    like a raw API body: it contains the keys "entity_id", "query" and "affinity";
 *    or "results" with a "heatmap" array; or a flat "results" array of objects with
 *    "entity_id"; or a compare body (results.tags + results.a + results.b). Strings
 *    holding JSON (HAR files, logs) are parsed and checked too;
 *  - a raw-looking JSON file inside fixtures/synthetic/ lacks "synthetic": true at its top level;
 *  - a tracked text file is too large to scan (over 64 MB).
 * Exit 2 on a usage or git error. Exit 0 otherwise.
 *
 * Content is read from the index (what would be committed), not the working tree.
 *
 *   node scripts/check-no-raw.mjs            check every tracked or staged file
 *   node scripts/check-no-raw.mjs --staged   check only files staged for the next commit
 *
 * Enable the pre-commit hook once per clone:  git config core.hooksPath .githooks
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_DIRS = ["fixtures/raw/", "data/private/", "probe_out/", ".cache/", "evals/out/private/"];
export const SYNTHETIC_DIR = "fixtures/synthetic/";
const SQLITE_RE = /\.sqlite(-[a-z]+)?$/i;
const JSON_LINES_RE = /\.(jsonl|ndjson)$/i;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

/** Why a path may never be tracked, or null when it may. */
export function forbiddenPathReason(path) {
  const p = path.replace(/\\/g, "/");
  const base = p.slice(p.lastIndexOf("/") + 1);
  for (const dir of FORBIDDEN_DIRS) {
    if (p.startsWith(dir) || p.includes(`/${dir}`)) {
      if (base === ".gitkeep") return null;
      return `private path (${dir})`;
    }
  }
  if (SQLITE_RE.test(p)) return "SQLite cache file";
  return null;
}

/**
 * Looks at parsed JSON and returns a reason string when it resembles a raw API
 * response body, or null when it does not.
 */
export function rawBodyReason(value) {
  const keys = new Set();
  const found = { heatmapResults: false, flatEntityResults: false, compare: false };
  walk(value, 0, keys, found);
  if (keys.has("entity_id") && keys.has("query") && keys.has("affinity")) return 'contains "entity_id", "query" and "affinity" keys';
  if (found.heatmapResults) return '"results" with a "heatmap" array';
  if (found.flatEntityResults) return 'flat "results" array of objects with "entity_id"';
  if (found.compare) return 'compare body ("results.tags", "results.a", "results.b")';
  return null;
}

function walk(node, depth, keys, found) {
  if (depth > 64 || node === null) return;
  if (typeof node === "string") {
    const t = node.trimStart();
    if (node.length > 40 && (t.startsWith("{") || t.startsWith("["))) {
      try {
        walk(JSON.parse(node), depth + 1, keys, found);
      } catch {
        // not JSON: ignore
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, keys, found);
    return;
  }
  if (typeof node !== "object") return;
  for (const k of Object.keys(node)) keys.add(k);
  const results = node.results;
  if (results && typeof results === "object" && !Array.isArray(results)) {
    if (Array.isArray(results.heatmap)) found.heatmapResults = true;
    if (Array.isArray(results.tags) && Array.isArray(results.a) && Array.isArray(results.b)) found.compare = true;
  }
  if (Array.isArray(node.heatmap) && "results" in node) found.heatmapResults = true;
  if (Array.isArray(results) && results.some((r) => r && typeof r === "object" && "entity_id" in r)) found.flatEntityResults = true;
  for (const v of Object.values(node)) walk(v, depth + 1, keys, found);
}

/** Parses text as JSON (or JSON lines for .jsonl/.ndjson). Returns undefined when it is not JSON. */
export function parseJsonish(path, text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const t = body.trim();
  if (t === "") return undefined;
  if (JSON_LINES_RE.test(path)) {
    const rows = [];
    for (const line of t.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        return undefined;
      }
    }
    return rows;
  }
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Checks one file's index content. Returns a reason string or null. */
export function contentReason(path, text) {
  const p = path.replace(/\\/g, "/");
  const parsed = parseJsonish(p, text);
  if (parsed === undefined) return null;
  const raw = rawBodyReason(parsed);
  if (!raw) return null;
  if (p.startsWith(SYNTHETIC_DIR)) {
    const marked = parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.synthetic === true;
    return marked ? null : `synthetic fixture looks raw (${raw}) but lacks "synthetic": true at the top level`;
  }
  return `looks like a raw API body: ${raw}`;
}

function git(args, cwd, input) {
  return execFileSync("git", args, {
    cwd,
    input,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Reads index blobs for many paths with one `git cat-file --batch`. */
function readIndexBlobs(root, paths) {
  const safe = paths.filter((p) => !p.includes("\n"));
  if (safe.length === 0) return new Map();
  const out = git(["cat-file", "--batch"], root, safe.map((p) => `:${p}`).join("\n") + "\n");
  const map = new Map();
  let pos = 0;
  for (const p of safe) {
    const nl = out.indexOf(10, pos);
    if (nl === -1) break;
    const header = out.subarray(pos, nl).toString("utf8");
    pos = nl + 1;
    if (header.endsWith(" missing")) continue;
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) break;
    map.set(p, out.subarray(pos, pos + size));
    pos += size + 1;
  }
  return map;
}

/** Runs the check in the repository containing `cwd`. Returns { violations, checked }. */
export function checkRepo({ cwd = process.cwd(), stagedOnly = false } = {}) {
  const root = git(["rev-parse", "--show-toplevel"], cwd).toString("utf8").trim();
  const listArgs = stagedOnly
    ? ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]
    : ["ls-files", "-z", "--cached"];
  const paths = git(listArgs, root)
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "");
  const violations = [];
  const toScan = [];
  for (const p of paths) {
    const why = forbiddenPathReason(p);
    if (why) violations.push({ path: p, reason: why });
    else toScan.push(p);
  }
  const blobs = readIndexBlobs(root, toScan);
  for (const [p, buf] of blobs) {
    if (buf.subarray(0, 8000).includes(0)) continue; // binary
    if (buf.length > MAX_SCAN_BYTES) {
      // Fail closed: a text file this large is not scanned, so it cannot be cleared either.
      violations.push({ path: p, reason: `text file over ${MAX_SCAN_BYTES / (1024 * 1024)} MB; too large to scan` });
      continue;
    }
    const why = contentReason(p, buf.toString("utf8"));
    if (why) violations.push({ path: p, reason: why });
  }
  return { violations, checked: paths.length };
}

function main(argv) {
  const stagedOnly = argv.includes("--staged");
  const unknown = argv.filter((a) => a !== "--staged");
  if (unknown.length > 0) {
    console.error(`check-no-raw: unknown argument(s): ${unknown.join(" ")}`);
    return 2;
  }
  let result;
  try {
    result = checkRepo({ stagedOnly });
  } catch (err) {
    const msg = err && typeof err === "object" && "stderr" in err && err.stderr ? String(err.stderr) : String(err);
    console.error(`check-no-raw: git failed: ${msg.trim()}`);
    return 2;
  }
  if (result.violations.length === 0) {
    console.log(`check-no-raw: ok (${result.checked} file${result.checked === 1 ? "" : "s"} checked)`);
    return 0;
  }
  console.error(`check-no-raw: ${result.violations.length} problem(s):`);
  for (const v of result.violations) console.error(`  ${v.path}: ${v.reason}`);
  console.error(
    "Raw API bodies and private data stay out of git. Unstage with `git rm --cached <path>`; synthetic fixtures belong in fixtures/synthetic/ with \"synthetic\": true.",
  );
  return 1;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) process.exit(main(process.argv.slice(2)));
