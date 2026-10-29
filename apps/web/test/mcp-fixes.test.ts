/**
 * The /mcp route against the web app's own rules (no keys, memory plan store, temp data dir):
 * - sample mode refuses g4-a and g4-b as POST /api/plan does, and never lists them;
 * - PUT and PATCH get the same JSON-RPC 405 as GET;
 * - on the hosted sheets (deploy/vercel/plans.json, git-ignored: run only where the file is), the text digest lists
 *   the same numbered areas as the Street Sheet page, presets list g4-a and g4-b, and revise_plan says an unknown id
 *   is unknown.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { areaLabel, topTiles } from "@walkup/exports/format";
import type { StoredPlan } from "@walkup/orchestrator";
import { topTiles as pageTopTiles } from "../lib/sheet-utils";

const route = await import("../app/mcp/route");
const { resetEngineForTests } = await import("../lib/server/engine");
const { resetKeyStatusMemo } = await import("../lib/server/key-status");
const { FreshRunLimiter, setFreshRunsForTests } = await import("../lib/server/limits");
const { resetRunsForTests } = await import("../lib/server/runs");
const { startPlan } = await import("../lib/server/service");

const PLANS = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_QLOO_UNTIL", "WALKUP_PLAN_SEED"];
const ORIGIN = "https://walkup.example";
const saved: Record<string, string | undefined> = {};
let dir = "";

type ToolResult = { isError?: boolean; structuredContent: Record<string, unknown> & { reason?: string; sheetUrl: string | null; planId: string | null; mode: string; results: unknown }; content: { type: string; text?: string }[] };

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await route.POST(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { result: Record<string, unknown> }).result;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult & { text: string }> {
  const r = (await rpc("tools/call", { name, arguments: args })) as unknown as ToolResult;
  return { ...r, text: r.content.map((c) => c.text ?? "").join("\n") };
}

async function instructions(): Promise<string> {
  const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-fixes", version: "0" } });
  return String(r.instructions);
}

async function toolList(): Promise<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }[]> {
  return (await rpc("tools/list")).tools as never;
}

/** The numbered list under an areas heading in the text digest: [name, lift]. */
function listedAreas(text: string): [string, string][] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("Numbered areas on the sheet"));
  if (at < 0) return [];
  const out: [string, string][] = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^ {2}\d+\. (.+) \(lift (\d+\.\d\d)\)/.exec(l);
    if (!m) break;
    out.push([m[1] as string, m[2] as string]);
  }
  return out;
}

/** The areas the Street Sheet page (/s/<id>) numbers, named as the page names them (its own topTiles). */
function pageAreas(sheet: StreetSheet): [string, string][] {
  return pageTopTiles(sheet).map((t) => [t.name ?? `tile ${t.geohash}`, t.lift.toFixed(2)]);
}

/** The areas the PDF and the CSVs number: the exports' topTiles, labelled by areaLabel. */
function fileAreas(sheet: StreetSheet): [string, string][] {
  return topTiles(sheet, { maxTiles: 5 }).map((t) => [t.name ? areaLabel(t) : `tile ${t.geohash}`, t.lift.toFixed(2)]);
}

function setMode(mode: "fixture" | "recorded", seed?: string): void {
  process.env.WALKUP_MODE = mode;
  if (seed) process.env.WALKUP_PLAN_SEED = seed;
  else delete process.env.WALKUP_PLAN_SEED;
  resetEngineForTests();
  resetRunsForTests();
  resetKeyStatusMemo();
}

beforeAll(() => {
  for (const k of [...KEYS, "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"]) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "hl-mcp-fixes-"));
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  setFreshRunsForTests(new FreshRunLimiter({ file: null }));
});

