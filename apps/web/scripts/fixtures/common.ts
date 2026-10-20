/**
 * Builders for SYNTHETIC Street Sheet fixtures. Nothing here is a recorded
 * API response: every entity, id, number and business is invented so the web
 * shell can be designed and tested before any key exists. Output is
 * deterministic (seeded PRNG, fixed timestamps) so a test can check the JSON
 * on disk still matches this code.
 */
import { createMemoryLedger, LIMITS_EVERY_SHEET } from "@walkup/contracts";
import type {
  Chip,
  ControlArmResult,
  ControlPlace,
  DeclaredPartner,
  DeclaredPartnerScore,
  Envelope,
  EnvelopeStatus,
  ExplainContribution,
  LedgerEntry,
  LedgerKind,
  LiftTile,
  MediaPick,
  Partner,
  PrePostSpot,
  QlooEntity,
  QlooTag,
  Weekday,
} from "@walkup/contracts";
import { decodeCenter, encode } from "../../lib/geohash";

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit, as 8 hex chars. */
export function hashHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Synthetic entity id. The "syn-" prefix makes it obvious nothing here is a real Qloo id. */
export function synId(kind: string, name: string): string {
  return `syn-${kind}-${hashHex(`${kind}:${name}`)}`;
}

/** mulberry32 PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round = (n: number, dp = 3): number => Math.round(n * 10 ** dp) / 10 ** dp;

export function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Offset a point by metres north/east. */
export function offset(p: { lat: number; lon: number }, northM: number, eastM: number): { lat: number; lon: number } {
  const lat = p.lat + northM / 111320;
  const lon = p.lon + eastM / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: round(lat, 6), lon: round(lon, 6) };
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Tags (ids follow Qloo's urn:tag:<namespace>:<value> shape; pinned set is synthetic)
// ---------------------------------------------------------------------------

export function tag(id: string, name: string): QlooTag {
  const parts = id.split(":");
  return { id, name, type: parts.slice(0, -1).join(":") };
}

export type Category =
  | "bar"
  | "restaurant"
  | "cafe"
  | "record_store"
  | "book_store"
  | "barber_shop"
  | "beauty_salon"
  | "clothing_store";

export const CATEGORY_LABEL: Record<Category, string> = {
  bar: "Bar",
  restaurant: "Restaurant",
  cafe: "Cafe",
  record_store: "Record store",
  book_store: "Bookstore",
  barber_shop: "Barbershop",
  beauty_salon: "Salon",
  clothing_store: "Clothing",
};

export const CATEGORY_TAG: Record<Category, QlooTag> = {
  bar: tag("urn:tag:category:place:bar", "Bar"),
  restaurant: tag("urn:tag:category:place:restaurant", "Restaurant"),
  cafe: tag("urn:tag:category:place:cafe", "Cafe"),
  record_store: tag("urn:tag:category:place:record_store", "Record Store"),
  book_store: tag("urn:tag:category:place:book_store", "Book Store"),
  barber_shop: tag("urn:tag:category:place:barber_shop", "Barber Shop"),
  beauty_salon: tag("urn:tag:category:place:beauty_salon", "Beauty Salon"),
  clothing_store: tag("urn:tag:category:place:clothing_store", "Clothing Store"),
};

export const AMBIENCE: Record<string, QlooTag> = {
  groups: tag("urn:tag:good_for:place:groups", "Good for groups"),
  liveMusic: tag("urn:tag:amenity:place:live_music", "Live music"),
  casual: tag("urn:tag:ambience:place:casual", "Casual"),
  cozy: tag("urn:tag:ambience:place:cozy", "Cozy"),
  lateNight: tag("urn:tag:good_for:place:late_night", "Late night"),
  vinyl: tag("urn:tag:keyword:place:vinyl", "Vinyl"),
  dateNight: tag("urn:tag:good_for:place:date_night", "Date night"),
  walkIns: tag("urn:tag:amenity:place:walk_ins", "Walk-ins welcome"),
  patio: tag("urn:tag:amenity:place:outdoor_seating", "Outdoor seating"),
  localFavorite: tag("urn:tag:ambience:place:local_favorite", "Local favorite"),
};

const AMBIENCE_BY_CATEGORY: Record<Category, string[]> = {
  bar: ["liveMusic", "lateNight", "groups"],
  restaurant: ["groups", "casual", "localFavorite"],
  cafe: ["cozy", "walkIns", "casual"],
  record_store: ["vinyl", "localFavorite", "walkIns"],
  book_store: ["cozy", "walkIns", "localFavorite"],
  barber_shop: ["walkIns", "localFavorite", "casual"],
  beauty_salon: ["localFavorite", "walkIns", "casual"],
  clothing_store: ["localFavorite", "casual", "walkIns"],
};

// ---------------------------------------------------------------------------
// Ledger with copy-as-curl (secrets are env-var references only)
// ---------------------------------------------------------------------------

type ParamValue = string | number | boolean | string[] | null;
export type Params = Record<string, ParamValue>;

function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

function paramText(v: ParamValue): string {
  return Array.isArray(v) ? v.join(",") : String(v);
}

export function qlooCurl(method: "GET" | "POST", endpoint: string, params: Params): string {
  const url = `https://hackathon.api.qloo.com${endpoint}`;
  if (method === "POST") {
    return `curl -s -X POST ${sq(url)} -H "X-Api-Key: $QLOO_API_KEY" -H 'Content-Type: application/json' -d ${sq(JSON.stringify(params))}`;
  }
  const args = Object.entries(params)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => ` --data-urlencode ${sq(`${k}=${paramText(v)}`)}`)
    .join("");
  return `curl -sG ${sq(url)} -H "X-Api-Key: $QLOO_API_KEY"${args}`;
}

