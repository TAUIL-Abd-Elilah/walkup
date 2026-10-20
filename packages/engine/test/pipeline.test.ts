/**
 * End-to-end over synthetic data: heatmaps -> lift -> partners -> budget ->
 * guard. Also checks the package stays pure (no randomness, clock or I/O).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as engine from "../src/index";
import { child7, gridGeohash6, heatMap, place } from "./helpers";

const here = dirname(fileURLToPath(import.meta.url));

function runPipeline() {
  const tiles = gridGeohash6(60);
  const bill = heatMap(tiles, (i) => i + (i % 7 === 2 ? 80 : 0), (i) => 0.3 + (i % 10) / 15);
  const house = heatMap(tiles, (i) => i, (i) => 0.3 + (i % 10) / 15);
  const lift = engine.computeLiftMap(bill, house, { adultPopulation: () => 2400, maxTiles: 3 });
  const cats = ["bar", "record_store", "cafe", "barber_shop", "restaurant"];
  const pools = lift.top.map((t, k) => ({
    tileGeohash: t.geohash,
    ledgerRef: `Q${9 + k}`,
    entities: Array.from({ length: 12 }, (_, i) =>
      place(`Spot ${k}-${i}`, {
        id: `E-${k}-${i}`,
        category: cats[i % cats.length] as string,
        distanceM: 100 * ((i * 3) % 7),
        hours: { Thursday: [{ opens: "T11:00", closes: "T23:00" }] },
      }),
    ),
  }));
  const partners = engine.scorePartnersWithReport(pools, lift.top, { weekday: "thursday" });
  const budget = engine.budgetSplit(lift.top, () => 1800, 0.15);
  const allow = engine.buildCopyAllowlist([
    { id: "urn:tag:genre:music:americana", name: "Americana" },
    { id: "urn:tag:ethnicity:qloo:x", name: "Some Group" },
  ]);
  const facts: engine.NarrationFacts = {
    entityIds: partners.partners.map((p) => p.entity.entityId),
    geohashes: lift.top.map((t) => t.geohash),
    numbers: engine.collectFactNumbers([lift.top.map((t) => t.lift), budget.map((b) => b.share), partners.partners.length]),
    allowlistTagIds: allow.allowed,
    allowlistTagNames: allow.names,
    names: partners.partners.map((p) => p.entity.name),
    deniedTagNames: allow.deniedNames,
    deniedTagCount: allow.deniedCount,
  };
  const top = lift.top[0]!;
  const share = Math.round((budget[0]!.share ?? 0) * 100);
  const guard = engine.validateNarration(
    {
      summary: `Three tiles over-index for this bill. The first carries ${share}% of the suggested budget. Expect 4,000 fans.`,
      tileWhy: [{ geohash: top.geohash, text: `Lift ${top.lift.toFixed(1)}x versus the house crowd.` }],
      partnerLines: partners.partners.slice(0, 2).map((p) => ({ entityId: p.entity.entityId, text: `${p.entity.name} fits Americana fans.` })),
      templated: false,
    },
    facts,
  );
  return { tiles, lift, partners, budget, guard };
}

describe("synthetic pipeline", () => {
  it("produces top tiles, 15-25 diverse partners, a budget and a guarded narration", () => {
    const { lift, partners, budget, guard } = runPipeline();
    expect(lift.top).toHaveLength(3);
    expect(lift.top.every((t) => t.lift >= 1.3 && t.adultPopulation === 2400)).toBe(true);
    expect(lift.diagnostics.liftWeak).toBe(false);
    expect(partners.partners.length).toBeGreaterThanOrEqual(15);
    expect(partners.partners.length).toBeLessThanOrEqual(25);
    expect(partners.report.belowMinimum).toBe(false);
    for (const t of lift.top) {
      const inTile = partners.partners.filter((p) => p.tileGeohash === t.geohash);
      expect(inTile.length).toBeLessThanOrEqual(8);
      expect(inTile.some((p) => p.category !== "bar")).toBe(true);
      const perCat = new Map<string, number>();
      for (const p of inTile) perCat.set(p.category, (perCat.get(p.category) ?? 0) + 1);
      expect(Math.max(...perCat.values())).toBeLessThanOrEqual(2);
    }
    expect(partners.partners.every((p) => p.hoursOnDay === "11:00-23:00")).toBe(true);
    expect(budget.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1);
    expect(guard.report.dropped).toBe(1);
    expect(guard.report.reasons).toEqual(["summary sentence 3: number 4,000 not in this run's results"]);
    expect(guard.report.deniedTagCount).toBe(1);
    expect(guard.narration.partnerLines).toHaveLength(2);
    expect(guard.narration.tileWhy).toHaveLength(1);
  });
  it("is reproducible", () => {
    expect(JSON.stringify(runPipeline())).toBe(JSON.stringify(runPipeline()));
  });
  it("aggregates geohash-7 cells into the same tiles", () => {
    const { tiles } = runPipeline();
    const doubled = tiles.flatMap((t, i) => [
      { geohash: child7(t, 1), lat: Number.NaN, lon: Number.NaN, affinity: i, affinityRank: 0, popularity: 0.5 },
      { geohash: child7(t, 2), lat: Number.NaN, lon: Number.NaN, affinity: i, affinityRank: 0, popularity: 0.5 },
    ]);
    expect(engine.aggregateToGeohash6(doubled).map((c) => c.geohash)).toEqual([...tiles].sort());
  });
});

describe("purity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("never calls Math.random or the clock", () => {
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random used");
    });
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now used");
    });
    expect(() => runPipeline()).not.toThrow();
    expect(() => engine.permutationTest([1, 2, 3], [4, 5, 6], { iterations: 50 })).not.toThrow();
    expect(() => engine.loadBalance([{ entityId: "a", weight: 1, assumedCapacity: 5 }], 10)).not.toThrow();
  });
  it("source has no network, file, clock or Math.random use", () => {
    const srcDir = join(here, "..", "src");
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const code = readFileSync(join(srcDir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/Math\.random|Date\.now|new Date\(|fetch\(|from "node:|require\(|process\.env/);
    }
  });
  it("exports the public API", () => {
    for (const name of [
      "aggregateToGeohash6",
      "pctRankMap",
      "computeLift",
      "computeLiftAll",
      "computeLiftMap",
      "liftDiagnostics",
      "spearman",
      "kendallTau",
      "jaccard",
      "topKOverlap",
      "permutationTest",
      "evaluateKG1",
      "evaluateKG2",
      "scorePartners",
      "rankDeclaredPartners",
      "loadBalance",
      "budgetSplit",
      "isDeniedTag",
      "buildCopyAllowlist",
      "stripPersonTags",
      "validateNarration",
      "hoursOnDay",
      "buildPrePostSpots",
    ]) {
      expect(typeof (engine as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});
