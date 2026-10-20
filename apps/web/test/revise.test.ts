/**
 * POST /api/plan/<id>/revise without a server: the service function on the
 * synthetic fixture world (memory store, temp data dir, no keys, so the fixed
 * rules read every note), the SSE stream of the revised run (cards and steps),
 * the rate limit, and the browser helper in lib/api.ts with an injected fetch.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SheetRevision, StreetSheet } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES } from "@walkup/engine";
import { revisePlan, type ReviseRunning } from "../lib/api";
import type { PlanResult } from "@walkup/orchestrator";
import { depsFor, resetEngineForTests, stores } from "../lib/server/engine";
import type { RequestContext } from "../lib/server/http";
import { parseOperator, parseReviseBody } from "../lib/server/input";
import { REVISES_PER_HOUR, resetRateWindowsForTests } from "../lib/server/limits";
import { revisePlanFor } from "../lib/server/revise";
import { getRun, resetRunsForTests, startRun } from "../lib/server/runs";
import { loadPlan } from "../lib/server/service";
import { planEventStream, staticFrames } from "../lib/server/stream";

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_QLOO_UNTIL"];
const saved: Record<string, string | undefined> = {};
let dir = "";
const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({ ip: "203.0.113.9", sessionId: "test-session-revise01", origin: "https://walkup.example", ...over });

type Body = Record<string, unknown> & { results?: StreetSheet | null; revision?: SheetRevision };

async function readFrames(stream: ReadableStream<Uint8Array>): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter((f) => f.startsWith("event:"))
    .map((f) => {
      const [e, d] = f.split("\n");
      return { event: (e ?? "").slice(7), data: JSON.parse((d ?? "").slice(6)) as Record<string, unknown> };
    });
}

beforeAll(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "walkup-revise-test-"));
  saved.WALKUP_DATA_DIR = process.env.WALKUP_DATA_DIR;
  saved.WALKUP_PLAN_STORE = process.env.WALKUP_PLAN_STORE;
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  resetEngineForTests();
  resetRunsForTests();
});

afterAll(() => {
  resetEngineForTests();
  resetRunsForTests();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => resetRateWindowsForTests());

describe("input", () => {
  it("revise bodies: a short note, nothing personal, wait defaults to none", () => {
    expect(parseReviseBody({ instruction: "  All ages:  no bars " })).toEqual({ ok: true, value: { instruction: "All ages: no bars", wait: "none" } });
    expect(parseReviseBody({ instruction: "only Saturday", wait: "complete" })).toEqual({ ok: true, value: { instruction: "only Saturday", wait: "complete" } });
    for (const bad of [null, {}, { instruction: "" }, { instruction: 4 }, { instruction: "x".repeat(301) }, { instruction: "send it to lead@example.com" }]) {
      expect(parseReviseBody(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("operator inputs accept allAges, excludeCategories and excludeAreas", () => {
    expect(parseOperator({ allAges: true, excludeCategories: ["bar", "bar", "cafe"], excludeAreas: ["Germantown"] })).toEqual({
      ok: true,
      value: { allAges: true, excludeCategories: ["bar", "cafe"], excludeAreas: ["Germantown"] },
    });
    expect(parseOperator({ allAges: "yes" }).ok).toBe(false);
    expect(parseOperator({ excludeAreas: "Germantown" }).ok).toBe(false);
  });
});

describe("POST /api/plan/<id>/revise", { timeout: 90_000 }, () => {
  it("revises a preset sheet: 202 with the new id and the tools the rules chose, then a stream with the revise step first", async () => {
    const res = await revisePlanFor("g1-a", { instruction: "All ages: no bars" }, ctx());
    expect(res.status).toBe(202);
    const body = res.body as ReviseRunning;
    expect(body).toMatchObject({ status: "running", parentPlanId: "g1-a", mode: "fixture" });
    expect(body.planId).not.toBe("g1-a");
    expect(body.streamUrl).toBe(`https://walkup.example/api/plan/${body.planId}/stream`);
    expect(body.revision).toMatchObject({ parentPlanId: "g1-a", interpreter: "rules", changes: [] });
    expect(body.revision.toolCalls.map((c) => c.tool)).toEqual(["set_all_ages", "exclude_partner_categories"]);

    const frames = await readFrames((await planEventStream(body.planId, null))!);
    expect(frames[0]?.event).toBe("start");
    const steps = frames.filter((f) => f.event === "step").map((f) => (f.data.step as { id: string; kind: string }));
    expect(steps[0]).toMatchObject({ id: "revise", kind: "revise" });
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    expect(frames.filter((f) => f.event === "card")).toHaveLength(9);
    expect(frames.at(-1)).toMatchObject({ event: "done", data: { status: "complete" } });

    const v = await loadPlan(body.planId, { view: "api" });
    if (!v || v.kind !== "sheet") throw new Error("revised sheet");
    expect(v.sheet.revision?.changes.length).toBeGreaterThan(0);
    expect(v.sheet.cards.partners.results.some((p) => DEFAULT_BAR_CATEGORIES.includes(p.category))).toBe(false);
    // A finished sheet replays its steps after the cards.
    const replay = staticFrames(v).map((f) => f.split("\n")[0]);
    expect(replay.filter((f) => f === "event: step")).toHaveLength(v.sheet.steps!.length);
    // Stored as the caller's own run, never as the preset.
    const stored = await stores().plans.get(body.planId);
    expect(stored?.presetId).toBeUndefined();
    expect(stored?.request.operator?.allAges).toBe(true);
  });

  it("wait complete answers with the revised sheet's envelope and the change list; a revision of a revision builds on it", async () => {
    const first = await revisePlanFor("g1-b", { instruction: "skip West Nashville", wait: "complete" }, ctx());
    expect(first.status).toBe(200);
    const b1 = first.body as Body;
    expect(b1.parentPlanId).toBe("g1-b");
    expect(b1.revision?.changes.some((c) => c.kind === "tile_removed" && c.label === "West Nashville")).toBe(true);
    const sheet = b1.results as StreetSheet;
    expect(sheet.revision?.parentPlanId).toBe("g1-b");
    const ids = new Set(sheet.ledger.map((e) => e.id));
    for (const c of sheet.revision!.changes) for (const r of c.ledgerRefs) expect(ids.has(r)).toBe(true);

    const second = await revisePlanFor(String(b1.planId), { instruction: "only Saturday", wait: "complete" }, ctx());
    expect(second.status).toBe(200);
    const s2 = (second.body as Body).results as StreetSheet;
    expect(s2.operator.excludeAreas).toEqual(["West Nashville"]);
    expect(s2.operator.streetTeamDays).toEqual(["saturday"]);
    expect(s2.revision?.parentPlanId).toBe(b1.planId);
  });

  it("an unclear note: 200 needs_input with a question, no new run", async () => {
    const before = (await stores().plans.list(500)).length;
    const res = await revisePlanFor("g3", { instruction: "make it pop" }, ctx());
    expect(res.status).toBe(200);
    const body = res.body as Body;
    expect(body).toMatchObject({ status: "needs_input", planId: "g3", parentPlanId: "g3", results: null });
    expect(String(body.question)).toMatch(/\?$/);
    expect(body.revision).toMatchObject({ changes: [], interpreter: "rules" });
    expect((await stores().plans.list(500)).length).toBe(before);
  });

  it("validation: bad id 400, bad note 400, unknown plan 404, a paused or running plan 409", async () => {
    expect((await revisePlanFor("bad id!", { instruction: "no bars" }, ctx())).status).toBe(400);
    expect((await revisePlanFor("g1-a", { instruction: "" }, ctx())).status).toBe(400);
    expect((await revisePlanFor("no-such-plan", { instruction: "no bars" }, ctx())).status).toBe(404);
    // A run held open until the check is done, so the running branch is always asserted.
    let release!: (r: PlanResult) => void;
    const held = new Promise<PlanResult>((res) => {
      release = res;
    });
    const run = startRun({ request: { planId: "held-revise-run", presetId: "g3" }, deps: depsFor("fixture"), mode: "fixture", title: "held", run: () => held });
    expect(getRun(run.planId)?.status).toBe("running");
    expect((await revisePlanFor(run.planId, { instruction: "no bars" }, ctx())).status).toBe(409);
    release({ status: "error", planId: run.planId, mode: "fixture", error: "released", arms: {}, budget: { qlooFresh: 0 } } as unknown as PlanResult);
    await run.done;
  });

  it(`rate limit: ${REVISES_PER_HOUR.fixture} per network per hour in fixture mode, then 429 with the wait`, async () => {
    const who = ctx({ ip: "198.51.100.77" });
    for (let i = 0; i < REVISES_PER_HOUR.fixture; i++) {
      const r = await revisePlanFor("g3", { instruction: "what?" }, who);
      expect(r.status).toBe(200);
    }
    const blocked = await revisePlanFor("g3", { instruction: "what?" }, who);
    expect(blocked.status).toBe(429);
    expect(String((blocked.body as Body).reason)).toMatch(/per network per hour; try again in \d+ s/);
    expect((await revisePlanFor("g3", { instruction: "what?" }, ctx({ ip: "198.51.100.78" }))).status).toBe(200);
  });
});

describe("revisePlan (browser helper)", () => {
  const viaService: typeof fetch = async (input, init) => {
    const url = String(input);
    const m = /\/api\/plan\/([^/]+)\/revise$/.exec(url);
    if (!m || init?.method !== "POST") return new Response("{}", { status: 404 });
    const res = await revisePlanFor(decodeURIComponent(m[1]!), JSON.parse(String(init.body)), ctx());
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  };

  it("posts {instruction} to the plan's revise URL and returns the body", async () => {
    const out = await revisePlan("g3", "only Thursday", { fetchImpl: viaService });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.httpStatus).toBe(202);
    expect(out.body.status).toBe("running");
    await getRun(out.body.planId)?.done;
  });

  it("returns a reason instead of throwing", async () => {
    expect(await revisePlan("g3", "   ", { fetchImpl: viaService })).toMatchObject({ ok: false, httpStatus: 400 });
    expect(await revisePlan("bad id!", "no bars")).toMatchObject({ ok: false, httpStatus: 400 });
    expect(await revisePlan("missing-plan", "no bars", { fetchImpl: viaService })).toMatchObject({ ok: false, httpStatus: 404, reason: "No plan with id missing-plan." });
    const offline: typeof fetch = async () => {
      throw new TypeError("network down");
    };
    expect(await revisePlan("g3", "no bars", { fetchImpl: offline })).toMatchObject({ ok: false, httpStatus: 0 });
  });
});
