/**
 * G1 (synthetic): "Same room, two crowds" at The Truth, Nashville.
 * Two invented bills in the same room so the lift map, partners and declared
 * list visibly move with the bill. Acts and businesses are fictional.
 */
import type { Act, Bill, DemographicsBlock, LiftTile, OperatorInputs, Partner, QlooEntity, StreetSheet } from "@walkup/contracts";
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
  artistEntity,
  envelope,
  makeBudget,
  makeControl,
  makeDeclared,
  makeMedia,
  makePartners,
  makeSpots,
  makeTiles,
  placesCurl,
  rng,
  round,
  synId,
  tag,
  type ControlSpec,
  type DeclaredSpec,
  type MediaSpec,
  type PlaceContext,
  type Seed,
  type SpotSpec,
  type TilePartnerSpec,
  type TileSpec,
} from "./common";

export const TRUTH = {
  name: "The Truth",
  // Approximate central-Nashville point for the synthetic fixture; live runs use Ticketmaster's lat/lon.
  lat: 36.1612,
  lon: -86.7745,
  city: "Nashville",
  state: "TN",
  country: "US",
  tmVenueId: "syn-tm-venue-truth",
  qlooEntityId: null,
};

const T = (name: string, lat: number, lon: number, lift: number, zctas: string[], adults: number): TileSpec => ({ name, lat, lon, lift, zctas, adults });

interface Variant {
  key: "a" | "b";
  seed: number;
  createdAt: string;
  date: string;
  weekday: Bill["weekday"];
  legalAgeEnforced: boolean;
  classification: string;
  acts: { act: Act; popularity: number; tags: ReturnType<typeof tag>[] }[];
  tiles: TileSpec[];
  partners: [TilePartnerSpec[], TilePartnerSpec[], TilePartnerSpec[]];
  spots: SpotSpec[];
  declaredRanks: Record<string, number>;
  media: MediaSpec[];
  compare: { a: [string, string, number][]; b: [string, string, number][] };
  hooks: { text: string; tagIds: string[] }[];
  allowTags: [string, string][];
  demo: { bill: DemographicsBlock["age"][]; house: DemographicsBlock["age"] };
  control: { overlap: string[]; places: ControlSpec[]; queries: string[] };
  spearman: number;
  narration: (tiles: LiftTile[], partners: Partner[]) => NonNullable<StreetSheet["narration"]>;
}

const DECLARED: DeclaredSpec[] = [
  { label: "Gallatin Pike Pizza Co.", place: { name: "Gallatin Pike Pizza Co.", phoneSuffix: 30, category: "restaurant", street: "Gallatin Pike", northM: 2600, eastM: 2900, rank: 1 } },
  { label: "Bellhop Records", place: { name: "Bellhop Records", phoneSuffix: 31, category: "record_store", street: "Woodland St", northM: 900, eastM: 1700, rank: 2 } },
  { label: "Tall Pines Tavern", place: { name: "Tall Pines Tavern", phoneSuffix: 32, category: "bar", street: "Charlotte Ave", northM: -400, eastM: -4600, rank: 3 } },
  { label: "Cumberland Cup Coffee", place: { name: "Cumberland Cup Coffee", phoneSuffix: 33, category: "cafe", street: "Rosa L Parks Blvd", northM: 2000, eastM: -1200, rank: 4 } },
  { label: "Quarter Note Books", place: { name: "Quarter Note Books", phoneSuffix: 34, category: "book_store", street: "21st Ave S", northM: -2900, eastM: -2300, rank: 5 } },
  { label: "Row House Barbers", place: { name: "Row House Barbers", phoneSuffix: 35, category: "barber_shop", street: "Edgehill Ave", northM: -1800, eastM: -1100, rank: 6 } },
  { label: "Riverside Spoke Bike Co." },
  { label: "Westside Screen Printers" },
];

const g = (id: string, name: string) => tag(id, name);

