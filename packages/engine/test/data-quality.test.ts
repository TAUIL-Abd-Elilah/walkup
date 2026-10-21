/**
 * Data-quality rules found on live sheets, each on synthetic places shaped like what Qloo returns: the display
 * category from the most specific place-type tags, non-venues, chain signals beyond the list and the chain cap,
 * adult-themed places, non-taste tags, and hours that are shown as open only when a clock time is listed.
 */
import { describe, expect, it } from "vitest";
import type { LiftTile, QlooEntity, QlooTag } from "@walkup/contracts";
import { categoryFromTags, isBarCategory, isNonVenue, resolveCategory } from "../src/category";
import { chainSignals, chainSummary, isAdultThemed, isSameBusiness, websiteHost, type ChainEntry } from "../src/chains";
import { explainPartner, explainTags } from "../src/explain";
import { clockHours, hoursOnDay } from "../src/hours";
import { scorePartnersWithReport, type PartnerPool } from "../src/partners";
import { buildPrePostSpots } from "../src/prepost";
import { dedupeTags, displayTagName, isTasteTag } from "../src/tasteTags";
import { place, tag } from "./helpers";

const cat = (...keys: string[]): QlooTag[] => keys.map((k) => tag(`urn:tag:category:place:${k}`, k));
const genre = (...keys: string[]): QlooTag[] => keys.map((k) => tag(`urn:tag:genre:place:${k}`, k));

function tile(geohash: string, lift: number): LiftTile {
  return { geohash, lat: 38.9, lon: -77.03, lift, billPct: 0.9, housePct: 0.5, popularityPct: 0.8 };
}

function pool(tileGeohash: string | null, entities: QlooEntity[]): PartnerPool {
  return { tileGeohash, ledgerRef: "Q9", entities };
}