export function tmCurl(endpoint: string, params: Params): string {
  const args = Object.entries(params)
    .filter(([k, v]) => v !== null && k !== "apikey")
    .map(([k, v]) => ` --data-urlencode ${sq(`${k}=${paramText(v)}`)}`)
    .join("");
  return `curl -sG ${sq(`https://app.ticketmaster.com${endpoint}`)} --data-urlencode "apikey=$TICKETMASTER_API_KEY"${args}`;
}

export function placesCurl(textQuery: string, lat: number, lon: number, radiusM: number): string {
  const body = JSON.stringify({
    textQuery,
    locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: radiusM } },
    pageSize: 20,
  });
  return (
    `curl -s -X POST 'https://places.googleapis.com/v1/places:searchText' -H "X-Goog-Api-Key: $GOOGLE_PLACES_API_KEY"` +
    ` -H 'X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.businessStatus,places.location,places.regularOpeningHours'` +
    ` -H 'Content-Type: application/json' -d ${sq(body)}`
  );
}

/**
 * The ACS request packages/acs makes (2024 5-year; same 17 variables): adults 21+
 * are B01001_001E minus the twelve under-21 bins, so the bins must be requested too.
 * Mirrored here because apps/web may import only @walkup/contracts.
 */
export const ACS_ENDPOINT = "/data/2024/acs/acs5";
export const ACS_GET_VARIABLES: string[] = [
  "NAME",
  "B01003_001E",
  "B01002_001E",
  "B19013_001E",
  "B01001_001E",
  "B01001_003E",
  "B01001_004E",
  "B01001_005E",
  "B01001_006E",
  "B01001_007E",
  "B01001_008E",
  "B01001_027E",
  "B01001_028E",
  "B01001_029E",
  "B01001_030E",
  "B01001_031E",
  "B01001_032E",
];

export function acsParams(zctas: string[]): Params {
  return { get: ACS_GET_VARIABLES, for: `zip code tabulation area:${zctas.join(",")}`, key: "$CENSUS_API_KEY" };
}

export function acsCurl(zctas: string[]): string {
  return (
    `curl -sG ${sq(`https://api.census.gov${ACS_ENDPOINT}`)} --data-urlencode ${sq(`get=${ACS_GET_VARIABLES.join(",")}`)}` +
    ` --data-urlencode ${sq(`for=zip code tabulation area:${zctas.join(",")}`)} --data-urlencode "key=$CENSUS_API_KEY"`
  );
}