const A: Variant = {
  key: "a",
  seed: 1101,
  createdAt: "2026-10-30T15:04:00.000Z",
  date: "2026-11-20",
  weekday: "friday",
  legalAgeEnforced: true,
  classification: "Music / Country (Americana)",
  acts: [
    { act: { name: "Hollis Creek String Band", role: "headliner", tmAttractionId: "syn-tm-att-hollis" }, popularity: 0.71, tags: [g("urn:tag:genre:music:americana", "Americana"), g("urn:tag:genre:music:bluegrass", "Bluegrass")] },
    { act: { name: "Marla Vane", role: "co", tmAttractionId: "syn-tm-att-vane" }, popularity: 0.58, tags: [g("urn:tag:genre:music:singer_songwriter", "Singer-songwriter"), g("urn:tag:genre:music:folk", "Folk")] },
    { act: { name: "The Ferry Lights", role: "support", tmAttractionId: "syn-tm-att-ferry" }, popularity: 0.44, tags: [g("urn:tag:genre:music:indie_folk", "Indie folk")] },
  ],
  tiles: [
    T("East Nashville", 36.177, -86.75, 2.14, ["37206"], 9800),
    T("Inglewood", 36.201, -86.728, 1.86, ["37216"], 7400),
    T("Sylvan Park", 36.149, -86.839, 1.71, ["37209"], 6900),
    T("12 South", 36.1245, -86.7895, 1.52, ["37204"], 5300),
    T("Germantown", 36.1795, -86.788, 1.38, ["37208"], 4100),
    T("Wedgewood-Houston", 36.1355, -86.7695, 1.21, ["37203"], 3900),
    T("Madison", 36.256, -86.714, 1.18, ["37115"], 8800),
    T("Hillsboro Village", 36.1345, -86.8, 1.12, ["37212"], 5100),
    T("The Nations", 36.164, -86.851, 1.09, ["37209"], 4700),
    T("Donelson", 36.169, -86.665, 1.05, ["37214"], 8200),
    T("Bellevue", 36.072, -86.933, 0.94, ["37221"], 9100),
    T("Midtown", 36.1515, -86.7985, 0.82, ["37203"], 6100),
    T("Antioch", 36.06, -86.672, 0.71, ["37013"], 12400),
    T("Downtown", 36.159, -86.7795, 0.64, ["37219", "37201"], 3800),
  ],
  partners: [
    [
      { name: "Porchlight Vinyl & Coffee", category: "record_store", street: "Fatherland St", qlooRank: 1 },
      { name: "The Rusty Mandolin Tavern", category: "bar", street: "Gallatin Ave", qlooRank: 2, extraTags: ["liveMusic"] },
      { name: "Juniper Biscuit House", category: "restaurant", street: "Woodland St", qlooRank: 3 },
      { name: "Second Fret Books", category: "book_store", street: "Eastland Ave", qlooRank: 5 },
      { name: "Lantern Row Barbers", category: "barber_shop", street: "Main St", qlooRank: 6 },
      { name: "Bramble & Thread Outfitters", category: "clothing_store", street: "S 11th St", qlooRank: 8 },
      { name: "Cold Creek Coffee Co.", category: "cafe", street: "McFerrin Ave", qlooRank: 9 },
      { name: "Whippoorwill Lounge", category: "bar", street: "Porter Rd", qlooRank: 11 },
    ],
    [
      { name: "Riverbend Record Exchange", category: "record_store", street: "Gallatin Pike", qlooRank: 2 },
      { name: "Hen & Harrow Kitchen", category: "restaurant", street: "Riverside Dr", qlooRank: 3 },
      { name: "Sawdust Floor Saloon", category: "bar", street: "Gallatin Pike", qlooRank: 4 },
      { name: "Thistledown Cafe", category: "cafe", street: "Riverwood Dr", qlooRank: 7 },
      { name: "Copperline Cuts", category: "barber_shop", street: "Kirkland Ave", qlooRank: 9 },
      { name: "Ridgeback Western Wear", category: "clothing_store", street: "Gallatin Pike", qlooRank: 12 },
    ],
    [
      { name: "Cedar Plank Smokehouse", category: "restaurant", street: "Charlotte Ave", qlooRank: 1 },
      { name: "Low Ceiling Listening Room", category: "bar", street: "46th Ave N", qlooRank: 3, extraTags: ["liveMusic"] },
      { name: "Paper Moth Bookshop", category: "book_store", street: "Murphy Rd", qlooRank: 4 },
      { name: "Kettle & Fiddle Cafe", category: "cafe", street: "Elkins Ave", qlooRank: 6 },
      { name: "Dusty Sleeve Records", category: "record_store", street: "Charlotte Ave", qlooRank: 8 },
      { name: "Hayloft Tailor & Denim", category: "clothing_store", street: "Park Ave", qlooRank: 13 },
    ],
  ],
  spots: [
    { name: "Marquee Supper Room", phoneSuffix: 40, category: "restaurant", street: "Hermitage Ave", northM: 380, eastM: 520, deltaRank: 5, share: 0.03, capacity: 140 },
    { name: "Ticket Stub Taproom", phoneSuffix: 41, category: "bar", street: "Lafayette St", northM: -420, eastM: 210, deltaRank: 4, share: 0.034, capacity: 160 },
    { name: "Stagedoor Diner", phoneSuffix: 42, category: "restaurant", street: "4th Ave S", northM: -610, eastM: -330, deltaRank: 3, share: 0.02, capacity: 90 },
    { name: "Intermission Coffee", phoneSuffix: 43, category: "cafe", street: "Peabody St", northM: 150, eastM: -520, deltaRank: 2, share: 0.011, capacity: 50 },
    { name: "Encore Hot Chicken", phoneSuffix: 44, category: "restaurant", street: "Lea Ave", northM: -880, eastM: 640, deltaRank: 0, share: 0.015, capacity: 70 },
    { name: "Overture Oyster Bar", phoneSuffix: 45, category: "bar", street: "2nd Ave S", northM: 700, eastM: -760, deltaRank: -1, share: 0.017, capacity: 80 },
    { name: "Curtain Call Pizza", phoneSuffix: 46, category: "restaurant", street: "Rutledge St", northM: -1150, eastM: -240, deltaRank: null, share: 0.022, capacity: 110 },
  ],
  declaredRanks: { "Gallatin Pike Pizza Co.": 1, "Bellhop Records": 2, "Tall Pines Tavern": 3, "Cumberland Cup Coffee": 4, "Quarter Note Books": 5, "Row House Barbers": 6 },
  media: [
    { name: "Back Porch Sessions", kind: "podcast", publisher: "Fictional network" },
    { name: "The Long Haul Songwriters Hour", kind: "podcast", publisher: "Fictional network" },
    { name: "Dirt Road Dispatch", kind: "podcast", publisher: "Fictional network" },
    { name: "Fiddle & Fable", kind: "podcast", publisher: "Fictional network" },
    { name: "Cumberland Cold Brew Co.", kind: "sponsor", publisher: "Fictional brand" },
  ],
  compare: {
    a: [
      ["urn:tag:genre:music:americana", "Americana", 0.82],
      ["urn:tag:genre:music:bluegrass", "Bluegrass", 0.74],
      ["urn:tag:genre:music:singer_songwriter", "Singer-songwriter", 0.69],
      ["urn:tag:keyword:media:storytelling", "Storytelling", 0.61],
      ["urn:tag:keyword:media:harmony", "Harmony", 0.55],
      ["urn:tag:genre:music:roots_rock", "Roots rock", 0.5],
    ],
    b: [
      ["urn:tag:genre:music:pop_country", "Pop country", 0.71],
      ["urn:tag:genre:music:arena_rock", "Arena rock", 0.66],
      ["urn:tag:genre:music:dance_pop", "Dance pop", 0.58],
      ["urn:tag:keyword:media:party", "Party", 0.52],
    ],
  },
  hooks: [
    { text: "Americana and bluegrass, played live.", tagIds: ["urn:tag:genre:music:americana", "urn:tag:genre:music:bluegrass", "urn:tag:amenity:place:live_music"] },
    { text: "Singer-songwriter storytelling, one night.", tagIds: ["urn:tag:genre:music:singer_songwriter", "urn:tag:keyword:media:storytelling"] },
    { text: "Harmony singing. Good for groups.", tagIds: ["urn:tag:keyword:media:harmony", "urn:tag:good_for:place:groups"] },
  ],
  allowTags: [
    ["urn:tag:genre:music:americana", "Americana"],
    ["urn:tag:genre:music:bluegrass", "Bluegrass"],
    ["urn:tag:genre:music:singer_songwriter", "Singer-songwriter"],
    ["urn:tag:keyword:media:storytelling", "Storytelling"],
    ["urn:tag:keyword:media:harmony", "Harmony"],
    ["urn:tag:genre:music:roots_rock", "Roots rock"],
    ["urn:tag:genre:music:folk", "Folk"],
  ],
  demo: {
    bill: [
      { "24_and_younger": -0.08, "25_to_29": 0.03, "30_to_34": 0.11, "35_to_44": 0.15, "45_to_54": 0.03, "55_and_older": -0.09 },
      { "24_and_younger": -0.05, "25_to_29": 0.06, "30_to_34": 0.12, "35_to_44": 0.09, "45_to_54": -0.02, "55_and_older": -0.1 },
      { "24_and_younger": 0.02, "25_to_29": 0.1, "30_to_34": 0.09, "35_to_44": 0.02, "45_to_54": -0.07, "55_and_older": -0.12 },
    ],
    house: { "24_and_younger": 0.06, "25_to_29": 0.08, "30_to_34": 0.04, "35_to_44": -0.01, "45_to_54": -0.04, "55_and_older": -0.08 },
  },
  control: {
    queries: ["americana bar Nashville", "record store Nashville", "bluegrass live music Nashville", "coffee shop near The Truth Nashville"],
    overlap: ["Porchlight Vinyl & Coffee", "The Rusty Mandolin Tavern", "Second Fret Books", "Riverbend Record Exchange"],
    places: [],
  },
  spearman: 0.41,
  narration: (tiles, partners) => ({
    summary: `This bill's crowd over-indexes in ${tiles[0]?.name}, ${tiles[1]?.name} and ${tiles[2]?.name} versus The Truth's usual crowd. ${partners.length} partners across those three tiles; 7 pre/post spots within 1.5 km.`,
    tileWhy: tiles.slice(0, 5).map((t) => ({
      geohash: t.geohash,
      text: `Lift ${t.lift.toFixed(2)}: bill percentile ${t.billPct.toFixed(2)} against a house percentile of ${t.housePct.toFixed(2)}.`,
    })),
    partnerLines: partners.slice(0, 4).map((p) => ({
      entityId: p.entity.entityId,
      text: `Rank ${p.qlooRank} of 50 for this bill inside the ${p.tileName ?? "top"} tile.`,
    })),
    templated: false,
  }),
};

