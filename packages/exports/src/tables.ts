/**
 * The CSV exports: partners.csv (the call list), zips.csv and pins.csv (ad
 * targeting inputs derived from the top lift tiles), offer-codes.csv (codes to
 * create in the operator's own ticketing platform).
 *
 * Ad-targeting files carry no audience labels: a ZIP or a pin and a weight,
 * nothing about who lives there.
 */
import type { DeclaredPartnerScore, LiftTile, Partner, QlooEntity, StreetSheet } from "@walkup/contracts";
import { geohashPolygon, haversineM, isValidGeohash } from "@walkup/engine";
import { toCsv, type CsvCell, type CsvOptions } from "./csv";
import { categoryLabel, codeFragment, DECLARED_UNRANKED, FIXTURE_NOTICE, partnerWhyLong, round, SAMPLE_PREFIX, tileLabel, topTiles, ymdOf, type TileSelectOptions } from "./format";

// ---------------------------------------------------------------------------
// partners.csv
// ---------------------------------------------------------------------------

export const PARTNERS_CSV_COLUMNS = [
  "call_order",
  "list",
  "name",
  "category",
  "tile",
  "tile_lift",
  "address",
  "hours_on_day",
  "phone",
  "website",
  "contact_email",
  "activation",
  "why",
  "confidence",
  "affiliation",
  "receipts",
  "chips",
  "qloo_entity_id",
  "qloo_rank",
  "score",
  "called",
  "outcome",
  "notes",
] as const;

export interface PartnersCsvOptions extends CsvOptions {
  /** Append the operator's declared list after the suggested partners. Default true. */
  includeDeclared?: boolean;
}

function prop(e: QlooEntity | undefined, key: string): string {
  const v = e?.properties?.[key];
  return typeof v === "string" ? v : "";
}

function chipsText(chips: readonly { label: string; ledgerRef: string }[]): string {
  return chips.map((c) => `${c.label} [${c.ledgerRef}]`).join("; ");
}

function refsText(chips: readonly { ledgerRef: string }[]): string {
  return chips.map((c) => c.ledgerRef).join(" ");
}

/** Declared partners in call order: ranked first (rank ascending), then the ones not in Qloo's catalog, in the operator's order. */
export function declaredInCallOrder(declared: readonly DeclaredPartnerScore[]): DeclaredPartnerScore[] {
  return declared
    .map((d, i) => ({ d, i }))
    .sort((a, b) => {
      const ra = a.d.rank;
      const rb = b.d.rank;
      if (ra !== null && rb !== null) return ra - rb || a.i - b.i;
      if (ra !== null) return -1;
      if (rb !== null) return 1;
      return a.i - b.i;
    })
    .map((x) => x.d);
}

export function partnersCsvRows(sheet: StreetSheet, opts: PartnersCsvOptions = {}): CsvCell[][] {
  const tiles = new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  // A fixture call list says so in every row, not only in its file name.
  const fixtureNote = sheet.mode === "fixture" ? FIXTURE_NOTICE : "";
  const notes = (...parts: string[]): string => parts.filter((x) => x !== "").join("; ");
  const rows: CsvCell[][] = [];
  let order = 0;
  for (const p of sheet.cards.partners.results as Partner[]) {
    order += 1;
    const tile = p.tileGeohash ? tiles.get(p.tileGeohash) : undefined;
    rows.push([
      order,
      "suggested",
      p.entity.name,
      categoryLabel(p.category),
      p.tileName ?? (tile ? tileLabel(tile) : p.tileGeohash ?? ""),
      tile ? round(tile.lift, 2) : null,
      p.address ?? prop(p.entity, "address"),
      p.hoursOnDay ?? "",
      p.phone ?? prop(p.entity, "phone"),
      p.website ?? prop(p.entity, "website"),
      "",
      // The partner panel's parts, when the run built them: what to do there, why it is listed, how sure.
      p.explain?.activation ?? "",
      p.explain ? partnerWhyLong(p.explain) : "",
      p.explain?.confidence ?? "",
      "suggested, not affiliated",
      refsText(p.chips),
      chipsText(p.chips),
      p.entity.entityId,
      p.qlooRank,
      round(p.score, 3),
      "",
      "",
      fixtureNote,
    ]);
  }
  if (opts.includeDeclared ?? true) {
    for (const d of declaredInCallOrder(sheet.cards.declared.results)) {
      order += 1;
      rows.push([
        order,
        "your list",
        d.declared.label,
        "",
        "",
        null,
        prop(d.entity, "address"),
        "",
        prop(d.entity, "phone"),
        prop(d.entity, "website"),
        // Only ever an address the operator typed; never scraped.
        d.declared.contactEmail ?? "",
        "",
        "",
        "",
        "your list",
        refsText(d.chips),
        chipsText(d.chips),
        d.entity?.entityId ?? d.declared.qlooEntityId ?? "",
        d.rank,
        null,
        "",
        "",
        notes(d.rank === null ? DECLARED_UNRANKED : "", fixtureNote),
      ]);
    }
  }
  return rows;
}

