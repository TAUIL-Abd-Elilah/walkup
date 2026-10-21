/**
 * What a revision changed, in display order: settings, then areas, partners
 * and pre/post spots (removed first, then added). Removed rows say why when
 * the new settings explain it. Receipts point at this run's ledger: an added
 * row cites the call that returned it; a removed row cites the new search that
 * no longer has it.
 */
import type { LiftTile, OperatorInputs, Partner, PrePostSpot, RevisionChange, StreetSheet } from "@walkup/contracts";
import { barsExcluded, DEFAULT_BAR_CATEGORIES, isDrinkLed, liftInWords } from "@walkup/engine";
import { categoriesInWords, categoryWord, dayWord } from "@walkup/narrator";
import { isExcludedArea } from "../steps/heat";
import { sheetAreas, reviseSummary } from "./summary";

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs.filter((x) => typeof x === "string" && x !== ""))];
}

function stepRefs(sheet: StreetSheet, id: string, fallback: readonly string[]): string[] {
  const step = sheet.steps?.find((s) => s.id === id);
  return uniq(step && step.ledgerRefs.length > 0 ? step.ledgerRefs : fallback);
}

/** Category keys the revised sheet leaves out, and why; with bars out, drinking places of any category too. */
/**
 * The left-out types of a revision, and for one place why it is left out: its type ("left out by type (all-ages
 * show)"), or, with bars left out, a drinking place by its name or tags whatever its type ("Capitol Square Bar &
 * Grill", a restaurant: "left out: a drinking place by its name or tags (all-ages show)"). Null when neither.
 */
function excludedTypes(op: OperatorInputs): { keys: Set<string>; reason: string; leftOut: (category: string | undefined, entity: Parameters<typeof isDrinkLed>[0]) => string | null } {
  const keys = new Set((op.excludeCategories ?? []).map((k) => k.trim().toLowerCase()));
  if (op.allAges === true) for (const k of DEFAULT_BAR_CATEGORIES) keys.add(k);
  const noBars = barsExcluded(keys);
  const reason = op.allAges === true ? "all-ages show" : "your exclusions";
  return {
    keys,
    reason,
    leftOut: (category, entity) =>
      !!category && keys.has(category) ? `left out by type (${reason})` : noBars && isDrinkLed(entity) ? `left out: a drinking place by its name or tags (${reason})` : null,
  };
}

function areaSkipped(op: OperatorInputs, geohash: string | null | undefined, name: string | null | undefined): boolean {
  if (!geohash && !name) return false;
  return isExcludedArea({ geohash: geohash ?? "", ...(name ? { name } : {}) }, op.excludeAreas);
}

/** Category keys that read the same ("night_club" and "nightclub"): the first of each is kept. */
function distinctByWord(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    const w = categoryWord(k, true);
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(k);
  }
  return out;
}

/**
 * The left-out types in words, each once: most of the bar types read as one group ("bars and other drinking
 * places"), and two keys with the same words ("night_club", "nightclub") are said once.
 */
export function excludedInWords(keys: readonly string[], summary?: Parameters<typeof categoriesInWords>[1]): string {
  const uniq = distinctByWord(keys);
  const bars = uniq.filter((k) => DEFAULT_BAR_CATEGORIES.includes(k));
  if (bars.includes("bar") && bars.length >= 5) {
    const rest = uniq.filter((k) => !DEFAULT_BAR_CATEGORIES.includes(k)).map((k) => categoryWord(k, true));
    return joinAnd(["bars and other drinking places", ...rest]);
  }
  const words = categoriesInWords(uniq, summary).split(/, | and /);
  return joinAnd([...new Set(words)]);
}