export const ACS_NOTE = "Adults 21+ per ZCTA (B01001 total minus the under-21 bins) for the budget heuristic and the tile floor.";

export function anthropicCurl(): string {
  return `curl -s 'https://api.anthropic.com/v1/messages' -H "x-api-key: $ANTHROPIC_API_KEY" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' -d @request.json`;
}

export interface CallOpts {
  httpStatus?: number | null;
  envelope?: EnvelopeStatus;
  latencyMs?: number;
  bytes?: number;
  cacheHit?: boolean;
  resultCount: number;
  note?: string;
  curl?: string;
}

export class RunLedger {
  private sink = createMemoryLedger();
  private clock: number;
  constructor(
    startIso: string,
    private r: () => number,
  ) {
    this.clock = Date.parse(startIso);
  }

  add(kind: LedgerKind, method: LedgerEntry["method"], endpoint: string, params: Params, opts: CallOpts): string {
    const cacheHit = opts.cacheHit ?? false;
    const latencyMs = opts.latencyMs ?? (cacheHit ? 2 + Math.floor(this.r() * 9) : 180 + Math.floor(this.r() * 900));
    const startedAt = new Date(this.clock).toISOString();
    this.clock += latencyMs + 40 + Math.floor(this.r() * 260);
    let curl = opts.curl ?? "";
    if (!opts.curl && kind === "qloo" && method !== "ACTION") curl = qlooCurl(method, endpoint, params);
    if (!opts.curl && kind === "tm") curl = tmCurl(endpoint, params);
    const entry: Omit<LedgerEntry, "id"> = {
      kind,
      method,
      endpoint,
      params,
      httpStatus: opts.httpStatus === undefined ? 200 : opts.httpStatus,
      envelopeStatus: opts.envelope ?? (opts.resultCount > 0 ? "ok" : "empty"),
      latencyMs,
      bytes: opts.bytes ?? 1200 + opts.resultCount * (900 + Math.floor(this.r() * 700)),
      cacheHit,
      resultCount: opts.resultCount,
      curl,
      startedAt,
      ...(opts.note ? { note: opts.note } : {}),
    };
    return this.sink.add(entry);
  }

