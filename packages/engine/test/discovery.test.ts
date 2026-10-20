import { describe, expect, it } from "vitest";
import type { LiftTile, Partner } from "@walkup/contracts";
import { AREA_RULE, areaDiscovery, DISCOVERY_RULES, mostCommonCategories, PARTNER_RULE, partnerDiscovery, pickDiscovery, rankAreas, type AreaDiscoveryInput } from "../src/discovery";
import { place } from "./helpers";

function tile(geohash: string, lift: number, billPct: number, name?: string): LiftTile {
  const t: LiftTile = { geohash, lat: 36.9, lon: -76.2, lift, billPct, housePct: 0.3, popularityPct: 0.5 };
  if (name) t.name = name;
  return t;
}

/** The G2-like map: Wynnewood is 5th by lift but 10th by this crowd's heat. */
const TILES: LiftTile[] = [
  tile("dq9cgz", 1.7809, 0.8192, "Baylake Pines"),
  tile("dq9dyp", 1.6833, 0.8227, "Hampton"),
  tile("dq99u8", 1.6562, 0.8212, "Huntersville"),
  tile("dq9cgx", 1.6547, 0.8842, "Chesapeake Beach"),
  tile("dq99ub", 1.6432, 0.7338, "Wynnewood"),
  tile("dq99u3", 1.6335, 0.7496, "Huntersville"),
  tile("dq99sz", 1.629, 0.8069, "Wynnewood"),
  tile("dq9dyr", 1.6146, 0.7842, "Hampton"),
  tile("dq99th", 1.4102, 0.7773, "Dunedin"),
  tile("dq9cfy", 1.4052, 0.8338, "Lake Shores"),
  tile("dq9944", 0.8957, 0.3254, "Pierce Park"),
  tile("dq99h8", 0.8973, 0.3638, "Chesapeake"),
];

/** The numbered areas (1-5): Chesapeake Beach and the second Huntersville sit too close to a higher area. */
const NUMBERED = ["dq9cgz", "dq9dyp", "dq99u8", "dq99ub", "dq9cfy"].map((g) => TILES.find((t) => t.geohash === g)!);

const AREA: AreaDiscoveryInput = { tiles: TILES, numbered: NUMBERED, baseline: "house", liftTrusted: true, minLift: 1.3, billFloor: 0.7, ledgerRefs: ["Q10", "Q11", "Q10"] };

function partner(name: string, category: string, score: number, qlooRank: number, houseRank: number | null | undefined, tileGeohash: string | null = "dq9cgz"): Partner {
  const p: Partner = {
    entity: place(name, { id: `E-${name}`, category }),
    tileGeohash,
    category,
    score,
    qlooRank,
    chips: [{ label: "over-indexes for this bill", ledgerRef: "Q17" }],
  };
  if (houseRank !== undefined) p.houseRank = houseRank;
  return p;
}

describe("rankAreas", () => {
  it("ranks every square by lift and by this crowd's heat", () => {
    const r = rankAreas([...TILES].reverse());
    expect(r.map((x) => x.tile.geohash).slice(0, 3)).toEqual(["dq9cgz", "dq9dyp", "dq99u8"]);
    const wynnewood = r.find((x) => x.tile.geohash === "dq99ub");
    expect(wynnewood).toMatchObject({ liftRank: 5, heatRank: 10 });
    expect(r.find((x) => x.tile.geohash === "dq9cgx")).toMatchObject({ liftRank: 4, heatRank: 1 });
  });
});

describe("area rule", () => {
  it("picks the highest-lift numbered area that is at least 5 places lower on fans alone, by its number", () => {
    const d = areaDiscovery(AREA);
    expect(d).toEqual({
      kind: "area",
      headline: "Area 4, Wynnewood, is 10th of the 12 squares on the map for this crowd on its own, but 5th once it's compared with the room's usual crowd.",
      detail: "Looking at this crowd alone, you'd skip it. Next to the room's usual crowd, it stands out.",
      rule: AREA_RULE,
      why: "the highest-lift numbered area that this crowd on its own ranks 5 places lower",
      geohash: "dq99ub",
      ledgerRefs: ["Q10", "Q11"],
    });
    expect(DISCOVERY_RULES.minRankGap).toBe(5);
  });
  it("needs a gap of 5, a top area and a map that passed its checks against the room itself", () => {
    const close = TILES.map((t) => (t.geohash === "dq99ub" ? { ...t, billPct: 0.79 } : t));
    expect(areaDiscovery({ ...AREA, tiles: close })).toBeNull();
    const belowFloor = TILES.map((t) => (t.geohash === "dq99ub" ? { ...t, billPct: 0.69 } : t));
    expect(areaDiscovery({ ...AREA, tiles: belowFloor })?.geohash).not.toBe("dq99ub");
    expect(areaDiscovery({ ...AREA, liftTrusted: false })).toBeNull();
    expect(areaDiscovery({ ...AREA, baseline: "tag" })).toBeNull();
    expect(areaDiscovery({ ...AREA, tiles: [] })).toBeNull();
  });
  it("never picks an area that has no number on the map", () => {
    expect(areaDiscovery({ ...AREA, numbered: NUMBERED.filter((t) => t.geohash !== "dq99ub") })).toBeNull();
    expect(areaDiscovery({ ...AREA, numbered: [] })).toBeNull();
  });
  it("names an unnamed area by its map number", () => {
    const numbered = NUMBERED.map((t) => (t.geohash === "dq99ub" ? { ...t, name: undefined } : t)) as LiftTile[];
    expect(areaDiscovery({ ...AREA, numbered })?.headline).toMatch(/^Area 4 is 10th/);
  });
});

