/**
 * Turns a run's results into (a) the facts payload shown to the model, (b) the
 * id sets the per-run schema enumerates, and (c) the numbers and names the
 * guard accepts. Everything the model may cite is derived here, once.
 */
import type { CompareTag } from "@walkup/contracts";
import { isAudienceTag } from "./audience";
import { cleanAllowlist, isAlcoholTag, isDeniedTag, literalNumbersIn, type AllowedNumbers } from "./policy";
import type { NarrateInput } from "./types";

export interface AllowTag {
  id: string;
  name: string;
}

export interface RunIds {
  geohashes: string[];
  /** Partner, pre/post and media entity ids, deduped, in that order. */
  entityIds: string[];
  /** Allowlisted (and not denied) tag ids. */
  tagIds: string[];
}

export interface PreparedRun {
  ids: RunIds;
  allowlist: AllowTag[];
  /** Tags removed from the allowlist: denylist hits, plus alcohol tags when the show is not 21+. */
  deniedTagCount: number;
  /** True only when the ticketing age policy says 21+ (legalAgeEnforced === true). */
  alcoholAllowed: boolean;
  /** Allowlisted tags that are distinctive to the bill (compare side a), in compare order. */
  distinctiveTags: AllowTag[];
  allowedNumbers: AllowedNumbers;
  /** Strings blanked before word and number checks (names, ids, tag names). */
  protectedStrings: string[];
  actNames: string[];
  /** JSON-able payload rendered into the user message. */
  facts: Record<string, unknown>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

function dedupe(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** "2026-11-28" -> { y: 2026, m: 11, d: 28 } or null. */
export function dateParts(date: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** "Saturday, Nov 28" (no locale dependency). */
export function displayDate(weekday: string, date: string): string {
  const day = weekday ? weekday[0]!.toUpperCase() + weekday.slice(1) : "";
  const p = dateParts(date);
  if (!p) return [day, date].filter(Boolean).join(", ");
  return `${day}, ${MONTHS[p.m - 1] ?? ""} ${p.d}`;
}

function tagsFromCompare(tags: ReadonlyArray<CompareTag> | undefined, allowed: Map<string, AllowTag>): AllowTag[] {
  const out: AllowTag[] = [];
  for (const t of tags ?? []) {
    const a = allowed.get(t.id);
    if (a && !out.some((x) => x.id === a.id)) out.push(a);
  }
  return out;
}

/** The act fan copy names: the first headliner, else the first act. Empty when the bill has no act. */
export function headlinerName(bill: { acts?: ReadonlyArray<{ name: string; role: string }> }): string {
  const acts = bill.acts ?? [];
  return (acts.find((a) => a.role === "headliner") ?? acts[0])?.name.trim() ?? "";
}

/** "thursday" -> "Thursday": the model copies the value as written. */
function dayName(day: string): string {
  return day ? day[0]!.toUpperCase() + day.slice(1) : day;
}

export function prepareRun(input: NarrateInput): PreparedRun {
  const { bill } = input;
  // Alcohol rules come from the ticketing age policy only; unknown counts as not 21+.
  const alcoholAllowed = bill.legalAgeEnforced === true;
  const cleaned = cleanAllowlist(input.allowlistTags.map((t) => ({ id: t.id, name: t.name })));
  const drinkable = alcoholAllowed ? cleaned.allowed : cleaned.allowed.filter((t) => !isAlcoholTag(t));
  const deniedCount = cleaned.deniedCount + (cleaned.allowed.length - drinkable.length);
  // Audience and identity tags describe people, never the show: they are not offered to copy at all.
  const allowlist = drinkable.filter((t) => !isAudienceTag(t));
  const allowedById = new Map(allowlist.map((t) => [t.id, t]));
  const distinctiveTags = tagsFromCompare(input.compareTags?.a, allowedById).slice(0, 8);
  const sharedTags = tagsFromCompare(input.compareTags?.shared, allowedById).slice(0, 5);

  const tiles = input.tiles.map((t) => ({
    geohash: t.geohash,
    name: t.name ?? null,
    lift: round(t.lift, 2),
    billPct: round(t.billPct, 3),
    housePct: round(t.housePct, 3),
    popularityPct: round(t.popularityPct, 3),
    zctas: t.zctas ?? [],
    adultPopulation: t.adultPopulation ?? null,
  }));

  const partners = input.partners.map((p) => ({
    entityId: p.entity.entityId,
    name: p.entity.name,
    category: p.category,
    tileGeohash: p.tileGeohash,
    tileName: p.tileName ?? null,
    score: round(p.score, 3),
    qlooRank: p.qlooRank,
    hoursOnDay: p.hoursOnDay ?? null,
    // Hours are for the street-team day, which is often not the show's weekday.
    hoursDay: p.hoursOnDay ? dayName(input.streetTeamDay ?? input.bill.weekday) : null,
    address: p.address ?? null,
    distanceM: p.entity.distanceM != null ? Math.round(p.entity.distanceM) : null,
    // The tags the partner panel shows as "Tags it shares": the only tags a partner line may name.
    sharedTags: [
      ...new Set(
        (p.explain?.tags ?? [])
          .filter((t) => t.name?.trim() && !isDeniedTag(t) && !isAudienceTag(t) && (alcoholAllowed || !isAlcoholTag(t)))
          .map((t) => t.name.trim()),
      ),
    ],
  }));

  const prePost = input.prePost.map((s) => ({
    entityId: s.entity.entityId,
    name: s.entity.name,
    deltaRank: s.deltaRank,
    expectedShare: round(s.expectedShare, 3),
    assumedCapacity: s.assumedCapacity,
    fanFacingAllowed: s.fanFacingAllowed,
  }));

  const media = input.media.map((m) => ({
    entityId: m.entity.entityId,
    name: m.entity.name,
    kind: m.kind,
    scope: m.scope,
  }));

  const numbers = input.numbers
    .filter((n) => Number.isFinite(n.value))
    .map((n) => ({ label: n.label, value: round(n.value, 3) }));

  const ids: RunIds = {
    geohashes: dedupe(tiles.map((t) => t.geohash)),
    entityIds: dedupe([...partners, ...prePost, ...media].map((e) => e.entityId)),
    tagIds: allowlist.map((t) => t.id),
  };

  // ---- numbers the guard accepts -------------------------------------------
  const values: number[] = [];
  const pushNum = (v: number | null | undefined) => {
    if (typeof v === "number" && Number.isFinite(v)) values.push(v);
  };
  for (const t of tiles) {
    pushNum(t.lift);
    pushNum(t.billPct);
    pushNum(t.housePct);
    pushNum(t.popularityPct);
    pushNum(t.adultPopulation);
  }
  for (const p of partners) {
    pushNum(p.score);
    pushNum(p.qlooRank);
    pushNum(p.distanceM);
  }
  for (const s of prePost) {
    pushNum(s.deltaRank);
    pushNum(s.expectedShare);
    pushNum(s.assumedCapacity);
  }
  for (const n of numbers) pushNum(n.value);
  // Counts and positions of what the run returned.
  const counts = [tiles.length, partners.length, prePost.length, media.length, distinctiveTags.length];
  counts.forEach(pushNum);
  pushNum(new Set(partners.map((p) => p.category)).size);
  const maxPos = Math.min(25, Math.max(3, tiles.length, partners.length));
  for (let i = 1; i <= maxPos; i++) pushNum(i);
  if (bill.legalAgeEnforced === true) pushNum(21);

  const literalSources: string[] = [
    ...bill.acts.map((a) => a.name),
    bill.venue.name,
    bill.venue.city,
    bill.venue.state ?? "",
    bill.date,
    ...tiles.flatMap((t) => [t.name ?? "", ...t.zctas]),
    ...partners.flatMap((p) => [p.name, p.address ?? "", p.hoursOnDay ?? "", p.tileName ?? "", ...p.sharedTags]),
    ...prePost.map((s) => s.name),
    ...media.map((m) => m.name),
    ...allowlist.map((t) => t.name),
  ];
  const literals = new Set<string>();
  for (const s of literalSources) for (const n of literalNumbersIn(s)) literals.add(n);
  const dp = dateParts(bill.date);
  if (dp) {
    literals.add(String(dp.y));
    literals.add(String(dp.d));
    literals.add(String(dp.m));
  }

  const actNames = dedupe(bill.acts.map((a) => a.name.trim()));
  const protectedStrings = dedupe([
    ...actNames,
    bill.venue.name,
    bill.venue.city,
    ...tiles.flatMap((t) => [t.geohash, t.name ?? ""]),
    ...partners.flatMap((p) => [p.entityId, p.name, p.address ?? "", p.hoursOnDay ?? "", p.tileName ?? "", ...p.sharedTags]),
    ...prePost.flatMap((s) => [s.entityId, s.name]),
    ...media.flatMap((m) => [m.entityId, m.name]),
    ...allowlist.flatMap((t) => [t.id, t.name]),
  ]);

  const facts: Record<string, unknown> = {
    show: {
      acts: bill.acts.map((a) => ({ name: a.name, role: a.role })),
      venue: { name: bill.venue.name, city: bill.venue.city, state: bill.venue.state ?? null },
      date: bill.date,
      // How prose writes the date ("Wednesday, Feb 17"); the ISO date is for reading, not for copying.
      dateText: displayDate(bill.weekday, bill.date),
      weekday: bill.weekday,
      legalAgeEnforced: bill.legalAgeEnforced,
      classification: bill.classification ?? null,
      countsAreHypothetical: input.hypothetical === true,
    },
    tiles,
    partners,
    prePost,
    media,
    distinctiveTags,
    sharedTags,
    allowlistedTags: allowlist,
    numbers,
  };

  return {
    ids,
    allowlist,
    deniedTagCount: deniedCount,
    alcoholAllowed,
    distinctiveTags,
    allowedNumbers: { values, literals },
    protectedStrings,
    actNames,
    facts,
  };
}

/** The user message for narration: data only, wrapped in a tag. */
export function renderFactsMessage(prepared: PreparedRun): string {
  return `<run_facts>\n${JSON.stringify(prepared.facts, null, 1)}\n</run_facts>\n\nWrite the narration for this run.`;
}
