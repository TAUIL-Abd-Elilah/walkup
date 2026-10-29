/**
 * The whole probe plan built in dry-run mode: no key, no network. Checks the
 * request shapes every probe would send.
 */

import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type ProbeConfig, loadConfig, validateConfig } from "../lib/probe/config.js";
import { PROBES, parseOnly, runOrder } from "../lib/probe/registry.js";
import { DEFAULT_BASE_URL, MAX_TAKE } from "../lib/probe/requests.js";
import { type RunResult, runProbes } from "../lib/probe/runner.js";
import type { CallRecord } from "../lib/probe/types.js";

const CONFIG_PATH = fileURLToPath(new URL("../probe.config.json", import.meta.url));
const base = (): ProbeConfig => loadConfig(CONFIG_PATH);

async function plan(cfg: ProbeConfig, only?: number[], files: Record<string, unknown> = {}): Promise<RunResult> {
  return runProbes({
    cfg,
    dryRun: true,
    only: only ?? null,
    verbose: false,
    budgetMax: 100,
    apiKey: null,
    baseUrl: DEFAULT_BASE_URL,
    log: () => {},
    readOptionalJson: (p) => files[p] ?? null,
  });
}

function fresh(result: RunResult, probe?: number): CallRecord[] {
  return result.runs.filter((r) => probe === undefined || r.def.id === probe).flatMap((r) => r.requests.filter((q) => !q.memo));
}

function knownPoints(cfg: ProbeConfig): { lat: number; lon: number }[] {
  const pts: { lat: number; lon: number }[] = [];
  for (const v of Object.values(cfg.venues)) {
    if (v.lat !== null && v.lon !== null) pts.push({ lat: v.lat, lon: v.lon });
    if (v.searchAnchor) pts.push({ lat: v.searchAnchor.lat, lon: v.searchAnchor.lon });
  }
  for (const m of cfg.kg4.metros) pts.push({ lat: m.lat, lon: m.lon });
  return pts;
}

/** Every WKT / lat,lon string in a request, with which slot it came from. */
function locations(r: CallRecord): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(r.params)) if (/location$/.test(k)) out.push({ key: k, value: String(v) });
  if (r.body) for (const [k, v] of Object.entries(r.body)) if (/location$/.test(k)) out.push({ key: k, value: String(v) });
  return out;
}

const filledTruth = (cfg: ProbeConfig): ProbeConfig => {
  const c = structuredClone(cfg);
  c.venues["the-truth"]!.lat = 36.15;
  c.venues["the-truth"]!.lon = -86.79;
  c.venues["super-funny-tacoma"]!.lat = 47.24;
  c.venues["super-funny-tacoma"]!.lon = -122.45;
  return c;
};

describe("config", () => {
  it("the shipped config validates", () => {
    expect(() => base()).not.toThrow();
  });
  it("rejects half-filled points, oversized takes and unknown venues", () => {
    const c = structuredClone(base()) as unknown as ProbeConfig;
    c.venues["ryman"]!.lon = null;
    c.kg4.take = 60;
    c.p10.venue = "nowhere";
    const errors = validateConfig(c);
    expect(errors.join("\n")).toMatch(/ryman: lat and lon must both be numbers or both null/);
    expect(errors.join("\n")).toMatch(/kg4.take must be <= 50/);
    expect(errors.join("\n")).toMatch(/unknown venue "nowhere"/);
  });
  it("null venue points carry the fill-from note and every point cites a source", () => {
    const c = base();
    for (const [key, v] of Object.entries(c.venues)) {
      expect(v.source.provider, key).toBeTruthy();
      if (v.lat === null) expect(v.note, key).toMatch(/fill from Ticketmaster venue on key day/);
    }
    expect(c.kg1.note).toMatch(/probe-only test pairs, not product claims/);
  });
});

