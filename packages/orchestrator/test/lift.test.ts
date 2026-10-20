/**
 * The lift fix on the fixture world: the split-half check and its typed
 * fallbacks, the partner house twin (its failure path), and the operator
 * inputs that only remove things (areas, categories, all ages).
 */
import { describe, expect, it } from "vitest";
import type { Bill, LiftTile } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES } from "@walkup/engine";
import { createWorld, WORLD_TAG_PINS, WORLD_VENUES, type World } from "@walkup/qloo-world";
import { planShow } from "../src/index";
import { isExcludedArea, SPLIT_HALF_NODE } from "../src/steps/heat";
import { HOUSE_TWIN_CHIP, HOUSE_TWIN_NODE, houseTwinChipLabel } from "../src/steps/partners";
import { deps, runPreset, sheetOf } from "./helpers";

function failing(world: World, fail: (u: URL) => boolean): World {
  const qlooFetch: World["qlooFetch"] = async (url, init) => {
    const u = new URL(url);
    if (fail(u)) return new Response(JSON.stringify({ synthetic: true, error: { message: "synthetic failure" } }), { status: 500, headers: { "content-type": "application/json" } });
    return world.qlooFetch(url, init);
  };
  return { ...world, qlooFetch };
}

const isHeat = (u: URL) => u.pathname === "/v2/insights" && u.searchParams.get("filter.type") === "urn:heatmap";

describe("split-half check: typed fallbacks", () => {
  it("a failed half leaves the check null with the reason, and the map still stands", async () => {
    // Q4, Q5 and Q6 answer; every later heatmap (the halves) fails.
    let heats = 0;
    const world = failing(createWorld(), (u) => isHeat(u) && ++heats > 3);
    const r = await runPreset("g1-a", deps({ world }));
    const s = sheetOf(r.final);
    const d = s.cards.liftMap.results.liftDiagnostics!;
    expect(d.splitHalfSpearman).toBeNull();
    expect(d.note).toMatch(/A split-half heatmap failed \(Qloo returned HTTP 500\)/);
    expect(s.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3).length).toBeGreaterThan(0);
    // The failed call has its ledger entry and the card cites it.
    const failed = s.ledger.find((e) => (e.note ?? "").includes(SPLIT_HALF_NODE) && e.httpStatus === 500);
    expect(failed).toBeDefined();
    expect(s.cards.liftMap.provenance).toContain(failed!.id);
    // A check that could not run does not demote the map.
    expect(s.cards.partners.results.some((p) => p.tileGeohash !== null)).toBe(true);
  });

  it("a genre-tag baseline cannot be split: only the bill is, with a note", async () => {
    const v = WORLD_VENUES.truth;
    const bill: Bill = {
      acts: [
        { name: "Hollis Creek String Band", role: "headliner" },
        { name: "Marla Vane", role: "co" },
      ],
      venue: { name: v.name, lat: v.lat, lon: v.lon, city: v.city, state: v.state },
      date: "2026-11-20",
      weekday: "friday",
      legalAgeEnforced: true,
      classification: "Music / Country",
    };
    // No Ticketmaster venue id: no roster, so the pinned genre tag is the baseline.
    const s = sheetOf(await planShow({ bill }, deps()));
    expect(s.cards.liftMap.results.diagnostics.baseline).toBe("tag");
    const halves = s.ledger.filter((e) => (e.note ?? "").includes(SPLIT_HALF_NODE));
    expect(halves.map((e) => /node (Q\d) /.exec(e.note ?? "")?.[1])).toEqual(["Q4", "Q4"]);
    const d = s.cards.liftMap.results.liftDiagnostics!;
    expect(typeof d.splitHalfSpearman).toBe("number");
    expect(d.note).toMatch(/one genre tag, so only the bill was split/);
    expect(WORLD_TAG_PINS.baselineTags).toBeDefined();
  });
});