/** partners.csv: the street team's call list (suggested partners, then the operator's own list). */
export function partnersCsv(sheet: StreetSheet, opts: PartnersCsvOptions = {}): string {
  return toCsv(PARTNERS_CSV_COLUMNS, partnersCsvRows(sheet, opts), opts);
}

// ---------------------------------------------------------------------------
// Tile weights shared by zips.csv and pins.csv
// ---------------------------------------------------------------------------

/**
 * Weight per selected tile, summing to 1: the sheet's budget split when it
 * covers every selected tile, otherwise proportional to lift. Same "heuristic,
 * not a forecast" status as the budget split.
 */
export function tileWeights(sheet: StreetSheet, tiles: readonly LiftTile[]): Map<string, number> {
  const out = new Map<string, number>();
  if (tiles.length === 0) return out;
  const split = new Map((sheet.budgetSplit ?? []).map((b) => [b.geohash, b.share]));
  const fromSplit = tiles.every((t) => {
    const s = split.get(t.geohash);
    return typeof s === "number" && Number.isFinite(s) && s >= 0;
  });
  const raw = tiles.map((t) => (fromSplit ? (split.get(t.geohash) as number) : Math.max(0, t.lift)));
  const total = raw.reduce((a, b) => a + b, 0);
  tiles.forEach((t, i) => out.set(t.geohash, total > 0 ? (raw[i] ?? 0) / total : 1 / tiles.length));
  return out;
}

/**
 * Integer apportionment of `weights` into `units` (largest remainder; ties go
 * to the earlier key), so rounded weights still sum to exactly 1.
 */
export function apportion(weights: readonly { key: string; w: number }[], units = 10_000): Map<string, number> {
  const total = weights.reduce((a, b) => a + Math.max(0, b.w), 0);
  const out = new Map<string, number>();
  if (total <= 0) return out;
  const exact = weights.map((x, i) => ({ key: x.key, i, v: (Math.max(0, x.w) / total) * units }));
  const floors = exact.map((x) => ({ ...x, f: Math.floor(x.v) }));
  let left = units - floors.reduce((a, b) => a + b.f, 0);
  const byRemainder = [...floors].sort((a, b) => b.v - b.f - (a.v - a.f) || a.i - b.i);
  const extra = new Set<number>();
  for (const x of byRemainder) {
    if (left <= 0) break;
    extra.add(x.i);
    left -= 1;
  }
  for (const x of floors) out.set(x.key, (x.f + (extra.has(x.i) ? 1 : 0)) / units);
  return out;
}

// ---------------------------------------------------------------------------
// zips.csv
// ---------------------------------------------------------------------------

export const ZIPS_CSV_COLUMNS = ["zip", "lift_score", "suggested_weight"] as const;

export interface ZipRow {
  zip: string;
  /** Highest lift among the tiles that contain this ZCTA, 2 decimals. */
  liftScore: number;
  /** Share of the tile weights, 4 decimals, summing to 1 across rows. */
  suggestedWeight: number;
  /** Geohashes of the selected tiles this ZCTA came from. */
  tiles: string[];
}

const ZIP_RE = /^\d{5}$/;

/**
 * One row per 5-digit ZCTA found in the selected tiles' `zctas`. A tile's
 * weight is split evenly across its ZCTAs; a ZCTA in several tiles sums its
 * shares and keeps the highest lift. Tiles without ZCTAs drop out and the rest
 * are renormalised.
 */
