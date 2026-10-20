/**
 * Host hooks and run policy: what apps/web plugs in at /mcp (its own preset
 * sheets, its fixture-mode rule, its afterRun bookkeeping).
 */
import type { StreetSheet } from "@walkup/contracts";
import { NO_LIVE_SHOW, PRESETS, type FixtureDeps, type LivePreset, type PlanResult } from "@walkup/orchestrator";
import { WORLD_EVENT_IDS } from "@walkup/qloo-world";
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

describe("a live server and a preset with no live show yet", () => {
  it("answers the plain reason before any Ticketmaster or Qloo call and takes no fresh run", async () => {
    const calls: string[] = [];
    const limiter: FreshRunLimiter = {
      check: () => (calls.push("check"), { allowed: true, leftForCaller: 3, leftToday: 15 }),
      take: () => (calls.push("take"), { allowed: true, leftForCaller: 2, leftToday: 14 }),
      refund: () => void calls.push("refund"),
    };
    const base = services();
    const world = (base.deps as FixtureDeps).world;
    // The fixture world stands in for the live transports, as in the web app's live-mode tests.
    const s = createMcpServices({ deps: { ...base.deps, mode: "live" }, store: base.store, limiter, rate: null, secrets: [], now: base.now, idGen: base.idGen });
    expect(s.mode).toBe("live");
    world.resetStats();

    const whatIf = await planShowTool(s, caller(), { presetId: "g1-a", operator: { seatsLeft: 300 } });
    expect(whatIf.httpStatus).toBe(404);
    expect(whatIf.envelope.reason).toBe(NO_LIVE_SHOW);
    const ranked = await rankPartnersTool(s, caller(), { presetId: "g1-b", partnerNames: ["A partner by name"] });
    expect(ranked.httpStatus).toBe(404);
    expect(ranked.envelope.reason).toBe(NO_LIVE_SHOW);
    const plain = await planShowTool(s, caller(), { presetId: "g1-a" });
    expect(plain.envelope.status).toBe("error");
    expect(plain.envelope.reason).toBe(NO_LIVE_SHOW);

    expect(calls.filter((c) => c !== "check")).toEqual([]);
    expect(world.stats()).toMatchObject({ qloo: 0, tm: 0 });
  });
});

describe("a live server and a preset whose live show changed", () => {
  it("never serves the stored run of the old event as the preset", async () => {
    // A live block for this test: fixture-world ids so the world can answer it.
    const recorded: LivePreset = {
      tmEventId: WORLD_EVENT_IDS.g3,
      tmVenueId: PRESETS.g3.venue.tmVenueId,
      asOf: PRESETS.g3.asOf,
      title: "Recorded live show",
      venue: { name: PRESETS.g3.venue.name, city: PRESETS.g3.venue.city, state: PRESETS.g3.venue.state },
      selection: PRESETS.g3.selection,
      operator: { ...PRESETS.g3.operator, declaredPartners: [] },
      line: "The recorded show's line.",
    };
    const before = PRESETS.g3.live;
    const base = services();
    const s = createMcpServices({ deps: { ...base.deps, mode: "live" }, store: base.store, limiter: base.limiter, rate: null, secrets: [], now: base.now, idGen: base.idGen });
    try {
      PRESETS.g3.live = recorded;
      const first = await planShowTool(s, caller(), { presetId: "g3" });
      expect((first.envelope.results as StreetSheet).mode).toBe("live");
      expect((await base.store.get("g3"))?.sheet?.bill.tmEventId).toBe(WORLD_EVENT_IDS.g3);
      const again = await planShowTool(s, caller(), { presetId: "g3" });
      expect((again.envelope.results as StreetSheet).createdAt).toBe((first.envelope.results as StreetSheet).createdAt);

      // Key day picks another bill: the preset plans it instead of showing the old sheet.
      PRESETS.g3.live = { ...recorded, tmEventId: WORLD_EVENT_IDS.g1b };
      const changed = await planShowTool(s, caller(), { presetId: "g3" });
      expect((changed.envelope.results as StreetSheet).bill.tmEventId).toBe(WORLD_EVENT_IDS.g1b);
    } finally {
      PRESETS.g3.live = before;
    }
  });
});
