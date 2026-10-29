/**
 * Rules from a promoter's read of a live sheet: drinking places by name on a "no bars" sheet, food carts, partner
 * websites, podcast recency, sponsor short names, plain-word usual-crowd chips, spots nearest the venue first, and
 * confidence that differs between places. Synthetic places only.
 */
import { describe, expect, it } from "vitest";
import {
  backCatalogueLabel,
  barsExcluded,
  brandDisplayName,
  buildPrePostSpots,
  cleanWebsite,
  explainPartner,
  hostMatchesName,
  isDrinkLed,
  isFoodStand,
  isNonVenue,
  isUsualCrowdChip,
  nameSaysDrinking,
  partnerConfidence,
  pickPodcasts,
  podcastRecency,
  scorePartnersWithReport,
  usualCrowdChipLabel,
  type ConfidenceInput,
  type PartnerPool,
} from "../src/index";
import { place, tag } from "./helpers";

describe("drinking places by name or bar-type tags", () => {
  it("reads the drinking words in a name, not food counters or barbecue", () => {
    for (const n of ["Live-K Karaoke Bar | The Wharf", "Town Tavern DC", "Amsterdam Lounge", "Copper Pub", "Old Mill Brewery", "Taproom 12", "Cantina Rosa", "Dusty Saloon", "Bombay Grill and Bar"]) {
      expect(nameSaysDrinking(n)).toBe(true);
    }
    for (const n of ["Salad Bar Co", "Sushi Bar Hana", "Juice Bar", "Joe's Bar-B-Q", "Barnes & Noble", "Barbara's Bakery", "Crowbar Coffee"]) {
      expect(nameSaysDrinking(n)).toBe(false);
    }
  });
  it("reads a shop that says what it sells after the drinking word as that shop", () => {
    for (const n of ["Laurel Tavern Donuts", "Pub Street Bakery", "Saloon Creamery"]) expect(nameSaysDrinking(n)).toBe(false);
    expect(nameSaysDrinking("Donut Tavern")).toBe(true);
  });
  it("never lists a supermarket as a partner or a spot", () => {
    expect(isNonVenue(place("Safeway", { tags: [tag("urn:tag:category:place:supermarket"), tag("urn:tag:category:place:bakery")] }))).toBe(true);
    expect(isNonVenue(place("Whole Foods Market", { tags: [tag("urn:tag:genre:place:supermarket"), tag("urn:tag:category:place:deli")] }))).toBe(true);
    expect(isNonVenue(place("La Espiga De Oro Bakery", { tags: [tag("urn:tag:category:place:bakery")] }))).toBe(false);
  });
  it("counts a specific bar-type place tag whatever the name, but not a bare bar tag", () => {
    expect(isDrinkLed(place("Harbor House", { tags: [tag("urn:tag:category:place:irish_pub"), tag("urn:tag:genre:place:restaurant")] }))).toBe(true);
    expect(isDrinkLed(place("Sky Deck", { tags: [tag("urn:tag:category:place:lounge_bar")] }))).toBe(true);
    expect(isDrinkLed(place("Pho Corner", { tags: [tag("urn:tag:category:place:bar"), tag("urn:tag:category:place:pho_restaurant")] }))).toBe(false);
    expect(isDrinkLed(place("Izakaya Mori", { tags: [tag("urn:tag:amenities:place:bar_onsite"), tag("urn:tag:category:place:japanese_restaurant")] }))).toBe(false);
  });
  it("counts a bar and grill, or a place Qloo tags as a dive bar, as drink-led whatever its name", () => {
    // "SWIG": a bar_grill whose description opens "Lively Wicker Park bar"; shown to fans on an all-ages sheet before.
    expect(isDrinkLed(place("SWIG", { tags: [tag("urn:tag:category:place:bar_grill"), tag("urn:tag:genre:place:restaurant")] }))).toBe(true);
    expect(isDrinkLed(place("Corner Spot", { tags: [tag("urn:tag:genre:place:restaurant"), tag("urn:tag:decor:qloo:dive_bar")] }))).toBe(true);
    // A bar culinary style alone is not enough: a pho house carries it.
    expect(isDrinkLed(place("Pho House", { tags: [tag("urn:tag:genre:place:restaurant"), tag("urn:tag:culinary_style:qloo:bar")] }))).toBe(false);
    expect(isDrinkLed(place("Corner Spot", { tags: [tag("urn:tag:genre:place:restaurant"), tag("urn:tag:ambience:qloo:cozy")] }))).toBe(false);
  });
  it("knows when the excluded types leave bars out", () => {
    expect(barsExcluded(["bar", "pub"])).toBe(true);
    expect(barsExcluded(["Night_Club"])).toBe(true);
    expect(barsExcluded(["clothing_store"])).toBe(false);
  });
  it("on a no-bars list, drops a drinking place filed as a restaurant; otherwise keeps it", () => {
    const pool: PartnerPool = {
      tileGeohash: "dqcjrm",
      ledgerRef: "Q15",
      entities: [
        place("Velvet Lounge", { id: "L", tags: [tag("urn:tag:category:place:american_restaurant")] }),
        place("Plain Diner", { id: "D", category: "diner" }),
        place("Corner Hot Dog Cart", { id: "C", category: "hot_dog_restaurant" }),
      ],
    };
    const tiles = [{ geohash: "dqcjrm", lat: 38.9, lon: -77, lift: 2, billPct: 0.9, housePct: 0.2, popularityPct: 0.5 }];
    const open = scorePartnersWithReport([pool], tiles, {});
    expect(open.partners.map((p) => p.entity.entityId)).toEqual(["L", "D"]);
    expect(open.report.droppedStand).toBe(1);
    const noBars = scorePartnersWithReport([pool], tiles, { excludeCategories: ["bar", "pub", "lounge"] });
    expect(noBars.partners.map((p) => p.entity.entityId)).toEqual(["D"]);
    expect(noBars.report.droppedCategory).toBe(1);
  });
  it("food carts, kiosks and stands", () => {
    expect(isFoodStand(place("Sami's Hot Dog Cart"))).toBe(true);
    expect(isFoodStand(place("Taco Kiosk"))).toBe(true);
    expect(isFoodStand(place("Toasty Cheese Food Trucks"))).toBe(true);
    expect(isFoodStand(place("Rolling Smoke", { tags: [tag("urn:tag:category:place:food_truck")] }))).toBe(true);
    expect(isFoodStand(place("Grandstand Grill"))).toBe(false);
    expect(isFoodStand(place("Cartwright's Kitchen"))).toBe(false);
  });
});

