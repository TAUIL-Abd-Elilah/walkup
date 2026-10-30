/**
 * Deterministic narration built only from run facts. Runs when the LLM is off,
 * refused, over budget, failed to parse, or in tests. Same input, same output.
 */
import { liftAgainst, type CopyHook, type LiftTile, type Partner } from "@walkup/contracts";
import { isAudienceTag } from "./audience";
import { displayDate, headlinerName, prepareRun, type AllowTag, type PreparedRun } from "./facts";
import { MAX_COPY_HOOKS } from "./constants";
import type { NarrateInput, NarrationResult, TemplateReason } from "./types";

export { headlinerName } from "./facts";

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
 * crowd"): `liftAgainst` from @walkup/contracts, the rule `liftInWords` in
 * @walkup/engine, the calendar and the plan page share. It reads the sheet's
 * 2-decimal lift, as the guard's facts hold it, so the one printed decimal
 * always matches a cited number. Ratios like "1.84x" belong in tables, never in
 * prose. The orchestrator swaps the baseline phrase for the genre's fans
 * ("country fans in general", genreBaselinePhrase) when the run fell back to
 * a genre tag.
 */
export function liftWords(lift: number): string {
  return liftAgainst(lift, "the room's usual crowd");
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
export function ordinal(n: number): string {
  const i = Math.round(n);
  const m100 = Math.abs(i) % 100;
  const m10 = Math.abs(i) % 10;
  return `${i}${m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`;
}

/**
 * The template's line for one lift tile. The area's name is printed beside this line wherever it appears, so
 * the line starts with the comparison.
 */
export function templateTileWhy(t: Pick<LiftTile, "lift" | "billPct" | "housePct">): string {
  return `${capitalize(liftWords(t.lift))}. ${ordinal(pct(t.billPct))} percentile for this crowd, ${ordinal(pct(t.housePct))} for the room's usual crowd.`;
}

/**
 * The template's line for one partner. qlooRank is the place's position in the search it came from (one per area, or
 * near the venue). "Near" the area: a partner can sit up to 2 km from its centre (3.5 km when the search widened).
 * Only a partner with no area (no tileGeohash) came from the near-venue search; an area without a name is still an area.
 */
export function templatePartnerLine(p: Pick<Partner, "category" | "qlooRank" | "tileName" | "tileGeohash">): string {
  const kind = capitalize(withArticle(categoryWord(p.category)));
  if (p.tileName) return `${kind} near ${p.tileName}, ${ordinal(p.qlooRank)} on that area's list for this crowd.`;
  if (p.tileGeohash) return `${kind} near an unnamed area, ${ordinal(p.qlooRank)} on that area's list for this crowd.`;
  return `${kind} near the venue, ${ordinal(p.qlooRank)} on that list for this crowd.`;
}

function billNames(input: NarrateInput): string {
  const order = { headliner: 0, co: 1, support: 2 } as const;
  const acts = [...input.bill.acts].sort((a, b) => order[a.role] - order[b.role]);
  return joinNames(acts.map((a) => a.name));
}

/**
 * Proper adjectives a tag name keeps capitalised ("American history", "Irish pub", "Mexican"). The plan page's
 * `tagInSentence` (apps/web/lib/sheet-utils.ts) keeps the same list.
 */
export const PROPER_WORD_RE =
  /^(?:American|African|Afro|Latin|Latino|Latina|Caribbean|Irish|Italian|Mexican|Asian|British|English|French|Spanish|Cajun|Creole|Appalachian|Celtic|Black|Southern|Ethiopian|Jamaican|Korean|Japanese|Chinese|Indian|Thai|Vietnamese|Cuban|Mediterranean|Greek|German|Polish|Persian|Peruvian|Brazilian|Hawaiian|Filipino|Turkish|Lebanese)$/;

/** "Middle Eastern": two words that are proper only together. */
export function properPhrases(text: string): string {
  return text.replace(/\bmiddle eastern\b/gi, "Middle Eastern");
}

/**
 * A tag name as it reads inside a sentence: lower case except acronyms
 * ("R&B", "EDM") and proper adjectives ("Mexican", "Middle Eastern"), and
 * without a trailing " fans" ("Comedy fans" -> "comedy").
 */
export function tagInProse(name: string): string {
  const words = name
    .trim()
    .replace(/\s+fans$/i, "")
    // "Hip - Hop" (a Qloo tag name) reads "hip hop".
    .replace(/\s+-\s+/g, " ")
    .split(/\s+/)
    .map((w) =>
      (w.match(/[A-Z]/g)?.length ?? 0) >= 2
        ? w
        : w
            .split("-")
            .map((part) => {
              const cap = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
              return PROPER_WORD_RE.test(cap) ? cap : part.toLowerCase();
            })
            .join("-"),
    );
  return properPhrases(words.join(" "));
}

/** Only genre tags fill the copy slots (audience tags are skipped where slots are filled), never adjectives or themes ("Cozy", "Friendship", "City life"). */
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
    // The tiles here are the sheet's top areas only; the lift card counts every area that passes both tests.
    const lead = `This crowd stands out from the room's usual crowd in the sheet's top ${input.tiles.length === 1 ? "area" : plural(input.tiles.length, "area")}`;
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

  const tileWhy = input.tiles.map((t) => ({ geohash: t.geohash, text: templateTileWhy(t) }));

  const seen = new Set<string>();
  const partnerLines: NarrationResult["partnerLines"] = [];
  for (const p of input.partners) {
    if (seen.has(p.entity.entityId)) continue;
    seen.add(p.entity.entityId);
    partnerLines.push({ entityId: p.entity.entityId, text: templatePartnerLine(p) });
  }

  // Genre tags only (never audience or identity tags), one per word; fewer usable tags means fewer lines,
  // never a filled slot. Every line names the act.
  const slot: { tag: AllowTag; word: string }[] = [];
  // A comedy bill has no music genre on its allowlist (`comedyBill`): its media keywords ("Stand-up comedy", "Sitcom")
  // fill the slots instead: the ones the comparison with the room's usual crowd puts on this bill's side or both
  // (any, when there is no comparison), never one the usual crowd leans toward more.
  const compare = input.compareTags;
  const usual = new Set(prepared.comedy ? (compare?.b ?? []).map((t) => t.id) : []);
  const billSide = new Set([...(compare?.a ?? []), ...(compare?.shared ?? [])].map((t) => t.id));
  const comedyKeyword = (x: AllowTag) => prepared.comedy && x.id.startsWith("urn:tag:keyword:media") && (billSide.size === 0 || billSide.has(x.id));
  for (const t of hookTags(prepared).filter((x) => ((isSlotTag(x) && !isAudienceTag(x)) || comedyKeyword(x)) && !usual.has(x.id))) {
    const word = tagInProse(t.name);
    if (word && !slot.some((x) => x.word === word)) slot.push({ tag: t, word });
  }
  const copyHooks: CopyHook[] = [];
  const venue = bill.venue.name;
  const act = headlinerName(bill);
  const lead = act ? `${act}: ` : "";
  const [g1, g2, g3, r1, r2] = slot;
  if (g1 && g2) copyHooks.push({ text: `${lead}${capitalize(g1.word)} and ${g2.word} at ${venue}, ${when}.`, tagIds: [g1.tag.id, g2.tag.id] });
  else if (g1) copyHooks.push({ text: `${lead}${capitalize(g1.word)} at ${venue}, ${when}.`, tagIds: [g1.tag.id] });
  if (g3) copyHooks.push({ text: `${act ? `${act} for` : "For"} the ${g3.word} crowd: ${weekday} night at ${venue}.`, tagIds: [g3.tag.id] });
  if (r1 && r2) copyHooks.push({ text: `${lead}${capitalize(r1.word)} and ${r2.word}, live at ${venue}.`, tagIds: [r1.tag.id, r2.tag.id] });
  else if (r1) copyHooks.push({ text: `${lead}${capitalize(r1.word)}, live at ${venue}.`, tagIds: [r1.tag.id] });

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
