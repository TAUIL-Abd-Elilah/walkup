/**
 * Behaviour fixed after the Oct 29 re-audit, on the fixture world with nothing on the network:
 * - a sample-mode server refuses g4-a and g4-b (real shows only) and never lists them; a recorded server lists all six;
 * - the text digest lists the sheet's numbered areas, never the map's first five squares;
 * - revise_plan on a recorded server says an unknown plan id is unknown;
 * - every method but POST gets the same JSON-RPC 405.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { StreetSheet } from "@walkup/contracts";
import { areaLabel } from "@walkup/exports/format";
import { numberedTiles } from "@walkup/orchestrator";
import { describe, expect, it } from "vitest";
import { billVsHouseOf, envelopeText, getSheetTool, handleMcpHttpRequest, planShowTool, rankPartnersTool, revisePlanTool, serverInstructions, SERVER_INSTRUCTIONS, type ToolEnvelope } from "../src/index";
import { caller, connect, services } from "./helpers";

const LIVE_ONLY = (id: string) => `${id} plans a real show only, and this copy of Walkup runs without keys.`;
const RECORDED = "Live runs are paused for judging.";

describe("g4-a and g4-b on a sample-mode server", () => {
  it("are refused with the web app's reason (503), store nothing and hand out no link", async () => {
    const s = services();
    const c = await connect(s);
    try {
      for (const [tool, args] of [
        ["get_sheet", { planId: "g4-a" }],
        ["bill_vs_house", { planId: "g4-b" }],
        ["plan_show", { presetId: "g4-a" }],
        ["plan_show", { planId: "g4-b" }],
        ["plan_show", { presetId: "g4-a", operator: { seatsLeft: 100 } }],
        ["rank_partners", { presetId: "g4-b", partnerNames: ["Bellhop Records"] }],
        ["revise_plan", { planId: "g4-a", instruction: "only Saturday" }],
      ] as const) {
        const id = "presetId" in args ? args.presetId : args.planId;
        const { result, env, text } = await c.call(tool, args);
        expect(result.isError, `${tool} ${id}`).toBe(true);
        expect(env).toMatchObject({ status: "error", mode: "fixture", reason: LIVE_ONLY(id), sheetUrl: null, results: null });
        expect(text, tool).not.toMatch(/The Truth|\/s\/g4-/);
      }
      expect(await s.store.get("g4-a")).toBeNull();
      expect(await s.store.get("g4-b")).toBeNull();
      expect((await getSheetTool(s, caller(), { planId: "g4-a" })).httpStatus).toBe(503);
      expect((await planShowTool(s, caller(), { presetId: "g4-b" })).httpStatus).toBe(503);
      expect((await rankPartnersTool(s, caller(), { presetId: "g4-a", partnerNames: ["Bellhop Records"] })).httpStatus).toBe(503);
      expect((await revisePlanTool(s, caller(), { planId: "g4-b", instruction: "only Saturday" })).httpStatus).toBe(503);
      // The sample presets still open.
      const g1 = await c.call("get_sheet", { planId: "g1-a" });
      expect(g1.result.isError).toBeFalsy();
      expect(g1.env.sheetUrl).toBe("https://walkup.example/s/g1-a");
    } finally {
      await c.close();
    }
  }, 120_000);

  it("are left out of the instructions, every tool description and the unknown-preset answer", async () => {
    const c = await connect(services());
    try {
      const instructions = c.client.getInstructions() ?? "";
      expect(instructions).toContain("a preset: g1-a, g1-b, g2, g3)");
      expect(instructions).not.toMatch(/g4-/);
      const { tools } = await c.client.listTools();
      expect(JSON.stringify(tools)).not.toMatch(/g4-|Salt Shed/);
      const unknown = await c.call("plan_show", { presetId: "g9" });
      expect(unknown.env.reason).toBe('Unknown preset "g9". Presets: g1-a, g1-b, g2, g3.');
      // The sample schemas stay strict.
      const strict = await c.client.callTool({ name: "get_sheet", arguments: { planId: "g1-a", extra: 1 } });
      expect(strict.isError).toBe(true);
    } finally {
      await c.close();
    }
  });

  it("are listed, with The Salt Shed, on a recorded server, and not refused there for want of keys", async () => {
    expect(SERVER_INSTRUCTIONS).toBe(serverInstructions(false));
    const c = await connect(services({ policy: { recorded: RECORDED } }));
    try {
      expect(c.client.getInstructions()).toContain("a preset: g1-a, g1-b, g2, g3, g4-a, g4-b)");
      const { tools } = await c.client.listTools();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
      const presetText = (name: string) => (byName[name]?.inputSchema.properties?.presetId as { description?: string } | undefined)?.description ?? "";
      for (const name of ["plan_show", "rank_partners"]) {
        expect(presetText(name), name).toMatch(/g1-a and g1-b, .*g4-a and g4-b, two bills in a second room \(live and recorded servers only: Greensky Bluegrass and The Roots at The Salt Shed, Chicago\)/);
      }
      expect(byName.plan_show?.description).toContain("presetId (g1-a, g1-b, g2, g3, g4-a, g4-b)");
      expect(byName.get_sheet?.description).toContain("a preset id: g1-a, g1-b, g2, g3, g4-a, g4-b");
      // Nothing is recorded in this store: the recorded server's own answer, never the sample-mode one.
      const g4 = await c.call("get_sheet", { planId: "g4-a" });
      expect(g4.env.reason).toBe(RECORDED);
      expect(g4.env.mode).toBe("recorded");
    } finally {
      await c.close();
    }
  });
});

describe("revise_plan on a recorded server", () => {
  it("says an unknown plan id is unknown (404), as get_sheet does", async () => {
    const s = services({ policy: { recorded: RECORDED } });
    const c = await connect(s);
    try {
      const { result, env, text } = await c.call("revise_plan", { planId: "nope-123", instruction: "Skip Bronzeville" });
      expect(result.isError).toBe(true);
      expect(env).toMatchObject({ status: "error", mode: "recorded", reason: "No plan with id nope-123.", sheetUrl: null });
      expect(text).not.toContain("was not run");
      expect((await revisePlanTool(s, caller(), { planId: "nope-123", instruction: "Skip Bronzeville" })).httpStatus).toBe(404);
      expect((await c.call("get_sheet", { planId: "nope-123" })).env.reason).toBe(env.reason);
    } finally {
      await c.close();
    }
  });
});

describe("numbered areas in the text digest", () => {
  const sheet = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/synthetic/engine/g1-a.sheet.json", import.meta.url)), "utf8")).sheet as StreetSheet;
  const env = (results: unknown): ToolEnvelope => ({ status: "ok", summary: "Done.", planId: sheet.planId, sheetUrl: null, mode: "fixture", results, resolution: [], provenance: ["Q7"], limits: [] }) as ToolEnvelope;
  const listed = (text: string): string[] => {
    const lines = text.split("\n");
    const at = lines.findIndex((l) => l.startsWith("Numbered areas on the sheet"));
    const out: string[] = [];
    for (const l of at < 0 ? [] : lines.slice(at + 1)) {
      const m = /^ {2}\d+\. (.+) \(lift \d+\.\d\d\)/.exec(l);
      if (!m) break;
      out.push(m[1] as string);
    }
    return out;
  };

  it("lists the areas the sheet numbers (3 km apart, no shared ZIP), not the map's first five squares", () => {
    const tiles = sheet.cards.liftMap.results.tiles;
    const want = numberedTiles(tiles, 5).map((t) => areaLabel(t));
    // The sample map's first five squares name one area three times: the case the list must not repeat.
    expect(new Set(tiles.slice(0, 5).map((t) => t.name)).size).toBeLessThan(5);
    expect(want.length).toBeGreaterThan(2);
    expect(new Set(want).size).toBe(want.length);
    expect(listed(envelopeText("get_sheet", env(sheet)))).toEqual(want);
    expect(listed(envelopeText("bill_vs_house", env(billVsHouseOf(sheet))))).toEqual(want);
  });

  it("says so when no square reached a lift of 1.3, with no empty list", () => {
    const low = structuredClone(sheet);
    low.cards.liftMap.results.tiles = low.cards.liftMap.results.tiles.map((t) => ({ ...t, lift: 1.1 }));
    for (const [tool, results] of [
      ["get_sheet", low],
      ["bill_vs_house", billVsHouseOf(low)],
    ] as const) {
      const text = envelopeText(tool, env(results));
      expect(text, tool).toContain("No area reached a lift of 1.3, so the sheet numbers none.");
      expect(text, tool).not.toContain("Numbered areas on the sheet");
    }
  });
});

describe("HTTP methods", () => {
  it("answers PUT, PATCH and DELETE with the same JSON-RPC 405 and Allow header as GET", async () => {
    const s = services();
    const url = "https://walkup.example/mcp";
    const get = await handleMcpHttpRequest(new Request(url, { method: "GET", headers: { accept: "text/event-stream" } }), s);
    const want = await get.json();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await handleMcpHttpRequest(new Request(url, { method, ...(method === "DELETE" ? {} : { body: "{}" }) }), s);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("POST");
      expect(await res.json(), method).toEqual(want);
    }
  });
});
