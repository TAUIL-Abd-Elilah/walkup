/**
 * Synthetic Street Sheets for the exports tests. Every act, venue, business,
 * id and number here is invented; nothing comes from any API.
 */
import type {
  Chip,
  DeclaredPartnerScore,
  Envelope,
  LedgerEntry,
  LiftTile,
  MediaPick,
  Partner,
  PrePostSpot,
  QlooEntity,
  QlooTag,
  StreetSheet,
} from "@walkup/contracts";
import { LIMITS_EVERY_SHEET } from "@walkup/contracts";
import { toGeohash6 } from "@walkup/engine";

export const VENUE = { name: "Example Hall", lat: 36.16, lon: -86.78, city: "Nashville", state: "TN", country: "US" };
export const ACTS = ["Juniper Wire", "The Lantern Choir", "Mesa Static"] as const;

function env<T>(results: T, provenance: string[] = [], extra: Partial<Envelope<T>> = {}): Envelope<T> {
  return { status: "ok", summary: "synthetic", results, provenance, limits: [], ...extra };
}

function gh(lat: number, lon: number): string {
  const g = toGeohash6({ lat, lon });
  if (!g) throw new Error("bad test coordinate");
  return g;
}

export function tile(lat: number, lon: number, lift: number, extra: Partial<LiftTile> = {}): LiftTile {
  return { geohash: gh(lat, lon), lat, lon, lift, billPct: 0.7, housePct: 0.4, popularityPct: 0.6, ...extra };
}

export const TILES: LiftTile[] = [
  tile(36.175, -86.75, 2.1, { name: "East Bank", zctas: ["37206"], billPct: 0.88, housePct: 0.41, adultPopulation: 6100 }),
  tile(36.14, -86.8, 1.8, { name: "Edgehill", zctas: ["37203", "37212"], billPct: 0.8, housePct: 0.44, adultPopulation: 5200 }),
  tile(36.19, -86.81, 1.6, { name: "Germantown North", zctas: ["37208", "37228"], billPct: 0.74, housePct: 0.46, adultPopulation: 4100 }),
  tile(36.12, -86.74, 1.45, { name: "Woodbine", zctas: [], billPct: 0.7, housePct: 0.48 }),
  tile(36.21, -86.72, 1.32, { name: "Inglewood", zctas: ["02134", "ABCDE", "1234"], billPct: 0.66, housePct: 0.5 }),
  tile(36.1, -86.85, 1.1, { name: "Sylvan Heights", zctas: ["37209"] }),
  tile(36.23, -86.9, 1.0, { name: "Bordeaux Hills", zctas: ["37218"] }),
  tile(36.05, -86.7, 0.8, { name: "Far South", zctas: ["37211"] }),
];

export function tag(id: string, name: string): QlooTag {
  return { id, name, type: id.split(":").slice(0, 4).join(":") };
}

export function place(id: string, name: string, extra: Partial<QlooEntity> = {}): QlooEntity {
  return {
    entityId: id,
    name,
    subtype: "urn:entity:place",
    popularity: 0.6,
    affinity: 0.9,
    tags: [tag("urn:tag:category:place:restaurant", "Restaurant")],
    properties: {},
    ...extra,
  };
}

function chips(...pairs: [string, string][]): Chip[] {
  return pairs.map(([label, ledgerRef]) => ({ label, ledgerRef }));
}

export function partner(i: number, name: string, tileIndex: number | null, extra: Partial<Partner> = {}): Partner {
  const t = tileIndex === null ? undefined : TILES[tileIndex];
  return {
    entity: place(`syn-place-${i}`, name),
    tileGeohash: t ? t.geohash : null,
    tileName: t?.name,
    category: "record_store",
    score: 1 - i * 0.05,
    qlooRank: i,
    hoursOnDay: "Thu 10:00-19:00",
    address: `${100 + i} Example St, Nashville, TN`,
    phone: `(615) 555-01${String(i).padStart(2, "0")}`,
    website: `https://example.com/test/${i}`,
    chips: chips(["over-indexes for this bill", `Q${3 + (tileIndex ?? 0)}`], [`in a ${t ? t.lift.toFixed(2) : "1.00"}x lift tile`, "Q2"]),
    ...extra,
  };
}

export const PARTNERS: Partner[] = [
  partner(1, "Low Hum Records", 0),
  partner(2, 'Spins, "Wax" & Co.', 0, { category: "record_store" }),
  partner(3, "Corner Fade Barbers", 1, { category: "barber_shop" }),
  partner(4, "Paper Lantern Books", 1, { category: "book_store" }),
  partner(5, "Night Owl Taproom", 2, { category: "bar" }),
  partner(6, "Field Day Cafe", 3, { category: "cafe", website: null, phone: null }),
];