afterAll(() => {
  resetEngineForTests();
  resetRunsForTests();
  resetKeyStatusMemo();
  setFreshRunsForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("/mcp in sample mode (no keys)", () => {
  beforeAll(() => setMode("fixture"));

  it("refuses g4-a and g4-b with POST /api/plan's reason and hands out no share link", async () => {
    const rest = await startPlan({ presetId: "g4-a" }, { ip: "203.0.113.70", sessionId: "test-session-0000070", origin: ORIGIN });
    expect(rest.status).toBe(503);
    const restReason = (rest.body as { reason: string }).reason;
    for (const [tool, args] of [
      ["get_sheet", { planId: "g4-a" }],
      ["bill_vs_house", { planId: "g4-a" }],
      ["plan_show", { presetId: "g4-a" }],
      ["plan_show", { planId: "g4-a" }],
      ["plan_show", { presetId: "g4-a", operator: { seatsLeft: 100 } }],
      ["rank_partners", { presetId: "g4-a", partnerNames: ["Bellhop Records"] }],
      ["revise_plan", { planId: "g4-a", instruction: "only Saturday" }],
    ] as const) {
      const r = await call(tool, args);
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.structuredContent.reason, tool).toBe(restReason);
      expect(r.structuredContent).toMatchObject({ status: "error", mode: "fixture", sheetUrl: null, results: null });
      expect(r.text, tool).not.toMatch(/The Truth|\/s\/g4-a/);
    }
    const b = await call("get_sheet", { planId: "g4-b" });
    expect(b.structuredContent.reason).toBe("g4-b plans a real show only, and this copy of Walkup runs without keys.");
    // The sample presets still open.
    const g1 = await call("get_sheet", { planId: "g1-a" });
    expect(g1.isError).toBeFalsy();
    expect(g1.structuredContent.sheetUrl).toBe(`${ORIGIN}/s/g1-a`);
  });

  it("leaves g4-a and g4-b out of the instructions, the tool descriptions and the unknown-preset answer", async () => {
    const text = await instructions();
    expect(text).toContain("a preset: g1-a, g1-b, g2, g3)");
    expect(text).not.toMatch(/g4-/);
    const tools = await toolList();
    expect(tools).toHaveLength(5);
    expect(JSON.stringify(tools)).not.toMatch(/g4-|Salt Shed/);
    const unknown = await call("plan_show", { presetId: "g9" });
    expect(unknown.structuredContent.reason).toBe('Unknown preset "g9". Presets: g1-a, g1-b, g2, g3.');
  });
});

describe("/mcp methods", () => {
  it("answers PUT and PATCH with the same JSON-RPC 405 and Allow header as GET", async () => {
    const get = await route.GET(new Request(`${ORIGIN}/mcp`, { method: "GET", headers: { accept: "text/event-stream" } }));
    const want = await get.json();
    expect(get.status).toBe(405);
    expect(want).toMatchObject({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this MCP server is stateless; send JSON-RPC with POST." } });
    for (const [method, handler] of [
      ["PUT", route.PUT],
      ["PATCH", route.PATCH],
    ] as const) {
      const res = await handler(new Request(`${ORIGIN}/mcp`, { method, headers: { "content-type": "application/json" }, body: "{}" }));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("POST");
      expect(res.headers.get("content-type"), method).toMatch(/application\/json/);
      expect(await res.json(), method).toEqual(want);
    }
  });
});

describe.skipIf(!existsSync(PLANS))("/mcp on the hosted sheets (recorded mode)", () => {
  const plans = existsSync(PLANS) ? (JSON.parse(readFileSync(PLANS, "utf8")) as StoredPlan[]).filter((p) => p.sheet) : [];
  beforeAll(() => setMode("recorded", PLANS));

  it("lists the numbered areas the Street Sheet page numbers, in get_sheet and bill_vs_house, on every hosted sheet", async () => {
    expect(plans.length).toBeGreaterThan(0);
    for (const p of plans) {
      const sheet = p.sheet as StreetSheet;
      const want = pageAreas(sheet);
      expect(fileAreas(sheet), p.planId).toEqual(want);
      for (const tool of ["get_sheet", "bill_vs_house"]) {
        const r = await call(tool, { planId: p.planId });
        expect(r.isError, `${tool} ${p.planId}`).toBeFalsy();
        const got = listedAreas(r.text);
        if (sheet.cards.liftMap.results.diagnostics.baseline !== "none" || tool === "bill_vs_house") expect(got, `${tool} ${p.planId}`).toEqual(want);
        expect(new Set(got.map(([n]) => n)).size, `${tool} ${p.planId}`).toBe(got.length);
      }
    }
  });

  it("lists g4-a and g4-b, serves their recordings and says an unknown plan id is unknown to revise_plan", async () => {
    expect(await instructions()).toContain("a preset: g1-a, g1-b, g2, g3, g4-a, g4-b)");
    const tools = await toolList();
    const plan = tools.find((t) => t.name === "plan_show");
    expect(plan?.inputSchema.properties.presetId?.description).toMatch(/g4-a and g4-b, .*The Salt Shed, Chicago/);
    expect(plan?.description).toContain("presetId (g1-a, g1-b, g2, g3, g4-a, g4-b)");
    const g4a = await call("get_sheet", { planId: "g4-a" });
    expect(g4a.isError).toBeFalsy();
    expect(g4a.structuredContent.mode).toBe("recorded");
    expect((g4a.structuredContent.results as StreetSheet).bill.venue.name).toBe("The Salt Shed");
    expect(g4a.structuredContent.sheetUrl).toBe(`${ORIGIN}/s/${g4a.structuredContent.planId}`);
    const unknown = await call("revise_plan", { planId: "nope-123", instruction: "Skip Bronzeville" });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({ status: "error", mode: "recorded", reason: "No plan with id nope-123." });
  });
});