export function zipRows(sheet: StreetSheet, opts: TileSelectOptions = {}): ZipRow[] {
  const tiles = topTiles(sheet, opts);
  const weights = tileWeights(sheet, tiles);
  const acc = new Map<string, { w: number; lift: number; tiles: string[] }>();
  for (const t of tiles) {
    const zips = [...new Set((t.zctas ?? []).map((z) => String(z).trim()).filter((z) => ZIP_RE.test(z)))];
    if (zips.length === 0) continue;
    const share = (weights.get(t.geohash) ?? 0) / zips.length;
    for (const z of zips) {
      const cur = acc.get(z) ?? { w: 0, lift: Number.NEGATIVE_INFINITY, tiles: [] };
      cur.w += share;
      cur.lift = Math.max(cur.lift, t.lift);
      cur.tiles.push(t.geohash);
      acc.set(z, cur);
    }
  }
  const ordered = [...acc.entries()].sort((a, b) => b[1].w - a[1].w || b[1].lift - a[1].lift || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const rounded = apportion(ordered.map(([zip, v]) => ({ key: zip, w: v.w })));
  return ordered.map(([zip, v]) => ({ zip, liftScore: round(v.lift, 2), suggestedWeight: rounded.get(zip) ?? 0, tiles: v.tiles }));
}

/** zips.csv: zip, lift_score, suggested_weight. ZIPs are written as text so leading zeros survive. */
export function zipsCsv(sheet: StreetSheet, opts: TileSelectOptions & CsvOptions = {}): string {
  return toCsv(
    ZIPS_CSV_COLUMNS,
    zipRows(sheet, opts).map((r) => [r.zip, r.liftScore, r.suggestedWeight]),
    opts,
  );
}

// ---------------------------------------------------------------------------
// pins.csv
// ---------------------------------------------------------------------------

export const PINS_CSV_COLUMNS = ["lat", "lon", "radius_mi"] as const;
export const METERS_PER_MILE = 1609.344;

export interface PinRow {
  lat: number;
  lon: number;
  /** Never below 1 mile: smaller radii are commonly refused or barely deliver on ad platforms. */
  radiusMi: number;
  geohash: string;
  name: string;
}

export interface PinOptions extends TileSelectOptions {
  /** Minimum radius in miles; values below 1 are raised to 1. Default 1. */
  minRadiusMi?: number;
}

/** Half the diagonal of a geohash cell, in miles. */
export function geohashHalfDiagonalMi(geohash: string): number {
  if (!isValidGeohash(geohash)) return 0;
  const ring = geohashPolygon(geohash);
  const sw = ring[0];
  const ne = ring[2];
  if (!sw || !ne) return 0;
  return haversineM({ lat: sw[1], lon: sw[0] }, { lat: ne[1], lon: ne[0] }) / 2 / METERS_PER_MILE;
}

/** One pin per selected tile at the tile's centre, radius covering the cell and never under 1 mile. */
export function pinRows(sheet: StreetSheet, opts: PinOptions = {}): PinRow[] {
  const floor = Math.max(1, opts.minRadiusMi ?? 1);
  return topTiles(sheet, opts)
    .filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lon))
    .map((t) => ({
      lat: round(t.lat, 5),
      lon: round(t.lon, 5),
      radiusMi: Math.max(floor, Math.ceil(geohashHalfDiagonalMi(t.geohash) * 10) / 10),
      geohash: t.geohash,
      name: tileLabel(t),
    }));
}

/** pins.csv: lat, lon, radius_mi (>= 1). */
export function pinsCsv(sheet: StreetSheet, opts: PinOptions & CsvOptions = {}): string {
  return toCsv(
    PINS_CSV_COLUMNS,
    pinRows(sheet, opts).map((p) => [p.lat, p.lon, p.radiusMi]),
    opts,
  );
}

// ---------------------------------------------------------------------------
// offer-codes.csv
// ---------------------------------------------------------------------------

export const OFFER_CODE_STATUS = "create in your ticketing platform";

export const OFFER_CODES_CSV_COLUMNS = [
  "offer_code",
  "description",
  "channel",
  "assigned_to",
  "tile",
  "event_id",
  "event_date",
  "venue",
  "valid_from",
  "valid_until",
  "discount",
  "max_uses",
  "status",
] as const;

