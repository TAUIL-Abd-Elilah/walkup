/**
 * Host hooks and run policy: what apps/web plugs in at /mcp (its own preset
 * sheets, its fixture-mode rule, its afterRun bookkeeping).
 */
import type { StreetSheet } from "@walkup/contracts";
import type { PlanResult } from "@walkup/orchestrator";
import { describe, expect, it } from "vitest";
import { createMcpServices, DEFAULT_FIXTURE_REFUSAL, planShowTool, rankPartnersTool, type FreshRunLimiter, type PlanView } from "../src/index";
import { caller, connect, services } from "./helpers";

describe("run policy", () => {
  it("can refuse free-form fixture runs (as the hosted web app does) while presets and preset what-ifs stay open and uncapped", async () => {
    const calls: string[] = [];
    const limiter: FreshRunLimiter = {
      check: () => (calls.push("check"), { allowed: false, reason: "limit reached: test", leftForCaller: 0, leftToday: 0 }),
      take: () => (calls.push("take"), { allowed: false, reason: "limit reached: test", leftForCaller: 0, leftToday: 0 }),
      refund: () => {},
    };
    const s = services({ limiter, policy: { fixtureEventRuns: false, capFixtureRuns: false } });
    const refused = await planShowTool(s, caller(), { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" });
    expect(refused.httpStatus).toBe(503);
    expect(refused.envelope.status).toBe("error");
    expect(refused.envelope.reason).toBe(DEFAULT_FIXTURE_REFUSAL);
    const rank = await rankPartnersTool(s, caller(), { event: "Hollis Creek String Band @ The Truth, Nov 20 2026", partnerNames: ["Bellhop Records"] });
    expect(rank.httpStatus).toBe(503);

    const preset = await planShowTool(s, caller(), { presetId: "g1-b" });
    expect(preset.httpStatus).toBe(200);
    const whatIf = await planShowTool(s, caller(), { presetId: "g1-b", operator: { seatsLeft: 1200, streetTeamDays: ["friday"] } });
    expect(whatIf.envelope.status).not.toBe("error");
    expect(whatIf.envelope.freshRuns).toBeUndefined();
    expect((whatIf.envelope.results as StreetSheet).operator.seatsLeft).toBe(1200);
    const ranked = await rankPartnersTool(s, caller(), { presetId: "g1-b", partnerNames: ["Bellhop Records"] });
    expect(ranked.envelope.status).not.toBe("error");
    expect(calls).toEqual([]);
  }, 120_000);

  it("serves recorded sheets only when the host says Qloo is gone: get_sheet reads, every other tool refuses with 503", async () => {
    const live = services();
    const made = await planShowTool(live, caller(), { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" });
    const planId = made.envelope.planId as string;
    const runs: string[] = [];
    const reason = "Qloo is no longer available. Recorded sheets still open.";
    const s = createMcpServices({
      deps: live.deps,
      store: live.store,
      limiter: live.limiter,
      rate: null,
      secrets: [],
      now: live.now,
      idGen: live.idGen,
      policy: { recorded: reason },
      afterRun: (r: PlanResult) => void runs.push(r.planId),
    });
    const c = await connect(s);
    try {
      for (const [tool, args] of [
        ["plan_show", { presetId: "g1-a" }],
        ["plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" }],
        ["rank_partners", { planId, partnerNames: ["Bellhop Records"] }],
        ["bill_vs_house", { planId }],
        ["revise_plan", { planId, instruction: "only Saturday" }],
      ] as const) {
        const r = await c.call(tool, args);
        expect(r.result.isError, tool).toBe(true);
        expect(r.env).toMatchObject({ status: "error", mode: "recorded", reason, results: null });
        expect(r.text).toMatch(/Mode: recorded/);
      }
      expect((await planShowTool(s, caller(), { presetId: "g1-a" })).httpStatus).toBe(503);
      // A stored sheet still reads; a preset with nothing stored is not run.
      const stored = await c.call("get_sheet", { planId });
      expect(stored.env.status).not.toBe("error");
      expect(stored.env.planId).toBe(planId);
      // That one is a sample sheet and says so; a live sheet read now is a recording, said with its date.
      expect(stored.env.mode).toBe("fixture");
      const from = await live.store.get(planId);
      const control = { arm: "F" as const, places: [], overlapWithQloo: [], ledgerRefs: [] };
      const liveSheet: StreetSheet = { ...from!.sheet!, planId: "rec-live-1", mode: "live", createdAt: "2026-10-30T15:00:00.000Z", control };
      await live.store.put({ ...from!, planId: "rec-live-1", mode: "live", sheet: liveSheet });
      const rec = await c.call("get_sheet", { planId: "rec-live-1" });
      expect(rec.result.isError).toBeFalsy();
      expect(rec.env.mode).toBe("recorded");
      const recSheet = rec.env.results as StreetSheet;
      expect(recSheet.mode).toBe("live");
      // Served without its Google Places list: Places content is kept 30 days at most.
      expect(recSheet.control).toBeUndefined();
      expect(rec.text).toContain("Mode: recorded (a live run recorded on 2026-10-30; Qloo is no longer available to this server, so it is not refreshed).");
      // The same sheet on a live server is a live sheet, list included.
      const asLive = await connect(services({ store: live.store }));
      try {
        const l = await asLive.call("get_sheet", { planId: "rec-live-1" });
        expect([l.env.mode, (l.env.results as StreetSheet).control]).toEqual(["live", control]);
      } finally {
        await asLive.close();
      }
      const preset = await c.call("get_sheet", { planId: "g3" });
      expect(preset.env).toMatchObject({ status: "error", mode: "recorded", reason });
      expect(runs).toEqual([]);
    } finally {
      await c.close();
    }
  }, 120_000);
});

describe("host hooks", () => {
  it("serves presets from the host's loader and validates picks against the host's pause", async () => {
    // A host that has its own preset sheets: g1-a comes from another run, g2 shows its pause first.
    const source = services();
    const g1a = await planShowTool(source, caller(), { presetId: "g1-a" });
    const g2 = await planShowTool(source, caller(), { presetId: "g2" });
    const hostSheet = { ...(g1a.envelope.results as StreetSheet), limits: [...(g1a.envelope.results as StreetSheet).limits, "Host preset sheet."] };
    const views: string[] = [];
    const base = services();
    const s = createMcpServices({
      deps: base.deps,
      store: base.store,
      limiter: base.limiter,
      rate: null,
      secrets: [],
      now: base.now,
      idGen: base.idGen,
      presetView: async (id, view): Promise<PlanView | null> => {
        views.push(`${id}:${view}`);
        if (id === "g1-a") return { kind: "sheet", sheet: hostSheet, presetId: id };
        if (id === "g2") {
          const pause = { resolution: { summary: g2.envelope.summary, results: g2.envelope.resolution, provenance: g2.envelope.provenance }, pending: g2.envelope.pending ?? [] };
          return { kind: "paused", planId: "g2", mode: "fixture", pause, presetId: id };
        }
        return null;
      },
    });
    const c = await connect(s);
    try {
      const sheet = await c.call("get_sheet", { planId: "g1-a" });
      expect(sheet.env.limits).toContain("Host preset sheet.");
      const page = await c.call("plan_show", { presetId: "g1-a" });
      expect(page.env.limits).toContain("Host preset sheet.");
      // g3 falls back to the built-in loader.
      const g3 = await c.call("get_sheet", { planId: "g3" });
      expect(g3.env.planId).toBe("g3");
      expect(views).toEqual(["g1-a:api", "g1-a:page", "g3:api"]);

      const paused = await c.call("plan_show", { presetId: "g2" });
      expect(paused.env.status).toBe("needs_input");
      const bad = await c.call("plan_show", { planId: "g2", picks: [{ input: "Sidecar", entityId: "0000dead-beef" }] });
      expect(bad.env.reason).toMatch(/candidates shown/);
      const person = paused.env.pending?.[0]?.candidates.find((x) => x.subtype === "urn:entity:person");
      const resumed = await c.call("plan_show", { planId: "g2", picks: [{ input: "Sidecar", entityId: person!.entityId }] });
      expect(resumed.env.status).not.toBe("needs_input");
      expect(resumed.env.planId).toMatch(/^g2-/);
      expect(await s.store.get(resumed.env.planId as string)).not.toBeNull();
    } finally {
      await c.close();
    }
  }, 120_000);

  it("calls afterRun after every orchestrator run, and a failing hook changes nothing", async () => {
    const seen: string[] = [];
    const base = services();
    const s = createMcpServices({
      deps: base.deps,
      store: base.store,
      limiter: base.limiter,
      rate: null,
      secrets: [],
      now: base.now,
      idGen: base.idGen,
      afterRun: (r: PlanResult) => {
        seen.push(`${r.planId}:${r.status}`);
        throw new Error("hook failed");
      },
    });
    const preset = await planShowTool(s, caller(), { presetId: "g3" });
    expect(preset.envelope.status).not.toBe("error");
    const fresh = await planShowTool(s, caller(), { event: "https://tickets.example/event/syn-tm-ev-truth-1205-neon" });
    expect(fresh.envelope.status).not.toBe("error");
    const again = await planShowTool(s, caller(), { presetId: "g3" });
    expect(again.envelope.planId).toBe("g3");
    expect(seen).toEqual(["g3:complete", `${fresh.envelope.planId}:complete`]);
  }, 120_000);
});
