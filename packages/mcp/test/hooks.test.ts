/**
 * Host hooks and run policy: what apps/web plugs in at /mcp (its own preset
 * sheets, its fixture-mode rule, its afterRun bookkeeping).
 */
import type { StreetSheet } from "@walkup/contracts";
import { NO_LIVE_SHOW, PRESETS, type FixtureDeps, type LivePreset, type PlanResult } from "@walkup/orchestrator";
import { WORLD_EVENT_IDS } from "@walkup/qloo-world";
import { describe, expect, it } from "vitest";
import { createMcpServices, DEFAULT_FIXTURE_REFUSAL, planShowTool, rankPartnersTool, type FreshRunLimiter, type PlanView } from "../src/index";
import { caller, connect, ORIGIN, services } from "./helpers";

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

  it("serves recorded sheets while live runs are paused: reads still work, anything that would run refuses with 503", async () => {
    const live = services();
    const made = await planShowTool(live, caller(), { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" });
    const planId = made.envelope.planId as string;
    const runs: string[] = [];
    // Whatever reason the host passes in (apps/web passes RECORDED_REASON) is what the refusals carry.
    const reason = "Recorded from live Qloo and Ticketmaster runs on Oct 21 2026. Live runs are paused for judging; these sheets are what a live run produced.";
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
        // A preset with nothing recorded is not run.
        ["plan_show", { presetId: "g1-a" }],
        ["plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" }],
        ["plan_show", { presetId: "g1-a", operator: { seatsLeft: 100 } }],
        ["rank_partners", { planId, partnerNames: ["Bellhop Records"] }],
        ["revise_plan", { planId, instruction: "only Saturday" }],
      ] as const) {
        const r = await c.call(tool, args);
        expect(r.result.isError, tool).toBe(true);
        expect(r.env).toMatchObject({ status: "error", mode: "recorded", results: null });
        // revise_plan leads with the note it did not run, then the host's reason.
        if (tool === "revise_plan") expect(r.env.reason).toBe(`Live runs are paused for judging, so your note "only Saturday" was not run. ${reason}`);
        else expect(r.env.reason).toBe(reason);
        expect(r.text).toContain("Mode: recorded (live runs are paused for judging; the recorded sheets are what live Qloo and Ticketmaster runs produced, and get_sheet reads them).");
        expect(r.text).not.toMatch(/no longer available|unavailable/i);
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
      // Served without its Google Places list: the product no longer shows it.
      expect(recSheet.control).toBeUndefined();
      expect(rec.text).toContain(
        "Mode: recorded (recorded from live Qloo and Ticketmaster runs on Oct 30 2026; live runs are paused for judging, and this sheet is what the live run produced).",
      );
      expect(rec.text).not.toMatch(/no longer available|unavailable/i);
      // The same sheet on a live server is a live sheet, still without the list.
      const asLive = await connect(services({ store: live.store }));
      try {
        const l = await asLive.call("get_sheet", { planId: "rec-live-1" });
        expect([l.env.mode, (l.env.results as StreetSheet).control]).toEqual(["live", undefined]);
      } finally {
        await asLive.close();
      }
      const preset = await c.call("get_sheet", { planId: "g3" });
      expect(preset.env).toMatchObject({ status: "error", mode: "recorded", reason });
      // Reading tools work on what is stored: plan_show by plan id and bill_vs_house, the live one as a recording.
      expect((await c.call("plan_show", { planId: "rec-live-1" })).env).toMatchObject({ planId: "rec-live-1", mode: "recorded" });
      const bvh = await c.call("bill_vs_house", { planId: "rec-live-1" });
      expect(bvh.result.isError).toBeFalsy();
      expect(bvh.env.mode).toBe("recorded");
      expect(bvh.text).toContain("Mode: recorded (read from a sheet recorded from live Qloo and Ticketmaster runs; live runs are paused for judging).");
      // A revision made while the server was live is named in the refusal, so an agent can read it.
      const revSheet: StreetSheet = {
        ...liveSheet,
        planId: "rec-rev-1",
        revision: { parentPlanId: "rec-live-1", instruction: "All ages, no bars", interpreter: "rules", toolCalls: [], changes: [] } as unknown as StreetSheet["revision"],
      };
      await live.store.put({ ...from!, planId: "rec-rev-1", mode: "live", sheet: revSheet });
      // The same note (case and spacing aside): the recorded revision is the recorded run of that note.
      const same = await c.call("revise_plan", { planId: "rec-live-1", instruction: "  all ages,  NO bars " });
      expect(same.result.isError).toBe(true);
      expect(same.env.mode).toBe("recorded");
      expect(same.env.reason).toBe(
        `Live runs are paused for judging, so your note "all ages, NO bars" was not run. This plan has a recorded run of that same note (plan rec-rev-1, ${ORIGIN}/s/rec-rev-1), readable with get_sheet. ${reason}`,
      );
      expect(same.env.summary).toBe(same.env.reason);
      expect(same.env.reason).not.toMatch(/different note/);
      // A different note: the refusal says plainly that the recorded revision was made for another note.
      const other = await c.call("revise_plan", { planId: "rec-live-1", instruction: "Skip Germantown" });
      expect(other.result.isError).toBe(true);
      expect(other.env.reason).toBe(
        `Live runs are paused for judging, so your note "Skip Germantown" was not run. This plan has a recorded revision for a different note: "All ages, no bars" (plan rec-rev-1, ${ORIGIN}/s/rec-rev-1), readable with get_sheet. That is not your note. ${reason}`,
      );
      expect(other.text).toContain('your note "Skip Germantown" was not run');
      expect(other.text).toContain('a different note: "All ages, no bars"');
      // A second recorded revision for the asked note: the same-note one is named first, the other as a different note.
      await live.store.put({
        ...from!,
        planId: "rec-rev-2",
        mode: "live",
        sheet: { ...revSheet, planId: "rec-rev-2", revision: { ...revSheet.revision!, instruction: "Skip Germantown" } },
      });
      const both = await c.call("revise_plan", { planId: "rec-live-1", instruction: "skip germantown" });
      expect(both.env.reason).toContain("This plan has a recorded run of that same note (plan rec-rev-2");
      expect(both.env.reason).toContain('It also has a recorded revision for a different note: "All ages, no bars" (plan rec-rev-1');
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

describe("a live server and a preset with no live show yet", () => {
  // g2 and g3 have no live show (g1-a and g1-b carry the hero bills).
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

    const whatIf = await planShowTool(s, caller(), { presetId: "g2", operator: { seatsLeft: 300 } });
    expect(whatIf.httpStatus).toBe(404);
    expect(whatIf.envelope.reason).toBe(NO_LIVE_SHOW);
    const ranked = await rankPartnersTool(s, caller(), { presetId: "g3", partnerNames: ["A partner by name"] });
    expect(ranked.httpStatus).toBe(404);
    expect(ranked.envelope.reason).toBe(NO_LIVE_SHOW);
    const plain = await planShowTool(s, caller(), { presetId: "g2" });
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
