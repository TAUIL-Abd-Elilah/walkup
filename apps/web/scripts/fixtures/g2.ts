/**
 * G2 (synthetic): "Peninsula Comedy Night", an invented three-act comedy bill
 * at Hampton Coliseum, Sat Dec 19 2026. Acts, titles, businesses, ids and
 * scores are invented; only the room is real. No seats-left count.
 * Shows the honesty beats: needs_input on a one-word name, a proxy seed for a
 * thin act, and the policy guard dropping denied tags.
 */
import type { Bill, Candidate, OperatorInputs, Partner, QlooEntity, Resolution, StreetSheet } from "@walkup/contracts";
import type { SheetFixture } from "../../lib/fixture-types";
import {
  RunLedger,
  SHEET_LIMITS,
  WEEKDAY_SHORT,
  ACS_ENDPOINT,
  ACS_NOTE,
  acsCurl,
  acsParams,
  anthropicCurl,
  envelope,
  makeBudget,
  makeDeclared,
  makeMedia,
  makePartners,
  makeSpots,
  makeTiles,
  rng,
  synId,
  tag,
  type DeclaredSpec,
  type PlaceContext,
  type Seed,
  type SpotSpec,
  type TilePartnerSpec,
  type TileSpec,
} from "./common";

const VENUE = {
  name: "Hampton Coliseum",
  // Approximate point for the synthetic fixture; live runs use Ticketmaster's lat/lon.
  lat: 37.0447,
  lon: -76.3889,
  city: "Hampton",
  state: "VA",
  country: "US",
  tmVenueId: "syn-tm-venue-hampton",
  qlooEntityId: synId("place", "Hampton Coliseum|Hampton"),
};

const T = (name: string, lat: number, lon: number, lift: number, zctas: string[], adults: number): TileSpec => ({ name, lat, lon, lift, zctas, adults });

const TILES: TileSpec[] = [
  T("Phoebus", 37.0205, -76.3265, 1.94, ["23663"], 6200),
  T("Hilton Village", 37.0285, -76.4625, 1.77, ["23601"], 5400),
  T("Ghent", 36.8625, -76.295, 1.61, ["23517"], 7900),
  T("Olde Towne Portsmouth", 36.8365, -76.3005, 1.47, ["23704"], 4600),
  T("Downtown Hampton", 37.0255, -76.344, 1.34, ["23669"], 3800),
  T("Buckroe Beach", 37.039, -76.295, 1.21, ["23664"], 4300),
  T("Denbigh", 37.125, -76.53, 1.15, ["23602"], 9600),
  T("City Center", 37.088, -76.4805, 1.12, ["23606"], 6800),
  T("Downtown Norfolk", 36.847, -76.29, 1.08, ["23510"], 5200),
  T("Ocean View", 36.95, -76.25, 0.97, ["23503"], 7100),
  T("Greenbrier", 36.78, -76.22, 0.91, ["23320"], 8700),
  T("Town Center", 36.8435, -76.135, 0.83, ["23462"], 9900),
  T("Coliseum Central", 37.043, -76.387, 0.78, ["23666"], 5600),
];