describe("partner rule", () => {
  const list = [
    partner("Teal Lounge", "bar", 0.76, 2, 16),
    partner("Opal Tavern", "bar", 0.7, 1, 6),
    partner("Alder Vinyl", "record_store", 0.6, 1, 2),
    partner("Copper Vinyl", "record_store", 0.59, 2, 3),
    partner("Near Cafe", "cafe", 0.9, 1, null, null),
    partner("Quarter Books", "book_store", 0.58, 6, 1),
    partner("The Hollow Grill", "restaurant", 0.57, 13, 26),
    partner("Rowan Eatery", "restaurant", 0.5, 15, 28),
  ];
  it("finds the most common types, ties included", () => {
    expect(mostCommonCategories(list)).toEqual(["bar", "record_store", "restaurant"]);
    expect(mostCommonCategories(list.slice(0, 5))).toEqual(["bar", "record_store"]);
    expect(mostCommonCategories([])).toEqual([]);
  });
  it("takes the top-scoring place outside the common types that the usual crowd ranks 5 or more lower", () => {
    const short = list.slice(0, 7); // restaurants no longer tie with bars and record stores
    const d = partnerDiscovery({ partners: short, baseline: "house" });
    // Near Cafe is near the venue, Quarter Books ranks higher for the house: The Hollow Grill wins.
    expect(d).toMatchObject({ kind: "partner", entityId: "E-The Hollow Grill", rule: PARTNER_RULE, ledgerRefs: ["Q17"] });
    expect(d?.headline).toBe("The Hollow Grill ranks 13th for this crowd and 26th for the room's usual crowd.");
    expect(d?.detail).toBe("Bars and record stores are the most common types on the list (2 of 7 each); this one is a restaurant.");
    expect(d?.why).toBe("the best fit that isn't a bar or record store, and the room's usual crowd ranks it 13 places lower");
  });
  it("words a place the usual crowd's list leaves out, with area, distance and the ask", () => {
    const p = partner("Slate Cafe", "cafe", 0.75, 2, null);
    p.explain = { tags: [], areaName: "Carriage House", distanceKm: 4.04, activation: "Ask to leave table cards.", confidence: "medium", confidenceWhy: "x", ledgerRefs: ["Q30", "Q31"] };
    const d = partnerDiscovery({ partners: [partner("Bar A", "bar", 0.9, 1, 2), partner("Bar B", "bar", 0.8, 2, 3), p], baseline: "house", twinSize: () => 28 });
    expect(d?.headline).toBe("Slate Cafe ranks 2nd for this crowd and isn't in the room's usual crowd's top 28.");
    expect(d?.detail).toBe("Bars are the most common type on the list (2 of 3); this one is a cafe in Carriage House, 4.0 km from the venue. Ask to leave table cards.");
    expect(d?.ledgerRefs).toEqual(["Q30", "Q31"]);
    expect(d?.why).toBe("the best fit that isn't a bar, and the room's usual crowd doesn't rank it at all");
    expect(partnerDiscovery({ partners: [partner("Bar A", "bar", 0.9, 1, 2), partner("Bar B", "bar", 0.8, 2, 3), p], baseline: "house" })?.headline).toBe(
      "Slate Cafe ranks 2nd for this crowd and doesn't come up for the room's usual crowd.",
    );
  });
  it("never picks a national chain", () => {
    const chain = { ...partner("Mall Outfitters", "clothing_store", 0.8, 3, 30), chain: true };
    const d = partnerDiscovery({ partners: [partner("Bar A", "bar", 0.9, 1, 2), partner("Bar B", "bar", 0.85, 2, 3), chain, partner("Slate Cafe", "cafe", 0.7, 4, 12)], baseline: "house" });
    expect(d?.entityId).toBe("E-Slate Cafe");
    expect(partnerDiscovery({ partners: [partner("Bar A", "bar", 0.9, 1, 2), partner("Bar B", "bar", 0.85, 2, 3), chain], baseline: "house" })).toBeNull();
  });
  it("finds nothing without the room's own crowd, a house rank, a gap, or a less common type", () => {
    expect(partnerDiscovery({ partners: list.slice(0, 7), baseline: "tag" })).toBeNull();
    expect(partnerDiscovery({ partners: [partner("A", "bar", 0.9, 1, 2), partner("B", "cafe", 0.8, 3, undefined), partner("C", "bar", 0.7, 2, 3)], baseline: "house" })).toBeNull();
    expect(partnerDiscovery({ partners: [partner("A", "bar", 0.9, 1, 2), partner("B", "cafe", 0.8, 3, 7), partner("C", "bar", 0.7, 2, 3)], baseline: "house" })).toBeNull();
    expect(partnerDiscovery({ partners: [partner("A", "bar", 0.9, 1, null), partner("B", "cafe", 0.8, 3, null)], baseline: "house" })).toBeNull();
    expect(partnerDiscovery({ partners: [], baseline: "house" })).toBeNull();
  });
});

describe("pickDiscovery", () => {
  const partners = [partner("Bar A", "bar", 0.9, 1, 2), partner("Bar B", "bar", 0.8, 2, 3), partner("Slate Cafe", "cafe", 0.75, 2, null)];
  it("prefers the area rule, then the partner rule, else nothing", () => {
    expect(pickDiscovery({ ...AREA, partners })?.kind).toBe("area");
    expect(pickDiscovery({ ...AREA, liftTrusted: false, partners })?.kind).toBe("partner");
    expect(pickDiscovery({ ...AREA, baseline: "tag", partners })).toBeNull();
  });
  it("is deterministic", () => {
    expect(pickDiscovery({ ...AREA, partners })).toEqual(pickDiscovery({ ...AREA, partners: [...partners] }));
  });
});