describe("display category from the most specific place-type tags", () => {
  it("a bookstore with an in-store cafe is a bookstore, not a restaurant", () => {
    const e = place("Corner Books", { tags: [...genre("restaurant", "restaurant:cafe", "book_store"), ...cat("toy_store", "cafe", "childrens_book_store", "book_store")] });
    expect(categoryFromTags(e)).toBe("book_store");
    // Even when the pinned map lists the restaurant tag first.
    expect(resolveCategory(e, { categoryTags: { restaurant: ["urn:tag:genre:place:restaurant"], book_store: ["urn:tag:category:place:book_store"] } })).toBe("book_store");
  });

  it("a restaurant that also has a bar is a restaurant", () => {
    const pho = place("Pho Corner Annandale", { tags: [...cat("bar", "restaurant", "asian_fusion_restaurant", "pho_restaurant", "vietnamese_restaurant"), ...genre("restaurant:bar", "restaurant")] });
    expect(categoryFromTags(pho)).toBe("restaurant");
    const seafood = place("Harbor Crab House", { tags: cat("restaurant", "bar", "seafood_restaurant") });
    expect(categoryFromTags(seafood)).toBe("restaurant");
    // "Bar & Grill" with only a grill tag: a restaurant with a bar.
    expect(categoryFromTags(place("Eastside Bar & Grill", { tags: cat("bar_grill") }))).toBe("restaurant");
  });

  it("a lounge is a bar (and counts as one on an all-ages show)", () => {
    const lounge = place("Copper Room", { tags: [...cat("lounge_bar"), ...genre("restaurant:lounge_bar", "restaurant")] });
    expect(categoryFromTags(lounge)).toBe("lounge");
    expect(isBarCategory(resolveCategory(lounge))).toBe(true);
  });

  it("the name breaks a tie between bar subtypes and families, never invents one", () => {
    expect(categoryFromTags(place("Ninth Street Tavern", { tags: cat("bar_grill", "pub") }))).toBe("pub");
    expect(categoryFromTags(place("Velvet Lounge Bar & Grill", { tags: cat("pub", "lounge_bar", "hookah_bar", "american_restaurant", "bar_grill") }))).toBe("lounge");
    // "Kitchen" names a restaurant, but with only a bar tag the place stays a bar.
    expect(categoryFromTags(place("Night Kitchen", { tags: cat("bar") }))).toBe("bar");
    // A sports bar with wings on the menu.
    expect(categoryFromTags(place("Wing Stop Sports", { tags: cat("sports_bar", "chicken_wings_restaurant", "takeout_restaurant") }))).toBe("sports_bar");
  });

  it("cafes and bakeries", () => {
    expect(categoryFromTags(place("Hilltop Cafe", { tags: cat("coffee_shop", "cafeteria", "pastry_shop", "cafe", "sandwich_shop") }))).toBe("cafe");
    expect(categoryFromTags(place("Rosette Bakery & Bistro", { tags: cat("bistro", "wedding_bakery", "pastry_shop", "bakery") }))).toBe("bakery");
  });

  it("an unclear food-and-drink place reads as a bar; a dance-club tag next to a plain bar tag stays a bar", () => {
    expect(categoryFromTags(place("Harbor House", { tags: cat("restaurant", "bar", "event_venue") }))).toBe("bar");
    expect(categoryFromTags(place("Late Hearts Club", { tags: cat("bar", "club", "dance_club") }))).toBe("bar");
    expect(categoryFromTags(place("Velvet", { tags: cat("dance_club") }))).toBe("night_club");
  });

  it("amusements: a bowling alley with a bar and an arcade is a bowling alley; one arcade tag on a bar is a bar", () => {
    expect(categoryFromTags(place("Strike Lanes", { tags: cat("bowling_alley", "video_arcade", "sports_bar", "bar_grill", "restaurant") }))).toBe("bowling_alley");
    expect(categoryFromTags(place("Pixel Bar", { tags: cat("video_arcade", "bar") }))).toBe("bar");
  });

  it("each category the pins and the sample world use maps to itself", () => {
    for (const k of ["bar", "pub", "sports_bar", "restaurant", "cafe", "record_store", "book_store", "clothing_store", "barber_shop", "beauty_salon", "night_club", "bakery"]) {
      expect(resolveCategory(place("x", { category: k })), k).toBe(k);
    }
    // A key the reading doesn't know falls back to the pinned map, then the tag itself.
    expect(resolveCategory(place("x", { category: "soul_food" }), { categoryTags: { soul_food: ["urn:tag:category:place:soul_food"] } })).toBe("soul_food");
  });
});

describe("non-venues", () => {
  const plaza = place("Riverside Plaza", {
    tags: [...cat("mexican_restaurant", "food_court", "shopping_mall", "parking_garage", "fast_food_restaurant"), ...genre("shopping_mall", "restaurant")],
  });

  it("a mall, plaza, station or parking garage is never a venue, whatever restaurants it holds", () => {
    expect(isNonVenue(plaza)).toBe(true);
    expect(isNonVenue(place("Central Station", { tags: cat("train_station", "restaurant") }))).toBe(true);
  });

  it("a park or office building is a venue only when a business tag says so; a place-name with generic tags is not", () => {
    expect(isNonVenue(place("Riverfront", { tags: cat("park") }))).toBe(true);
    expect(isNonVenue(place("The Park", { tags: cat("park", "bar") }))).toBe(false);
    expect(isNonVenue(place("Union Station", { tags: cat("restaurant") }))).toBe(true);
    expect(isNonVenue(place("Station 4", { tags: cat("restaurant", "new_american_restaurant", "bar") }))).toBe(false);
    expect(isNonVenue(place("Corner Books", { tags: cat("book_store") }))).toBe(false);
  });

  it("partners and pre/post spots leave non-venues out and count them", () => {
    const local = place("Okafor's Kitchen", { id: "k", category: "restaurant" });
    const r = scorePartnersWithReport([pool("aaaaaa", [{ ...plaza, entityId: "plaza" }, local])], [tile("aaaaaa", 2)], { minTotal: 0 });
    expect(r.partners.map((p) => p.entity.entityId)).toEqual(["k"]);
    expect(r.report.droppedNotVenue).toBe(1);
    const pp = buildPrePostSpots([{ ...plaza, entityId: "plaza" }, local], { attendance: null, legalAgeEnforced: false, ledgerRef: "Q10" });
    expect(pp.spots.map((s) => s.entity.entityId)).toEqual(["k"]);
    expect(pp.report.droppedNotVenue).toBe(1);
  });
});

