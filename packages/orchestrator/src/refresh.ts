/**
 * refreshSheet(): re-applies the current post-processing rules to a stored sheet, with no Qloo, Ticketmaster or
 * model call. It is what `scripts/refresh-recorded-plans.ts` runs over the recorded hero sheets, so a rule fixed
 * after recording reaches them without spending calls. Everything here works from what the sheet already holds
 * (its entities, ranks, ledger result counts and tile points) and the offline gazetteer:
 *
 *  - area names, ZIPs and adult counts from the gazetteer (the name people use; residential ZIPs only, at most 4);
 *    the budget split recomputed in the same area order;
 *  - categories re-read from each place's tags; on a "no bars" sheet, places whose name or bar-type tags say drinks
 *    are dropped; food carts and kiosks are dropped; websites that aren't the place's own are dropped;
 *  - chips in plain words ("ranks 7 places higher here than for the room's usual crowd"); "most influenced by"
 *    only on a bill with two or more acts;
 *  - "why this place" rebuilt (tags, confidence); partner lines cut back to each place's shared tags;
 *  - spots nearest the venue first; podcasts with no recent episodes left out or marked back catalogue; the
 *    sponsor by its short name;
 *  - the discovery picked again ("Start with this place"); a revision's change list rebuilt against its parent;
 *  - a live sheet is never marked hypothetical;
 *  - last, `recheckSheet`: the checks that change nothing the run found (tile states, "near" the area, the
 *    narration guard, the Checks step). `scripts/refresh-recorded-plans.ts --recheck` runs that pass alone.
 *
 * What it cannot do: fill a slot a dropped place leaves (that needs the Qloo list behind it), or add a numbered
 * area the new ZIP rules would now separate. `report.needsLiveRun` says when a sheet is in that state.
 */
import type { LedgerEntry, LiftTile, MediaPick, Partner, PrePostSpot, QlooEntity, SheetDiscovery, StreetSheet } from "@walkup/contracts";
import { annotateTile, stateFromZctas } from "@walkup/gazetteer";
import { vetNarration } from "@walkup/narrator";
import {
  backCatalogueLabel,
  barsExcluded,
  brandDisplayName,
  BACK_CATALOGUE_CHIP,
  cleanWebsite,
  DEFAULT_BAR_CATEGORIES,
  explainPartner,
  fanFacingAllowed,
  haversineM,
  isDrinkLed,
  isFoodStand,
  isNonVenue,
  isUsualCrowdChip,
  LIFT_DEFAULTS,
  partnerTagCounts,
  pickDiscovery,
  normalizeChainName,
  pickPodcasts,
  resolveCategory,
  usualCrowdChipLabel,
  type ExplainContext,
} from "@walkup/engine";
import { diffSheets } from "./revise/diff";
import { REVISE_STEP_ID, RULES_CHOSEN_READER } from "./revise/step";
import { splitBudget } from "./steps/budget";
import { partnerLinesNearArea, partnerLinesWithinTags, tidyAreaPhrases, usualCrowdWording } from "./steps/copy";
import { guardTrace } from "./steps/trace";
import { PARTNER_TILES } from "./steps/partners";
import { disambiguateNames, MIN_BILL_PCT, MIN_SPLIT_HALF, NARRATED_TILES, numberedTiles, spreadTiles } from "./steps/heat";
import { categoryTagMap, loadTagPins, type TagPins } from "./tags";
import type { GazetteerLike } from "./types";

export interface RefreshOptions {
  /** Default: the offline gazetteer in data/gazetteer/out. */
  gazetteer?: GazetteerLike;
  /** Tag pins for the category fallback. Default: config/tags.json. */
  pins?: TagPins;
  /** The parent sheet (already refreshed) of a revision, to rebuild its change list. */
  parent?: StreetSheet | null;
}

export interface RefreshReport {
  renamedAreas: { geohash: string; from: string; to: string }[];
  droppedPartners: { name: string; why: string }[];
  droppedSpots: { name: string; why: string }[];
  droppedWebsites: { name: string; website: string }[];
  droppedPodcasts: string[];
  backCatalogue: string[];
  renamedSponsor: { from: string; to: string } | null;
  discovery: { before: string | null; after: string | null };
  /** Set when the numbered areas (1-5) the sheet draws differ from the ones the run used. */
  numberedAreas?: { before: string[]; after: string[] };
  /** Why the sheet would differ after a live run: things refreshing cannot do. Empty when none. */
  needsLiveRun: string[];
}

const DEFAULT_GAZETTEER: GazetteerLike = { annotateTile: (t) => annotateTile(t) };

