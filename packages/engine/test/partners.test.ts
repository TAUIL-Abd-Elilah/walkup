import { describe, expect, it } from "vitest";
import type { LiftTile, QlooEntity } from "@walkup/contracts";
import { scorePartners, scorePartnersWithReport, ubiquityPenalty, UBIQUITY, type PartnerPool, type PoolHouseTwin } from "../src/partners";
import { isClosedEntity, resolveCategory } from "../src/category";
import { place, tag } from "./helpers";

function tile(geohash: string, lift: number, name?: string): LiftTile {
  const t: LiftTile = { geohash, lat: 36.16, lon: -86.78, lift, billPct: 0.9, housePct: 0.5, popularityPct: 0.8 };
  if (name) t.name = name;
  return t;
}

function pool(tileGeohash: string | null, entities: QlooEntity[], ledgerRef = "Q9"): PartnerPool {
  return { tileGeohash, ledgerRef, entities };
}

const CATS = ["bar", "record_store", "cafe", "barber_shop", "restaurant", "book_store", "clothing_store", "beauty_salon"];

/** n places cycling through categories, rank order = array order. */
function places(prefix: string, n: number, cats: string[] = CATS, extra: Partial<Parameters<typeof place>[1]> = {}): QlooEntity[] {
  return Array.from({ length: n }, (_, i) => place(`${prefix}${i}`, { id: `${prefix}-${String(i).padStart(2, "0")}`, category: cats[i % cats.length] as string, ...extra }));
}

describe("category helpers", () => {
  it("resolves categories via resolver, place-type tags, pinned map, then tag id", () => {
    const e = place("x", { tags: [tag("urn:tag:category:place:Record_Store"), tag("urn:tag:genre:place:x")] });
    expect(resolveCategory(e)).toBe("record_store");
    // A known place-type tag wins over the pinned map; the map decides for tags the reading doesn't know.
    expect(resolveCategory(e, { categoryTags: { vinyl: ["urn:tag:genre:place:x"] } })).toBe("record_store");
    const unknown = place("u", { tags: [tag("urn:tag:category:place:listening_room"), tag("urn:tag:genre:place:x")] });
    expect(resolveCategory(unknown, { categoryTags: { vinyl: ["urn:tag:genre:place:x"] } })).toBe("vinyl");
    expect(resolveCategory(unknown)).toBe("listening_room");
    expect(resolveCategory(e, { categoryOf: () => "custom" })).toBe("custom");
    expect(resolveCategory(e, { categoryOf: () => "  " })).toBe("record_store");
    expect(resolveCategory(place("y", { tags: [] }))).toBe("other");
  });
  it("closed flag accepts boolean and string forms", () => {
    expect(isClosedEntity(place("a", { isClosed: true }))).toBe(true);
    expect(isClosedEntity(place("b", { properties: { is_closed: "true" } }))).toBe(true);
    expect(isClosedEntity(place("c", { isClosed: false }))).toBe(false);
    expect(isClosedEntity(place("d"))).toBe(false);
  });
});