describe("national chains beyond the hand-kept list", () => {
  const LIST: ChainEntry[] = [{ name: "Wingtown" }, { name: "Peaks & Pints", adult: true }];

  it("spots a chain by Qloo's description, a store-locator website, or the same name or website at 3+ places", () => {
    const places = [
      place("Grill Republic", { id: "d", category: "restaurant", properties: { short_description: "Australian-themed steakhouse chain offering steaks." } }),
      place("Grill Lane", { id: "nc", category: "restaurant", properties: { short_description: "Family-run, non-chain grill on Main Street." } }),
      place("Daily Bread", { id: "w", category: "restaurant", properties: { website: "https://www.dailybread.com/en-us/cafe/locations/md/bowie/3931-town-center" } }),
      place("Bookhouse", { id: "w2", category: "book_store", properties: { website: "https://stores.bookhouse.com/store/2093" } }),
      ...["n1", "n2", "n3"].map((id, i) => place(i === 2 ? "Taco Spot #12" : "Taco Spot", { id, category: "restaurant" })),
      ...["h1", "h2", "h3"].map((id, i) => place(`Pho ${["Arlington", "Tysons", "Reston"][i]}`, { id, category: "restaurant", properties: { website: "https://phohouse.com/" } })),
      place("Wingtown Laurel", { id: "l", category: "sports_bar" }),
      place("Okafor's Kitchen", { id: "local", category: "restaurant", properties: { website: "https://okafors.com/menu" } }),
    ];
    const sig = chainSignals(places, LIST);
    expect(sig.get("d")?.reason).toBe("description");
    expect(sig.has("nc")).toBe(false);
    expect(sig.get("w")?.reason).toBe("website");
    expect(sig.get("w2")?.reason).toBe("website");
    expect(["n1", "n2", "n3"].map((id) => sig.get(id)?.reason)).toEqual(["locations", "locations", "locations"]);
    expect(["h1", "h2", "h3"].every((id) => sig.get(id)?.reason === "locations")).toBe(true);
    expect(sig.get("l")).toEqual({ brand: "Wingtown", reason: "list" });
    expect(sig.has("local")).toBe(false);
  });

  it("reads three same-name places with websites on different domains as unrelated local places", () => {
    const same = ["x1", "x2", "x3"].map((id) => place("Golden Wok", { id, category: "restaurant", properties: { website: `https://goldenwok-${id}.com/` } }));
    expect(chainSignals(same, null).size).toBe(0);
    const noSites = ["y1", "y2", "y3"].map((id) => place("Golden Wok", { id, category: "restaurant", properties: { website: null } }));
    expect(chainSignals(noSites, null).size).toBe(3);
  });

  it("never reads a shared booking platform or a test domain as one brand", () => {
    expect(websiteHost("https://order.toasttab.com/online/abc")).toBeNull();
    expect(websiteHost("https://example.test")).toBeNull();
    expect(websiteHost("https://grimsleys.example")).toBeNull();
    expect(websiteHost("www.Okafors.com/menu")).toBe("okafors.com");
    const onToast = ["a", "b", "c"].map((id) => place(`Spot ${id}`, { id, category: "cafe", properties: { website: `https://order.toasttab.com/online/${id}` } }));
    expect(chainSignals(onToast, null).size).toBe(0);
  });

  it("keeps at most 2 chains, only when local places run out, and says so in numbers that match the list", () => {
    // Tile a: 6 chains (3 kinds x 2) score above 2 locals; the caps leave room for all of them.
    const chains = ["restaurant", "cafe", "book_store"].flatMap((c, i) =>
      [0, 1].map((j) => place(`Chain ${c} ${j}`, { id: `c${i}${j}`, category: c, properties: { short_description: `A national ${c} chain.` } })),
    );
    const locals = [place("Okafor's Kitchen", { id: "l1", category: "restaurant" }), place("Mabry Coffee", { id: "l2", category: "cafe" })];
    const r = scorePartnersWithReport([pool("aaaaaa", [...chains, ...locals])], [tile("aaaaaa", 2)], { minTotal: 0, chains: [] });
    const kept = r.partners.filter((p) => p.chain);
    expect(kept).toHaveLength(2);
    expect(r.partners.slice(0, 2).map((p) => p.entity.entityId)).toEqual(["l1", "l2"]);
    expect(r.report).toMatchObject({ chains: 6, chainsKept: 2, chainsLeftOut: 4, maxChains: 2 });
    // l1 and l2 took a restaurant and a cafe slot, so one chain of each kind lost its slot to a local place; the two
    // book-store chains still had slots and lost them only to the cap.
    expect(r.report.chainsCapped).toBe(2);
    expect(r.report.chainsOffList).toHaveLength(4);
    const line = chainSummary({ kept: kept.length, listed: r.partners.length, leftOut: r.report.chainsLeftOut, capped: r.report.chainsCapped, cap: r.report.maxChains });
    expect(line).toBe("2 of 4 partners are national chains, listed last: no local place filled their slot. 4 more chains left off: 2 for local places, 2 by the limit of 2 per list.");
    expect(chainSummary({ kept: 0, listed: 9, leftOut: 2, capped: 0, cap: 2 })).toBe("2 national chains left off for local places.");
    expect(chainSummary({ kept: 2, listed: 9, leftOut: 1, capped: 1, cap: 2 })).toBe(
      "2 of 9 partners are national chains, listed last: no local place filled their slot. 1 more chain left off by the limit of 2 per list.",
    );
    expect(chainSummary({ kept: 0, listed: 9, leftOut: 0, capped: 0, cap: 2 })).toBeNull();
    // Pre/post: the same cap.
    const pp = buildPrePostSpots([...chains, ...locals], { attendance: null, legalAgeEnforced: true, ledgerRef: "Q10", chains: [] });
    expect(pp.spots.filter((s) => s.chain)).toHaveLength(2);
    expect(pp.report).toMatchObject({ chainsKept: 2, chainsLeftOut: 4, chainsCapped: 4, maxChains: 2 });
  });
});

