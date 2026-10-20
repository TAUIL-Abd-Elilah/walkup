// @ts-check
// Tests for skills/walkup/scripts/walkup.mjs against a local fake server.
// Offline: the only network traffic is to 127.0.0.1. All payloads are synthetic.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../walkup/scripts/walkup.mjs", import.meta.url));
const FAKE_KEY = "test-key-that-must-never-leave-the-machine";

/** @type {{method: string, url: string, headers: Record<string, unknown>, body: string}[]} */
const seen = [];
/** @type {import("node:http").Server} */
let server;
let base = "";

/** @param {import("node:http").Server} srv */
function portOf(srv) {
  const addr = srv.address();
  if (!addr || typeof addr === "string") throw new Error("server has no TCP port");
  return addr.port;
}

function syntheticSheet() {
  return {
    synthetic: true,
    planId: "plan_abc123",
    mode: "fixture",
    hypothetical: true,
    cards: {
      resolution: { status: "ok", summary: "3 of 3 acts resolved.", results: [], provenance: ["Q1"], limits: [] },
      partners: {
        status: "ok",
        summary: "1 partner in 1 tile.",
        results: [
          {
            entity: { entityId: "SYN-1", name: "Synthetic Records" },
            category: "record_store",
            tileName: "Tile A",
            chips: [{ label: "over-indexes for this bill", ledgerRef: "Q9" }],
          },
        ],
        provenance: ["Q9"],
        limits: [],
      },
      media: { status: "empty", summary: "No sponsor survived the exclusions.", results: [], provenance: ["Q13"], limits: [] },
    },
    guard: { dropped: 0, reasons: [], deniedTagCount: 2 },
    ledger: [
      { id: "Q1", kind: "qloo", cacheHit: true },
      { id: "Q9", kind: "qloo", cacheHit: false },
      { id: "T1", kind: "tm", cacheHit: false },
    ],
    limits: ["This sheet does not show that it sells tickets."],
  };
}

