import { describe, expect, it } from "vitest";
import type { LiftTile, QlooEntity } from "@walkup/contracts";
import CHAIN_FILE from "../../../config/chains.json";
import { chainOf, compileChains, isChain, normalizeChainName, type ChainList } from "../src/chains";
import { scorePartnersWithReport, type PartnerPool } from "../src/partners";
import { buildPrePostSpots } from "../src/prepost";
import { chainsCause } from "../src/steps";
import { place } from "./helpers";

const LIST = CHAIN_FILE as ChainList;

function tile(geohash: string, lift: number): LiftTile {
  return { geohash, lat: 38.88, lon: -77.02, lift, billPct: 0.9, housePct: 0.5, popularityPct: 0.8 };
}

function pool(tileGeohash: string | null, entities: QlooEntity[]): PartnerPool {
  return { tileGeohash, ledgerRef: "Q9", entities };
}

describe("chain names", () => {
  it("normalizes case, accents, apostrophes, periods, '&' and a leading 'the'", () => {
    expect(normalizeChainName("Dunkin'")).toBe("dunkin");
    expect(normalizeChainName("T.J. Maxx")).toBe("tj maxx");
    expect(normalizeChainName("Barnes & Noble")).toBe("barnes and noble");
    expect(normalizeChainName("Fogo de Chão")).toBe("fogo de chao");
    expect(normalizeChainName("The Cheesecake Factory")).toBe("cheesecake factory");
    expect(normalizeChainName("Chick-fil-A")).toBe("chick fil a");
    expect(normalizeChainName("Applebee’s Grill + Bar")).toBe("applebees grill and bar");
  });

  it("matches the chains from the Anthem run, with store suffixes and location words", () => {
    const cases: [string, string][] = [
      ["Hooters", "Hooters"],
      ["Outback Steakhouse", "Outback Steakhouse"],
      ["Outback Steakhouse Tysons", "Outback Steakhouse"],
      ["Buffalo Wild Wings", "Buffalo Wild Wings"],
      ["Panera Bread", "Panera Bread"],
      ["Starbucks Coffee Company", "Starbucks"],
      ["STARBUCKS #08217", "Starbucks"],
      ["Starbucks Reserve", "Starbucks"],
      ["Dunkin'", "Dunkin'"],
      ["Dunkin Donuts", "Dunkin'"],
      ["Potbelly Sandwich Shop", "Potbelly"],
      ["Smoothie King", "Smoothie King"],
      ["Tropical Smoothie Cafe", "Tropical Smoothie Cafe"],
      ["Barnes & Noble", "Barnes & Noble"],
      ["Barnes and Noble Booksellers", "Barnes & Noble"],
      ["Ross Dress for Less", "Ross Dress for Less"],
      ["TJ Maxx", "T.J. Maxx"],
      ["The Capital Grille", "The Capital Grille"],
      ["Capital Grille", "The Capital Grille"],
      ["Target", "Target"],
      ["Target - Tysons Corner", "Target"],
      ["Target Store 1234", "Target"],
      ["Gap (Georgetown)", "Gap"],
      ["Seasons 52", "Seasons 52"],
      ["&pizza", "&pizza"],
    ];
    for (const [name, brand] of cases) expect(chainOf(name, LIST), name).toBe(brand);
  });

  it("leaves local places alone, even when they share a word with a brand", () => {
    for (const name of [
      "The Hill Cafe",
      "Stable DC",
      "Hush Harbor",
      "Pho Deluxe Tysons",
      "Jerry's Seafood",
      "Seasons Restaurant",
      "Target Practice Pub",
      "Gap Year Coffee",
      "Burlington Bar & Grill",
      "Ross Bakery",
      "Hollister Ranch Tavern",
      "Smoothie Kingdom",
      "Capital Grill & Taproom",
      "",
    ]) {
      expect(isChain(name, LIST), name).toBe(false);
    }
  });

  it("compiles once per list and accepts a bare array or a compiled index", () => {
    const idx = compileChains(LIST);
    expect(compileChains(LIST)).toBe(idx);
    expect(idx.size).toBeGreaterThanOrEqual(LIST.chains.length);
    expect(isChain("Starbucks", idx)).toBe(true);
    expect(isChain("Joe's Diner", [{ name: "Joe's Diner", exact: true }])).toBe(true);
    expect(isChain("Joe's Diner Two", [{ name: "Joe's Diner", exact: true }])).toBe(false);
    expect(isChain("Joe's Diner Two", [{ name: "Joe's Diner" }])).toBe(true);
  });
});