type Annotated = { name?: string; gazetteerName?: string; zctas?: string[]; adultPopulation?: number | null; state?: string | null };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace whole-word occurrences of each old name with its new one (longest first). */
function renamer(pairs: readonly { from: string; to: string }[]): (text: string) => string {
  const list = [...pairs].filter((p) => p.from && p.from !== p.to).sort((a, b) => b.from.length - a.from.length);
  if (list.length === 0) return (t) => t;
  const re = new RegExp(`(?<![A-Za-z])(${list.map((p) => escapeRe(p.from)).join("|")})(?![A-Za-z])`, "g");
  const to = new Map(list.map((p) => [p.from, p.to]));
  return (t) => t.replace(re, (m) => to.get(m) ?? m);
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = k === "ledgerRefs" || k === "geohash" || k === "tileGeohash" || k === "entityId" ? v : mapStrings(v, fn);
    return out as T;
  }
  return value;
}

function minLift(): number {
  return LIFT_DEFAULTS.minLift;
}

/** The sheet's numbered areas as the run made them: the budget split's order, else the spread of its top tiles. */
function storedNumbered(sheet: StreetSheet): string[] {
  const order = (sheet.budgetSplit ?? []).map((b) => b.geohash);
  if (order.length > 0) return order;
  const top = sheet.cards.liftMap.results.tiles.filter((t) => t.lift >= minLift()).sort((a, b) => b.lift - a.lift);
  return spreadTiles(top).slice(0, NARRATED_TILES).map((t) => t.geohash);
}

/** The numbered areas the web sheet and the exports draw from the tiles (lift >= 1.3; 3 km apart, no shared ZIP). */
function drawnNumbered(tiles: readonly LiftTile[]): string[] {
  return numberedTiles(tiles).map((t) => t.geohash);
}

function entryIndex(ledger: readonly LedgerEntry[]): Map<string, LedgerEntry> {
  return new Map(ledger.map((e) => [e.id, e]));
}

function relabelChips<T extends { chips: { label: string; ledgerRef: string }[] }>(row: T, multiAct: boolean, twinSize: (ref: string) => number | null): T {
  const chips = row.chips
    .filter((c) => multiAct || !/^most influenced by /.test(c.label))
    .map((c) => {
      if (!/^tonight vs house\b/.test(c.label)) return c;
      const delta = /([+-]?\d+) ranks?$/.exec(c.label);
      if (delta) return { ...c, label: usualCrowdChipLabel(Number(delta[1])) };
      const top = /top (\d+)$/.exec(c.label);
      return { ...c, label: usualCrowdChipLabel(null, top ? Number(top[1]) : (twinSize(c.ledgerRef) ?? 0)) };
    });
  return { ...row, chips };
}

function asOfYear(sheet: StreetSheet): number {
  const y = Number((sheet.createdAt ?? "").slice(0, 4));
  return Number.isFinite(y) && y > 1900 ? y : new Date().getUTCFullYear();
}