const B: Variant = {
  key: "b",
  seed: 2202,
  createdAt: "2026-11-14T16:20:00.000Z",
  date: "2026-12-05",
  weekday: "saturday",
  legalAgeEnforced: false,
  classification: "Music / Pop (Indie pop)",
  acts: [
    { act: { name: "Neon Orchard", role: "headliner", tmAttractionId: "syn-tm-att-orchard" }, popularity: 0.74, tags: [g("urn:tag:genre:music:indie_pop", "Indie pop"), g("urn:tag:genre:music:synthpop", "Synth-pop")] },
    { act: { name: "Sable & Sun", role: "co", tmAttractionId: "syn-tm-att-sable" }, popularity: 0.55, tags: [g("urn:tag:genre:music:dream_pop", "Dream pop")] },
    { act: { name: "Kites Over Concrete", role: "support", tmAttractionId: "syn-tm-att-kites" }, popularity: 0.39, tags: [g("urn:tag:genre:music:indie_rock", "Indie rock")] },
  ],
  tiles: [
    T("The Nations", 36.164, -86.851, 2.05, ["37209"], 4700),
    T("Wedgewood-Houston", 36.1355, -86.7695, 1.92, ["37203"], 3900),
    T("Midtown", 36.1515, -86.7985, 1.66, ["37203"], 6100),
    T("Hillsboro Village", 36.1345, -86.8, 1.49, ["37212"], 5100),
    T("Germantown", 36.1795, -86.788, 1.33, ["37208"], 4100),
    T("12 South", 36.1245, -86.7895, 1.22, ["37204"], 5300),
    T("Sylvan Park", 36.149, -86.839, 1.17, ["37209"], 6900),
    T("East Nashville", 36.177, -86.75, 1.08, ["37206"], 9800),
    T("Antioch", 36.06, -86.672, 0.88, ["37013"], 12400),
    T("Inglewood", 36.201, -86.728, 0.86, ["37216"], 7400),
    T("Donelson", 36.169, -86.665, 0.79, ["37214"], 8200),
    T("Bellevue", 36.072, -86.933, 0.74, ["37221"], 9100),
    T("Downtown", 36.159, -86.7795, 0.71, ["37219", "37201"], 3800),
    T("Madison", 36.256, -86.714, 0.69, ["37115"], 8800),
  ],
  partners: [
    [
      { name: "Static Bloom Records", category: "record_store", street: "51st Ave N", qlooRank: 1 },
      { name: "Glasshouse Noodle Bar", category: "restaurant", street: "Centennial Blvd", qlooRank: 2 },
      { name: "Afterglow Arcade Bar", category: "bar", street: "Delaware Ave", qlooRank: 4, extraTags: ["lateNight"] },
      { name: "Softwave Coffee", category: "cafe", street: "51st Ave N", qlooRank: 5 },
      { name: "Second Skin Vintage", category: "clothing_store", street: "Centennial Blvd", qlooRank: 6 },
      { name: "Tidal Paper Zines", category: "book_store", street: "Alabama Ave", qlooRank: 8 },
      { name: "Fade Theory Barbers", category: "barber_shop", street: "Delaware Ave", qlooRank: 10 },
      { name: "Pixel & Pour", category: "bar", street: "Centennial Blvd", qlooRank: 12 },
    ],
    [
      { name: "Kiln Room Coffee", category: "cafe", street: "Martin St", qlooRank: 1 },
      { name: "Warehouse Nine Listening Bar", category: "bar", street: "Merritt Ave", qlooRank: 2, extraTags: ["liveMusic"] },
      { name: "Loop & Lathe Records", category: "record_store", street: "Hagan St", qlooRank: 3 },
      { name: "Brightside Dumpling Co.", category: "restaurant", street: "Houston St", qlooRank: 5 },
      { name: "Margin Notes Books", category: "book_store", street: "Chestnut St", qlooRank: 7 },
      { name: "Thrift Theory Vintage", category: "clothing_store", street: "Martin St", qlooRank: 9 },
    ],
    [
      { name: "Velvet Hour Cocktail Den", category: "bar", street: "Division St", qlooRank: 2, extraTags: ["dateNight"] },
      { name: "Paperlight Ramen", category: "restaurant", street: "Elliston Pl", qlooRank: 3 },
      { name: "Satellite Record Shop", category: "record_store", street: "Elliston Pl", qlooRank: 4 },
      { name: "Little Orbit Cafe", category: "cafe", street: "Church St", qlooRank: 6 },
      { name: "Studio Cut Barbers", category: "barber_shop", street: "Hayes St", qlooRank: 9 },
      { name: "Polaroid Pocket Clothing", category: "clothing_store", street: "West End Ave", qlooRank: 11 },
    ],
  ],
  spots: [
    { name: "Intermission Coffee", phoneSuffix: 43, category: "cafe", street: "Peabody St", northM: 150, eastM: -520, deltaRank: 6, share: 0.011, capacity: 50 },
    { name: "Curtain Call Pizza", phoneSuffix: 46, category: "restaurant", street: "Rutledge St", northM: -1150, eastM: -240, deltaRank: 4, share: 0.024, capacity: 110 },
    { name: "Encore Hot Chicken", phoneSuffix: 44, category: "restaurant", street: "Lea Ave", northM: -880, eastM: 640, deltaRank: 3, share: 0.016, capacity: 70 },
    { name: "Overture Oyster Bar", phoneSuffix: 45, category: "bar", street: "2nd Ave S", northM: 700, eastM: -760, deltaRank: 2, share: 0.018, capacity: 80 },
    { name: "Marquee Supper Room", phoneSuffix: 40, category: "restaurant", street: "Hermitage Ave", northM: 380, eastM: 520, deltaRank: -1, share: 0.03, capacity: 140 },
    { name: "Stagedoor Diner", phoneSuffix: 42, category: "restaurant", street: "4th Ave S", northM: -610, eastM: -330, deltaRank: 0, share: 0.019, capacity: 90 },
    { name: "Ticket Stub Taproom", phoneSuffix: 41, category: "bar", street: "Lafayette St", northM: -420, eastM: 210, deltaRank: -2, share: 0.03, capacity: 160 },
  ],
  declaredRanks: { "Quarter Note Books": 1, "Bellhop Records": 2, "Cumberland Cup Coffee": 3, "Row House Barbers": 4, "Tall Pines Tavern": 5, "Gallatin Pike Pizza Co.": 6 },
  media: [
    { name: "Bedroom Pop Diaries", kind: "podcast", publisher: "Fictional network" },
    { name: "Synth Club Radio Hour", kind: "podcast", publisher: "Fictional network" },
    { name: "Tape Hiss Weekly", kind: "podcast", publisher: "Fictional network" },
    { name: "Small Venue, Big Sound", kind: "podcast", publisher: "Fictional network" },
    { name: "Lumen Sparkling Water Co.", kind: "sponsor", publisher: "Fictional brand" },
  ],
  compare: {
    a: [
      ["urn:tag:genre:music:indie_pop", "Indie pop", 0.84],
      ["urn:tag:genre:music:synthpop", "Synth-pop", 0.77],
      ["urn:tag:genre:music:dream_pop", "Dream pop", 0.7],
      ["urn:tag:keyword:media:dance", "Dance", 0.63],
      ["urn:tag:genre:music:bedroom_pop", "Bedroom pop", 0.58],
      ["urn:tag:keyword:place:vinyl", "Vinyl", 0.51],
    ],
    b: [
      ["urn:tag:genre:music:pop_country", "Pop country", 0.74],
      ["urn:tag:genre:music:southern_rock", "Southern rock", 0.65],
      ["urn:tag:genre:music:arena_rock", "Arena rock", 0.6],
    ],
  },
  hooks: [
    { text: "Indie pop and synth-pop, late night.", tagIds: ["urn:tag:genre:music:indie_pop", "urn:tag:genre:music:synthpop", "urn:tag:good_for:place:late_night"] },
    { text: "Dream pop for the vinyl crowd.", tagIds: ["urn:tag:genre:music:dream_pop", "urn:tag:keyword:place:vinyl"] },
    { text: "Dance night. Good for groups.", tagIds: ["urn:tag:keyword:media:dance", "urn:tag:good_for:place:groups"] },
  ],
  allowTags: [
    ["urn:tag:genre:music:indie_pop", "Indie pop"],
    ["urn:tag:genre:music:synthpop", "Synth-pop"],
    ["urn:tag:genre:music:dream_pop", "Dream pop"],
    ["urn:tag:keyword:media:dance", "Dance"],
    ["urn:tag:genre:music:bedroom_pop", "Bedroom pop"],
    ["urn:tag:genre:music:indie_rock", "Indie rock"],
  ],
  demo: {
    bill: [
      { "24_and_younger": 0.14, "25_to_29": 0.16, "30_to_34": 0.05, "35_to_44": -0.06, "45_to_54": -0.12, "55_and_older": -0.17 },
      { "24_and_younger": 0.11, "25_to_29": 0.13, "30_to_34": 0.07, "35_to_44": -0.03, "45_to_54": -0.1, "55_and_older": -0.16 },
      { "24_and_younger": 0.09, "25_to_29": 0.12, "30_to_34": 0.06, "35_to_44": -0.02, "45_to_54": -0.09, "55_and_older": -0.15 },
    ],
    house: { "24_and_younger": 0.06, "25_to_29": 0.08, "30_to_34": 0.04, "35_to_44": -0.01, "45_to_54": -0.04, "55_and_older": -0.08 },
  },
  control: {
    queries: ["indie music bar Nashville", "record store Nashville", "late night bar Nashville", "coffee shop near The Truth Nashville"],
    overlap: ["Static Bloom Records", "Velvet Hour Cocktail Den", "Satellite Record Shop"],
    places: [],
  },
  spearman: 0.37,
  narration: (tiles, partners) => ({
    summary: `This bill's crowd over-indexes in ${tiles[0]?.name}, ${tiles[1]?.name} and ${tiles[2]?.name} versus The Truth's usual crowd. ${partners.length} partners across those three tiles; 7 pre/post spots within 1.5 km, bars listed for the operator only (all-ages show).`,
    tileWhy: tiles.slice(0, 5).map((t) => ({
      geohash: t.geohash,
      text: `Lift ${t.lift.toFixed(2)}: bill percentile ${t.billPct.toFixed(2)} against a house percentile of ${t.housePct.toFixed(2)}.`,
    })),
    partnerLines: partners.slice(0, 4).map((p) => ({
      entityId: p.entity.entityId,
      text: `Rank ${p.qlooRank} of 50 for this bill inside the ${p.tileName ?? "top"} tile.`,
    })),
    templated: false,
  }),
};