describe("partner websites", () => {
  it("keeps the place's own domain, with tracking removed", () => {
    expect(cleanWebsite("https://stabledc.example/", "Stable DC")).toBe("https://stabledc.example/");
    expect(cleanWebsite("http://salsitaliankitchen.example", "Sal's Italian Kitchen")).toBe("http://salsitaliankitchen.example");
    expect(cleanWebsite("https://stores.barnesandnoble.example/store/1", "Barnes & Noble")).toBe("https://stores.barnesandnoble.example/store/1");
    expect(cleanWebsite("https://www.bowlero.example/location/x?utm_source=google&utm_medium=organic", "Bowlero Bethesda")).toBe("https://www.bowlero.example/location/x");
    expect(cleanWebsite("https://www.wingsplace.example/locations/laurel%3Futm_medium%3Dorganic%26utm_source%3Dgoogle", "Wings Place")).toBe(
      "https://www.wingsplace.example/locations/laurel",
    );
  });
  it("drops a developer's or agency's server, a bare IP and non-web links", () => {
    expect(cleanWebsite("http://pixelagency.example/clients/redloungebar/", "Red Lounge Bar & Grill")).toBeNull();
    expect(cleanWebsite("http://10.0.0.1/menu", "Red Lounge")).toBeNull();
    expect(cleanWebsite("mailto:hi@redlounge.example", "Red Lounge")).toBeNull();
    expect(cleanWebsite("not a url at all", "Red Lounge")).toBeNull();
    expect(cleanWebsite("", "Red Lounge")).toBeNull();
  });
  it("keeps a social or listing page only when it points at a page", () => {
    expect(cleanWebsite("https://www.facebook.com/redloungedc", "Red Lounge")).toBe("https://www.facebook.com/redloungedc");
    expect(cleanWebsite("https://www.instagram.com/", "Red Lounge")).toBeNull();
    expect(cleanWebsite("https://www.yelp.com/biz/red-lounge-washington", "Red Lounge")).toBe("https://www.yelp.com/biz/red-lounge-washington");
  });
  it("matches hosts to names by their own words, not generic ones", () => {
    expect(hostMatchesName("dcpurelounge.example", "Pure Lounge")).toBe(true);
    expect(hostMatchesName("loungeworld.example", "Red Lounge Bar")).toBe(false);
  });
});

