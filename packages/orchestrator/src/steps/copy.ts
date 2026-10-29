/**
 * Q14 (the copy allowlist), narration and the two guards.
 *
 * - Allowlist: Q14 tag profile (namespace-scoped, diversified) through the
 *   denylist; fewer than 3 survivors means hooks come from partner tags only.
 *   Partner ambience/good_for tags join the allowlist. Only taste tags get in
 *   (`isTasteTag`: no age bands, payment brands, amenities, places or words
 *   like "Clean" or "Large group"), each name once. On shows that are not
 *   21+ (Ticketmaster), alcohol tags are held back before anything is written.
 * - Narration: @walkup/narrator (the deterministic template without a
 *   model). Operator-facing lines (summary, tile "why", partner lines) pass the
 *   narrator's guard there.
 * - Fan-facing copy hooks also pass @walkup/engine validateNarration with
 *   the all-ages alcohol rule, against only the citable numbers of this run.
 */
import type { CopyHook, CompareResult, LiftTile, MediaPick, Partner, PrePostSpot, QlooTag, StreetSheet, StreetSheetCards } from "@walkup/contracts";
import { buildCopyAllowlist, collectFactNumbers, dedupeTags, findAlcoholTerm, isDeniedTag, isTasteTag, validateNarration, type NarrationFacts } from "@walkup/engine";
import { isAlcoholTag, narrate, type NarrationResult } from "@walkup/narrator";
import type { RankedTag } from "@walkup/qloo";
import { envelope, node, plural, seedIds, type RunContext, type Seed } from "../context";
import type { BudgetShare } from "./budget";
import { streetDay } from "./partners";

export const Q14_TAG_TYPES = ["urn:tag:keyword:media", "urn:tag:genre:music", "urn:tag:theme:qloo", "urn:tag:audience:qloo"];
const PARTNER_COPY_NAMESPACES = ["urn:tag:ambience:", "urn:tag:good_for:"];
export const MIN_BILL_TAGS = 3;

type HooksCard = StreetSheetCards["copyHooks"];