describe("scorePartners: scoring", () => {
  it("rank_score x tile_weight", () => {
    const tiles = [tile("aaaaaa", 2), tile("bbbbbb", 1)];
    const pa = places("A", 4);
    const pb = places("B", 4);
    const res = scorePartners([pool("aaaaaa", pa), pool("bbbbbb", pb)], tiles, { order: "score", minTotal: 0 });
    const s = new Map(res.map((p) => [p.entity.entityId, p.score]));
    expect(s.get("A-00")).toBeCloseTo(1);
    expect(s.get("A-01")).toBeCloseTo(0.75);
    expect(s.get("A-03")).toBeCloseTo(0.25);
    expect(s.get("B-00")).toBeCloseTo(0.5);
    expect(s.get("B-01")).toBeCloseTo(0.375);
    expect(res.find((p) => p.entity.entityId === "A-01")!.qlooRank).toBe(2);
    for (let i = 1; i < res.length; i++) expect(res[i - 1]!.score).toBeGreaterThanOrEqual(res[i]!.score);
  });
  it("pools without a known tile use lift 1", () => {
    const res = scorePartners([pool(null, places("N", 2)), pool("zzzzzz", places("Z", 2))], [tile("aaaaaa", 4)], { minTotal: 0 });
    expect(res.find((p) => p.entity.entityId === "N-00")!.score).toBeCloseTo(0.25);
    expect(res.find((p) => p.entity.entityId === "Z-00")!.score).toBeCloseTo(0.25);
    const venueOnly = scorePartners([pool(null, places("V", 2))], [], { minTotal: 0 });
    expect(venueOnly[0]!.score).toBe(1);
    expect(venueOnly[0]!.tileGeohash).toBeNull();
  });
  it("fills contact fields, tile name, chips and hours text", () => {
    const e = place("Spot", {
      id: "S-1",
      category: "record_store",
      hours: { Thursday: [{ opens: "T10:00", closes: "T20:00" }] },
      properties: { address: "1 Main St", phone: "+1 555 0101", website: "https://spot.test" },
    });
    const [p] = scorePartners([pool("aaaaaa", [e], "Q12")], [tile("aaaaaa", 1.5, "East Side")], {
      weekday: "thursday",
      minTotal: 0,
      extraChips: (_e, ctx) => [{ label: `rank ${ctx.qlooRank}`, ledgerRef: "Q13" }],
    });
    expect(p!.tileName).toBe("East Side");
    expect(p!.address).toBe("1 Main St");
    expect(p!.phone).toBe("+1 555 0101");
    expect(p!.website).toBe("https://spot.test");
    expect(p!.hoursOnDay).toBe("10:00-20:00");
    expect(p!.chips).toEqual([
      { label: "over-indexes for this bill", ledgerRef: "Q12" },
      { label: "rank 1", ledgerRef: "Q13" },
    ]);
    const [noDay] = scorePartners([pool("aaaaaa", [e])], [], { minTotal: 0 });
    expect(noDay!.hoursOnDay).toBeUndefined();
  });
});

describe("scorePartners: eligibility", () => {
  it("drops closed, excluded (venue), id-less and hours-closed places; keeps unknown hours", () => {
    const entities = [
      place("closed", { id: "C", category: "bar", isClosed: true }),
      place("venue", { id: "VENUE", category: "bar" }),
      { ...place("noid", { category: "bar" }), entityId: "" },
      place("shut-thu", { id: "H", category: "cafe", hours: { Thursday: "Closed", Friday: "9-5" } }),
      place("unknown-hours", { id: "U", category: "cafe", hours: "call us" }),
      place("ok", { id: "OK", category: "record_store", hours: ["Thursday: 9 AM-9 PM"] }),
    ];
    const { partners, report } = scorePartnersWithReport([pool("aaaaaa", entities)], [tile("aaaaaa", 2)], {
      weekday: "thursday",
      excludeEntityIds: ["VENUE"],
    });
    expect(partners.map((p) => p.entity.entityId).sort()).toEqual(["OK", "U"]);
    expect(report.droppedClosed).toBe(1);
    expect(report.droppedExcluded).toBe(1);
    expect(report.droppedInvalid).toBe(1);
    expect(report.droppedHoursClosed).toBe(1);
    expect(report.hoursUnknown).toBe(1);
    expect(report.candidates).toBe(6);
    expect(report.belowMinimum).toBe(true);
    expect(partners.find((p) => p.entity.entityId === "U")!.hoursOnDay).toBeNull();
  });
  it("an entity in two pools is picked once, in its best-scoring tile", () => {
    const shared = place("Shared", { id: "SH", category: "cafe" });
    const res = scorePartnersWithReport(
      [pool("aaaaaa", [place("x", { id: "X", category: "bar" }), shared]), pool("bbbbbb", [shared])],
      [tile("aaaaaa", 3), tile("bbbbbb", 1.5)],
      { minTotal: 0 },
    );
    const picks = res.partners.filter((p) => p.entity.entityId === "SH");
    expect(picks).toHaveLength(1);
    // tile a: rank 2 of 2 -> 0.5 * 1; tile b: rank 1 of 1 -> 1 * 0.5. Equal score; distance ties; lower Qloo rank wins.
    expect(picks[0]!.tileGeohash).toBe("bbbbbb");
    expect(res.report.duplicates).toBe(1);
  });
});

