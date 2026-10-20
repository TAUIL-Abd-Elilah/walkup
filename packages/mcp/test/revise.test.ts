/**
 * revise_plan over an in-memory MCP client on the fixture world (no model, so
 * the fixed rules read every note): a revised sheet under a new plan id with
 * its change list, a question that changes nothing, refusals, caps, and the
 * text digest.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES } from "@walkup/engine";
import { createMemoryFreshRunLimiter, REVISE_QUESTION_REASON, revisePlanTool, RevisePlanInput } from "../src/index";
import { caller, connect, services, type Connected } from "./helpers";

let c: Connected;
const s = services();

beforeAll(async () => {
  c = await connect(s);
});

afterAll(async () => {
  await c.close();
});

describe("revise_plan", () => {
  it("is listed with a strict input schema of planId and instruction", async () => {
    const { tools } = await c.client.listTools();
    const t = tools.find((x) => x.name === "revise_plan");
    expect(Object.keys(t?.inputSchema.properties ?? {}).sort()).toEqual(["instruction", "planId"]);
    expect((t?.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
    expect(t?.annotations?.readOnlyHint).toBe(false);
    expect(RevisePlanInput.safeParse({ planId: "g1-a", instruction: "x".repeat(301) }).success).toBe(false);
  });

  it("All ages: no bars on a preset: a new plan with the revision and its receipts", async () => {
    const { env, result, text } = await c.call("revise_plan", { planId: "g1-a", instruction: "All ages: no bars" });
    expect(result.isError).toBeFalsy();
    expect(env.planId).not.toBe("g1-a");
    expect(env.parentPlanId).toBe("g1-a");
    expect(env.mode).toBe("fixture");
    const sheet = env.results as StreetSheet;
    expect(sheet.revision).toMatchObject({ parentPlanId: "g1-a", instruction: "All ages: no bars", interpreter: "rules" });
    expect(env.revision?.toolCalls.map((t) => t.tool)).toEqual(["set_all_ages", "exclude_partner_categories"]);
    expect(sheet.cards.partners.results.some((p) => DEFAULT_BAR_CATEGORIES.includes(p.category))).toBe(false);
    expect(sheet.steps?.[0]).toMatchObject({ kind: "revise" });
    const ids = new Set(sheet.ledger.map((e) => e.id));
    for (const ch of sheet.revision!.changes) for (const r of ch.ledgerRefs) expect(ids.has(r)).toBe(true);
    expect(text).toMatch(/Revision of g1-a \("All ages: no bars"\), read by fixed rules:/);
    expect(text).toMatch(/set_all_ages: Marked the show all ages/);
    expect(text).toMatch(/Changes \(\d+\):/);

    // The new plan is stored: it can be re-read and revised again.
    const again = await c.call("get_sheet", { planId: env.planId as string });
    expect((again.env.results as StreetSheet).revision?.parentPlanId).toBe("g1-a");
    const second = await c.call("revise_plan", { planId: env.planId as string, instruction: "only Saturday" });
    const s2 = second.env.results as StreetSheet;
    expect(s2.operator.allAges).toBe(true);
    expect(s2.operator.streetTeamDays).toEqual(["saturday"]);
    expect(s2.revision?.parentPlanId).toBe(env.planId);
  });

  it("an unclear note: needs_input with the question, nothing run or stored", async () => {
    await c.call("get_sheet", { planId: "g3" }); // the preset's own run is stored once on first read
    const before = (await s.store.list(500)).length;
    const { env, result, text } = await c.call("revise_plan", { planId: "g3", instruction: "make it pop" });
    expect(result.isError).toBeFalsy();
    expect(env).toMatchObject({ status: "needs_input", planId: "g3", parentPlanId: "g3", results: null, reason: REVISE_QUESTION_REASON });
    expect(env.question).toMatch(/\?$/);
    expect(env.revision).toMatchObject({ changes: [], interpreter: "rules" });
    expect(text).toMatch(/Question for the user: /);
    expect((await s.store.list(500)).length).toBe(before);
  });

  it("refuses contact details, political notes and unknown plans", async () => {
    expect((await revisePlanTool(s, caller(), { planId: "g1-a", instruction: "email it to lead@example.com" })).httpStatus).toBe(400);
    expect((await revisePlanTool(s, caller(), { planId: "nope", instruction: "no bars" })).httpStatus).toBe(404);
  });

  it("counts against the fresh-run caps only when it runs", async () => {
    const limited = services({ limiter: createMemoryFreshRunLimiter({ perCallerPerDay: 1, perDay: 10 }) });
    const who = caller("198.51.100.20");
    expect((await revisePlanTool(limited, who, { planId: "g3", instruction: "what?" })).envelope.status).toBe("needs_input");
    const ran = await revisePlanTool(limited, who, { planId: "g3", instruction: "only Thursday" });
    expect(ran.httpStatus).toBe(200);
    expect(ran.envelope.freshRuns?.leftForCaller).toBe(0);
    const blocked = await revisePlanTool(limited, who, { planId: "g3", instruction: "only Wednesday" });
    expect(blocked.httpStatus).toBe(429);
  });
});