export function refreshSheet(input: StreetSheet, opts: RefreshOptions = {}): { sheet: StreetSheet; report: RefreshReport } {
  const gaz = opts.gazetteer ?? DEFAULT_GAZETTEER;
  const pins = opts.pins ?? loadTagPins();
  const categoryTags = categoryTagMap(pins);
  const sheet: StreetSheet = structuredClone(input);
  const report: RefreshReport = {
    renamedAreas: [],
    droppedPartners: [],
    droppedSpots: [],
    droppedWebsites: [],
    droppedPodcasts: [],
    backCatalogue: [],
    renamedSponsor: null,
    discovery: { before: input.discovery?.headline ?? null, after: null },
    needsLiveRun: [],
  };
  const entries = entryIndex(sheet.ledger ?? []);
  const resultCount = (ref: string | undefined) => (ref ? (entries.get(ref)?.resultCount ?? null) : null);
  const venue = { lat: sheet.bill.venue.lat, lon: sheet.bill.venue.lon };
  const multiAct = sheet.bill.acts.length >= 2;

  // ---- Sample sheets are hypothetical; live ones never ---------------------------------------
  if (sheet.mode === "live") sheet.hypothetical = false;

  // ---- Areas -------------------------------------------------------------------------------------
  const annotations = new Map<string, Annotated>();
  const annotate = (t: { geohash: string; lat: number; lon: number }): Annotated => {
    let a = annotations.get(t.geohash);
    if (!a) {
      const r = gaz.annotateTile({ lat: t.lat, lon: t.lon });
      a = {};
      if (r.name !== undefined) a.name = r.name;
      if (r.gazetteerName !== undefined) a.gazetteerName = r.gazetteerName;
      if (r.zctas !== undefined) a.zctas = r.zctas;
      if (r.adultPopulation !== undefined) a.adultPopulation = r.adultPopulation;
      if (r.state) a.state = r.state;
      annotations.set(t.geohash, a);
    }
    return a;
  };
  const oldTiles = sheet.cards.liftMap.results.tiles;
  const base = oldTiles.map((t) => {
    const a = annotate(t);
    const out: LiftTile = { ...t };
    if (a.name) out.name = a.name;
    else delete out.name;
    if (a.zctas) out.zctas = a.zctas;
    out.adultPopulation = a.adultPopulation ?? null;
    if (a.state) out.state = a.state;
    return out;
  });
  const numberedIds = storedNumbered(input);
  const byGh = new Map(base.map((t) => [t.geohash, t]));
  const nameSet = [...new Set([...numberedIds, ...drawnNumbered(base)])].map((g) => byGh.get(g)).filter((t): t is LiftTile => !!t);
  const named = new Map(disambiguateNames(nameSet, venue, (gh) => annotations.get(gh)?.gazetteerName).map((t) => [t.geohash, t]));
  const newTiles = base.map((t) => named.get(t.geohash) ?? t);
  oldTiles.forEach((t, i) => {
    const to = newTiles[i]?.name;
    if (t.name && to && t.name !== to) report.renamedAreas.push({ geohash: t.geohash, from: t.name, to });
  });
  sheet.cards.liftMap.results.tiles = newTiles;
  // The numbered areas the sheet now draws (the web sheet, the PDF and the CSVs number the tiles themselves): the
  // budget split follows them. Partners were searched in the first PARTNER_TILES of the old ones; when those
  // change, only a live run can search the new ones.
  const drawn = drawnNumbered(newTiles);
  if (drawn.join(",") !== numberedIds.join(",")) {
    const first = (ids: readonly string[]) => ids.slice(0, PARTNER_TILES).join(",");
    if (first(drawn) !== first(numberedIds)) {
      report.needsLiveRun.push(`The first ${PARTNER_TILES} numbered areas change with the new ZIP rules (${numberedIds.join(", ")} -> ${drawn.join(", ")}); partners were searched in the old ones.`);
    }
    report.numberedAreas = { before: numberedIds, after: drawn };
  }
  const drawnTiles = drawn.map((g) => byGh.get(g)).filter((t): t is LiftTile => !!t);
  if (sheet.budgetSplit && drawnTiles.length > 0) sheet.budgetSplit = splitBudget(drawnTiles);
  const tileName = new Map(newTiles.filter((t) => t.name).map((t) => [t.geohash, t.name as string]));
  const renames = report.renamedAreas.map((r) => ({ from: r.from, to: r.to }));

  // ---- Partners ------------------------------------------------------------------------------------
  const op = sheet.operator;
  const excluded = new Set((op.excludeCategories ?? []).map((k) => k.trim().toLowerCase()));
  if (op.allAges === true) for (const k of DEFAULT_BAR_CATEGORIES) excluded.add(k);
  const noBars = barsExcluded(excluded);
  const keepPlace = (e: QlooEntity, category: string): string | null => {
    if (isNonVenue(e)) return "not a business";
    if (isFoodStand(e)) return "a food cart or kiosk";
    if (excluded.has(category)) return `left out by type (${op.allAges === true ? "all-ages show" : "your exclusions"})`;
    if (noBars && isDrinkLed(e)) return `a drinking place by its name or tags (${op.allAges === true ? "all-ages show" : "your exclusions"})`;
    return null;
  };
  const twinSizeOf = (ref: string) => resultCount(ref);
  const partnersIn = sheet.cards.partners.results;
  const kept: Partner[] = [];
  for (const p of partnersIn) {
    const category = resolveCategory(p.entity, { categoryTags });
    const why = keepPlace(p.entity, category);
    if (why) {
      report.droppedPartners.push({ name: p.entity.name, why });
      continue;
    }
    const website = cleanWebsite(p.website ?? null, p.entity.name);
    if (p.website && !website) report.droppedWebsites.push({ name: p.entity.name, website: p.website });
    const row: Partner = relabelChips({ ...p, category, website }, multiAct, twinSizeOf);
    if (p.tileGeohash && tileName.has(p.tileGeohash)) row.tileName = tileName.get(p.tileGeohash) as string;
    kept.push(row);
  }
  if (report.droppedPartners.length > 0) {
    report.needsLiveRun.push(`${report.droppedPartners.length} partner(s) dropped; a live run would fill their places from the same Qloo lists.`);
  }

  // "Why this place", rebuilt with the current rules.
  const billNames = new Set(sheet.bill.acts.map((a) => a.name.toLowerCase()));
  const billTagIds = new Set(
    sheet.cards.resolution.results
      .filter((r) => r.entity && (billNames.has((r.input ?? "").toLowerCase()) || billNames.has(r.entity.name.toLowerCase())))
      .flatMap((r) => (r.entity?.tags ?? []).map((t) => t.id)),
  );
  const thinSignal = sheet.limits.some((l) => /^Thin signal/.test(l));
  const ectx: ExplainContext = {
    venue,
    day: op.streetTeamDays[0] ?? sheet.bill.weekday,
    days: op.streetTeamDays,
    listSize: kept.length,
    adultsOnly: sheet.bill.legalAgeEnforced === true && op.allAges !== true,
    thinSignal,
    billTagIds,
    tagCounts: partnerTagCounts(kept),
  };
  const explained = kept.map((p) => {
    const refs = p.explain?.ledgerRefs ?? [p.chips[0]?.ledgerRef ?? ""];
    const poolRef = refs[0] ?? p.chips[0]?.ledgerRef ?? "";
    const twinRef = refs[1] ?? p.chips.find((c) => isUsualCrowdChip(c.label))?.ledgerRef ?? null;
    const note = entries.get(poolRef)?.note ?? "";
    let areaName = p.tileGeohash ? tileName.get(p.tileGeohash) : undefined;
    if (!areaName && p.entity.location) areaName = gaz.annotateTile({ lat: p.entity.location.lat, lon: p.entity.location.lon }).name;
    const explain = explainPartner(
      {
        partner: p,
        poolSize: resultCount(poolRef) ?? 0,
        poolRef,
        twinRef,
        ...(twinRef && resultCount(twinRef) !== null ? { houseListSize: resultCount(twinRef) as number } : {}),
        widenedRadiusM: /\(3,500 m\)/.test(note) ? 3500 : null,
        widenedCategories: /\(more categories\)/.test(note),
        ...(areaName ? { areaName } : {}),
      },
      ectx,
    );
    return { ...p, explain };
  });
  const partnerCount = explained.length;
  const areaCount = new Set(explained.map((p) => p.tileGeohash ?? "near")).size;
  sheet.cards.partners.results = explained;
  sheet.cards.partners.summary = sheet.cards.partners.summary.replace(/^\d+ partners? in \d+ areas?/, `${partnerCount} ${partnerCount === 1 ? "partner" : "partners"} in ${areaCount} ${areaCount === 1 ? "area" : "areas"}`);
  if (sheet.popularityCheck) {
    sheet.popularityCheck = {
      ...sheet.popularityCheck,
      perArea: sheet.popularityCheck.perArea.map((a) => (a.tileGeohash && tileName.has(a.tileGeohash) ? { ...a, tileName: tileName.get(a.tileGeohash) as string } : a)),
    };
  }

  // ---- Before and after the show -----------------------------------------------------------------
  const spots: PrePostSpot[] = [];
  // One spot per chain brand, as a new run keeps them.
  const brands = new Set<string>();
  for (const s of sheet.cards.prePost.results) {
    const category = resolveCategory(s.entity, { categoryTags });
    const why = keepPlace(s.entity, category);
    if (why) {
      report.droppedSpots.push({ name: s.entity.name, why });
      continue;
    }
    if (s.chain) {
      const brand = normalizeChainName(s.entity.name);
      if (brands.has(brand)) {
        report.droppedSpots.push({ name: s.entity.name, why: "a second spot of the same chain" });
        continue;
      }
      brands.add(brand);
    }
    spots.push(relabelChips({ ...s, category, fanFacingAllowed: fanFacingAllowed(category, sheet.bill.legalAgeEnforced) }, multiAct, twinSizeOf));
  }
  const dist = (s: PrePostSpot) => (typeof s.entity.distanceM === "number" && Number.isFinite(s.entity.distanceM) ? s.entity.distanceM : haversineM(venue, s.entity.location ?? venue));
  const order = new Map(spots.map((s, i) => [s.entity.entityId, i]));
  spots.sort((a, b) => Number(a.chain === true) - Number(b.chain === true) || dist(a) - dist(b) || (order.get(a.entity.entityId) ?? 0) - (order.get(b.entity.entityId) ?? 0));
  sheet.cards.prePost.results = spots;
  const sameBrand = report.droppedSpots.filter((d) => d.why === "a second spot of the same chain").length;
  if (sameBrand > 0) recountSpots(sheet, sameBrand);
  const drinkSpots = report.droppedSpots.filter((d) => /^a drinking place/.test(d.why)).length;
  if (drinkSpots > 0) recountDrinkSpots(sheet, drinkSpots, op.allAges === true ? "all-ages show" : "your exclusions");

  // ---- Podcasts and the sponsor ------------------------------------------------------------------
  const media = sheet.cards.media.results;
  const podcasts = media.filter((m) => m.kind === "podcast");
  const chosen = pickPodcasts(podcasts, (m) => m.entity, asOfYear(sheet), podcasts.length);
  const keptPods = new Set(chosen.map((c) => c.item));
  for (const m of podcasts) if (!keptPods.has(m)) report.droppedPodcasts.push(m.entity.name);
  const mediaOut: MediaPick[] = [];
  for (const m of media) {
    if (m.kind === "podcast") {
      const c = chosen.find((x) => x.item === m);
      if (!c) continue;
      const chips = m.chips.filter((x) => !x.label.startsWith(BACK_CATALOGUE_CHIP));
      if (c.backCatalogue) {
        chips.push({ label: backCatalogueLabel(c.recency), ledgerRef: m.chips[0]?.ledgerRef ?? "" });
        report.backCatalogue.push(m.entity.name);
      }
      mediaOut.push({ ...m, chips });
    } else {
      const legal = typeof m.entity.properties?.legal_name === "string" ? (m.entity.properties.legal_name as string) : m.entity.name;
      const display = brandDisplayName({ ...m.entity, name: legal });
      if (display !== m.entity.name) {
        report.renamedSponsor = { from: m.entity.name, to: display };
        mediaOut.push({ ...m, entity: { ...m.entity, name: display, properties: { ...m.entity.properties, legal_name: legal } } });
      } else mediaOut.push(m);
    }
  }
  sheet.cards.media.results = mediaOut;
  if (report.droppedPodcasts.length > 0) {
    const n = mediaOut.filter((m) => m.kind === "podcast").length;
    sheet.cards.media.summary = sheet.cards.media.summary
      .replace(/^\d+ podcasts?/, `${n} ${n === 1 ? "podcast" : "podcasts"}`)
      .concat(` ${report.droppedPodcasts.length} ${report.droppedPodcasts.length === 1 ? "show" : "shows"} with no recent episodes left out.`);
  }
  const mediaRename = report.renamedSponsor ? [{ from: report.renamedSponsor.from, to: report.renamedSponsor.to }] : [];

  // ---- Words: area names, the sponsor, partner lines ------------------------------------------------
  const areaNames = newTiles.map((t) => t.name ?? "").filter(Boolean);
  const renameOnly = renamer([...renames, ...mediaRename]);
  const rename = (t: string) => tidyAreaPhrases(usualCrowdWording(renameOnly(t)), areaNames);
  if (sheet.narration) {
    const keptIds = new Set(explained.map((p) => p.entity.entityId));
    const lines = sheet.narration.partnerLines.filter((l) => keptIds.has(l.entityId)).map((l) => ({ ...l, text: rename(l.text) }));
    sheet.narration = {
      ...sheet.narration,
      summary: rename(sheet.narration.summary),
      tileWhy: sheet.narration.tileWhy.map((t) => ({ ...t, text: rename(t.text) })),
      partnerLines: partnerLinesWithinTags(lines, explained).lines,
    };
  }
  for (const key of Object.keys(sheet.cards) as (keyof StreetSheet["cards"])[]) {
    const card = sheet.cards[key] as { summary: string; reason?: string };
    card.summary = rename(card.summary);
    if (card.reason) card.reason = rename(card.reason);
  }
  if (sheet.steps) sheet.steps = mapStrings(sheet.steps, rename);

  // ---- The discovery ---------------------------------------------------------------------------------
  const diag = sheet.cards.liftMap.results.liftDiagnostics;
  const numbered = drawn.map((g) => newTiles.find((t) => t.geohash === g)).filter((t): t is LiftTile => !!t);
  const discovery: SheetDiscovery | null = pickDiscovery({
    tiles: newTiles,
    numbered: numbered.slice(0, NARRATED_TILES),
    baseline: sheet.cards.liftMap.results.diagnostics.baseline,
    liftTrusted: !!diag && diag.splitHalfSpearman !== null && diag.splitHalfSpearman > MIN_SPLIT_HALF && !diag.note,
    minLift: minLift(),
    billFloor: diag?.billFloor ?? MIN_BILL_PCT,
    ledgerRefs: sheet.cards.liftMap.provenance.slice(0, 2),
    partners: explained,
    twinSize: (p) => {
      const ref = p.chips.find((c) => isUsualCrowdChip(c.label))?.ledgerRef;
      return ref ? resultCount(ref) : null;
    },
    partnerRefs: (p) => p.explain?.ledgerRefs ?? p.chips.map((c) => c.ledgerRef),
  });
  if (discovery) sheet.discovery = discovery;
  else delete sheet.discovery;
  report.discovery.after = discovery?.headline ?? null;

  // ---- A revision's change list --------------------------------------------------------------------
  if (sheet.revision && !opts.parent) sheet.revision = mapStrings(sheet.revision, rename);
  // The checks a stored sheet is held to again (tile states, "near" the area, the narration guard, the Checks step,
  // the change list against the parent): the same pass the recorded plans get on their own.
  const checked = recheckSheet(sheet, { gazetteer: gaz, parent: opts.parent ?? null });
  return { sheet: checked.sheet, report };
}