const DOWNTOWN = { lat: 36.1595, lon: -86.778 };
const MIDTOWN = { lat: 36.152, lon: -86.7985 };
const GULCH = { lat: 36.1525, lon: -86.785 };

const CONTROL_A: ControlSpec[] = [
  { name: "Lower Broad Boot Hall", street: "Broadway", query: "americana bar Nashville", near: DOWNTOWN },
  { name: "Neon Saddle Honky-Tonk", street: "Broadway", query: "americana bar Nashville", near: DOWNTOWN },
  { name: "The Rusty Mandolin Tavern", street: "Gallatin Ave", query: "americana bar Nashville", near: { lat: 36.1785, lon: -86.7495 } },
  { name: "Big Fiddle Bar & Grill", street: "2nd Ave N", query: "bluegrass live music Nashville", near: DOWNTOWN },
  { name: "Steel Guitar Smokehouse", street: "Broadway", query: "bluegrass live music Nashville", near: DOWNTOWN },
  { name: "Riverfront Pickers Pub", street: "1st Ave N", query: "bluegrass live music Nashville", near: DOWNTOWN },
  { name: "Honeysuckle Hall Bar", street: "Demonbreun St", query: "bluegrass live music Nashville", near: GULCH },
  { name: "Downtown Vinyl Depot", street: "5th Ave N", query: "record store Nashville", near: DOWNTOWN },
  { name: "Studio Row Records", street: "Music Square E", query: "record store Nashville", near: MIDTOWN },
  { name: "Porchlight Vinyl & Coffee", street: "Fatherland St", query: "record store Nashville", near: { lat: 36.1765, lon: -86.7505 } },
  { name: "Riverbend Record Exchange", street: "Gallatin Pike", query: "record store Nashville", near: { lat: 36.2015, lon: -86.7275 } },
  { name: "Second Fret Books", street: "Eastland Ave", query: "record store Nashville", near: { lat: 36.1775, lon: -86.7485 } },
  { name: "Hatch Mark Coffee", street: "Church St", query: "coffee shop near The Truth Nashville", near: DOWNTOWN },
  { name: "Gulch Grind Coffee", street: "11th Ave S", query: "coffee shop near The Truth Nashville", near: GULCH },
  { name: "Midtown Mule Bar", street: "Division St", query: "americana bar Nashville", near: MIDTOWN },
  { name: "Bootstitch Saloon", street: "Broadway", query: "americana bar Nashville", near: DOWNTOWN },
];

