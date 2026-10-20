/**
 * The live code path against an in-process fake API that returns SYNTHETIC
 * bodies generated below (no real API, no network). Covers derivation,
 * retries, the budget cap, the monthly-quota floor and the output files.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { rawBodyReason } from "../check-no-raw.mjs";
import type { Transport } from "../lib/probe/client.js";
import { type ProbeConfig, loadConfig } from "../lib/probe/config.js";
import { writeOutputs } from "../lib/probe/output.js";
import { runProbes } from "../lib/probe/runner.js";
import { gateLines, renderSummary } from "../lib/probe/summary.js";

const CONFIG_PATH = fileURLToPath(new URL("../probe.config.json", import.meta.url));
const KEY = "test-key-not-real-0123456789";
const BASE = "https://api.example.test";
const A32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

function shuffle<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function cells(seed: number, n = 400): unknown[] {
  return Array.from({ length: n }, (_, i) => {
    const pop = ((i * 37) % n) / n;
    const own = ((i * ((seed % 50) * 2 + 7)) % n) / n;
    return {
      location: { latitude: 36, longitude: -86, geohash: `dn6m${A32[i % 32]}${A32[Math.floor(i / 32) % 32]}0` },
      query: { affinity: seed === 0 ? pop : 0.5 * pop + 0.5 * own, affinity_rank: 0.5, popularity: pop },
    };
  });
}

function entity(id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { entity_id: id, name, type: "urn:entity", ...extra };
}

/** Routes one synthetic request. Returns null for "not found". */
function route(path: string, q: Record<string, unknown>): unknown {
  const s = (k: string): string => (q[k] === undefined ? "" : typeof q[k] === "string" ? (q[k] as string) : JSON.stringify(q[k]));
  if (path === "/search") {
    const name = s("query");
    const types = s("types");
    const tags =
      types === "urn:entity:brand"
        ? [{ id: "urn:tag:genre:brand:sports_organization", name: "Sports organization" }]
        : types === "urn:entity:person"
          ? [{ id: "urn:tag:genre:person:comedian", name: "Comedian" }]
          : [];
    const near = s("filter.location").split(",").map(Number);
    const location = near.length === 2 ? { lat: near[0], lon: near[1] } : undefined;
    return { results: [entity(`E:${slug(name)}`, name, { types: [types], popularity: 0.8, tags, ...(location ? { location } : {}) })] };
  }
  if (path === "/entities") {
    const ids = (s("entity_ids") || s("external.spotify.ids")).split(",").filter(Boolean);
    return { results: ids.map((id) => entity(id.startsWith("E:") ? id : `E:${id}`, id, { tags: [{ id: "urn:tag:genre:brand:sports_organization", name: "x" }] })) };
  }
  if (path === "/v2/tags") {
    const query = s("filter.query");
    const parent = s("filter.parents.types").replace("urn:entity:", "") || "media";
    return { results: { tags: [{ id: `urn:tag:genre:${parent}:${slug(query)}`, name: query, parents: [{ type: s("filter.parents.types") }] }] } };
  }
  if (path === "/v2/audiences") {
    return { results: { audiences: [{ id: `urn:audience:communities:${slug(s("filter.query"))}`, name: s("filter.query") }] } };
  }
  if (path === "/v2/analysis/compare") {
    const tag = (i: number) => ({ tag_id: `urn:tag:keyword:media:k${i}`, name: `keyword ${i}`, subtype: "urn:tag:keyword:media" });
    return { results: { tags: [tag(0)], a: [1, 2, 3, 4, 5, 6].map(tag), b: [7, 8].map(tag) } };
  }
  if (path !== "/v2/insights") return null;
  const type = s("filter.type");
  const signal = s("signal.interests.entities") + s("signal.interests.tags");
  if (type === "urn:heatmap") return { results: { heatmap: cells(hash(signal) % 997) } };
  if (type === "urn:demographics") {
    return { results: { demographics: [{ entity_id: signal, query: { age: { "24_and_younger": -0.1, "25_to_29": 0.2 }, gender: { male: 0.1, female: -0.1 } } }] } };
  }
  if (type === "urn:tag") {
    return {
      results: {
        tags: [
          { tag_id: "urn:tag:keyword:media:ice_age", name: "Ice Age", query: { affinity: 0.9 } },
          { tag_id: "urn:tag:ethnicity:qloo:example", name: "example", query: { affinity: 0.8 } },
          { tag_id: "urn:tag:genre:media:comedy", name: "Comedy", query: { affinity: 0.7 } },
        ],
      },
    };
  }
  const take = Number(s("take") || 20);
  if (type === "urn:entity:place") {
    const pool = s("filter.results.entities").split(",").filter(Boolean);
    if (pool.length > 0) {
      let order: string[];
      const extra = s("signal.demographics.age") + s("signal.demographics.audiences");
      if (extra) order = shuffle(pool, hash(signal + extra));
      else if (/luke-combs|jason-isbell/.test(signal)) order = [...pool].reverse();
      else if (/sza|bad-bunny/.test(signal)) order = [...pool.slice(15), ...pool.slice(0, 15)];
      else order = shuffle(pool, hash(signal));
      return { results: { entities: order.map((id, i) => entity(id, id, { query: { affinity: 1 - i / 100 } })) } };
    }
    const names = s("filter.results.entities.query").split(",").filter(Boolean);
    if (names.length > 0) return { results: { entities: names.map((n) => entity(`E:${slug(n)}`, n, { query: { affinity: 0.5 } })) } };
    const loc = s("filter.location");
    const tagIds = s("filter.tags").split(",").filter(Boolean);
    const hours = s("filter.hours");
    const club = s("signal.interests.entities");
    let rows = Array.from({ length: Math.min(take, 30) }, (_, i) =>
      entity(`P:${hash(loc) % 1000}:${i}`, `Place ${i}`, {
        tags: tagIds.map((t) => ({ id: t, name: t })),
        properties: { hours: { Thursday: i % 5 === 0 ? [] : [{ opens: "T11:00", closes: "T23:00" }] } },
        query: { affinity: club ? 1 - i / 100 : null },
      }),
    );
    if (hours) rows = rows.filter((_, i) => i % 5 !== 0);
    if (club) rows = shuffle(rows, hash(club + loc));
    return { results: { entities: rows } };
  }
  // podcast / brand / person
  const ids = s("filter.results.entities").split(",").filter(Boolean);
  if (ids.length > 0) return { results: { entities: ids.map((id, i) => entity(id, id, { query: { affinity: 0.9 - i * 0.03, explainability: { "signal.interests.entities": [{ entity_id: signal, score: 0.5 }] } } })) } };
  const names = s("filter.results.entities.query").split(",").filter(Boolean);
  if (names.length > 0) return { results: { entities: names.map((n, i) => entity(`E:${slug(n)}`, n, { query: { affinity: 0.9 - i * 0.03 } })) } };
  const shift = s("signal.location") ? 5 : 0;
  const excluded = new Set(s("filter.exclude.tags").split(",").filter(Boolean));
  let rows = Array.from({ length: take + shift }, (_, i) =>
    entity(`X:${type}:${i}`, `Thing ${i}`, { tags: i % 3 === 0 ? [{ id: "urn:tag:genre:brand:alcohol", name: "alcohol" }] : [] }),
  ).slice(shift);
  rows = rows.filter((r) => !(r.tags as { id: string }[]).some((t) => excluded.has(t.id)));
  return { results: { entities: rows } };
}

