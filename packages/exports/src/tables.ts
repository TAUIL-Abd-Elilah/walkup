/**
 * The CSV exports: partners.csv (the call list), zips.csv and pins.csv (ad
 * targeting inputs derived from the top lift tiles), offer-codes.csv (codes to
 * create in the operator's own ticketing platform).
 *
 * Ad-targeting files carry no audience labels: a ZIP or a pin, the numbered
 * area it belongs to and a weight, nothing about who lives there. Distances
 * are in km.
 */
import type { DeclaredPartnerScore, LiftTile, Partner, QlooEntity, StreetSheet } from "@walkup/contracts";
import { WEEKDAYS } from "@walkup/contracts";
import { geohashPolygon, haversineM, isValidGeohash } from "@walkup/engine";
import { areaZips } from "./area-zips";
import { toCsv, type CsvCell, type CsvOptions } from "./csv";
import {
  areaLabel,
  categoryLabel,
  codeFragment,
  dayHoursText,
  DECLARED_UNRANKED,
  FIXTURE_NOTICE,
  hoursWeekday,
  NEAR_VENUE,
  partnerAreaText,
  partnerWhyLong,
  PHONE_NOT_LISTED,
  round,
  SAMPLE_PREFIX,
  sortedReceipts,
  streetDaysText,
  SUGGESTED_NOT_AFFILIATED,
  topTiles,
  WEBSITE_NOT_LISTED,
  weekdayShort,
  ymdOf,
  type TileSelectOptions,
} from "./format";
import { partnerVisits, type IcsOptions } from "./ics";

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
  "day",
  "hours_on_day",
  "visit_dates",
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
  /** The street-team plan options, the same as for street-team.ics, so the day column matches the calendar. */
  visits?: IcsOptions;
}

function prop(e: QlooEntity | undefined, key: string): string {
  const v = e?.properties?.[key];
  return typeof v === "string" ? v : "";
}

/** The value, or the words for a blank ("Phone not listed"), so the call list never leaves the cell silent. */
function notListed(value: string, words: string): string {
  return value.trim() !== "" ? value : words;
}

function chipsText(chips: readonly { label: string; ledgerRef: string }[]): string {
  return chips.map((c) => `${c.label} [${c.ledgerRef}]`).join("; ");
}