function okPlan() {
  return {
    status: "ok",
    summary: "Synthetic plan.",
    planId: "plan_abc123",
    sheetUrl: `${base}/s/plan_abc123`,
    mode: "fixture",
    results: syntheticSheet(),
    provenance: ["Q1", "Q9"],
    limits: ["This sheet does not show that it sells tickets."],
  };
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload JSON value, or the raw body when `type` is not JSON
 * @param {string} [type]
 */
function send(res, status, payload, type = "application/json") {
  res.writeHead(status, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(payload) : String(payload));
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} body
 */
function handle(req, res, body) {
  const url = req.url ?? "";
  if (url.startsWith("/html/")) return send(res, 200, "<html>not an api</html>", "text/html");
  if (req.method === "POST" && url === "/api/plan") {
    const input = JSON.parse(body);
    if (input.event.includes("Busy")) return send(res, 429, { status: "error", reason: "3 fresh runs per IP per day" });
    if (input.event.includes("Recorded")) return send(res, 503, { status: "error", mode: "fixture", reason: "fresh runs are disabled" });
    if (input.event.includes("Ambiguous") && !input.picks) {
      return send(res, 200, {
        status: "needs_input",
        summary: "One act needs a pick.",
        mode: "fixture",
        results: null,
        resolution: [
          {
            input: "Ambiguous",
            role: "headliner",
            status: "needs_input",
            candidates: [
              { entityId: "AAA-111", name: "Ambiguous", subtype: "urn:entity:person", popularity: 0.81, shortDescription: "Synthetic comedian" },
              { entityId: "BBB-222", name: "Ambiguous", subtype: "urn:entity:artist", popularity: 0.42 },
            ],
          },
        ],
        provenance: ["Q1"],
        limits: [],
      });
    }
    return send(res, 200, okPlan());
  }
  if (req.method === "POST" && url === "/api/rank-partners") {
    const input = JSON.parse(body);
    if (input.event.includes("Ambiguous")) {
      return send(res, 200, {
        status: "needs_input",
        summary: "One partner needs a pick.",
        results: [],
        resolution: [
          {
            input: "Ambiguous",
            role: "partner",
            status: "needs_input",
            candidates: [
              { entityId: "CCC-333", name: "Ambiguous", subtype: "urn:entity:place", popularity: 0.5 },
              { entityId: "DDD-444", name: "Ambiguous", subtype: "urn:entity:place", popularity: 0.4 },
            ],
          },
        ],
        provenance: ["Q11"],
        limits: [],
      });
    }
    return send(res, 200, {
      status: "partial",
      summary: "1 of 2 partners scored.",
      reason: "1 partner is not in the catalog.",
      results: [
        { declared: { label: "Unknown Spot" }, rank: null, chips: [] },
        { declared: { label: "Partner Two" }, rank: 1, entity: { name: "Partner Two" }, chips: [{ label: "rank", ledgerRef: "Q11" }] },
      ],
      provenance: ["Q11"],
      limits: [],
    });
  }
  if (req.method === "GET" && url === "/api/sheet/plan_abc123") return send(res, 200, okPlan());
  if (req.method === "GET" && url === "/api/sheet/plan_abc123/pdf") return send(res, 200, "%PDF-1.4\n% synthetic\n", "application/pdf");
  if (req.method === "GET" && url === "/healthz") return send(res, 200, { mode: "fixture", qloo: "no key" });
  return send(res, 404, { status: "error", reason: "no such route or plan" });
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers }, body });
      handle(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  base = `http://127.0.0.1:${portOf(server)}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * @param {string[]} args
 * @param {{ url?: string | null, cwd?: string }} [options] url null leaves WALKUP_URL unset
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(args, { url = base, cwd } = {}) {
  return new Promise((resolve) => {
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, QLOO_API_KEY: FAKE_KEY, ANTHROPIC_API_KEY: FAKE_KEY };
    if (url === null) delete env.WALKUP_URL;
    else env.WALKUP_URL = url;
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function lastRequest() {
  const req = seen[seen.length - 1];
  if (!req) throw new Error("no request was recorded");
  return req;
}

test("--help prints usage and exits 0", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage:/);
  assert.match(r.stdout, /rank-partners/);
});

test("no command prints usage to stderr and exits 2", async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage:/);
});

test("unknown command and unknown option exit 2", async () => {
  assert.equal((await run(["launch"])).code, 2);
  assert.equal((await run(["plan", "x", "--nope"])).code, 2);
});

test("plan posts only the event and operator what-ifs, and prints the sheet", async () => {
  const r = await run(["plan", "Synthetic Band @ Test Hall, Nov 28 2026", "--street-days", "thu,saturday", "--seats-left", "1850"]);
  assert.equal(r.code, 0, r.stderr);
  const req = lastRequest();
  assert.equal(req.method, "POST");
  assert.equal(req.url, "/api/plan");
  const body = JSON.parse(req.body);
  assert.deepEqual(Object.keys(body).sort(), ["event", "operator"]);
  assert.equal(body.event, "Synthetic Band @ Test Hall, Nov 28 2026");
  assert.deepEqual(body.operator, { seatsLeft: 1850, streetTeamDays: ["thursday", "saturday"] });
  assert.match(r.stdout, /FIXTURE/);
  assert.match(r.stdout, /HYPOTHETICAL COUNT/);
  assert.match(r.stdout, /Synthetic Records \(record_store, Tile A\) \[Q9\]/);
  assert.match(r.stdout, /Guard: 0 claim\(s\) dropped, 2 tag\(s\) denied by policy/);
  assert.match(r.stdout, /3 entries, 2 Qloo calls \(1 from cache\)/);
  assert.match(r.stdout, /does not show that it sells tickets/);
  assert.match(r.stdout, new RegExp(`Street Sheet: ${base}/s/plan_abc123`));
});

test("no API key or credential header is ever sent", async () => {
  await run(["plan", "Synthetic Band @ Test Hall, Nov 28 2026"]);
  await run(["rank-partners", "Synthetic Band @ Test Hall", "Partner Two"]);
  for (const req of seen) {
    const dump = JSON.stringify(req.headers) + req.body;
    assert.ok(!dump.includes(FAKE_KEY), `key leaked in ${req.method} ${req.url}`);
    assert.equal(req.headers["authorization"], undefined);
    assert.equal(req.headers["x-api-key"], undefined);
    assert.equal(req.headers["cookie"], undefined);
  }
});

test("needs_input lists candidates, explains --pick and exits 3", async () => {
  const r = await run(["plan", "Ambiguous @ Test Hall, Nov 28 2026"]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout, /"Ambiguous" \(headliner\) matches more than one entity/);
  assert.match(r.stdout, /AAA-111/);
  assert.match(r.stdout, /BBB-222/);
  assert.match(r.stdout, /--pick "Ambiguous=<id>"/);
});

test("--pick sends the operator's choice", async () => {
  const r = await run(["plan", "Ambiguous @ Test Hall, Nov 28 2026", "--pick", "Ambiguous=AAA-111"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(lastRequest().body).picks, [{ input: "Ambiguous", entityId: "AAA-111" }]);
});

test("a rate or quota limit exits 5 with the server's reason", async () => {
  const r = await run(["plan", "Busy @ Test Hall, Nov 28 2026"]);
  assert.equal(r.code, 5);
  assert.match(r.stderr, /Limit reached: 3 fresh runs per IP per day/);
});

test("fixture mode exits 6", async () => {
  const r = await run(["plan", "Recorded @ Test Hall, Nov 28 2026"]);
  assert.equal(r.code, 6);
  assert.match(r.stderr, /fixture mode/);
});

test("rank-partners prints call order and the declared-not-scored list", async () => {
  const r = await run(["rank-partners", "Synthetic Band @ Test Hall", "Partner Two", "Unknown Spot"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(lastRequest().body), {
    event: "Synthetic Band @ Test Hall",
    partners: ["Partner Two", "Unknown Spot"],
  });
  assert.match(r.stdout, /1\. Partner Two \[Q11\]/);
  assert.match(r.stdout, /Declared, not scored/);
  assert.match(r.stdout, /- Unknown Spot/);
  assert.match(r.stdout, /Reason: 1 partner is not in the catalog/);
});

test("arguments containing an email address are refused before any request", async () => {
  const count = seen.length;
  const r = await run(["rank-partners", "Synthetic Band @ Test Hall", "Partner Two", "owner@example.com"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /email address/);
  assert.equal(seen.length, count);
});

test("options a command does not use are refused, not silently dropped", async () => {
  const count = seen.length;
  const pick = await run(["rank-partners", "Synthetic Band @ Test Hall", "Partner Two", "--pick", "Partner Two=AAA-111"]);
  assert.equal(pick.code, 2);
  assert.match(pick.stderr, /--pick cannot be used with "rank-partners"/);
  const days = await run(["sheet", "plan_abc123", "--street-days", "thu"]);
  assert.equal(days.code, 2);
  assert.match(days.stderr, /--street-days cannot be used with "sheet"/);
  const outOnly = await run(["sheet", "plan_abc123", "--out", "x.pdf"]);
  assert.equal(outOnly.code, 2);
  assert.match(outOnly.stderr, /--out cannot be used/);
  const pdf = await run(["plan", "Synthetic Band @ Test Hall, Nov 28 2026", "--pdf"]);
  assert.equal(pdf.code, 2);
  assert.equal(seen.length, count, "no request is sent when options are refused");
});

test("needs_input from rank-partners says how to pick without --pick", async () => {
  const r = await run(["rank-partners", "Ambiguous Partner Show", "Ambiguous"]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout, /"Ambiguous" \(partner\) matches more than one entity/);
  assert.match(r.stdout, /Pick one in the web app/);
  assert.doesNotMatch(r.stdout, /--pick/);
});

test("sheet --pdf saves the PDF where asked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "walkup-cli-"));
  try {
    const target = join(dir, "sheet.pdf");
    const r = await run(["sheet", "plan_abc123", "--pdf", "--out", target]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(await readFile(target, "utf8"), /^%PDF-/);
    assert.match(r.stdout, /Saved /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sheet prints the envelope summary; --json prints it unchanged", async () => {
  const human = await run(["sheet", "plan_abc123"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Status: ok · plan plan_abc123/);
  const raw = await run(["sheet", "plan_abc123", "--json"]);
  assert.equal(raw.code, 0, raw.stderr);
  assert.equal(JSON.parse(raw.stdout).planId, "plan_abc123");
});

test("sheet rejects plan ids that are not plain tokens", async () => {
  const r = await run(["sheet", "../../etc/passwd"]);
  assert.equal(r.code, 2);
});

test("an unknown plan id reports 404 and exits 1", async () => {
  const r = await run(["sheet", "missing"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTP 404/);
});

test("health prints the server's status", async () => {
  const r = await run(["health"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"mode": "fixture"/);
});

test("an unreachable server gives a clear message and exits 4", async () => {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(undefined)));
  const port = portOf(probe);
  await new Promise((resolve) => probe.close(resolve));
  const r = await run(["plan", "Synthetic Band @ Test Hall, Nov 28 2026"], { url: `http://127.0.0.1:${port}` });
  assert.equal(r.code, 4);
  assert.match(r.stderr, /Walkup server unreachable at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(r.stderr, /WALKUP_URL/);
});

test("a non-http WALKUP_URL is rejected", async () => {
  const r = await run(["plan", "x"], { url: "ftp://example.org" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /https:\/\/ or http:\/\//);
});

test("a server that is not Walkup is reported as such", async () => {
  const r = await run(["plan", "Synthetic Band @ Test Hall, Nov 28 2026"], { url: `${base}/html` });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not JSON/);
});