describe("one business under two Qloo entries", () => {
  const at = (name: string, id: string, lat: number, lon: number) => ({ ...place(name, { id, category: "bakery" }), location: { lat, lon } });
  const a = at("Rosette Bakery", "r1", 38.8786, -77.0235);
  const b = at("Rosette Bakery & Bistro", "r2", 38.8787, -77.0236);
  const far = at("Rosette Bakery", "r3", 38.9494, -77.1192);
  const other = at("Okafor's Kitchen", "k", 38.8786, -77.0235);

  it("is the same name, or one name starting the other, within 150 m", () => {
    expect(isSameBusiness(a, b)).toBe(true);
    expect(isSameBusiness(a, far)).toBe(false);
    expect(isSameBusiness(a, other)).toBe(false);
  });

  it("is listed once on the partner and pre/post lists", () => {
    const r = scorePartnersWithReport([pool("aaaaaa", [a, b, far, other])], [tile("aaaaaa", 2)], { minTotal: 0, maxPerCategoryPerTile: 5 });
    expect(r.partners.map((p) => p.entity.entityId)).toEqual(["r1", "r3", "k"]);
    expect(r.report.duplicates).toBe(1);
    const pp = buildPrePostSpots([a, b, other], { attendance: null, legalAgeEnforced: false, ledgerRef: "Q10" });
    expect(pp.spots.map((s) => s.entity.entityId)).toEqual(["r1", "k"]);
  });
});