export const DECLARED: DeclaredPartnerScore[] = [
  { declared: { label: "Riverside Neighbours Association", qlooEntityId: "syn-place-90" }, rank: 2, entity: place("syn-place-90", "Riverside Neighbours Association"), chips: chips(["ranked against this bill", "Q11"]) },
  { declared: { label: "Alumni chapter (operator contact)", contactEmail: "lead@example.com" }, rank: null, chips: [] },
  { declared: { label: "Hilltop Record Club", qlooEntityId: "syn-place-91" }, rank: 1, entity: place("syn-place-91", "Hilltop Record Club"), chips: chips(["ranked against this bill", "Q11"]) },
];

export const SPOTS: PrePostSpot[] = [
  { entity: place("syn-place-50", "Front Step Diner", { distanceM: 240 }), deltaRank: 4, expectedShare: 0.031, assumedCapacity: 80, fanFacingAllowed: true, category: "restaurant", chips: chips(["open on show night", "Q9"], ["tonight vs house +4 ranks", "Q10"]) },
  { entity: place("syn-place-51", "The Ninth Bar", { distanceM: 410 }), deltaRank: 2, expectedShare: 0.02, assumedCapacity: 120, fanFacingAllowed: false, category: "bar", chips: chips(["open on show night", "Q9"]) },
  { entity: place("syn-place-52", "Morning Shift Coffee", { distanceM: 1200 }), deltaRank: null, expectedShare: 0.012, assumedCapacity: 40, fanFacingAllowed: true, category: "cafe", chips: chips(["open on show night", "Q9"]) },
];

export const MEDIA: MediaPick[] = [
  { entity: place("syn-pod-1", "Long Drive Radio Hour", { subtype: "urn:entity:podcast" }), kind: "podcast", scope: "national", chips: chips(["bill audience overlap", "Q12"]) },
  { entity: place("syn-pod-2", "Tuesday Tape Club", { subtype: "urn:entity:podcast" }), kind: "podcast", scope: "local", chips: chips(["bill audience overlap", "Q12"]) },
  { entity: place("syn-brand-1", "Cumberland Lemonade Co.", { subtype: "urn:entity:brand" }), kind: "sponsor", scope: "national", chips: chips(["brand affinity for this bill", "Q12"]) },
];

export function ledgerEntry(id: string, kind: LedgerEntry["kind"], extra: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id,
    kind,
    method: kind === "action" ? "ACTION" : "GET",
    endpoint: kind === "qloo" ? "/v2/insights" : kind === "tm" ? "/discovery/v2/events.json" : "/v1/places:searchText",
    params: kind === "qloo" ? { "filter.type": "urn:entity:place" } : kind === "tm" ? { apikey: "$TICKETMASTER_API_KEY", id: "syn-tm-1" } : {},
    httpStatus: 200,
    envelopeStatus: "ok",
    latencyMs: 120,
    bytes: 2048,
    cacheHit: false,
    resultCount: 10,
    curl: kind === "qloo" ? "curl -sG 'https://hackathon.api.qloo.com/v2/insights' -H \"X-Api-Key: $QLOO_API_KEY\"" : "",
    startedAt: "2026-10-09T15:00:00.000Z",
    ...extra,
  };
}

export const LEDGER: LedgerEntry[] = [
  ...Array.from({ length: 12 }, (_, i) => ledgerEntry(`Q${i + 1}`, "qloo")),
  ledgerEntry("T1", "tm"),
  ledgerEntry("T2", "tm"),
  ledgerEntry("P1", "places"),
  ledgerEntry("L1", "anthropic"),
];