/** The receipts once each, in ledger order: "Q12 Q15 Q16". */
function refsText(chips: readonly { ledgerRef: string }[]): string {
  return sortedReceipts(chips.map((c) => c.ledgerRef)).join(" ");
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
  // The day column is the street-team day the calendar visits the partner on; the hours are that day's.
  const visits = partnerVisits(sheet, opts.visits);
  const streetDays = WEEKDAYS.filter((d) => (opts.visits?.streetTeamDays ?? sheet.operator.streetTeamDays ?? []).includes(d));
  // With no calendar at all (no street-team days, or the show is past), the hours are the ones the plan read.
  const day = hoursWeekday(sheet) ?? undefined;
  const rows: CsvCell[][] = [];
  let order = 0;
  for (const p of sheet.cards.partners.results as Partner[]) {
    order += 1;
    const tile = p.tileGeohash ? tiles.get(p.tileGeohash) : undefined;
    const visit = visits.get(p.entity.entityId);
    const closedAll = !visit && visits.size > 0;
    rows.push([
      order,
      "suggested",
      p.entity.name,
      // "Cafe, national chain", as the plan page and the paper say it.
      p.chain === true ? `${categoryLabel(p.category)}, national chain` : categoryLabel(p.category),
      // The paper's words for a partner from the search around the venue (no area): never a blank cell.
      partnerAreaText(p, tiles) || NEAR_VENUE,
      tile ? round(tile.lift, 2) : null,
      p.address ?? prop(p.entity, "address"),
      visit ? visit.weekdays.map(weekdayShort).join("; ") : "",
      visit ? visit.days.map((d) => dayHoursText(d.hours, d.weekday)).join("; ") : closedAll ? `Closed ${streetDaysText(streetDays)}: not on the calendar` : dayHoursText(p.hoursOnDay, day),
      // A date the day's route had no time left for says so, as the calendar's first event that day does.
      visit ? visit.dates.map((d) => (visit.notTimed.includes(d) ? `${d} (no time left on the route: call to arrange)` : d)).join("; ") : "",
      // A blank is said out loud, as on the paper. The website is the cleaned one only (`Partner.website`), the same
      // as the plan page and the PDF: a site the engine's rule dropped is not written here either.
      notListed(p.phone ?? prop(p.entity, "phone"), PHONE_NOT_LISTED),
      notListed(p.website ?? "", WEBSITE_NOT_LISTED),
      "",
      // The partner panel's parts, when the run built them: what to do there, why it is listed, how sure.
      p.explain?.activation ?? "",
      // The affiliation column already says "suggested, not affiliated"; the why text doesn't repeat it.
      p.explain ? partnerWhyLong({ ...p.explain, limits: p.explain.limits?.trim() === SUGGESTED_NOT_AFFILIATED ? "" : p.explain.limits }) : "",
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
        "",
        "",
        notListed(prop(d.entity, "phone"), PHONE_NOT_LISTED),
        notListed(prop(d.entity, "website"), WEBSITE_NOT_LISTED),
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
// Area weights shared by zips.csv and the sheet's budget split
// ---------------------------------------------------------------------------

/**
 * Weight per numbered area, summing to 1 (in zips.csv, an area's ZIPs add up to its weight). When the sheet's budget
 * split covers every area, each area keeps its own stored share, the same numbers the plan page and the area text
 * show; otherwise the weights are proportional to lift (already in area order). Same "heuristic, not a forecast"
 * status as the budget split.
 */
export function tileWeights(sheet: StreetSheet, tiles: readonly LiftTile[]): Map<string, number> {
  const out = new Map<string, number>();
  if (tiles.length === 0) return out;
  const split = new Map((sheet.budgetSplit ?? []).map((b) => [b.geohash, b.share]));
  const fromSplit = tiles.every((t) => {
    const s = split.get(t.geohash);
    return typeof s === "number" && Number.isFinite(s) && s >= 0;
  });
  const raw = tiles.map((t) => (fromSplit ? (split.get(t.geohash) as number) : Math.max(0, Number.isFinite(t.lift) ? t.lift : 0)));
  const total = raw.reduce((a, b) => a + b, 0);
  tiles.forEach((t, i) => out.set(t.geohash, total > 0 ? (raw[i] ?? 0) / total : 1 / tiles.length));
  return out;
}

/** The budget split by area number: one row per numbered area with its share, or [] when the sheet has no split. */
export function areaBudget(sheet: StreetSheet, opts: TileSelectOptions = {}): { rank: number; tile: LiftTile; share: number }[] {
  if ((sheet.budgetSplit ?? []).length === 0) return [];
  const tiles = topTiles(sheet, opts);
  const w = tileWeights(sheet, tiles);
  return tiles.map((t, i) => ({ rank: i + 1, tile: t, share: w.get(t.geohash) ?? 0 }));
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

export const ZIPS_CSV_COLUMNS = ["zip", "area", "area_name", "lift_score", "suggested_weight"] as const;

export interface ZipRow {
  zip: string;
  /** The numbered area (1-5) the ZIP is listed under: the first area that has it. */
  area: number;
  areaName: string;
  /** That area's lift, 2 decimals. */
  liftScore: number;
  /**
   * The ZIP's part of its area's budget share: the area's share split evenly over its ZIPs, 4 decimals, summing to 1
   * across rows. An area's rows add up to its share in the budget split (re-scaled when an area has no ZIP to list).
   */
  suggestedWeight: number;
  /** Geohashes of the numbered areas that contain this ZCTA, first area first. */
  tiles: string[];
}

export interface ZipOptions extends TileSelectOptions {
  /**
   * Which ZIPs to keep: false drops a ZIP that is not residential (a P.O. box, a single business or a campus, with
   * no one to reach at home). Default: `isResidentialZip` from @walkup/gazetteer/zips.
   */
  isResidentialZip?: (zip: string) => boolean;
}

/**
 * One row per residential 5-digit ZCTA in the numbered areas' `zctas`, in area order. A ZIP in several areas is
 * listed once, under the first. Each area's weight (`tileWeights`, the sheet's budget split) is split evenly over the
 * ZIPs listed under it, so an area's rows add up to its share in the budget split; the rows are then scaled to sum
 * to 1. Areas without a residential ZIP drop out.
 */
export function zipRows(sheet: StreetSheet, opts: ZipOptions = {}): ZipRow[] {
  const tiles = topTiles(sheet, opts);
  const weights = tileWeights(sheet, tiles);
  const acc = new Map<string, { area: number; t: LiftTile; tiles: string[] }>();
  tiles.forEach((t, i) => {
    for (const z of [...areaZips(t.zctas, opts.isResidentialZip)].sort()) {
      const cur = acc.get(z);
      if (cur) cur.tiles.push(t.geohash);
      else acc.set(z, { area: i + 1, t, tiles: [t.geohash] });
    }
  });
  const ordered = [...acc.entries()].sort((a, b) => a[1].area - b[1].area || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const zipsInArea = new Map<number, number>();
  for (const [, v] of ordered) zipsInArea.set(v.area, (zipsInArea.get(v.area) ?? 0) + 1);
  const rounded = apportion(ordered.map(([zip, v]) => ({ key: zip, w: (weights.get(v.t.geohash) ?? 0) / (zipsInArea.get(v.area) ?? 1) })));
  return ordered.map(([zip, v]) => ({
    zip,
    area: v.area,
    areaName: areaLabel(v.t),
    liftScore: round(v.t.lift, 2),
    suggestedWeight: rounded.get(zip) ?? 0,
    tiles: v.tiles,
  }));
}

/** zips.csv: zip, area, area_name, lift_score, suggested_weight. ZIPs are written as text so leading zeros survive. */
export function zipsCsv(sheet: StreetSheet, opts: ZipOptions & CsvOptions = {}): string {
  return toCsv(
    ZIPS_CSV_COLUMNS,
    zipRows(sheet, opts).map((r) => [r.zip, r.area, r.areaName, r.liftScore, r.suggestedWeight]),
    opts,
  );
}

// ---------------------------------------------------------------------------
// pins.csv
// ---------------------------------------------------------------------------

export const PINS_CSV_COLUMNS = ["area", "area_name", "lat", "lon", "radius_km"] as const;
/** The smallest pin radius, in km (one mile): smaller radii are commonly refused or barely deliver on ad platforms. */
export const MIN_PIN_RADIUS_KM = 1.6;

export interface PinRow {
  /** The numbered area (1-5), as on the sheet's map. */
  area: number;
  lat: number;
  lon: number;
  /** In km, one decimal; never below 1.6 km. */
  radiusKm: number;
  geohash: string;
  name: string;
}

export interface PinOptions extends TileSelectOptions {
  /** Minimum radius in km; values below 1.6 are raised to 1.6. Default 1.6. */
  minRadiusKm?: number;
}

/** Half the diagonal of a geohash cell, in km. */
export function geohashHalfDiagonalKm(geohash: string): number {
  if (!isValidGeohash(geohash)) return 0;
  const ring = geohashPolygon(geohash);
  const sw = ring[0];
  const ne = ring[2];
  if (!sw || !ne) return 0;
  return haversineM({ lat: sw[1], lon: sw[0] }, { lat: ne[1], lon: ne[0] }) / 2 / 1000;
}

/** One pin per numbered area at the tile's centre, radius covering the cell and never under 1.6 km. */
export function pinRows(sheet: StreetSheet, opts: PinOptions = {}): PinRow[] {
  const floor = Math.max(MIN_PIN_RADIUS_KM, opts.minRadiusKm ?? MIN_PIN_RADIUS_KM);
  return topTiles(sheet, opts)
    .map((t, i) => ({ t, area: i + 1 }))
    .filter(({ t }) => Number.isFinite(t.lat) && Number.isFinite(t.lon))
    .map(({ t, area }) => ({
      area,
      lat: round(t.lat, 5),
      lon: round(t.lon, 5),
      radiusKm: Math.max(floor, Math.ceil(round(geohashHalfDiagonalKm(t.geohash) * 10, 6)) / 10),
      geohash: t.geohash,
      name: areaLabel(t),
    }));
}

/** pins.csv: area, area_name, lat, lon, radius_km (>= 1.6). */
export function pinsCsv(sheet: StreetSheet, opts: PinOptions & CsvOptions = {}): string {
  return toCsv(
    PINS_CSV_COLUMNS,
    pinRows(sheet, opts).map((p) => [p.area, p.name, p.lat, p.lon, p.radiusKm]),
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
    // The same area words as partners.csv and the paper ("Kenilworth, DC (place in MD)", "near venue").
    const tileText = partnerAreaText(p, tiles) || NEAR_VENUE;
    rows.push({
      ...base,
      code: make(p.entity.name, "PARTNER"),
      // "(Kenilworth, DC, place in MD)": one pair of brackets in the description.
      description: `${fx}Street team code for ${p.entity.name} (${tileText.replace(/ \((place in [A-Z]{2})\)$/, ", $1")})`,
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
      const name = areaLabel(t);
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