describe("chain rule in partner scoring", () => {
  const CHAINS = [{ name: "Hooters" }, { name: "Starbucks", aliases: ["Starbucks Coffee Company"] }];
  // Tile A: two chains on top, then locals; tile B: locals only.
  const a = [
    place("Hooters", { id: "a-hooters", category: "bar" }),
    place("Starbucks Coffee Company", { id: "a-sbux", category: "cafe" }),
    place("Grimsley's Tavern", { id: "a-1", category: "bar" }),
    place("Haskins Records", { id: "a-2", category: "record_store" }),
    place("Mabry Coffee", { id: "a-3", category: "cafe" }),
  ];
  const b = [place("Okafor's Kitchen", { id: "b-1", category: "restaurant" }), place("Tidwell Books", { id: "b-2", category: "book_store" })];
  const tiles = [tile("aaaaaa", 2), tile("bbbbbb", 1)];

  it("lists chains after every local place of their area and marks them; scores and picks are otherwise the same", () => {
    const without = scorePartnersWithReport([pool("aaaaaa", a), pool("bbbbbb", b)], tiles, { minTotal: 0 });
    const withRule = scorePartnersWithReport([pool("aaaaaa", a), pool("bbbbbb", b)], tiles, { minTotal: 0, chains: CHAINS });
    expect(without.partners.map((p) => p.entity.entityId)).toEqual(["a-hooters", "a-sbux", "a-1", "a-2", "a-3", "b-1", "b-2"]);
    expect(withRule.partners.map((p) => p.entity.entityId)).toEqual(["a-1", "a-2", "a-3", "a-hooters", "a-sbux", "b-1", "b-2"]);
    expect(withRule.partners.filter((p) => p.chain).map((p) => p.entity.entityId)).toEqual(["a-hooters", "a-sbux"]);
    expect(without.partners.some((p) => "chain" in p)).toBe(false);
    const score = (r: typeof without, id: string) => r.partners.find((p) => p.entity.entityId === id)?.score;
    expect(score(withRule, "a-hooters")).toBe(score(without, "a-hooters"));
    expect(withRule.report).toMatchObject({ chains: 2, chainsMovedDown: 2, chainsOffList: [], chainsKept: 2 });
    expect(without.report).toMatchObject({ chains: 0, chainsMovedDown: 0, chainsOffList: [], chainsKept: 0 });
  });

  it("keeps a chain only for a slot no local place can fill, and names the chains it pushed off", () => {
    const many = [
      place("Hooters", { id: "c-hooters", category: "bar" }),
      place("Grimsley's", { id: "c-1", category: "bar" }),
      place("Ledford's", { id: "c-2", category: "bar" }),
      place("Starbucks", { id: "c-sbux", category: "cafe" }),
    ];
    // At most 2 bars in the tile: two local bars take both bar slots; the cafe chain still fills the cafe slot.
    const r = scorePartnersWithReport([pool("aaaaaa", many)], [tile("aaaaaa", 2)], { minTotal: 0, chains: CHAINS });
    expect(r.partners.map((p) => p.entity.entityId)).toEqual(["c-1", "c-2", "c-sbux"]);
    expect(r.report.chainsOffList).toEqual(["Hooters"]);
    expect(r.report.chainsMovedDown).toBe(1);
    expect(r.report.chainsKept).toBe(1);
    // Starbucks scored below both locals anyway: it was not moved.
    expect(r.report.chains).toBe(2);
  });

  it("a chain below every local already is not counted as moved", () => {
    const r = scorePartnersWithReport([pool("bbbbbb", [...b, place("Hooters", { id: "b-h", category: "bar" })])], [tile("bbbbbb", 1)], { minTotal: 0, chains: CHAINS });
    expect(r.partners.map((p) => p.entity.entityId)).toEqual(["b-1", "b-2", "b-h"]);
    expect(r.report).toMatchObject({ chains: 1, chainsMovedDown: 0, chainsOffList: [], chainsKept: 1 });
  });

  it("is deterministic", () => {
    const run = () => JSON.stringify(scorePartnersWithReport([pool("aaaaaa", a), pool("bbbbbb", b)], tiles, { minTotal: 0, chains: LIST }));
    expect(run()).toBe(run());
  });
});

