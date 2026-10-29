/**
 * Q4-Q6 and the lift map: bill heat, house heat (roster or tag baseline), the
 * generic foot-traffic heat for the diagnostic, deterministic lift, then the
 * split-half check: at most 4 more heatmaps (two halves of the bill's seeds,
 * two halves of the house's), lift per half, and the Spearman between them.
 */
import type { Envelope, HeatCell, LiftTile, SheetLiftDiagnostics, StreetSheetCards } from "@walkup/contracts";
import { computeLiftMap, haversineM, LIFT_DEFAULTS, liftMethod, splitHalfAgreement, splitHalves, type LiftMapResult } from "@walkup/engine";
import { errorStatus } from "@walkup/qloo";
import { baselineTagFor, isComedyClassification } from "../tags";
import { envelope, failure, node, plural, signal, venuePoint, type HouseSet, type RunContext, type Seed } from "../context";
import { HOUSE_MIN_RESOLVED } from "./resolve";

export const THIN_CELLS = 200;
export const WIDE_RADIUS_KM = 60;
/** Top tiles need the bill's crowd to actually be there (bill percentile floor). */
export const MIN_BILL_PCT = LIFT_DEFAULTS.billFloor;
/** The split-half Spearman must be above this for the map to steer partners. */
export const MIN_SPLIT_HALF = LIFT_DEFAULTS.minSplitHalf;
/** Node label suffix of the split-half heatmaps (at most 4 per run). */
export const SPLIT_HALF_NODE = "(split-half check)";
export const MAX_CARD_TILES = 8;
export const CONTEXT_TILES = 4;
export const NARRATED_TILES = 5;
/** Partner pools, narration and budget use top tiles at least this far apart. */
export const MIN_TILE_SEPARATION_KM = 3;

type LiftCard = StreetSheetCards["liftMap"];

export interface HeatResult {
  card: LiftCard;
  /** Split-half and lift-vs-heat checks, as written on the card. Null when no lift was computed. */
  liftDiagnostics: SheetLiftDiagnostics | null;
  /** Top tiles (annotated, lift possibly down-weighted by reached ZIPs), lift order. */
  top: LiftTile[];
  /** Top tiles at least MIN_TILE_SEPARATION_KM apart, lift order (partners, narration, budget). */
  spread: LiftTile[];
  /** Every tile on the card (top + context). */
  cardTiles: LiftTile[];
  liftWeak: boolean;
  radiusKm: number;
  billRef: string | null;
  houseRef: string | null;
  widened: boolean;
  thin: boolean;
  /** Top tiles left out because the operator excluded their area. */
  excludedAreas: number;
  /** Spearman(lift, the bill's own heat) over the joined tiles (KG2's statistic); null without a lift map. */
  liftVsOwnHeat: number | null;
  /** liftVsOwnHeat above LIFT_DEFAULTS.weakThreshold: the map shows where the crowd is, not where it stands out. */
  tracksOwnHeat: boolean;
}

/** House sets seen by runHeat, so the partner step can replay its pools with the same house signal. */
const HOUSES = new WeakMap<RunContext, HouseSet>();

/** The house set this run's heat step used (null before runHeat ran). */
export function houseFor(ctx: RunContext): HouseSet | null {
  return HOUSES.get(ctx) ?? null;
}

/**
 * "Alexandria (Del Ray), VA" -> ["alexandria (del ray), va", "alexandria (del ray)"], plus "alexandria" and "del ray"
 * with `parts` (an area's own name matches either part; an operator's "Alexandria (Del Ray)" means that one area).
 */
function areaKeys(name: string, parts = true): string[] {
  const out = new Set<string>();
  const add = (x: string | undefined) => {
    const k = (x ?? "").replace(/\s*\(\d{5}\)$/, "").trim().toLowerCase();
    if (k) out.add(k);
  };
  add(name);
  // "Nashville-Davidson, 17 km west" or "Laurel, MD" (a numbered area's label) names the place before the comma.
  const head = name.split(",")[0] ?? name;
  add(head);
  const paren = parts ? /^(.*?)\s*\(([^)]+)\)\s*$/.exec(head.trim()) : null;
  if (paren) {
    add(paren[1]);
    if (!/^\d{5}$/.test(paren[2] ?? "")) add(paren[2]);
  }
  return [...out];
}