describe("scorePartners: diversity constraints", () => {
  it("at most 2 per category per tile", () => {
    const bars = places("B", 6, ["bar"]);
    const res = scorePartners([pool("aaaaaa", [...bars, ...places("R", 3, ["record_store"])])], [tile("aaaaaa", 2)], { minTotal: 0 });
    const counts = new Map<string, number>();
    for (const p of res) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    expect(counts.get("bar")).toBe(2);
    expect(counts.get("record_store")).toBe(2);
  });
  it("at most 8 per tile and 25 overall; 15-25 window", () => {
    const tiles = [tile("t1aaaa", 3), tile("t2aaaa", 2.5), tile("t3aaaa", 2), tile("t4aaaa", 1.5)];
    const pools = tiles.map((t, i) => pool(t.geohash, places(`T${i}`, 40)));
    const { partners, report } = scorePartnersWithReport(pools, tiles);
    expect(partners).toHaveLength(25);
    for (const t of tiles) expect(partners.filter((p) => p.tileGeohash === t.geohash).length).toBeLessThanOrEqual(8);
    expect(report.belowMinimum).toBe(false);
    expect(report.selected).toBe(25);
    expect(Object.values(report.perTile).reduce((a, b) => a + b, 0)).toBe(25);
    const custom = scorePartners(pools, tiles, { maxTotal: 10, maxPerTile: 3 });
    expect(custom).toHaveLength(10);
  });
  it("adds a non-bar when a tile would otherwise be all bars", () => {
    const barCats = ["bar", "pub", "sports_bar", "wine_bar"];
    const bars = places("B", 8, barCats); // 4 bar categories x 2 = 8 bars fill the tile
    const cafe = place("Cafe", { id: "CAFE", category: "cafe" });
    const { partners, report } = scorePartnersWithReport([pool("aaaaaa", [...bars, cafe])], [tile("aaaaaa", 2)], { minTotal: 0 });
    expect(partners).toHaveLength(8);
    expect(partners.some((p) => p.entity.entityId === "CAFE")).toBe(true);
    expect(report.nonBarSwaps).toBe(1);
    expect(partners.some((p) => p.entity.entityId === "B-07")).toBe(false); // lowest-scored bar swapped out
  });
  it("swaps when the total is full; a non-bar that fits is picked in the main pass", () => {
    const bars = places("B", 4, ["bar", "pub"]);
    const cafe = place("Cafe", { id: "CAFE", category: "cafe" });
    const { partners, report } = scorePartnersWithReport([pool("aaaaaa", [...bars, cafe])], [tile("aaaaaa", 2)], {
      minTotal: 0,
      maxTotal: 4,
    });
    expect(partners.map((p) => p.entity.entityId)).toContain("CAFE");
    expect(partners).toHaveLength(4);
    expect(report.nonBarSwaps).toBe(1);
    const roomy = scorePartnersWithReport([pool("aaaaaa", [...bars, cafe])], [tile("aaaaaa", 2)], { minTotal: 0 });
    expect(roomy.partners).toHaveLength(5);
    expect(roomy.report.nonBarAdded).toBe(0); // cafe was picked in the main pass
  });
  it("custom bar categories and categoryTags", () => {
    const e1 = place("one", { id: "1", tags: [tag("urn:tag:x:speakeasy")] });
    const e2 = place("two", { id: "2", tags: [tag("urn:tag:x:speakeasy")] });
    const e3 = place("three", { id: "3", tags: [tag("urn:tag:x:speakeasy")] });
    const e4 = place("four", { id: "4", tags: [tag("urn:tag:x:vinyl")] });
    const res = scorePartners([pool("aaaaaa", [e1, e2, e3, e4])], [tile("aaaaaa", 2)], {
      minTotal: 0,
      maxPerTile: 2,
      categoryTags: { speakeasy: ["urn:tag:x:speakeasy"], record_store: ["urn:tag:x:vinyl"] },
      barCategories: ["speakeasy"],
    });
    expect(res.map((p) => p.entity.entityId)).toEqual(["1", "4"]);
  });
  it("no non-bar available: tile stays all bars", () => {
    const res = scorePartners([pool("aaaaaa", places("B", 3, ["bar"]))], [tile("aaaaaa", 2)], { minTotal: 0 });
    expect(res.every((p) => p.category === "bar")).toBe(true);
  });
});

