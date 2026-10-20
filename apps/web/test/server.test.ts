/**
 * The web wiring end to end, without a server: the plan service on the
 * synthetic fixture world (memory plan store, temp data dir, no keys), the SSE
 * frames, the confirm-gated send in demo mode, exports, caps and /healthz.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMemoryLedger, type LedgerEntry, type StreetSheet } from "@walkup/contracts";
import { CARD_ORDER, createFixtureDeps } from "@walkup/orchestrator";
import { createWorld, WORLD_EVENT_IDS } from "@walkup/qloo-world";
import { createMemorySendStore, resolveSendConfig } from "@walkup/send";
import { runtimeMode } from "../lib/mode";
import { validateSheet } from "../lib/validate";
import { resetActionsForTests, sessionActions } from "../lib/server/actions";
import { depsFor, resetEngineForTests, setEngineForTests, stores } from "../lib/server/engine";
import { exportKind, exportResponse } from "../lib/server/exports";
import type { RequestContext } from "../lib/server/http";
import { clientIp, parseCookies, sessionCookie } from "../lib/server/http";
import { parseOperator, parsePlanBody, POLITICAL_REFUSAL, tmEventIdFrom } from "../lib/server/input";
import { noteQlooRejection, qlooKeyRejection, resetKeyStatusMemo } from "../lib/server/key-status";
import { FreshRunLimiter, rateLimit, resetRateWindowsForTests, setFreshRunsForTests } from "../lib/server/limits";
import { health } from "../lib/server/lookups";
import { applyProxyPicks } from "../lib/server/proxy";
import { getRun, resetRunsForTests } from "../lib/server/runs";
import { searchShows } from "../lib/server/search";
import { confirmSendFor, prepareSendFor } from "../lib/server/send";
import { loadPlan, planSnapshot, resolvePlan, startPlan } from "../lib/server/service";
import { planEventStream, staticFrames } from "../lib/server/stream";
import { addPartnerHouseRanks, continueLedger, houseSignalOf, TWIN_CHIP_PREFIX, twinChipLabel } from "../lib/server/twin";

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "GOOGLE_PLACES_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "RESEND_API_KEY", "RESEND_FROM", "WALKUP_MODE"];
const saved: Record<string, string | undefined> = {};
let dir = "";

const ctx = (over: Partial<RequestContext> = {}): RequestContext => ({ ip: "203.0.113.7", sessionId: "test-session-0000001", origin: "https://walkup.example", ...over });

type Body = Record<string, unknown> & { results?: StreetSheet | null };

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
  dir = mkdtempSync(join(tmpdir(), "hl-web-test-"));
  saved.WALKUP_DATA_DIR = process.env.WALKUP_DATA_DIR;
  saved.WALKUP_PLAN_STORE = process.env.WALKUP_PLAN_STORE;
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  resetEngineForTests();
  resetRunsForTests();
  setFreshRunsForTests(new FreshRunLimiter({ file: null }));
});

afterAll(() => {
  resetEngineForTests();
  resetRunsForTests();
  setFreshRunsForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetRateWindowsForTests();
  resetActionsForTests();
});

describe("mode", () => {
  it("is fixture without keys and live with both keys, unless Qloo rejected the key", () => {
    expect(runtimeMode().kind).toBe("fixture");
    const env = { QLOO_API_KEY: "k-one", TICKETMASTER_API_KEY: "t", WALKUP_DATA_DIR: dir };
    resetKeyStatusMemo();
    expect(runtimeMode(env).kind).toBe("live");
    expect(runtimeMode({ ...env, WALKUP_MODE: "fixture" }).kind).toBe("fixture");
    const rejected: LedgerEntry = {
      id: "Q1", kind: "qloo", method: "GET", endpoint: "/search", params: {}, httpStatus: 401, envelopeStatus: "error",
      latencyMs: 1, bytes: 0, cacheHit: false, resultCount: 0, curl: "curl", startedAt: new Date().toISOString(),
    };
    expect(noteQlooRejection([rejected], env)).toBe(true);
    expect(qlooKeyRejection(env)?.httpStatus).toBe(401);
    const m = runtimeMode(env);
    expect(m.kind).toBe("fixture");
    expect(m.detail).toMatch(/rejected/);
    // A different key clears it.
    expect(runtimeMode({ ...env, QLOO_API_KEY: "k-two" }).kind).toBe("live");
    resetKeyStatusMemo();
  });

  it("does not take a 403 on one request for a dead key when the same run's fresh calls were accepted", () => {
    const env = { QLOO_API_KEY: "k-three", TICKETMASTER_API_KEY: "t", WALKUP_DATA_DIR: dir };
    resetKeyStatusMemo();
    const entry = (id: string, httpStatus: number, cacheHit = false): LedgerEntry => ({
      id, kind: "qloo", method: "GET", endpoint: "/v2/insights", params: {}, httpStatus, envelopeStatus: httpStatus === 200 ? "ok" : "error",
      latencyMs: 1, bytes: 0, cacheHit, resultCount: 0, curl: "curl", startedAt: new Date().toISOString(),
    });
    // Unsupported filter.type: 403 on one call, the key answered others.
    expect(noteQlooRejection([entry("Q1", 200), entry("Q2", 403)], env)).toBe(false);
    expect(runtimeMode(env).kind).toBe("live");
    // Cached answers prove nothing about the key today.
    expect(noteQlooRejection([entry("Q1", 200, true), entry("Q2", 403)], env)).toBe(true);
    expect(qlooKeyRejection(env)?.httpStatus).toBe(403);
    expect(runtimeMode(env).kind).toBe("fixture");
    resetKeyStatusMemo();
  });
});

describe("input", () => {
  it("reads Ticketmaster URLs, preset ids and free text", () => {
    expect(tmEventIdFrom("https://www.ticketmaster.com/some-show/event/1A005F8C9B1D2E3F")).toBe("1A005F8C9B1D2E3F");
    expect(tmEventIdFrom("https://evil.example/event/1A005F8C9B1D2E3F")).toBeNull();
    const p = (v: unknown) => parsePlanBody(v, ["g1-a", "g2"]);
    expect(p({ event: "g2" })).toMatchObject({ ok: true, value: { presetId: "g2" } });
    expect(p({ event: "Zach Bryan @ The Truth, Nov 28 2026" })).toMatchObject({ ok: true, value: { freeText: "Zach Bryan @ The Truth, Nov 28 2026" } });
    expect(p({ presetId: "g1-a", event: "x" }).ok).toBe(false);
    expect(p({ presetId: "g1-a", picks: [{ input: "Sidecar", entityId: "abc-123" }] })).toMatchObject({ ok: true, value: { picks: [{ input: "Sidecar", entityId: "abc-123" }] } });
    expect(p({ event: "someone@example.com" }).ok).toBe(false);
  });

  it("refuses political candidates and campaigns, like the MCP tools", () => {
    const p = (v: unknown) => parsePlanBody(v, ["g1-a", "g2"]);
    expect(p({ event: "Campaign rally @ Hampton Coliseum, Nov 28 2026" })).toMatchObject({ ok: false, reason: POLITICAL_REFUSAL });
    expect(p({ presetId: "g1-a", partners: ["Jane Doe for Senate HQ"] })).toMatchObject({ ok: false, reason: POLITICAL_REFUSAL });
    expect(parseOperator({ declaredPartners: [{ label: "Get out the vote volunteers" }] })).toMatchObject({ ok: false, reason: POLITICAL_REFUSAL });
    expect(p({ event: "Monster Truck Rally @ Hampton Coliseum, Nov 28 2026" }).ok).toBe(true);
  });

  it("accepts only bounded operator what-ifs and no contact addresses", () => {
    expect(parseOperator({ seatsLeft: 1200, streetTeamDays: ["Thursday"], radiusKm: 30 })).toEqual({ ok: true, value: { seatsLeft: 1200, streetTeamDays: ["thursday"], radiusKm: 30 } });
    expect(parseOperator({ seatsLeft: -1 }).ok).toBe(false);
    expect(parseOperator({ radiusKm: 500 }).ok).toBe(false);
    expect(parseOperator({ declaredPartners: [{ label: "boss@venue.example" }] }).ok).toBe(false);
    expect(parseOperator({ alreadyReachedZips: [{ zip: "37206", count: 14 }] }).ok).toBe(true);
  });

  it("reads the client IP and the session cookie", () => {
    const h = new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1", cookie: "a=1; hl_sid=abcdefghijklmnopqrstuv" });
    expect(clientIp(h)).toBe("198.51.100.4");
    expect(clientIp(new Headers({ "fly-client-ip": "192.0.2.9", "x-forwarded-for": "1.1.1.1" }))).toBe("192.0.2.9");
    expect(parseCookies(h.get("cookie")).hl_sid).toBe("abcdefghijklmnopqrstuv");
    expect(parseCookies("other=%E0%A4%A; hl_sid=abcdefghijklmnopqrstuv").hl_sid).toBe("abcdefghijklmnopqrstuv");
    expect(sessionCookie("abc", true)).toMatch(/HttpOnly; SameSite=Lax; Secure$/);
  });
});

describe("partner house ranks (tonight vs house)", () => {
  it("adds one twin call per partner pool and a cited chip on every partner", async () => {
    const v = await loadPlan("g1-a", { view: "api" });
    expect(v?.kind).toBe("sheet");
    if (v?.kind !== "sheet") return;
    const s = v.sheet;
    expect(v.fixtureSource).toBe("engine");
    expect(validateSheet(s)).toEqual([]);
    const ids = new Set(s.ledger.map((e) => e.id));
    for (const p of s.cards.partners.results) {
      const chip = p.chips.find((c) => c.label.startsWith(TWIN_CHIP_PREFIX));
      expect(chip, p.entity.name).toBeDefined();
      expect(ids.has(chip!.ledgerRef)).toBe(true);
    }
    const twins = s.ledger.filter((e) => (e.note ?? "").includes("node Q9 house twin"));
    expect(twins).toHaveLength(new Set(s.cards.partners.results.map((p) => p.tileGeohash)).size);
    // The twin swaps only the signal: same tile point, radius and category filters as its Q9 pool.
    const q9 = s.ledger.find((e) => (e.note ?? "").includes("node Q9 partners, tile 1"));
    expect(twins[0]?.params["filter.location"]).toBe(q9?.params["filter.location"]);
    expect(twins[0]?.params["signal.interests.entities"]).toEqual(houseSignalOf(s.ledger)?.["signal.interests.entities"]);
    expect(s.cards.partners.limits.some((l) => /usual-crowd rank comes from the same Qloo search/.test(l))).toBe(true);
  });

  it("is idempotent, and labels places missing from the house list", async () => {
    const v = await loadPlan("g2", { view: "api" });
    if (v?.kind !== "sheet") throw new Error("g2 missing");
    const again = await addPartnerHouseRanks(v.sheet, { withLedger: () => { throw new Error("must not call"); } } as never, { fixture: true });
    expect(again.calls).toBe(0);
    expect(again.skipped).toBe("already added");
    // G3 has no usual crowd (no roster, and comedy has no genre-wide map), so there is no twin to add.
    const g3 = await loadPlan("g3", { view: "api" });
    if (g3?.kind !== "sheet") throw new Error("g3 missing");
    const none = await addPartnerHouseRanks(g3.sheet, { withLedger: () => { throw new Error("must not call"); } } as never, { fixture: true });
    expect(none.calls).toBe(0);
    expect(none.skipped).toMatch(/no house signal/);
    expect(twinChipLabel(5, 50)).toBe("tonight vs house +5 ranks");
    expect(twinChipLabel(-2, 50)).toBe("tonight vs house -2 ranks");
    expect(twinChipLabel(null, 50)).toBe("tonight vs house: not in the house top 50");
    const sink = continueLedger(v.sheet.ledger);
    const id = sink.add({ ...v.sheet.ledger[0]!, kind: "action" } as Omit<LedgerEntry, "id">);
    expect(id).toBe("A1");
  });
});

describe("plans", () => {
  it("serves cached presets as sheets, and the G2 page as its recorded pause", async () => {
    const page = await loadPlan("g2", { view: "page" });
    expect(page?.kind).toBe("paused");
    if (page?.kind === "paused") {
      expect(page.pause.pending.map((p) => p.input)).toEqual(["Sidecar"]);
      expect(page.pause.pending[0]!.candidates.length).toBeGreaterThanOrEqual(2);
      expect(page.pause.ledger.length).toBeGreaterThan(0);
    }
    const api = await loadPlan("g2", { view: "api" });
    expect(api?.kind).toBe("sheet");
    expect(await loadPlan("nope-123", { view: "api" })).toBeNull();
    expect(await loadPlan("../etc", { view: "api" })).toBeNull();
  });

  it("runs a preset end to end on the fixture world (sync), cards in spec order, with the house chip", async () => {
    const res = await startPlan({ presetId: "g1-b" }, ctx());
    expect(res.status).toBe(200);
    const body = res.body as Body;
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("fixture");
    const sheet = body.results as StreetSheet;
    expect(validateSheet(sheet)).toEqual([]);
    expect(sheet.cards.partners.results.every((p) => p.chips.some((c) => c.label.startsWith(TWIN_CHIP_PREFIX)))).toBe(true);
    expect(sheet.control?.arm).toBe("F");
    const run = getRun(String(body.planId));
    expect(run?.cards.map((c) => c.key)).toEqual([...CARD_ORDER]);
    // Stored, so it reloads after the run registry forgets it.
    expect((await stores().plans.get(String(body.planId)))?.sheet?.cards.partners.results[0]?.chips.some((c) => c.label.startsWith(TWIN_CHIP_PREFIX))).toBe(true);
    const snap = await planSnapshot(String(body.planId), ctx());
    expect((snap.body as Body).status).toBe("complete");
  });

  it("limits fixture runs per network (each one is stored)", async () => {
    const ip = "198.51.100.201";
    for (let i = 0; i < 30; i++) rateLimit("fixture-run", ip, 30, 3_600_000);
    const r = await startPlan({ presetId: "g3", wait: "none" }, ctx({ ip }));
    expect(r.status).toBe(429);
    expect((r.body as Body).reason).toMatch(/fixture runs/);
    expect((await resolvePlan("g2", { picks: [{ input: "Sidecar", entityId: "00002bea-860e-4dac-80f3-aa013b0ccb5b", proxy: true }] }, ctx({ ip }))).status).toBe(429);
  });

  it("refuses free-form runs in fixture mode (503) and unknown presets (400)", async () => {
    const r1 = await startPlan({ event: "Zach Bryan @ The Truth, Nov 28 2026" }, ctx());
    expect(r1.status).toBe(503);
    expect((r1.body as Body).mode).toBe("fixture");
    expect((await startPlan({ tmEventId: "vvG1zZ9abc" }, ctx())).status).toBe(503);
    expect((await startPlan({ presetId: "g9" }, ctx())).status).toBe(400);
  });

  it("pauses G2 for a pick, refuses picks that were not offered, resumes with one that was, and remembers it per session", async () => {
    const res = await startPlan({ presetId: "g2" }, ctx({ sessionId: "session-g2-aaaaaaaa" }));
    const body = res.body as Body & { pending: { input: string; candidates: { entityId: string; subtype: string }[] }[] };
    expect(body.status).toBe("needs_input");
    expect(body.results).toBeNull();
    const id = String(body.planId);
    const bad = await resolvePlan(id, { picks: [{ input: "Sidecar", entityId: "0000dead-beef" }] }, ctx());
    expect(bad.status).toBe(400);
    const wrongName = await resolvePlan(id, { picks: [{ input: "Dorian", entityId: "x" }] }, ctx());
    expect(wrongName.status).toBe(400);
    const comedian = body.pending[0]!.candidates.find((c) => c.subtype === "urn:entity:person")!;
    const ok = await resolvePlan(id, { picks: [{ input: "Sidecar", entityId: comedian.entityId }], wait: "complete" }, ctx({ sessionId: "session-g2-aaaaaaaa" }));
    expect(ok.status).toBe(200);
    const done = ok.body as Body;
    expect(done.planId).toBe(id);
    expect(done.status).not.toBe("needs_input");
    const row = (done.results as StreetSheet).cards.resolution.results.find((r) => r.input === "Sidecar");
    expect(row?.status).toBe("exact");
    expect(row?.entity?.entityId).toBe(comedian.entityId);
    // The same session does not pause again; another session does.
    expect(((await startPlan({ presetId: "g2" }, ctx({ sessionId: "session-g2-aaaaaaaa" }))).body as Body).status).not.toBe("needs_input");
    expect(((await startPlan({ presetId: "g2" }, ctx({ sessionId: "session-g2-bbbbbbbb" }))).body as Body).status).toBe("needs_input");
    expect(((await startPlan({ presetId: "g2" }, ctx({ sessionId: null }))).body as Body).status).toBe("needs_input");
    // A complete plan has nothing to resolve.
    expect((await resolvePlan(id, { picks: [{ input: "Sidecar", entityId: comedian.entityId }] }, ctx())).status).toBe(409);
  });

  it("answers the preset's recorded pause with a new run, and labels a proxy title as a proxy seed", async () => {
    const r = await resolvePlan("g2", { picks: [{ input: "Sidecar", entityId: "00002bea-860e-4dac-80f3-aa013b0ccb5b", proxy: true }], wait: "complete" }, ctx({ sessionId: null }));
    expect(r.status).toBe(200);
    const body = r.body as Body;
    expect(body.planId).not.toBe("g2");
    const res = (body.results as StreetSheet).cards.resolution;
    const row = res.results.find((x) => x.input === "Sidecar");
    expect(row?.status).toBe("proxy");
    expect(row?.proxy?.entity.subtype).toBe("urn:entity:tv_show");
    expect(row?.proxy?.reason).toMatch(/None of the candidates/);
    expect(res.status).toBe("partial");
  });

  it("relabels only the acts the operator answered with a proxy", () => {
    const fake = { cards: { resolution: { status: "ok", summary: "s.", reason: undefined, provenance: [], limits: [], results: [
      { input: "A", role: "support", status: "exact", entity: { entityId: "t1", name: "Title", subtype: "urn:entity:movie", popularity: 0.5, affinity: null, tags: [], properties: { release_year: 1999 } } },
      { input: "B", role: "headliner", status: "exact", entity: { entityId: "b1", name: "B", subtype: "urn:entity:artist", popularity: 0.5, affinity: null, tags: [], properties: {} } },
    ] } } } as unknown as StreetSheet;
    const out = applyProxyPicks(fake, { A: "t1" });
    expect(out.cards.resolution.results[0]?.status).toBe("proxy");
    expect(out.cards.resolution.results[0]?.proxy?.reason).toMatch(/Title \(film, 1999\)/);
    expect(out.cards.resolution.results[1]?.status).toBe("exact");
    expect(out.cards.resolution.status).toBe("partial");
    expect(applyProxyPicks(fake, {})).toBe(fake);
  });
});

describe("stream", () => {
  it("replays a cached sheet as start, nine cards in order, done", async () => {
    const v = await loadPlan("g3", { view: "api" });
    if (!v || v.kind === "running") throw new Error("g3");
    const frames = staticFrames(v).map((f) => f.split("\n")[0]);
    expect(frames[0]).toBe("event: start");
    expect(frames.filter((f) => f === "event: card")).toHaveLength(9);
    expect(frames.at(-1)).toBe("event: done");
  });

  it("follows a running plan to the end, cards in CARD_ORDER with nothing repeated", async () => {
    const res = await startPlan({ presetId: "g3", wait: "none" }, ctx());
    expect(res.status).toBe(202);
    const id = String((res.body as Body).planId);
    const stream = await planEventStream(id, null);
    expect(stream).not.toBeNull();
    const frames = await readFrames(stream!);
    expect(frames[0]?.event).toBe("start");
    const keys = frames.filter((f) => f.event === "card").map((f) => f.data.key);
    expect(keys).toEqual([...CARD_ORDER]);
    expect(frames.at(-1)).toMatchObject({ event: "done", data: { status: "complete" } });
    expect(await planEventStream("does-not-exist", null)).toBeNull();
  });

  it("streams a pause as the resolution card plus needs_input", async () => {
    const stream = await planEventStream("g2", null);
    const frames = await readFrames(stream!);
    expect(frames.map((f) => f.event)).toEqual(["start", "card", "needs_input", "done"]);
    expect(frames[3]?.data.status).toBe("needs_input");
  });
});

describe("send (demo: no mail keys)", () => {
  const seams = () => ({
    prepare: { config: resolveSendConfig({ WALKUP_SIGNING_SECRET: "x".repeat(40) }), store },
    confirm: { config: resolveSendConfig({ WALKUP_SIGNING_SECRET: "x".repeat(40) }), store },
  });
  const store = createMemorySendStore();

  it("previews without logging, then records one A# entry kept with a stored plan", async () => {
    const run = await startPlan({ presetId: "g1-a" }, ctx());
    const planId = String((run.body as Body).planId);
    const prep = await prepareSendFor({ planId }, ctx(), seams());
    expect(prep.status).toBe(200);
    const p = prep.body as { status: string; confirmToken: string; preview: { mode: string; recipients: { address: string }[]; attachments: { filename: string }[] } };
    expect(p.preview.mode).toBe("demo");
    expect(p.preview.recipients.map((r) => r.address)).toEqual(["delivered@resend.dev"]);
    expect(p.preview.attachments.map((a) => a.filename)).toEqual(["fixture-street-sheet.pdf", "fixture-street-team.ics", "fixture-partners.csv"]);
    expect((await stores().plans.get(planId))?.sheet?.ledger.some((e) => e.kind === "action")).toBe(false);

    const conf = await confirmSendFor({ planId, confirmToken: p.confirmToken }, ctx(), seams());
    const c = conf.body as { status: string; ledgerEntryId: string; ledgerEntry: LedgerEntry; kept: string };
    expect(c.status).toBe("demo_not_sent");
    expect(c.ledgerEntryId).toBe("A1");
    expect(c.kept).toBe("plan");
    expect(c.ledgerEntry.note).toMatch(/^demo: not sent/);
    const stored = await stores().plans.get(planId);
    expect(stored?.sheet?.ledger.filter((e) => e.kind === "action").map((e) => e.id)).toEqual(["A1"]);
    // A replayed token is refused and still recorded (A2).
    const replay = (await confirmSendFor({ planId, confirmToken: p.confirmToken }, ctx(), seams())).body as { status: string; ledgerEntryId: string };
    expect(replay.status).toBe("refused");
    expect(replay.ledgerEntryId).toBe("A2");
  });

  it("keeps a preset's send with the visitor's session only, and takes typed copies once", async () => {
    const prep = await prepareSendFor({ planId: "g3", copyTo: "lead@crew.example" }, ctx(), seams());
    const p = prep.body as { confirmToken: string; preview: { recipients: { source: string }[] } };
    expect(p.preview.recipients.map((r) => r.source)).toEqual(["test_inbox", "typed"]);
    const c = (await confirmSendFor({ planId: "g3", confirmToken: p.confirmToken }, ctx(), seams())).body as { kept: string; ledgerEntry: LedgerEntry };
    expect(c.kept).toBe("session");
    expect(JSON.stringify(c.ledgerEntry)).not.toContain("lead@crew.example");
    expect(sessionActions("g3", "test-session-0000001")).toHaveLength(1);
    expect(sessionActions("g3", "someone-else-00000001")).toHaveLength(0);
    const other = await loadPlan("g3", { view: "api", sessionId: "someone-else-00000001" });
    expect(other?.kind === "sheet" && other.sheet.ledger.some((e) => e.kind === "action")).toBe(false);
  });

  it("refuses unknown plans, untyped recipient shapes and too many previews", async () => {
    expect((await prepareSendFor({ planId: "nope-0001" }, ctx(), seams())).status).toBe(404);
    expect((await prepareSendFor({ planId: "g3", copyTo: [1, 2] }, ctx(), seams())).status).toBe(400);
    expect((await prepareSendFor({ planId: "g3", attachments: ["zip"] }, ctx(), seams())).status).toBe(400);
    expect((await confirmSendFor({ planId: "g3" }, ctx(), seams())).status).toBe(400);
    for (let i = 0; i < 30; i++) rateLimit("send-prepare", "198.51.100.200", 30, 3_600_000);
    expect((await prepareSendFor({ planId: "g3" }, ctx({ ip: "198.51.100.200" }), seams())).status).toBe(429);
  });
});

describe("exports", () => {
  it("maps file names to export kinds", () => {
    expect(exportKind("pdf")).toBe("pdf");
    expect(exportKind("offer-codes.csv")).toBe("offerCodes");
    expect(exportKind("ics")).toBe("ics");
    expect(exportKind("constructor")).toBeNull();
    expect(exportKind("../x")).toBeNull();
  });

  it("serves the one-page PDF and the CSVs with fixture- file names", async () => {
    const v = await loadPlan("g1-a", { view: "api" });
    if (v?.kind !== "sheet") throw new Error("g1-a");
    const pdf = await exportResponse(v.sheet, "pdf", { ledgerUrl: "https://walkup.example/plan/g1-a#ledger" });
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="fixture-street-sheet.pdf"');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    const zips = await exportResponse(v.sheet, "zips");
    expect((await zips.text()).split("\r\n")[0]).toBe("zip,lift_score,suggested_weight");
    const ics = await exportResponse(v.sheet, "ics");
    expect(await ics.text()).toMatch(/^BEGIN:VCALENDAR/);
  }, 120_000);
});

describe("caps", () => {
  it("allows 3 fresh runs per network and 15 per day, resets at UTC midnight, and refunds", () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const l = new FreshRunLimiter({ file: null, now: () => now, env: { WALKUP_SIGNING_SECRET: "s".repeat(40) } });
    for (let i = 0; i < 3; i++) expect(l.take("198.51.100.1").allowed).toBe(true);
    const blocked = l.take("198.51.100.1");
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/3 per network/);
    expect(blocked.you.remaining).toBe(0);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) l.take(`198.51.100.${10 + i}`);
    expect(l.status("198.51.100.99").total.remaining).toBe(0);
    expect(l.take("198.51.100.99").reason).toMatch(/15 fresh runs/);
    l.refund("198.51.100.1", "2026-11-01");
    expect(l.status("198.51.100.1").you.remaining).toBe(1);
    now = Date.parse("2026-11-02T00:00:01Z");
    expect(l.status("198.51.100.1").you.remaining).toBe(3);
    expect(l.status(null).total.remaining).toBe(15);
  });

  it("keeps rate windows per bucket and IP", () => {
    expect(rateLimit("t", "a", 2, 1000, 0).ok).toBe(true);
    expect(rateLimit("t", "a", 2, 1000, 10).ok).toBe(true);
    expect(rateLimit("t", "a", 2, 1000, 20).ok).toBe(false);
    expect(rateLimit("t", "b", 2, 1000, 20).ok).toBe(true);
    expect(rateLimit("t", "a", 2, 1000, 1500).ok).toBe(true);
  });
});

describe("live mode (keys present; the fixture world stands in for the live transports)", () => {
  let world: ReturnType<typeof createWorld>;
  beforeAll(() => {
    process.env.QLOO_API_KEY = "test-not-a-key";
    process.env.TICKETMASTER_API_KEY = "test-not-a-key";
    world = createWorld();
    const st = stores();
    setEngineForTests({ live: createFixtureDeps({ world, store: st.plans, choices: st.choices }) });
    setFreshRunsForTests(new FreshRunLimiter({ file: null }));
  });
  afterAll(() => {
    delete process.env.QLOO_API_KEY;
    delete process.env.TICKETMASTER_API_KEY;
    setEngineForTests({ live: null });
    setFreshRunsForTests(new FreshRunLimiter({ file: null }));
  });

  it("turns free text into one Ticketmaster event, counts fresh runs per network, and caps at 3", async () => {
    expect(runtimeMode().kind).toBe("live");
    const hits = await searchShows(depsFor("live"), "Hollis Creek String Band, Nov 20 2026", "2026-10-30");
    expect(hits.hits.map((h) => h.tmEventId)).toEqual([WORLD_EVENT_IDS.g1a]);
    const ip = "198.51.100.77";
    const first = await startPlan({ event: "Hollis Creek String Band, Nov 20 2026" }, ctx({ ip }));
    expect(first.status).toBe(200);
    expect((first.body as Body).freshRuns).toMatchObject({ youRemaining: 2, todayRemaining: 14 });
    expect((await startPlan({ tmEventId: WORLD_EVENT_IDS.g1b, wait: "none" }, ctx({ ip }))).status).toBe(202);
    expect((await startPlan({ tmEventId: WORLD_EVENT_IDS.g2, wait: "none" }, ctx({ ip }))).status).toBe(202);
    const blocked = await startPlan({ tmEventId: WORLD_EVENT_IDS.g3 }, ctx({ ip }));
    expect(blocked.status).toBe(429);
    expect((blocked.body as Body).reason).toMatch(/per network/);
    // Several matches: the caller picks one.
    const many = await startPlan({ event: "The Truth" }, ctx({ ip: "198.51.100.78" }));
    expect([404, 409]).toContain(many.status);
  });

  it("serves a preset from its stored run without counting it", async () => {
    const ip = "198.51.100.90";
    const run = await startPlan({ presetId: "g1-a" }, ctx({ ip }));
    expect(run.status).toBe(200);
    const again = await startPlan({ presetId: "g1-a" }, ctx({ ip }));
    expect((again.body as Body).servedFromStore).toBe(true);
    expect((again.body as Body).planId).toBe((run.body as Body).planId);
    const v = await loadPlan("g1-a", { view: "page" });
    expect(v?.kind === "sheet" && v.source).toBe("store");
  });

  it("never serves one caller's what-ifs, partner list or up-front picks as the preset to everyone", async () => {
    const canonical = await startPlan({ presetId: "g1-b" }, ctx({ ip: "198.51.100.92" }));
    const canonicalId = String((canonical.body as Body).planId);
    const custom = await startPlan(
      { presetId: "g1-b", operator: { seatsLeft: 99, declaredPartners: [{ label: "Anything a visitor typed" }] } },
      ctx({ ip: "198.51.100.93" }),
    );
    expect(custom.status).toBe(200);
    const customId = String((custom.body as Body).planId);
    expect(customId).not.toBe(canonicalId);
    // The custom run is still the caller's own sheet...
    const own = await loadPlan(customId, { view: "api" });
    expect(own?.kind === "sheet" && own.sheet.operator.seatsLeft).toBe(99);
    expect(own?.kind === "sheet" && own.presetId).toBe("g1-b");
    // ...but the preset everyone sees stays the run with the preset's own inputs.
    const shared = await loadPlan("g1-b", { view: "page" });
    expect(shared?.kind === "sheet" && shared.planId).toBe(canonicalId);
    expect(((await startPlan({ presetId: "g1-b" }, ctx({ ip: "198.51.100.94" }))).body as Body).planId).toBe(canonicalId);
  });

  it("stops fresh runs when the Qloo month quota is at its floor", async () => {
    world.setScenario({ quotaRemaining: 1400 });
    await depsFor("live").qloo.withLedger(createMemoryLedger()).search("Marla Vane", ["artist"], { take: 1 });
    expect(depsFor("live").qloo.guardTripped()).toBe(true);
    const r = await startPlan({ tmEventId: WORLD_EVENT_IDS.g2 }, ctx({ ip: "198.51.100.91" }));
    expect(r.status).toBe(429);
    expect((r.body as Body).reason).toMatch(/quota/);
    world.resetScenario();
  });
});

describe("/healthz", () => {
  it("answers ok in fixture mode with key presence only and no reachability calls", () => {
    const r = health();
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown> & { reachability: Record<string, { status: string }>; configured: Record<string, boolean> };
    expect(b.ok).toBe(true);
    expect(b.mode).toBe("fixture");
    expect(b.configured.qloo).toBe(false);
    expect(b.reachability.qloo?.status).toBe("not checked in fixture mode");
    expect(b.qlooMonthlyRemaining).toBeNull();
    expect(JSON.stringify(b)).not.toMatch(/api[_-]?key"\s*:\s*"[^$]/i);
  });
});