/**
 * True when the tile's geohash or name is in the operator's excluded areas (case-insensitive). The name matches with
 * or without its state, distance or parenthesised part ("Alexandria (Del Ray)" matches "Alexandria" and "Del Ray"),
 * and `alias` (the tile's OSM or Census name, e.g. "Langston" for "H Street NE") matches too.
 */
export function isExcludedArea(tile: Pick<LiftTile, "geohash" | "name">, excludeAreas: readonly string[] | undefined, alias?: string | null): boolean {
  if (!excludeAreas || excludeAreas.length === 0) return false;
  const wanted = new Set(excludeAreas.flatMap((a) => areaKeys(a, false)));
  if (wanted.has(tile.geohash.toLowerCase())) return true;
  const own = [...(tile.name ? areaKeys(tile.name) : []), ...(alias ? areaKeys(alias) : [])];
  return own.some((k) => wanted.has(k));
}

export interface SplitHalfRun {
  spearman: number | null;
  /** The bill and the house were both split (false: only the bill, against a one-tag baseline). */
  houseSplit: boolean;
  /** Plain line for the card when the check could not run or is limited. */
  note?: string;
  ledgerRefs: string[];
}

/**
 * The split-half check. Typed fallbacks: one seed (no calls), a failed or
 * empty half (null with the reason), too few shared tiles (null). The house
 * is split only when its own heat is the baseline; a genre-tag baseline is one
 * signal, so both bill halves are compared against it.
 */
export async function runSplitHalf(
  ctx: RunContext,
  seeds: readonly Seed[],
  house: HouseSet,
  baseline: { kind: "house" | "tag"; cells: readonly HeatCell[] },
  radiusKm: number,
): Promise<SplitHalfRun> {
  const [seedsA, seedsB] = splitHalves(seeds, (x) => x.entity.entityId);
  if (seedsB.length === 0) {
    return { spearman: null, houseSplit: false, note: "This bill has one act, so there was no second half to check the map against.", ledgerRefs: [] };
  }
  const point = venuePoint(ctx);
  const refs: string[] = [];
  const heat = async (label: string, level: "bill" | "venue", sig: string[]): Promise<HeatCell[]> => {
    node(ctx, label, level);
    const r = await ctx.qloo.heatmap({ signalEntities: sig, point, radiusM: radiusKm * 1000 });
    refs.push(r.ledgerRef);
    return r.value;
  };
  const houseSplit = baseline.kind === "house" && house.baseline === "house" && new Set(house.ids).size >= 2;
  let cells: [HeatCell[], HeatCell[], readonly HeatCell[], readonly HeatCell[]];
  try {
    const billA = await heat(`Q4 bill heat, half 1 ${SPLIT_HALF_NODE}`, "bill", signal(ctx, seedsA));
    const billB = await heat(`Q4 bill heat, half 2 ${SPLIT_HALF_NODE}`, "bill", signal(ctx, seedsB));
    let houseA: readonly HeatCell[] = baseline.cells;
    let houseB: readonly HeatCell[] = baseline.cells;
    if (houseSplit) {
      const [ha, hb] = splitHalves(house.ids, (id) => id);
      houseA = await heat(`Q5 house heat, half 1 ${SPLIT_HALF_NODE}`, "venue", ha);
      houseB = await heat(`Q5 house heat, half 2 ${SPLIT_HALF_NODE}`, "venue", hb);
    }
    cells = [billA, billB, houseA, houseB];
  } catch (err) {
    const ref = (err as { ledgerRef?: string }).ledgerRef;
    if (ref) refs.push(ref);
    return { spearman: null, houseSplit, note: `A split-half heatmap failed (${errorStatus(err).reason}), so the map could not be checked.`, ledgerRefs: refs };
  }
  if (cells.some((c) => c.length === 0)) {
    return { spearman: null, houseSplit, note: "A split-half heatmap came back empty, so the map could not be checked.", ledgerRefs: refs };
  }
  // Without two house halves, both bill halves would share one denominator, which correlates their lift
  // maps even on noise: compare the halves' own heat instead.
  const r = splitHalfAgreement(
    { billA: cells[0], billB: cells[1], houseA: cells[2], houseB: cells[3], compare: houseSplit ? "lift" : "partial" },
    { minBillPct: MIN_BILL_PCT, minSplitHalf: MIN_SPLIT_HALF },
  );
  const out: SplitHalfRun = { spearman: r.spearman, houseSplit, ledgerRefs: refs };
  if (r.spearman === null) out.note = `Only ${plural(r.n, "area")} came back in all four split-half maps, too few to compare.`;
  else if (!houseSplit) {
    out.note =
      baseline.kind === "tag"
        ? "The baseline is one genre tag, so only the bill was split in two and the check compares where each half's crowd is, with the shared baseline taken out."
        : "The room's usual crowd rests on one act, so only the bill was split in two and the check compares where each half's crowd is, with the shared baseline taken out.";
  }
  return out;
}