  entries(): LedgerEntry[] {
    return this.sink.entries();
  }
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export function envelope<T>(
  status: EnvelopeStatus,
  summary: string,
  results: T,
  provenance: string[],
  limits: string[] = [],
  reason?: string,
): Envelope<T> {
  return { status, summary, results, ...(reason ? { reason } : {}), provenance, limits };
}

export interface TileSpec {
  name: string;
  lat: number;
  lon: number;
  lift: number;
  zctas: string[];
  adults: number;
}

/** Snap each named point to its geohash-6 cell and derive consistent percentiles from lift. */
export function makeTiles(specs: TileSpec[], r: () => number): LiftTile[] {
  return specs
    .map((s) => {
      const geohash = encode(s.lat, s.lon, 6);
      const c = decodeCenter(geohash);
      const maxHouse = Math.min(0.85, 0.97 / s.lift);
      const housePct = round(0.15 + r() * (maxHouse - 0.15), 3);
      const billPct = round(housePct * s.lift, 3);
      return {
        geohash,
        lat: round(c.lat, 6),
        lon: round(c.lon, 6),
        lift: s.lift,
        billPct,
        housePct,
        popularityPct: round(0.35 + r() * 0.6, 3),
        name: s.name,
        zctas: s.zctas,
        adultPopulation: s.adults,
      } satisfies LiftTile;
    })
    .sort((a, b) => b.lift - a.lift);
}

export interface Seed {
  entityId: string;
  weight: number;
}

function explain(seeds: Seed[], r: () => number): ExplainContribution[] {
  const raw = seeds.map((s) => s.weight * (0.7 + r() * 0.6));
  const total = raw.reduce((a, b) => a + b, 0);
  return seeds
    .map((s, i) => ({ entityId: s.entityId, score: round((raw[i] ?? 0) / total, 2) }))
    .filter((x) => x.score >= 0.1)
    .sort((a, b) => b.score - a.score);
}

export interface PlaceSpec {
  name: string;
  category: Category;
  /** Street (real street names, no house numbers: the business is fictional). */
  street: string;
  extraTags?: string[];
  /** Fixed 555-01xx suffix, for businesses that appear in more than one fixture. */
  phoneSuffix?: number;
}

export interface PlaceContext {
  city: string;
  state: string;
  areaCode: string;
  /** Next free 555-01xx suffix (reserved fictional range). */
  phoneCounter: { n: number };
  weekdayShort: string;
}

function phone(ctx: PlaceContext, fixed?: number): string {
  const n = fixed ?? ctx.phoneCounter.n++;
  if (n > 99) throw new Error("ran out of 555-01xx numbers");
  return `(${ctx.areaCode}) 555-01${String(n).padStart(2, "0")}`;
}

function hours(category: Category, r: () => number): { open: string; close: string } {
  const base: Record<Category, [number, number]> = {
    bar: [16, 26],
    restaurant: [11, 22],
    cafe: [7, 17],
    record_store: [11, 20],
    book_store: [10, 20],
    barber_shop: [9, 19],
    beauty_salon: [9, 18],
    clothing_store: [10, 19],
  };
  const [o, c] = base[category];
  const open = o + (r() < 0.3 ? 1 : 0);
  const close = c - (r() < 0.3 ? 1 : 0);
  const fmt = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  return { open: fmt(open), close: fmt(close) };
}

export function makePlace(
  spec: PlaceSpec,
  at: { lat: number; lon: number },
  ctx: PlaceContext,
  r: () => number,
  opts: { affinity: number | null; popularity: number; seeds: Seed[]; from?: { lat: number; lon: number }; neighborhood?: string },
): QlooEntity & { hoursText: string; phone: string; website: string; address: string } {
  const h = hours(spec.category, r);
  const addr = `${spec.street}, ${ctx.city}, ${ctx.state}`;
  const ph = phone(ctx, spec.phoneSuffix);
  const web = `https://example.com/walkup-fixture/${slug(spec.name)}`;
  const tags = [CATEGORY_TAG[spec.category], ...AMBIENCE_BY_CATEGORY[spec.category].map((k) => AMBIENCE[k]!)];
  for (const t of spec.extraTags ?? []) {
    const known = AMBIENCE[t];
    if (known && !tags.includes(known)) tags.push(known);
  }
  const entity: QlooEntity = {
    entityId: synId("place", `${spec.name}|${ctx.city}`),
    name: spec.name,
    subtype: "urn:entity:place",
    popularity: round(opts.popularity, 3),
    affinity: opts.affinity === null ? null : round(opts.affinity, 3),
    tags,
    properties: {
      address: addr,
      phone: ph,
      website: web,
      price_level: 1 + Math.floor(r() * 3),
      is_closed: false,
      hours: { [ctx.weekdayShort]: `${h.open}-${h.close}` },
      ...(opts.neighborhood ? { neighborhood: opts.neighborhood } : {}),
      short_description: `Fictional ${CATEGORY_LABEL[spec.category].toLowerCase()} for the synthetic fixture.`,
    },
    location: { lat: at.lat, lon: at.lon, geohash: encode(at.lat, at.lon, 9) },
    distanceM: opts.from ? Math.round(haversineM(opts.from, at)) : null,
    explainability: opts.seeds.length > 0 ? explain(opts.seeds, r) : [],
  };
  return Object.assign(entity, { hoursText: `${ctx.weekdayShort} ${h.open}-${h.close}`, phone: ph, website: web, address: addr });
}

export interface TilePartnerSpec extends PlaceSpec {
  qlooRank: number;
}

/** Partner rows for one tile, scored the way the engine does: rank_score x tile_weight. */
export function makePartners(
  tile: LiftTile,
  maxLift: number,
  specs: TilePartnerSpec[],
  ctx: PlaceContext,
  r: () => number,
  refs: { pool: string; billHeat: string },
  seeds: Seed[],
  poolSize = 50,
): Partner[] {
  return specs.map((s) => {
    const at = offset({ lat: tile.lat, lon: tile.lon }, (r() - 0.5) * 1400, (r() - 0.5) * 1400);
    const place = makePlace(s, at, ctx, r, {
      affinity: 0.98 - s.qlooRank * 0.012 - r() * 0.01,
      popularity: 0.25 + r() * 0.6,
      seeds,
      from: { lat: tile.lat, lon: tile.lon },
      ...(tile.name ? { neighborhood: tile.name } : {}),
    });
    const { hoursText, phone: ph, website, address, ...entity } = place;
    const rankScore = 1 - (s.qlooRank - 1) / poolSize;
    const chips: Chip[] = [
      { label: "over-indexes for this bill", ledgerRef: refs.pool },
      { label: `in a ${tile.lift.toFixed(2)}x lift tile`, ledgerRef: refs.billHeat },
    ];
    return {
      entity,
      tileGeohash: tile.geohash,
      ...(tile.name ? { tileName: tile.name } : {}),
      category: s.category,
      score: round(rankScore * (tile.lift / maxLift), 3),
      qlooRank: s.qlooRank,
      hoursOnDay: hoursText,
      address,
      phone: ph,
      website,
      chips,
    } satisfies Partner;
  });
}

export interface SpotSpec extends PlaceSpec {
  northM: number;
  eastM: number;
  deltaRank: number | null;
  share: number;
  capacity: number;
}

export function makeSpots(
  venue: { lat: number; lon: number },
  specs: SpotSpec[],
  ctx: PlaceContext,
  r: () => number,
  refs: { pool: string; twin: string },
  seeds: Seed[],
  legalAgeEnforced: boolean | null,
): PrePostSpot[] {
  return specs.map((s, i) => {
    const at = offset(venue, s.northM, s.eastM);
    const place = makePlace(s, at, ctx, r, {
      affinity: 0.95 - i * 0.04,
      popularity: 0.4 + r() * 0.5,
      seeds,
      from: venue,
    });
    const { hoursText: _h, phone: _p, website: _w, address: _a, ...entity } = place;
    const chips: Chip[] = [{ label: "open on show night", ledgerRef: refs.pool }];
    if (s.deltaRank !== null) {
      const d = s.deltaRank;
      chips.push({ label: `tonight vs house ${d > 0 ? "+" : ""}${d} ranks`, ledgerRef: refs.twin });
    }
    return {
      entity,
      deltaRank: s.deltaRank,
      expectedShare: s.share,
      assumedCapacity: s.capacity,
      // Alcohol rules come from Ticketmaster ageRestrictions only; unknown counts as all-ages.
      fanFacingAllowed: s.category === "bar" ? legalAgeEnforced === true : true,
      chips,
    } satisfies PrePostSpot;
  });
}

export interface MediaSpec {
  name: string;
  kind: "podcast" | "sponsor";
  publisher: string;
}

export function makeMedia(specs: MediaSpec[], r: () => number, ref: string, seeds: Seed[], scopeNote: string): MediaPick[] {
  return specs.map((m, i) => ({
    entity: {
      entityId: synId(m.kind, m.name),
      name: m.name,
      subtype: m.kind === "podcast" ? "urn:entity:podcast" : "urn:entity:brand",
      popularity: round(0.3 + r() * 0.5, 3),
      affinity: round(0.92 - i * 0.07, 3),
      tags: [],
      properties: { publisher: m.publisher, short_description: `Fictional ${m.kind} for the synthetic fixture.` },
      explainability: explain(seeds, r),
    },
    kind: m.kind,
    scope: "national",
    chips: [{ label: m.kind === "podcast" ? `bill audience overlap, ${scopeNote}` : `brand affinity for this bill, ${scopeNote}`, ledgerRef: ref }],
  }));
}

export interface DeclaredSpec {
  label: string;
  /** Present when the operator picked it from a /search pick list and it is a place in the catalog. */
  place?: PlaceSpec & { northM: number; eastM: number; rank: number; city?: string };
}

export function makeDeclared(
  specs: DeclaredSpec[],
  anchor: { lat: number; lon: number },
  ctx: PlaceContext,
  r: () => number,
  ref: string | null,
  seeds: Seed[],
  /** Entities already on the sheet (e.g. a partner row), reused so ids and contact details match. */
  reuse: Map<string, QlooEntity> = new Map(),
): { inputs: DeclaredPartner[]; scores: DeclaredPartnerScore[] } {
  const inputs: DeclaredPartner[] = [];
  const scores: DeclaredPartnerScore[] = [];
  for (const d of specs) {
    if (d.place && ref) {
      let entity = reuse.get(d.place.name);
      if (!entity) {
        const at = offset(anchor, d.place.northM, d.place.eastM);
        const pctx = d.place.city ? { ...ctx, city: d.place.city } : ctx;
        const p = makePlace(d.place, at, pctx, r, { affinity: 0.9 - d.place.rank * 0.05, popularity: 0.3 + r() * 0.4, seeds });
        const { hoursText: _h, phone: _p, website: _w, address: _a, ...made } = p;
        entity = made;
      }
      inputs.push({ label: d.label, qlooEntityId: entity.entityId });
      scores.push({ declared: { label: d.label, qlooEntityId: entity.entityId }, rank: d.place.rank, entity, chips: [{ label: "ranked against this bill", ledgerRef: ref }] });
    } else {
      inputs.push({ label: d.label });
      scores.push({ declared: { label: d.label }, rank: null, chips: [] });
    }
  }
  scores.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return { inputs, scores };
}

export interface ControlSpec {
  name: string;
  street: string;
  query: string;
  near: { lat: number; lon: number };
}

export function makeControl(
  specs: ControlSpec[],
  ctx: { city: string; state: string; key: string },
  r: () => number,
  overlap: string[],
  ledgerRefs: string[],
): ControlArmResult {
  const places: ControlPlace[] = specs.map((s) => {
    const at = offset(s.near, (r() - 0.5) * 900, (r() - 0.5) * 900);
    return {
      placeId: `syn-gplace-${hashHex(`${ctx.key}:${s.name}`)}`,
      name: s.name,
      address: `${s.street}, ${ctx.city}, ${ctx.state}`,
      rating: round(3.9 + r() * 0.9, 1),
      userRatingCount: 80 + Math.floor(r() * 6000),
      businessStatus: "OPERATIONAL",
      location: at,
      query: s.query,
    };
  });
  return { arm: "F", places, overlapWithQloo: overlap, ledgerRefs };
}

/** Lift x adults, normalised, with a 10% floor per tile. Labelled heuristic. */
export function makeBudget(tiles: LiftTile[]): { geohash: string; share: number; label: "heuristic, not a forecast" }[] {
  const weights = tiles.map((t) => t.lift * (t.adultPopulation ?? 1000));
  const total = weights.reduce((a, b) => a + b, 0);
  const floor = 0.1;
  const free = 1 - floor * tiles.length;
  const shares = weights.map((w) => floor + free * (w / total));
  const rounded = shares.map((s) => round(s, 2));
  const drift = round(1 - rounded.reduce((a, b) => a + b, 0), 2);
  if (rounded.length > 0) rounded[0] = round((rounded[0] ?? 0) + drift, 2);
  return tiles.map((t, i) => ({ geohash: t.geohash, share: rounded[i] ?? 0, label: "heuristic, not a forecast" as const }));
}

export const SHEET_LIMITS: string[] = [...LIMITS_EVERY_SHEET];

export const WEEKDAY_SHORT: Record<Weekday, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

export function artistEntity(name: string, popularity: number, tags: QlooTag[], subtype = "urn:entity:artist"): QlooEntity {
  return {
    entityId: synId(subtype.split(":").pop() ?? "entity", name),
    name,
    subtype,
    popularity,
    affinity: null,
    tags,
    properties: { short_description: "Fictional act for the synthetic fixture." },
    external: { spotify: { id: `syn${hashHex(name)}` } },
  };
}
