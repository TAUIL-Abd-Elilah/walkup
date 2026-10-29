/**
 * "Change something" while live runs are paused: the note is read (fixed rules here: no model key), turned into
 * overrides, and answered from a ready-made revision of the same sheet with the same overrides; otherwise a plain
 * answer that nothing new runs. Covers the matcher (lib/revise-match.ts), the server path
 * (lib/server/recorded-revise.ts through revisePlanFor), the kill switch, the header links, that live mode is
 * untouched, and the box's recorded variant.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WEEKDAYS, type OperatorInputs, type RevisionToolCall, type StreetSheet, type Weekday } from "@walkup/contracts";
import { barKeys } from "@walkup/narrator";
import { reviseSummary, type StoredPlan } from "@walkup/orchestrator";
import { RECORDED_REASON } from "../lib/api";
import { changesNothing, findReadyMade, normaliseOverrides, overridesKey, revisionOverrides } from "../lib/revise-match";
import { resetEngineForTests, stores } from "../lib/server/engine";
import type { RequestContext } from "../lib/server/http";
import { REVISES_PER_HOUR, resetRateWindowsForTests } from "../lib/server/limits";
import { recordedOnDay, revisionsOf } from "../lib/server/recorded";
import { matchReadyMade, NOT_RECORDED_REASON, readyMadeFor, resetRecordedReviseForTests, UNCHANGED_REASON } from "../lib/server/recorded-revise";
import { revisePlanFor } from "../lib/server/revise";
import { resetRunsForTests } from "../lib/server/runs";
import { ReviseBox } from "../components/plan/ReviseBox";
import { openingLine, parseReadyMade, recordedOutcome } from "../components/plan/model";

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_QLOO_UNTIL", "WALKUP_RECORDED_REVISE"];
const saved: Record<string, string | undefined> = {};
let dir = "";
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({ ip: "203.0.113.40", sessionId: "test-session-recrev01", origin: "https://walkup.example", ...over });
type Body = Record<string, unknown>;

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixtureSheet = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;

// A recorded parent (a fixture sheet standing in for a live recording) and its ready-made revisions.
const PARENT_ID = "rec-parent-1";
const base = fixtureSheet("g1-a");
const parent: StreetSheet = { ...structuredClone(base), planId: PARENT_ID, mode: "live", createdAt: "2026-10-21T04:35:56.054Z" };
delete parent.revision;
const summary = reviseSummary(parent);
const parentDays = parent.operator.streetTeamDays;
const oneDay: Weekday = WEEKDAYS.find((d) => !(parentDays.length === 1 && parentDays[0] === d)) ?? "saturday";
const firstArea = summary.areas.find((a) => a.name)?.name as string;
const otherArea = summary.areas.find((a) => a.name && a.name !== firstArea)?.name as string;
const bars = barKeys(summary);

function revisionOf(planId: string, instruction: string, toolCalls: RevisionToolCall[], createdAt: string): StoredPlan {
  const sheet: StreetSheet = {
    ...structuredClone(parent),
    planId,
    createdAt,
    revision: { parentPlanId: PARENT_ID, instruction, interpreter: "model", toolCalls, changes: [] },
  };
  return { planId, createdAt, mode: "live", status: "complete", request: { planId }, sheet };
}

const AGES = revisionOf(
  "rec-rev-ages",
  "All ages, no bars",
  [
    { tool: "set_all_ages", input: { allAges: true }, summary: "Marked the show all ages" },
    // The model listed the bar keys in its own order.
    { tool: "exclude_partner_categories", input: { categories: [...bars].reverse() }, summary: "Left out bars" },
  ],
  "2026-10-21T04:36:07.551Z",
);
const DAY = revisionOf("rec-rev-day", `Street team only on ${oneDay}`, [{ tool: "set_street_team_days", input: { days: [oneDay] }, summary: "Street team on one day" }], "2026-10-28T11:43:41.380Z");
const SKIP = revisionOf("rec-rev-skip", `Skip ${firstArea}`, [{ tool: "exclude_areas", input: { areas: [firstArea] }, summary: `Skipped ${firstArea}` }], "2026-10-28T11:52:24.455Z");

async function seed(): Promise<void> {
  resetEngineForTests();
  resetRunsForTests();
  resetRecordedReviseForTests();
  const st = stores();
  await st.plans.put({ planId: PARENT_ID, createdAt: parent.createdAt, mode: "live", status: "complete", request: { planId: PARENT_ID }, sheet: parent });
  for (const r of [AGES, DAY, SKIP]) await st.plans.put(r);
}

beforeAll(async () => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "walkup-recrev-test-"));
  saved.WALKUP_DATA_DIR = process.env.WALKUP_DATA_DIR;
  saved.WALKUP_PLAN_STORE = process.env.WALKUP_PLAN_STORE;
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  process.env.WALKUP_MODE = "recorded";
  await seed();
});

afterAll(() => {
  resetEngineForTests();
  resetRunsForTests();
  resetRecordedReviseForTests();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetRateWindowsForTests();
  process.env.WALKUP_MODE = "recorded";
  delete process.env.WALKUP_RECORDED_REVISE;
});

describe("normalising and matching overrides", () => {
  const op: Partial<OperatorInputs> = { allAges: false, streetTeamDays: ["thursday", "saturday"], radiusKm: 40, excludeCategories: [], excludeAreas: [] };

  it("compares place types and areas as sets, keeps the day order, the radius to 0.1 km, and drops what the parent already has", () => {
    expect(normaliseOverrides({ excludeCategories: ["pub", "bar", "pub", " BAR "] }, op)).toEqual({ excludeCategories: ["bar", "pub"] });
    expect(normaliseOverrides({ streetTeamDays: ["saturday", "friday", "saturday"] }, op)).toEqual({ streetTeamDays: ["saturday", "friday"] });
    // Partner hours are checked against the first day, so Saturday-then-Thursday changes a Thursday-then-Saturday sheet.
    expect(changesNothing(normaliseOverrides({ streetTeamDays: ["saturday", "thursday"] }, op))).toBe(false);
    expect(normaliseOverrides({ radiusKm: 9.96 }, op)).toEqual({ radiusKm: 10 });
    expect(normaliseOverrides({ excludeAreas: ["East  Nashville", "dq9cgz"] }, op)).toEqual({ excludeAreas: ["dq9cgz", "east nashville"] });
    // "Within 40 km, only Saturday" on a 40 km sheet is the same change as "only Saturday".
    expect(overridesKey(normaliseOverrides({ radiusKm: 40, streetTeamDays: ["saturday"] }, op))).toBe(overridesKey(normaliseOverrides({ streetTeamDays: ["saturday"] }, op)));
    expect(changesNothing(normaliseOverrides({ streetTeamDays: ["thursday", "saturday", "thursday"], allAges: false }, op))).toBe(true);
    expect(changesNothing(normaliseOverrides({ allAges: true }, op))).toBe(false);
  });

  it("rebuilds a stored revision's overrides from its own tool calls, checked against the parent", () => {
    // All ages already leaves every bar type out, so the stored "no bars" call adds no change of its own.
    expect(revisionOverrides(AGES.sheet!.revision!, parent)).toEqual({ allAges: true });
    expect(revisionOverrides({ toolCalls: [{ tool: "set_radius", input: { km: 500 }, summary: "" }] }, parent)).toBeNull();
    expect(revisionOverrides({ toolCalls: [{ tool: "ask_operator", input: { question: "Which?" }, summary: "" }] }, parent)).toBeNull();
    expect(revisionOverrides({ toolCalls: [], question: "Which?" }, parent)).toBeNull();
  });

  it("finds the revision with the same tools and arguments, whatever the order or wording", () => {
    const stored = [AGES, DAY, SKIP];
    expect(findReadyMade(parent, { excludeCategories: bars, allAges: true }, stored)?.planId).toBe("rec-rev-ages");
    expect(findReadyMade(parent, { streetTeamDays: [oneDay] }, stored)?.planId).toBe("rec-rev-day");
    expect(findReadyMade(parent, { excludeAreas: [firstArea.toUpperCase()] }, stored)?.planId).toBe("rec-rev-skip");
    // All ages alone already leaves bars out, so it is "all ages, no bars"; bars alone, without all ages, is not.
    expect(findReadyMade(parent, { allAges: true }, stored)?.planId).toBe("rec-rev-ages");
    expect(findReadyMade(parent, { excludeCategories: bars }, stored)).toBeNull();
    // Another area is not the stored one; no change finds nothing.
    expect(findReadyMade(parent, { excludeAreas: [otherArea] }, stored)).toBeNull();
    expect(findReadyMade(parent, { streetTeamDays: [...parentDays] }, stored)).toBeNull();
    // A revision of another sheet never answers.
    const other = { ...structuredClone(DAY), planId: "rec-rev-other" };
    other.sheet!.planId = "rec-rev-other";
    other.sheet!.revision!.parentPlanId = "someone-else";
    expect(findReadyMade(parent, { streetTeamDays: [oneDay] }, [other])).toBeNull();
  });
});

describe("recorded mode: revisePlanFor answers from ready-made changes", () => {
  it("opens the stored revision a note reads as, with the reading, and stores and runs nothing", async () => {
    const before = (await stores().plans.list(1000)).length;
    const res = await revisePlanFor(PARENT_ID, { instruction: `Only ${oneDay}, please` }, ctx());
    expect(res.status).toBe(200);
    const body = res.body as Body & { revision: { interpreter: string; toolCalls: RevisionToolCall[] }; recorded: { instruction: string } };
    expect(body).toMatchObject({ status: "recorded", mode: "recorded", planId: "rec-rev-day", parentPlanId: PARENT_ID, reader: "rules" });
    expect(body.recorded.instruction).toBe(`Street team only on ${oneDay}`);
    expect(body.revision.interpreter).toBe("rules");
    expect(body.revision.toolCalls.map((t) => t.tool)).toEqual(["set_street_team_days"]);
    expect(String(body.summary)).toMatch(/recorded ahead/);
    expect(String(body.summary)).toMatch(/Nothing was sent to Qloo/);
    // A model-read revision answers a rules reading of the same change.
    expect(((await revisePlanFor(PARENT_ID, { instruction: "No bars. All ages." }, ctx())).body as Body).planId).toBe("rec-rev-ages");
    expect((await stores().plans.list(1000)).length).toBe(before);
  });

  it("answers a change nobody made ahead with a plain message and the ready-made changes, never 503", async () => {
    const res = await revisePlanFor(PARENT_ID, { instruction: `skip ${otherArea}` }, ctx());
    expect(res.status).toBe(200);
    const body = res.body as Body & { readyMade: { planId: string; instruction: string }[] };
    expect(body).toMatchObject({ status: "not_recorded", mode: "recorded", planId: PARENT_ID, reason: NOT_RECORDED_REASON });
    expect(NOT_RECORDED_REASON).toMatch(/new Qloo requests/);
    expect(NOT_RECORDED_REASON).toMatch(/paused for judging/);
    // Oldest first: the first recorded revision leads.
    expect(body.readyMade.map((r) => r.planId)).toEqual(["rec-rev-ages", "rec-rev-day", "rec-rev-skip"]);
    const same = await revisePlanFor(PARENT_ID, { instruction: `street team ${parentDays.join(" and ")}` }, ctx());
    expect(same.body).toMatchObject({ status: "unchanged", reason: UNCHANGED_REASON });
    const unclear = await revisePlanFor(PARENT_ID, { instruction: "make it pop" }, ctx());
    expect(unclear.body).toMatchObject({ status: "needs_input", mode: "recorded", planId: PARENT_ID });
  });

  it("gives MCP revise_plan the same reading as the route: the version it opens, none, or not read", async () => {
    const note = `Only ${oneDay}, please`;
    const rest = (await revisePlanFor(PARENT_ID, { instruction: note }, ctx())).body as Body;
    expect(await matchReadyMade(PARENT_ID, note, "203.0.113.42")).toEqual({ planId: rest.planId });
    expect(await matchReadyMade(PARENT_ID, "No bars. All ages.", "203.0.113.42")).toEqual({ planId: "rec-rev-ages" });
    // Read, and no ready-made change makes it.
    expect(await matchReadyMade(PARENT_ID, `skip ${otherArea}`, "203.0.113.42")).toEqual({ planId: null });
    // Not read: an unclear note, a revision or sample sheet as parent, the switch off.
    expect(await matchReadyMade(PARENT_ID, "make it pop", "203.0.113.42")).toBeNull();
    expect(await matchReadyMade("rec-rev-day", note, "203.0.113.42")).toBeNull();
    expect(await matchReadyMade("g3", note, "203.0.113.42")).toBeNull();
    process.env.WALKUP_RECORDED_REVISE = "off";
    expect(await matchReadyMade(PARENT_ID, note, "203.0.113.42")).toBeNull();
  });

  it("keeps the per-network cap", async () => {
    const who = ctx({ ip: "203.0.113.41" });
    for (let i = 0; i < REVISES_PER_HOUR.recorded; i++) expect((await revisePlanFor(PARENT_ID, { instruction: "make it pop" }, who)).status).toBe(200);
    const blocked = await revisePlanFor(PARENT_ID, { instruction: "make it pop" }, who);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ mode: "recorded" });
  });

  it("refuses as before for a sheet with nothing made ahead, a revision, a sample sheet, and with the switch off", async () => {
    const refused = { status: 503, body: { mode: "recorded", reason: RECORDED_REASON } };
    expect(await revisePlanFor("rec-rev-day", { instruction: "only saturday" }, ctx())).toEqual(refused);
    expect(await revisePlanFor("g3", { instruction: "only saturday" }, ctx())).toEqual(refused);
    expect((await revisePlanFor("no-such-plan", { instruction: "only saturday" }, ctx())).status).toBe(404);
    process.env.WALKUP_RECORDED_REVISE = "off";
    expect(await revisePlanFor(PARENT_ID, { instruction: `only ${oneDay}` }, ctx())).toEqual(refused);
    expect((await readyMadeFor(PARENT_ID)).body).toMatchObject({ enabled: false, changes: [] });
  });

  it("lists the ready-made changes for the box, and links only the first under the header while the box can open them", async () => {
    const ready = await readyMadeFor(PARENT_ID);
    expect(ready.body).toMatchObject({ mode: "recorded", enabled: true, reader: "rules" });
    expect((ready.body as { changes: { instruction: string }[] }).changes.map((c) => c.instruction)).toEqual(["All ages, no bars", `Street team only on ${oneDay}`, `Skip ${firstArea}`]);
    expect((await readyMadeFor("rec-rev-day")).body).toMatchObject({ enabled: false });
    expect((await revisionsOf(PARENT_ID, "live")).map((r) => r.planId)).toEqual(["rec-rev-ages"]);
    process.env.WALKUP_RECORDED_REVISE = "off";
    expect((await revisionsOf(PARENT_ID, "live")).map((r) => r.planId)).toEqual(["rec-rev-skip", "rec-rev-day", "rec-rev-ages"]);
    // The site's "recorded on" day is the recordings', not a later ready-made change's.
    expect(recordedOnDay()).toBe("2026-10-21");
  });
});

describe("live and fixture modes are unchanged", () => {
  it("a fixture server re-runs the note on the synthetic world (new plan id), never a ready-made change", async () => {
    delete process.env.WALKUP_MODE;
    const res = await revisePlanFor("g1-a", { instruction: "only Saturday" }, ctx({ ip: "203.0.113.42" }));
    expect(res.status).toBe(202);
    const body = res.body as Body;
    expect(body).toMatchObject({ status: "running", mode: "fixture", parentPlanId: "g1-a" });
    expect(String(body.planId)).not.toMatch(/^rec-/);
    expect((await readyMadeFor(PARENT_ID)).body).toMatchObject({ enabled: false });
  });

  it("a live server takes the live path (here: a live parent is refused as before, nothing recorded is opened)", async () => {
    process.env.WALKUP_MODE = "live";
    process.env.QLOO_API_KEY = "test-not-a-key";
    process.env.TICKETMASTER_API_KEY = "test-not-a-key";
    try {
      const res = await revisePlanFor("g3", { instruction: "only Saturday" }, ctx({ ip: "203.0.113.43" }));
      expect(res.status).toBe(409);
      expect((res.body as Body).status).toBeUndefined();
    } finally {
      delete process.env.QLOO_API_KEY;
      delete process.env.TICKETMASTER_API_KEY;
    }
  });
});

describe("the box", () => {
  it("reads the server's answers", () => {
    expect(
      recordedOutcome({
        status: "recorded",
        planId: "rec-rev-day",
        recorded: { instruction: "Street team only on Saturday", recordedAt: "2026-10-28T11:43:41.380Z" },
        revision: { interpreter: "rules", toolCalls: [{ tool: "set_street_team_days", input: { days: ["saturday"] }, summary: "Street team on Saturday" }] },
      }),
    ).toEqual({
      planId: "rec-rev-day",
      recorded: { instruction: "Street team only on Saturday", recordedAt: "2026-10-28T11:43:41.380Z" },
      reading: { interpreter: "rules", toolCalls: [{ tool: "set_street_team_days", input: { days: ["saturday"] }, summary: "Street team on Saturday" }] },
    });
    expect(recordedOutcome({ status: "not_recorded", reason: NOT_RECORDED_REASON })).toEqual({ notice: NOT_RECORDED_REASON });
    expect(recordedOutcome({ status: "needs_input", question: "Which area?" })).toEqual({ question: "Which area?" });
    expect(recordedOutcome({ status: "weird" })).toEqual({ reason: "Nothing changed. Try saying it another way." });
    expect(openingLine({ instruction: "No restaurants", recordedAt: "2026-10-28T11:54:46.174Z" }, () => "Oct 28")).toBe("Opening the version made for “No restaurants”, recorded Oct 28.");
    expect(parseReadyMade({ enabled: false, changes: [] })).toBeNull();
    expect(parseReadyMade({ enabled: true, reader: "rules", changes: [{ planId: "a", instruction: "No bars", createdAt: "2026-10-28" }, { planId: 3 }] })).toEqual({
      reader: "rules",
      changes: [{ planId: "a", instruction: "No bars", createdAt: "2026-10-28" }],
    });
  });

  it("shows the paused-runs line and the ready-made changes as links on a recorded sheet, and stays hidden until it has them", () => {
    const readyMade = { reader: "rules" as const, changes: [{ planId: "a", instruction: "All ages, no bars", createdAt: "2026-10-21" }, { planId: "b", instruction: "No restaurants", createdAt: "2026-10-28" }] };
    const html = renderToStaticMarkup(createElement(ReviseBox, { recordedPlanId: PARENT_ID, readyMade, onOpen: () => undefined }));
    expect(html).toContain("Live runs are paused for judging. Walkup reads your note now and, if it asks for one of the changes recorded ahead for this sheet");
    expect(html).toContain("Nothing is sent to Qloo.");
    // The ready-made revisions were recorded later than their parents, with fresh calls where the note reached; never
    // say they reuse only the parent's answers.
    expect(html).not.toMatch(/same recorded/);
    expect(NOT_RECORDED_REASON).not.toMatch(/same recorded/);
    expect(html).toContain("Fixed rules read your note on this server (it has no model key)");
    expect(html).toMatch(/<button type="button" class="link[^"]*"[^>]*>All ages, no bars<\/button>/);
    expect(html).toContain(">No restaurants</button>");
    // Before the list has loaded (server render), nothing shows.
    expect(renderToStaticMarkup(createElement(ReviseBox, { recordedPlanId: PARENT_ID, onOpen: () => undefined }))).toBe("");
    // The live box is as before.
    const live = renderToStaticMarkup(createElement(ReviseBox, { onRevise: async () => ({}), onOpen: () => undefined }));
    expect(live).toContain("Walkup makes a new version of this plan and lists what changed");
    expect(live).not.toContain("paused");
  });
});
