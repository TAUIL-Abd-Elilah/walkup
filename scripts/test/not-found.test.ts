/**
 * The probe's not_found handling: Qloo can list an act under /search and still have no taste data for it
 * (live, Oct 15: a 200 with warnings[{type:"not_found","signal.interests.entities":[id]}], or a 400 that
 * blames signal.interests.entities when every id is unknown). The resolver checks candidates with one
 * place-insights call and skips dropped ids; the runner marks a probe inconclusive when a probe call itself
 * had a signal dropped. Bodies here are small and SYNTHETIC (fake ids, invented names).
 */

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ProbeClient, type Transport } from "../lib/probe/client.js";
import { type ActCfg, type ProbeConfig, loadConfig } from "../lib/probe/config.js";
import { errorPaths, searchEntities, signalWarnings } from "../lib/probe/extract.js";
import { CallBudget } from "../lib/probe/limiter.js";
import { extendsName } from "../lib/probe/names.js";
import { canonicalKey } from "../lib/probe/requests.js";
import { flagDroppedSignals } from "../lib/probe/runner.js";
import { orderCandidates, resolveAct, resolveActs, resolveBill, substitutionLines } from "../lib/probe/shared.js";
import type { CallRecord, CallResult, ProbeContext, RequestSpec } from "../lib/probe/types.js";

const CONFIG_PATH = fileURLToPath(new URL("../probe.config.json", import.meta.url));
const SOLO = "00000000-0000-4000-8000-0000000000a1";
const BAND = "00000000-0000-4000-8000-0000000000a2";
const OTHER = "00000000-0000-4000-8000-0000000000b1";

const search = (rows: { id: string; name: string }[]) => ({
  synthetic: true,
  results: rows.map((r) => ({ entity_id: r.id, name: r.name, types: ["urn:entity:artist"], popularity: 0.8, properties: {}, tags: [] })),
});

function cfg(): ProbeConfig {
  const c = loadConfig(CONFIG_PATH);
  for (const v of Object.values(c.venues)) {
    v.lat = v.lat ?? 36.1;
    v.lon = v.lon ?? -86.7;
  }
  return c;
}

/** A fake ProbeContext over a router; memoizes like the real client and records every call. */
function fakeCtx(route: (spec: RequestSpec) => { status: number; json: unknown }, dryRun = false): { ctx: ProbeContext; calls: RequestSpec[] } {
  const calls: RequestSpec[] = [];
  const memo = new Map<string, CallResult>();
  const ctx: ProbeContext = {
    dryRun,
    cfg: cfg(),
    state: {},
    log: () => {},
    readOptionalJson: () => null,
    async call(spec) {
      const key = canonicalKey(spec);
      const hit = memo.get(key);
      if (hit) return hit;
      calls.push(spec);
      const record = { seq: calls.length, label: spec.label, method: spec.method, path: spec.path, params: spec.params, status: null, ms: 0, bytes: 0, attempts: 0, memo: false, headers: {} } as CallRecord;
      const r: CallResult = dryRun ? { dry: true, status: null, json: null, record } : { dry: false, ...route(spec), record };
      memo.set(key, r);
      return r;
    },
  };
  return { ctx, calls };
}

/** Qloo-like router: /search by query; insights warn about `notFound` ids (or 400 when all are unknown and `strict`). */
function router(byQuery: Record<string, { id: string; name: string }[]>, notFound: string[], strict = false) {
  return (spec: RequestSpec): { status: number; json: unknown } => {
    if (spec.path === "/search") return { status: 200, json: search(byQuery[String(spec.params.query)] ?? []) };
    const ids = String(spec.params["signal.interests.entities"] ?? "").split(",").filter(Boolean);
    const dropped = ids.filter((id) => notFound.includes(id));
    if (strict && dropped.length === ids.length) {
      return { status: 400, json: { synthetic: true, errors: [{ message: "synthetic", path: "signal.interests.entities" }] } };
    }
    return { status: 200, json: { synthetic: true, success: true, results: { entities: [] }, ...(dropped.length ? { warnings: [{ type: "not_found", "signal.interests.entities": dropped }] } : {}) } };
  };
}