describe("chain rule in the step stream", () => {
  it("says how many chains are listed and names the ones left off, once per brand", () => {
    expect(chainsCause(0, [], "places")).toBeNull();
    expect(chainsCause(1, [], "spots")).toBe("Listed 1 national chain last, after the local spots: no local spot filled its slot");
    expect(chainsCause(0, ["Panera Bread", "Panera Bread", "Applebee's"], "places")).toBe("Left off 3 national chains: Panera Bread (2) and Applebee's");
    expect(chainsCause(2, ["Applebee's"], "places", 2, 1)).toBe(
      "Listed 2 national chains last, after the local places: no local place filled their slot; left off 1 national chain, at most 2 per list: Applebee's",
    );
    expect(chainsCause(0, ["A", "B", "C", "D", "E", "F"], "places")).toBe("Left off 6 national chains: A, B, C, D and 2 more");
  });
});

describe("chain rule in pre/post spots", () => {
  const spots = [
    place("Starbucks Coffee Company", { id: "s-1", category: "cafe" }),
    place("Mabry Coffee", { id: "s-2", category: "cafe" }),
    place("Panera Bread", { id: "s-3", category: "restaurant" }),
    place("Grimsley's", { id: "s-4", category: "bar" }),
    place("Okafor's Kitchen", { id: "s-5", category: "restaurant" }),
  ];

  it("puts chains after the local spots before the cut, keeping Qloo's weights", () => {
    const plain = buildPrePostSpots(spots, { attendance: null, legalAgeEnforced: true, ledgerRef: "Q10", maxSpots: 4 });
    const r = buildPrePostSpots(spots, { attendance: null, legalAgeEnforced: true, ledgerRef: "Q10", maxSpots: 4, chains: LIST });
    expect(plain.spots.map((s) => s.entity.entityId)).toEqual(["s-1", "s-2", "s-3", "s-4"]);
    expect(r.spots.map((s) => s.entity.entityId)).toEqual(["s-2", "s-4", "s-5", "s-1"]);
    expect(r.spots.filter((s) => s.chain).map((s) => s.entity.entityId)).toEqual(["s-1"]);
    expect(plain.spots.some((s) => "chain" in s)).toBe(false);
    expect(r.report).toMatchObject({ chains: 2, chainsMovedDown: 2, chainsOffList: ["Panera Bread"] });
    // Shares follow Qloo's rank: Starbucks (rank 1) keeps the largest share though it is listed last.
    const share = new Map(r.spots.map((s) => [s.entity.entityId, s.expectedShare]));
    expect(share.get("s-1")!).toBeGreaterThan(share.get("s-2")!);
  });

  it("changes nothing when no chain is eligible", () => {
    const locals = spots.filter((s) => !isChain(s.name, LIST));
    const a = buildPrePostSpots(locals, { attendance: 300, legalAgeEnforced: true, ledgerRef: "Q10" });
    const b = buildPrePostSpots(locals, { attendance: 300, legalAgeEnforced: true, ledgerRef: "Q10", chains: LIST });
    expect(b.spots).toEqual(a.spots);
    expect(b.report).toMatchObject({ chains: 0, chainsMovedDown: 0, chainsOffList: [] });
  });
});