export function makeSheet(over: Partial<StreetSheet> = {}): StreetSheet {
  const base: StreetSheet = {
    planId: "test-plan-1",
    createdAt: "2026-10-09T15:00:00.000Z",
    mode: "live",
    hypothetical: false,
    bill: {
      acts: [
        { name: ACTS[0], role: "headliner" },
        { name: ACTS[1], role: "co" },
        { name: ACTS[2], role: "support" },
      ],
      venue: { ...VENUE },
      date: "2026-11-20",
      weekday: "friday",
      legalAgeEnforced: false,
      tmEventId: "syn-tm-1",
      tmUrl: "https://example.com/event/syn-tm-1",
    },
    operator: {
      seatsLeft: 640,
      capacity: 1200,
      mediaBudgetUsd: 2500,
      streetTeamDays: ["thursday", "saturday"],
      radiusKm: 40,
      declaredPartners: DECLARED.map((d) => d.declared),
    },
    cards: {
      resolution: env([]),
      liftMap: env({ tiles: TILES, diagnostics: { spearmanLiftVsHeat: 0.42, baseline: "house" as const } }, ["Q1", "Q2"]),
      partners: env(PARTNERS, ["Q3", "Q4", "Q5", "Q6"]),
      declared: env(DECLARED, ["Q11"]),
      prePost: env(SPOTS, ["Q9", "Q10"]),
      media: env(MEDIA, ["Q12"]),
      demographics: env({ bill: [], house: [] }),
      whatsDifferent: env({ shared: [], a: [tag("urn:tag:genre:music:americana", "Americana")], b: [], fromTagDiff: false }, ["Q8"]),
      copyHooks: env(
        [
          { text: "Americana and string bands, one night.", tagIds: ["urn:tag:genre:music:americana"] },
          { text: "Record-store regulars, this one is yours.", tagIds: ["urn:tag:category:place:record_store"] },
          { text: "Cold beer and banjo.", tagIds: ["urn:tag:genre:music:bluegrass"] },
          { text: "Walk-ins welcome at our partners.", tagIds: ["urn:tag:amenity:place:walk_ins"] },
        ],
        ["Q8"],
      ),
    },
    narration: {
      summary: "synthetic",
      tileWhy: [{ geohash: TILES[0]!.geohash, text: "Lift 2.10: bill percentile 0.88 against a house percentile of 0.41." }],
      partnerLines: [],
      templated: true,
    },
    ledger: LEDGER,
    guard: { dropped: 0, reasons: [], deniedTagCount: 0 },
    budgetSplit: [
      { geohash: TILES[0]!.geohash, share: 0.3, label: "heuristic, not a forecast" },
      { geohash: TILES[1]!.geohash, share: 0.25, label: "heuristic, not a forecast" },
      { geohash: TILES[2]!.geohash, share: 0.2, label: "heuristic, not a forecast" },
      { geohash: TILES[3]!.geohash, share: 0.15, label: "heuristic, not a forecast" },
      { geohash: TILES[4]!.geohash, share: 0.1, label: "heuristic, not a forecast" },
    ],
    limits: [...LIMITS_EVERY_SHEET, "Synthetic test sheet."],
  };
  return { ...base, ...over };
}

/** A sheet with every list at its cap and long names, to exercise the one-page fit. */
export function makeBusySheet(): StreetSheet {
  const s = makeSheet({ hypothetical: true, mode: "fixture" });
  const partners: Partner[] = Array.from({ length: 25 }, (_, i) =>
    partner(i + 1, `Very Long Neighbourhood Business Name Number ${i + 1} and Sons`, i % 5, {
      address: `${1000 + i} Extremely Long Boulevard Name Northeast, Suite ${i}, Nashville, TN`,
    }),
  );
  const declared: DeclaredPartnerScore[] = Array.from({ length: 12 }, (_, i) => ({
    declared: { label: `Declared community partner with a long name ${i + 1}` },
    rank: i < 6 ? i + 1 : null,
    chips: i < 6 ? [{ label: "ranked against this bill", ledgerRef: "Q11" }] : [],
  }));
  const spots: PrePostSpot[] = Array.from({ length: 8 }, (_, i) => ({ ...SPOTS[i % 3]!, entity: place(`syn-spot-${i}`, `Spot number ${i + 1} near the hall`, { distanceM: 200 + i * 100 }) }));
  return {
    ...s,
    cards: {
      ...s.cards,
      partners: { ...s.cards.partners, results: partners },
      declared: { ...s.cards.declared, results: declared },
      prePost: { ...s.cards.prePost, results: spots },
    },
  };
}

/**
 * The same sheet with the wave-3 extras: explain parts on every partner and a discovery line. Every tag, line and
 * number here is invented for the tests.
 */
export function makeExplainedSheet(over: Partial<StreetSheet> = {}): StreetSheet {
  const s = makeSheet(over);
  const partners: Partner[] = s.cards.partners.results.map((p, i) => ({
    ...p,
    explain: {
      tags: [
        { id: "urn:tag:category:place:record_store", name: "Record store" },
        { id: "urn:tag:genre:music:americana", name: "Americana" },
        { id: "urn:tag:style:place:vinyl", name: "Vinyl" },
      ],
      areaName: p.tileName,
      distanceKm: 3.1 + i,
      activation: i === 0 ? "Ask to leave flyers at the counter." : "Ask for a poster in the window.",
      confidence: i < 2 ? "high" : i < 4 ? "medium" : "low",
      confidenceWhy: `Rank ${i + 1} of 40 in a top area, open on the street-team day.`,
      limits: "Affinity is aggregate taste, not a visit count.",
      ledgerRefs: ["Q2", "Q7"],
    },
  }));
  return {
    ...s,
    cards: { ...s.cards, partners: { ...s.cards.partners, results: partners } },
    discovery: {
      kind: "partner",
      headline: "Paper Lantern Books, 4.2 km out in Edgehill",
      detail: "A bookstore this crowd ranks highly that the list without Qloo does not have.",
      rule: "The highest-ranked partner that is not a bar, more than 2 km from the venue and missing from the list without Qloo.",
      entityId: "syn-place-4",
      ledgerRefs: ["Q4", "P1"],
    },
  };
}
