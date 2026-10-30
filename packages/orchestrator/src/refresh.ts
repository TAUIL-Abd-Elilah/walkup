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
import { aboutTimes, type LedgerEntry, type LiftTile, type MediaPick, type Partner, type PrePostSpot, type QlooEntity, type SheetDiscovery, type StreetSheet } from "@walkup/contracts";
import { annotateTile, stateFromZctas } from "@walkup/gazetteer";
import { anBeforeNumber, classificationWording, liftFigureStyle, vetNarration, vetSheetHooks } from "@walkup/narrator";
import {
  activationFor,
  backCatalogueLabel,
  barsExcluded,
  brandDisplayName,
  BACK_CATALOGUE_CHIP,
  chainSkippedAhead,
  chainTailInPlaces,
  CHAINS_ASIDE,
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
  narrateStep,
  PARTNER_DEFAULTS,
  partnerTagCounts,
  pickDiscovery,
  normalizeChainName,
  pickPodcasts,
  propString,
  resolveCategory,
  roundTo,
  summaryReplaced,
  usualCrowdChipLabel,
  type ExplainContext,
} from "@walkup/engine";
import { diffSheets } from "./revise/diff";
import { REVISE_STEP_ID, RULES_CHOSEN_READER } from "./revise/step";
import { splitBudget } from "./steps/budget";
import { partnerLineReason, partnerLinesNearArea, partnerLinesWithinTags, tidyAreaPhrases, usualCrowdWording } from "./steps/copy";
import { guardTrace } from "./steps/trace";
import { CHAIN_DETECT_LIMIT, CHAIN_DETECT_LIMIT_BEFORE, PARTNER_TILES, PARTNERS_COUNT_LINE_RE, partnersCountLine } from "./steps/partners";
import { disambiguateNames, liftCountLine, MIN_BILL_PCT, MIN_SPLIT_HALF, NARRATED_TILES, numberedTiles, spreadTiles } from "./steps/heat";
import { categoryTagMap, loadTagPins, type TagPins } from "./tags";
import type { GazetteerLike } from "./types";