const CONTROL_B: ControlSpec[] = [
  { name: "Neon Lights Karaoke Bar", street: "Broadway", query: "late night bar Nashville", near: DOWNTOWN },
  { name: "Gulch Rooftop Lounge", street: "12th Ave S", query: "late night bar Nashville", near: GULCH },
  { name: "Lower Broad Boot Hall", street: "Broadway", query: "late night bar Nashville", near: DOWNTOWN },
  { name: "Velvet Hour Cocktail Den", street: "Division St", query: "indie music bar Nashville", near: { lat: 36.152, lon: -86.7975 } },
  { name: "Demonbreun Dance Hall", street: "Demonbreun St", query: "indie music bar Nashville", near: GULCH },
  { name: "Pixel Palace Arcade Bar", street: "2nd Ave N", query: "indie music bar Nashville", near: DOWNTOWN },
  { name: "Midtown Mule Bar", street: "Division St", query: "indie music bar Nashville", near: MIDTOWN },
  { name: "Honeysuckle Hall Bar", street: "Demonbreun St", query: "late night bar Nashville", near: GULCH },
  { name: "Downtown Vinyl Depot", street: "5th Ave N", query: "record store Nashville", near: DOWNTOWN },
  { name: "Studio Row Records", street: "Music Square E", query: "record store Nashville", near: MIDTOWN },
  { name: "Static Bloom Records", street: "51st Ave N", query: "record store Nashville", near: { lat: 36.1645, lon: -86.8505 } },
  { name: "Satellite Record Shop", street: "Elliston Pl", query: "record store Nashville", near: { lat: 36.1515, lon: -86.799 } },
  { name: "Hatch Mark Coffee", street: "Church St", query: "coffee shop near The Truth Nashville", near: DOWNTOWN },
  { name: "Gulch Grind Coffee", street: "11th Ave S", query: "coffee shop near The Truth Nashville", near: GULCH },
  { name: "Midtown Taco Garage", street: "Broadway", query: "late night bar Nashville", near: MIDTOWN },
];