/** The "All ages" row: what changed, said against what the original sheet already did. */
function allAgesDetail(parent: StreetSheet, child: StreetSheet): string {
  const legal = child.bill.legalAgeEnforced;
  if (child.operator.allAges !== true) return `Off (was on)${legal === true ? ": Ticketmaster still lists the show as age-restricted" : ""}`;
  // The original sheet already read the show as all ages from Ticketmaster: only the bar rule is new.
  if (parent.bill.legalAgeEnforced === false) return "Already all ages on Ticketmaster; bar partners and drink-led spots are now left out";
  if (legal === true) return "On (was off), so no bar partners or drink-led spots; Ticketmaster still lists the show as age-restricted";
  if (legal === null) return "On: bar partners and drink-led spots are now left out (Ticketmaster lists no age limit)";
  return "On (was off), so no bar partners or drink-led spots";
}

function daysWords(days: readonly string[]): string {
  return days.length > 0 ? joinAnd(days.map((d) => dayWord(d as Parameters<typeof dayWord>[0]))) : "none";
}

function settingChanges(parent: StreetSheet, child: StreetSheet, refs: readonly string[]): RevisionChange[] {
  const p = parent.operator;
  const c = child.operator;
  const out: RevisionChange[] = [];
  const summary = reviseSummary(child);
  const ledgerRefs = uniq(refs);
  if ((p.allAges === true) !== (c.allAges === true)) {
    out.push({ kind: "setting_changed", label: "All ages", detail: allAgesDetail(parent, child), ledgerRefs });
  }
  const pCats = new Set(p.excludeCategories ?? []);
  const newCats = (c.excludeCategories ?? []).filter((k) => !pCats.has(k));
  if (newCats.length > 0) out.push({ kind: "setting_changed", label: "Left out", detail: excludedInWords(newCats, summary), ledgerRefs });
  const pAreas = new Set((p.excludeAreas ?? []).map((a) => a.toLowerCase()));
  const newAreas = (c.excludeAreas ?? []).filter((a) => !pAreas.has(a.toLowerCase()));
  if (newAreas.length > 0) out.push({ kind: "setting_changed", label: "Skipped areas", detail: joinAnd(newAreas), ledgerRefs });
  if (p.streetTeamDays.join(",") !== c.streetTeamDays.join(",")) {
    out.push({ kind: "setting_changed", label: "Street-team days", detail: `${daysWords(c.streetTeamDays)} (was ${daysWords(p.streetTeamDays)})`, ledgerRefs });
  }
  if (p.radiusKm !== c.radiusKm) {
    const km = (n: number) => `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
    out.push({ kind: "setting_changed", label: "Search radius", detail: `${km(c.radiusKm)} (was ${km(p.radiusKm)})`, ledgerRefs });
  }
  return out;
}

function tileLabel(t: LiftTile): string {
  return t.name ?? `Area ${t.geohash}`;
}

function tileChanges(parent: StreetSheet, child: StreetSheet): RevisionChange[] {
  const before = sheetAreas(parent);
  const after = sheetAreas(child);
  const was = new Set(before.map((t) => t.geohash));
  const now = new Set(after.map((t) => t.geohash));
  const baseline = child.cards.liftMap.results.diagnostics.baseline === "tag" ? "tag" : "house";
  const refs = stepRefs(child, "heat", child.cards.liftMap.provenance);
  const out: RevisionChange[] = [];
  for (const t of before) {
    if (now.has(t.geohash)) continue;
    const skipped = areaSkipped(child.operator, t.geohash, t.name);
    out.push({ kind: "tile_removed", label: tileLabel(t), detail: `${skipped ? "skipped at your request" : "no longer among the top areas"} (map square ${t.geohash})`, ledgerRefs: refs });
  }
  for (const t of after) {
    if (was.has(t.geohash)) continue;
    out.push({ kind: "tile_added", label: tileLabel(t), detail: `${liftInWords(t.lift, baseline)} (map square ${t.geohash})`, ledgerRefs: refs });
  }
  return out;
}

function partnerWhere(p: Partner): string {
  return p.tileName ? `in ${p.tileName}` : "near the room";
}

function partnerRefs(p: Partner): string[] {
  return uniq([...(p.explain?.ledgerRefs ?? []), ...p.chips.map((c) => c.ledgerRef)]);
}

/** Partners of one kind an area keeps (the partner list's "at most 2 of a kind per area"). */
const KIND_CAP_PER_AREA = 2;

/** Why a partner the revision didn't exclude is gone: the rebuilt list, and who took its place when that shows. */
function rebuiltWhy(p: Partner, after: readonly Partner[]): string {
  const same = after.filter((x) => x.tileGeohash === p.tileGeohash && x.category === p.category).length;
  if (same >= KIND_CAP_PER_AREA) {
    return `dropped when the list was rebuilt; higher-ranked ${categoryWord(p.category, true)} filled the area's ${KIND_CAP_PER_AREA} places`;
  }
  return "dropped when the list was rebuilt";
}

