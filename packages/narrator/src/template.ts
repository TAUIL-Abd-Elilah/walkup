/**
 * Deterministic narration built only from run facts. Runs when the LLM is off,
 * refused, over budget, failed to parse, or in tests. Same input, same output.
 */
import type { CopyHook } from "@walkup/contracts";
import { displayDate, prepareRun, round, type AllowTag, type PreparedRun } from "./facts";
import { MAX_COPY_HOOKS } from "./constants";
import type { NarrateInput, NarrationResult, TemplateReason } from "./types";

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Percentile on a 0..100 scale, whether the input is 0..1 or already 0..100. */
function pct(v: number): number {
  return Math.round(v <= 1 ? v * 100 : v);
}

/**
 * Lift in words, always naming the baseline ("about 1.8 times the room's usual
 * crowd"); the same thresholds and phrases as `liftInWords` in @walkup/engine.
 * Uses the lift rounded to 2 decimals, as the guard's facts hold it, so the one
 * printed decimal always matches a cited number. Ratios like "1.84x" belong in
 * tables, never in prose. The orchestrator swaps the baseline phrase for "the
 * genre baseline" when the run fell back to a genre tag.
 */
export function liftWords(lift: number): string {
  const b = "the room's usual crowd";
  const l = round(lift, 2);
  if (!Number.isFinite(l)) return `compared with ${b}`;
  if (l < 0.95) return `below ${b}`;
  if (l < 1.05) return `about the same as ${b}`;
  if (l < 1.3) return `a little above ${b}`;
  return `about ${l.toFixed(1)} times ${b}`;
}

/** "record_store" -> "record store"; "barber_shop" -> "barbershop". */
function categoryWord(category: string): string {
  const w = category.replace(/_/g, " ").trim().toLowerCase();
  return w === "barber shop" ? "barbershop" : w === "book store" ? "bookstore" : w || "place";
}

function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st ... */
function ordinal(n: number): string {
  const i = Math.round(n);
  const m100 = Math.abs(i) % 100;
  const m10 = Math.abs(i) % 10;
  return `${i}${m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`;
}

function billNames(input: NarrateInput): string {
  const order = { headliner: 0, co: 1, support: 2 } as const;
  const acts = [...input.bill.acts].sort((a, b) => order[a.role] - order[b.role]);
  return joinNames(acts.map((a) => a.name));
}

/**
 * A tag name as it reads inside a sentence: lower case except acronyms
 * ("R&B", "EDM"), and without a trailing " fans" ("Comedy fans" -> "comedy").
 */
export function tagInProse(name: string): string {
  const words = name
    .trim()
    .replace(/\s+fans$/i, "")
    .split(/\s+/)
    .map((w) => ((w.match(/[A-Z]/g)?.length ?? 0) >= 2 ? w : w.toLowerCase()));
  return words.join(" ");
}

/** Only genre and audience tags fill the copy slots, never adjectives or themes ("Cozy", "Friendship", "City life"). */
const SLOT_NAMESPACES = ["urn:tag:genre:music", "urn:tag:genre:media", "urn:tag:genre:person", "urn:tag:audience:"];
export function isSlotTag(t: { id: string }): boolean {
  return SLOT_NAMESPACES.some((ns) => t.id.startsWith(ns));
}

/** Tags for copy: distinctive-to-the-bill first, then the rest of the allowlist. */
function hookTags(prepared: PreparedRun): AllowTag[] {
  const out: AllowTag[] = [...prepared.distinctiveTags];
  for (const t of prepared.allowlist) if (!out.some((x) => x.id === t.id)) out.push(t);
  return out;
}