export interface RecheckReport {
  /** Tiles whose point lies in another state than their first ZIP ("dqcjq4 Georgetown: DC, first ZIP says VA"). */
  states: { geohash: string; name: string; state: string; firstZip: string | null }[];
  droppedSpots: { name: string; why: string }[];
  droppedPartners: { name: string; why: string }[];
  /** Narration lines the guard replaced with the template's ("partnerLines[4]: says the place is near the room ..."). */
  replaced: string[];
  /** Partner lines that now say "near <area>" instead of "in" or "on" it. */
  nearArea: number;
  /** What else changed, in words ("partners reason", "guard step", "revise step", "change list"). */
  rewritten: string[];
}

/**
 * The checks a stored sheet can be held to again without changing what the run found: no rename, no re-scoring and no
 * re-categorising (that is refreshSheet). Offline and deterministic; what it changes, a run with today's code would
 * also have written:
 *
 *  - each tile's state from its own point ("Georgetown, DC": its nearest ZIP is in VA);
 *  - on a sheet with bars left out, spots and partners that are drinking places by their name or tags dropped, with
 *    the counts the sheet states following the list;
 *  - partner lines say "near <area>" (`partnerLinesNearArea`), then the narration guard (`vetNarration`) runs and a
 *    failing line is replaced by the template's, with the reason added to the guard's reasons, as a new run does;
 *  - the partners card's "aren't searched yet" line, the spots step's counts (from the list), the Checks step (by why
 *    each line went), the revise step's reader on a sheet whose note the rules read on purpose, and a revision's
 *    change list against its parent.
 */
