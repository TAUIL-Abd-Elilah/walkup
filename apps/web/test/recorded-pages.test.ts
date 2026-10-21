/**
 * Recorded mode (live runs paused) through the web app's own front doors: the
 * landing page rendered to static HTML, GET /api/sheet/<id> and the /mcp route.
 * Live runs are recorded first by the live-mode harness (the fixture world
 * standing in for the live transports, memory plan store, temp data dir).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { createFixtureDeps } from "@walkup/orchestrator";
import { createWorld } from "@walkup/qloo-world";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
// The maps load MapLibre; the page is checked without them.
vi.mock("../components/LiftMap", () => ({
  LiftMap: () => createElement("figure", { "data-testid": "map" }),
  MapCaption: ({ source }: { source?: ReactNode }) => createElement("p", { "data-testid": "map-source" }, source),
}));
vi.mock("../components/LiftLegend", () => ({ LiftLegend: () => null }));
vi.mock("../components/TileList", () => ({ TileList: () => null }));

const { default: Home } = await import("../app/page");
const { GET: getSheet } = await import("../app/api/sheet/[planId]/route");
const { POST: mcpPost } = await import("../app/mcp/route");
const { RECORDED_REASON } = await import("../lib/api");
const { runtimeMode } = await import("../lib/mode");
const { resetEngineForTests, setEngineForTests, stores } = await import("../lib/server/engine");
const { resetKeyStatusMemo } = await import("../lib/server/key-status");
const { FreshRunLimiter, setFreshRunsForTests } = await import("../lib/server/limits");
const { resetRunsForTests } = await import("../lib/server/runs");
const { startPlan } = await import("../lib/server/service");
const { restoreLiveShows, useWorldLiveShows } = await import("./live-presets");

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "WALKUP_MODE", "WALKUP_QLOO_UNTIL", "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"];
const saved: Record<string, string | undefined> = {};
let dir = "";
const ORIGIN = "https://walkup.example";
const recordedIds: Record<string, string> = {};

const ctx = (ip: string) => ({ ip, sessionId: "test-session-0000009", origin: ORIGIN });

async function landing(): Promise<string> {
  return renderToStaticMarkup(await Home());
}

/** Visible text with tags dropped and entities the page uses decoded. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function sheetsSection(html: string): string {
  return text(/<section id="sheets"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "");
}

/** Records a preset as a live run, as on the host before the key goes. */
async function record(id: string, ip: string): Promise<void> {
  const r = await startPlan({ presetId: id }, ctx(ip));
  const body = r.body as { mode?: string; planId?: string };
  expect(body.mode, id).toBe("live");
  recordedIds[id] = String(body.planId);
}

type RpcResult = { result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] } };

async function mcpCall(name: string, args: Record<string, unknown>): Promise<RpcResult["result"]> {
  const res = await mcpPost(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as RpcResult).result;
}

beforeAll(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "hl-web-recorded-"));
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  resetEngineForTests();
  resetRunsForTests();
  resetKeyStatusMemo();
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

describe("recorded mode before any live run was recorded", () => {
  afterEach(() => {
    delete process.env.WALKUP_MODE;
  });

  it("calls the sheets samples on the landing page, not recordings", async () => {
    process.env.WALKUP_MODE = "recorded";
    expect(runtimeMode().kind).toBe("recorded");
    const html = await landing();
    const sheets = sheetsSection(html);
    expect(sheets).toContain("Sample sheets");
    expect(sheets).toContain("No live run was recorded on this server, so these are sample sheets with made-up places and numbers.");
    expect(sheets).not.toMatch(/Recorded sheets|were recorded from live runs/);
    expect(sheets.match(/· sample ·/g)?.length).toBe(4);
    expect(text(html)).toContain("Data: made-up sample data in Qloo's format.");
    expect(html).not.toContain("recorded on live runs");
  });
});

