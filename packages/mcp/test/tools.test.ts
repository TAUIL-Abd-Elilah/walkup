/**
 * The four tools through a real MCP client (in-memory transport) on the
 * fixture world: envelopes, needs_input and resume, refusals, strict inputs.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DeclaredPartnerScore, StreetSheet } from "@walkup/contracts";
import type { FixtureDeps } from "@walkup/orchestrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EnvelopeOutput, sheetEnvelope, type BillVsHouse, type McpServices, type ToolEnvelope } from "../src/index";
import { caller, connect, ORIGIN, services, type Connected } from "./helpers";

const ENVELOPE_KEYS = ["status", "summary", "planId", "sheetUrl", "mode", "results", "resolution", "provenance", "limits"];

function expectEnvelope(env: ToolEnvelope): void {
  expect(() => EnvelopeOutput.parse(env)).not.toThrow();
  for (const k of ENVELOPE_KEYS) expect(env).toHaveProperty(k);
  expect(env.mode).toBe("fixture");
  expect(env.limits.length).toBeGreaterThan(0);
  expect(env.limits.some((l) => l.startsWith("Sample data"))).toBe(true);
}

function sheet(env: ToolEnvelope): StreetSheet {
  return env.results as StreetSheet;
}

let s: McpServices;
let c: Connected;

beforeAll(async () => {
  s = services();
  c = await connect(s);
});
afterAll(async () => {
  await c.close();
});

describe("tools/list", () => {
  it("lists the five tools with strict input schemas and the envelope output schema", async () => {
    const { tools } = await c.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["bill_vs_house", "get_sheet", "plan_show", "rank_partners", "revise_plan"]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
      expect(t.outputSchema?.properties).toHaveProperty("status");
      expect(t.outputSchema?.properties).toHaveProperty("provenance");
      expect(t.description?.length ?? 0).toBeGreaterThan(80);
    }
    const plan = tools.find((t) => t.name === "plan_show");
    expect(Object.keys(plan?.inputSchema.properties ?? {}).sort()).toEqual(["event", "operator", "picks", "planId", "presetId"]);
    expect(tools.find((t) => t.name === "get_sheet")?.annotations?.readOnlyHint).toBe(true);
  });

  it("promises no partner count: plan_show ranks real local partner places where the bill's crowd stands out", async () => {
    const { tools } = await c.client.listTools();
    const plan = tools.find((t) => t.name === "plan_show")?.description ?? "";
    expect(plan).toMatch(/real local partner places ranked in the areas where that crowd stands out/);
    for (const t of tools) expect(t.description ?? "", t.name).not.toMatch(/\b15\s*(-|–|to)\s*25\b|\b15\b/);
  });

  it("describes recorded mode as live runs paused for judging, never as Qloo gone", () => {
    const text = c.client.getInstructions() ?? "";
    expect(text).toMatch(/recorded from live Qloo and Ticketmaster runs, and live runs are paused for judging/);
    expect(text).toMatch(/what a live run produced/);
    expect(text).not.toMatch(/no longer available|unavailable|are off\b/i);
  });

  it("gives agents instructions about receipts, needs_input and limits", () => {
    const text = c.client.getInstructions() ?? "";
    expect(text).toMatch(/needs_input/);
    expect(text).toMatch(/never pick for them/i);
    expect(text).toMatch(/suggested, not affiliated/i);
  });
});

describe("plan_show", () => {
  it("serves a preset as the web app's envelope, with a short text digest", async () => {
    const { result, env, text } = await c.call("plan_show", { presetId: "g1-a" });
    expect(result.isError).toBeFalsy();
    expectEnvelope(env);
    expect(env.planId).toBe("g1-a");
    expect(env.sheetUrl).toBe(`${ORIGIN}/s/g1-a`);
    expect(env.planUrl).toBe(`${ORIGIN}/plan/g1-a`);
    expect(env.cards?.partners).toBe(sheet(env).cards.partners.status);
    expect(["ok", "partial", "degraded"]).toContain(env.status);
    const sh = sheet(env);
    expect(sh.planId).toBe("g1-a");
    expect(sh.mode).toBe("fixture");
    expect(sh.cards.partners.results.length).toBeGreaterThanOrEqual(15);
    // Provenance is the sheet's ledger; every partner chip traces to it.
    expect(env.provenance).toEqual(sh.ledger.map((e) => e.id));
    for (const p of sh.cards.partners.results) for (const chip of p.chips) expect(env.provenance).toContain(chip.ledgerRef);
    expect(env.resolution).toEqual(sh.cards.resolution.results);
    expect(env).toEqual(sheetEnvelope(sh, ORIGIN));
    // The digest names the mode, the plan, partners with receipts, and the limits; it stays short.
    expect(text).toContain("Mode: fixture");
    expect(text).toContain("Plan id: g1-a");
    expect(text).toMatch(/suggested, not affiliated/);
    expect(text).toMatch(/\[Q\d+\]/);
    expect(text).toContain("What this does not establish:");
    expect(text.length).toBeLessThan(6000);
    expect(result.content).toHaveLength(1);
  });

  it("serves the stored preset on the next call (no new run, no cap)", async () => {
    const world = (s.deps as FixtureDeps).world;
    const before = world.stats();
    const a = await c.call("plan_show", { presetId: "g1-a" });
    const b = await c.call("get_sheet", { planId: "g1-a" });
    expect(sheet(a.env).createdAt).toBe(sheet(b.env).createdAt);
    expect(a.env.freshRuns).toBeUndefined();
    expect(world.stats()).toEqual(before);
  });

  it("matches the web app's envelope for the same sheet (keys, status, reason, links)", async () => {
    const apiPath = resolve(__dirname, "../../../apps/web/lib/api.ts");
    if (!existsSync(apiPath)) return;
    const web = (await import(pathToFileURL(apiPath).href)) as { sheetEnvelope: (sh: StreetSheet, origin: string) => Record<string, unknown> };
    for (const id of ["g1-a", "g3"]) {
      const { env } = await c.call("get_sheet", { planId: id });
      const theirs = web.sheetEnvelope(sheet(env), ORIGIN);
      expect(Object.keys(env).sort()).toEqual(Object.keys(theirs).sort());
      for (const k of Object.keys(theirs)) {
        if (k === "results") continue;
        expect(env[k as keyof ToolEnvelope], k).toEqual(theirs[k]);
      }
    }
  });

  it("produces sheets the web app's validator accepts", async () => {
    const validatePath = resolve(__dirname, "../../../apps/web/lib/validate.ts");
    if (!existsSync(validatePath)) return;
    const mod = (await import(pathToFileURL(validatePath).href)) as { validateSheet: (x: unknown) => string[] };
    const { env } = await c.call("get_sheet", { planId: "g1-a" });
    expect(mod.validateSheet(env.results)).toEqual([]);
  });

  it("pauses on an ambiguous name, refuses picks outside the candidates, and resumes with a shown candidate", async () => {
    const first = await c.call("plan_show", { presetId: "g2" });
    expectEnvelope(first.env);
    expect(first.result.isError).toBeFalsy();
    expect(first.env.status).toBe("needs_input");
    expect(first.env.planId).toBe("g2");
    expect(first.env.results).toBeNull();
    expect(first.env.pending?.[0]?.input).toBe("Sidecar");
    expect(first.env.planUrl).toBe(`${ORIGIN}/plan/g2`);
    const row = first.env.resolution.find((r) => r.status === "needs_input");
    expect(row?.input).toBe("Sidecar");
    expect(row?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(first.text).toContain("Needs a pick");
    expect(first.text).toContain("Never pick for them");

    const bad = await c.call("plan_show", { planId: "g2", picks: [{ input: "Sidecar", entityId: "0000ffff-not-a-candidate" }] });
    expect(bad.result.isError).toBe(true);
    expect(bad.env.status).toBe("error");
    expect(bad.env.reason).toMatch(/candidates shown/);
    const wrongName = await c.call("plan_show", { planId: "g2", picks: [{ input: "Dorian", entityId: row!.candidates![0]!.entityId }] });
    expect(wrongName.env.reason).toMatch(/Nothing waits for a pick named "Dorian"/);

    const comedian = row!.candidates!.find((x) => x.subtype === "urn:entity:person")!;
    const resumed = await c.call("plan_show", { planId: "g2", picks: [{ input: "Sidecar", entityId: comedian.entityId }] });
    expectEnvelope(resumed.env);
    expect(resumed.result.isError).toBeFalsy();
    expect(resumed.env.status).not.toBe("needs_input");
    expect(resumed.env.planId).toMatch(/^g2-[0-9a-f]{12}$/);
    expect(sheet(resumed.env).cards.resolution.results.find((r) => r.input === "Sidecar")?.entity?.entityId).toBe(comedian.entityId);
    expect(resumed.env.freshRuns).toBeUndefined();

    // The same answer again is the same stored plan; the preset itself stays paused for the next caller.
    const again = await c.call("plan_show", { presetId: "g2", picks: [{ input: "sidecar", entityId: comedian.entityId }] });
    expect(again.env.planId).toBe(resumed.env.planId);
    expect(sheet(again.env).createdAt).toBe(sheet(resumed.env).createdAt);
    const preset = await c.call("get_sheet", { planId: "g2" });
    expect(preset.env.status).toBe("needs_input");
  });

  it("refuses an unknown preset with an error envelope", async () => {
    const { result, env, text } = await c.call("plan_show", { presetId: "g9" });
    expect(result.isError).toBe(true);
    expectEnvelope(env);
    expect(env.status).toBe("error");
    expect(env.results).toBeNull();
    expect(env.reason).toMatch(/Unknown preset "g9"\. Presets: g1-a, g1-b, g2, g3/);
    expect(text).toContain("Unknown preset");
  });

  it("asks for exactly one source", async () => {
    const none = await c.call("plan_show", {});
    expect(none.result.isError).toBe(true);
    expect(none.env.reason).toMatch(/Give one of event, presetId, planId/);
    const two = await c.call("plan_show", { presetId: "g1-a", event: "Hollis Creek String Band @ The Truth, Nov 20 2026" });
    expect(two.env.reason).toMatch(/exactly one of/);
    const op = await c.call("plan_show", { planId: "g1-a", operator: { seatsLeft: 10 } });
    expect(op.env.reason).toMatch(/start a new plan/);
  });

  it("rejects unknown keys and wrong types before anything runs (strict schemas)", async () => {
    const extra = await c.call("plan_show", { presetId: "g1-a", apiKey: "x" });
    expect(extra.result.isError).toBe(true);
    expect(extra.result.structuredContent).toBeUndefined();
    expect(extra.text).toMatch(/Input validation error/);
    const nested = await c.call("plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026", operator: { seatsLeft: 10, buyers: ["a"] } });
    expect(nested.text).toMatch(/Input validation error/);
    const days = await c.call("plan_show", { presetId: "g1-a", operator: { streetTeamDays: ["someday"] } });
    expect(days.text).toMatch(/Input validation error/);
    const tooMany = await c.call("rank_partners", { planId: "g1-a", partnerNames: Array.from({ length: 21 }, (_, i) => `Partner ${i}`) });
    expect(tooMany.text).toMatch(/Input validation error/);
    const badId = await c.call("get_sheet", { planId: "../etc/passwd" });
    expect(badId.text).toMatch(/Input validation error/);
  });

  it("plans a show typed as \"Artist @ Venue, Date\" as a fresh run", async () => {
    const { env, text } = await c.call("plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026", operator: { streetTeamDays: ["thursday"] } });
    expectEnvelope(env);
    expect(env.status).not.toBe("error");
    expect(env.planId).toMatch(/^plan-\d+$/);
    expect(sheet(env).bill.tmEventId).toBe("syn-tm-ev-truth-1120-hollis");
    expect(sheet(env).operator.streetTeamDays).toEqual(["thursday"]);
    expect(env.freshRuns).toEqual({ leftForCaller: 2, leftToday: 14 });
    expect(text).toContain("Fresh runs left today: 2 for you");
    const reread = await c.call("get_sheet", { planId: env.planId as string });
    expect(reread.env.planId).toBe(env.planId);
  });

  it("asks which event when several match, and runs the one the user picks", async () => {
    const other = await connect(s, caller("198.51.100.20"));
    try {
      const first = await other.call("plan_show", { event: "Wren & Wolfe @ The Truth" });
      expectEnvelope(first.env);
      expect(first.env.status).toBe("needs_input");
      expect(first.env.planId).toBeNull();
      const row = first.env.resolution[0];
      expect(row?.candidates?.map((x) => x.entityId)).toEqual(["syn-tm-ev-truth-1102-wren", "syn-tm-ev-truth-1103-wren", "syn-tm-ev-truth-0108-wren"]);
      expect(row?.candidates?.every((x) => x.subtype === "urn:ticketmaster:event")).toBe(true);
      expect(first.env.provenance).toEqual(["T1"]);
      // Looking up the event takes no fresh run.
      expect(first.env.freshRuns).toBeUndefined();
      const picked = await other.call("plan_show", { event: "Wren & Wolfe @ The Truth", picks: [{ input: "Wren & Wolfe @ The Truth", entityId: "syn-tm-ev-truth-1103-wren" }] });
      expect(picked.env.status).not.toBe("error");
      expect(sheet(picked.env).bill.date).toBe("2026-11-03");
      expect(picked.env.freshRuns?.leftForCaller).toBe(2);
    } finally {
      await other.close();
    }
  });

  it("plans from a Ticketmaster-style event link and refuses other links and unknown events", async () => {
    const other = await connect(s, caller("198.51.100.21"));
    try {
      const ok = await other.call("plan_show", { event: "https://tickets.example/event/syn-tm-ev-truth-1205-neon" });
      expect(ok.env.status).not.toBe("error");
      expect(sheet(ok.env).bill.tmEventId).toBe("syn-tm-ev-truth-1205-neon");
      const foreign = await other.call("plan_show", { event: "https://tickets.other.example/event/abc123" });
      expect(foreign.result.isError).toBe(true);
      expect(foreign.env.reason).toMatch(/Only Ticketmaster event links/);
      const missing = await other.call("plan_show", { event: "https://www.ticketmaster.com/some-show-nashville-tennessee-11-20-2026/event/0D0061DEADBEEF" });
      expect(missing.result.isError).toBe(true);
      expect(missing.env.reason).toMatch(/did not return event 0D0061DEADBEEF/);
      expect(missing.env.provenance.length).toBeGreaterThan(0);
      const nothing = await other.call("plan_show", { event: "Nobody Real @ Nowhere Hall, Nov 20 2026" });
      expect(nothing.env.reason).toMatch(/No Ticketmaster event matches/);
      // Lookups that find nothing do not use up fresh runs.
      const after = await other.call("plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" });
      expect(after.env.freshRuns?.leftForCaller).toBe(1);
    } finally {
      await other.close();
    }
  });

  it("refuses emails and campaign events in what the caller typed", async () => {
    const mail = await c.call("plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026 fan@example.com" });
    expect(mail.result.isError).toBe(true);
    expect(mail.env.reason).toMatch(/email address/);
    const politics = await c.call("plan_show", { event: "Campaign rally for Senate @ The Truth, Nov 20 2026" });
    expect(politics.env.reason).toMatch(/Political candidates and campaigns/);
  });
});

describe("rank_partners", () => {
  it("ranks the user's own list against a stored plan, in call order", async () => {
    const other = await connect(s, caller("198.51.100.30"));
    try {
      const { env, text, result } = await other.call("rank_partners", {
        planId: "g1-a",
        partnerNames: ["Bellhop Records", "Tin Heron Tavern", "Riverside Spoke Bike Co.", "bellhop records"],
      });
      expect(result.isError).toBeFalsy();
      expectEnvelope(env);
      const rows = env.results as DeclaredPartnerScore[];
      expect(rows.map((r) => r.declared.label).sort()).toEqual(["Bellhop Records", "Riverside Spoke Bike Co.", "Tin Heron Tavern"]);
      const scored = rows.filter((r) => r.rank !== null);
      expect(scored.length).toBeGreaterThanOrEqual(1);
      expect(rows.find((r) => r.declared.label === "Riverside Spoke Bike Co.")?.rank).toBeNull();
      expect(scored.map((r) => r.rank)).toEqual([...scored.map((r) => r.rank)].sort((a, b) => (a as number) - (b as number)));
      for (const r of scored) for (const chip of r.chips) expect(env.provenance).toContain(chip.ledgerRef);
      expect(env.limits).toContain("Suggested, not affiliated: no partner has agreed to anything.");
      expect(env.planId).not.toBe("g1-a");
      expect(env.freshRuns?.leftForCaller).toBe(2);
      expect(text).toContain("not in Qloo's catalog, kept in your order: Riverside Spoke Bike Co.");
      // The new plan keeps the preset's bill and what-ifs, with only the typed names on its list.
      const full = await other.call("get_sheet", { planId: env.planId as string });
      expect(sheet(full.env).bill.tmEventId).toBe("syn-tm-ev-truth-1120-hollis");
      expect(sheet(full.env).operator.declaredPartners.map((d) => d.label)).toHaveLength(3);
    } finally {
      await other.close();
    }
  });

  it("refuses contact details and unknown plans", async () => {
    const mail = await c.call("rank_partners", { planId: "g1-a", partnerNames: ["Bellhop Records (owner@bellhop.example)"] });
    expect(mail.result.isError).toBe(true);
    expect(mail.env.reason).toMatch(/email address/);
    const missing = await c.call("rank_partners", { planId: "no-such-plan", partnerNames: ["Bellhop Records"] });
    expect(missing.env.reason).toMatch(/No plan with id no-such-plan/);
    const preset = await c.call("rank_partners", { presetId: "g7", partnerNames: ["Bellhop Records"] });
    expect(preset.env.reason).toMatch(/Unknown preset/);
  });

  it("pauses on the preset's ambiguous name, resumes with plan_show, or takes picks up front", async () => {
    const other = await connect(s, caller("198.51.100.31"));
    try {
      const first = await other.call("rank_partners", { presetId: "g2", partnerNames: ["Crown & Clipper Barbershop", "Southside Social Hall"] });
      expect(first.env.status).toBe("needs_input");
      expect(first.env.planId).toMatch(/^plan-\d+$/);
      const person = first.env.pending?.[0]?.candidates.find((x) => x.subtype === "urn:entity:person");
      expect(person).toBeDefined();
      // Finishing the paused run costs no second fresh run; its sheet carries the ranked list.
      const resumed = await other.call("plan_show", { planId: first.env.planId as string, picks: [{ input: "Sidecar", entityId: person!.entityId }] });
      expect(resumed.env.status).not.toBe("needs_input");
      expect(resumed.env.freshRuns).toBeUndefined();
      const declared = sheet(resumed.env).cards.declared.results.map((d) => d.declared.label);
      expect(declared.sort()).toEqual(["Crown & Clipper Barbershop", "Southside Social Hall"]);
      const upFront = await other.call("rank_partners", {
        presetId: "g2",
        partnerNames: ["Crown & Clipper Barbershop"],
        picks: [{ input: "Sidecar", entityId: person!.entityId }],
      });
      expect(upFront.env.status).not.toBe("needs_input");
      expect((upFront.env.results as DeclaredPartnerScore[])[0]?.declared.label).toBe("Crown & Clipper Barbershop");
      expect(upFront.env.freshRuns?.leftForCaller).toBe(1);
    } finally {
      await other.close();
    }
  });

  it("asks to resolve a stored paused plan first", async () => {
    const other = await connect(s, caller("198.51.100.32"));
    try {
      const paused = await other.call("rank_partners", { presetId: "g2", partnerNames: ["Mercury Line Cuts"] });
      const again = await other.call("rank_partners", { planId: paused.env.planId as string, partnerNames: ["Mercury Line Cuts"] });
      expect(again.env.status).toBe("needs_input");
      expect(again.env.reason).toMatch(/Resolve this plan first/);
    } finally {
      await other.close();
    }
  });
});

describe("bill_vs_house", () => {
  it("returns lift tiles, the baseline, compare and demographics for a plan", async () => {
    const { env, text } = await c.call("bill_vs_house", { planId: "g1-a" });
    expectEnvelope(env);
    const r = env.results as BillVsHouse;
    expect(r.planId).toBe("g1-a");
    expect(r.baseline).toBe("house");
    expect(r.tiles.length).toBeGreaterThan(0);
    expect(r.tiles[0]?.lift).toBeGreaterThan(1);
    expect(r.whatsDifferent.a.length).toBeGreaterThan(0);
    expect(Object.keys(r.cards).sort()).toEqual(["demographics", "liftMap", "whatsDifferent"]);
    expect(env.limits).toContain("Where buyers live: the areas show where this bill's fans stand out from the room's usual crowd.");
    const full = await c.call("get_sheet", { planId: "g1-a" });
    for (const ref of env.provenance) expect(full.env.provenance).toContain(ref);
    expect(text).toContain("Baseline: the room's own roster");
  });

  it("says when there is no usual crowd and no comedy-wide map to compare with (G3)", async () => {
    const { env, text } = await c.call("bill_vs_house", { planId: "g3" });
    const r = env.results as BillVsHouse;
    // No house set and no pinned genre tag: the baseline is "none", never a claimed genre tag.
    expect(r.baseline).toBe("none");
    expect(r.diagnostics.baseline).toBe("none");
    expect(text).toContain("Baseline: none");
    expect(text).not.toMatch(/genre tag \(the roster|a genre baseline/);
    expect(env.summary).toContain("compared with nothing");
    expect(env.status).toBe("degraded");
    expect(env.reason).toMatch(/no comedy-wide map to compare with/);
    expect(text).not.toMatch(/degraded: degraded/);
  });

  it("refuses unknown plans", async () => {
    const { result, env } = await c.call("bill_vs_house", { planId: "missing" });
    expect(result.isError).toBe(true);
    expect(env.reason).toBe("No plan with id missing.");
  });
});

describe("get_sheet", () => {
  it("returns a preset sheet on first read and 'no plan' for unknown ids", async () => {
    const fresh = services();
    const other = await connect(fresh);
    try {
      const g3 = await other.call("get_sheet", { planId: "g3" });
      expectEnvelope(g3.env);
      expect(g3.env.planId).toBe("g3");
      const missing = await other.call("get_sheet", { planId: "nope" });
      expect(missing.result.isError).toBe(true);
      expect(missing.env.status).toBe("error");
      expect(missing.env.planId).toBeNull();
    } finally {
      await other.close();
    }
  });
});