describe("partner house twin", () => {
  it("a failed twin leaves its pool without a house rank and says so", async () => {
    // The twin is the only place request with a price cap and no explainability.
    const world = failing(createWorld(), (u) => u.searchParams.get("filter.type") === "urn:entity:place" && u.searchParams.has("filter.price_level.max") && !u.searchParams.has("feature.explainability"));
    const s = sheetOf((await runPreset("g1-b", deps({ world }))).final);
    expect(s.cards.partners.results.length).toBeGreaterThan(0);
    for (const p of s.cards.partners.results) {
      expect(p.houseRank).toBeUndefined();
      expect(p.ubiquityPenalty).toBeUndefined();
      expect(p.chips.some((c) => c.label.startsWith(HOUSE_TWIN_CHIP))).toBe(false);
    }
    expect(s.cards.partners.reason).toMatch(/The usual-crowd search failed for area 1 \(Qloo returned HTTP 500\)/);
    expect(s.cards.partners.limits.some((l) => /^The usual-crowd rank/.test(l))).toBe(false);
    expect(s.ledger.filter((e) => (e.note ?? "").includes(`node ${HOUSE_TWIN_NODE}`)).every((e) => e.httpStatus === 500)).toBe(true);
  });

  it("labels the chip with the rank difference, or says the place is not in the house list", () => {
    expect(houseTwinChipLabel(9, 4, 50)).toBe("tonight vs house +5 ranks");
    expect(houseTwinChipLabel(2, 4, 50)).toBe("tonight vs house -2 ranks");
    expect(houseTwinChipLabel(null, 4, 50)).toBe("tonight vs house: not in the house top 50");
  });
});

describe("operator inputs that only remove things", () => {
  it("excludeAreas leaves an area off the top list, by geohash or by name (any case), and says so", async () => {
    const base = sheetOf((await runPreset("g1-a", deps())).final);
    const top = base.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3);
    const first = top[0] as LiftTile;
    const byGh = sheetOf(await planShow({ presetId: "g1-a", operator: { excludeAreas: [first.geohash.toUpperCase()] } }, deps()));
    expect(byGh.cards.liftMap.results.tiles.some((t) => t.geohash === first.geohash)).toBe(false);
    expect(byGh.cards.liftMap.summary).toMatch(/1 area left out at your request/);
    expect(byGh.cards.partners.results.some((p) => p.tileGeohash === first.geohash)).toBe(false);
    expect(byGh.operator.excludeAreas).toEqual([first.geohash.toUpperCase()]);
    // A name can cover many tiles (every tile the gazetteer names that way goes).
    const byName = sheetOf(await planShow({ presetId: "g1-a", operator: { excludeAreas: [` ${first.name!.toLowerCase()} `] } }, deps()));
    expect(byName.cards.liftMap.results.tiles.some((t) => t.name === first.name && t.lift >= 1.3)).toBe(false);
    expect(byName.cards.liftMap.summary).toMatch(/\d+ areas? left out at your request/);
    expect(byName.cards.partners.results.some((p) => p.tileName === first.name)).toBe(false);
  });

  it("isExcludedArea matches geohash or name, case-insensitively", () => {
    const t = { geohash: "dn6m9h", name: "East Nashville" };
    expect(isExcludedArea(t, ["DN6M9H"])).toBe(true);
    expect(isExcludedArea(t, ["east nashville"])).toBe(true);
    expect(isExcludedArea(t, ["Germantown", ""])).toBe(false);
    expect(isExcludedArea(t, undefined)).toBe(false);
    expect(isExcludedArea({ geohash: "dn6m9h" }, ["east nashville"])).toBe(false);
  });

  it("excludeCategories drops those partner categories", async () => {
    const s = sheetOf(await planShow({ presetId: "g1-a", operator: { excludeCategories: ["record_store", "Cafe"] } }, deps()));
    expect(s.cards.partners.results.some((p) => p.category === "record_store" || p.category === "cafe")).toBe(false);
    expect(s.cards.partners.summary).toMatch(/left out by category \(your exclusions\)/);
  });

  it("allAges: no bar partners and night clubs excluded at the request, even on a 21+ show", async () => {
    const plain = sheetOf((await runPreset("g1-a", deps())).final);
    expect(plain.bill.legalAgeEnforced).toBe(true);
    expect(plain.cards.partners.results.some((p) => DEFAULT_BAR_CATEGORIES.includes(p.category))).toBe(true);
    const s = sheetOf(await planShow({ presetId: "g1-a", operator: { allAges: true } }, deps()));
    expect(s.cards.partners.results.some((p) => DEFAULT_BAR_CATEGORIES.includes(p.category))).toBe(false);
    expect(s.cards.partners.summary).toMatch(/left out by category \(all-ages show\)/);
    const q9 = s.ledger.filter((e) => (e.note ?? "").includes("node Q9"));
    expect(q9.length).toBeGreaterThan(0);
    for (const e of q9) expect(String(e.params["filter.exclude.tags"] ?? "")).toContain("night_club");
  });

  it("allAges false never relaxes Ticketmaster's rule on an all-ages show", async () => {
    const s = sheetOf(await planShow({ presetId: "g1-b", operator: { allAges: false } }, deps()));
    expect(s.bill.legalAgeEnforced).toBe(false);
    for (const e of s.ledger.filter((x) => (x.note ?? "").includes("node Q9"))) expect(String(e.params["filter.exclude.tags"] ?? "")).toContain("night_club");
  });
});