describe("live runs recorded, then Qloo goes away", () => {
  beforeAll(() => {
    process.env.QLOO_API_KEY = "test-not-a-key";
    process.env.TICKETMASTER_API_KEY = "test-not-a-key";
    const st = stores();
    // The deps say live, so these runs are stored as live runs.
    setEngineForTests({ live: { ...createFixtureDeps({ world: createWorld(), store: st.plans, choices: st.choices }), mode: "live" } });
    useWorldLiveShows();
  });

  afterAll(() => {
    delete process.env.WALKUP_MODE;
    setEngineForTests({ live: null });
    restoreLiveShows();
  });

  it("in live mode pairs two sheets in the worked example only when both are live runs", async () => {
    expect(runtimeMode().kind).toBe("live");
    await record("g1-a", "198.51.100.181");
    // g1-a is a live run, g1-b still its sample sheet: no worked example setting real numbers against made-up ones.
    const mixed = await landing();
    expect(mixed).not.toContain('data-testid="hero-comparison"');
    await record("g1-b", "198.51.100.182");
    const both = await landing();
    expect(both).toContain('data-testid="hero-comparison"');
    expect(text(both)).toContain("Data: Qloo.");
  });

  it("lists the recordings on the landing page, with the samples among them said as such", async () => {
    process.env.WALKUP_MODE = "recorded";
    expect(runtimeMode().kind).toBe("recorded");
    const html = await landing();
    const sheets = sheetsSection(html);
    expect(sheets).toContain("Recorded sheets");
    expect(sheets).toContain(
      "Live runs are paused for judging. The sheets not marked sample were recorded from live Qloo and Ticketmaster runs on the dates shown; they are what a live run produced. A sheet marked sample uses made-up places and numbers.",
    );
    expect(sheets.match(/· recorded /g)?.length).toBe(2);
    expect(sheets.match(/· sample ·/g)?.length).toBe(2);
    // The search is gone: nothing new runs.
    expect(html).not.toContain("Plan a show");
    // Both hero bills are recordings.
    expect(html).toContain('data-testid="hero-comparison"');
    expect(text(html)).toContain("Data: Qloo, recorded on live runs.");
    expect(text(html)).not.toMatch(/made-up sample data in Qloo's format/);
  });

  it("serves a recording at GET /api/sheet/<id> with mode recorded and without its Google Places list", async () => {
    process.env.WALKUP_MODE = "recorded";
    // A recording made before Oct 20 2026 kept its Google Places list (arm F).
    const stored = await stores().plans.get(recordedIds["g1-a"]!);
    const control = { arm: "F" as const, places: [], overlapWithQloo: [], ledgerRefs: [] };
    await stores().plans.put({ ...stored!, sheet: { ...stored!.sheet!, control } });
    const res = await getSheet(new Request(`${ORIGIN}/api/sheet/g1-a`), { params: Promise.resolve({ planId: "g1-a" }) });
    expect(res.status).toBe(200);
    const env = (await res.json()) as { planId: string; mode: string; results: StreetSheet };
    expect([env.planId, env.mode, env.results.mode]).toEqual([recordedIds["g1-a"], "recorded", "live"]);
    expect(env.results.control).toBeUndefined();
    // A preset with no recording is its sample sheet, said as one.
    const g3 = (await (await getSheet(new Request(`${ORIGIN}/api/sheet/g3`), { params: Promise.resolve({ planId: "g3" }) })).json()) as { mode: string };
    expect(g3.mode).toBe("fixture");
  });

  it("answers get_sheet and plan_show over /mcp with the recording, and refuses a new run with mode recorded", async () => {
    process.env.WALKUP_MODE = "recorded";
    const sheet = await mcpCall("get_sheet", { planId: "g1-a" });
    expect(sheet?.isError).toBeFalsy();
    expect(sheet?.structuredContent).toMatchObject({ planId: recordedIds["g1-a"], mode: "recorded" });
    expect((sheet?.structuredContent?.results as StreetSheet).control).toBeUndefined();
    expect(sheet?.content.map((c) => c.text ?? "").join("\n")).toMatch(/Mode: recorded \(recorded from live Qloo and Ticketmaster runs on \w{3} \d{1,2} \d{4}; live runs are paused for judging/);
    const before = (await stores().plans.list(1000)).length;
    const plan = await mcpCall("plan_show", { presetId: "g1-a" });
    expect(plan?.isError).toBeFalsy();
    expect(plan?.structuredContent).toMatchObject({ planId: recordedIds["g1-a"], mode: "recorded" });
    const fresh = await mcpCall("plan_show", { presetId: "g1-a", operator: { seatsLeft: 100 } });
    expect(fresh?.isError).toBe(true);
    expect(fresh?.structuredContent).toMatchObject({ status: "error", mode: "recorded", reason: RECORDED_REASON, results: null });
    expect((await stores().plans.list(1000)).length).toBe(before);
  });
});