const PARTNERS: { city: string; specs: TilePartnerSpec[] }[] = [
  {
    city: "Hampton",
    specs: [
      { name: "Crown & Clipper Barbershop", category: "barber_shop", street: "Mellen St", qlooRank: 1 },
      { name: "Harborline Seafood Kitchen", category: "restaurant", street: "E Mercury Blvd", qlooRank: 2 },
      { name: "Saltbox Records & Tapes", category: "record_store", street: "E County St", qlooRank: 4 },
      { name: "Mallory Row Salon", category: "beauty_salon", street: "N Mallory St", qlooRank: 5 },
      { name: "Porchside Grill", category: "restaurant", street: "S Mallory St", qlooRank: 7 },
      { name: "Lighthouse Lounge", category: "bar", street: "Mellen St", qlooRank: 8, extraTags: ["groups"] },
    ],
  },
  {
    city: "Newport News",
    specs: [
      { name: "Tidewater Fade Studio", category: "barber_shop", street: "Warwick Blvd", qlooRank: 1 },
      { name: "Shipyard Shift Diner", category: "restaurant", street: "Warwick Blvd", qlooRank: 2 },
      { name: "Riverside Reel Records", category: "record_store", street: "Main St", qlooRank: 3 },
      { name: "Halyard Taproom", category: "bar", street: "River Rd", qlooRank: 6 },
      { name: "Gloss Theory Salon", category: "beauty_salon", street: "Hopkins St", qlooRank: 7 },
      { name: "Anchor & Oak Cafe", category: "cafe", street: "Warwick Blvd", qlooRank: 9 },
    ],
  },
  {
    city: "Norfolk",
    specs: [
      { name: "Elm & Ember Bistro", category: "restaurant", street: "W 21st St", qlooRank: 1 },
      { name: "Mercury Line Cuts", category: "barber_shop", street: "Colley Ave", qlooRank: 2 },
      { name: "Wax Tidings Records", category: "record_store", street: "Colley Ave", qlooRank: 3 },
      { name: "Low Tide Lounge", category: "bar", street: "Granby St", qlooRank: 5 },
      { name: "Twenty-Second Street Salon", category: "beauty_salon", street: "W 22nd St", qlooRank: 8 },
      { name: "Bluefin Supper Club", category: "restaurant", street: "Colonial Ave", qlooRank: 10 },
    ],
  },
];

const SPOTS: SpotSpec[] = [
  { name: "Front Row Fish Fry", category: "restaurant", street: "Coliseum Dr", northM: -350, eastM: 420, deltaRank: 5, share: 0.025, capacity: 80 },
  { name: "Box Office Burger Bar", category: "restaurant", street: "W Mercury Blvd", northM: 520, eastM: -310, deltaRank: 4, share: 0.03, capacity: 120 },
  { name: "Mercury Blvd Wing Shack", category: "restaurant", street: "W Mercury Blvd", northM: 610, eastM: 280, deltaRank: 3, share: 0.028, capacity: 90 },
  { name: "Coliseum Crossing Coffee", category: "cafe", street: "Coliseum Dr", northM: -720, eastM: -180, deltaRank: 2, share: 0.012, capacity: 45 },
  { name: "Late Show Lounge", category: "bar", street: "Cunningham Dr", northM: 900, eastM: 650, deltaRank: 1, share: 0.02, capacity: 140 },
  { name: "Headliner Tap House", category: "bar", street: "Power Plant Pkwy", northM: -1100, eastM: 820, deltaRank: -1, share: 0.018, capacity: 150 },
];

const DECLARED: DeclaredSpec[] = [
  { label: "HBCU alumni chapter, Peninsula (operator contact)" },
  { label: "Divine Nine graduate chapter, Norfolk (operator contact)" },
  { label: "Congregation outreach team, Newport News (operator contact)" },
  { label: "Crown & Clipper Barbershop", place: { name: "Crown & Clipper Barbershop", category: "barber_shop", street: "Mellen St", northM: 0, eastM: 0, rank: 1, city: "Hampton" } },
  { label: "Tidewater Fade Studio", place: { name: "Tidewater Fade Studio", category: "barber_shop", street: "Warwick Blvd", northM: 0, eastM: 0, rank: 2, city: "Newport News" } },
  { label: "Mercury Line Cuts", place: { name: "Mercury Line Cuts", category: "barber_shop", street: "Colley Ave", northM: 0, eastM: 0, rank: 3, city: "Norfolk" } },
  { label: "Southside Social Hall" },
];

