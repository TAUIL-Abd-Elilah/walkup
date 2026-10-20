/**
 * G3 (synthetic): Super Funny Comedy Club, Tacoma, Fri Dec 4 2026 (invented bill).
 * The hardest room: club ticketing is not on Ticketmaster, so the house
 * baseline degrades to a comedy tag baseline, the heatmap widens to 60 km,
 * partners are fewer, the compare falls back to a tag diff and narration
 * falls back to the deterministic template. Acts and businesses are fictional.
 */
import type { Bill, OperatorInputs, Partner, QlooEntity, Resolution, StreetSheet } from "@walkup/contracts";
import type { SheetFixture } from "../../lib/fixture-types";
import {
  RunLedger,
  SHEET_LIMITS,
  WEEKDAY_SHORT,
  ACS_ENDPOINT,
  ACS_NOTE,
  acsCurl,
  acsParams,
  envelope,
  makeBudget,
  makeMedia,
  makePartners,
  makeSpots,
  makeTiles,
  rng,
  synId,
  tag,
  type PlaceContext,
  type Seed,
  type SpotSpec,
  type TilePartnerSpec,
  type TileSpec,
} from "./common";

const VENUE = {
  name: "Super Funny Comedy Club",
  // Approximate central-Tacoma point for the synthetic fixture.
  lat: 47.244,
  lon: -122.453,
  city: "Tacoma",
  state: "WA",
  country: "US",
  qlooEntityId: null,
};

const T = (name: string, lat: number, lon: number, lift: number, zctas: string[], adults: number): TileSpec => ({ name, lat, lon, lift, zctas, adults });

const TILES: TileSpec[] = [
  T("Sixth Avenue", 47.2555, -122.4705, 1.58, ["98406"], 5900),
  T("Proctor", 47.2695, -122.495, 1.41, ["98407"], 4800),
  T("Stadium District", 47.2665, -122.4505, 1.33, ["98403"], 3600),
  T("Hilltop", 47.252, -122.456, 1.24, ["98405"], 5100),
  T("University Place", 47.236, -122.55, 1.19, ["98466"], 7400),
  T("Gig Harbor", 47.3295, -122.58, 1.12, ["98335"], 6900),
  T("Lakewood", 47.172, -122.518, 1.06, ["98499"], 8100),
  T("Federal Way", 47.3225, -122.3125, 0.95, ["98003"], 9300),
  T("Downtown Tacoma", 47.253, -122.443, 0.92, ["98402"], 3900),
  T("Kent", 47.3809, -122.2348, 0.9, ["98032"], 8800),
  T("Puyallup", 47.1855, -122.293, 0.88, ["98371"], 7600),
  T("Olympia", 47.0379, -122.9007, 0.81, ["98501"], 9800),
];

const PARTNERS: TilePartnerSpec[][] = [
  [
    { name: "Pinball Parlor Taproom", category: "bar", street: "6th Ave", qlooRank: 1, extraTags: ["lateNight"] },
    { name: "Night Owl Noodle Co.", category: "restaurant", street: "6th Ave", qlooRank: 3 },
    { name: "Drizzle & Groove Records", category: "record_store", street: "N Pine St", qlooRank: 4 },
    { name: "Fern Hollow Coffee", category: "cafe", street: "6th Ave", qlooRank: 6 },
  ],
  [
    { name: "Spine & Static Books", category: "book_store", street: "N 26th St", qlooRank: 2 },
    { name: "Tideflat Tavern", category: "bar", street: "N Proctor St", qlooRank: 3 },
    { name: "Slow Ferry Cafe", category: "cafe", street: "N 27th St", qlooRank: 5 },
    { name: "Mossback Barber Co.", category: "barber_shop", street: "N Proctor St", qlooRank: 7 },
  ],
  [
    { name: "Stadium Steps Diner", category: "restaurant", street: "N Tacoma Ave", qlooRank: 1 },
    { name: "Bellwether Bar & Billiards", category: "bar", street: "N 1st St", qlooRank: 2 },
    { name: "Tin Kettle Teahouse", category: "cafe", street: "Division Ave", qlooRank: 4 },
  ],
];

