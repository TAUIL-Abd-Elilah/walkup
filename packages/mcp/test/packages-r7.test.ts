/**
 * Round 7, MCP: get_sheet and plan_show on a revision say it is one, as its page does (the earlier plan, the note,
 * what changed); a call that names no show, or a plan id with nothing behind it, says so before the recorded
 * server's paused text. Synthetic fixture sheets.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { envelopeText, planShowTool, rankPartnersTool, sheetEnvelope } from "../src/index";
import { caller, services } from "./helpers";

const fixture = (id: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/synthetic/engine/${id}.sheet.json`, import.meta.url)), "utf8")).sheet as StreetSheet;

describe("a revision read back", () => {
  it("carries the revision and its parent up top, and the text says so", () => {
    const s = structuredClone(fixture("g1-a"));
    s.planId = "rev-1";
    s.revision = {
      parentPlanId: "parent-1",
      instruction: "Within 10 km of the room",
      interpreter: "rules",
      toolCalls: [{ tool: "set_radius", input: { km: 10 }, summary: "Search radius set to 10 km" }],
      changes: [{ kind: "setting_changed", label: "Search radius", detail: "10 km (was 40 km)", ledgerRefs: ["L1"] }],
    } as unknown as NonNullable<StreetSheet["revision"]>;
    const env = sheetEnvelope(s, null);
    expect(env.parentPlanId).toBe("parent-1");
    expect(env.revision?.instruction).toBe("Within 10 km of the room");
    const text = envelopeText("get_sheet", env);
    expect(text).toContain('Revision of parent-1 ("Within 10 km of the room"), read by fixed rules:');
    expect(text).toContain("setting changed: Search radius (10 km (was 40 km))");
  });

  it("a plan that is not a revision has neither", () => {
    const env = sheetEnvelope(fixture("g1-a"), null);
    expect(env).not.toHaveProperty("revision");
    expect(env).not.toHaveProperty("parentPlanId");
  });
});

describe("input problems before the paused text", () => {
  const recorded = () => services({ policy: { recorded: "Live runs are paused for judging." } });

  it("plan_show with nothing to show asks for one", async () => {
    const out = await planShowTool(recorded(), caller(), {});
    expect(out.envelope.status).toBe("error");
    expect(out.envelope.reason ?? out.envelope.summary).toMatch(/^Give one of event, presetId, planId\./);
  });

  it("rank_partners on a plan id with nothing behind it says so", async () => {
    const out = await rankPartnersTool(recorded(), caller(), { planId: "nope", partnerNames: ["x"] });
    expect(out.envelope.status).toBe("error");
    expect(out.envelope.reason ?? out.envelope.summary).toBe("No plan with id nope.");
  });

  it("rank_partners on a preset is still refused with the paused text", async () => {
    const out = await rankPartnersTool(recorded(), caller(), { planId: "g1-a", partnerNames: ["x"] });
    expect(out.envelope.reason ?? out.envelope.summary).toBe("Live runs are paused for judging.");
  });
});