type Annotation = { name?: string; gazetteerName?: string; zctas?: string[]; adultPopulation?: number | null; state?: string | null };

/** Gazetteer names per run (geohash -> the OSM or Census name behind the area name), for the excluded-area match. */
const ALIASES = new WeakMap<RunContext, Map<string, string>>();

/** The OSM or Census name behind an area's name on this run ("Langston" behind "H Street NE"), or undefined. */
export function areaAlias(ctx: RunContext, geohash: string): string | undefined {
  return ALIASES.get(ctx)?.get(geohash);
}

function annotateCache(ctx: RunContext): (t: { geohash: string; lat: number; lon: number }) => Annotation {
  const memo = new Map<string, Annotation>();
  let aliases = ALIASES.get(ctx);
  if (!aliases) {
    aliases = new Map();
    ALIASES.set(ctx, aliases);
  }
  const known = aliases;
  return (t) => {
    let hit = memo.get(t.geohash);
    if (!hit) {
      const a = ctx.gazetteer.annotateTile({ lat: t.lat, lon: t.lon });
      hit = {};
      if (a.name !== undefined) hit.name = a.name;
      if (a.gazetteerName !== undefined) {
        hit.gazetteerName = a.gazetteerName;
        known.set(t.geohash, a.gazetteerName);
      }
      if (a.zctas !== undefined) hit.zctas = a.zctas;
      if (a.adultPopulation !== undefined) hit.adultPopulation = a.adultPopulation;
      if (a.state) hit.state = a.state;
      memo.set(t.geohash, hit);
    }
    return hit;
  };
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

/** True when two tiles share a 5-digit ZIP (ZCTA). */
function shareZip(a: Pick<LiftTile, "zctas">, b: Pick<LiftTile, "zctas">): boolean {
  const za = a.zctas ?? [];
  return za.length > 0 && (b.zctas ?? []).some((z) => za.includes(z));
}

/**
 * Greedy pick in lift order, skipping tiles closer than minKm to one already
 * picked or sharing a ZIP with one, so the numbered areas are distinct places.
 */
export function spreadTiles(tiles: readonly LiftTile[], minKm = MIN_TILE_SEPARATION_KM): LiftTile[] {
  const out: LiftTile[] = [];
  for (const t of tiles) {
    if (out.every((o) => haversineM(o, t) >= minKm * 1000 && !shareZip(o, t))) out.push(t);
  }
  return out;
}

/**
 * The numbered areas 1-5 as the web sheet, the PDF and the CSVs draw them from a sheet's tiles: lift at least the
 * lift floor, by lift (then bill percentile, then geohash), skipping a tile within 3 km of one already numbered or
 * sharing a ZIP with it. The revision banner diffs these, so its rows match the list a reader sees.
 */
export function numberedTiles(tiles: readonly LiftTile[], n = NARRATED_TILES): LiftTile[] {
  const sorted = [...tiles]
    .filter((t) => Number.isFinite(t.lift) && t.lift >= LIFT_DEFAULTS.minLift)
    .sort((a, b) => b.lift - a.lift || b.billPct - a.billPct || (a.geohash < b.geohash ? -1 : a.geohash > b.geohash ? 1 : 0));
  const out: LiftTile[] = [];
  for (const t of sorted) {
    if (out.length >= n) break;
    if (!out.some((o) => haversineM(o, t) < MIN_TILE_SEPARATION_KM * 1000 || shareZip(o, t))) out.push(t);
  }
  return out;
}

/** The radius the lift map was searched at: the widened one when fewer than THIN_CELLS squares came back. */
export function mapSearchKm(sheet: { operator: { radiusKm: number }; cards: { liftMap: { reason?: string } } }): number {
  const m = /The search widened to (\d+(?:\.\d+)?) km/.exec(sheet.cards.liftMap.reason ?? "");
  return m ? Number(m[1]) : sheet.operator.radiusKm;
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;

/** Eight-point compass direction from `from` to `to`. */
export function compassFrom(from: { lat: number; lon: number }, to: { lat: number; lon: number }): (typeof COMPASS)[number] {
  const dy = to.lat - from.lat;
  const dx = (to.lon - from.lon) * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180);
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8] as (typeof COMPASS)[number];
}