describe("podcasts and the sponsor", () => {
  const pod = (name: string, year?: number, extra: Record<string, unknown> = {}) => place(name, { subtype: "urn:entity:podcast", properties: { ...(year ? { release_year: year } : {}), ...extra } });
  it("reads recency from the latest year Qloo has, or an ended mark", () => {
    expect(podcastRecency(pod("A", 2025), 2026)).toEqual({ status: "recent", lastYear: 2025 });
    expect(podcastRecency(pod("B", 2024), 2026).status).toBe("recent");
    expect(podcastRecency(pod("C", 2019), 2026)).toEqual({ status: "old", lastYear: 2019 });
    expect(podcastRecency(pod("D", 2025, { status: "Ended" }), 2026).status).toBe("ended");
    expect(podcastRecency(pod("E"), 2026)).toEqual({ status: "unknown", lastYear: null });
  });
  it("leaves out old shows when enough recent ones came back, else keeps them as back catalogue", () => {
    const items = [pod("Old One", 2019), pod("New A", 2025), pod("Old Two", 2021), pod("New B", 2024), pod("New C", 2026)];
    const kept = pickPodcasts(items, (e) => e, 2026, 4);
    expect(kept.map((k) => k.item.name)).toEqual(["New A", "New B", "New C"]);
    const thin = pickPodcasts([pod("Old One", 2019), pod("New A", 2025), pod("Old Two", 2021)], (e) => e, 2026, 4);
    expect(thin.map((k) => [k.item.name, k.backCatalogue])).toEqual([
      ["Old One", true],
      ["New A", false],
    ]);
    expect(backCatalogueLabel(thin[0]!.recency)).toBe("back catalogue: latest episodes 2019");
  });
  it("shows a brand by its short name when Qloo's own data gives one", () => {
    const rei = place("Recreational Equipment Inc", { subtype: "urn:entity:brand", properties: { short_description: "REI is a retail co-op for outdoor gear." } });
    expect(brandDisplayName(rei)).toBe("REI");
    expect(brandDisplayName(place("Northwind Outfitters", { properties: { short_name: "Northwind" } }))).toBe("Northwind");
    expect(brandDisplayName(place("Taft", { properties: { short_description: "Taft is a law firm." } }))).toBe("Taft");
    expect(brandDisplayName(place("Blue Sky Gear", { properties: { short_description: "NASA tested gear." } }))).toBe("Blue Sky Gear");
  });
});

describe("the usual-crowd chip, in plain words", () => {
  it("never says house", () => {
    expect(usualCrowdChipLabel(5)).toBe("ranks 5 places higher here than for the room's usual crowd");
    expect(usualCrowdChipLabel(-1)).toBe("ranks 1 place lower here than for the room's usual crowd");
    expect(usualCrowdChipLabel(0)).toBe("ranks the same here as for the room's usual crowd");
    expect(usualCrowdChipLabel(null, 50)).toBe("not in the room's usual crowd's top 50");
    expect(usualCrowdChipLabel(null, 0)).toBe("no list for the room's usual crowd");
    for (const d of [5, -1, 0]) expect(usualCrowdChipLabel(d)).not.toMatch(/house/);
    expect(isUsualCrowdChip(usualCrowdChipLabel(null, 50))).toBe(true);
    expect(isUsualCrowdChip("tonight vs house +3 ranks")).toBe(true);
    expect(isUsualCrowdChip("over-indexes for this bill")).toBe(false);
  });
});