describe("scorePartners: ordering and determinism", () => {
  it("ties broken by distance, then Qloo rank, then id", () => {
    const near = place("near", { id: "N", category: "cafe", distanceM: 100 });
    const far = place("far", { id: "F", category: "record_store", distanceM: 900 });
    const res = scorePartners([pool("aaaaaa", [far]), pool("bbbbbb", [near])], [tile("aaaaaa", 2), tile("bbbbbb", 2)], {
      order: "score",
      minTotal: 0,
    });
    expect(res.map((p) => p.entity.entityId)).toEqual(["N", "F"]);
    const noDist = place("nd", { id: "ND", category: "book_store", distanceM: null });
    const res2 = scorePartners([pool("aaaaaa", [noDist]), pool("bbbbbb", [far])], [tile("aaaaaa", 2), tile("bbbbbb", 2)], {
      order: "score",
      minTotal: 0,
    });
    expect(res2.map((p) => p.entity.entityId)).toEqual(["F", "ND"]);
  });
  it("tile order groups by tile lift order", () => {
    const tiles = [tile("hiaaaa", 3), tile("loaaaa", 1.4)];
    const res = scorePartners([pool("loaaaa", places("L", 3)), pool("hiaaaa", places("H", 3)), pool(null, places("V", 2))], tiles, {
      minTotal: 0,
    });
    const order = res.map((p) => p.tileGeohash);
    expect(order).toEqual(["hiaaaa", "hiaaaa", "hiaaaa", "loaaaa", "loaaaa", "loaaaa", null, null]);
  });
  it("same input, same output; pool order does not change the selection", () => {
    const tiles = [tile("t1aaaa", 3), tile("t2aaaa", 2)];
    const p1 = pool("t1aaaa", places("A", 20));
    const p2 = pool("t2aaaa", places("B", 20));
    const a = scorePartners([p1, p2], tiles);
    const b = scorePartners([p2, p1], tiles);
    expect(a).toEqual(b);
    expect(scorePartners([p1, p2], tiles)).toEqual(a);
  });
  it("empty input", () => {
    const { partners, report } = scorePartnersWithReport([], []);
    expect(partners).toEqual([]);
    expect(report.belowMinimum).toBe(true);
    expect(scorePartners([pool("aaaaaa", [])], [tile("aaaaaa", 2)])).toEqual([]);
  });
});

/** A house twin whose list is `ids` in rank order. */
function twin(ids: string[], ledgerRef = "Q30", size = ids.length): PoolHouseTwin {
  return { ranks: new Map(ids.map((id, i) => [id, i + 1])), size, ledgerRef };
}