describe("adult-themed places", () => {
  const LIST: ChainEntry[] = [{ name: "Peaks & Pints", adult: true }];
  const byList = place("Peaks & Pints Laurel", { id: "a1", category: "sports_bar" });
  const byText = place("Wings & Things", { id: "a2", category: "sports_bar", properties: { short_description: "Sports bar known for wings and female servers in themed uniforms." } });
  const byTag = place("Velvet Club", { id: "a3", tags: cat("adult_entertainment_club", "bar") });
  const ok = place("Okafor's Kitchen", { id: "ok", category: "restaurant" });

  it("are spotted by the list's adult mark, Qloo's description or an adult-entertainment tag", () => {
    expect(isAdultThemed(byList, LIST)).toBe(true);
    expect(isAdultThemed(byList)).toBe(false);
    expect(isAdultThemed(byText)).toBe(true);
    expect(isAdultThemed(byTag)).toBe(true);
    expect(isAdultThemed(ok, LIST)).toBe(false);
  });

  it("are never a partner or a pre/post spot, on any show", () => {
    const r = scorePartnersWithReport([pool("aaaaaa", [byList, byText, byTag, ok])], [tile("aaaaaa", 2)], { minTotal: 0, chains: LIST });
    expect(r.partners.map((p) => p.entity.entityId)).toEqual(["ok"]);
    expect(r.report.droppedAdult).toBe(3);
    const pp = buildPrePostSpots([byList, byText, byTag, ok], { attendance: null, legalAgeEnforced: true, ledgerRef: "Q10", chains: LIST });
    expect(pp.spots.map((s) => s.entity.entityId)).toEqual(["ok"]);
    expect(pp.report.droppedAdult).toBe(3);
  });
});

describe("taste tags", () => {
  it("drops age bands, payment, endorsements, amenities, place types, geography, occupations and generic words", () => {
    const junk: QlooTag[] = [
      tag("urn:tag:age_range:qloo:35_44", "35 44"),
      tag("urn:tag:payments:place:credit_cards", "Credit cards"),
      tag("urn:tag:endorsement:qloo:american_express", "American Express"),
      tag("urn:tag:keyword:qloo:amex", "American Express"),
      tag("urn:tag:amenity:qloo:outdoor_patio", "Outdoor patio"),
      tag("urn:tag:service_type:qloo:dine_in", "Dine in"),
      tag("urn:tag:genre:place", "Place"),
      tag("urn:tag:genre:place:restaurant", "Restaurant"),
      tag("urn:tag:region:qloo:united_states", "United States"),
      tag("urn:tag:nationality:qloo:american", "American"),
      tag("urn:tag:language:qloo:english", "English"),
      tag("urn:tag:gender:qloo:male", "Male"),
      tag("urn:tag:occupation:qloo:musician", "Musician"),
      tag("urn:tag:instrument:music:guitar", "Guitar"),
      tag("urn:tag:ambience:qloo:casual", "Casual"),
      tag("urn:tag:ambience:qloo:clean", "Clean"),
      tag("urn:tag:ambience:place:large_group", "Large group"),
      tag("urn:tag:time_of_day_fit:qloo:evening", "Evening"),
      tag("urn:tag:dietary_option:qloo:halal", "Halal"),
    ];
    for (const t of junk) expect(isTasteTag(t), t.id).toBe(false);
    for (const t of [tag("urn:tag:genre:music:americana", "Americana"), tag("urn:tag:ambience:qloo:cozy", "Cozy"), tag("urn:tag:theme:qloo:heritage", "Heritage"), tag("urn:tag:instrument:qloo:banjo", "Banjo")]) {
      expect(isTasteTag(t), t.id).toBe(true);
    }
  });

  it("names tags the way a sheet should show them, and lists each once", () => {
    expect(displayTagName("VERSATILE")).toBe("Versatile");
    expect(displayTagName("DedicateD")).toBe("Dedicated");
    expect(displayTagName("vintage")).toBe("Vintage");
    expect(displayTagName("R&B")).toBe("R&B");
    expect(displayTagName("work-life balance")).toBe("Work-life balance");
    const d = dedupeTags([tag("urn:tag:artist:qloo:soulful", "Soulful"), tag("urn:tag:music:qloo:soulful", "Soulful"), tag("urn:tag:artist:qloo:soulful", "Soulful"), tag("urn:tag:theme:qloo:love", "Love")]);
    expect(d.map((t) => t.id)).toEqual(["urn:tag:artist:qloo:soulful", "urn:tag:theme:qloo:love"]);
  });

  it("'why this place' shows taste tags only, and puts a tag most of the list carries last", () => {
    const e = {
      tags: [
        tag("urn:tag:age_range:qloo:35_44", "35 44"),
        tag("urn:tag:genre:place", "Place"),
        tag("urn:tag:ambience:qloo:lively", "Lively"),
        tag("urn:tag:payments:place:nfc_mobile_payments", "Nfc mobile payments"),
        tag("urn:tag:menu_highlight:qloo:crab_bisque", "Crab bisque"),
        tag("urn:tag:decor:qloo:retro", "RETRO"),
      ],
    };
    const counts = new Map([["urn:tag:ambience:qloo:lively", 9]]);
    expect(explainTags(e, { adultsOnly: false, tagCounts: counts, listSize: 10 }).map((t) => t.name)).toEqual(["Crab bisque", "Retro", "Lively"]);
  });
});

