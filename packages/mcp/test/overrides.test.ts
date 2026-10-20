/**
 * Runs that change a preset (what-ifs, a partner list) and picks sent up front:
 * a caller's changes never become the preset's shared sheet, the quota guard
 * never answers with a sheet that ignores them, and a pick must be one of the
 * candidates the caller was shown.
 */
import type { DeclaredPartnerScore, StreetSheet } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryFreshRunLimiter, planShowTool, rankPartnersTool } from "../src/index";
import { caller, services } from "./helpers";

const SHOW = "Hollis Creek String Band @ The Truth, Nov 20 2026";

describe("preset runs with the caller's changes", () => {
  it("are stored under their own id, never as the preset's latest sheet", async () => {
    const s = services({ limiter: createMemoryFreshRunLimiter({ perCallerPerDay: 10, perDay: 10 }) });
    await planShowTool(s, caller(), { presetId: "g1-a" });
    const whatIf = await planShowTool(s, caller(), { presetId: "g1-a", operator: { seatsLeft: 7 } });
    const ranked = await rankPartnersTool(s, caller(), { presetId: "g1-a", partnerNames: ["Bellhop Records"] });
    expect((whatIf.envelope.results as StreetSheet).operator.seatsLeft).toBe(7);
    expect((ranked.envelope.results as DeclaredPartnerScore[]).map((d) => d.declared.label)).toEqual(["Bellhop Records"]);
    for (const id of [whatIf.envelope.planId, ranked.envelope.planId]) {
      const stored = await s.store.get(id as string);
      expect(stored?.status).toBe("complete");
      expect(stored?.presetId).toBeUndefined();
    }
    const latest = await s.store.latestForPreset("g1-a");
    expect(latest?.planId).toBe("g1-a");
    expect(latest?.sheet?.operator.seatsLeft).toBeNull();

    // Ranking against a preset answered with a pick keeps that pick and stays out of the preset's slot too.
    const paused = await planShowTool(s, caller(), { presetId: "g2" });
    const person = paused.envelope.pending?.[0]?.candidates.find((x) => x.subtype === "urn:entity:person");
    const answered = await planShowTool(s, caller(), { planId: "g2", picks: [{ input: "Sidecar", entityId: person!.entityId }] });
    const onAnswered = await rankPartnersTool(s, caller(), { planId: answered.envelope.planId as string, partnerNames: ["Mercury Line Cuts"] });
    expect(onAnswered.envelope.status).not.toBe("error");
    expect((onAnswered.envelope.results as DeclaredPartnerScore[]).map((d) => d.declared.label)).toEqual(["Mercury Line Cuts"]);
    const rankedSheet = (await s.store.get(onAnswered.envelope.planId as string))?.sheet;
    expect(rankedSheet?.cards.resolution.results.find((r) => r.input === "Sidecar")?.entity?.entityId).toBe(person!.entityId);
    expect(rankedSheet?.operator.seatsLeft).toBe((answered.envelope.results as StreetSheet).operator.seatsLeft);
    expect((await s.store.get(onAnswered.envelope.planId as string))?.presetId).toBeUndefined();
    expect((await s.store.latestForPreset("g2"))?.planId).toBe(answered.envelope.planId);
    // Six full fixture runs in one test: give it room when the whole suite runs in parallel.
  }, 120_000);

  it("rank the caller's own names while the quota guard is on (no stored preset sheet in their place)", async () => {
    const s = services({ limiter: createMemoryFreshRunLimiter({ perCallerPerDay: 10, perDay: 10 }) });
    await planShowTool(s, caller(), { presetId: "g1-a" });
    const qloo = s.deps.qloo as unknown as { guardTripped: () => boolean };
    qloo.guardTripped = () => true;
    const ranked = await rankPartnersTool(s, caller(), { presetId: "g1-a", partnerNames: ["Quarter Note Books"] });
    expect(ranked.envelope.planId).not.toBe("g1-a");
    expect((ranked.envelope.results as DeclaredPartnerScore[]).map((d) => d.declared.label)).toEqual(["Quarter Note Books"]);
    const whatIf = await planShowTool(s, caller(), { presetId: "g1-a", operator: { seatsLeft: 3 } });
    expect(whatIf.envelope.planId).not.toBe("g1-a");
    expect((whatIf.envelope.results as StreetSheet).operator.seatsLeft).toBe(3);
  }, 120_000);
});