describe("ubiquity penalty", () => {
  it("is half the score for a place at least as high for the usual crowd, none for one half a list higher for the bill", () => {
    expect(UBIQUITY).toEqual({ maxPenalty: 0.5, span: 0.5 });
    expect(ubiquityPenalty(1, 50, 1, 50)).toBe(0.5);
    expect(ubiquityPenalty(10, 50, 3, 50)).toBe(0.5); // higher for the house than for the bill
    expect(ubiquityPenalty(1, 50, 30, 50)).toBe(0); // bill_pos 1, house_pos 0.42
    // bill_pos 1, house_pos 0.76: u = 1 - 0.24 / 0.5 = 0.52
    expect(ubiquityPenalty(1, 50, 13, 50)).toBeCloseTo(0.26, 10);
  });
  it("is zero when the place is not in the house list or no twin answered, and always inside [0, 0.5]", () => {
    expect(ubiquityPenalty(1, 50, null, 50)).toBe(0);
    expect(ubiquityPenalty(1, 50, 1, 0)).toBe(0);
    expect(ubiquityPenalty(1, 0, 1, 50)).toBe(0);
    for (let r = 1; r <= 40; r += 3) {
      for (let h = 1; h <= 40; h += 3) {
        const v = ubiquityPenalty(r, 40, h, 40);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(0.5);
        // Ranking lower for the house never raises the penalty.
        expect(ubiquityPenalty(r, 40, h + 1, 40)).toBeLessThanOrEqual(v + 1e-12);
      }
    }
    expect(ubiquityPenalty(1, 50, 1, 50, { maxPenalty: 0.3 })).toBe(0.3);
  });
  it("is applied to the score and recorded with the house rank on each partner", () => {
    const hub = place("Hub", { id: "HUB", category: "bar" });
    const own = place("Own", { id: "OWN", category: "record_store" });
    const mid = place("Mid", { id: "MID", category: "cafe" });
    const entities = [hub, own, mid];
    const withTwin: PartnerPool = { ...pool("aaaaaa", entities), house: twin(["HUB", "X1", "X2"], "Q30", 3) };
    const { partners, report } = scorePartnersWithReport([withTwin], [tile("aaaaaa", 2)], { minTotal: 0, order: "score" });
    const byId = new Map(partners.map((p) => [p.entity.entityId, p]));
    expect(byId.get("HUB")!.houseRank).toBe(1);
    expect(byId.get("HUB")!.ubiquityPenalty).toBe(0.5);
    expect(byId.get("HUB")!.score).toBeCloseTo((1 - 0 / 3) * 1 * 0.5, 10);
    expect(byId.get("OWN")!.houseRank).toBeNull();
    expect(byId.get("OWN")!.ubiquityPenalty).toBe(0);
    expect(byId.get("OWN")!.score).toBeCloseTo(1 - 1 / 3, 10);
    // The hub falls below the bill's own place.
    expect(partners.map((p) => p.entity.entityId)).toEqual(["OWN", "HUB", "MID"]);
    expect(report.penalized).toBe(1);
    // No twin: no penalty and no house fields.
    const plain = scorePartners([pool("aaaaaa", entities)], [tile("aaaaaa", 2)], { minTotal: 0, order: "score" });
    expect(plain.map((p) => p.entity.entityId)).toEqual(["HUB", "OWN", "MID"]);
    for (const p of plain) {
      expect(p.houseRank).toBeUndefined();
      expect(p.ubiquityPenalty).toBeUndefined();
    }
  });
  it("keeps the diversity caps", () => {
    const bars = places("B", 6, ["bar"]);
    const stores = places("R", 3, ["record_store"]);
    const all = [...bars, ...stores];
    const withTwin: PartnerPool = { ...pool("aaaaaa", all), house: twin(all.map((e) => e.entityId).reverse()) };
    const res = scorePartners([withTwin], [tile("aaaaaa", 2)], { minTotal: 0 });
    const counts = new Map<string, number>();
    for (const p of res) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    expect(counts.get("bar")).toBe(2);
    expect(counts.get("record_store")).toBe(2);
  });
});

describe("excluded categories", () => {
  it("drops places in an excluded category and counts them", () => {
    const entities = [...places("B", 4, ["bar", "pub"]), ...places("C", 3, ["cafe"])];
    const { partners, report } = scorePartnersWithReport([pool("aaaaaa", entities)], [tile("aaaaaa", 2)], {
      minTotal: 0,
      excludeCategories: ["bar", "pub"],
    });
    expect(partners.every((p) => p.category === "cafe")).toBe(true);
    expect(report.droppedCategory).toBe(4);
    expect(scorePartnersWithReport([pool("aaaaaa", entities)], [tile("aaaaaa", 2)], { minTotal: 0 }).report.droppedCategory).toBe(0);
  });
});