function partnerChanges(parent: StreetSheet, child: StreetSheet): RevisionChange[] {
  const before = parent.cards.partners.results;
  const after = child.cards.partners.results;
  const was = new Set(before.map((p) => p.entity.entityId));
  const now = new Set(after.map((p) => p.entity.entityId));
  const types = excludedTypes(child.operator);
  const removedRefs = stepRefs(child, "partners", child.cards.partners.provenance);
  const out: RevisionChange[] = [];
  for (const p of before) {
    if (now.has(p.entity.entityId)) continue;
    const why =
      types.leftOut(p.category, p.entity) ?? (areaSkipped(child.operator, p.tileGeohash, p.tileName) ? "its area was skipped" : rebuiltWhy(p, after));
    out.push({ kind: "partner_removed", label: p.entity.name, detail: `${categoryWord(p.category, false)} ${partnerWhere(p)}: ${why}`, ledgerRefs: removedRefs });
  }
  for (const p of after) {
    if (was.has(p.entity.entityId)) continue;
    out.push({ kind: "partner_added", label: p.entity.name, detail: `${categoryWord(p.category, false)} ${partnerWhere(p)}`, ledgerRefs: partnerRefs(p) });
  }
  return out;
}

function spotRefs(s: PrePostSpot): string[] {
  return uniq(s.chips.map((c) => c.ledgerRef));
}

function spotChanges(parent: StreetSheet, child: StreetSheet): RevisionChange[] {
  const before = parent.cards.prePost.results;
  const after = child.cards.prePost.results;
  const was = new Set(before.map((s) => s.entity.entityId));
  const now = new Set(after.map((s) => s.entity.entityId));
  const types = excludedTypes(child.operator);
  const removedRefs = stepRefs(child, "prepost", child.cards.prePost.provenance);
  const out: RevisionChange[] = [];
  for (const s of before) {
    if (now.has(s.entity.entityId)) continue;
    const kind = s.category ? categoryWord(s.category, false) : "spot";
    const why = types.leftOut(s.category, s.entity) ?? "not picked in the new search";
    out.push({ kind: "spot_removed", label: s.entity.name, detail: `${kind} near the room: ${why}`, ledgerRefs: removedRefs });
  }
  for (const s of after) {
    if (was.has(s.entity.entityId)) continue;
    out.push({ kind: "spot_added", label: s.entity.name, detail: `${s.category ? categoryWord(s.category, false) : "spot"} near the room`, ledgerRefs: spotRefs(s) });
  }
  return out;
}

/**
 * Every difference between a revised sheet and its parent. `settingRefs` are
 * the receipts for the setting rows (the model call that read the note; none
 * when the rules read it).
 */
export function diffSheets(parent: StreetSheet, child: StreetSheet, settingRefs: readonly string[] = []): RevisionChange[] {
  return [...settingChanges(parent, child, settingRefs), ...tileChanges(parent, child), ...partnerChanges(parent, child), ...spotChanges(parent, child)];
}