/**
 * Gives tiles that share a name a way apart, so every numbered area reads as its own place: the OSM or Census
 * name behind it in brackets when that tells them apart ("Alexandria (Del Ray)", from `aliasOf`), else a distance
 * and direction from the venue ("Nashville, 17 km west"), then a ZIP if that still clashes. Returns new tile objects.
 */
export function disambiguateNames(tiles: readonly LiftTile[], venue: { lat: number; lon: number }, aliasOf: (geohash: string) => string | undefined = () => undefined): LiftTile[] {
  const count = (list: readonly LiftTile[]) => {
    const m = new Map<string, number>();
    for (const t of list) if (t.name) m.set(t.name, (m.get(t.name) ?? 0) + 1);
    return m;
  };
  const first = count(tiles);
  // Brackets only when every clashing tile has its own, different alias.
  const aliasesOk = new Map<string, boolean>();
  for (const [name, n] of first) {
    if (n < 2) continue;
    const group = tiles.filter((t) => t.name === name).map((t) => aliasOf(t.geohash));
    aliasesOk.set(name, group.every((a) => !!a && a !== name) && new Set(group).size === group.length);
  }
  let out = tiles.map((t) => {
    if (!t.name || (first.get(t.name) ?? 0) < 2) return t;
    if (aliasesOk.get(t.name)) return { ...t, name: `${t.name} (${aliasOf(t.geohash)})` };
    const km = haversineM(venue, t) / 1000;
    const dist = km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
    return { ...t, name: `${t.name}, ${dist} ${compassFrom(venue, t)}` };
  });
  const second = count(out);
  out = out.map((t) => (t.name && (second.get(t.name) ?? 0) > 1 && t.zctas?.[0] ? { ...t, name: `${t.name} (${t.zctas[0]})` } : t));
  return out;
}

/** Down-weights tiles whose ZCTAs the operator already reaches (aggregate counts only). */
export function applyReachedZips(tiles: LiftTile[], reached: { zip: string; count: number }[] | undefined): { tiles: LiftTile[]; adjusted: number } {
  if (!reached || reached.length === 0) return { tiles, adjusted: 0 };
  const byZip = new Map(reached.map((r) => [r.zip, r.count]));
  let adjusted = 0;
  const out = tiles.map((t) => {
    const count = (t.zctas ?? []).reduce((s, z) => s + (byZip.get(z) ?? 0), 0);
    const adults = t.adultPopulation ?? null;
    if (count <= 0 || !adults) return t;
    // Share of the tile's adults already reached; 5% reached halves the lift (heuristic).
    const share = Math.min(1, count / adults);
    const factor = Math.max(0.5, 1 - share * 10);
    if (factor >= 1) return t;
    adjusted++;
    return { ...t, lift: round(t.lift * factor, 4) };
  });
  out.sort((a, b) => b.lift - a.lift || (a.geohash < b.geohash ? -1 : 1));
  return { tiles: out, adjusted };
}

