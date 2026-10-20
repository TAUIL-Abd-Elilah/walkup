import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../../run_arms";
import { parseBars } from "../bars";
import { planRun, renderPlan } from "../plan";
import { ARMS } from "../protocol";
import { BARS_CSV } from "./fake-world";

const SYNTHETIC_CSV = fileURLToPath(new URL("../test-data/bars_synthetic.csv", import.meta.url));

describe("dry-run plan", () => {
  const base = { arms: [...ARMS], limit: null, viability: false, noGoogle: false, qlooCap: 900, placesDailyCap: 300, today: "2026-10-20" };

  it("counts exclusions known before any call and upper bounds per stage", () => {
    const plan = planRun(parseBars(BARS_CSV), base);
    expect(plan.selection).toEqual({ mode: "full", queries: 7, bars: 11, metros: 3 });
    expect(plan.knownBeforeCalls).toEqual({ stale_page: 1, no_metro: 1, to_resolve: 9, primary_path_candidates: 7, fallback_path: 2 });
    expect(plan.derbyMetros).toBe(2);
    expect(plan.calls.qloo).toEqual({
      brand_search_max: 12,
      brand_entities_max: 12,
      tags: 4,
      resolution: 9,
      q_pop: 3,
      q_signal: 7,
      q_derby: 6,
      total_max: 53,
    });
    expect(plan.calls.places).toMatchObject({ resolution_max: 9, f_tools_max: 35, total_max: 44, f_subset_needed: false });
    expect(plan.calls.model).toEqual({ f_conversations_max: 7, l_calls_max: 7 });
    expect(plan.budget).toMatchObject({ qloo_cap_per_run: 900, runs_needed_at_cap: 1 });
    expect(renderPlan(plan).join("\n")).toMatch(/total at most 53/);
  });

  it("follows --arms, --no-google and the cap", () => {
    const plan = planRun(parseBars(BARS_CSV), { ...base, arms: ["Q-signal"], noGoogle: true, qlooCap: 20 });
    expect(plan.calls.qloo).toMatchObject({ q_pop: 0, q_signal: 7, q_derby: 0, total_max: 44 });
    expect(plan.calls.places.total_max).toBe(0);
    expect(plan.budget.runs_needed_at_cap).toBe(3);
    expect(plan.notes.join(" ")).toMatch(/--no-google/);
    expect(plan.notes.join(" ")).toMatch(/resume from the cache/);
  });

  it("plans the F subset when the Places cap would be exceeded", () => {
    // 600 queries over one metro each: 600 resolutions + 5 x 600 tool calls > 2,500.
    const header = BARS_CSV.split("\n")[0]!;
    const rows = Array.from({ length: 600 }, (_, i) => {
      const key = `b${String(i).padStart(11, "0")}`;
      return `${key},arsenal_america,X,Exampleton,TX,Example Bar ${i},"${i + 1} Example St, Exampleton, TX",https://example.invalid,2026-10-13T00:00:00Z,,official,,,${9800000 + i},Exampleton city,TX,30.0,-97.0,place,direct`;
    });
    const plan = planRun(parseBars([header, ...rows].join("\n")), base);
    expect(plan.calls.places).toMatchObject({ resolution_max: 600, f_subset_needed: true, f_subset_size: 380, total_max: 2500 });
    expect(plan.calls.model.f_conversations_max).toBe(380);
  });
});

describe("CLI --dry-run", () => {
  let dir: string | null = null;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("prints the plan, needs no key and writes nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "p1-dry-"));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    const out = join(dir, "out");
    const code = await main(["--dry-run", "--bars", SYNTHETIC_CSV, "--out", out, "--public-out", out, "--pins-dir", out, "--state-dir", out]);
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/input is the sealed table: false/);
    expect(lines.join("\n")).toMatch(/DRY RUN: nothing was sent and nothing was written/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses to build live services without a Qloo key (no network, nothing written)", async () => {
    const { createServices } = await import("../services");
    const never = async (): Promise<Response> => {
      throw new Error("network must not be reached");
    };
    expect(() =>
      createServices({
        stateFile: ":memory:",
        spendFile: null,
        env: {},
        qlooFetch: never,
        placesFetch: never,
        censusFetch: never,
        modelClient: null,
        usePlaces: false,
        maxQlooCalls: 10,
        placesDailyCap: 10,
        llmDailyCapUsd: 1,
      }),
    ).toThrow(/QLOO_API_KEY is not set/);
    expect(() =>
      createServices({
        stateFile: ":memory:",
        spendFile: null,
        env: { QLOO_API_KEY: "test-qloo-key-not-real" },
        qlooFetch: never,
        placesFetch: never,
        censusFetch: never,
        modelClient: null,
        usePlaces: true,
        maxQlooCalls: 10,
        placesDailyCap: 10,
        llmDailyCapUsd: 1,
      }),
    ).toThrow(/GOOGLE_PLACES_API_KEY is not set/);
  });
});
