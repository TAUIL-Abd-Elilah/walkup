/**
 * The revise loop on the fixture world: a note becomes tool calls (rules
 * without a model, a mock model otherwise), the calls become operator
 * overrides, the plan re-runs on the same deps (unchanged requests from the
 * cache), and the new sheet lists what changed with receipts in its own ledger.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { StreetSheet, TraceStep } from "@walkup/contracts";
import { ALCOHOL_TERMS, DEFAULT_BAR_CATEGORIES, LIFT_DEFAULTS } from "@walkup/engine";
import type { NarratorClient } from "@walkup/narrator";
import {
  createMemoryPlanStore,
  diffSheets,
  overridesFor,
  parentRequest,
  pausePicks,
  planShow,
  readInstruction,
  revisePlan,
  reviseSummary,
  runRevision,
  sheetAreas,
  type PlanResult,
} from "../src/index";
import { revisionClock } from "../src/revise/index";
import { CLOCK_MS, deps, runPreset, sheetOf } from "./helpers";

const parents: Record<string, StreetSheet> = {};

beforeAll(async () => {
  for (const id of ["g1-a", "g1-b", "g2", "g3"]) parents[id] = sheetOf((await runPreset(id, deps())).final);
});

function completed(r: Awaited<ReturnType<typeof revisePlan>>): PlanResult {
  if (r.status === "question") throw new Error(`question: ${r.revision.question}`);
  expect(r.result.status).toBe("complete");
  return r.result;
}

describe("summary and overrides", () => {
  it("the summary holds settings, areas and place types, never partner names or contacts", () => {
    const s = reviseSummary(parents["g2"]!);
    expect(s.settings.streetTeamDays).toEqual(parents["g2"]!.operator.streetTeamDays);
    expect(s.areas.length).toBeGreaterThan(0);
    expect(s.areas.every((a) => /^[0-9a-z]{6}$/.test(a.geohash))).toBe(true);
    expect(s.categories.map((c) => c.key)).toEqual(expect.arrayContaining(["bar", "restaurant", "barber_shop", ...DEFAULT_BAR_CATEGORIES]));
    const text = JSON.stringify(s);
    for (const p of parents["g2"]!.cards.partners.results) expect(text).not.toContain(p.entity.name);
    expect(text).not.toMatch(/@/);
    expect(sheetAreas(parents["g2"]!).every((t) => t.lift >= LIFT_DEFAULTS.minLift)).toBe(true);
  });

  it("exclusions add to the parent's; set_* replace", () => {
    const op = { ...parents["g1-a"]!.operator, excludeCategories: ["cafe"], excludeAreas: ["Bexley"] };
    expect(
      overridesFor(
        [
          { tool: "exclude_partner_categories", input: { categories: ["bar"] } },
          { tool: "exclude_areas", input: { areas: ["Mount Juliet"] } },
          { tool: "set_street_team_days", input: { days: ["saturday"] } },
          { tool: "set_radius", input: { km: 20 } },
          { tool: "set_all_ages", input: { allAges: true } },
        ],
        op,
      ),
    ).toEqual({ excludeCategories: ["cafe", "bar"], excludeAreas: ["Bexley", "Mount Juliet"], streetTeamDays: ["saturday"], radiusKm: 20, allAges: true });
  });
});

describe("parent requests", () => {
  it("a preset re-runs by its event, never in the preset's slot", () => {
    const r = parentRequest(parents["g1-a"]!, { presetId: "g1-a" })!;
    expect(r.presetId).toBeUndefined();
    expect(r.tmEventId).toBeTruthy();
    expect(r.asOf).toBeTruthy();
    expect(r.pairedPlanId).toBe("g1-b");
  });

  it("G2 keeps the pick its pause used", () => {
    const picks = pausePicks(parents["g2"]!);
    expect(Object.keys(picks)).toEqual(["Sidecar"]);
    expect(parentRequest(parents["g2"]!, { presetId: "g2" })!.resolutions).toEqual(picks);
  });

  it("a stored preset request becomes its event request; other stored requests stay as they are", () => {
    const r = parentRequest(parents["g2"]!, { stored: { presetId: "g2", planId: "x", resolutions: { Sidecar: "e1" } } })!;
    expect(r).toMatchObject({ resolutions: { Sidecar: "e1" } });
    expect(r.presetId).toBeUndefined();
    expect(r.planId).toBeUndefined();
    const plain = parentRequest(parents["g1-a"]!, { stored: { tmEventId: "abc", operator: { radiusKm: 30 }, planId: "y" } });
    expect(plain).toEqual({ tmEventId: "abc", operator: { radiusKm: 30 } });
  });
});

describe("All ages: no bars (G1-A, a 21+ bill)", { timeout: 90_000 }, () => {
  let parent: StreetSheet;
  let result: PlanResult;
  let sheet: StreetSheet;
  const streamed: TraceStep[] = [];
  const store = createMemoryPlanStore();
  const d = deps({ store });

  beforeAll(async () => {
    const p = await planShow({ presetId: "g1-a", planId: "parent-a" }, d);
    parent = sheetOf(p);
    const r = await revisePlan({ sheet: parent, request: parentRequest(parent, { presetId: "g1-a" })! }, "All ages: no bars", d, { onStep: (s) => streamed.push(s) });
    result = completed(r);
    sheet = sheetOf(result);
  });

  it("a new plan with the revision record, read by the rules", () => {
    expect(sheet.planId).not.toBe(parent.planId);
    expect(sheet.revision).toMatchObject({ parentPlanId: "parent-a", instruction: "All ages: no bars", interpreter: "rules" });
    expect(sheet.revision!.question).toBeUndefined();
    expect(sheet.revision!.toolCalls.map((c) => c.tool)).toEqual(["set_all_ages", "exclude_partner_categories"]);
    for (const c of sheet.revision!.toolCalls) expect(c.summary).toMatch(/^[A-Z][^!]*$/);
    expect(sheet.operator.allAges).toBe(true);
    expect(sheet.operator.excludeCategories).toEqual(expect.arrayContaining(["bar", "pub", "night_club"]));
  });

  it("no bar partners and no bar spots; Ticketmaster's 21+ is untouched", () => {
    expect(sheet.bill.legalAgeEnforced).toBe(true);
    expect(sheet.cards.partners.results.some((p) => DEFAULT_BAR_CATEGORIES.includes(p.category))).toBe(false);
    expect(sheet.cards.prePost.results.some((s) => s.category && DEFAULT_BAR_CATEGORIES.includes(s.category))).toBe(false);
    expect(sheet.cards.prePost.results.length).toBeGreaterThan(0);
    expect(sheet.cards.prePost.summary).toMatch(/left out by type \(all-ages show\)/);
    for (const p of sheet.cards.partners.results) expect(p.explain?.activation ?? "").not.toMatch(/listening night/i);
  });

  it("all ages also keeps alcohol out of the copy lines and adult brands out of the sponsor pick", () => {
    const words = new RegExp(`\b(${ALCOHOL_TERMS.join("|")})s?\b`, "i");
    for (const h of sheet.cards.copyHooks.results) expect(h.text).not.toMatch(words);
    expect(sheet.cards.media.summary).toMatch(/you set the show to all ages/);
    expect(sheet.steps?.find((s) => s.id === "media")?.decision ?? "").toBeTruthy();
  });

  it("the revise step comes first (also through onStep), then the run's own steps say why", () => {
    const steps = sheet.steps!;
    expect(steps[0]).toMatchObject({ id: "revise", kind: "revise", label: "Your change", status: "ok" });
    expect(steps[0]!.decision).toBe('Changed 2 settings from your note "All ages: no bars".');
    expect(steps[0]!.cause).toBe("Fixed rules read it (no model is set up here) and changed the age setting and the types of place to leave out.");
    expect(streamed.map((s) => s.id)).toEqual(steps.map((s) => s.id));
    expect(steps.find((s) => s.id === "partners")!.cause).toMatch(/Left out \d+ places by type \(all-ages show\)/);
    expect(steps.find((s) => s.id === "prepost")!.cause).toMatch(/Left out \d+ places by type \(all-ages show\)/);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
  });

  it("changes: settings first, every removed bar listed with its reason, receipts in this run's ledger", () => {
    const changes = sheet.revision!.changes;
    expect(changes.slice(0, 2).map((c) => [c.kind, c.label])).toEqual([
      ["setting_changed", "All ages"],
      ["setting_changed", "Left out"],
    ]);
    const now = new Set(sheet.cards.partners.results.map((p) => p.entity.entityId));
    const gone = parent.cards.partners.results.filter((p) => !now.has(p.entity.entityId)).map((p) => p.entity.name);
    expect(changes.filter((c) => c.kind === "partner_removed").map((c) => c.label)).toEqual(gone);
    for (const c of changes.filter((x) => x.kind === "partner_removed" && /^bar /.test(x.detail ?? ""))) expect(c.detail).toMatch(/left out by type \(all-ages show\)$/);
    const was = new Set(parent.cards.partners.results.map((p) => p.entity.entityId));
    expect(changes.filter((c) => c.kind === "partner_added").length).toBe(sheet.cards.partners.results.filter((p) => !was.has(p.entity.entityId)).length);
    expect(changes.some((c) => c.kind === "spot_removed")).toBe(true);
    const ids = new Set(sheet.ledger.map((e) => e.id));
    for (const c of changes) for (const r of c.ledgerRefs) expect(ids.has(r), `${c.label} ${r}`).toBe(true);
    for (const c of changes.filter((x) => x.kind !== "setting_changed")) expect(c.ledgerRefs.length, c.label).toBeGreaterThan(0);
    for (const c of changes) expect(`${c.label} ${c.detail ?? ""}`).not.toMatch(/!|\d\.\d+x/);
  });

  it("call budget: only the partner searches (night-club exclusion) and the sponsor pick (adult-brand exclusions) are new; everything else came from the cache", () => {
    const b = result.budget;
    expect(b.venueLevel).toBe(0);
    expect(Object.keys(b.byNode).every((n) => n.startsWith("Q9 ") || n === "Q13 sponsor")).toBe(true);
    expect(Object.keys(b.byNode)).toContain("Q13 sponsor");
    // 3 pools, their house twins and their popularity twins, and the sponsor pick.
    expect(b.qlooFresh).toBeLessThanOrEqual(12);
    expect(b.qlooCached).toBeGreaterThan(b.qlooFresh);
    expect(b.anthropic).toBe(0);
  });

  it("stored under the new id with an event request (never as the preset)", async () => {
    const stored = await store.get(sheet.planId);
    expect(stored?.sheet?.revision?.parentPlanId).toBe("parent-a");
    expect(stored?.presetId).toBeUndefined();
    expect(stored?.request.presetId).toBeUndefined();
    expect(stored?.request.operator?.allAges).toBe(true);
  });

  it("revising the revision builds on its stored request", async () => {
    const stored = (await store.get(sheet.planId))!;
    const r2 = completed(await revisePlan({ sheet, request: parentRequest(sheet, { stored: stored.request })! }, "skip Mount Juliet", d));
    const s2 = sheetOf(r2);
    expect(s2.operator.allAges).toBe(true);
    expect(s2.operator.excludeAreas).toEqual(["Mount Juliet"]);
    expect(s2.revision!.parentPlanId).toBe(sheet.planId);
    expect(s2.cards.partners.results.some((p) => p.tileName === "Mount Juliet")).toBe(false);
  });
});

describe("other notes", { timeout: 90_000 }, () => {
  it("no bars on its own: zero new Qloo calls", async () => {
    const d = deps();
    const parent = sheetOf(await planShow({ presetId: "g1-a" }, d));
    const r = completed(await revisePlan({ sheet: parent, request: parentRequest(parent, { presetId: "g1-a" })! }, "no bars", d));
    expect(r.budget.qlooFresh).toBe(0);
    expect(sheetOf(r).cards.partners.results.some((p) => p.category === "bar")).toBe(false);
  });

  it("skip an area: the heat step says so, the area is gone, discovery never picks it", async () => {
    const d = deps();
    const parent = sheetOf(await planShow({ presetId: "g1-b" }, d));
    const r = completed(await revisePlan({ sheet: parent, request: parentRequest(parent, { presetId: "g1-b" })! }, "skip Beech Grove Farms", d));
    const s = sheetOf(r);
    expect(s.steps!.find((x) => x.id === "heat")!.cause).toMatch(/Left out \d+ areas? at your request/);
    expect(sheetAreas(s).some((t) => t.name === "Beech Grove Farms")).toBe(false);
    expect(s.cards.partners.results.some((p) => p.tileName === "Beech Grove Farms")).toBe(false);
    const gh = new Set(sheetAreas(parent).filter((t) => t.name === "Beech Grove Farms").map((t) => t.geohash));
    if (s.discovery?.geohash) expect(gh.has(s.discovery.geohash)).toBe(false);
    expect(s.revision!.changes.some((c) => c.kind === "tile_removed" && c.label === "Beech Grove Farms" && /skipped at your request/.test(c.detail ?? ""))).toBe(true);
    expect(r.budget.venueLevel).toBe(0);
    expect(r.budget.qlooFresh).toBeLessThanOrEqual(6);
  });

  it("a revision keeps its parent's as-of clock, so both count the same days to the show", async () => {
    let now = CLOCK_MS; // the preset's as-of time (Oct 30 2026, 15:00 UTC)
    const d = deps({ clock: () => now });
    const parent = sheetOf(await planShow({ presetId: "g1-a" }, d));
    expect(parent.createdAt).toBe("2026-10-30T15:00:00.000Z");
    now = Date.parse("2026-10-14T09:30:00Z"); // the operator revises on a different (real) day
    const s = sheetOf(completed(await revisePlan({ sheet: parent, request: parentRequest(parent, { presetId: "g1-a" })! }, "no bars", d)));
    expect(s.createdAt).toBe(parent.createdAt);
    const days = (iso: string) => Math.round((Date.parse(`${s.bill.date}T00:00:00Z`) - Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
    expect(days(s.createdAt)).toBe(days(parent.createdAt));
    // A parent planned on the live clock (no as-of date) is revised on the live clock.
    expect(revisionClock({ sheet: parent, request: { bill: parent.bill, operator: parent.operator } }, () => 42)()).toBe(42);
    // With an as-of date, time still moves forward from the parent's moment.
    let t = 1_000;
    const clock = revisionClock({ sheet: parent, request: { bill: parent.bill, operator: parent.operator, asOf: "2026-10-30" } }, () => t);
    t += 2_500;
    expect(clock()).toBe(CLOCK_MS + 2_500);
  });

  it("G2 revises without pausing again", async () => {
    const d = deps();
    const parent = parents["g2"]!;
    const r = completed(await revisePlan({ sheet: parent, request: parentRequest(parent, { presetId: "g2" })! }, "only Friday", d));
    expect(sheetOf(r).operator.streetTeamDays).toEqual(["friday"]);
    expect(sheetOf(r).revision!.changes[0]).toMatchObject({ kind: "setting_changed", label: "Street-team days", detail: "Friday (was Thursday and Friday)" });
  });

  it("an unclear note asks back: no run, nothing stored", async () => {
    const store = createMemoryPlanStore();
    const d = deps({ store });
    const parent = parents["g3"]!;
    const r = await revisePlan({ sheet: parent, request: parentRequest(parent, { presetId: "g3" })! }, "make it pop", d);
    expect(r.status).toBe("question");
    if (r.status !== "question") return;
    expect(r.revision).toMatchObject({ parentPlanId: parent.planId, interpreter: "rules", changes: [] });
    expect(r.revision.question).toMatch(/\?$/);
    expect(await store.list()).toEqual([]);
  });

  it("diffSheets of a sheet with itself is empty", () => {
    expect(diffSheets(parents["g1-a"]!, parents["g1-a"]!)).toEqual([]);
  });
});

describe("the model reads the note", { timeout: 90_000 }, () => {
  function mockModel(input: unknown[]): { client: NarratorClient; calls: MessageCreateParamsNonStreaming[] } {
    const calls: MessageCreateParamsNonStreaming[] = [];
    const message = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: input,
      stop_reason: "tool_use",
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as BetaMessage;
    return {
      calls,
      client: {
        beta: {
          messages: {
            async create(params) {
              calls.push(structuredClone(params));
              return message;
            },
          },
        },
      },
    };
  }

  it("tool calls from the model, its ledger entry carried into the revised sheet", async () => {
    const d = deps();
    const parent = sheetOf(await planShow({ presetId: "g1-b" }, d));
    const m = mockModel([
      { type: "tool_use", id: "t1", name: "set_street_team_days", input: { days: ["saturday"] } },
      { type: "tool_use", id: "t2", name: "exclude_partner_categories", input: { categories: ["beauty_salon"] } },
    ]);
    const reading = await readInstruction(parent, "Saturday only, and no salons", { narrator: { client: m.client } });
    expect(reading.interpreter).toBe("model");
    expect(reading.ledger.map((e) => e.kind)).toEqual(["anthropic"]);
    expect(m.calls[0]!.tools!.length).toBe(6);
    const r = await runRevision({ sheet: parent, request: parentRequest(parent, { presetId: "g1-b" })! }, reading, { ...d, narrator: { client: null } });
    const s = sheetOf(r);
    expect(s.revision!.interpreter).toBe("model");
    const step = s.steps![0]!;
    expect(step.cause).toBe("The model read it and changed the street-team days and the types of place to leave out.");
    expect(step.ledgerRefs).toEqual(["L1"]);
    expect(s.ledger.find((e) => e.id === "L1")?.note).toMatch(/node revise; revise turn 1/);
    expect(s.revision!.changes.filter((c) => c.kind === "setting_changed").every((c) => c.ledgerRefs.join() === "L1")).toBe(true);
    expect(r.budget.anthropic).toBe(1);
    expect(s.cards.partners.results.some((p) => p.category === "beauty_salon")).toBe(false);
  });

  it("an ask_operator call means a question and no run", async () => {
    const parent = parents["g1-a"]!;
    const m = mockModel([{ type: "tool_use", id: "t1", name: "ask_operator", input: { question: "Which part of town do you mean?" } }]);
    const r = await revisePlan({ sheet: parent, request: parentRequest(parent, { presetId: "g1-a" })! }, "skip the far side", { ...deps(), narrator: { client: m.client } });
    expect(r.status).toBe("question");
    if (r.status === "question") expect(r.revision).toMatchObject({ interpreter: "model", question: "Which part of town do you mean?", changes: [] });
  });

  it("the reading never sends contact details to the model", async () => {
    const parent = parents["g2"]!;
    const m = mockModel([{ type: "tool_use", id: "t1", name: "set_radius", input: { km: 30 } }]);
    await readInstruction(parent, "within 30 km", { narrator: { client: m.client } });
    const sent = JSON.stringify(m.calls[0]!.messages);
    expect(sent).not.toMatch(/@/);
    for (const dp of parent.operator.declaredPartners) expect(sent).not.toContain(dp.label);
  });
});