/** Card line when lift ranks areas almost like the bill's own heat (the KG2 statistic). */
export function ownHeatLine(against: string, rho: number | null): string {
  const r = rho === null ? "" : ` (${(Math.round(rho * 100) / 100).toFixed(2)})`;
  return `This map shows where this bill's crowd is, not where it stands out from ${against}: on this bill the two rank areas almost the same way${r}. Partners are picked near the venue.`;
}

/**
 * "comedy fans in general" for a genre-tag baseline ("fans of this genre in general" without a genre). A genre with
 * two capitals keeps its case ("R&B fans in general", "EDM").
 */
export function genreBaselinePhrase(classification: string | null | undefined): string {
  const raw = classification ?? "";
  const g = (/\(([^)]+)\)\s*$/.exec(raw)?.[1] ?? raw.split("/").pop() ?? "").trim();
  if (!g || /^(undefined|other|miscellaneous)$/i.test(g)) return "fans of this genre in general";
  return `${/[A-Z].*[A-Z]/.test(g) ? g : g.toLowerCase()} fans in general`;
}

/** "in Nashville-Davidson (3) and Mount Juliet (2)": area names grouped by place, counts only when a place repeats. */
function joinNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) {
    const base = n.split(", ")[0]?.replace(/ \(\d{5}\)$/, "") ?? n;
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([n, k]) => (k > 1 ? `${n} (${k})` : n));
  const list = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `in ${list}`;
}