describe("picks sent up front", () => {
  it("must be one of the preset's own candidates (never any entity id)", async () => {
    const s = services({ limiter: createMemoryFreshRunLimiter({ perCallerPerDay: 10, perDay: 10 }) });
    const g1a = (await planShowTool(s, caller(), { presetId: "g1-a" })).envelope.results as StreetSheet;
    const aPlace = g1a.cards.partners.results[0]!.entity.entityId;
    const bogus = await planShowTool(s, caller(), { presetId: "g2", operator: { seatsLeft: 10 }, picks: [{ input: "Sidecar", entityId: aPlace }] });
    expect(bogus.httpStatus).toBe(400);
    expect(bogus.envelope.reason).toMatch(/Pick one of the candidates shown for "Sidecar"/);
    const rankBogus = await rankPartnersTool(s, caller(), { presetId: "g2", partnerNames: ["Mercury Line Cuts"], picks: [{ input: "Sidecar", entityId: aPlace }] });
    expect(rankBogus.httpStatus).toBe(400);
    const nothingWaits = await planShowTool(s, caller(), { presetId: "g1-a", operator: { seatsLeft: 10 }, picks: [{ input: "Hollis Creek String Band", entityId: aPlace }] });
    expect(nothingWaits.envelope.reason).toMatch(/Nothing on g1-a waits for a pick/);

    const paused = await planShowTool(s, caller(), { presetId: "g2" });
    const person = paused.envelope.pending?.[0]?.candidates.find((x) => x.subtype === "urn:entity:person");
    const good = await planShowTool(s, caller(), { presetId: "g2", operator: { seatsLeft: 10 }, picks: [{ input: "sidecar", entityId: person!.entityId }] });
    expect(good.envelope.status).not.toBe("error");
    const row = (good.envelope.results as StreetSheet).cards.resolution.results.find((r) => r.input === "Sidecar");
    expect(row?.entity?.entityId).toBe(person!.entityId);
  }, 120_000);

  it("with event text, only the event pick is taken; act picks answer a pause by plan id", async () => {
    const s = services();
    const r = await planShowTool(s, caller("198.51.100.77"), { event: SHOW, picks: [{ input: "Hollis Creek String Band", entityId: "0000abcd-0000" }] });
    expect(r.httpStatus).toBe(400);
    expect(r.envelope.reason).toMatch(/Nothing waits for a pick named "Hollis Creek String Band"/);
    expect(r.envelope.freshRuns).toBeUndefined();
    const rank = await rankPartnersTool(s, caller("198.51.100.77"), { event: SHOW, partnerNames: ["Bellhop Records"], picks: [{ input: "Hollis Creek String Band", entityId: "0000abcd-0000" }] });
    expect(rank.httpStatus).toBe(400);
    const made = await planShowTool(s, caller("198.51.100.78"), { event: SHOW });
    expect(made.envelope.status).not.toBe("error");
    const completePlan = await rankPartnersTool(s, caller("198.51.100.77"), { planId: made.envelope.planId as string, partnerNames: ["Bellhop Records"], picks: [{ input: "x", entityId: "y" }] });
    expect(completePlan.httpStatus).toBe(400);
    expect(completePlan.envelope.reason).toMatch(/is complete: nothing waits for a pick/);
    // None of the refusals used a fresh run.
    expect((await s.limiter.check("198.51.100.77", s.now())).leftForCaller).toBe(3);
  }, 120_000);
});