export interface CopyResult {
  card: HooksCard;
  narration: NonNullable<StreetSheet["narration"]>;
  guardDropped: number;
  guardReasons: string[];
  /** Policy-denied tags removed from the copy candidates (sensitive names stay in memory only). */
  deniedNames: string[];
  ledgerRefs: string[];
  templated: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function displayDate(weekday: string, date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const day = weekday ? weekday[0]!.toUpperCase() + weekday.slice(1) : "";
  if (!m) return day;
  return `${day}, ${MONTHS[Number(m[2]) - 1] ?? ""} ${Number(m[3])}`;
}

/** Why the fixed template wrote the summary, in plain words (one line in the sheet's checks). */
export function templateLine(reason: NarrationResult["templateReason"]): string {
  const why: Record<string, string> = {
    llm_off: "no model key",
    over_budget: "the day's model budget was used up",
    refusal: "the model declined",
    max_tokens: "the model's answer was cut off",
    parse_failed: "the model's answer didn't fit the format",
    api_error: "the model call failed",
  };
  return `The summary came from a fixed template (${why[reason ?? "llm_off"] ?? "no model key"}).`;
}

function capFirst(s: string): string {
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
}

function alcoholFree(t: { id: string; name: string }): boolean {
  return !isAlcoholTag(t) && findAlcoholTerm(t.name) === null && findAlcoholTerm(t.id.split(":").pop()?.replace(/_/g, " ") ?? "") === null;
}

export interface CopyInputs {
  seeds: Seed[];
  tiles: LiftTile[];
  partners: Partner[];
  rawPartnerTags: QlooTag[];
  prePost: PrePostSpot[];
  media: MediaPick[];
  compare: CompareResult | null;
  budget: BudgetShare[];
  hypothetical: boolean;
}

type Narration = NonNullable<StreetSheet["narration"]>;

/**
 * "House" is Walkup's internal word for the room's usual crowd; the sheet never prints it. Words only.
 */
export function usualCrowdWording(text: string): string {
  return text
    .replace(/\bthe house crowd\b/g, "the room's usual crowd")
    .replace(/\b(?:the |its )?house share\b/g, "the room's usual crowd's share")
    .replace(/\bshare of the house\b/g, "share of the room's usual crowd")
    .replace(/\b(versus|than|from|for|with|of|to|above|below) the house\b(?! (twin|list))/g, "$1 the room's usual crowd")
    .replace(/\bhouse percentile\b/g, "usual-crowd percentile");
}

/**
 * Tidies a line after an area name was put in it: "in Laurel in Laurel" reads "in Laurel", and "on U Street in
 * U Street / Shaw" reads "on U Street / Shaw" (the street is already in the area's name).
 */
export function tidyAreaPhrases(text: string, areaNames: readonly string[]): string {
  let out = text;
  for (const name of [...new Set(areaNames)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\bin ${n} in ${n}(?![A-Za-z])`, "g"), `in ${name}`);
    out = out.replace(new RegExp(`\\b(in|on) ([A-Z][\\w'’ .-]{1,40}?) in ${n}(?![A-Za-z])`, "g"), (m, prep: string, place: string) => {
      const a = place.trim().toLowerCase();
      const b = name.toLowerCase();
      return b.includes(a) || a.includes(b) ? `${prep === "on" && b.startsWith(a) ? "on" : "in"} ${name}` : m;
    });
  }
  return out;
}

/**
 * The narrator's template (and its model prompt) compares against "the house
 * crowd" and calls the sponsor "local". The sheet must say what actually ran:
 * on a genre tag baseline there is no house crowd behind the numbers, and a
 * sponsor is "local" only when the signal.location probe verified it.
 * Words only: no id or number changes, so the guards' results still hold.
 */
export function honestWording(n: Narration, o: { tagBaseline: boolean; localSponsor: boolean; genre?: string }): Narration {
  const g = o.genre ?? "the genre baseline";
  const fix = (s: string) => {
    let out = s;
    if (o.tagBaseline) {
      out = out
        .replace(/\bthe room's usual crowd\b/g, g)
        .replace(/\bthe house crowd\b/g, g)
        .replace(/\bhouse percentile\b/g, "baseline percentile")
        .replace(/\bversus the house\b(?! crowd)/g, `versus ${g}`);
    } else out = usualCrowdWording(out);
    if (!o.localSponsor) out = out.replace(/\b(\d+) local sponsor(s?)\b/g, "$1 sponsor brand$2");
    return out;
  };
  return {
    ...n,
    summary: fix(n.summary),
    tileWhy: n.tileWhy.map((t) => ({ ...t, text: fix(t.text) })),
    partnerLines: n.partnerLines.map((l) => ({ ...l, text: fix(l.text) })),
  };
}

/**
 * "1 partner line", "15 partner lines": the head of the guard's reasons for partner lines dropped or trimmed at once.
 * The count stays plain digits: the engine's step, the plan page and the product eval read it back with `(\d+)`.
 */
export function partnerLineCount(n: number): string {
  return `${n} partner ${n === 1 ? "line" : "lines"}`;
}

/** The earlier form of those reasons, "15 partner line(s) trimmed: ...": its count and the rest after "line(s)". */
export const PARTNER_LINE_S_RE = /^([\d,]+) partner line\(s\)( (?:trimmed|dropped): )/;

/** A stored "15 partner line(s) trimmed: ..." in the form a run now writes ("15 partner lines trimmed: ..."). */
export function partnerLineReason(reason: string): string {
  return reason.replace(PARTNER_LINE_S_RE, (_m, n: string, rest: string) => `${partnerLineCount(Number(n.replace(/,/g, "")))}${rest}`);
}

/** "tag" or "tags" in a clause: the clause claims a tag the place shares. */
const TAG_CLAIM_RE = /\btags?\b/i;

/**
 * A partner line may name only the tags listed under that partner's shared tags (`explain.tags`). A clause that
 * claims a tag ("sharing the bill's country tag") without naming one of them is cut; a line whose first clause does
 * is dropped. Returns the lines kept and how many were changed or dropped.
 */
export function partnerLinesWithinTags(
  lines: readonly { entityId: string; text: string }[],
  partners: readonly Pick<Partner, "entity" | "explain">[],
): { lines: { entityId: string; text: string }[]; changed: number; dropped: number } {
  const tagsOf = new Map(partners.map((p) => [p.entity.entityId, (p.explain?.tags ?? []).map((t) => t.name.trim().toLowerCase()).filter(Boolean)]));
  let changed = 0;
  let dropped = 0;
  const out: { entityId: string; text: string }[] = [];
  for (const l of lines) {
    const allowed = tagsOf.get(l.entityId) ?? [];
    const supported = (clause: string) => !TAG_CLAIM_RE.test(clause) || allowed.some((t) => clause.toLowerCase().includes(t));
    const sentences = l.text.match(/[^.!?]+[.!?]*/g) ?? [l.text];
    const kept: string[] = [];
    let firstBad = false;
    for (const sentence of sentences) {
      const body = sentence.trim().replace(/[.!?]+$/, "");
      if (body === "") continue;
      const clauses = body.split(/,\s+|;\s+|\s+-\s+/);
      if (!supported(clauses[0] ?? "")) {
        if (kept.length === 0) firstBad = true;
        continue;
      }
      kept.push(`${clauses.filter((c, i) => i === 0 || supported(c)).join(", ").trim()}.`);
    }
    if (firstBad || kept.length === 0) {
      dropped++;
      continue;
    }
    const text = kept.join(" ").replace(/\s+/g, " ").trim();
    if (text !== l.text.trim()) changed++;
    out.push({ ...l, text });
  }
  return { lines: out, changed, dropped };
}

const STREET_WORDS: Record<string, string> = { street: "st", avenue: "ave", road: "rd", boulevard: "blvd" };

/**
 * A partner's area is the map square its search started from, and the place can sit up to 2 km from its centre (3.5
 * km when widened): "Sports bar on H Street NE" for a place at 1007 8th St SE reads "Sports bar near H Street NE".
 * Kept as written when the area is a street the place's own address is on ("on H Street NE" at 1339 H St NE).
 */
export function partnerLinesNearArea<L extends { entityId: string; text: string }>(
  lines: readonly L[],
  partners: readonly Pick<Partner, "entity" | "tileName" | "address">[],
): { lines: L[]; changed: number } {
  const byId = new Map(partners.map((p) => [p.entity.entityId, p]));
  let changed = 0;
  const out = lines.map((l) => {
    const p = byId.get(l.entityId);
    const area = p?.tileName?.trim();
    if (!p || !area) return l;
    const names = [escapeRe(area)];
    const street = /^(.+?)\s+(street|avenue|road|boulevard)\b/i.exec(area);
    if (street) {
      const word = street[2]!.toLowerCase();
      const onIt = new RegExp(`(?<![A-Za-z0-9])${escapeRe(street[1]!)}\\s+(?:${word}|${STREET_WORDS[word]})\\b`, "i");
      if (onIt.test(p.address ?? "")) return l;
      // "on H Street" names the area "H Street NE" too (and "on U Street" the area "U Street / Shaw").
      names.push(`${escapeRe(street[1]!)}\\s+(?:${word}|${STREET_WORDS[word]})\\b(?:\\s+(?:NE|NW|SE|SW)\\b)?`);
    }
    // "in the Vienna area" already says it loosely and stays as written.
    const re = new RegExp(`\\b(in|on)\\s+(?:${names.join("|")})(?![A-Za-z])(?!\\s+area\\b)`, "gi");
    const text = l.text.replace(re, (_m, prep: string) => `${prep[0] === prep[0]!.toUpperCase() ? "Near" : "near"} ${area}`);
    if (text === l.text) return l;
    changed++;
    return { ...l, text };
  });
  return { lines: out, changed };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runCopy(ctx: RunContext, inp: CopyInputs): Promise<CopyResult> {
  const provenance: string[] = [];
  const reasons: string[] = [];
  let q14: RankedTag[] = [];
  node(ctx, "Q14 copy allowlist", "bill");
  try {
    const r = await ctx.qloo.tagProfile({ signalEntities: seedIds(inp.seeds), tagTypes: Q14_TAG_TYPES, diversifyBySubtype: true, take: 30 });
    q14 = r.value;
    provenance.push(r.ledgerRef);
  } catch (err) {
    const ref = (err as { ledgerRef?: string }).ledgerRef;
    if (ref) provenance.push(ref);
    reasons.push("the Qloo tag list failed");
  }
  for (const t of q14) ctx.seenTags.push({ id: t.id, name: t.name, ...(t.type ? { type: t.type } : {}) });

  // The denylist runs on every candidate (its sensitive names feed the guard); only taste tags are then usable.
  const taste = <T extends QlooTag>(a: ReturnType<typeof buildCopyAllowlist<T>>) => ({ ...a, tags: dedupeTags(a.tags.filter((t) => isTasteTag(t))) });
  const billAllow = taste(buildCopyAllowlist(q14));
  const partnerCopyTags = inp.rawPartnerTags.filter((t) => PARTNER_COPY_NAMESPACES.some((ns) => t.id.startsWith(ns)));
  const partnerAllow = taste(buildCopyAllowlist(partnerCopyTags));
  // Ticketmaster's 21+ is the only way in; the operator's all-ages setting can only take it away.
  const adult = ctx.bill.legalAgeEnforced === true && ctx.operator.allAges !== true;
  const keep = (t: QlooTag) => adult || alcoholFree(t);
  const billTags = billAllow.tags.filter(keep);
  const partnerTags = partnerAllow.tags.filter(keep);
  const heldBack = billAllow.tags.length - billTags.length + (partnerAllow.tags.length - partnerTags.length);
  if (heldBack > 0) {
    ctx.guardReasons.push(
      `${plural(heldBack, "tag")} held back from copy on ${ctx.bill.legalAgeEnforced === true ? "a show you set to all ages" : "a show that is not 21+"} (alcohol).`,
    );
  }
  const fromPartnersOnly = billTags.length < MIN_BILL_TAGS;
  const allow: QlooTag[] = fromPartnersOnly ? partnerTags : [...billTags, ...partnerTags.filter((t) => !billTags.some((b) => b.id === t.id))];
  if (fromPartnersOnly) reasons.push(`only ${billTags.length} of the bill's ${billTags.length === 1 ? "tags was" : "tags were"} approved, so the lines use the partners' tags`);

  // The operator's numbers, labelled as what they are: what-ifs on a sample sheet only, the operator's own inputs on
  // a live one (the narration must not call a live sheet's numbers what-ifs).
  const kind = inp.hypothetical ? "what-if" : "operator input";
  const whatIf: { label: string; value: number }[] = [];
  if (ctx.operator.seatsLeft !== null) whatIf.push({ label: `seats left (${kind})`, value: ctx.operator.seatsLeft });
  if (ctx.operator.capacity !== null) whatIf.push({ label: `capacity (${kind})`, value: ctx.operator.capacity });
  if (ctx.operator.mediaBudgetUsd !== null) whatIf.push({ label: `media budget left, USD (${kind})`, value: ctx.operator.mediaBudgetUsd });
  const shares = inp.budget.map((b) => ({ label: `budget share for ${b.geohash} (heuristic)`, value: Math.round(b.share * 1000) / 1000 }));

  node(ctx, "narration", "narration");
  const narration: NarrationResult = await narrate(
    {
      bill: ctx.bill,
      tiles: inp.tiles,
      partners: inp.partners,
      prePost: inp.prePost,
      media: inp.media,
      compareTags: inp.compare,
      allowlistTags: allow.map((t) => ({ id: t.id, name: t.name })),
      numbers: [...whatIf, { label: "partners on the sheet", value: inp.partners.length }, ...shares],
      hypothetical: inp.hypothetical,
      streetTeamDay: streetDay(ctx),
    },
    { client: ctx.narrator.client, ...(ctx.narrator.spend ? { spend: ctx.narrator.spend } : {}), ledger: ctx.ledger },
  );

  // Fan-facing guard (engine) on copy hooks, with only this run's citable facts.
  const dp = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ctx.bill.date);
  const facts: NarrationFacts = {
    entityIds: [...inp.partners.map((p) => p.entity.entityId), ...inp.prePost.map((s) => s.entity.entityId), ...inp.media.map((m) => m.entity.entityId)],
    geohashes: inp.tiles.map((t) => t.geohash),
    numbers: [
      ...collectFactNumbers([inp.tiles.map((t) => [t.lift, t.billPct, t.housePct]), inp.budget.map((b) => b.share), whatIf.map((w) => w.value)]),
      inp.partners.length,
      inp.prePost.length,
      inp.tiles.length,
      ...(dp ? [Number(dp[1]), Number(dp[2]), Number(dp[3])] : []),
    ],
    allowlistTagIds: allow.map((t) => t.id),
    allowlistTagNames: allow.map((t) => t.name),
    names: [
      ...ctx.bill.acts.map((a) => a.name),
      ctx.bill.venue.name,
      ctx.bill.venue.city,
      displayDate(ctx.bill.weekday, ctx.bill.date),
      ...inp.tiles.map((t) => t.name ?? "").filter(Boolean),
      ...inp.partners.map((p) => p.entity.name),
      ...inp.prePost.map((s) => s.entity.name),
      ...inp.media.map((m) => m.entity.name),
    ],
    deniedTagNames: [...billAllow.deniedNames, ...partnerAllow.deniedNames],
    ledgerRefs: ctx.ledger.entries().map((e) => e.id),
  };
  const fanFacing = validateNarration(
    { summary: "", tileWhy: [], partnerLines: [], templated: narration.templated, copyHooks: narration.copyHooks },
    facts,
    { legalAgeEnforced: adult ? true : ctx.bill.legalAgeEnforced === true ? false : ctx.bill.legalAgeEnforced },
  );
  const hooks: CopyHook[] = (fanFacing.narration.copyHooks ?? []).filter((h) => h.tagIds.every((id) => !isDeniedTag(id)));
  const dropped = narration.guard.dropped + fanFacing.report.dropped;
  const guardReasons = [...narration.guard.reasons, ...fanFacing.report.reasons.map((r) => `fan-facing guard: ${r}`)];
  if (narration.templated) guardReasons.push(templateLine(narration.templateReason));

  let status: HooksCard["status"] = hooks.length >= 3 ? "ok" : hooks.length > 0 ? "partial" : "empty";
  if (status === "ok" && fromPartnersOnly) status = "partial";
  if (hooks.length < 3) reasons.push(`${plural(hooks.length, "line")} passed the checks`);
  const summary =
    hooks.length > 0
      ? `${plural(hooks.length, "line")}, ${hooks.length === 1 ? "built" : "each built"} only from approved Qloo tags${fromPartnersOnly ? " (from the partners' tags)" : ""}.`
      : "No copy lines.";
  const card = envelope(status, summary, hooks, [...provenance, ...narration.ledgerRefs], status === "ok" ? undefined : `${capFirst(reasons.join("; "))}.`, [
    "No jokes, no artist voice, no artist marks in partner copy.",
  ]);
  return {
    card,
    narration: { summary: narration.summary, tileWhy: narration.tileWhy, partnerLines: narration.partnerLines, templated: narration.templated },
    guardDropped: dropped,
    guardReasons,
    deniedNames: facts.deniedTagNames ? [...facts.deniedTagNames] : [],
    ledgerRefs: narration.ledgerRefs,
    templated: narration.templated,
  };
}