const WADE: ActCfg = { name: "Wade Corley", kind: "artist" };

describe("readers", () => {
  it("signalWarnings reads the live warning shape; errorPaths reads the 4xx shape", () => {
    expect(signalWarnings({ warnings: [{ type: "not_found", "signal.interests.entities": [SOLO] }] })).toEqual([SOLO]);
    expect(signalWarnings({ warnings: [{ type: "not_found", "a.signal.interests.entities": [SOLO, SOLO] }, { type: "other", x: [BAND] }] })).toEqual([SOLO]);
    expect(signalWarnings({ results: {} })).toEqual([]);
    expect(errorPaths({ errors: [{ message: "m", path: "signal.interests.entities" }] })).toEqual(["signal.interests.entities"]);
    expect(errorPaths({ error: { message: "old" } })).toEqual([]);
  });

  it("billing-name extensions and candidate order: exact, aliases, extensions", () => {
    expect(extendsName("Jason Isbell", "Jason Isbell and The 400 Unit")).toBe(true);
    expect(extendsName("Wade Corley", "Wade Corley & The Low Ten")).toBe(true);
    expect(extendsName("Wade Corley", "Wade Corleyson")).toBe(false);
    const list = searchEntities(search([
      { id: BAND, name: "Wade Corley and The Low Ten" },
      { id: OTHER, name: "Wade C." },
      { id: SOLO, name: "Wade Corley" },
    ]));
    expect(orderCandidates(list, { ...WADE, aliases: ["Wade C."] }).map((c) => c.e.id)).toEqual([SOLO, OTHER, BAND]);
    expect(orderCandidates(searchEntities(search([{ id: OTHER, name: "Someone Else" }])), WADE)).toEqual([{ e: expect.objectContaining({ id: OTHER }), exact: false }]);
  });
});

describe("resolveActs / resolveBill", () => {
  it("skips a not_found exact match for the billing-name entry, with one check call for the whole bill", async () => {
    const { ctx, calls } = fakeCtx(router({ "Wade Corley": [{ id: SOLO, name: "Wade Corley" }, { id: BAND, name: "Wade Corley and The Low Ten" }], "Other Act": [{ id: OTHER, name: "Other Act" }] }, [SOLO]));
    const bill = { label: "test", genre: "Americana", acts: [WADE, { name: "Other Act", kind: "artist" as const }] };
    const r = await resolveBill(ctx, bill);
    expect(r.ids).toEqual([BAND, OTHER]);
    expect(r.refs[0]).toMatchObject({ id: BAND, exact: true, droppedIds: [SOLO], substitutedFrom: "Wade Corley" });
    expect(r.refs[1]).toMatchObject({ id: OTHER, droppedIds: [], substitutedFrom: null });
    const checks = calls.filter((c) => c.path === "/v2/insights");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ purpose: "signal-check" });
    expect(checks[0]!.params).toMatchObject({ "filter.type": "urn:entity:place", take: 1, "filter.location.radius": 1500, "signal.interests.entities": `${SOLO},${BAND},${OTHER}` });
    expect(substitutionLines("bill A: ", bill.acts, r.refs)).toEqual([
      `bill A: "Wade Corley": Qloo has no taste data for the first match (${SOLO}), so "Wade Corley and The Low Ten" was used`,
    ]);
    // A second resolution of the same bill reuses the memoized calls.
    await resolveBill(ctx, bill);
    expect(calls.filter((c) => c.path === "/v2/insights")).toHaveLength(1);
  });

  it("leaves an act unresolved when every candidate is dropped (200 warnings or a 400 on the signal)", async () => {
    for (const strict of [false, true]) {
      const { ctx } = fakeCtx(router({ "Wade Corley": [{ id: SOLO, name: "Wade Corley" }] }, [SOLO], strict));
      const [r] = await resolveActs(ctx, [WADE]);
      expect(r, `strict=${strict}`).toBeNull();
    }
  });

  it("keeps the old behaviour when nothing is dropped, and resolveAct checks only when asked", async () => {
    const { ctx, calls } = fakeCtx(router({ "Wade Corley": [{ id: SOLO, name: "Wade Corley" }, { id: BAND, name: "Wade Corley and The Low Ten" }] }, []));
    expect((await resolveAct(ctx, WADE))?.id).toBe(SOLO);
    expect(calls.every((c) => c.path === "/search")).toBe(true);
    expect((await resolveAct(ctx, WADE, undefined, { check: true }))?.id).toBe(SOLO);
    expect(calls.filter((c) => c.path === "/v2/insights")).toHaveLength(1);
  });

  it("plans the check in a dry run with placeholder ids", async () => {
    const { ctx, calls } = fakeCtx(() => ({ status: 200, json: {} }), true);
    const refs = await resolveActs(ctx, [WADE]);
    expect(refs[0]).toMatchObject({ placeholder: true });
    expect(calls.map((c) => c.path)).toEqual(["/search", "/v2/insights"]);
    expect(String(calls[1]!.params["signal.interests.entities"])).toBe("{{artist:Wade Corley}}");
  });
});