describe("before and after the show", () => {
  it("lists spots nearest the venue first and leaves out carts", () => {
    const entities = [
      place("Far Grill", { id: "F", category: "restaurant", distanceM: 900 }),
      place("Near Cafe", { id: "N", category: "cafe", distanceM: 120 }),
      place("Hot Dog Cart", { id: "C", category: "restaurant", distanceM: 50 }),
      place("Mid Diner", { id: "M", category: "diner", distanceM: 400 }),
    ];
    const { spots, report } = buildPrePostSpots(entities, { attendance: null, legalAgeEnforced: false, ledgerRef: "Q10" });
    expect(spots.map((s) => s.entity.entityId)).toEqual(["N", "M", "F"]);
    expect(report.droppedStand).toBe(1);
  });
  it("keeps one spot per chain brand", () => {
    const entities = [
      place("Starbucks Coffee Company", { id: "S1", category: "cafe", distanceM: 300 }),
      place("Starbucks Coffee Company", { id: "S2", category: "cafe", distanceM: 600, properties: { address: "2 Other St" } }),
      place("Local Diner", { id: "L", category: "diner", distanceM: 400 }),
    ];
    const { spots } = buildPrePostSpots(entities, { attendance: null, legalAgeEnforced: false, ledgerRef: "Q10", chains: [{ name: "Starbucks", aliases: ["Starbucks Coffee Company"], kind: "coffee" }] });
    expect(spots.map((s) => s.entity.entityId).filter((id) => id.startsWith("S"))).toHaveLength(1);
    expect(spots.some((s) => s.entity.entityId === "L")).toBe(true);
  });
});

describe("confidence differs between places on one list", () => {
  const base: ConfidenceInput = { qlooRank: 2, poolSize: 50, inTopArea: true, widenedRadiusM: null, widenedCategories: false, hoursKnown: true, day: "thursday", thinSignal: false };
  it("rises with evidence that the place belongs to this crowd and falls when the usual crowd ranks it higher", () => {
    expect(partnerConfidence({ ...base, houseRank: null, houseListSize: 50 })).toEqual({
      confidence: "high",
      why: "Rank 2 of 50 in a top area; not in the room's usual crowd's top 50, open Thursday.",
    });
    expect(partnerConfidence({ ...base, qlooRank: 12, houseRank: 30 }).confidence).toBe("high");
    expect(partnerConfidence({ ...base, qlooRank: 12, houseRank: 14 }).confidence).toBe("medium");
    const lower = partnerConfidence({ ...base, qlooRank: 12, houseRank: 8 });
    expect(lower.confidence).toBe("low");
    expect(lower.why).toBe("Rank 12 of 50 in a top area, but the room's usual crowd ranks it higher.");
    expect(partnerConfidence({ ...base, qlooRank: 12, billTagNames: ["Folk"] }).why).toBe("Rank 12 of 50 in a top area; it shares the bill's Folk tag, open Thursday.");
  });
  it("a thin signal caps a place at medium without marking every place down alike", () => {
    const strong = partnerConfidence({ ...base, houseRank: null, houseListSize: 50, thinSignal: true });
    expect(strong.confidence).toBe("medium");
    expect(strong.why).toMatch(/this bill's signal is thin\.$/);
    expect(partnerConfidence({ ...base, qlooRank: 12, houseRank: 8, thinSignal: true }).confidence).toBe("low");
  });
  it("explainPartner passes the usual-crowd rank and the bill's tags through", () => {
    const e = place("Slate Cafe", { id: "S", tags: [tag("urn:tag:genre:music:folk", "Folk"), tag("urn:tag:category:place:cafe", "Cafe")] });
    const x = explainPartner(
      { partner: { entity: e, category: "cafe", qlooRank: 9, tileGeohash: "dqcjrm", tileName: "U Street / Shaw", hoursOnDay: "08:00-18:00", houseRank: null }, poolSize: 50, poolRef: "Q15", twinRef: "Q16", houseListSize: 50 },
      { venue: { lat: 38.88, lon: -77.02 }, day: "thursday", adultsOnly: false, thinSignal: false, billTagIds: new Set(["urn:tag:genre:music:folk"]) },
    );
    expect(x.confidence).toBe("high");
    expect(x.confidenceWhy).toBe("Rank 9 of 50 in a top area; not in the room's usual crowd's top 50 and it shares the bill's Folk tag, open Thursday.");
  });
});