export interface OfferCodeRow {
  code: string;
  description: string;
  channel: "partner" | "your list" | "street team";
  assignedTo: string;
  tile: string;
  eventId: string;
  eventDate: string;
  venue: string;
  validFrom: string;
  validUntil: string;
  status: typeof OFFER_CODE_STATUS;
}

export interface OfferCodeOptions extends TileSelectOptions {
  /** Operator's prefix for every code (letters and digits kept, upper-cased, at most 6). Default "". */
  codePrefix?: string;
  /** Add one code per declared partner. Default true. */
  includeDeclared?: boolean;
  /** Add one flyer code per top tile. Default true. */
  includeTiles?: boolean;
}

/**
 * One tracking code per suggested partner, per declared partner and per top
 * tile. Codes are built from the partner's or tile's own name plus a running
 * number, never from act names (partner-facing text carries no artist marks).
 * Discount and limits are left blank: they are the operator's call, set in
 * their ticketing platform.
 */
export function offerCodeRows(sheet: StreetSheet, opts: OfferCodeOptions = {}): OfferCodeRow[] {
  const prefix = codeFragment(opts.codePrefix ?? "", 6);
  const bill = sheet.bill;
  const created = new Date(sheet.createdAt);
  const validFrom = Number.isNaN(created.getTime()) ? "" : ymdOf(created);
  const tiles = new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  const used = new Set<string>();
  // Fixture rows say so in their description, not only in the file name.
  const fx = sheet.mode === "fixture" ? SAMPLE_PREFIX : "";
  let n = 0;
  const make = (stem: string, fallback: string): string => {
    n += 1;
    const body = codeFragment(stem, 6) || fallback;
    const stemCode = `${prefix}${body}${String(n).padStart(2, "0")}`;
    let code = stemCode;
    // Only reachable past 99 rows ("ABC" + 102 vs "ABC1" + 02); keep codes unique anyway.
    for (let k = 1; used.has(code); k++) code = `${stemCode}X${k}`;
    used.add(code);
    return code;
  };
  const base = {
    eventId: bill.tmEventId ?? "",
    eventDate: bill.date,
    venue: bill.venue.name,
    validFrom,
    validUntil: bill.date,
    status: OFFER_CODE_STATUS,
  } as const;
  const rows: OfferCodeRow[] = [];
  for (const p of sheet.cards.partners.results) {
    const tile = p.tileGeohash ? tiles.get(p.tileGeohash) : undefined;
    const tileText = p.tileName ?? (tile ? tileLabel(tile) : p.tileGeohash ?? "");
    rows.push({
      ...base,
      code: make(p.entity.name, "PARTNER"),
      description: `${fx}Street team code for ${p.entity.name}${tileText ? ` (${tileText})` : ""}`,
      channel: "partner",
      assignedTo: p.entity.name,
      tile: tileText,
    });
  }
  if (opts.includeDeclared ?? true) {
    for (const d of declaredInCallOrder(sheet.cards.declared.results)) {
      rows.push({
        ...base,
        code: make(d.declared.label, "LIST"),
        description: `${fx}Code for ${d.declared.label} (your list)`,
        channel: "your list",
        assignedTo: d.declared.label,
        tile: "",
      });
    }
  }
  if (opts.includeTiles ?? true) {
    topTiles(sheet, opts).forEach((t, i) => {
      const name = tileLabel(t);
      rows.push({
        ...base,
        code: make(t.name ?? "", `TILE${i + 1}`),
        description: `${fx}Flyer code for ${name} (area ${i + 1} on the sheet)`,
        channel: "street team",
        assignedTo: name,
        tile: name,
      });
    });
  }
  return rows;
}

/** offer-codes.csv: TM One / Etix-style promo code rows, every one labelled "create in your ticketing platform". */
export function offerCodesCsv(sheet: StreetSheet, opts: OfferCodeOptions & CsvOptions = {}): string {
  return toCsv(
    OFFER_CODES_CSV_COLUMNS,
    offerCodeRows(sheet, opts).map((r) => [
      r.code,
      r.description,
      r.channel,
      r.assignedTo,
      r.tile,
      r.eventId,
      r.eventDate,
      r.venue,
      r.validFrom,
      r.validUntil,
      "",
      "",
      r.status,
    ]),
    opts,
  );
}