export async function runHeat(ctx: RunContext, seeds: Seed[], house: HouseSet): Promise<HeatResult> {
  HOUSES.set(ctx, house);
  const point = venuePoint(ctx);
  const sig = signal(ctx, seeds);
  // Neither a house set nor a pinned genre tag: there is no baseline at all ("none"), never a claimed genre tag.
  const genreTag = house.tag ?? baselineTagFor(ctx.pins, ctx.bill.classification);
  const emptyBaseline: LiftCard["results"]["diagnostics"]["baseline"] = house.baseline === "house" ? "house" : genreTag ? "tag" : "none";
  const empty: LiftCard["results"] = { tiles: [], diagnostics: { spearmanLiftVsHeat: null, baseline: emptyBaseline } };
  const result: HeatResult = {
    card: envelope("empty", "No lift map.", empty, []),
    liftDiagnostics: null,
    top: [],
    spread: [],
    cardTiles: [],
    liftWeak: false,
    radiusKm: ctx.operator.radiusKm,
    billRef: null,
    houseRef: null,
    widened: false,
    thin: false,
    excludedAreas: 0,
    liftVsOwnHeat: null,
    tracksOwnHeat: false,
  };

  // Q4: bill heat; fewer than 200 cells widens to 60 km once.
  let radiusKm = ctx.operator.radiusKm;
  let bill: HeatCell[] = [];
  const provenance: string[] = [];
  try {
    node(ctx, "Q4 bill heat", "bill");
    let r = await ctx.qloo.heatmap({ signalEntities: sig, point, radiusM: radiusKm * 1000 });
    provenance.push(r.ledgerRef);
    if (r.value.length < THIN_CELLS && radiusKm < WIDE_RADIUS_KM) {
      result.widened = true;
      radiusKm = WIDE_RADIUS_KM;
      node(ctx, "Q4 bill heat (widened to 60 km)", "bill");
      r = await ctx.qloo.heatmap({ signalEntities: sig, point, radiusM: radiusKm * 1000 });
      provenance.push(r.ledgerRef);
    }
    bill = r.value;
    result.billRef = r.ledgerRef;
    ctx.billHeatRef = r.ledgerRef;
    result.thin = bill.length < THIN_CELLS;
  } catch (err) {
    result.card = failure(err, empty, "Where this crowd stands out");
    return result;
  }
  result.radiusKm = radiusKm;
  if (bill.length === 0) {
    result.card = envelope("empty", "The bill heatmap came back empty.", empty, provenance, "No cells for this signal around the venue.");
    return result;
  }

  // Q5: house heat (roster); when it fails or comes back empty, the pinned genre tag stands in.
  let houseCells: HeatCell[] = [];
  let baseline: "house" | "tag" = house.baseline === "house" ? "house" : "tag";
  const houseReasons: string[] = [];
  if (house.baseline === "house") {
    node(ctx, "Q5 house heat", "venue");
    try {
      const r = await ctx.qloo.heatmap({ signalEntities: house.ids, point, radiusM: radiusKm * 1000 });
      houseCells = r.value;
      result.houseRef = r.ledgerRef;
      provenance.push(r.ledgerRef);
      if (houseCells.length === 0) {
        houseReasons.push("house heat came back empty");
        baseline = "tag";
      }
    } catch (err) {
      const ref = (err as { ledgerRef?: string }).ledgerRef;
      if (ref) provenance.push(ref);
      houseReasons.push(`house heat failed (${errorStatus(err).reason})`);
      baseline = "tag";
    }
  }
  const tag = genreTag;
  let tagHeatProblem: string | null = null;
  if (baseline === "tag" && houseCells.length === 0) {
    if (tag) {
      node(ctx, "Q5 house heat (tag baseline)", "venue");
      try {
        const r = await ctx.qloo.heatmap({ signalTags: [tag], point, radiusM: radiusKm * 1000 });
        houseCells = r.value;
        result.houseRef = r.ledgerRef;
        provenance.push(r.ledgerRef);
        if (houseCells.length === 0) tagHeatProblem = "the genre tag heatmap came back empty";
      } catch (err) {
        const ref = (err as { ledgerRef?: string }).ledgerRef;
        if (ref) provenance.push(ref);
        tagHeatProblem = `the genre tag heatmap failed (${errorStatus(err).reason})`;
      }
    } else {
      tagHeatProblem = isComedyClassification(ctx.bill.classification) ? "comedy has no genre-wide map" : "no genre-wide crowd is set up for this bill's genre";
    }
  }

  if (houseCells.length === 0 && house.baseline !== "house" && !tag && isComedyClassification(ctx.bill.classification)) {
    // Comedy: no genre-wide map exists to stand in (Oct 15, probe 19: 0 areas), so there is no lift map.
    const lines = [
      `Qloo has no comedy-wide map to compare with, and fewer than ${HOUSE_MIN_RESOLVED} of the room's usual acts matched, so there's no lift map for this bill. Partners are picked near the venue.`,
    ];
    if (result.widened) lines.push(`The search widened to 60 km (fewer than ${THIN_CELLS} map squares came back within ${ctx.operator.radiusKm} km).`);
    if (result.thin) lines.push(`Only ${plural(bill.length, "area")} came back, so the signal is thin.`);
    result.card = envelope("degraded", "There is no usual crowd to compare this bill with.", empty, provenance, lines.join(" "));
    return result;
  }

  // Q6: generic foot-traffic heat (diagnostic only).
  let generic: HeatCell[] | null = null;
  if (ctx.pins.genericHeatTag) {
    node(ctx, "Q6 generic heat (diagnostic)", "venue");
    try {
      const r = await ctx.qloo.heatmap({ signalTags: [ctx.pins.genericHeatTag], point, radiusM: radiusKm * 1000 });
      generic = r.value;
      provenance.push(r.ledgerRef);
    } catch (err) {
      const ref = (err as { ledgerRef?: string }).ledgerRef;
      if (ref) provenance.push(ref);
    }
  }

  const annotate = annotateCache(ctx);
  if (houseCells.length === 0) {
    const why = [
      ...(house.baseline === "house" ? [] : [`the room's roster resolved ${plural(house.resolved, "headliner")}`]),
      ...houseReasons,
      ...(tagHeatProblem ? [tagHeatProblem] : []),
    ];
    result.card = envelope(
      "degraded",
      "No house baseline came back, so the map cannot show lift.",
      empty,
      provenance,
      `degraded: no house baseline (${why.join("; ") || "roster unresolved"}).`,
    );
    return result;
  }
  const lift: LiftMapResult = computeLiftMap(bill, houseCells, {
    rawHeat: generic,
    minBillPct: MIN_BILL_PCT,
    adultPopulation: (t) => annotate(t).adultPopulation,
  });
  const annotated = (t: LiftTile): LiftTile => {
    const a = annotate(t);
    const out: LiftTile = { ...t, lift: round(t.lift, 4), billPct: round(t.billPct, 4), housePct: round(t.housePct, 4), popularityPct: round(t.popularityPct, 4) };
    if (a.name) out.name = a.name;
    if (a.zctas) out.zctas = a.zctas;
    out.adultPopulation = a.adultPopulation ?? null;
    if (a.state) out.state = a.state;
    return out;
  };
  // Split-half check (after Q6, so Q4-Q6 keep their order in the ledger).
  const split = await runSplitHalf(ctx, seeds, house, { kind: baseline, cells: houseCells }, radiusKm);
  provenance.push(...split.ledgerRefs);
  const splitWeak = split.spearman !== null && !(split.spearman > MIN_SPLIT_HALF);

  const annotatedTop = lift.top.map(annotated);
  const kept = annotatedTop.filter((t) => !isExcludedArea(t, ctx.operator.excludeAreas, areaAlias(ctx, t.geohash)));
  result.excludedAreas = annotatedTop.length - kept.length;
  const reached = applyReachedZips(kept, ctx.operator.alreadyReachedZips);
  const top = reached.tiles;
  // Numbered areas: distinct places (3 km apart, no shared ZIP) with distinct names.
  const spread = disambiguateNames(spreadTiles(top), venuePoint(ctx), (gh) => areaAlias(ctx, gh));
  const renamed = new Map(spread.map((t) => [t.geohash, t]));
  result.top = top.map((t) => renamed.get(t.geohash) ?? t);
  result.spread = spread;
  // KG2's statistic: lift that ranks areas almost like the bill's own heat shows where the crowd is, not
  // where it stands out (Oct 15, probe 6: 0.98 for a comedian against the restaurant baseline).
  const ownRho = lift.diagnostics.spearmanLiftVsBillHeat;
  const tracksOwnHeat = lift.diagnostics.tracksOwnHeat;
  result.liftWeak = lift.diagnostics.liftWeak || splitWeak || tracksOwnHeat;
  result.liftVsOwnHeat = ownRho === null ? null : round(ownRho, 3);
  result.tracksOwnHeat = tracksOwnHeat;
  // The card shows the spread tiles (partners, budget, narration) plus the next
  // best tiles, then a few of the lowest-lift tiles for contrast.
  const shown = new Map<string, LiftTile>();
  for (const t of [...result.spread.slice(0, NARRATED_TILES), ...result.top.slice(0, MAX_CARD_TILES)]) if (!shown.has(t.geohash)) shown.set(t.geohash, t);
  const leading = [...shown.values()].sort((a, b) => b.lift - a.lift || (a.geohash < b.geohash ? -1 : 1));
  const context = [...lift.all]
    .reverse()
    .filter((t) => !shown.has(t.geohash))
    .slice(0, CONTEXT_TILES * 4)
    .map(annotated)
    .filter((t) => !isExcludedArea(t, ctx.operator.excludeAreas, areaAlias(ctx, t.geohash)))
    .slice(0, CONTEXT_TILES);
  result.cardTiles = [...leading, ...context];
  const rho = lift.diagnostics.spearmanLiftVsHeat;
  const splitRounded = split.spearman === null ? null : round(split.spearman, 3);
  const liftDiagnostics: SheetLiftDiagnostics = {
    splitHalfSpearman: splitRounded,
    liftVsHeatSpearman: rho === null ? null : round(rho, 3),
    billFloor: MIN_BILL_PCT,
    method: liftMethod({ minBillPct: MIN_BILL_PCT }),
  };
  const notes: string[] = [];
  if (splitWeak) notes.push(`The two halves of the bill put this crowd in different areas (split-half ${splitRounded}), so partners are ranked near the venue.`);
  else if (split.note) notes.push(split.note);
  if (lift.diagnostics.liftWeak) notes.push("Lift follows general popularity here, so partners are picked near the venue.");
  if (tracksOwnHeat) notes.push(ownHeatLine(baseline === "house" ? "the room's usual crowd" : genreBaselinePhrase(ctx.bill.classification), ownRho));
  if (notes.length > 0) liftDiagnostics.note = notes.join(" ");
  result.liftDiagnostics = liftDiagnostics;
  const results: LiftCard["results"] = {
    tiles: result.cardTiles,
    diagnostics: { spearmanLiftVsHeat: rho === null ? null : round(rho, 3), baseline },
    liftDiagnostics,
  };

  const against = baseline === "house" ? "the room's usual crowd" : genreBaselinePhrase(ctx.bill.classification);
  const named = result.spread.slice(0, NARRATED_TILES).map((t) => t.name ?? "an unnamed area");
  let summary =
    top.length > 0
      ? `${plural(top.length, "area")} where this bill's crowd ranks higher than ${against}. ${named.length === 1 ? "The top one is" : `The top ${named.length} are`} ${joinNames(named)}.`
      : `No area reached a lift of 1.3 against ${against}, so partners are picked near the venue.`;
  if (reached.adjusted > 0) summary += ` ${plural(reached.adjusted, "area")} weighted down because you already reach their ZIPs.`;
  if (result.excludedAreas > 0) summary += ` ${plural(result.excludedAreas, "area")} left out at your request.`;
  const reasons: string[] = [];
  let status: Envelope<unknown>["status"] = "ok";
  if (baseline === "tag") {
    status = "degraded";
    reasons.unshift(
      house.baseline === "house"
        ? `The room's own crowd couldn't be mapped (${houseReasons.join("; ")}), so the map compares this bill with ${against}.`
        : `Only ${plural(house.resolved, "of the room's headliners", "of the room's headliners")} matched Qloo (${HOUSE_MIN_RESOLVED} needed), so the map compares this bill with ${against}.`,
    );
  }
  if (result.widened) {
    if (status === "ok") status = "partial";
    reasons.push(`The search widened to 60 km (fewer than ${THIN_CELLS} map squares came back within ${ctx.operator.radiusKm} km).`);
  }
  if (result.thin) {
    if (status === "ok") status = "partial";
    reasons.push(`Only ${plural(bill.length, "area")} came back, so the signal is thin.`);
  }
  if (lift.diagnostics.liftWeak) {
    if (status === "ok") status = "partial";
    reasons.push("Lift follows general popularity here, so partners are picked near the venue.");
  }
  if (tracksOwnHeat) {
    if (status === "ok") status = "partial";
    reasons.push(ownHeatLine(against, ownRho));
  }
  if (splitWeak) {
    if (status === "ok") status = "partial";
    reasons.push(`The two halves of the bill put this crowd in different areas (agreement ${splitRounded}, ${MIN_SPLIT_HALF} needed), so partners are picked near the venue.`);
  }
  if (top.length === 0 && status === "ok") {
    status = "partial";
    reasons.push("No area stood out enough, so partners are picked near the venue.");
  }
  const reason = reasons.length > 0 ? reasons.join(" ") : undefined;
  result.card = envelope(status, summary, results, provenance, reason, [
    "Lift compares percentile ranks within each response; it is not a count of people.",
  ]);
  return result;
}
