/**
 * Heat for subsets of a signal: halves of one bill agree on where its crowd
 * lives but are not identical, so a split-half check on lift has something to
 * measure; a bill of two unrelated acts does not hold up; a broad house signal
 * looks more like plain foot traffic than a focused bill.
 */
import { describe, expect, it } from "vitest";
import type { HeatCell } from "@walkup/contracts";
import { spearman, splitHalfAgreement, splitHalves } from "@walkup/engine";
import { catalogByKey, createWorld, WORLD_VENUES, type World } from "../src/index";

const truth = WORLD_VENUES.truth;
const ids = (...keys: string[]) => keys.map((k) => catalogByKey(k).id);
const BILL_A = ids("hollis_creek", "marla_vane", "ferry_lights");
const MIXED = ids("paper_satellites", "orquesta_brisa");
const HOUSE = ids(
  "granite_static",
  "velvet_coast",
  "wren_wolfe",
  "tessa_arden",
  "juniper_tate",
  "theo_marsh",
  "big_sky_static",
  "sundown_kids",
  "mason_reyes",
  "lowland_echo",
  "brass_lantern",
  "cold_harbor",
);

async function heat(world: World, entities: string[]): Promise<HeatCell[]> {
  const qs = new URLSearchParams({
    "filter.type": "urn:heatmap",
    "filter.location": `POINT(${truth.lon} ${truth.lat})`,
    "filter.location.radius": "40000",
    "signal.interests.entities": entities.join(","),
  });
  const res = await world.qlooFetch(`https://hackathon.api.qloo.com/v2/insights?${qs.toString()}`, { method: "GET" });
  const body = (await res.json()) as { results: { heatmap: { location: { latitude: number; longitude: number; geohash: string }; query: { affinity: number; affinity_rank: number; popularity: number } }[] } };
  return body.results.heatmap.map((r) => ({
    geohash: r.location.geohash,
    lat: r.location.latitude,
    lon: r.location.longitude,
    affinity: r.query.affinity,
    affinityRank: r.query.affinity_rank,
    popularity: r.query.popularity,
  }));
}

async function splitHalf(world: World, bill: string[]): Promise<number | null> {
  const [ba, bb] = splitHalves(bill, (x) => x);
  const [ha, hb] = splitHalves(HOUSE, (x) => x);
  const r = splitHalfAgreement({ billA: await heat(world, ba), billB: await heat(world, bb), houseA: await heat(world, ha), houseB: await heat(world, hb) });
  return r.spearman;
}

describe("heat for seed subsets", () => {
  it("halves of one bill agree on where its crowd lives but are not identical", async () => {
    const world = createWorld();
    const [a, b] = splitHalves(BILL_A, (x) => x);
    const ha = new Map((await heat(world, a)).map((c) => [c.geohash, c.affinity]));
    const hb = await heat(world, b);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const c of hb) {
      const v = ha.get(c.geohash);
      if (v === undefined) continue;
      xs.push(v);
      ys.push(c.affinity);
    }
    expect(xs.length).toBeGreaterThan(1000);
    const rho = spearman(xs, ys) as number;
    expect(rho).toBeGreaterThan(0.8);
    expect(rho).toBeLessThan(0.999);
    // A real share of cells moves by more than a few percentile points between the halves.
    const moved = xs.filter((x, i) => Math.abs(x - (ys[i] as number)) > 0.05).length;
    expect(moved / xs.length).toBeGreaterThan(0.1);
  });

  it("the split-half check passes for a focused bill and fails for two unrelated acts", async () => {
    const world = createWorld();
    expect((await splitHalf(world, BILL_A)) as number).toBeGreaterThan(0.5);
    expect((await splitHalf(world, MIXED)) as number).toBeLessThanOrEqual(0.5);
  });

  it("a broad house signal tracks plain foot traffic more closely than a focused bill", async () => {
    const world = createWorld();
    const pop = (cells: HeatCell[]) => spearman(cells.map((c) => c.affinity), cells.map((c) => c.popularity)) as number;
    const house = pop(await heat(world, HOUSE));
    const bill = pop(await heat(world, BILL_A));
    expect(house).toBeGreaterThan(bill);
    // Both still track popularity closely, as live heatmaps do.
    expect(bill).toBeGreaterThan(0.8);
  });
});