describe("runner and client", () => {
  const rec = (over: Partial<CallRecord>): CallRecord => ({ seq: 1, label: "scored", method: "GET", path: "/v2/insights", params: {}, status: 200, ms: 0, bytes: 0, attempts: 1, memo: false, headers: {}, ...over });

  it("a probe call with a dropped signal makes pass/partial/fail inconclusive; signal checks do not", () => {
    const base = { status: "pass" as const, headline: "ok", lines: [], derived: {} };
    const flagged = flagDroppedSignals(base, [rec({ notFound: [SOLO] })]);
    expect(flagged.status).toBe("inconclusive");
    expect(flagged.lines).toEqual([`Qloo ignored signal ${SOLO} on 'scored' (not_found)`]);
    expect(flagged.derived.droppedSignals).toEqual([SOLO]);
    expect(flagDroppedSignals(base, [rec({ notFound: [SOLO], purpose: "signal-check" })])).toBe(base);
    expect(flagDroppedSignals({ ...base, status: "info" }, [rec({ notFound: [SOLO] })]).status).toBe("info");
  });

  it("ProbeClient records not_found ids on 2xx and blamed params on 4xx (ids and names only)", async () => {
    const replies = [
      { status: 200, text: JSON.stringify({ synthetic: true, results: { entities: [] }, warnings: [{ type: "not_found", "signal.interests.entities": [SOLO] }] }) },
      { status: 400, text: JSON.stringify({ synthetic: true, errors: [{ message: "synthetic", path: "signal.interests.entities" }] }) },
    ];
    let i = 0;
    const transport: Transport = async () => ({ ...replies[i++]!, headers: {} });
    const client = new ProbeClient({ baseUrl: "https://api.example.test", apiKey: "test-key-not-real-000", dryRun: false, budget: new CallBudget(5), transport, maxRetries: 0, timeoutMs: 1000, minMonthRemaining: 0 });
    const a = await client.call({ method: "GET", path: "/v2/insights", params: { "signal.interests.entities": SOLO, take: 1 }, label: "a", purpose: "signal-check" });
    expect(a.record).toMatchObject({ notFound: [SOLO], purpose: "signal-check" });
    const b = await client.call({ method: "GET", path: "/v2/insights", params: { "signal.interests.entities": BAND, take: 1 }, label: "b" });
    expect(b.record.errorPaths).toEqual(["signal.interests.entities"]);
    expect(b.record.notFound).toBeUndefined();
  });
});