describe("run order and flags", () => {
  it("runs the gate groups 1-3 first", () => {
    expect(runOrder().map((p) => p.id).slice(0, 3)).toEqual([1, 2, 3]);
    expect(PROBES.map((p) => p.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
  it("parses --only lists and ranges", () => {
    expect(parseOnly("1,2,3")).toEqual([1, 2, 3]);
    expect(parseOnly("9-11,1")).toEqual([1, 9, 10, 11]);
    expect(() => parseOnly("21")).toThrow();
    expect(() => parseOnly("a")).toThrow();
  });
});

describe("dry-run plan (shipped config)", () => {
  const cfg = base();
  let result: RunResult;
  let all: CallRecord[];
  beforeAll(async () => {
    result = await plan(cfg);
    all = fresh(result);
  });

  it("plans every probe, stays under the 100-call cap and sends nothing", () => {
    expect(result.dryRun).toBe(true);
    expect(result.aborted).toBeNull();
    expect(result.calls).toBe(all.length);
    expect(result.calls).toBeLessThanOrEqual(100);
    expect(result.calls).toBeGreaterThan(50);
    for (const r of result.runs) expect(["planned", "skipped"], `#${r.def.id}`).toContain(r.outcome.status);
    expect(all.every((q) => q.status === null && q.attempts === 0)).toBe(true);
  });

  it("each probe stays within its declared call estimate", () => {
    for (const r of result.runs) {
      const n = r.requests.filter((q) => !q.memo).length;
      expect(n, `#${r.def.id}`).toBeLessThanOrEqual(r.def.maxCalls);
    }
  });

  it("writes every WKT as POINT(lon lat) and every /search point as lat,lon", () => {
    const pts = knownPoints(cfg);
    // Requests carry 7 decimals (about 1 cm); configured points can carry more.
    const isKnown = (lat: number, lon: number): boolean => pts.some((p) => Math.abs(p.lat - lat) < 5e-8 && Math.abs(p.lon - lon) < 5e-8);
    let seen = 0;
    for (const r of all) {
      for (const loc of locations(r)) {
        seen++;
        if (r.path === "/search") {
          const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(loc.value);
          expect(m, loc.value).not.toBeNull();
          expect(isKnown(Number(m![1]), Number(m![2])), loc.value).toBe(true);
        } else {
          const m = /^POINT\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/.exec(loc.value);
          expect(m, loc.value).not.toBeNull();
          // longitude first: (x, y) = (lon, lat)
          expect(isKnown(Number(m![2]), Number(m![1])), loc.value).toBe(true);
        }
      }
    }
    expect(seen).toBeGreaterThan(30);
  });

  it("spells types per endpoint: filter.type on insights, `types` on /search", () => {
    const insightTypes = new Set([
      "urn:entity:place",
      "urn:entity:podcast",
      "urn:entity:brand",
      "urn:entity:person",
      "urn:heatmap",
      "urn:demographics",
      "urn:tag",
    ]);
    for (const r of all) {
      if (r.path === "/search") {
        expect(r.params["filter.type"]).toBeUndefined();
        expect(String(r.params.types)).toMatch(/^urn:entity:[a-z_]+(,urn:entity:[a-z_]+)*$/);
        expect(String(r.params.types)).not.toContain("video_game");
      }
      if (r.path === "/v2/insights") {
        const ft = r.method === "POST" ? r.body?.["filter.type"] : r.params["filter.type"];
        expect(insightTypes.has(String(ft)), String(ft)).toBe(true);
      }
    }
  });

  it("never sends a heatmap boundary or a take above 50, and heatmaps send no take", () => {
    for (const r of all) {
      expect(r.params["output.heatmap.boundary"]).toBeUndefined();
      if (r.params.take !== undefined) expect(Number(r.params.take)).toBeLessThanOrEqual(MAX_TAKE);
      if (r.params["filter.type"] === "urn:heatmap") expect(r.params.take).toBeUndefined();
    }
  });

  it("probe 1: no-signal pool then the same pool scored per bill", () => {
    const reqs = fresh(result, 1).filter((r) => r.path === "/v2/insights");
    const pools = reqs.filter((r) => r.label.includes("(no signal"));
    const scored = reqs.filter((r) => r.params["filter.results.entities"] !== undefined);
    // One pool per KG1 room with a point (the-truth gets one once key day fills it), each scored by both bills.
    const withPoint = cfg.kg1.venues.filter((v) => cfg.venues[v]!.lat !== null);
    const without = cfg.kg1.venues.filter((v) => cfg.venues[v]!.lat === null);
    expect(withPoint.length).toBeGreaterThanOrEqual(2);
    expect(pools.map((p) => p.label)).toEqual(withPoint.map((v) => `pool near ${v} (no signal = popularity order)`));
    expect(scored.length).toBe(2 * withPoint.length);
    for (const p of pools) {
      expect(p.params["signal.interests.entities"]).toBeUndefined();
      expect(p.params["filter.location.radius"]).toBe(1500);
      expect(p.params.take).toBe(30);
      expect(p.params["operator.filter.tags"]).toBe("union");
    }
    for (const s of scored) expect(s.params["signal.interests.entities"]).toBeTruthy();
    const lines = result.runs.find((r) => r.def.id === 1)!.outcome.lines;
    expect(lines).toEqual(without.map((v) => `${v}: skipped (no coordinates yet; fill lat/lon from the Ticketmaster venue)`));
  });

  it("probe 2: bill, bill, house and generic heatmaps at 40 km", () => {
    const heat = fresh(result, 2).filter((r) => r.params["filter.type"] === "urn:heatmap");
    expect(heat.length).toBe(4);
    expect(heat.every((h) => h.params["filter.location.radius"] === 40000)).toBe(true);
    expect(heat.filter((h) => h.params["signal.interests.tags"] !== undefined).length).toBe(1);
  });

  it("probe 3: three brand searches and nine club-signal bar lists of 50 within 25 km", () => {
    const reqs = fresh(result, 3);
    expect(reqs.filter((r) => r.path === "/search" && r.params.types === "urn:entity:brand").length).toBe(3);
    const lists = reqs.filter((r) => r.path === "/v2/insights");
    expect(lists.length).toBe(9);
    for (const l of lists) {
      expect(l.params.take).toBe(50);
      expect(l.params["filter.location.radius"]).toBe(25000);
      expect(l.params["operator.filter.tags"]).toBe("union");
    }
  });

  it("probes 5-7: person, movie and tv_show searches; demographics and tag profile", () => {
    const types = [...fresh(result, 5), ...fresh(result, 6)].filter((r) => r.path === "/search").map((r) => r.params.types);
    expect(types).toEqual(expect.arrayContaining(["urn:entity:person", "urn:entity:movie", "urn:entity:tv_show"]));
    const p7 = fresh(result, 7).map((r) => r.params["filter.type"]);
    expect(p7).toEqual(["urn:demographics", "urn:tag"]);
  });

  it("probes 9-10: tag lookups scoped to places, filtered rows, and filter.hours", () => {
    const tags = fresh(result, 9).filter((r) => r.path === "/v2/tags");
    expect(tags.every((t) => t.params["filter.parents.types"] === "urn:entity:place")).toBe(true);
    const rows = fresh(result, 9).filter((r) => r.path === "/v2/insights");
    expect(rows.length).toBe(8);
    expect(fresh(result, 10)[0]!.params["filter.hours"]).toBe("thursday");
  });

  it("probes 11-12: location as signal.location for podcasts and brands, never filter.location", () => {
    for (const id of [11, 12]) {
      const reqs = fresh(result, id).filter((r) => r.path === "/v2/insights");
      expect(reqs.some((r) => r.params["signal.location"] !== undefined)).toBe(true);
      expect(reqs.some((r) => r.params["signal.location"] === undefined)).toBe(true);
      expect(reqs.every((r) => r.params["filter.location"] === undefined)).toBe(true);
    }
    expect(fresh(result, 12).some((r) => r.params["filter.exclude.tags"] !== undefined)).toBe(true);
  });

  it("probes 13-14: compare with a./b. sides; POST with weighted objects", () => {
    const cmp = fresh(result, 13).find((r) => r.path === "/v2/analysis/compare")!;
    expect(cmp.params["a.signal.interests.entities"]).toBeTruthy();
    expect(cmp.params["b.signal.interests.entities"]).toBeTruthy();
    const posts = fresh(result, 14).filter((r) => r.method === "POST");
    expect(posts.length).toBe(2);
    const w = posts.map((p) => (p.body?.["signal.interests.entities"] as { weight: number }[]).map((x) => x.weight));
    expect(w).toEqual([
      [10, 1],
      [1, 10],
    ]);
  });

  it("probes 15-17: name query, age signal and audience signal on the scored pool", () => {
    expect(fresh(result, 15)[0]!.params["filter.results.entities.query"]).toBe("Ryman Auditorium,Bridgestone Arena,Tootsie's Orchid Lounge");
    expect(fresh(result, 16)[0]!.params["signal.demographics.age"]).toBe("24_and_younger,25_to_29");
    const p17 = fresh(result, 17);
    expect(p17.filter((r) => r.path === "/v2/audiences").length).toBe(2);
    expect(p17.some((r) => r.params["signal.demographics.audiences"] !== undefined)).toBe(true);
  });

  it("probe 18 waits for roster ids; 19 uses a 60 km comedy-tag heatmap; 20 scores the slate with explainability", () => {
    const p18 = result.runs.find((r) => r.def.id === 18)!;
    const ids = cfg.roster.spotifyIds.slice(0, cfg.p18.maxIds);
    if (ids.length === 0) {
      expect(p18.outcome.status).toBe("skipped");
      expect(p18.requests).toEqual([]);
    } else {
      // Filled on key day: one /entities lookup by the roster's ids (or the same lookup reused from probe 2).
      expect(p18.outcome.status).toBe("planned");
      expect(p18.requests.length).toBe(1);
      expect(p18.requests[0]).toMatchObject({ path: "/entities", params: { "external.spotify.ids": ids.join(",") } });
    }
    const h = fresh(result, 19).find((r) => r.params["filter.type"] === "urn:heatmap")!;
    expect(h.params["filter.location.radius"]).toBe(60000);
    expect(h.params["signal.interests.tags"]).toBeTruthy();
    const slate = fresh(result, 20).find((r) => r.params["filter.type"] === "urn:entity:person")!;
    expect(slate.params["feature.explainability"]).toBe(true);
    expect(String(slate.params["filter.results.entities.query"]).split(",")).toHaveLength(10);
  });
});

describe("dry-run plan with key-day inputs filled", () => {
  it("uses the new room, the roster house, the bar rows, and stays under the cap", async () => {
    const cfg = filledTruth(base());
    cfg.roster.spotifyIds = Array.from({ length: 12 }, (_, i) => `spotify${i}`);
    const bars = cfg.kg4.bars.map((b, i) => ({ club: b.club, metro: b.metro, barName: `Test Bar ${i}`, lat: null, lon: null, sourceUrl: null }));
    const result = await plan(cfg, undefined, { [cfg.kg4.barsFile!]: bars });
    const all = fresh(result);
    expect(result.calls).toBeLessThanOrEqual(100);
    const p1 = fresh(result, 1).filter((r) => r.label.includes("(no signal"));
    expect(p1.map((r) => r.label)).toEqual(expect.arrayContaining([expect.stringContaining("the-truth")]));
    expect(fresh(result, 2).some((r) => r.path === "/entities" && r.params["external.spotify.ids"] !== undefined)).toBe(true);
    expect(fresh(result, 2).filter((r) => r.params["filter.type"] === "urn:heatmap").every((r) => String(r.label).includes("the-truth"))).toBe(true);
    expect(fresh(result, 3).filter((r) => r.path === "/search" && r.params.types === "urn:entity:place").length).toBe(9);
    // probe 18 reuses the roster lookup only when the id lists match; it plans at most one call
    expect(fresh(result, 18).length).toBeLessThanOrEqual(1);
    expect(all.length).toBe(result.calls);
  });

  it("the gates alone (--only=1,2,3) plan well under the cap", async () => {
    const result = await plan(base(), [1, 2, 3]);
    expect(result.runs.map((r) => r.def.id)).toEqual([1, 2, 3]);
    // Within the gates' own estimates, which leave room for key day: the-truth's point adds a KG1 room
    // and filled bars add the KG4 lookups (42 calls with the committed config, 51 with both).
    const declared = PROBES.filter((p) => p.id <= 3).reduce((n, p) => n + p.maxCalls, 0);
    expect(declared).toBeLessThanOrEqual(55);
    expect(result.calls).toBeLessThanOrEqual(declared);
  });
});