A.control.places = CONTROL_A;
B.control.places = CONTROL_B;

function buildVariant(v: Variant): SheetFixture {
  const r = rng(v.seed);
  const L = new RunLedger(v.createdAt, r);
  const venuePoint = `POINT(${TRUTH.lon} ${TRUTH.lat})`;
  const planId = `g1-${v.key}`;
  const tmEventId = `syn-tm-event-g1${v.key}`;
  const streetDay = "thursday" as const;
  const ctx: PlaceContext = { city: "Nashville", state: "TN", areaCode: "615", phoneCounter: { n: v.key === "a" ? 0 : 50 }, weekdayShort: WEEKDAY_SHORT[streetDay] };
  // Declared and pre/post places are the same businesses in both bills, so they share a phone block.
  const sharedCtx: PlaceContext = { ...ctx, phoneCounter: { n: 30 } };

  // --- Ticketmaster intake -------------------------------------------------
  const t1 = L.add("tm", "GET", "/discovery/v2/events.json", { id: tmEventId, apikey: "$TICKETMASTER_API_KEY" }, { resultCount: 1, note: "Bill, venue lat/lon, date and ageRestrictions.legalAgeEnforced." });
  L.add("tm", "GET", "/discovery/v2/events.json", { venueId: TRUTH.tmVenueId, size: 60, sort: "date,asc", apikey: "$TICKETMASTER_API_KEY" }, { resultCount: 60, cacheHit: true, note: "House roster: next 60 events at this venue (weekly cache)." });

  // --- Resolution ------------------------------------------------------------
  const actEntities: QlooEntity[] = v.acts.map((a) => artistEntity(a.act.name, a.popularity, a.tags));
  const q1 = L.add("qloo", "GET", "/entities", { "external.spotify.ids": actEntities.map((e) => String((e.external?.spotify as { id: string }).id)) }, { resultCount: 3, note: "Spotify ids from Ticketmaster attractions; exact matches only." });
  const q2 = L.add("qloo", "GET", "/search", { query: TRUTH.name, types: "urn:entity:place", "filter.location": `${TRUTH.lat},${TRUTH.lon}`, "filter.radius": 1 }, { resultCount: 0, envelope: "empty", note: `Venue not in catalog yet: using ${venuePoint} from Ticketmaster.` });
  const q3 = L.add("qloo", "GET", "/entities", { "external.spotify.ids": ["syn-house-01", "syn-house-02", "syn-house-03", "syn-house-04", "syn-house-05", "syn-house-06", "syn-house-07", "syn-house-08", "syn-house-09", "syn-house-10"] }, { resultCount: 10, cacheHit: true, note: "House set: roster headliners with Spotify ids (weekly cache)." });
  const q4 = L.add("qloo", "GET", "/search", { query: "syn-house-roster-act", types: ["urn:entity:artist", "urn:entity:person"], take: 5 }, { resultCount: 0, envelope: "empty", cacheHit: true, note: "2 roster acts had no Spotify id; typed search found no exact match. House set = 10 of 12." });
  const billIds = actEntities.map((e) => e.entityId);
  const houseIds = Array.from({ length: 10 }, (_, i) => synId("artist", `The Truth house act ${i + 1}`));

  // --- Heatmaps and lift ---------------------------------------------------
  const q5 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": billIds, "filter.location": venuePoint, "filter.location.radius": 40000 }, { resultCount: 2140, bytes: 318_400, note: "Bill heat; GET (POST weights not verified yet)." });
  const q6 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.entities": houseIds, "filter.location": venuePoint, "filter.location.radius": 40000 }, { resultCount: 2210, bytes: 327_900, cacheHit: true, note: "House heat (weekly cache per venue)." });
  const q7 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:heatmap", "signal.interests.tags": "urn:tag:category:place:restaurant", "filter.location": venuePoint, "filter.location.radius": 40000 }, { resultCount: 2380, bytes: 351_200, cacheHit: true, note: "Generic baseline: diagnostic only (lift vs raw heat)." });
  const tiles = makeTiles(v.tiles, r);
  const top = tiles.filter((t) => t.lift >= 1.3).slice(0, 5);
  const maxLift = top[0]?.lift ?? 1;

  // --- Demographics and compare -------------------------------------------
  const q8 = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:demographics", "signal.interests.entities": [...billIds, ...houseIds.slice(0, 3)] }, { resultCount: 6 });
  const q9 = L.add("qloo", "GET", "/v2/analysis/compare", { "a.signal.interests.entities": billIds, "b.signal.interests.entities": houseIds, take: 30 }, { resultCount: 30 });

  // --- Partner pools per top tile ------------------------------------------
  const seeds: Seed[] = [
    { entityId: billIds[0]!, weight: 1 },
    { entityId: billIds[1]!, weight: 0.6 },
    { entityId: billIds[2]!, weight: 0.3 },
  ];
  const categories = ["bar", "restaurant", "cafe", "record_store", "book_store", "barber_shop", "clothing_store"].map((c) => `urn:tag:category:place:${c}`);
  const partners: Partner[] = [];
  const poolRefs: string[] = [];
  top.slice(0, 3).forEach((tile, i) => {
    const ref = L.add(
      "qloo",
      "GET",
      "/v2/insights",
      {
        "filter.type": "urn:entity:place",
        "signal.interests.entities": billIds,
        "filter.location": `POINT(${tile.lon} ${tile.lat})`,
        "filter.location.radius": 2000,
        "filter.tags": categories,
        "operator.filter.tags": "union",
        "filter.hours": streetDay,
        "filter.price_level.max": 3,
        ...(v.legalAgeEnforced ? {} : { "filter.exclude.tags": "urn:tag:category:place:night_club" }),
        "feature.explainability": true,
        take: 50,
      },
      { resultCount: 50, note: `Partner pool for tile ${tile.name ?? tile.geohash}; diversity caps applied after scoring.` },
    );
    poolRefs.push(ref);
    partners.push(...makePartners(tile, maxLift, v.partners[i] ?? [], ctx, r, { pool: ref, billHeat: q5 }, seeds));
  });
  partners.sort((a, b) => b.score - a.score || (a.entity.distanceM ?? 0) - (b.entity.distanceM ?? 0));

  // --- Pre/post near the venue --------------------------------------------
  const qPre = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:place", "signal.interests.entities": billIds, "filter.location": venuePoint, "filter.location.radius": 1500, "filter.tags": ["urn:tag:category:place:restaurant", "urn:tag:category:place:bar", "urn:tag:category:place:cafe"], "operator.filter.tags": "union", "filter.hours": v.weekday, "feature.explainability": true, take: 30 }, { resultCount: 30 });
  const qTwin = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:place", "signal.interests.entities": houseIds, "filter.location": venuePoint, "filter.location.radius": 1500, "filter.tags": ["urn:tag:category:place:restaurant", "urn:tag:category:place:bar", "urn:tag:category:place:cafe"], "operator.filter.tags": "union", "filter.hours": v.weekday, take: 30 }, { resultCount: 30, cacheHit: true, note: "House-signal twin for the delta rank (weekly cache)." });
  const spots = makeSpots(TRUTH, v.spots, { ...sharedCtx, phoneCounter: { n: 70 }, weekdayShort: WEEKDAY_SHORT[v.weekday] }, r, { pool: qPre, twin: qTwin }, seeds, v.legalAgeEnforced);

  // --- Declared list ---------------------------------------------------------
  const declaredSpecs = DECLARED.map((d) => (d.place ? { ...d, place: { ...d.place, rank: v.declaredRanks[d.label] ?? d.place.rank } } : d));
  const scoredIds = declaredSpecs.filter((d) => d.place).length;
  const qDecl = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:place", "filter.results.entities": declaredSpecs.filter((d) => d.place).map((d) => synId("place", `${d.label}|Nashville`)), "signal.interests.entities": billIds }, { resultCount: scoredIds, note: "6 of 8 declared partners were picked from a /search pick list; 2 are not in the catalog." });
  const declared = makeDeclared(declaredSpecs, TRUTH, sharedCtx, r, qDecl, seeds);

  // --- Media and sponsor ----------------------------------------------------
  const qPod = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:podcast", "signal.interests.entities": billIds, "signal.location": venuePoint, "feature.explainability": true, take: 15 }, { resultCount: 15, note: "signal.location probe pending: labelled national." });
  const qBrand = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": billIds, "signal.location": venuePoint, ...(v.legalAgeEnforced ? {} : { "filter.exclude.tags": ["urn:tag:category:brand:alcohol", "urn:tag:category:brand:tobacco", "urn:tag:category:brand:gambling"] }), "feature.explainability": true, take: 15 }, { resultCount: 15 });
  const podcasts = makeMedia(v.media.filter((m) => m.kind === "podcast"), r, qPod, seeds, "labelled national until the local probe runs");
  const sponsor = makeMedia(v.media.filter((m) => m.kind === "sponsor"), r, qBrand, seeds, "labelled national until the local probe runs");

  // --- Copy allowlist --------------------------------------------------------
  const qTags = L.add("qloo", "GET", "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": billIds, "filter.tag.types": ["urn:tag:keyword:media", "urn:tag:genre:music", "urn:tag:theme:qloo", "urn:tag:audience:qloo"], "diversify.by": "subtype", take: 30 }, { resultCount: 30, note: `Denylist applied first; ${v.allowTags.length} tags survived to the copy allowlist.` });

  // --- ACS, control arm, narration -------------------------------------------
  const zctas = [...new Set(top.flatMap((t) => t.zctas ?? []))];
  const c1 = L.add("acs", "GET", ACS_ENDPOINT, acsParams(zctas), { resultCount: zctas.length, curl: acsCurl(zctas), note: ACS_NOTE });
  const placeRefs = v.control.queries.map((q) => L.add("places", "POST", "/v1/places:searchText", { textQuery: q, "locationBias.radiusM": 40000, pageSize: 20 }, { resultCount: 20, curl: placesCurl(q, TRUTH.lat, TRUTH.lon, 40000), note: "Arm F: query chosen by the model." }));
  const lControl = L.add("anthropic", "POST", "/v1/messages", { model: "claude-opus-5-5", "output_config.effort": "medium", tools: ["places_search", "acs_lookup"], max_tokens: 16000 }, { resultCount: 1, latencyMs: 14200, bytes: 18_400, curl: anthropicCurl(), note: "Arm F: same model, same schema, Google Places + ACS tools." });
  const lNarr = L.add("anthropic", "POST", "/v1/messages", { model: "claude-opus-5-5", "output_config.effort": "low", "output_config.format": "json_schema:street_sheet_narration", max_tokens: 4000 }, { resultCount: 1, latencyMs: 6100, bytes: 7_900, curl: anthropicCurl(), note: "Narration may cite only ids and numbers from this run; guard dropped 0." });

  const bill: Bill = {
    acts: v.acts.map((a) => a.act),
    venue: { ...TRUTH },
    date: v.date,
    weekday: v.weekday,
    legalAgeEnforced: v.legalAgeEnforced,
    classification: v.classification,
    tmEventId,
    tmUrl: `https://www.ticketmaster.com/event/${tmEventId}`,
  };
  const operator: OperatorInputs = {
    seatsLeft: null,
    capacity: 4400,
    mediaBudgetUsd: 6000,
    streetTeamDays: ["thursday", "saturday"],
    radiusKm: 40,
    declaredPartners: declared.inputs,
  };

  const resolutionRows = [
    ...v.acts.map((a, i) => ({ input: a.act.name, role: a.act.role, status: "exact" as const, entity: actEntities[i]!, ledgerRef: q1 })),
    { input: TRUTH.name, role: "venue" as const, status: "unresolved" as const, ledgerRef: q2 },
    { input: "House roster (next 60 Ticketmaster events)", role: "house" as const, status: "exact" as const, ledgerRef: q3 },
  ];

  const sheet: StreetSheet = {
    planId,
    createdAt: v.createdAt,
    mode: "fixture",
    hypothetical: true,
    bill,
    operator,
    cards: {
      resolution: envelope("ok", "3 of 3 acts resolved exactly. Venue not in the catalog yet, so the run uses the Ticketmaster point. House set: 10 of 12 roster headliners.", resolutionRows, [t1, q1, q2, q3, q4], ["Resolution is by exact match on external ids or names; nothing was guessed."]),
      liftMap: envelope(
        "ok",
        `${top.length} tiles with lift of 1.3 or more against the house crowd; top tile ${top[0]?.name} at ${top[0]?.lift.toFixed(2)}.`,
        { tiles, diagnostics: { spearmanLiftVsHeat: v.spearman, baseline: "house" as const } },
        [q5, q6, q7, c1],
        ["Lift compares percentile ranks inside two responses; it is not a count of fans.", "Tile names come from the gazetteer, not from Qloo."],
      ),
      partners: envelope("ok", `${partners.length} partners across the top 3 tiles, at most 2 per category per tile.`, partners, poolRefs, ["Suggested, not affiliated: no partner has agreed to anything.", "Hours are for the street-team day and should be confirmed by phone."]),
      declared: envelope("ok", `${scoredIds} of ${DECLARED.length} of your partners ranked for this bill; ${DECLARED.length - scoredIds} are not in Qloo's catalog, kept in your order.`, declared.scores, [qDecl]),
      prePost: envelope(
        "ok",
        `${spots.length} spots within 1.5 km open on show night, load-balanced against assumed capacities.${v.legalAgeEnforced ? "" : " All-ages show: bars are operator-only partners."}`,
        spots,
        [qPre, qTwin, t1],
        ["Assumed capacities are guesses the operator can edit.", "Alcohol rules come from the Ticketmaster age policy, never from Qloo."],
      ),
      media: envelope("ok", "4 podcasts and 1 sponsor brand. Local ranking not checked yet, so all are national.", [...podcasts, ...sponsor], [qPod, qBrand], ["Podcast reach and sponsor fit are not measured here."]),
      demographics: envelope(
        "ok",
        "Age and gender skew for each act and the house set.",
        {
          bill: actEntities.map((e, i) => ({ entityId: e.entityId, age: v.demo.bill[i] ?? {}, gender: { male: round(0.02 * (i + 1) * (v.key === "a" ? 1 : -1), 2), female: round(-0.02 * (i + 1) * (v.key === "a" ? 1 : -1), 2) } })),
          house: [{ entityId: houseIds[0]!, age: v.demo.house, gender: { male: 0.01, female: -0.01 } }],
        },
        [q8],
        ["Skews describe aggregate audiences, never individuals.", "Not used for radio format, alcohol or community inference."],
      ),
      whatsDifferent: envelope(
        "ok",
        "Tags distinctive to this bill versus the house crowd.",
        {
          shared: [
            { ...tag("urn:tag:amenity:place:live_music", "Live music"), score: 0.4 },
            { ...tag("urn:tag:keyword:media:concerts", "Concerts"), score: 0.36 },
          ],
          a: v.compare.a.map(([id, name, score]) => ({ ...tag(id, name), score })),
          b: v.compare.b.map(([id, name, score]) => ({ ...tag(id, name), score })),
          fromTagDiff: false,
        },
        [q9],
      ),
      copyHooks: envelope("ok", "3 hooks built only from allowlisted tag words.", v.hooks, [qTags], ["No jokes, no artist voice, no artist marks in partner copy."]),
    },
    narration: v.narration(top, partners),
    ledger: [],
    guard: { dropped: 0, reasons: [], deniedTagCount: 0 },
    budgetSplit: makeBudget(top),
    limits: [...SHEET_LIMITS, "Venue coordinates in this synthetic fixture are approximate; live runs take them from Ticketmaster."],
  };
  sheet.ledger = L.entries();
  void lNarr;

  return {
    synthetic: true,
    fixtureId: planId,
    title: `The Truth, Nashville: bill ${v.key.toUpperCase()}`,
    note: "Synthetic fixture. Acts, partner businesses, ids, scores and ledger timings are invented; neighbourhood names and ZIPs are real places used for layout only. Phone numbers use the reserved 555-01xx range and sites point at example.com.",
    pairedWith: v.key === "a" ? "g1-b" : "g1-a",
    sheet,
    control: makeControl(v.control.places, { city: "Nashville", state: "TN", key: planId }, r, v.control.overlap, [...placeRefs, lControl, c1]),
  };
}

export function buildG1A(): SheetFixture {
  return buildVariant(A);
}

export function buildG1B(): SheetFixture {
  return buildVariant(B);
}