function fakeApi(
  opts: {
    monthRemaining?: number;
    echoKey?: boolean;
    first429?: boolean;
    /** Returns an HTTP status to send instead of a body (e.g. 400 or 503), or null to answer normally. */
    failWhen?: (path: string, q: Record<string, unknown>) => number | null;
    /** Rewrites a synthetic body before it is sent (e.g. to drop tags the API did not echo). */
    mutate?: (path: string, q: Record<string, unknown>, json: unknown) => unknown;
  } = {},
) {
  let n = 0;
  let sent429 = false;
  const transport: Transport = async (req) => {
    n++;
    const u = new URL(req.url);
    const q: Record<string, unknown> = Object.fromEntries(u.searchParams);
    if (req.body) Object.assign(q, JSON.parse(req.body));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-second-ratelimit-limit": "5",
      "x-month-ratelimit-limit": "10000",
      "x-month-ratelimit-remaining": String(opts.monthRemaining ?? 9000 - n),
    };
    if (opts.echoKey) headers["x-echo"] = `seen ${req.headers["X-Api-Key"]}`;
    if (opts.first429 && !sent429) {
      sent429 = true;
      return { status: 429, headers: { ...headers, "retry-after": "0" }, text: "{}" };
    }
    const forced = opts.failWhen?.(u.pathname, q) ?? null;
    if (forced !== null) return { status: forced, headers, text: JSON.stringify({ error: "synthetic failure" }) };
    const routed = route(u.pathname, q);
    const json = routed !== null && opts.mutate ? opts.mutate(u.pathname, q, routed) : routed;
    return { status: json === null ? 404 : 200, headers, text: JSON.stringify(json ?? {}) };
  };
  return { transport, count: () => n };
}