export function recheckSheet(input: StreetSheet, opts: { gazetteer?: GazetteerLike; parent?: StreetSheet | null } = {}): { sheet: StreetSheet; report: RecheckReport } {
  const gaz = opts.gazetteer ?? DEFAULT_GAZETTEER;
  const sheet: StreetSheet = structuredClone(input);
  const report: RecheckReport = { states: [], droppedSpots: [], droppedPartners: [], replaced: [], nearArea: 0, rewritten: [] };
  const op = sheet.operator;

  // ---- Tile states from their own points ---------------------------------------------------------
  sheet.cards.liftMap.results.tiles = sheet.cards.liftMap.results.tiles.map((t) => {
    const state = gaz.annotateTile({ lat: t.lat, lon: t.lon }).state;
    if (!state) return t;
    const firstZip = stateFromZctas(t.zctas ?? []);
    if (firstZip !== state) report.states.push({ geohash: t.geohash, name: t.name ?? "", state, firstZip });
    return { ...t, state };
  });

  // ---- Drinking places on a sheet with bars left out ----------------------------------------------
  const excluded = new Set((op.excludeCategories ?? []).map((k) => k.trim().toLowerCase()));
  if (op.allAges === true) for (const k of DEFAULT_BAR_CATEGORIES) excluded.add(k);
  if (barsExcluded(excluded)) {
    const why = `a drinking place by its name or tags (${op.allAges === true ? "all-ages show" : "your exclusions"})`;
    const spots = sheet.cards.prePost.results.filter((s) => {
      if (!isDrinkLed(s.entity)) return true;
      report.droppedSpots.push({ name: s.entity.name, why });
      return false;
    });
    if (report.droppedSpots.length > 0) {
      sheet.cards.prePost.results = spots;
      recountDrinkSpots(sheet, report.droppedSpots.length, op.allAges === true ? "all-ages show" : "your exclusions");
    }
    const partners = sheet.cards.partners.results.filter((p) => {
      if (!isDrinkLed(p.entity)) return true;
      report.droppedPartners.push({ name: p.entity.name, why });
      return false;
    });
    if (report.droppedPartners.length > 0) {
      sheet.cards.partners.results = partners;
      const areas = new Set(partners.map((p) => p.tileGeohash ?? "near")).size;
      sheet.cards.partners.summary = sheet.cards.partners.summary.replace(
        /^\d+ partners? in \d+ areas?/,
        `${partners.length} ${partners.length === 1 ? "partner" : "partners"} in ${areas} ${areas === 1 ? "area" : "areas"}`,
      );
      const keep = new Set(partners.map((p) => p.entity.entityId));
      if (sheet.narration) sheet.narration = { ...sheet.narration, partnerLines: sheet.narration.partnerLines.filter((l) => keep.has(l.entityId)) };
    }
  }

  // ---- The partners card's skipped-kinds line -----------------------------------------------------
  const reason = sheet.cards.partners.reason;
  if (reason) {
    // "Record stores isn't searched yet: ... find them by.": the words are plural (skippedCategoriesReason).
    const fixed = reason.replace(/ isn't searched yet: Qloo has no tag to find them by\./g, " aren't searched yet: Qloo has no tag to find them by.");
    if (fixed !== reason) {
      sheet.cards.partners.reason = fixed;
      report.rewritten.push("partners reason");
    }
  }

  // ---- Narration: "near" the area, then the guard ----------------------------------------------------
  if (sheet.narration) {
    const near = partnerLinesNearArea(sheet.narration.partnerLines, sheet.cards.partners.results);
    report.nearArea = near.changed;
    sheet.narration = { ...sheet.narration, partnerLines: near.lines };
    if (!sheet.narration.templated) {
      const v = vetNarration(sheet);
      if (v.narration && v.replaced.length > 0) {
        sheet.narration = v.narration;
        report.replaced = v.replaced;
        sheet.guard = { ...sheet.guard, reasons: [...sheet.guard.reasons, ...v.replaced.map((r) => `replaced by the template: ${r}`)] };
      }
    }
  }

  // ---- Steps: the spots step follows the list; Checks by why each line went; the reader of a note the rules read
  // on purpose --------------------------------------------------------------------------------------------
  if (syncPrePostStep(sheet)) report.rewritten.push("spots step");
  if (sheet.steps) {
    const steps = sheet.steps.map((s) => {
      if (s.id === "guard") {
        const g = guardTrace(sheet.guard, sheet.guard.reasons, op.allAges === true);
        if (g.decision === s.decision) return s;
        report.rewritten.push("guard step");
        return { ...s, decision: g.decision };
      }
      if (s.id === REVISE_STEP_ID && s.cause && sheet.revision?.interpreter === "rules" && sheet.ledger.some((e) => e.kind === "anthropic")) {
        // A model was set up (the sheet's own ledger holds a Claude call): the rules read the note by choice.
        // Also the earlier wording with an unclosed aside ("Fixed rules read it, as they do on the hosted site and ...").
        const cause = s.cause.replace(/^Fixed rules read it(?: \(no model is set up here\)|, as they do on the hosted site,?)(?= and )/, RULES_CHOSEN_READER);
        if (cause === s.cause) return s;
        report.rewritten.push("revise step");
        return { ...s, cause };
      }
      return s;
    });
    sheet.steps = steps;
  }

  // ---- A revision's change list --------------------------------------------------------------------
  if (sheet.revision && opts.parent) {
    const settingRefs = sheet.revision.changes.find((c) => c.kind === "setting_changed")?.ledgerRefs ?? [];
    const changes = diffSheets(opts.parent, sheet, settingRefs);
    if (JSON.stringify(changes) !== JSON.stringify(sheet.revision.changes)) report.rewritten.push(`change list (${sheet.revision.changes.length} -> ${changes.length} rows)`);
    sheet.revision = { ...sheet.revision, changes };
  }
  return { sheet, report };
}

/**
 * After drinking places are dropped from the spots, the counts the sheet states follow the list: the spots card's
 * "8 spots ..." (and its chain sentence), the step's "Picked 8 spots", and the summary's "8 spots for before and after
 * the show". Each spot's share of the crowd stays as the run computed it.
 */
function recountDrinkSpots(sheet: StreetSheet, dropped: number, why: string): void {
  const n = sheet.cards.prePost.results.length;
  const word = (x: number) => (x === 1 ? "spot" : "spots");
  const chains = sheet.cards.prePost.results.filter((s) => s.chain === true).length;
  const left = `Left out ${dropped === 1 ? "1 place that is a bar by its" : `${dropped} places that are bars by their`} name or tags (${why}).`;
  sheet.cards.prePost.summary = `${sheet.cards.prePost.summary
    .replace(/^\d+ spots?\b/, `${n} ${word(n)}`)
    .replace(/\b\d+ of \d+ spots? (is a national chain|are national chains)/, () => `${chains} of ${n} ${word(n)} ${chains === 1 ? "is a national chain" : "are national chains"}`)} ${left}`;
  if (sheet.steps) {
    sheet.steps = sheet.steps.map((s) =>
      s.id === "prepost" ? { ...s, decision: s.decision.replace(/^Picked \d+ spots?\b/, `Picked ${n} ${word(n)}`), cause: `${s.cause ? `${s.cause} ` : ""}${left}` } : s,
    );
  }
  if (sheet.narration?.summary) {
    sheet.narration = { ...sheet.narration, summary: sheet.narration.summary.replace(/\b\d+ spots? for before and after the show/, `${n} ${word(n)} for before and after the show`) };
  }
}

/**
 * After a second spot of the same chain is dropped, the counts the sheet states follow the list: the spots card's
 * "7 spots ..." and its chain sentence, and the summary's "lists 7 spots for before and after the show".
 */
function recountSpots(sheet: StreetSheet, dropped: number): void {
  const spots = sheet.cards.prePost.results;
  const n = spots.length;
  const kept = spots.filter((s) => s.chain === true).length;
  const word = (x: number) => (x === 1 ? "spot" : "spots");
  let summary = sheet.cards.prePost.summary.replace(/^\d+ spots?\b/, `${n} ${word(n)}`);
  summary = summary.replace(
    /\d+ of \d+ spots? (?:is a national chain|are national chains), listed last: no local place filled (?:its|their) slot/,
    `${kept} of ${n} ${word(n)} ${kept === 1 ? "is a national chain" : "are national chains"}, listed last: no local place filled ${kept === 1 ? "its" : "their"} slot`,
  );
  const same = `${dropped} as a second spot of a brand already listed`;
  const left = /(\d+) more chains? left off(?::([^.]*))?\./.exec(summary);
  if (left) {
    const total = Number(left[1]) + dropped;
    const detail = left[2] ? `${left[2].trim()}, ${same}` : same;
    summary = summary.replace(left[0], `${total} more ${total === 1 ? "chain" : "chains"} left off: ${detail}.`);
  }
  sheet.cards.prePost.summary = summary;
  syncPrePostStep(sheet);
  if (sheet.narration?.summary) {
    sheet.narration = { ...sheet.narration, summary: sheet.narration.summary.replace(/\b\d+ spots? for before and after the show/, `${n} ${word(n)} for before and after the show`) };
  }
}

/**
 * The spots step follows the list, as the card does: "Picked 6 spots", "Listed 1 national chain last ... its slot",
 * and a second spot of a brand the card says was left off. True when the step changed.
 */
function syncPrePostStep(sheet: StreetSheet): boolean {
  if (!sheet.steps) return false;
  const spots = sheet.cards.prePost.results;
  const n = spots.length;
  const chains = spots.filter((s) => s.chain === true).length;
  const word = (x: number) => (x === 1 ? "spot" : "spots");
  const same = /\b(\d+) as a second spot of a brand already listed\b/.exec(sheet.cards.prePost.summary);
  let changed = false;
  sheet.steps = sheet.steps.map((s) => {
    if (s.id !== "prepost") return s;
    const decision = s.decision.replace(/^Picked \d+ spots?\b/, `Picked ${n} ${word(n)}`);
    let cause = s.cause;
    if (cause) {
      const listed = /Listed \d+ national chains? last, after the local spots: no local spot filled (?:its|their) slot(; left off|\.)?/;
      if (chains > 0) {
        cause = cause.replace(listed, (_m, tail: string | undefined) => `Listed ${chains} national ${chains === 1 ? "chain" : "chains"} last, after the local spots: no local spot filled ${chains === 1 ? "its" : "their"} slot${tail ?? ""}`);
      } else if (listed.test(cause)) {
        // No chain is listed any more: the clause goes, and what it led into starts the sentence.
        cause = cause.replace(listed, (_m, tail: string | undefined) => (tail === "; left off" ? "Left off" : "")).replace(/\s{2,}/g, " ").trim();
      }
      if (same && !/second spot of a brand already listed/.test(cause)) cause = `${cause} Left off ${same[1]} more as a second spot of a brand already listed.`;
    }
    if (decision === s.decision && cause === s.cause) return s;
    changed = true;
    return { ...s, decision, ...(cause !== undefined ? { cause } : {}) };
  });
  return changed;
}
