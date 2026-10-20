/**
 * End-to-end runs of the P1 runner on the synthetic table with injected fake transports
 * (Qloo, Google Places, Census Geocoder, model). Nothing reaches the network.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBars } from "../bars";
import { parseCsv } from "../csv";
import { ARMS, ARMS_CSV_COLUMNS, BARS_STATUS_COLUMNS, PLACES_TOTAL_CAP, type ArmName } from "../protocol";
import { decideFSubset, runP1, type RunOptions, type RunResult } from "../runner";
import { createMemoryKv, RunStore } from "../store";
import { BARS_CSV, BRAND, harness, makeWorld, TAG, type Harness } from "./fake-world";

let dir: string;
const open: Harness[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p1-arms-"));
});
afterEach(() => {
  for (const h of open.splice(0)) h.handle.close();
  rmSync(dir, { recursive: true, force: true });
});

function options(over: Partial<RunOptions> = {}): RunOptions {
  return {
    bars: parseBars(BARS_CSV),
    inputIsSealedTable: null,
    planMatchesSealedHash: null,
    arms: [...ARMS],
    limit: null,
    viability: false,
    noGoogle: false,
    retryFailed: false,
    llmConcurrency: 1,
    outDir: join(dir, "private"),
    publicDir: join(dir, "public"),
    pinsDir: join(dir, "pins"),
    configTagsPath: null,
    ...over,
  };
}

function track(h: Harness): Harness {
  open.push(h);
  return h;
}

function rowsOf(res: RunResult, arm: ArmName): Record<string, string | number | null>[] {
  return res.rows
    .filter((r) => r.arm === arm)
    .map((r) => ({ club: r.club, metro: r.metro, bar: r.barKey, rank: r.rank, n: r.candidatesN, barClub: r.barClub }));
}

describe("full synthetic run", () => {
  it("resolves, applies the exclusions in order and writes the analyze.py inputs", async () => {
    const h = track(harness(makeWorld()));
    const res = await runP1(h.handle.services, options());
    expect(res.exitCode).toBe(0);
    expect(res.stopped).toBeNull();

    // Coverage funnel (plan §5 order).
    const status = Object.fromEntries(res.statusRows.map((r) => [r.barKey, r.status]));
    expect(status).toEqual({
      a00000000001: "analyzed", // primary path
      a00000000002: "analyzed", // fallback path, no ZIP on the listing
      a00000000003: "closed", // fallback (geocoder no match), Google CLOSED_PERMANENTLY
      a00000000004: "unresolved", // no Qloo result
      a00000000005: "no_metro",
      a00000000006: "analyzed",
      a00000000007: "analyzed",
      a00000000008: "stale_page", // page dated 2023-01-01, run date 2026-10-20
      a00000000009: "out_of_radius", // resolved 44 km from P
      a00000000010: "unresolved", // fallback, ZIP mismatch
      a00000000011: "analyzed",
    });
    const cov = res.summary.coverage!;
    expect(cov.byClub.american_outlaws).toMatchObject({ listed: 6, no_metro: 1, unresolved: 1, closed: 1, analyzed: 3, resolution_rate: 0.8 });
    expect(cov.byClub.arsenal_america).toMatchObject({ listed: 3, stale_page: 1, out_of_radius: 1, analyzed: 1, resolution_rate: 1 });
    expect(cov.byClub.lfc_olsc).toMatchObject({ listed: 2, unresolved: 1, analyzed: 1, resolution_rate: 0.5 });

    // Setup: brands (the band and the ferry line are rejected) and tag pins.
    expect(res.log.club_entities.map((c) => [c.club, c.entityId, c.acceptedQuery])).toEqual([
      ["american_outlaws", BRAND.ao, "United States men's national soccer team"],
      ["arsenal_america", BRAND.ars, "Arsenal F.C."],
      ["lfc_olsc", BRAND.lfc, "Liverpool FC"],
    ]);
    expect(res.log.tag_pins.map((p) => [p.word, p.tagId])).toEqual([
      ["bar", TAG.barCategory],
      ["pub", TAG.pub],
      ["sports bar", TAG.sportsBar],
      ["irish pub", null],
    ]);
    expect(JSON.parse(readFileSync(join(dir, "pins", "club_entities.json"), "utf8"))).toEqual({
      arsenal_america: BRAND.ars,
      lfc_olsc: BRAND.lfc,
      american_outlaws: BRAND.ao,
    });
    expect(JSON.parse(readFileSync(join(dir, "pins", "pinned_tags.json"), "utf8"))).toEqual({
      bar: TAG.barCategory,
      pub: TAG.pub,
      "sports bar": TAG.sportsBar,
      "irish pub": null,
    });

    // Ranks per arm.
    expect(rowsOf(res, "Q-pop")).toEqual([
      { club: "american_outlaws", metro: "3719000", bar: "a00000000006", rank: 2, n: 2, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000001", rank: 6, n: 8, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000002", rank: 8, n: 8, barClub: "american_outlaws" },
      { club: "arsenal_america", metro: "9900001", bar: "a00000000007", rank: 1, n: 8, barClub: "arsenal_america" },
      { club: "lfc_olsc", metro: "9900002", bar: "a00000000011", rank: 2, n: 3, barClub: "lfc_olsc" },
    ]);
    expect(rowsOf(res, "Q-signal")).toEqual([
      { club: "american_outlaws", metro: "3719000", bar: "a00000000006", rank: 1, n: 2, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000001", rank: 1, n: 8, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000002", rank: 2, n: 8, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000007", rank: 3, n: 8, barClub: "arsenal_america" },
      { club: "arsenal_america", metro: "9900001", bar: "a00000000007", rank: 1, n: 8, barClub: "arsenal_america" },
      { club: "arsenal_america", metro: "9900001", bar: "a00000000001", rank: 6, n: 8, barClub: "american_outlaws" },
      { club: "arsenal_america", metro: "9900001", bar: "a00000000002", rank: 8, n: 8, barClub: "american_outlaws" },
      { club: "lfc_olsc", metro: "9900002", bar: "a00000000011", rank: 1, n: 3, barClub: "lfc_olsc" },
    ]);
    // F: the answer is the tool's ids reversed, after an unseen id (dropped) and with a repeat (dropped).
    expect(rowsOf(res, "F")).toEqual([
      { club: "american_outlaws", metro: "3719000", bar: "a00000000006", rank: 1, n: 1, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000001", rank: 4, n: 4, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000002", rank: 3, n: 4, barClub: "american_outlaws" },
      { club: "arsenal_america", metro: "9900001", bar: "a00000000007", rank: 2, n: 4, barClub: "arsenal_america" },
      { club: "lfc_olsc", metro: "9900002", bar: "a00000000011", rank: 1, n: 2, barClub: "lfc_olsc" },
    ]);
    expect(rowsOf(res, "L")).toEqual([
      { club: "american_outlaws", metro: "3719000", bar: "a00000000006", rank: null, n: 1, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000001", rank: 1, n: 2, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000002", rank: null, n: 2, barClub: "american_outlaws" },
      { club: "arsenal_america", metro: "9900001", bar: "a00000000007", rank: null, n: 2, barClub: "arsenal_america" },
      { club: "lfc_olsc", metro: "9900002", bar: "a00000000011", rank: null, n: 1, barClub: "lfc_olsc" },
    ]);
    expect(rowsOf(res, "Q-derby")).toEqual([
      { club: "american_outlaws", metro: "9900001", bar: "a00000000001", rank: 1, n: 2, barClub: "american_outlaws" },
      { club: "american_outlaws", metro: "9900001", bar: "a00000000007", rank: 2, n: 2, barClub: "arsenal_america" },
      { club: "arsenal_america", metro: "9900001", bar: "a00000000007", rank: 1, n: 2, barClub: "arsenal_america" },
      { club: "arsenal_america", metro: "9900001", bar: "a00000000001", rank: 2, n: 2, barClub: "american_outlaws" },
    ]);

    // Files: exact column sets that analyze.py reads.
    const arms = parseCsv(readFileSync(join(dir, "private", "p1_arms.csv"), "utf8"));
    expect(arms.header).toEqual([...ARMS_CSV_COLUMNS]);
    expect(arms.records).toHaveLength(27);
    expect(arms.records.every((r) => r.rank_or_blank === "" || Number(r.rank_or_blank) >= 1)).toBe(true);
    expect(arms.records.find((r) => r.arm === "Q-signal" && r.bar_key === "a00000000002")).toMatchObject({
      resolution_via: "fallback",
      listing_role: "satellite",
      entity_id: "q-ao-2",
    });
    const st = parseCsv(readFileSync(join(dir, "private", "p1_bars_status.csv"), "utf8"));
    expect(st.header).toEqual([...BARS_STATUS_COLUMNS]);
    expect(st.records.find((r) => r.bar_key === "a00000000003")).toMatchObject({ status: "closed", google_place_id: "gp-3", resolution_via: "fallback" });
    expect(existsSync(join(dir, "private", "p1_arms.partial.csv"))).toBe(false);

    // Calls: 5 brand + 4 tags + 9 resolution + 3 Q-pop + 4 Q-signal + 2 Q-derby.
    expect(h.qloo.calls).toHaveLength(27);
    expect(res.summary.calls.qloo).toMatchObject({ sent_this_run: 27, sent_all_runs: 27, cap_per_run: 900 });
    // 7 Google resolutions + 3 live tool searches (the second Exampleton search is a cache hit).
    expect(h.places.bodies).toHaveLength(10);
    expect(res.summary.calls.places).toMatchObject({ sent_this_run: 10, cached_this_run: 1, sent_all_runs: 10, plan_cap: PLACES_TOTAL_CAP });
    expect(res.summary.calls.census_geocoder.sent_this_run).toBe(7);
    expect(res.summary.arms["Q-pop"]?.extra).toMatchObject({ popularity_non_increasing: 3, popularity_not_monotone: 0 });
    expect(res.summary.f_subset).toEqual({ population: 4, drawn: false, size: 4 });
  });

  it("sends the exact request shapes of ARMS.md", async () => {
    const h = track(harness(makeWorld()));
    await runP1(h.handle.services, options());
    const params = (u: URL): Record<string, string> => Object.fromEntries([...u.searchParams.entries()]);
    const calls = h.qloo.calls.map((u) => ({ path: u.pathname, ...params(u) }));

    expect(calls[0]).toEqual({ path: "/search", query: "United States men's national soccer team", types: "urn:entity:brand" });
    expect(calls).toContainEqual({ path: "/entities", entity_ids: BRAND.ao });
    expect(calls).toContainEqual({ path: "/v2/tags", "filter.query": "sports bar", "filter.parents.types": "urn:entity:place" });
    // Primary path: point A, 1 mile, take 20.
    expect(calls).toContainEqual({ path: "/search", query: "Corner Flag Tavern", types: "urn:entity:place", "filter.location": "POINT(-97.01 30.01)", "filter.radius": "1", take: "20" });
    // Fallback path: metro point, 16 miles.
    expect(calls).toContainEqual({ path: "/search", query: "Offside Pub", types: "urn:entity:place", "filter.location": "POINT(-97 30)", "filter.radius": "16", take: "20" });
    const pinned = `${TAG.barCategory},${TAG.pub},${TAG.sportsBar}`;
    expect(calls).toContainEqual({
      path: "/v2/insights",
      "filter.type": "urn:entity:place",
      "signal.interests.entities": BRAND.ars,
      "filter.location": "POINT(-97 30)",
      "filter.location.radius": "25000",
      "filter.tags": pinned,
      "operator.filter.tags": "union",
      take: "50",
    });
    expect(calls).toContainEqual({
      path: "/v2/insights",
      "filter.type": "urn:entity:place",
      "filter.location": "POINT(-83 40)",
      "filter.location.radius": "25000",
      "filter.tags": pinned,
      "operator.filter.tags": "union",
      take: "50",
    });
    expect(calls).toContainEqual({
      path: "/v2/insights",
      "filter.type": "urn:entity:place",
      "signal.interests.entities": BRAND.ao,
      "filter.results.entities": "q-ao-1,q-ars-7",
      take: "10",
    });
    // Google resolution: primary at A with 300 m, fallback at P with 25 km; 20 results.
    expect(h.places.bodies).toContainEqual({
      textQuery: "Corner Flag Tavern, 101 Example St, Exampleton, TX, 75001",
      locationBias: { circle: { center: { latitude: 30.01, longitude: -97.01 }, radius: 300 } },
      maxResultCount: 20,
    });
    expect(h.places.bodies).toContainEqual({
      textQuery: "Offside Pub, Exampleton, TX",
      locationBias: { circle: { center: { latitude: 30, longitude: -97 }, radius: 25000 } },
      maxResultCount: 20,
    });
    // Census Geocoder: robots.txt first, then "address, city, state".
    expect(h.census.urls[0]).toBe("https://geocoding.geo.census.gov/robots.txt");
    const geo = new URL(h.census.urls[1]!);
    expect(geo.pathname).toBe("/geocoder/locations/onelineaddress");
    expect(geo.searchParams.get("address")).toBe("101 Example St, Exampleton, TX, 75001, Exampleton, TX");
    expect(geo.searchParams.get("benchmark")).toBe("Public_AR_Current");
    expect(geo.searchParams.get("format")).toBe("json");
  });

  it("calls the model exactly as ARMS.md §4 and §5 specify", async () => {
    const h = track(harness(makeWorld()));
    await runP1(h.handle.services, options({ arms: ["F", "L"] }));
    const f = h.model.requests.find((r) => (r.tools ?? []).length > 0)!;
    expect(f.model).toBe("claude-opus-5-5");
    expect(f.max_tokens).toBe(16000);
    expect(f.output_config?.effort).toBe("medium");
    expect(f.output_config?.format?.type).toBe("json_schema");
    expect(JSON.stringify(f.output_config?.format?.schema)).toContain("place_ids");
    expect(f.system).toEqual([
      {
        type: "text",
        text: "You are a research assistant helping a live-event marketing team understand local venues. Follow the instructions in the user message and answer only in the requested JSON format.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(f.messages[0]).toEqual({
      role: "user",
      content:
        "Rank up to 50 bars and pubs in Durham, NC that fans of USMNT (US men's national soccer team) love. Use the places_search tool to find candidates. Return only place ids that the tool returned, best first.",
    });
    for (const r of h.model.requests) {
      expect(r).not.toHaveProperty("thinking");
      expect(r).not.toHaveProperty("tool_choice");
      expect(r).not.toHaveProperty("betas");
      expect(r).not.toHaveProperty("fallbacks");
    }
    const l = h.model.requests.find((r) => !r.tools)!;
    expect(l.output_config?.effort).toBe("low");
    expect(l.messages[0]?.content).toBe(
      "Name the bar or pub where the official USMNT (US men's national soccer team) supporters' group in Durham, NC watches matches. Give up to 3 names, most likely first.",
    );
    // The tool result handed to the model has the contract's fields only.
    const second = h.model.requests.find((r) => r.tools && r.messages.length === 3)!;
    const block = (second.messages[2]!.content as ToolResultBlockParam[])[0]!;
    expect(Object.keys((JSON.parse(String(block.content)) as Record<string, unknown>[])[0]!)).toEqual([
      "id",
      "name",
      "address",
      "rating",
      "userRatingCount",
      "businessStatus",
    ]);
  });
});

describe("guards, stops and resume", () => {
  it("stops at the per-run Qloo cap and resumes from the cache without repeating a call", async () => {
    const stateFile = join(dir, "state.sqlite");
    const first = track(harness(makeWorld(), { stateFile, maxQlooCalls: 10 }));
    const r1 = await runP1(first.handle.services, options({ arms: ["Q-pop", "Q-signal"] }));
    expect(r1.exitCode).toBe(3);
    expect(r1.stopped?.kind).toBe("qloo_budget");
    expect(first.qloo.calls).toHaveLength(10);
    expect(existsSync(join(dir, "private", "p1_arms.csv"))).toBe(false);
    first.handle.close();
    open.splice(open.indexOf(first), 1);

    const second = track(harness(makeWorld(), { stateFile }));
    const r2 = await runP1(second.handle.services, options({ arms: ["Q-pop", "Q-signal"] }));
    expect(r2.exitCode).toBe(0);
    // 18 setup + resolution calls + 3 Q-pop + 4 Q-signal = 25 in total, 10 of them in the first run.
    expect(second.qloo.calls).toHaveLength(15);
    // Setup and resolution answers come from the run store, so no Qloo request is repeated.
    expect(r2.summary.calls.qloo).toMatchObject({ sent_this_run: 15, cached_this_run: 0, sent_all_runs: 25 });
    expect(r2.rows.filter((r) => r.arm === "Q-signal")).toHaveLength(8);

    // A third run sends nothing.
    second.handle.close();
    open.splice(open.indexOf(second), 1);
    const third = track(harness(makeWorld(), { stateFile }));
    const r3 = await runP1(third.handle.services, options({ arms: ["Q-pop", "Q-signal"] }));
    expect(r3.exitCode).toBe(0);
    expect(third.qloo.calls).toHaveLength(0);
    expect(third.places.bodies).toHaveLength(0);
    expect(r3.rows).toEqual(r2.rows);
  });

  it("stops when a Q arm returns a place beyond 26 km (filter not honoured)", async () => {
    const intruder = { id: "q-far", name: "Faraway Example Bar", lat: 31.0, lon: -97.0, address: "1 Far Rd", popularity: 0.01 };
    const h = track(harness(makeWorld(), { qlooOpts: { intruder } }));
    const res = await runP1(h.handle.services, options({ arms: ["Q-pop", "Q-signal"] }));
    expect(res.exitCode).toBe(4);
    expect(res.stopped?.kind).toBe("filter_not_honoured");
    expect(res.stopped?.message).toMatch(/location filter was not applied/);
    expect(existsSync(join(dir, "private", "p1_bars_status.csv"))).toBe(true);
    expect(res.summary.complete).toBe(false);
  });

  it("leaves no rows for a Q call that still fails after 3 retries", async () => {
    const h = track(
      harness(makeWorld(), {
        qlooOpts: { failWhen: (u) => (u.pathname === "/v2/insights" && u.searchParams.get("signal.interests.entities") === BRAND.lfc && !u.searchParams.get("filter.results.entities") ? 503 : null) },
      }),
    );
    const res = await runP1(h.handle.services, options({ arms: ["Q-signal"] }));
    expect(res.exitCode).toBe(0);
    expect(res.summary.arms["Q-signal"]).toMatchObject({ planned: 4, completed: 3, failed: 1 });
    expect(res.rows.some((r) => r.club === "lfc_olsc")).toBe(false);
    // 1 try + 3 retries for the failing call.
    expect(h.qloo.calls.filter((u) => u.searchParams.get("signal.interests.entities") === BRAND.lfc)).toHaveLength(4);
  });

  it("stops on a 400 from a Q arm instead of counting every query as failed", async () => {
    const h = track(harness(makeWorld(), { qlooOpts: { failWhen: (u) => (u.pathname === "/v2/insights" ? 400 : null) } }));
    const res = await runP1(h.handle.services, options({ arms: ["Q-pop", "Q-signal"] }));
    expect(res.exitCode).toBe(1);
    expect(res.stopped?.kind).toBe("fatal_api");
    expect(h.qloo.calls.filter((u) => u.pathname === "/v2/insights")).toHaveLength(1);
  });

  it("stops the run when a resolution call still fails (the coverage table must be complete)", async () => {
    const h = track(harness(makeWorld(), { qlooOpts: { failWhen: (u) => (u.searchParams.get("query") === "Gunners Rest" ? 500 : null) } }));
    const res = await runP1(h.handle.services, options({ arms: ["Q-signal"] }));
    expect(res.exitCode).toBe(1);
    expect(res.stopped?.kind).toBe("resolution_failed");
    expect(existsSync(join(dir, "private", "p1_bars_status.csv"))).toBe(false);
  });

  it("marks a club's bars no_brand when its brand entity does not resolve", async () => {
    const world = makeWorld();
    world.brands["Liverpool FC"] = [];
    const h = track(harness(world));
    const res = await runP1(h.handle.services, options({ arms: ["Q-signal"] }));
    expect(res.statusRows.filter((r) => r.club === "lfc_olsc").map((r) => r.status)).toEqual(["no_brand", "no_brand"]);
    expect(res.log.club_entities.find((c) => c.club === "lfc_olsc")?.queriesTried).toHaveLength(4);
    expect(JSON.parse(readFileSync(join(dir, "pins", "club_entities.json"), "utf8")).lfc_olsc).toBeNull();
  });

  it("refuses the primary path when the geocoder's robots.txt disallows it", async () => {
    const h = track(harness(makeWorld(), { robots: "User-agent: *\nDisallow: /geocoder/\n" }));
    const res = await runP1(h.handle.services, options({ arms: ["Q-signal"] }));
    expect(res.stopped?.kind).toBe("resolution_failed");
    expect(res.stopped?.message).toMatch(/robots\.txt/);
    expect(h.census.urls).toEqual(["https://geocoding.geo.census.gov/robots.txt"]);
  });

  it("--no-google: provisional coverage, no closed check, no arm F", async () => {
    const h = track(harness(makeWorld(), { usePlaces: false }));
    const res = await runP1(h.handle.services, options({ noGoogle: true, arms: ["Q-signal", "F"] }));
    expect(res.exitCode).toBe(0);
    expect(res.summary.coverage_provisional).toBe(true);
    expect(res.statusRows.find((r) => r.barKey === "a00000000003")?.status).toBe("analyzed");
    expect(res.rows.some((r) => r.arm === "F")).toBe(false);
    expect(res.log.warnings).toContain("arm F skipped: no Google Places");
    expect(h.places.bodies).toHaveLength(0);
  });
});

describe("model arms", () => {
  it("records a refusal as an empty list (rows with blank ranks)", async () => {
    const h = track(harness(makeWorld(), { modelOpts: { refuseWhen: "Durham" } }));
    const res = await runP1(h.handle.services, options({ arms: ["F", "L"] }));
    for (const arm of ["F", "L"] as const) {
      expect(res.rows.find((r) => r.arm === arm && r.metro === "3719000")).toMatchObject({ rank: null, candidatesN: 0 });
      expect(res.summary.arms[arm]).toMatchObject({ refused: 1, failed: 0 });
    }
  });

  it("discards and retries once a response from another model", async () => {
    const h = track(harness(makeWorld(), { modelOpts: { wrongModelFirst: true, lNames: {} } }));
    const res = await runP1(h.handle.services, options({ arms: ["L"] }));
    expect(res.summary.arms.L).toMatchObject({ planned: 4, completed: 4, failed: 0 });
    expect(h.model.requests).toHaveLength(5);
  });

  it("answers a sixth tool call with the budget message", async () => {
    const h = track(harness(makeWorld(), { modelOpts: { fSearches: 7 } }));
    const res = await runP1(h.handle.services, options({ arms: ["F"] }));
    expect(res.summary.arms.F?.extra).toMatchObject({ tool_calls: 20 });
    const last = h.model.requests.filter((r) => r.tools).at(-1)!;
    const budgetHits = last.messages
      .filter((m) => m.role === "user" && typeof m.content !== "string")
      .flatMap((m) => m.content as ToolResultBlockParam[])
      .filter((b) => b.is_error && b.content === "tool budget reached; give your answer now");
    expect(budgetHits).toHaveLength(2);
  });

  it("fails the F conversation (no rows) when places_search still fails after retries, instead of letting the model answer", async () => {
    const h = track(harness(makeWorld(), { placesOpts: { toolStatus: 503 } }));
    const res = await runP1(h.handle.services, options({ arms: ["F"] }));
    expect(res.exitCode).toBe(0);
    expect(res.summary.arms.F).toMatchObject({ planned: 4, completed: 0, failed: 4, rows: 0 });
    expect(res.rows.some((r) => r.arm === "F")).toBe(false);
    expect(res.log.failures.filter((f) => f.arm === "F").every((f) => /places_search failed after retries/.test(f.reason))).toBe(true);
    // The model never saw a tool error: each conversation ended at its first tool call.
    const toolErrors = h.model.requests
      .flatMap((r) => r.messages)
      .filter((m) => m.role === "user" && typeof m.content !== "string")
      .flatMap((m) => m.content as ToolResultBlockParam[])
      .filter((b) => b.type === "tool_result" && b.is_error);
    expect(toolErrors).toHaveLength(0);
    // 1 try + 3 retries for each of the 4 failing tool calls, after 7 resolution searches.
    expect(h.places.bodies.filter((b) => !b.textQuery.includes(","))).toHaveLength(16);
  });

  it("stops the run when places_search is refused for the key (401/403)", async () => {
    const h = track(harness(makeWorld(), { placesOpts: { toolStatus: 403 } }));
    const res = await runP1(h.handle.services, options({ arms: ["F"] }));
    expect(res.stopped?.kind).toBe("fatal_api");
    expect(res.rows).toHaveLength(0);
  });

  it("retries a Google Places network error or timeout before giving up", async () => {
    const h = track(harness(makeWorld(), { placesOpts: { networkFailures: 2 } }));
    const res = await runP1(h.handle.services, options({ arms: ["Q-signal"] }));
    expect(res.exitCode).toBe(0);
    expect(res.statusRows.find((r) => r.barKey === "a00000000003")?.status).toBe("closed");
    // 7 resolution searches, the first one sent 3 times.
    expect(h.places.bodies).toHaveLength(9);
  });

  it("stores answers so a resumed run makes no model call", async () => {
    const stateFile = join(dir, "state.sqlite");
    const a = track(harness(makeWorld(), { stateFile }));
    const r1 = await runP1(a.handle.services, options({ arms: ["F", "L"] }));
    a.handle.close();
    open.splice(open.indexOf(a), 1);
    const b = track(harness(makeWorld(), { stateFile }));
    const r2 = await runP1(b.handle.services, options({ arms: ["F", "L"] }));
    expect(b.model.requests).toHaveLength(0);
    expect(r2.rows).toEqual(r1.rows);
  });
});

describe("F subset (§8 budget)", () => {
  it("draws floor(remaining / 5) queries with Python's random.Random(20261013), once", () => {
    const store = new RunStore(createMemoryKv());
    const keys = Array.from({ length: 40 }, (_, i) => `q${String(i).padStart(3, "0")}`);
    const s = decideFSubset(store, [...keys].reverse(), 35);
    expect(s.drawn).toBe(true);
    expect(s.size).toBe(7);
    // Same draw as random.Random(20261013).sample(sorted(keys), 7).
    expect([...s.selected]).toEqual(["q039", "q029", "q012", "q036", "q020", "q030", "q006"]);
    const again = decideFSubset(store, keys, 1000);
    expect([...again.selected]).toEqual([...s.selected]);
    expect(decideFSubset(store, keys.slice(0, 3), 1000)).toMatchObject({ drawn: false, size: 3 });
  });
});

describe("viability gate (§13)", () => {
  it("runs the probe queries with Q-signal only and reports the gate", async () => {
    const h = track(harness(makeWorld()));
    const res = await runP1(h.handle.services, options({ viability: true, arms: [...ARMS] }));
    expect(res.exitCode).toBe(0);
    expect(res.log.arms).toEqual(["Q-signal"]);
    expect(res.log.viability).toMatchObject({ combinations: 1, resolved: 1, in_q_signal_top50: 1, passes: false });
    expect(res.rows.every((r) => r.arm === "Q-signal" && r.metro === "3719000")).toBe(true);
  });
});

describe("public summary", () => {
  it("holds aggregates only: no bar names, bar keys, entity ids or place ids", async () => {
    const h = track(harness(makeWorld()));
    await runP1(h.handle.services, options());
    for (const f of ["p1_arms_summary.json", "p1_arms_summary.md"]) {
      const text = readFileSync(join(dir, "public", f), "utf8");
      for (const bar of parseBars(BARS_CSV)) {
        expect(text).not.toContain(bar.barName);
        expect(text).not.toContain(bar.barKey);
      }
      expect(text).not.toMatch(/q-ao-|q-ars-|gp-\d|00000000-0000/);
    }
  });
});

// The analysis code is Python; run it on the runner's output when numpy and scipy are installed.
const PYTHON = ["python", "python3"].find((cmd) => spawnSync(cmd, ["-c", "import numpy, scipy"], { encoding: "utf8" }).status === 0);
const ANALYZE = fileURLToPath(new URL("../../analyze.py", import.meta.url));

describe("analyze.py reads the runner's files", () => {
  it.skipIf(!PYTHON)("runs without input errors and sees every arm", async () => {
    const h = track(harness(makeWorld()));
    await runP1(h.handle.services, options());
    const out = join(dir, "analysis");
    const proc = spawnSync(
      PYTHON!,
      ["-B", ANALYZE, "--arms", join(dir, "private", "p1_arms.csv"), "--bars", join(dir, "private", "p1_bars_status.csv"), "--out", out, "--resamples", "200"],
      { encoding: "utf8" },
    );
    expect(proc.stderr).toBe("");
    expect(proc.status).toBe(0);
    const result = JSON.parse(readFileSync(join(out, "p1_results.json"), "utf8")) as {
      arms: Record<string, { n_queries: number }>;
      coverage: { total: Record<string, number> };
      derby: { source_arm: string; trials: number };
      info: Record<string, number>;
    };
    expect(Object.keys(result.arms).sort()).toEqual(["F", "L", "Q-pop", "Q-signal"]);
    expect(result.arms["Q-signal"]?.n_queries).toBe(4);
    expect(result.coverage.total).toMatchObject({ listed: 11, analyzed: 5, closed: 1, out_of_radius: 1, stale_page: 1, no_metro: 1, unresolved: 2 });
    expect(result.derby).toMatchObject({ source_arm: "Q-derby", trials: 2 });
    expect(result.info).toMatchObject({ analyzed_bars_without_any_arm_row: 0, arm_rows_for_bars_not_analyzed: 0 });
  });
});
