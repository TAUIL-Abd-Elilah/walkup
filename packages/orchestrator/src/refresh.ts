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
 *  - a live sheet is never marked hypothetical.
 *
 * What it cannot do: fill a slot a dropped place leaves (that needs the Qloo list behind it), or add a numbered
 * area the new ZIP rules would now separate. `report.needsLiveRun` says when a sheet is in that state.
 */
import type { LedgerEntry, LiftTile, MediaPick, Partner, PrePostSpot, QlooEntity, SheetDiscovery, StreetSheet } from "@walkup/contracts";
import { annotateTile } from "@walkup/gazetteer";
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
import { splitBudget } from "./steps/budget";
import { partnerLinesWithinTags, tidyAreaPhrases, usualCrowdWording } from "./steps/copy";
import { PARTNER_TILES } from "./steps/partners";
import { disambiguateNames, MIN_BILL_PCT, MIN_SPLIT_HALF, NARRATED_TILES, spreadTiles } from "./steps/heat";
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

type Annotated = { name?: string; gazetteerName?: string; zctas?: string[]; adultPopulation?: number | null };

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
  const sorted = [...tiles]
    .filter((t) => Number.isFinite(t.lift) && t.lift >= 1.3)
    .sort((a, b) => b.lift - a.lift || b.billPct - a.billPct || (a.geohash < b.geohash ? -1 : a.geohash > b.geohash ? 1 : 0));
  const out: LiftTile[] = [];
  for (const t of sorted) {
    if (out.length >= NARRATED_TILES) break;
    const same = out.some((o) => haversineM(o, t) < 3000 || (o.zctas ?? []).some((z) => (t.zctas ?? []).includes(z)));
    if (!same) out.push(t);
  }
  return out.map((t) => t.geohash);
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
  if (sheet.revision && opts.parent) {
    const settingRefs = sheet.revision.changes.find((c) => c.kind === "setting_changed")?.ledgerRefs ?? [];
    sheet.revision = { ...sheet.revision, changes: diffSheets(opts.parent, sheet, settingRefs) };
  } else if (sheet.revision) {
    sheet.revision = mapStrings(sheet.revision, rename);
  }
  return { sheet, report };
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
  if (sheet.narration?.summary) {
    sheet.narration = { ...sheet.narration, summary: sheet.narration.summary.replace(/\b\d+ spots? for before and after the show/, `${n} ${word(n)} for before and after the show`) };
  }
}