const SPOTS: SpotSpec[] = [
  { name: "Spotlight Taqueria", category: "restaurant", street: "S 11th St", northM: 420, eastM: -260, deltaRank: null, share: 0.15, capacity: 60 },
  { name: "Green Room Grill", category: "restaurant", street: "Pacific Ave", northM: -380, eastM: 510, deltaRank: null, share: 0.18, capacity: 70 },
  { name: "Callback Coffee", category: "cafe", street: "S 9th St", northM: 960, eastM: 120, deltaRank: null, share: 0.1, capacity: 35 },
  { name: "Opening Act Pizza", category: "restaurant", street: "S Fawcett Ave", northM: -1450, eastM: -700, deltaRank: null, share: 0.14, capacity: 55 },
  { name: "Mic Drop Pub", category: "bar", street: "Commerce St", northM: 1800, eastM: 900, deltaRank: null, share: 0.12, capacity: 90 },
];

export function buildG3(): SheetFixture {
  const r = rng(4404);
  const createdAt = "2026-11-20T18:00:00.000Z";
  const L = new RunLedger(createdAt, r);
  const venuePoint = `POINT(${VENUE.lon} ${VENUE.lat})`;
  const planId = "g3";
  const streetDay = "wednesday" as const;
  const phoneCounter = { n: 0 };
  const ctx: PlaceContext = { city: "Tacoma", state: "WA", areaCode: "253", phoneCounter, weekdayShort: WEEKDAY_SHORT[streetDay] };

  const t1 = L.add("tm", "GET", "/discovery/v2/events.json", { keyword: "Super Funny Comedy Club", city: "Tacoma", startDateTime: "2026-12-04T00:00:00Z", apikey: "$TICKETMASTER_API_KEY" }, { resultCount: 0, envelope: "empty", note: "The club sells on its own platform: bill and date typed by the operator. Age policy unknown." });
  const t2 = L.add("tm", "GET", "/discovery/v2/venues.json", { keyword: "Super Funny Comedy Club", stateCode: "WA", apikey: "$TICKETMASTER_API_KEY" }, { resultCount: 0, envelope: "empty", note: "No Ticketmaster roster for the house baseline." });

  const headliner: QlooEntity = {
    entityId: synId("person", "Ada Pell"),
    name: "Ada Pell",
    subtype: "urn:entity:person",
    popularity: 0.41,
    affinity: null,
    tags: [],
    properties: { short_description: "Fictional comedian for the synthetic fixture.", occupation_check: "comedian tag present" },
  };
  const q1 = L.add("qloo", "GET", "/search", { query: "Ada Pell", types: ["urn:entity:artist", "urn:entity:person"], take: 5 }, { resultCount: 1, note: "Exact match; comedian tag check passed." });
  const q2 = L.add("qloo", "GET", "/search", { query: "Margo Vint", types: ["urn:entity:artist", "urn:entity:person"], take: 5 }, { resultCount: 2, envelope: "partial", note: "2 near matches, neither exact nor tagged comedian: not used." });
  const q3 = L.add("qloo", "GET", "/search", { query: VENUE.name, types: "urn:entity:place", "filter.location": `${VENUE.lat},${VENUE.lon}`, "filter.radius": 1 }, { resultCount: 0, envelope: "empty", note: `Venue not in catalog: using ${venuePoint}.` });

  const q4 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": headliner.entityId, "filter.location": venuePoint, "filter.location.radius": 40000 }, { resultCount: 140, envelope: "partial", bytes: 21_400, note: "Thin: 140 cells within 40 km (floor is 200). Retrying at 60 km." });
  const q5 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": headliner.entityId, "filter.location": venuePoint, "filter.location.radius": 60000 }, { resultCount: 236, bytes: 35_800 });
  const q6 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.tags": "urn:tag:genre:media:stand_up_comedy", "filter.location": venuePoint, "filter.location.radius": 60000 }, { resultCount: 1310, bytes: 196_000, envelope: "degraded", note: "House baseline degraded to a comedy tag baseline (no roster)." });
  const q7 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.tags": "urn:tag:category:place:restaurant", "filter.location": venuePoint, "filter.location.radius": 60000 }, { resultCount: 2950, bytes: 431_000, note: "Generic baseline: diagnostic only." });
  const tiles = makeTiles(TILES, r);
  const top = tiles.filter((t) => t.lift >= 1.3).slice(0, 5);
  const maxLift = top[0]?.lift ?? 1;

  const q8 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": headliner.entityId }, { resultCount: 1 });
  const q9 = L.add("qloo", "GET", "/v2/analysis/compare", { "a.signal.interests.entities": headliner.entityId, "b.signal.interests.tags": "urn:tag:genre:media:stand_up_comedy", take: 30 }, { resultCount: 4, envelope: "degraded", note: "Only generic shared tags came back; falling back to a tag diff." });
  const q10 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": headliner.entityId, "filter.tag.types": ["urn:tag:keyword:media", "urn:tag:genre:media"], take: 30 }, { resultCount: 30 });
  const q11 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:tag", "signal.interests.tags": "urn:tag:genre:media:stand_up_comedy", "filter.tag.types": ["urn:tag:keyword:media", "urn:tag:genre:media"], take: 30 }, { resultCount: 30, note: "Tag-diff baseline side." });

  const seeds: Seed[] = [{ entityId: headliner.entityId, weight: 1 }];
  const categories = ["bar", "restaurant", "cafe", "record_store", "book_store", "barber_shop"].map((c) => `urn:tag:category:place:${c}`);
  const poolParams = (tile: { lat: number; lon: number }, radius: number) => ({
    "filter.type": "urn:entity:place",
    "signal.interests.entities": headliner.entityId,
    "filter.location": `POINT(${tile.lon} ${tile.lat})`,
    "filter.location.radius": radius,
    "filter.tags": categories,
    "operator.filter.tags": "union",
    "filter.hours": streetDay,
    "filter.price_level.max": 3,
    "feature.explainability": true,
    take: 50,
  });
  const partners: Partner[] = [];
  const poolRefs: string[] = [];
  const results = [
    [6, 14],
    [9, null],
    [5, 10],
  ] as const;
  top.slice(0, 3).forEach((tile, i) => {
    const [first, widened] = results[i] ?? [0, null];
    let ref = L.add("qloo", "GET", "/v2/insights", poolParams(tile, 2000), { resultCount: first, envelope: first < 8 ? "partial" : "ok", note: first < 8 ? "Fewer than 8 results at 2,000 m: widening to 3,500 m." : `Partner pool for tile ${tile.name ?? tile.geohash}.` });
    poolRefs.push(ref);
    if (widened !== null) {
      ref = L.add("qloo", "GET", "/v2/insights", poolParams(tile, 3500), { resultCount: widened, note: `Partner pool for tile ${tile.name ?? tile.geohash} at 3,500 m.` });
      poolRefs.push(ref);
    }
    partners.push(...makePartners(tile, maxLift, PARTNERS[i] ?? [], ctx, r, { pool: ref, billHeat: q5 }, seeds));
  });
  partners.sort((a, b) => b.score - a.score);

  const preParams = (radius: number) => ({ "filter.type": "urn:entity:place", "signal.interests.entities": headliner.entityId, "filter.location": venuePoint, "filter.location.radius": radius, "filter.tags": ["urn:tag:category:place:restaurant", "urn:tag:category:place:bar", "urn:tag:category:place:cafe"], "operator.filter.tags": "union", "filter.hours": "friday", "feature.explainability": true, take: 30 });
  L.add("qloo", "GET", "/v2/insights", preParams(1500), { resultCount: 4, envelope: "partial", note: "Fewer than 6 spots at 1,500 m: widening to 2,500 m." });
  const qPre = L.add("qloo", "GET", "/v2/insights", preParams(2500), { resultCount: 9, note: "No house twin: the house baseline is a tag, so no delta rank." });
  const spots = makeSpots(VENUE, SPOTS, { ...ctx, weekdayShort: WEEKDAY_SHORT.friday }, r, { pool: qPre, twin: qPre }, seeds, null);

  const qPod = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:podcast", "signal.interests.entities": headliner.entityId, "signal.location": venuePoint, "feature.explainability": true, take: 15 }, { resultCount: 15, note: "signal.location probe pending: labelled national." });
  const qBrand = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": headliner.entityId, "signal.location": venuePoint, "filter.exclude.tags": ["urn:tag:category:brand:alcohol", "urn:tag:category:brand:tobacco", "urn:tag:category:brand:gambling"], "feature.explainability": true, take: 15 }, { resultCount: 0, envelope: "empty", note: "No sponsor brand returned: sponsor slot hidden." });
  const media = makeMedia(
    [
      { name: "Open Mic Notebook", kind: "podcast", publisher: "Fictional network" },
      { name: "The Road Comic Report", kind: "podcast", publisher: "Fictional network" },
      { name: "Pacific Northwest Punchlines", kind: "podcast", publisher: "Fictional network" },
    ],
    r,
    qPod,
    seeds,
    "labelled national until the local probe runs",
  );

  const qTags = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": headliner.entityId, "filter.tag.types": ["urn:tag:keyword:media", "urn:tag:genre:media", "urn:tag:theme:qloo", "urn:tag:audience:qloo"], "diversify.by": "subtype", take: 30 }, { resultCount: 30, note: "Denylist removed 1 tag (credit_card); 2 bill tags survived the allowlist." });

  const zctas = [...new Set(top.flatMap((t) => t.zctas ?? []))];
  const c1 = L.add("acs", "GET", ACS_ENDPOINT, acsParams(zctas), { resultCount: zctas.length, curl: acsCurl(zctas), note: ACS_NOTE });

  const bill: Bill = {
    acts: [
      { name: "Ada Pell", role: "headliner", isComedian: true },
      { name: "Margo Vint", role: "support", isComedian: true },
    ],
    venue: { ...VENUE },
    date: "2026-12-04",
    weekday: "friday",
    legalAgeEnforced: null,
    classification: "Comedy (operator-entered)",
  };
  const operator: OperatorInputs = {
    seatsLeft: null,
    capacity: 320,
    mediaBudgetUsd: 600,
    streetTeamDays: ["wednesday", "thursday"],
    radiusKm: 60,
    declaredPartners: [],
  };
  const resolution: Resolution[] = [
    { input: "Ada Pell", role: "headliner", status: "exact", entity: headliner, ledgerRef: q1 },
    { input: "Margo Vint", role: "support", status: "unresolved", ledgerRef: q2 },
    { input: VENUE.name, role: "venue", status: "unresolved", ledgerRef: q3 },
    { input: "House roster (Ticketmaster)", role: "house", status: "unresolved", ledgerRef: t2 },
  ];

  const sheet: StreetSheet = {
    planId,
    createdAt,
    mode: "fixture",
    hypothetical: true,
    bill,
    operator,
    cards: {
      resolution: envelope(
        "partial",
        "1 of 2 acts resolved. Venue and house roster are not available, so the run uses the venue point and a comedy tag baseline.",
        resolution,
        [t1, t2, q1, q2, q3],
        ["Near matches without the comedian tag are never used."],
        "The support act has no exact match tagged comedian; the run continued on the headliner alone.",
      ),
      liftMap: envelope(
        "degraded",
        `${top.length} tiles with lift of 1.3 or more; top tile ${top[0]?.name} at ${top[0]?.lift.toFixed(2)}.`,
        { tiles, diagnostics: { spearmanLiftVsHeat: 0.71, baseline: "tag" as const } },
        [q4, q5, q6, q7, c1],
        ["Lift compares percentile ranks inside two responses; it is not a count of fans.", "Against a tag baseline, lift means 'versus comedy fans here', not 'versus this room's crowd'."],
        "degraded: tag baseline. The club's roster is not on Ticketmaster, and the heatmap widened to 60 km (140 cells inside 40 km).",
      ),
      partners: envelope(
        "partial",
        `${partners.length} partners across the top 3 tiles. Thin signal: treat as a starting list.`,
        partners,
        poolRefs,
        ["Suggested, not affiliated: no partner has agreed to anything."],
        "Two tiles returned fewer than 8 places at 2,000 m and were widened to 3,500 m; 11 partners against a target of 15.",
      ),
      declared: envelope("empty", "No partners declared yet.", [], [], ["Type the businesses you already work with to rank them for this bill."], "The operator has not typed any partners."),
      prePost: envelope(
        "partial",
        `${spots.length} spots within 2.5 km open on show night. Age policy unknown (no Ticketmaster listing), so bars are operator-only partners.`,
        spots,
        [qPre, t1],
        ["Assumed capacities are guesses the operator can edit.", "No house twin, so no 'tonight vs house' delta."],
        "Fewer than 6 spots inside 1.5 km; radius widened to 2,500 m.",
      ),
      media: envelope("partial", "3 podcasts. No sponsor brand came back.", media, [qPod, qBrand], ["Podcast reach is not measured here."], "The brand call was empty, so the sponsor slot is hidden."),
      demographics: envelope(
        "ok",
        "Age and gender skew for the headliner. No house block (tag baseline).",
        {
          bill: [{ entityId: headliner.entityId, age: { "24_and_younger": 0.05, "25_to_29": 0.11, "30_to_34": 0.09, "35_to_44": 0.03, "45_to_54": -0.08, "55_and_older": -0.14 }, gender: { male: 0.06, female: -0.06 } }],
          house: [],
        },
        [q8],
        ["Skews describe aggregate audiences, never individuals."],
      ),
      whatsDifferent: envelope(
        "degraded",
        "Tags that rank higher for this bill than for comedy fans in Tacoma in general.",
        {
          shared: [{ ...tag("urn:tag:genre:media:comedy", "Comedy"), score: 0.6 }],
          a: [
            { ...tag("urn:tag:genre:media:stand_up_comedy", "Stand-up comedy"), count: 1 },
            { ...tag("urn:tag:keyword:media:observational_comedy", "Observational comedy"), count: 4 },
          ],
          b: [
            { ...tag("urn:tag:genre:media:improv", "Improv"), count: 2 },
            { ...tag("urn:tag:genre:media:sketch_comedy", "Sketch comedy"), count: 5 },
          ],
          fromTagDiff: true,
        },
        [q9, q10, q11],
        ["A tag diff ranks tags; it does not measure how different two crowds are."],
        "degraded: tag diff. Compare returned only generic shared tags.",
      ),
      copyHooks: envelope(
        "partial",
        "2 hooks, drawn from partner tags.",
        [
          { text: "Stand-up comedy, late night.", tagIds: ["urn:tag:genre:media:stand_up_comedy", "urn:tag:good_for:place:late_night"] },
          { text: "Good for groups. Walk-ins welcome.", tagIds: ["urn:tag:good_for:place:groups", "urn:tag:amenity:place:walk_ins"] },
        ],
        [qTags],
        ["No jokes, no artist voice, no artist marks in partner copy."],
        "Only 2 bill tags survived the allowlist, so hooks come from partner tags.",
      ),
    },
    narration: {
      summary: `Thin signal: treat this as a starting list. Against a comedy tag baseline, the headliner's crowd over-indexes in ${top[0]?.name}, ${top[1]?.name} and ${top[2]?.name}. ${partners.length} partners; ${spots.length} spots near the club.`,
      tileWhy: top.map((t) => ({ geohash: t.geohash, text: `Lift ${t.lift.toFixed(2)} against the comedy tag baseline.` })),
      partnerLines: partners.slice(0, 3).map((p) => ({ entityId: p.entity.entityId, text: `Rank ${p.qlooRank} for this headliner near ${p.tileName ?? "the tile"}.` })),
      templated: true,
    },
    ledger: [],
    guard: { dropped: 0, reasons: ["1 tag denied by policy (credit_card)", "Narration used the deterministic template (no model call)."], deniedTagCount: 1 },
    budgetSplit: makeBudget(top),
    limits: [...SHEET_LIMITS, "Thin signal: treat as a starting list.", "Venue coordinates in this synthetic fixture are approximate."],
  };
  sheet.ledger = L.entries();

  return {
    synthetic: true,
    fixtureId: planId,
    title: "Super Funny, Tacoma",
    note: "Synthetic fixture. Acts, partner businesses, ids, scores and ledger timings are invented; neighbourhood names and ZIPs are real places used for layout only. Phone numbers use the reserved 555-01xx range and sites point at example.com.",
    sheet,
  };
}