export function buildG2(): SheetFixture {
  const r = rng(3303);
  const createdAt = "2026-10-17T14:30:00.000Z";
  const L = new RunLedger(createdAt, r);
  const venuePoint = `POINT(${VENUE.lon} ${VENUE.lat})`;
  const planId = "g2";
  const tmEventId = "syn-tm-event-g2";
  const streetDay = "thursday" as const;
  const phoneCounter = { n: 0 };
  const ctxFor = (city: string): PlaceContext => ({ city, state: "VA", areaCode: "757", phoneCounter, weekdayShort: WEEKDAY_SHORT[streetDay] });

  const t1 = L.add("tm", "GET", "/discovery/v2/events.json", { id: tmEventId, apikey: "$TICKETMASTER_API_KEY" }, { resultCount: 1, note: "Bill, venue and date from the listing. Age policy not set on the listing." });
  const t2 = L.add("tm", "GET", "/discovery/v2/events.json", { venueId: VENUE.tmVenueId, size: 60, sort: "date,asc", apikey: "$TICKETMASTER_API_KEY" }, { resultCount: 41, cacheHit: true, note: "House roster: 41 upcoming events (weekly cache)." });

  // --- Resolution ----------------------------------------------------------
  const headliner: QlooEntity = {
    entityId: synId("person", "Dorian Pike"),
    name: "Dorian Pike",
    subtype: "urn:entity:person",
    popularity: 0.88,
    affinity: null,
    tags: [], // person-entity tags are stripped before anything is persisted
    properties: { short_description: "Comedian and actor (fixture text).", occupation_check: "comedian tag present" },
  };
  const thinAct: QlooEntity = {
    entityId: synId("person", "Reggie Collier"),
    name: "Reggie Collier",
    subtype: "urn:entity:person",
    popularity: 0.33,
    affinity: null,
    tags: [],
    properties: { short_description: "Actor and comedian (fixture text)." },
  };
  const title = (name: string, subtype: string, year: number, pop: number): QlooEntity => ({
    entityId: synId(subtype.split(":").pop() ?? "title", name),
    name,
    subtype,
    popularity: pop,
    affinity: null,
    tags: [tag("urn:tag:genre:media:comedy", "Comedy")],
    properties: { release_year: year, short_description: "Title used as a proxy seed (fixture text)." },
  });
  const diner = title("Late Shift Diner", "urn:entity:tv_show", 1994, 0.86);
  const pier = title("Saturday Night at the Pier", "urn:entity:movie", 2001, 0.78);
  const cornerHouse = title("Corner House", "urn:entity:tv_show", 2018, 0.81);
  const venueEntity: QlooEntity = {
    entityId: VENUE.qlooEntityId,
    name: VENUE.name,
    subtype: "urn:entity:place",
    popularity: 0.88,
    affinity: null,
    tags: [tag("urn:tag:category:place:arena", "Arena")],
    properties: { address: "Coliseum Dr, Hampton, VA" },
    location: { lat: VENUE.lat, lon: VENUE.lon },
  };
  const candidates: Candidate[] = [
    { entityId: synId("person", "Sidecar|comedian"), name: "Sidecar", subtype: "urn:entity:person", popularity: 0.62, shortDescription: "Stand-up comedian", externalUrl: "https://example.com/walkup-fixture/candidates/sidecar-person" },
    { entityId: synId("movie", "Sidecar|1987"), name: "Sidecar", subtype: "urn:entity:movie", popularity: 0.55, shortDescription: "Road movie", releaseYear: 1987, externalUrl: "https://example.com/walkup-fixture/candidates/sidecar-film" },
    { entityId: synId("artist", "Sidecar|band"), name: "Sidecar", subtype: "urn:entity:artist", popularity: 0.31, shortDescription: "Rock band", externalUrl: "https://example.com/walkup-fixture/candidates/sidecar-band" },
    { entityId: synId("tv_show", "Sidecar|series"), name: "Sidecar", subtype: "urn:entity:tv_show", popularity: 0.12, shortDescription: "Documentary series", releaseYear: 2009, externalUrl: "https://example.com/walkup-fixture/candidates/sidecar-series" },
  ];

  const q1 = L.add("qloo", "GET", "/search", { query: "Dorian Pike", types: ["urn:entity:artist", "urn:entity:person"], take: 5 }, { resultCount: 5, note: "Exact normalized-name match; comedian tag check passed." });
  const q2 = L.add("qloo", "GET", "/search", { query: "Sidecar", types: ["urn:entity:artist", "urn:entity:person"], take: 5 }, { resultCount: 4, envelope: "needs_input", note: "One-word name: 4 candidates across types. Never resolved silently." });
  const q3 = L.add("qloo", "GET", "/search", { query: "Reggie Collier", types: ["urn:entity:artist", "urn:entity:person"], take: 5 }, { resultCount: 1, envelope: "partial", note: "Exact match but thin signal; proxy seed offered." });
  const q4 = L.add("qloo", "GET", "/search", { query: "Late Shift Diner", types: ["urn:entity:movie", "urn:entity:tv_show"], take: 5 }, { resultCount: 5, note: "Proxy checked against properties.release_year = 1994." });
  const q5 = L.add("qloo", "GET", "/search", { query: "Saturday Night at the Pier", types: ["urn:entity:movie", "urn:entity:tv_show"], take: 5 }, { resultCount: 2, note: "Stand-up seed: headliner's raw profile is dominated by family-film audiences." });
  const q6 = L.add("qloo", "GET", "/search", { query: "Corner House", types: ["urn:entity:movie", "urn:entity:tv_show"], take: 5 }, { resultCount: 5, note: "TV seed, checked against release_year = 2018." });
  const q7 = L.add("qloo", "GET", "/search", { query: VENUE.name, types: "urn:entity:place", "filter.location": `${VENUE.lat},${VENUE.lon}`, "filter.radius": 1 }, { resultCount: 1 });
  const houseIds = Array.from({ length: 8 }, (_, i) => synId("artist", `Hampton Coliseum house act ${i + 1}`));
  const q8 = L.add("qloo", "GET", "/entities", { "external.spotify.ids": houseIds.map((_, i) => `syn-house-${String(i + 1).padStart(2, "0")}`) }, { resultCount: 8, cacheHit: true, note: "House set: 8 of 12 roster headliners resolved (weekly cache)." });

  const seedIds = [pier.entityId, cornerHouse.entityId, headliner.entityId, diner.entityId];
  const seeds: Seed[] = [
    { entityId: pier.entityId, weight: 1 },
    { entityId: cornerHouse.entityId, weight: 0.8 },
    { entityId: headliner.entityId, weight: 0.5 },
    { entityId: diner.entityId, weight: 0.4 },
  ];

  // --- Heatmaps -------------------------------------------------------------
  const q9 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": seedIds, "filter.location": venuePoint, "filter.location.radius": 40000 }, { resultCount: 1460, bytes: 214_800, note: "Bill heat on the resolved subset and proxy seeds; GET (POST weights not verified yet)." });
  const q10 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": houseIds, "filter.location": venuePoint, "filter.location.radius": 40000 }, { resultCount: 1720, bytes: 251_300, cacheHit: true, note: "House heat (weekly cache per venue)." });
  const q11 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.tags": "urn:tag:category:place:restaurant", "filter.location": venuePoint, "filter.location.radius": 40000 }, { resultCount: 1980, bytes: 290_100, cacheHit: true, note: "Generic baseline: diagnostic only." });
  const tiles = makeTiles(TILES, r);
  const top = tiles.filter((t) => t.lift >= 1.3).slice(0, 5);
  const maxLift = top[0]?.lift ?? 1;

  const q12 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": [headliner.entityId, diner.entityId, pier.entityId, cornerHouse.entityId, houseIds[0]!] }, { resultCount: 5, envelope: "partial", note: "Reggie Collier's block comes from his proxy seed." });
  const q13 = L.add("qloo", "GET", "/v2/analysis/compare", { "a.signal.interests.entities": seedIds, "b.signal.interests.entities": houseIds, take: 30 }, { resultCount: 30 });

  // --- Partners --------------------------------------------------------------
  const categories = ["bar", "restaurant", "cafe", "record_store", "barber_shop", "beauty_salon"].map((c) => `urn:tag:category:place:${c}`);
  const partners: Partner[] = [];
  const poolRefs: string[] = [];
  top.slice(0, 3).forEach((tile, i) => {
    const group = PARTNERS[i];
    if (!group) return;
    const ref = L.add(
      "qloo",
      "GET",
      "/v2/insights",
      {
        "filter.type": "urn:entity:place",
        "signal.interests.entities": seedIds,
        "filter.location": `POINT(${tile.lon} ${tile.lat})`,
        "filter.location.radius": 2000,
        "filter.tags": categories,
        "operator.filter.tags": "union",
        "filter.hours": streetDay,
        "filter.price_level.max": 3,
        "filter.exclude.tags": "urn:tag:category:place:night_club",
        "filter.exclude.entities": VENUE.qlooEntityId,
        "feature.explainability": true,
        take: 50,
      },
      { resultCount: 50, note: `Partner pool for tile ${tile.name ?? tile.geohash}. barber_shop and beauty_salon are probe-gated categories.` },
    );
    poolRefs.push(ref);
    partners.push(...makePartners(tile, maxLift, group.specs, ctxFor(group.city), r, { pool: ref, billHeat: q9 }, seeds));
  });
  partners.sort((a, b) => b.score - a.score);

  // --- Pre/post ----------------------------------------------------------------
  const qPre = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:place", "signal.interests.entities": seedIds, "filter.location": venuePoint, "filter.location.radius": 1500, "filter.tags": ["urn:tag:category:place:restaurant", "urn:tag:category:place:bar", "urn:tag:category:place:cafe"], "operator.filter.tags": "union", "filter.hours": "saturday", "filter.exclude.entities": VENUE.qlooEntityId, "feature.explainability": true, take: 30 }, { resultCount: 30 });
  const qTwin = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:place", "signal.interests.entities": houseIds, "filter.location": venuePoint, "filter.location.radius": 1500, "filter.tags": ["urn:tag:category:place:restaurant", "urn:tag:category:place:bar", "urn:tag:category:place:cafe"], "operator.filter.tags": "union", "filter.hours": "saturday", take: 30 }, { resultCount: 30, cacheHit: true, note: "House-signal twin for the delta rank (weekly cache)." });
  const spots = makeSpots(VENUE, SPOTS, { ...ctxFor("Hampton"), weekdayShort: WEEKDAY_SHORT.saturday }, r, { pool: qPre, twin: qTwin }, seeds, null);

  // --- Declared ------------------------------------------------------------------
  const reuse = new Map(partners.map((p) => [p.entity.name, p.entity] as const));
  const scored = DECLARED.filter((d) => d.place);
  const qDecl = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:place", "filter.results.entities": scored.map((d) => reuse.get(d.label)?.entityId ?? d.label), "signal.interests.entities": seedIds }, { resultCount: scored.length, note: "3 of 7 declared items were picked from a /search pick list; the rest are not places in the catalog." });
  const declared = makeDeclared(DECLARED, VENUE, ctxFor("Hampton"), r, qDecl, seeds, reuse);

  // --- Media ---------------------------------------------------------------------
  const qPod = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:podcast", "signal.interests.entities": seedIds, "signal.location": venuePoint, "feature.explainability": true, take: 15 }, { resultCount: 15, note: "signal.location probe pending: labelled national." });
  const qBrand = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": seedIds, "signal.location": venuePoint, "filter.exclude.tags": ["urn:tag:category:brand:alcohol", "urn:tag:category:brand:tobacco", "urn:tag:category:brand:gambling", "urn:tag:category:brand:political"], "feature.explainability": true, take: 15 }, { resultCount: 15, note: "Age policy unknown: alcohol, tobacco, gambling and political brands excluded." });
  const media = [
    ...makeMedia(
      [
        { name: "The Laugh Track Rewind", kind: "podcast", publisher: "Fictional network" },
        { name: "Sitcom Summit", kind: "podcast", publisher: "Fictional network" },
        { name: "Front Row Funny", kind: "podcast", publisher: "Fictional network" },
        { name: "Tidewater Talks", kind: "podcast", publisher: "Fictional network" },
      ],
      r,
      qPod,
      seeds,
      "labelled national until the local probe runs",
    ),
    ...makeMedia([{ name: "Chesapeake Sweet Tea Co.", kind: "sponsor", publisher: "Fictional brand" }], r, qBrand, seeds, "labelled national until the local probe runs"),
  ];

  const qTags = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": seedIds, "filter.tag.types": ["urn:tag:keyword:media", "urn:tag:genre:media", "urn:tag:theme:qloo", "urn:tag:audience:qloo"], "diversify.by": "subtype", take: 30 }, { resultCount: 30, note: "Denylist removed 3 tags (ethnicity/inclusivity/credit_card) before the allowlist." });

  const zctas = [...new Set(top.flatMap((t) => t.zctas ?? []))];
  const c1 = L.add("acs", "GET", ACS_ENDPOINT, acsParams(zctas), { resultCount: zctas.length, curl: acsCurl(zctas), note: ACS_NOTE });
  L.add("anthropic", "POST", "/v1/messages", { model: "claude-opus-5-5", "output_config.effort": "low", "output_config.format": "json_schema:street_sheet_narration", max_tokens: 4000 }, { resultCount: 1, latencyMs: 6900, bytes: 8_300, curl: anthropicCurl(), note: "Narration may cite only ids and numbers from this run; guard dropped 0." });

  const bill: Bill = {
    acts: [
      { name: "Dorian Pike", role: "headliner", isComedian: true, tmAttractionId: "syn-tm-att-dorian-pike" },
      { name: "Sidecar", role: "co", isComedian: true, tmAttractionId: "syn-tm-att-sidecar" },
      { name: "Reggie Collier", role: "support", isComedian: true, tmAttractionId: "syn-tm-att-reggie-collier" },
    ],
    venue: { ...VENUE },
    date: "2026-12-19",
    weekday: "saturday",
    legalAgeEnforced: null,
    classification: "Arts & Theatre / Comedy",
    tmEventId,
    tmUrl: `https://www.ticketmaster.com/event/${tmEventId}`,
  };
  const operator: OperatorInputs = {
    seatsLeft: null,
    capacity: null,
    mediaBudgetUsd: null,
    streetTeamDays: ["thursday", "friday"],
    radiusKm: 40,
    declaredPartners: declared.inputs,
  };

  const resolution: Resolution[] = [
    { input: "Dorian Pike", role: "headliner", status: "exact", entity: headliner, ledgerRef: q1 },
    { input: "Sidecar", role: "co", status: "needs_input", candidates, ledgerRef: q2 },
    { input: "Reggie Collier", role: "support", status: "proxy", entity: thinAct, proxy: { entity: diner, reason: "Qloo has little on Reggie Collier, so his TV series stands in." }, ledgerRef: q4 },
    { input: "Saturday Night at the Pier", role: "headliner", status: "proxy", proxy: { entity: pier, reason: "Dorian Pike's Qloo profile mostly reflects family films, so a stand-up special and a sitcom stand in for him." }, proxyFor: "Dorian Pike", ledgerRef: q5 },
    { input: "Corner House", role: "headliner", status: "proxy", proxy: { entity: cornerHouse, reason: "Dorian Pike's Qloo profile mostly reflects family films, so a stand-up special and a sitcom stand in for him." }, proxyFor: "Dorian Pike", ledgerRef: q6 },
    { input: VENUE.name, role: "venue", status: "exact", entity: venueEntity, ledgerRef: q7 },
    { input: "House roster (next 60 Ticketmaster events)", role: "house", status: "exact", ledgerRef: q8 },
  ];

  const sheet: StreetSheet = {
    planId,
    createdAt,
    mode: "fixture",
    hypothetical: false,
    bill,
    operator,
    cards: {
      resolution: envelope(
        "needs_input",
        "1 act exact, 1 act on a proxy seed, 1 act waiting for your pick. Venue resolved; house set 8 of 12.",
        resolution,
        [t1, t2, q1, q2, q3, q4, q5, q6, q7, q8],
        ["A one-word name is never resolved silently."],
        "\"Sidecar\" matches 4 catalog entities. Pick one to add the act; the run continued on the resolved subset.",
      ),
      liftMap: envelope(
        "partial",
        `${top.length} tiles with lift of 1.3 or more against the Coliseum's usual crowd; top tile ${top[0]?.name} at ${top[0]?.lift.toFixed(2)}.`,
        { tiles, diagnostics: { spearmanLiftVsHeat: 0.52, baseline: "house" as const } },
        [q9, q10, q11, c1],
        ["Lift compares percentile ranks inside two responses; it is not a count of fans.", "Lift tiles are where this bill's fans over-index versus the usual crowd, never where any group lives."],
        "Computed on the resolved subset: two stand-up/TV seeds with the headliner as anchor. Sidecar awaits your pick.",
      ),
      partners: envelope(
        "partial",
        `${partners.length} partners across the top 3 tiles in Hampton, Newport News and Norfolk.`,
        partners,
        poolRefs,
        ["Suggested, not affiliated: no partner has agreed to anything."],
        "Seeded on the resolved subset; 18 partners against a target of 20.",
      ),
      declared: envelope("ok", "3 of 7 of your partners ranked for this bill; 4 are not in Qloo's catalog, kept in your order.", declared.scores, [qDecl]),
      prePost: envelope(
        "ok",
        `${spots.length} spots within 1.5 km open on show night. Age policy is not set on the listing, so bars are operator-only partners.`,
        spots,
        [qPre, qTwin, t1],
        ["Assumed capacities are guesses the operator can edit.", "Alcohol rules come from the Ticketmaster age policy, never from Qloo."],
      ),
      media: envelope("ok", "4 podcasts and 1 sponsor brand. Local ranking not checked yet, so all are national.", media, [qPod, qBrand], ["Podcast reach and sponsor fit are not measured here."]),
      demographics: envelope(
        "partial",
        "Age and gender skew for the resolved acts, proxy seeds and the house set.",
        {
          bill: [
            { entityId: headliner.entityId, age: { "24_and_younger": -0.12, "25_to_29": -0.04, "30_to_34": 0.05, "35_to_44": 0.13, "45_to_54": 0.12, "55_and_older": 0.04 }, gender: { male: 0.01, female: -0.01 } },
            { entityId: diner.entityId, age: { "24_and_younger": -0.15, "25_to_29": -0.06, "30_to_34": 0.04, "35_to_44": 0.16, "45_to_54": 0.14, "55_and_older": 0.02 }, gender: { male: 0.02, female: -0.02 } },
            { entityId: pier.entityId, age: { "24_and_younger": -0.14, "25_to_29": -0.05, "30_to_34": 0.06, "35_to_44": 0.15, "45_to_54": 0.11, "55_and_older": 0.03 }, gender: { male: 0.03, female: -0.03 } },
          ],
          house: [{ entityId: houseIds[0]!, age: { "24_and_younger": 0.04, "25_to_29": 0.05, "30_to_34": 0.03, "35_to_44": 0.0, "45_to_54": -0.04, "55_and_older": -0.06 }, gender: { male: 0.04, female: -0.04 } }],
        },
        [q12],
        ["Skews describe aggregate audiences, never individuals.", "Not used for radio format, alcohol or community inference. The promoter picks the station format."],
        "Reggie Collier's block comes from his proxy seed.",
      ),
      whatsDifferent: envelope(
        "ok",
        "Tags distinctive to this bill versus the house crowd.",
        {
          shared: [{ ...tag("urn:tag:keyword:media:live_events", "Live events"), score: 0.38 }],
          a: [
            { ...tag("urn:tag:genre:media:stand_up_comedy", "Stand-up comedy"), score: 0.81 },
            { ...tag("urn:tag:genre:media:sitcom", "Sitcom"), score: 0.76 },
            { ...tag("urn:tag:keyword:media:classic_tv", "Classic TV"), score: 0.68 },
            { ...tag("urn:tag:genre:media:comedy", "Comedy"), score: 0.6 },
            { ...tag("urn:tag:keyword:media:family", "Family"), score: 0.52 },
          ],
          b: [
            { ...tag("urn:tag:genre:music:arena_rock", "Arena rock"), score: 0.7 },
            { ...tag("urn:tag:genre:music:country", "Country"), score: 0.64 },
            { ...tag("urn:tag:keyword:media:motorsports", "Motorsports"), score: 0.55 },
          ],
          fromTagDiff: false,
        },
        [q13],
      ),
      copyHooks: envelope(
        "ok",
        "3 hooks from partner ambience tags and the bill's media keywords.",
        [
          { text: "Stand-up comedy and sitcom classics, one night.", tagIds: ["urn:tag:genre:media:stand_up_comedy", "urn:tag:genre:media:sitcom", "urn:tag:keyword:media:classic_tv"] },
          { text: "Comedy night. Good for groups.", tagIds: ["urn:tag:genre:media:comedy", "urn:tag:good_for:place:groups"] },
          { text: "Classic TV, live. Walk-ins welcome at our partners.", tagIds: ["urn:tag:keyword:media:classic_tv", "urn:tag:amenity:place:walk_ins"] },
        ],
        [qTags],
        ["No jokes, no artist voice, no artist marks in partner copy."],
      ),
    },
    narration: {
      summary: `On the resolved subset, this bill's crowd over-indexes in ${top[0]?.name}, ${top[1]?.name} and ${top[2]?.name} versus the Coliseum's usual crowd. ${partners.length} partners across those tiles; ${spots.length} pre/post spots near the venue. Sidecar still needs a pick.`,
      tileWhy: top.map((t) => ({ geohash: t.geohash, text: `Lift ${t.lift.toFixed(2)}: bill percentile ${t.billPct.toFixed(2)} against a house percentile of ${t.housePct.toFixed(2)}.` })),
      partnerLines: partners.slice(0, 4).map((p) => ({ entityId: p.entity.entityId, text: `Rank ${p.qlooRank} of 50 for this bill inside the ${p.tileName ?? "top"} tile.` })),
      templated: false,
    },
    ledger: [],
    guard: { dropped: 0, reasons: ["3 tags denied by policy (ethnicity/inclusivity/credit_card)", "Person-entity tags stripped before storage."], deniedTagCount: 3 },
    budgetSplit: makeBudget(top),
    limits: [...SHEET_LIMITS, "Planning tool; no sales data is known or shown.", "Venue coordinates in this synthetic fixture are approximate; live runs take them from Ticketmaster."],
  };
  sheet.ledger = L.entries();

  return {
    synthetic: true,
    fixtureId: planId,
    title: "Hampton Coliseum: Peninsula Comedy Night",
    note: "Synthetic fixture. The bill is invented; acts, titles, partner businesses, ids, scores and ledger timings are made up, and only the room is real. Phone numbers use the reserved 555-01xx range and sites point at example.com.",
    sheet,
  };
}