export interface RefreshOptions {
  /** Default: the offline gazetteer in data/gazetteer/out. */
  gazetteer?: GazetteerLike;
  /** Tag pins for the category fallback. Default: config/tags.json. */
  pins?: TagPins;
  /** The parent sheet (already refreshed) of a revision, to rebuild its change list. */
  parent?: StreetSheet | null;
  /** The kinds the show's other recorded runs gave a place (see `RecheckOptions`). */
  recordedKinds?: (entityId: string) => readonly string[];
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

/** Most partners of one kind in one area: select()'s cap, which the sheet states ("at most 2 of a kind per area"). */
const KIND_CAP_PER_AREA = PARTNER_DEFAULTS.maxPerCategoryPerTile;

/** Areas listing more partners of one kind than the cap allows, in words ("dqcjrm: 3 restaurant"). Empty when none. */
export function kindsOverCap(sheet: Pick<StreetSheet, "cards">): string[] {
  const count = new Map<string, number>();
  for (const p of sheet.cards.partners.results) {
    const key = `${p.tileGeohash ?? "near the venue"}: ${p.category}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  return [...count].filter(([, n]) => n > KIND_CAP_PER_AREA).map(([key, n]) => key.replace(": ", `: ${n} `));
}

/**
 * A partner's website by today's rule (`cleanWebsite`), read as a new run reads it: from the place's own record, else
 * the link the sheet holds. A link the rule no longer accepts (not the place's own, or a dead site or page) goes.
 */
function partnerWebsite(p: Pick<Partner, "website" | "entity">): string | null {
  return cleanWebsite(propString(p.entity, "website", "url") ?? p.website ?? null, p.entity.name);
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
  // Kinds per area as the run picked them (select() lists at most 2 of a kind per area).
  const kindKey = (p: Partner, kind: string) => `${p.tileGeohash ?? "near"}\u0000${kind}`;
  const kinds = new Map<string, number>();
  for (const p of partnersIn) kinds.set(kindKey(p, p.category), (kinds.get(kindKey(p, p.category)) ?? 0) + 1);
  for (const p of partnersIn) {
    // The kind read again from the stored tags, unless that would list a third of a kind in the area: the run picked
    // the place under its stored kind, and the stored tags may lack what made it that kind (the data policy removes
    // some tags before storage).
    const reread = resolveCategory(p.entity, { categoryTags });
    let category = p.category;
    if (reread !== p.category && (kinds.get(kindKey(p, reread)) ?? 0) < KIND_CAP_PER_AREA) {
      kinds.set(kindKey(p, p.category), (kinds.get(kindKey(p, p.category)) ?? 0) - 1);
      kinds.set(kindKey(p, reread), (kinds.get(kindKey(p, reread)) ?? 0) + 1);
      category = reread;
    }
    const why = keepPlace(p.entity, category);
    if (why) {
      report.droppedPartners.push({ name: p.entity.name, why });
      continue;
    }
    const website = partnerWebsite(p);
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
    ...(sheet.cards.liftMap.results.diagnostics.baseline === "none" || newTiles.length === 0 ? { noLiftMap: true } : {}),
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
  sheet.cards.partners.results = explained;
  sheet.cards.partners.summary = sheet.cards.partners.summary.replace(PARTNERS_COUNT_LINE_RE, partnersCountLine(explained));
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
  const checked = recheckSheet(sheet, { gazetteer: gaz, parent: opts.parent ?? null, ...(opts.recordedKinds ? { recordedKinds: opts.recordedKinds } : {}) });
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
  /** Partners whose kind went back to the one a run recorded, so no area lists more than 2 of a kind. */
  kinds: { name: string; from: string; to: string }[];
  /** Areas that still list more than 2 of a kind ("dqcjrm: 3 restaurant"): a recorded sheet must have none. */
  overCap: string[];
  /** Partner websites the rule now keeps or drops ("dropped: The Sweet Lobby", "kept: Avenue Ale House"). */
  websites: string[];
  /** What else changed, in words ("partners reason", "guard step", "revise step", "change list"). */
  rewritten: string[];
}

export interface RecheckOptions {
  gazetteer?: GazetteerLike;
  parent?: StreetSheet | null;
  /**
   * The kinds other recorded runs of the same show gave a place (by entity id): its parent's and the other changes'.
   * Used only for an area that lists more than 2 of a kind (see `recheckSheet`).
   */
  recordedKinds?: (entityId: string) => readonly string[];
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
 *  - "about N times" in the template's area lines and summary and in the heat step's "Put X first" follows the one
 *    rule (`aboutTimes`: the sheet's 2-decimal lift, half up), so an area never reads two figures; Claude's lines
 *    are left to the guard (`liftFiguresByRule`), apart from the text-only fixes narrate() now makes: "an 82nd" for
 *    "a 82nd", "about 2.0 times" for "about 2 times" where 2.0 is the area's figure, and "this R&B show" for "this
 *    Music / R&B show" (`modelLineWording`);
 *  - Claude's fan copy held to the copy checks narrate()'s guard runs: a line that calls the room small from a taste
 *    tag ("a cozy room") is dropped and counted, and the copy card and the Summary step say how many lines are left
 *    (`dropCopyHooks`);
 *  - at most 2 of a kind per area, as select() picked them: a place whose kind was read again after the run (from
 *    stored tags the data policy had already trimmed) gets back the kind another recorded run of the same show gave
 *    it (`opts.recordedKinds`), with that kind's ask; an area still over the cap is reported in `overCap`;
 *  - partner websites by today's rule (`cleanWebsite`): a dead site or page on the checked list goes, and a place's
 *    own site the rule now recognises comes back from its own record;
 *  - the partners card's opening count and "aren't searched yet" line, partner chains "listed last in their area"
 *    (card and step: the list is grouped by area), the spots step's counts (from the list), the Summary step (when
 *    fixed wording replaced Claude's summary), the Checks step (by why each line went and what was replaced, a dropped
 *    summary among the replaced), the guard's "15 partner lines trimmed" (was "line(s)"), the chain limit that now
 *    names the shared-website signal ("the same name or website at 3 or more places"), chain lists whose "and 7
 *    more" counted brands (now places), the acts card's "1 of 1 acts resolved" (now "act"), a ledger note that
 *    repeats its node's name, the revise step's reader on a sheet whose note the rules read on purpose, and a
 *    revision's change list against its parent;
 *  - the Summary step's count of fan copy lines only when it is a full set (Claude may have drafted more than the
 *    checks kept), the lift card's count said as the areas that pass both tests (`liftCountWording`), and "Why this
 *    one" saying "national chains aside" when a chain the rule skipped ranks higher (`discoveryChainsAside`).
 */
export function recheckSheet(input: StreetSheet, opts: RecheckOptions = {}): { sheet: StreetSheet; report: RecheckReport } {
  const gaz = opts.gazetteer ?? DEFAULT_GAZETTEER;
  const sheet: StreetSheet = structuredClone(input);
  const report: RecheckReport = { states: [], droppedSpots: [], droppedPartners: [], replaced: [], nearArea: 0, kinds: [], overCap: [], websites: [], rewritten: [] };
  const op = sheet.operator;

  // ---- Ledger notes: a note that repeats its node's name ("node Q3 house roster (Ticketmaster); node Q3 house roster
  // (Ticketmaster); the parent sheet's answer ...") says it once ----------------------------------------------------
  let notes = 0;
  sheet.ledger = sheet.ledger.map((e) => {
    const note = e.note?.replace(/^(node [^;]+)(?:; \1)+(?=;|$)/, "$1");
    if (note === undefined || note === e.note) return e;
    notes++;
    return { ...e, note };
  });
  if (notes > 0) report.rewritten.push(`ledger note${notes === 1 ? "" : "s"} (${notes})`);

  // ---- Guard reasons: "15 partner line(s) trimmed: ..." counts as a run now writes it ("15 partner lines") ---------
  const guardReasons = sheet.guard.reasons.map(partnerLineReason);
  if (guardReasons.some((r, i) => r !== sheet.guard.reasons[i])) {
    sheet.guard = { ...sheet.guard, reasons: guardReasons };
    report.rewritten.push("guard reasons");
  }

  // ---- The chain limit names the shared-website signal too, as a run now writes it --------------------------
  for (const key of ["partners", "prePost"] as const) {
    const card = sheet.cards[key];
    if (!card.limits.includes(CHAIN_DETECT_LIMIT_BEFORE)) continue;
    card.limits = card.limits.map((l) => (l === CHAIN_DETECT_LIMIT_BEFORE ? CHAIN_DETECT_LIMIT : l));
    report.rewritten.push(`${key} chain limit`);
  }

  // ---- At most 2 of a kind per area ----------------------------------------------------------------
  const adultsOnly = sheet.bill.legalAgeEnforced === true && op.allAges !== true;
  const kindKey = (p: Pick<Partner, "tileGeohash">, kind: string) => `${p.tileGeohash ?? "near"}\u0000${kind}`;
  const kindCount = new Map<string, number>();
  for (const p of sheet.cards.partners.results) kindCount.set(kindKey(p, p.category), (kindCount.get(kindKey(p, p.category)) ?? 0) + 1);
  if ([...kindCount.values()].some((n) => n > KIND_CAP_PER_AREA)) {
    // The run picked the higher-scored places first, so the lowest-scored of a kind over the cap is the one to fix.
    const order = sheet.cards.partners.results.map((p, i) => ({ p, i })).sort((a, b) => a.p.score - b.p.score || b.i - a.i);
    for (const { p, i } of order) {
      if ((kindCount.get(kindKey(p, p.category)) ?? 0) <= KIND_CAP_PER_AREA) continue;
      const to = (opts.recordedKinds?.(p.entity.entityId) ?? []).find((k) => k !== p.category && (kindCount.get(kindKey(p, k)) ?? 0) < KIND_CAP_PER_AREA);
      if (!to) continue;
      const row: Partner = { ...p, category: to };
      if (p.explain && p.explain.activation === activationFor(p.category, { adultsOnly })) row.explain = { ...p.explain, activation: activationFor(to, { adultsOnly }) };
      sheet.cards.partners.results[i] = row;
      kindCount.set(kindKey(p, p.category), (kindCount.get(kindKey(p, p.category)) ?? 0) - 1);
      kindCount.set(kindKey(p, to), (kindCount.get(kindKey(p, to)) ?? 0) + 1);
      report.kinds.push({ name: p.entity.name, from: p.category, to });
    }
  }
  report.overCap = kindsOverCap(sheet);

  // ---- Websites by today's rule -----------------------------------------------------------------------
  sheet.cards.partners.results = sheet.cards.partners.results.map((p) => {
    const website = partnerWebsite(p);
    if (website === (p.website ?? null)) return p;
    report.websites.push(`${website ? "kept" : "dropped"}: ${p.entity.name}`);
    return { ...p, website };
  });

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
      const keep = new Set(partners.map((p) => p.entity.entityId));
      if (sheet.narration) sheet.narration = { ...sheet.narration, partnerLines: sheet.narration.partnerLines.filter((l) => keep.has(l.entityId)) };
    }
  }

  // ---- The partners card's opening count follows the list (a near-venue list is not an area) ---------------
  const counted = sheet.cards.partners.summary.replace(PARTNERS_COUNT_LINE_RE, partnersCountLine(sheet.cards.partners.results));
  if (counted !== sheet.cards.partners.summary) {
    sheet.cards.partners.summary = counted;
    report.rewritten.push("partners count");
  }

  // ---- Partner chains are last in their own area, not on the whole list (the list is grouped by area) -----------
  const perArea = sheet.cards.partners.results.some((p) => p.tileGeohash);
  if (perArea) {
    const chainLine = chainsLastInArea(sheet.cards.partners.summary);
    if (chainLine !== sheet.cards.partners.summary) {
      sheet.cards.partners.summary = chainLine;
      report.rewritten.push("partners chain order");
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

  // ---- "About N times" by the one rule (`aboutTimes`), in the lines the code wrote: template lines and the heat step --
  report.rewritten.push(...liftFiguresByRule(sheet));
  // ---- Claude's lines as a run now writes them: "an 82nd", "about 2.0 times" --------------------------------------
  report.rewritten.push(...modelLineWording(sheet));

  // ---- Fan copy: the lines narrate()'s guard now drops ("a cozy room" from a taste tag), dropped as a run would ---
  const hooksBefore = { n: sheet.cards.copyHooks.results.length, status: sheet.cards.copyHooks.status };
  report.rewritten.push(...dropCopyHooks(sheet));

  // ---- The copy lines card: one line is not "each" -------------------------------------------------------
  const hooksSummary = sheet.cards.copyHooks.summary.replace(/^1 line, each built only /, "1 line, built only ");
  if (hooksSummary !== sheet.cards.copyHooks.summary) {
    sheet.cards.copyHooks.summary = hooksSummary;
    report.rewritten.push("copy lines count");
  }

  // ---- The acts card: "1 of 1 acts resolved" reads "1 of 1 act resolved", as a run now writes it --------------
  const actsSummary = sheet.cards.resolution.summary.replace(/^(\d+) of 1 acts resolved\b/, "$1 of 1 act resolved");
  if (actsSummary !== sheet.cards.resolution.summary) {
    sheet.cards.resolution.summary = actsSummary;
    report.rewritten.push("acts count");
  }

  // ---- The lift card's count says what it counts: the areas that pass both tests (the Lift map step's own words) --
  if (liftCountWording(sheet)) report.rewritten.push("lift card count");

  // ---- "Start with this place": a national chain the rule skipped ranks higher, so the "why" says chains are aside --
  if (discoveryChainsAside(sheet)) report.rewritten.push("discovery why");

  // ---- Steps: the spots step follows the list; Summary and Checks by what the checks replaced and why each line
  // went; chain lists counted in places; the reader of a note the rules read on purpose ----------------------------
  if (syncPrePostStep(sheet)) report.rewritten.push("spots step");
  if (sheet.steps) {
    const hooks = sheet.cards.copyHooks;
    const steps = sheet.steps.map((s) => {
      if (s.id === "guard") {
        const g = guardTrace(sheet.guard, sheet.guard.reasons, op.allAges === true);
        if (g.decision === s.decision) return s;
        report.rewritten.push("guard step");
        return { ...s, decision: g.decision };
      }
      if (s.id === "narrate" && sheet.narration && !sheet.narration.templated) {
        // Only the step's own wording ("Claude wrote the summary and 3 fan copy lines ..."), said again with the copy
        // lines left now and, when fixed wording replaced Claude's summary, saying so.
        const step = (n: number, status: typeof hooks.status, replaced: boolean) =>
          narrateStep({ templated: false, hooks: n, hooksStatus: status, summaryReplaced: replaced, ledgerRefs: s.ledgerRefs });
        // Also the wording before a step stopped counting kept lines as written ("Claude wrote ... and 2 fan copy
        // lines" when Claude drafted 3): the full-set wording, which still counts.
        const was = [false, true].find((r) => step(hooksBefore.n, hooksBefore.status, r).decision === s.decision || step(hooksBefore.n, "ok", r).decision === s.decision);
        if (was === undefined) return s;
        const replacedNow = was || summaryReplaced(sheet.guard.reasons);
        const hooksDropped = hooks.results.length !== hooksBefore.n;
        if (!hooksDropped) {
          const decision = step(hooksBefore.n, hooksBefore.status, replacedNow).decision;
          if (decision === s.decision) return s;
          report.rewritten.push(replacedNow !== was ? "summary step" : "summary step copy count");
          return { ...s, decision };
        }
        if (replacedNow !== was) report.rewritten.push("summary step");
        report.rewritten.push("copy lines step");
        const now = step(hooks.results.length, hooks.status, replacedNow);
        const out: typeof s = { ...s, decision: now.decision, status: now.status };
        if (now.cause) out.cause = now.cause;
        else delete out.cause;
        return out;
      }
      if ((s.id === "partners" || s.id === "prepost") && s.cause) {
        let cause = chainTailInPlaces(s.cause);
        if (cause !== s.cause) report.rewritten.push(`${s.id === "partners" ? "partners" : "spots"} step chain count`);
        if (s.id === "partners" && perArea) {
          const inArea = chainsLastInArea(cause);
          if (inArea !== cause) report.rewritten.push("partners step chain order");
          cause = inArea;
        }
        return cause === s.cause ? s : { ...s, cause };
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

/** The template's figure before the one rule: the 2-decimal lift through toFixed(1), so 2.15 (a float under it) read 2.1. */
function templateFigureBefore(lift: number): string {
  return (Math.round(lift * 100) / 100).toFixed(1);
}

/** The heat step's figure before the one rule: the raw lift to one decimal, so 2.4477 read 2.4 beside the sheet's 2.45x. */
function stepFigureBefore(lift: number): string {
  return roundTo(lift, 1).toFixed(1);
}

/** Percentile on a 0..100 scale, as the template prints it. */
function pct100(v: number): number {
  return Math.round(v <= 1 ? v * 100 : v);
}

/** The template's line for one area: "About 2.1 times <baseline>. 86th percentile for this crowd, 13th for <baseline>." */
const TEMPLATE_TILE_LINE = /^About (\d+\.\d) times (.+?)\. (\d+)(?:st|nd|rd|th) percentile for this crowd, (\d+)(?:st|nd|rd|th) for (.+)\.$/;
/** The template summary's strongest area: "...; the strongest, Highwood, is about 2.5 times" or "...: Highwood, about 2.5 times". */
const TEMPLATE_SUMMARY_TOP = /(This crowd stands out from .+? in \d+ areas?(?:; the strongest(?:, (.+?),)? is|: (.+?),) about )(\d+\.\d)( times )/;
const HEAT_DECISION = /^(Put (.+) first: about )(\d+\.\d)( times )/;

/**
 * "About N times" as a run now writes it (`aboutTimes`: the sheet's 2-decimal lift, half up), in the lines the code
 * wrote from the area's own lift: the template's area lines, the template summary's strongest area and the heat step's
 * "Put X first". A line is rewritten only when it is the code's own wording with the figure the old rule gave that
 * area, so a line Claude wrote is never touched (the guard handles those). Returns what changed, for the report.
 */
function liftFiguresByRule(sheet: StreetSheet): string[] {
  const out: string[] = [];
  const tiles = sheet.cards.liftMap.results.tiles;
  const byHash = new Map(tiles.map((t) => [t.geohash, t]));
  const n = sheet.narration;
  if (n) {
    let lines = 0;
    const tileWhy = n.tileWhy.map((w) => {
      const t = byHash.get(w.geohash);
      const m = TEMPLATE_TILE_LINE.exec(w.text);
      if (!t || !m || m[2] !== m[5] || Number(m[3]) !== pct100(t.billPct) || Number(m[4]) !== pct100(t.housePct)) return w;
      if (m[1] !== templateFigureBefore(t.lift) || m[1] === aboutTimes(t.lift)) return w;
      lines++;
      return { ...w, text: w.text.replace(/^About \d+\.\d times /, `About ${aboutTimes(t.lift)} times `) };
    });
    if (lines > 0) out.push(`area line figure${lines === 1 ? "" : "s"} (${lines})`);
    let summary = n.summary;
    // The template's summary: a templated run, or Claude's summary the guard replaced with it.
    if (n.templated || summaryReplaced(sheet.guard.reasons)) {
      // The template names the strongest of the narrated areas (lift, then geohash).
      const narrated = n.tileWhy.map((w) => byHash.get(w.geohash)).filter((t): t is LiftTile => t !== undefined);
      const top = [...(narrated.length > 0 ? narrated : numberedTiles(tiles))].sort((a, b) => b.lift - a.lift || a.geohash.localeCompare(b.geohash))[0];
      const m = TEMPLATE_SUMMARY_TOP.exec(summary);
      const name = m?.[2] ?? m?.[3];
      if (top && m && (name === undefined || name === top.name) && m[4] === templateFigureBefore(top.lift) && m[4] !== aboutTimes(top.lift)) {
        summary = summary.replace(m[0], `${m[1]}${aboutTimes(top.lift)}${m[5]}`);
        out.push("summary figure");
      }
    }
    if (lines > 0 || summary !== n.summary) sheet.narration = { ...n, summary, tileWhy };
  }
  if (sheet.steps) {
    // The run's "first" area is its highest-lift numbered area.
    const first = numberedTiles(tiles)[0];
    sheet.steps = sheet.steps.map((s) => {
      const m = s.id === "heat" ? HEAT_DECISION.exec(s.decision) : null;
      if (!first || !m || m[2] !== (first.name ?? "Area 1")) return s;
      if (m[3] !== stepFigureBefore(first.lift) || m[3] === aboutTimes(first.lift)) return s;
      out.push("lift map step figure");
      return { ...s, decision: s.decision.replace(m[0], `${m[1]}${aboutTimes(first.lift)}${m[4]}`) };
    });
  }
  return out;
}

/**
 * The wording narrate() now gives Claude's lines, text only: "a 82nd percentile" reads "an 82nd percentile"
 * (`anBeforeNumber`), and an area line's "about 2 times" for an area at 2.04 reads "about 2.0 times", the figure the
 * sheet and the calendar print (`liftFigureStyle`). No number, name or claim changes. Returns what changed.
 */
function modelLineWording(sheet: StreetSheet): string[] {
  const n = sheet.narration;
  if (!n || n.templated) return [];
  const lifts = new Map(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t.lift]));
  let articles = 0;
  let figures = 0;
  let genres = 0;
  const an = (text: string) => {
    const named = classificationWording(text, sheet.bill.classification);
    if (named !== text) genres++;
    const out = anBeforeNumber(named);
    if (out !== named) articles++;
    return out;
  };
  const tileWhy = n.tileWhy.map((w) => {
    const text = an(w.text);
    const styled = liftFigureStyle(text, lifts.get(w.geohash) ?? Number.NaN);
    if (styled !== text) figures++;
    return styled === w.text ? w : { ...w, text: styled };
  });
  const summary = an(n.summary);
  const partnerLines = n.partnerLines.map((l) => {
    const text = an(l.text);
    return text === l.text ? l : { ...l, text };
  });
  if (articles === 0 && figures === 0 && genres === 0) return [];
  sheet.narration = { ...n, summary, tileWhy, partnerLines };
  return [
    ...(articles > 0 ? [`"an" before a number (${articles})`] : []),
    ...(figures > 0 ? [`"about N.0 times" (${figures})`] : []),
    ...(genres > 0 ? [`genre as the header gives it (${genres})`] : []),
  ];
}

/** The lift card's count as runs stored it: "20 areas where this bill's crowd ranks higher than the room's usual crowd." */
const LIFT_COUNT_BEFORE = /^([\d,]+) areas? where this bill's crowd ranks higher than (.+?)\.(?= |$)/;
/** The Lift map step's two tests: "20 areas pass both tests: at least 1.3 times ..., and percentile 70 or higher ...". */
const BOTH_TESTS = /^([\d,]+) areas? pass(?:es)? both tests: at least (\d+(?:\.\d+)?) times .+?, and percentile (\d+) or higher\b/;

/**
 * The lift card's count as a run now says it (`liftCountLine`): the areas that pass both tests, in the Lift map step's
 * own numbers ("20 areas pass both tests (lift 1.3 or more against the room's usual crowd, percentile 70 or higher for
 * this crowd)"). Only when the step counts the same areas; the count itself never changes. True when the card changed.
 */
function liftCountWording(sheet: StreetSheet): boolean {
  const card = sheet.cards.liftMap;
  const m = LIFT_COUNT_BEFORE.exec(card.summary);
  const cause = sheet.steps?.find((s) => s.id === "heat")?.cause;
  const t = cause ? BOTH_TESTS.exec(cause) : null;
  if (!m || !t || m[1] !== t[1]) return false;
  card.summary = card.summary.replace(m[0], liftCountLine(Number(m[1]!.replace(/,/g, "")), m[2]!, Number(t[2]), Number(t[3])));
  return true;
}

/** The partner rule's "why" up to its area: "the highest-ranked place for this crowd in area 2 (no place in area 1 qualified)". */
const PARTNER_WHY_AREA = /^(the highest-ranked place for this crowd in area (\d+)(?: \([^)]*\))?)( that )/;

/**
 * "Why this one" as a run now writes it (`partnerDiscovery`): when a national chain the rule skipped would have
 * qualified ahead of the pick (it ranks higher in the pick's area, or sits in an earlier area), the line says
 * "national chains aside", so it never calls the pick the highest-ranked place over a chain the sheet lists higher.
 * Text only: the pick, its ranks and the gap stay. True when the line changed.
 */
function discoveryChainsAside(sheet: StreetSheet): boolean {
  const d = sheet.discovery;
  if (!d || d.kind !== "partner" || !d.why || d.why.includes(CHAINS_ASIDE)) return false;
  const m = PARTNER_WHY_AREA.exec(d.why);
  const pick = sheet.cards.partners.results.find((p) => p.entity.entityId === d.entityId);
  if (!m || !pick) return false;
  // The areas in the order the run walked them; the line's area number must be the pick's own area there.
  const order = storedNumbered(sheet);
  const number = Number(m[2]);
  if (order[number - 1] !== pick.tileGeohash) return false;
  const entries = entryIndex(sheet.ledger ?? []);
  const twinSize = (p: Partner) => {
    const ref = p.chips.find((c) => isUsualCrowdChip(c.label))?.ledgerRef;
    return ref ? (entries.get(ref)?.resultCount ?? null) : null;
  };
  if (!chainSkippedAhead({ partners: sheet.cards.partners.results, pick, areasBefore: order.slice(0, number - 1), twinSize })) return false;
  sheet.discovery = { ...d, why: d.why.replace(m[0], `${m[1]}${CHAINS_ASIDE}${m[3]}`) };
  return true;
}

/**
 * Claude's fan copy held to the copy checks narrate()'s guard runs now (`vetSheetHooks`): a line that calls the room
 * small from a taste tag ("a cozy room") is dropped, with the guard's reason added to the guard's reasons and counted
 * as dropped, and the card says what a run with that many lines says ("2 lines, each built only from approved Qloo
 * tags.", partial below 3). Kept lines are left as stored. A sheet the template wrote, or one that would keep no
 * line, is left as it is (the page then shows its one fallback line). Returns what changed.
 */
function dropCopyHooks(sheet: StreetSheet): string[] {
  if (!sheet.narration || sheet.narration.templated) return [];
  const card = sheet.cards.copyHooks;
  const { reasons } = vetSheetHooks(sheet);
  const gone = new Set(reasons.map((r) => Number(/^copyHooks\[(\d+)\]/.exec(r)?.[1] ?? Number.NaN)).filter(Number.isInteger));
  if (gone.size === 0 || gone.size >= card.results.length) return [];
  const kept = card.results.filter((_h, i) => !gone.has(i));
  const n = kept.length;
  const status = n >= 3 && card.status === "ok" ? "ok" : "partial";
  const summary = card.summary.replace(/^\d+ lines?, (?:each )?built only /, `${n} ${n === 1 ? "line, built" : "lines, each built"} only `);
  sheet.cards.copyHooks = { ...card, status, summary, results: kept };
  if (status !== "ok" && !card.reason) sheet.cards.copyHooks.reason = `${n} ${n === 1 ? "line" : "lines"} passed the checks.`;
  sheet.guard = { ...sheet.guard, dropped: sheet.guard.dropped + gone.size, reasons: [...sheet.guard.reasons, ...reasons.filter((r) => /^copyHooks\[\d+\]/.test(r))] };
  return [`copy lines dropped (${gone.size})`];
}

/**
 * The partner card's and step's chain words, as a run now writes them for a list grouped by area (`chainSummary`,
 * `chainsCause` with `perArea`): "2 of 11 partners are national chains, listed last: ..." reads "listed last in their
 * area: ...", and "Listed 2 national chains last, after the local places: ..." reads "Listed 2 national chains last in
 * their area: ...". Spots are one list near the venue and keep "listed last". Other text is returned as is.
 */
export function chainsLastInArea(text: string): string {
  return text
    .replace(
      /\b([\d,]+ of [\d,]+ partners? )(is a national chain|are national chains), listed last: no local place filled (its|their) slot/g,
      (_m, head: string, verb: string, its: string) => `${head}${verb}, listed last in ${its} area: no local place filled ${its} slot`,
    )
    .replace(
      /\bListed ([\d,]+ national chains?) last, after the local places: no local place filled (its|their) slot/g,
      (_m, chains: string, its: string) => `Listed ${chains} last in ${its} area: no local place filled ${its} slot`,
    );
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