const fastClock = () => {
  let t = Date.parse("2026-10-15T14:00:00Z");
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

function liveOpts(cfg: ProbeConfig, transport: Transport, extra: Partial<Parameters<typeof runProbes>[0]> = {}) {
  return {
    cfg,
    dryRun: false,
    only: null,
    verbose: false,
    budgetMax: 100,
    apiKey: KEY,
    baseUrl: BASE,
    transport,
    clock: fastClock(),
    log: () => {},
    readOptionalJson: () => null,
    ...extra,
  };
}

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe("live path against synthetic responses", () => {
  it("KG1 derives tau and overlaps per room and passes when the bills reorder the pool", async () => {
    const api = fakeApi();
    const r = await runProbes(liveOpts(loadConfig(CONFIG_PATH), api.transport, { only: [1] }));
    const run = r.runs[0]!;
    expect(run.outcome.status).toBe("pass");
    expect(run.outcome.headline).toBe("2/2 rooms pass (need 2)");
    const ryman = (run.outcome.derived.venues as Record<string, Record<string, unknown>>).ryman!;
    expect(ryman.poolSize).toBe(30);
    expect(ryman.topKAvsPop).toBe(0);
    expect(ryman.tauAB as number).toBeLessThan(0.8);
    expect(r.calls).toBe(api.count());
  });

  it("runs all 20 probes without errors, under the cap, with key-day inputs filled", async () => {
    const cfg = loadConfig(CONFIG_PATH);
    cfg.venues["the-truth"]!.lat = 36.15;
    cfg.venues["the-truth"]!.lon = -86.79;
    cfg.roster.spotifyIds = Array.from({ length: 10 }, (_, i) => `sp${i}`);
    const bars = cfg.kg4.bars.map((b) => ({ ...b, barName: `Supporters Bar ${b.club} ${b.metro}` }));
    const api = fakeApi();
    const r = await runProbes(liveOpts(cfg, api.transport, { readOptionalJson: () => bars }));
    expect(r.aborted).toBeNull();
    expect(r.calls).toBeLessThanOrEqual(100);
    for (const run of r.runs) expect(run.outcome.status, `#${run.def.id}: ${run.outcome.lines.join(" | ")}`).not.toMatch(/error|aborted/);
    const byId = new Map(r.runs.map((x) => [x.def.id, x.outcome]));
    expect(byId.get(2)!.derived.cells).toEqual({ billA: 400, billB: 400, house: 400, generic: 400 });
    expect(byId.get(3)!.derived.resolved).toBe(9);
    expect(byId.get(7)!.derived.ethnicityTagsPresent).toBe(1);
    expect((byId.get(7)!.derived.markerHits as Record<string, number>)["ice age"]).toBe(1);
    expect(byId.get(10)!.status).toBe("pass");
    expect(byId.get(11)!.status).toBe("pass");
    expect(byId.get(12)!.status).toBe("pass");
    expect(byId.get(13)!.status).toBe("pass");
    expect(byId.get(15)!.status).toBe("pass");
    expect(byId.get(18)!.status).toBe("pass");
    expect(byId.get(20)!.derived.path).toBe("name-query");
    expect(gateLines(r).join("\n")).toMatch(/KG1 .*: GO/);
    const md = renderSummary(r, { baseHost: "api.example.test", configPath: "scripts/probe.config.json", only: null });
    expect(md).toContain("| 1 | KG1: taste moves partners |");
  });

  it("retries a 429 once and counts both attempts against the budget", async () => {
    const api = fakeApi({ first429: true });
    const r = await runProbes(liveOpts(loadConfig(CONFIG_PATH), api.transport, { only: [5] }));
    const first = r.runs[0]!.requests[0]!;
    expect(first.attempts).toBe(2);
    expect(first.status).toBe(200);
    expect(r.calls).toBe(api.count());
  });

  it("aborts the run at the call cap and marks later probes not run", async () => {
    const api = fakeApi();
    const r = await runProbes(liveOpts(loadConfig(CONFIG_PATH), api.transport, { only: [1, 2], budgetMax: 3 }));
    expect(api.count()).toBe(3);
    expect(r.aborted).toMatch(/budget of 3/);
    expect(r.runs.map((x) => x.outcome.status)).toEqual(["aborted", "aborted"]);
  });

  it("stops when the monthly quota is below the floor", async () => {
    const api = fakeApi({ monthRemaining: 1000 });
    const r = await runProbes(liveOpts(loadConfig(CONFIG_PATH), api.transport, { only: [5] }));
    expect(api.count()).toBe(1);
    expect(r.aborted).toMatch(/below the floor/);
  });

  it("verbose logs show rate-limit headers but never the key", async () => {
    const api = fakeApi({ echoKey: true });
    const lines: string[] = [];
    await runProbes(liveOpts(loadConfig(CONFIG_PATH), api.transport, { only: [5], verbose: true, log: (l: string) => lines.push(l) }));
    const text = lines.join("\n");
    expect(text).toContain("x-month-ratelimit-remaining=");
    expect(text).toContain("x-echo=seen [REDACTED]");
    expect(text).not.toContain(KEY);
  });

  it("writes only params, headers and derived numbers; never the key or a body", async () => {
    const api = fakeApi({ echoKey: true });
    const cfg = loadConfig(CONFIG_PATH);
    const r = await runProbes(liveOpts(cfg, api.transport, { only: [1, 4, 7] }));
    const dir = mkdtempSync(join(tmpdir(), "probe-out-"));
    tmp.push(dir);
    const out = writeOutputs(dir, r, { baseUrl: BASE, configPath: "scripts/probe.config.json", only: [1, 4, 7], apiKey: KEY });
    const files = readdirSync(out);
    expect(files).toEqual(expect.arrayContaining(["SUMMARY.md", "run.json", "probe-01-kg1-taste-moves-partners.json"]));
    for (const f of files) {
      const text = readFileSync(join(out, f), "utf8");
      expect(text, f).not.toContain(KEY);
      if (f.endsWith(".json")) expect(rawBodyReason(JSON.parse(text)), f).toBeNull();
    }
    const p1 = JSON.parse(readFileSync(join(out, "probe-01-kg1-taste-moves-partners.json"), "utf8"));
    expect(p1.requests[0].curl).toContain("$QLOO_API_KEY");
    expect(p1.requests[0].headers["x-month-ratelimit-remaining"]).toBeDefined();
    expect(JSON.stringify(p1.requests)).toContain("[REDACTED]");
    expect(readFileSync(join(out, "SUMMARY.md"), "utf8")).toMatch(/KG1 \(taste moves partners, probe #1\): GO/);
  });
});

describe("a failed or ignored call never reads as a pass", () => {
  const has = (q: Record<string, unknown>, k: string): boolean => q[k] !== undefined && q[k] !== "";
  const run = async (only: number[], api: ReturnType<typeof fakeApi>, cfg: ProbeConfig = loadConfig(CONFIG_PATH)) =>
    (await runProbes(liveOpts(cfg, api.transport, { only }))).runs[0]!.outcome;

  it("#10: filter.hours refused with 400 is a fail, not 'results change'", async () => {
    const o = await run([10], fakeApi({ failWhen: (p, q) => (p === "/v2/insights" && has(q, "filter.hours") ? 400 : null) }));
    expect(o.status).toBe("fail");
  });
  it("#10: a 503 on the filtered call is inconclusive", async () => {
    const o = await run([10], fakeApi({ failWhen: (p, q) => (p === "/v2/insights" && has(q, "filter.hours") ? 503 : null) }));
    expect(o.status).toBe("inconclusive");
  });
  it("#16: a failed age-signal call is not 'top 10 changed'", async () => {
    const o = await run([16], fakeApi({ failWhen: (p, q) => (has(q, "signal.demographics.age") ? 503 : null) }));
    expect(o.status).not.toBe("pass");
  });
  it("#17: a failed audience-signal call is not 'ranking moved'", async () => {
    const o = await run([17], fakeApi({ failWhen: (p, q) => (has(q, "signal.demographics.audiences") ? 503 : null) }));
    expect(o.status).not.toBe("pass");
  });
  it("#12: a failed exclusion call is not 'exclusions honoured'", async () => {
    const o = await run([12], fakeApi({ failWhen: (p, q) => (has(q, "filter.exclude.tags") ? 503 : null) }));
    expect(o.status).not.toBe("pass");
  });
  it("#12: a failed no-location call is not 'ranking changed'", async () => {
    const o = await run([12], fakeApi({ failWhen: (p, q) => (q["filter.type"] === "urn:entity:brand" && !has(q, "signal.location") ? 503 : null) }));
    expect(o.status).not.toBe("pass");
  });
  it("#9: a tag filter that is silently ignored (rows do not carry the tag) is not pinned", async () => {
    const api = fakeApi({
      mutate: (p, q, json) => {
        if (p !== "/v2/insights" || !has(q, "filter.tags")) return json;
        const body = json as { results: { entities: Record<string, unknown>[] } };
        return { results: { entities: body.results.entities.map((e) => ({ ...e, tags: [{ id: "urn:tag:category:place:other", name: "other" }] })) } };
      },
    });
    const o = await run([9], api);
    expect(o.status).toBe("fail");
    expect(o.derived.pinnedCandidates).toEqual({});
  });
  it("#9: a child tag of the filter tag counts as carrying it", async () => {
    const api = fakeApi({
      mutate: (p, q, json) => {
        if (p !== "/v2/insights" || !has(q, "filter.tags")) return json;
        const tag = String(q["filter.tags"]);
        const body = json as { results: { entities: Record<string, unknown>[] } };
        return { results: { entities: body.results.entities.map((e) => ({ ...e, tags: [{ id: `${tag}:child`, name: "child" }] })) } };
      },
    });
    expect((await run([9], api)).status).toBe("pass");
  });
  it("#6 (KG3): an HTTP error on the headliner heatmap is inconclusive, not a no-go", async () => {
    const o = await run([6], fakeApi({ failWhen: (p, q) => (q["filter.type"] === "urn:heatmap" && has(q, "signal.interests.entities") ? 503 : null) }));
    expect(o.status).toBe("inconclusive");
  });
  it("#19: an HTTP error on the comedy heatmap is inconclusive", async () => {
    const o = await run([19], fakeApi({ failWhen: (p, q) => (q["filter.type"] === "urn:heatmap" ? 503 : null) }));
    expect(o.status).toBe("inconclusive");
  });
  it("#20: when the name query matches too few guests, the slate is inconclusive (re-run by id), not a fail", async () => {
    const api = fakeApi({
      mutate: (p, q, json) =>
        p === "/v2/insights" && q["filter.type"] === "urn:entity:person" && has(q, "filter.results.entities.query")
          ? { results: { entities: [{ entity_id: "E:x", name: "Somebody Else", query: { affinity: 0.4 } }] } }
          : json,
    });
    const r = await runProbes(liveOpts(loadConfig(CONFIG_PATH), api.transport, { only: [15, 20] }));
    const o = r.runs.find((x) => x.def.id === 20)!.outcome;
    expect(o.status).toBe("inconclusive");
    expect(o.lines.join(" ")).toMatch(/--only=20/);
  });
  it("#3 (KG4): club-signal lists that error make the gate inconclusive, not a no-go", async () => {
    const cfg = loadConfig(CONFIG_PATH);
    cfg.kg4.bars = cfg.kg4.bars.map((b) => ({ ...b, barName: `Supporters Bar ${b.club} ${b.metro}` }));
    const api = fakeApi({
      failWhen: (p, q) => (p === "/v2/insights" && q["filter.type"] === "urn:entity:place" && has(q, "signal.interests.entities") ? 503 : null),
    });
    const o = await run([3], api, cfg);
    expect(o.status).toBe("inconclusive");
    expect(o.lines.join(" ")).toMatch(/without a 200/);
  });
  it("#1 (KG1): an act that resolves only to a non-exact name is flagged in the detail lines", async () => {
    const api = fakeApi({
      mutate: (p, q, json) =>
        p === "/search" && q.query === "SZA" ? { results: [{ entity_id: "E:sza", name: "SZA Tribute Night", types: ["urn:entity:artist"] }] } : json,
    });
    const o = await run([1], api);
    expect(o.lines.join(" ")).toMatch(/"SZA" matched no exact name/);
  });
  it("house: a roster lookup that resolves too few acts says so instead of a silent stand-in", async () => {
    const cfg = loadConfig(CONFIG_PATH);
    cfg.venues["the-truth"]!.lat = 36.15;
    cfg.venues["the-truth"]!.lon = -86.79;
    cfg.roster.spotifyIds = Array.from({ length: 10 }, (_, i) => `sp${i}`);
    const o = await run([2], fakeApi({ failWhen: (p) => (p === "/entities" ? 503 : null) }), cfg);
    expect(o.lines.join(" ")).toMatch(/roster lookup/);
    expect(o.derived.houseSource).toBe("stand-in");
  });
});