export function templateSummary(input: NarrateInput, prepared: PreparedRun = prepareRun(input)): string {
  const { bill } = input;
  const when = displayDate(bill.weekday, bill.date);
  const parts: string[] = [`${billNames(input)} at ${bill.venue.name}, ${when}.`];

  if (input.tiles.length > 0) {
    const top = [...input.tiles].sort((a, b) => b.lift - a.lift || a.geohash.localeCompare(b.geohash))[0]!;
    const lead = `This crowd stands out from the room's usual crowd in ${plural(input.tiles.length, "area")}`;
    if (input.tiles.length === 1) parts.push(`${lead}: ${top.name ?? "one area"}, ${liftWords(top.lift)}.`);
    else parts.push(`${lead}; the strongest${top.name ? `, ${top.name},` : ""} is ${liftWords(top.lift)}.`);
  } else {
    parts.push("No area stands out on this run, so partners are picked near the venue.");
  }

  if (input.partners.length > 0) {
    const kinds = new Set(input.partners.map((p) => p.category)).size;
    parts.push(`The sheet suggests ${plural(input.partners.length, "partner")} of ${plural(kinds, "kind")}; none has agreed to anything.`);
  }

  const extras: string[] = [];
  if (input.prePost.length > 0) extras.push(`${plural(input.prePost.length, "spot")} for before and after the show`);
  const podcasts = input.media.filter((m) => m.kind === "podcast").length;
  const sponsors = input.media.filter((m) => m.kind === "sponsor").length;
  if (podcasts > 0) extras.push(plural(podcasts, "podcast"));
  if (sponsors > 0) extras.push(plural(sponsors, "local sponsor"));
  if (extras.length > 0) parts.push(`It also lists ${joinNames(extras)}.`);

  if (prepared.distinctiveTags.length > 0) {
    parts.push(
      `Compared with the room's usual crowd, this one leans toward ${joinNames(prepared.distinctiveTags.slice(0, 3).map((t) => tagInProse(t.name)))}.`,
    );
  }
  return parts.join(" ");
}

export function templateNarrate(
  input: NarrateInput,
  reason: TemplateReason = "llm_off",
  prepared: PreparedRun = prepareRun(input),
): NarrationResult {
  const { bill } = input;
  const when = displayDate(bill.weekday, bill.date);
  const weekday = capitalize(bill.weekday);

  // The area's name is printed beside this line wherever it appears, so the line starts with the comparison.
  const tileWhy = input.tiles.map((t) => ({
    geohash: t.geohash,
    text: `${capitalize(liftWords(t.lift))}. ${ordinal(pct(t.billPct))} percentile for this crowd, ${ordinal(pct(t.housePct))} for the room's usual crowd.`,
  }));

  const seen = new Set<string>();
  const partnerLines: NarrationResult["partnerLines"] = [];
  for (const p of input.partners) {
    if (seen.has(p.entity.entityId)) continue;
    seen.add(p.entity.entityId);
    // qlooRank is the place's position in the search it came from (one per area, or near the venue).
    const kind = capitalize(withArticle(categoryWord(p.category)));
    const text = p.tileName
      ? `${kind} in ${p.tileName}, ${ordinal(p.qlooRank)} on that area's list for this crowd.`
      : `${kind} near the venue, ${ordinal(p.qlooRank)} on that list for this crowd.`;
    partnerLines.push({ entityId: p.entity.entityId, text });
  }

  // Genre and audience tags only, one per word; fewer usable tags means fewer lines, never a filled slot.
  const slot: { tag: AllowTag; word: string }[] = [];
  for (const t of hookTags(prepared).filter(isSlotTag)) {
    const word = tagInProse(t.name);
    if (word && !slot.some((x) => x.word === word)) slot.push({ tag: t, word });
  }
  const copyHooks: CopyHook[] = [];
  const venue = bill.venue.name;
  const genres = slot.filter((x) => !x.tag.id.startsWith("urn:tag:audience:"));
  const audience = slot.find((x) => x.tag.id.startsWith("urn:tag:audience:"));
  const [g1, g2, g3] = genres;
  if (g1 && g2) copyHooks.push({ text: `${capitalize(g1.word)} and ${g2.word} at ${venue}, ${when}.`, tagIds: [g1.tag.id, g2.tag.id] });
  else if (g1) copyHooks.push({ text: `${capitalize(g1.word)} at ${venue}, ${when}.`, tagIds: [g1.tag.id] });
  const crowd = audience ?? g3;
  if (crowd) copyHooks.push({ text: `For the ${crowd.word} crowd: ${weekday} night at ${venue}.`, tagIds: [crowd.tag.id] });
  const rest = genres.filter((x) => x !== g1 && x !== g2 && x !== crowd);
  const [r1, r2] = rest;
  if (r1 && r2) copyHooks.push({ text: `${capitalize(r1.word)} and ${r2.word}, live at ${venue}.`, tagIds: [r1.tag.id, r2.tag.id] });
  else if (r1) copyHooks.push({ text: `${capitalize(r1.word)}, live at ${venue}.`, tagIds: [r1.tag.id] });

  return {
    summary: templateSummary(input, prepared),
    tileWhy,
    partnerLines,
    copyHooks: copyHooks.slice(0, MAX_COPY_HOOKS),
    templated: true,
    templateReason: reason,
    usage: null,
    guard: { dropped: 0, reasons: [], deniedTagCount: prepared.deniedTagCount },
    ledgerRefs: [],
  };
}