describe("hours shown as open only with a clock time", () => {
  it("an open day with no times, or one end missing, reads as unknown", () => {
    expect(clockHours({ status: "open", text: "11:00-23:00" })).toBe("11:00-23:00");
    expect(clockHours({ status: "open", text: "Open 24 hours" })).toBe("Open 24 hours");
    expect(clockHours({ status: "open", text: null })).toBeNull();
    expect(clockHours({ status: "open", text: "Open" })).toBeNull();
    expect(clockHours({ status: "open", text: "17:00-?" })).toBeNull();
    expect(clockHours({ status: "closed", text: null })).toBeNull();
    expect(clockHours(hoursOnDay({ thursday: [{ opens: "T17:00:00", closes: null }] }, "thursday"))).toBeNull();
  });

  it("a partner with no clock time for the street-team day is listed with no hours and counted as unknown", () => {
    const vague = place("Okafor's Kitchen", { id: "v", category: "restaurant", hours: { Thursday: true, Friday: "9-5" } });
    const half = place("Mabry Coffee", { id: "h", category: "cafe", hours: { Thursday: [{ opens: "T07:00" }] } });
    const clear = place("Haskins Records", { id: "c", category: "record_store", hours: { Thursday: [{ opens: "T11:00", closes: "T19:00" }] } });
    const r = scorePartnersWithReport([pool("aaaaaa", [vague, half, clear])], [tile("aaaaaa", 2)], { minTotal: 0, weekday: "thursday" });
    const hours = Object.fromEntries(r.partners.map((p) => [p.entity.entityId, p.hoursOnDay]));
    expect(hours).toEqual({ v: null, h: null, c: "11:00-19:00" });
    expect(r.report.hoursUnknown).toBe(2);
  });

  it("'why this place' names the other street-team days the place is closed, and says 'call first' without hours", () => {
    const e = place("Haskins Records", { id: "c", category: "record_store", hours: { Thursday: [{ opens: "T11:00", closes: "T19:00" }], Saturday: "Closed", Friday: "11-7" } });
    const ex = explainPartner(
      { partner: { entity: e, category: "record_store", qlooRank: 1, tileGeohash: "aaaaaa", hoursOnDay: "11:00-19:00" }, poolSize: 20, poolRef: "Q9" },
      { venue: { lat: 38.9, lon: -77.03 }, day: "thursday", days: ["thursday", "saturday"], adultsOnly: false, thinSignal: false },
    );
    expect(ex.limits).toBe("Suggested, not affiliated: no partner has agreed to anything. Closed Saturday: visit on Thursday.");
    const none = explainPartner(
      { partner: { entity: { ...e, properties: {} }, category: "record_store", qlooRank: 1, tileGeohash: "aaaaaa", hoursOnDay: null }, poolSize: 20, poolRef: "Q9" },
      { venue: { lat: 38.9, lon: -77.03 }, day: "thursday", days: ["thursday", "saturday"], adultsOnly: false, thinSignal: false },
    );
    expect(none.limits).toBe("Suggested, not affiliated: no partner has agreed to anything. No hours listed for Thursday: call first.");
  });
});
