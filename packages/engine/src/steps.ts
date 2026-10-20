/**
 * The step stream ("What Walkup decided"): one plain decision per pipeline
 * step, with its cause and receipts. Pure text builders over plain inputs, so
 * the same numbers always give the same sentences.
 *
 * Copy rules: short sentences, a number in every
 * decision, every lift in prose names its baseline with the fixed phrases in
 * `liftInWords`, no ratios like "1.8x" in prose, no marketing words. Callers
 * pass only numbers that are on the sheet (card fields, ledger counts, card
 * summaries), so every number a step prints can be traced.
 *
 * Also here: `ubiquityDrops`, which replays partner scoring without the house
 * twins to name the places the ubiquity penalty pushed off the list.
 */
import type { EnvelopeStatus, LiftTile, QlooEntity, TraceStep, TraceStepKind, Weekday } from "@walkup/contracts";
import { roundTo } from "./num";
import { scorePartnersWithReport, ubiquityPenalty, type PartnerPool, type PartnerScoringOptions } from "./partners";

// ---------------------------------------------------------------------------
// Wording helpers (shared with discovery.ts and explain.ts)
// ---------------------------------------------------------------------------

/**
 * What lift is compared with: the room's own roster ("house"), a genre tag standing in for it ("tag"), or
 * nothing ("none": neither the room's roster nor a pinned genre tag, so there is no lift map).
 */
export type BaselineKind = "house" | "tag" | "none";

export function baselinePhrase(b: BaselineKind): string {
  if (b === "none") return "a usual crowd (there is none to compare with)";
  return b === "tag" ? "the genre baseline" : "the room's usual crowd";
}

/**
 * Lift in prose, always naming the baseline: under 0.95 "below", 0.95 to 1.05
 * "about the same as", 1.05 to 1.3 "a little above", 1.3 and up "about 1.8
 * times". The ratio itself ("1.8x") belongs in tables, never here.
 */
export function liftInWords(lift: number, baseline: BaselineKind = "house"): string {
  const b = baselinePhrase(baseline);
  if (!Number.isFinite(lift)) return `compared with ${b}`;
  if (lift < 0.95) return `below ${b}`;
  if (lift < 1.05) return `about the same as ${b}`;
  if (lift < 1.3) return `a little above ${b}`;
  return `about ${roundTo(lift, 1).toFixed(1)} times ${b}`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd ... */
export function ordinal(n: number): string {
  const i = Math.round(n);
  const mod100 = Math.abs(i) % 100;
  const mod10 = Math.abs(i) % 10;
  const suffix = mod100 >= 11 && mod100 <= 13 ? "th" : mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th";
  return `${i}${suffix}`;
}

/** "a", "a and b", "a, b and c". */
export function joinAnd(items: readonly string[]): string {
  const xs = items.filter((x) => x.trim() !== "");
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "1 place", "24 places", "1,200 places". */
export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "thursday" -> "Thursday". */
export function dayName(day: Weekday | string): string {
  return day ? `${day.charAt(0).toUpperCase()}${day.slice(1).toLowerCase()}` : "";
}

/** Two decimals for a rank correlation, e.g. 0.706 -> "0.71". */
export function corr(x: number): string {
  return roundTo(x, 2).toFixed(2);
}

/** Kilometres from metres, one decimal at most: 1500 -> "1.5", 2000 -> "2". */
export function kmFromM(m: number): string {
  return (m / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function sentence(s: string): string {
  const t = s.trim();
  if (t === "") return "";
  const first = `${t.charAt(0).toUpperCase()}${t.slice(1)}`;
  return /[.?!]$/.test(first) ? first : `${first}.`;
}

function joinSentences(parts: readonly (string | null | undefined | false)[]): string | undefined {
  const out = parts.filter((p): p is string => typeof p === "string" && p.trim() !== "").map(sentence);
  return out.length > 0 ? out.join(" ") : undefined;
}

/** One trace step; drops an empty cause and repeated receipts. */
export function traceStep(
  id: string,
  kind: TraceStepKind,
  label: string,
  decision: string,
  status: EnvelopeStatus,
  ledgerRefs: readonly string[],
  cause?: string,
): TraceStep {
  const step: TraceStep = { id, kind, label, decision: sentence(decision), status, ledgerRefs: [...new Set(ledgerRefs.filter((r) => typeof r === "string" && r !== ""))] };
  if (cause && cause.trim() !== "") step.cause = cause.trim();
  return step;
}

// ---------------------------------------------------------------------------
// Step builders
// ---------------------------------------------------------------------------

export interface ResolveStepInput {
  /** Every act on the bill in bill order, with whether Qloo matched it and, when not, why. */
  acts: { name: string; matched: boolean; reason?: string }[];
  /** Names still waiting for the operator's pick (the run paused). */
  pending?: string[];
  /** Matched acts whose Qloo signal is thin (popularity under the floor). */
  thin?: string[];
  /** Acts whose signal comes from film or TV titles. */
  viaTitles?: string[];
  /** Acts whose first Qloo entry had no taste data and were swapped for another entry from the same search. */
  swapped?: string[];
  venueMatched: boolean;
  status: EnvelopeStatus;
  ledgerRefs: string[];
}

export function resolveStep(i: ResolveStepInput): TraceStep {
  const n = i.acts.length;
  const m = i.acts.filter((a) => a.matched).length;
  const pending = i.pending ?? [];
  let decision: string;
  if (pending.length > 0) decision = `Matched ${m} of ${countOf(n, "act")}; ${joinAnd(pending)} ${pending.length === 1 ? "needs" : "need"} your pick`;
  else if (m === 0) decision = `Couldn't match any of the ${countOf(n, "act")} on the bill to Qloo`;
  else if (m === n) decision = `Matched ${countOf(n, "act")} to Qloo`;
  else decision = `Matched ${m} of ${countOf(n, "act")} to Qloo`;
  const missing = i.acts.filter((a) => !a.matched && !pending.includes(a.name));
  const cause = joinSentences([
    ...missing.map((a) => `${a.name}: ${a.reason ?? "no exact match"}${m > 0 ? ", so the run went on without it" : ""}`),
    (i.thin ?? []).length > 0 ? `${joinAnd(i.thin ?? [])} ${(i.thin ?? []).length === 1 ? "has" : "have"} a thin signal in Qloo` : null,
    (i.viaTitles ?? []).length > 0 ? `Film or TV titles stand in for ${joinAnd(i.viaTitles ?? [])}` : null,
    (i.swapped ?? []).length > 0
      ? `Swapped ${(i.swapped ?? []).length === 1 ? `${joinAnd(i.swapped ?? [])}'s Qloo entry` : `the Qloo entries for ${joinAnd(i.swapped ?? [])}`}: the first match had no taste data (Q1)`
      : null,
    i.venueMatched ? null : "The room isn't in Qloo's catalog, so the run uses the Ticketmaster map point",
  ]);
  return traceStep("resolve", "resolve", "Acts", decision, i.status, i.ledgerRefs, cause);
}

export interface PauseStepInput {
  name: string;
  /** Results the name search returned (from its ledger entry), or null when unknown. */
  matches: number | null;
  /** True on the resumed run (the operator picked); false while the run waits. */
  answered: boolean;
  ledgerRefs: string[];
  /** 1-based, for the step id when several names paused. */
  index?: number;
}

export function pauseStep(i: PauseStepInput): TraceStep {
  const found = i.matches !== null && i.matches > 1 ? `: the search found ${i.matches}` : "";
  const id = `pause-${i.index ?? 1}`;
  if (!i.answered) {
    return traceStep(id, "pause", "Your pick", `Waiting for you to say which ${i.name} is on the bill${found}`, "needs_input", i.ledgerRefs);
  }
  return traceStep(id, "pause", "Your pick", `Stopped to ask which ${i.name} you meant${found}`, "ok", i.ledgerRefs, "You picked one, and the run went on from there.");
}

export interface BaselineStepInput {
  kind: "house" | "tag" | "none";
  /** Roster headliners resolved in Qloo. */
  headliners: number;
  /** Shows on the room's roster (the Ticketmaster call's result count), or null when unknown. */
  shows: number | null;
  /** Fewest headliners for a house baseline (5). */
  minHeadliners: number;
  /** When the room's own heatmap failed or came back empty and a genre tag stood in on the map: what happened. */
  heatFallback?: string | null;
  /** Comedy bill: no genre-wide crowd can stand in for the room (no comedy baseline is pinned). */
  comedy?: boolean;
  status: EnvelopeStatus;
  ledgerRefs: string[];
}

export function baselineStep(i: BaselineStepInput): TraceStep {
  const onShows = i.shows !== null && i.shows > 0 ? ` on its next ${countOf(i.shows, "show")}` : "";
  if (i.kind === "house") {
    const decision = `Built the room's usual crowd from ${countOf(i.headliners, "headliner")}${onShows}`;
    if (i.heatFallback) {
      return traceStep("baseline", "baseline", "Usual crowd", decision, "degraded", i.ledgerRefs, sentence(`The room's own heatmap ${i.heatFallback}, so a genre tag stands in on the map`));
    }
    return traceStep("baseline", "baseline", "Usual crowd", decision, i.status, i.ledgerRefs);
  }
  if (i.kind === "tag") {
    const cause = `Only ${countOf(i.headliners, "headliner")}${onShows} matched Qloo, fewer than ${i.minHeadliners}, so the map compares this bill with a genre, not with this room.`;
    return traceStep("baseline", "baseline", "Usual crowd", "Used a genre tag for the room's usual crowd", "degraded", i.ledgerRefs, cause);
  }
  return traceStep(
    "baseline",
    "baseline",
    "Usual crowd",
    "Couldn't build the room's usual crowd",
    i.status === "ok" ? "degraded" : i.status,
    i.ledgerRefs,
    i.comedy
      ? "Too few of the room's headliners matched Qloo, and comedy has no genre-wide crowd to stand in."
      : "Too few of the room's headliners matched Qloo and no genre tag is pinned for this bill.",
  );
}

export interface HeatStepInput {
  status: EnvelopeStatus;
  baseline: BaselineKind;
  /** The first area on the list (highest lift after the operator's exclusions), or null when none stood out. */
  first: { name: string; lift: number } | null;
  /** Areas that pass the top-area test. */
  topCount: number;
  minLift: number;
  billFloor: number;
  excludedAreas: number;
  /** Set when the heatmap widened: the radius it widened to and the one it started from (km). */
  widened?: { fromKm: number; toKm: number; minCells: number } | null;
  /** Set when the map came back thin: the number of map cells. */
  thinCells?: number | null;
  /** Set when there is no lift map: what happened, in one sentence. */
  failure?: string | null;
  ledgerRefs: string[];
}

/** A 0..1 percentile floor as a 0..100 number (0.7 -> 70). */
function pctOf(v: number): number {
  return Math.round(v <= 1 ? v * 100 : v);
}

export function heatStep(i: HeatStepInput): TraceStep {
  const b = baselinePhrase(i.baseline);
  if (i.failure) return traceStep("heat", "heat", "Lift map", i.failure, i.status, i.ledgerRefs);
  const extra = [
    i.excludedAreas > 0 ? `Left out ${countOf(i.excludedAreas, "area")} at your request` : null,
    i.widened ? `The search widened to ${i.widened.toKm} km: fewer than ${i.widened.minCells} map cells came back inside ${i.widened.fromKm} km` : null,
    i.thinCells !== null && i.thinCells !== undefined ? `Only ${countOf(i.thinCells, "map cell")} came back, so the map is thin` : null,
  ];
  // The two tests an area must pass, in the words of the sheet's lift method line.
  const tests = `at least ${i.minLift} times ${b}, and percentile ${pctOf(i.billFloor)} or higher for this crowd`;
  if (!i.first) {
    const cause = joinSentences([`No area passed both tests (${tests}), so partners are picked near the venue`, ...extra]);
    return traceStep("heat", "heat", "Lift map", `No area stood out against ${b}`, i.status, i.ledgerRefs, cause);
  }
  const cause = joinSentences([`${countOf(i.topCount, "area")} ${i.topCount === 1 ? "passes" : "pass"} both tests: ${tests}`, ...extra]);
  return traceStep("heat", "heat", "Lift map", `Put ${i.first.name} first: ${liftInWords(i.first.lift, i.baseline)}`, i.status, i.ledgerRefs, cause);
}

export interface CheckStepInput {
  /** Split-half Spearman, or null when the check could not run. */
  splitHalf: number | null;
  /** The bar it must clear (0.5). */
  threshold: number;
  /** Plain line from the lift step when the check could not run or is limited. */
  note?: string;
  /** Spearman(lift, raw foot traffic), or null. */
  liftVsHeat: number | null;
  /** True when lift mostly follows raw foot traffic (the engine's liftWeak). */
  followsTraffic: boolean;
  /** Spearman(lift, the bill's own heat), or null; above the threshold the map shows where the crowd is, not where it stands out. */
  liftVsOwnHeat?: number | null;
  tracksOwnHeat?: boolean;
  ledgerRefs: string[];
}

export function checkStep(i: CheckStepInput): TraceStep {
  const splitWeak = i.splitHalf !== null && !(i.splitHalf > i.threshold);
  const traffic = i.followsTraffic && i.liftVsHeat !== null;
  const own = i.tracksOwnHeat === true;
  if (splitWeak || i.followsTraffic || own) {
    const why = [
      splitWeak ? "the two halves of the bill put this crowd in different areas" : null,
      i.followsTraffic ? "the map mostly follows general popularity" : null,
      own ? "the map shows where this crowd is, not where it stands out" : null,
    ].filter((x): x is string => !!x);
    const cause = joinSentences([
      splitWeak ? `The two halves rank the areas differently: ${corr(i.splitHalf as number)}, at or below the ${i.threshold} the check needs (1 means the same order)` : null,
      traffic ? `Lift follows general popularity: ${corr(i.liftVsHeat as number)}, where 1 means the same order` : null,
      own && i.liftVsOwnHeat !== null && i.liftVsOwnHeat !== undefined ? `Lift ranks areas almost like this crowd's own map: ${corr(i.liftVsOwnHeat)}, where 1 means the same order` : null,
    ]);
    return traceStep("heat-check", "heat", "Map check", `Ranked partners near the venue: ${joinAnd(why)}`, "partial", i.ledgerRefs, cause);
  }
  if (i.splitHalf === null) {
    return traceStep("heat-check", "heat", "Map check", "Couldn't check the map by splitting the bill in two", "partial", i.ledgerRefs, i.note);
  }
  const cause = joinSentences([`The two halves rank the areas alike: ${corr(i.splitHalf)}, where 1 means the same order`, i.note]);
  return traceStep("heat-check", "heat", "Map check", "Split the bill's acts in two and mapped each half: the two maps broadly agree", "ok", i.ledgerRefs, cause);
}

export interface PartnersStepInput {
  status: EnvelopeStatus;
  kept: number;
  /** Partners picked inside top areas, and how many areas they span. */
  inAreas: number;
  areas: number;
  /** Partners from the near-venue pool. */
  nearVenue: number;
  /** Top areas the run asked for (3) and how many it got. */
  areasWanted: number;
  areasUsed: number;
  day: Weekday | string;
  hoursUnknown: number;
  droppedClosed: number;
  /** Places whose hours say they are closed on the street-team day. */
  droppedHoursClosed?: number;
  droppedCategory: number;
  categoryReason?: "all-ages show" | "your exclusions" | null;
  /** Area searches that came back short and widened, and the radius they widened to (m). */
  widenedRadius: number;
  widenedRadiusM: number;
  widenedCategories: number;
  belowMinimum: boolean;
  minTotal: number;
  skippedCategories: number;
  /** National chains (hand-kept list) the chain rule moved below local places, and the names of those now off the list. */
  chainsMoved?: number;
  chainsOffList?: readonly string[];
  /** Set when the partner step failed: what happened, in one sentence. */
  failure?: string | null;
  ledgerRefs: string[];
}

/** The chain rule's trace line: how many chains moved below local places, and which ones fell off the list. */
export function chainsCause(moved: number | undefined, offList: readonly string[] | undefined, local: string): string | null {
  const n = moved ?? 0;
  if (n <= 0) return null;
  // Two stores of one brand read "Panera Bread (2)".
  const counts = new Map<string, number>();
  for (const name of offList ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
  const off = [...counts].map(([name, k]) => (k > 1 ? `${name} (${k})` : name));
  const head = `Moved ${countOf(n, "national chain")} below the local ${local}`;
  return off.length > 0 ? `${head}; ${joinAnd(off)} no longer ${(offList ?? []).length === 1 ? "makes" : "make"} the list` : head;
}

export function partnersStep(i: PartnersStepInput): TraceStep {
  if (i.failure) return traceStep("partners", "partners", "Partners", i.failure, i.status, i.ledgerRefs);
  let decision: string;
  if (i.kept === 0) decision = "No place passed the filters";
  else if (i.nearVenue === 0) decision = `Kept ${countOf(i.kept, "place")} across ${countOf(i.areas, "top area")}, at most 2 of a kind in each`;
  else if (i.inAreas === 0) decision = `Kept ${countOf(i.kept, "place")} near the venue, at most 2 of a kind`;
  else decision = `Kept ${countOf(i.kept, "place")}: ${i.inAreas} in ${countOf(i.areas, "top area")} and ${i.nearVenue} near the venue`;
  const day = dayName(i.day);
  const cause = joinSentences([
    i.kept > 0 && i.hoursUnknown === 0 ? `Qloo ranked them for this crowd, and every one is open ${day}` : null,
    i.kept > 0 && i.hoursUnknown > 0
      ? `Qloo ranked them for this crowd. ${countOf(i.hoursUnknown, "place")} ${i.hoursUnknown === 1 ? "lists" : "list"} no hours for ${day}, so call first; the rest are open`
      : null,
    i.droppedClosed > 0 ? `Dropped ${countOf(i.droppedClosed, "place")} marked closed` : null,
    (i.droppedHoursClosed ?? 0) > 0 ? `Dropped ${countOf(i.droppedHoursClosed ?? 0, "place")} closed on ${day}` : null,
    i.droppedCategory > 0 ? `Left out ${countOf(i.droppedCategory, "place")} by type (${i.categoryReason ?? "your exclusions"})` : null,
    i.areasUsed < i.areasWanted && i.areasUsed > 0 ? `Only ${countOf(i.areasUsed, "area")} stood out, so the rest of the list comes from near the venue` : null,
    i.widenedRadius > 0 ? `${countOf(i.widenedRadius, "area search", "area searches")} came back short and widened to ${i.widenedRadiusM.toLocaleString("en-US")} m` : null,
    i.widenedCategories > 0 ? `${countOf(i.widenedCategories, "search", "searches")} also took in more kinds of places` : null,
    i.skippedCategories > 0 ? `${countOf(i.skippedCategories, "kind")} of place skipped: no pinned tag yet` : null,
    chainsCause(i.chainsMoved, i.chainsOffList, "places"),
    i.belowMinimum ? `That's short of the ${i.minTotal} the list aims for, so treat it as a starting list` : null,
  ]);
  return traceStep("partners", "partners", "Partners", decision, i.status, i.ledgerRefs, cause);
}

export interface UsualCrowdStepInput {
  baseline: BaselineKind;
  /** Pools that got a house twin. */
  compared: number;
  /** Where the house twin failed ("tile 2", "near venue"). */
  failed: string[];
  /** Names of places the penalty pushed off the list (see `ubiquityDrops`). */
  dropped: string[];
  /** Kept places whose score carries a penalty, and how many were kept. */
  penalized: number;
  kept: number;
  ledgerRefs: string[];
}

export function usualCrowdStep(i: UsualCrowdStepInput): TraceStep {
  const b = baselinePhrase(i.baseline);
  const failedLine = i.failed.length > 0 ? `The same search for ${b} failed for ${joinAnd(i.failed)}, so those places weren't compared` : null;
  if (i.compared === 0) {
    return traceStep("partners-usual", "partners", "Usual-crowd overlap", `Couldn't compare the list with ${b}`, "partial", i.ledgerRefs, joinSentences([failedLine]));
  }
  const status: EnvelopeStatus = i.failed.length > 0 ? "partial" : "ok";
  if (i.dropped.length > 0) {
    const one = i.dropped.length === 1;
    const why = i.baseline === "house" ? `so ${one ? "it'd" : "they'd"} suit any night here` : `so ${one ? "it says" : "they say"} little about this bill`;
    // Every pick is marked down, not removed: these fell below places that fit this bill better.
    const cause = joinSentences([
      `${joinAnd(i.dropped)}: the same search for ${b} ranks ${one ? "it" : "them"} about as high, ${why}`,
      `${one ? "It comes" : "They come"} back only if nothing better is open nearby`,
      failedLine,
    ]);
    return traceStep(
      "partners-usual",
      "partners",
      "Usual-crowd overlap",
      `Marked down the places ${b} ranks as high; ${countOf(i.dropped.length, "place")} fell off the list`,
      status,
      i.ledgerRefs,
      cause,
    );
  }
  if (i.penalized > 0) {
    return traceStep(
      "partners-usual",
      "partners",
      "Usual-crowd overlap",
      `Marked down ${i.penalized} of the ${countOf(i.kept, "place")} that ${b} ranks nearly as high; none fell off the list`,
      status,
      i.ledgerRefs,
      joinSentences([failedLine]),
    );
  }
  return traceStep("partners-usual", "partners", "Usual-crowd overlap", `None of the ${countOf(i.kept, "place")} ranks as high for ${b}`, status, i.ledgerRefs, joinSentences([failedLine]));
}

export interface DeclaredStepInput {
  status: EnvelopeStatus;
  declared: number;
  ranked: number;
  ledgerRefs: string[];
}

export function declaredStep(i: DeclaredStepInput): TraceStep {
  const unranked = i.declared - i.ranked;
  const cause = unranked > 0 ? sentence(`${unranked} ${unranked === 1 ? "isn't" : "aren't"} in Qloo's catalog, so ${unranked === 1 ? "it stays" : "they stay"} on your list in your order`) : undefined;
  return traceStep("declared", "partners", "Your list", `Ranked ${i.ranked} of your ${countOf(i.declared, "place")} for this bill`, i.status, i.ledgerRefs, cause);
}

export interface PrePostStepInput {
  status: EnvelopeStatus;
  spots: number;
  unknownHours: number;
  /** Search radius used (m), or null when unknown. */
  radiusM: number | null;
  /** Set when the search widened: the radius it started from (m) and the fewest spots wanted. */
  widened?: { fromM: number; minSpots: number } | null;
  /** Bar spots kept off fan-facing copy, and Ticketmaster's age rule for the show. */
  barsOperatorOnly: number;
  legalAgeEnforced: boolean | null;
  /** Spots left out by type before picking (operator exclusions, or every bar on an all-ages show). */
  typeDrops?: { count: number; reason: string } | null;
  /** National chains the chain rule moved below local spots, and the names of those now off the list. */
  chainsMoved?: number;
  chainsOffList?: readonly string[];
  failure?: string | null;
  ledgerRefs: string[];
}

export function prePostStep(i: PrePostStepInput): TraceStep {
  if (i.failure) return traceStep("prepost", "prepost", "Before and after", i.failure, i.status, i.ledgerRefs);
  const within = i.radiusM !== null ? ` within ${kmFromM(i.radiusM)} km of the room` : " near the room";
  let decision: string;
  if (i.spots === 0) decision = `No spot${within} came back open on show night`;
  else if (i.unknownHours === 0) decision = `Picked ${countOf(i.spots, "spot")}${within}, open on show night`;
  else decision = `Picked ${countOf(i.spots, "spot")}${within}; ${i.unknownHours} ${i.unknownHours === 1 ? "lists" : "list"} no hours for show night, so call first`;
  const cause = joinSentences([
    i.widened && i.radiusM !== null ? `Fewer than ${i.widened.minSpots} came back inside ${kmFromM(i.widened.fromM)} km, so the search widened to ${kmFromM(i.radiusM)} km` : null,
    i.typeDrops && i.typeDrops.count > 0 ? `Left out ${countOf(i.typeDrops.count, "place")} by type (${i.typeDrops.reason})` : null,
    chainsCause(i.chainsMoved, i.chainsOffList, "spots"),
    i.barsOperatorOnly > 0
      ? `Bars stay off fan copy: ${i.legalAgeEnforced === false ? "Ticketmaster lists the show as all ages" : "Ticketmaster doesn't list an age limit for the show"}`
      : null,
  ]);
  return traceStep("prepost", "prepost", "Before and after", decision, i.status, i.ledgerRefs, cause);
}

export interface MediaStepInput {
  status: EnvelopeStatus;
  podcasts: number;
  sponsor: boolean;
  /** True when any pick is labelled local (the probe showed rankings move). */
  local: boolean;
  /** Alcohol, tobacco and gambling brands were excluded, and why. */
  adultBrandsExcluded: boolean;
  legalAgeEnforced: boolean | null;
  /** The operator set the show to all ages (it can only add restrictions to Ticketmaster's rule). */
  allAgesByOperator?: boolean;
  ledgerRefs: string[];
}

export function mediaStep(i: MediaStepInput): TraceStep {
  let decision: string;
  if (i.podcasts === 0 && !i.sponsor) decision = "No podcasts or sponsor brand came back";
  else if (i.podcasts === 0) decision = "Added 1 sponsor brand; no podcasts came back";
  else decision = `Added ${countOf(i.podcasts, "podcast")}${i.sponsor ? " and 1 sponsor brand" : "; no sponsor brand came back"}`;
  const cause = joinSentences([
    (i.podcasts > 0 || i.sponsor) && !i.local ? "All are labelled national: local ranking isn't verified yet" : null,
    i.adultBrandsExcluded
      ? `Alcohol, tobacco and gambling brands are left out: ${i.allAgesByOperator === true && i.legalAgeEnforced === true ? "you set the show to all ages" : i.legalAgeEnforced === false ? "Ticketmaster lists the show as all ages" : "Ticketmaster doesn't list an age limit for the show"}`
      : null,
  ]);
  return traceStep("media", "media", "Podcasts and sponsor", decision, i.status, i.ledgerRefs, cause);
}

export interface NarrateStepInput {
  /** True when the deterministic template wrote the text. */
  templated: boolean;
  hooks: number;
  hooksStatus: EnvelopeStatus;
  ledgerRefs: string[];
}

export function narrateStep(i: NarrateStepInput): TraceStep {
  const lines = i.hooks > 0 ? ` and ${countOf(i.hooks, "fan copy line")}` : "";
  const decision = i.templated ? `Wrote the summary${lines} from a fixed template; no model was called` : `Claude wrote the summary${lines} from this run's results`;
  const cause = i.hooks === 0 ? "No copy line passed the tag allowlist and the checks." : i.hooksStatus !== "ok" ? `Only ${countOf(i.hooks, "copy line")} passed the tag allowlist and the checks.` : undefined;
  return traceStep("narrate", "narrate", "Summary", decision, i.hooks === 0 ? "partial" : "ok", i.ledgerRefs, cause);
}

export interface GuardStepInput {
  /** Lines the guards dropped. */
  dropped: number;
  /** Tags the policy denylist removed (a count only: class names and tag names stay off the step). */
  denied: number;
  /** Alcohol tags held back from fan copy on a show that isn't adults only. */
  alcoholHeld: number;
  /** The operator set the show to all ages (Ticketmaster may still list it as 21+). */
  allAgesByOperator?: boolean;
  ledgerRefs: string[];
}

export function guardStep(i: GuardStepInput): TraceStep {
  const decision =
    i.dropped === 0
      ? "Checked every line against this run's requests; nothing had to go"
      : `Dropped ${countOf(i.dropped, "line")} that cited something this run didn't return`;
  const cause = joinSentences([
    i.denied > 0 ? `Held back ${countOf(i.denied, "tag")} by policy: none of them appears in copy or on this sheet` : null,
    i.alcoholHeld > 0
      ? `Kept ${countOf(i.alcoholHeld, "alcohol tag")} out of fan copy: ${i.allAgesByOperator ? "you set the show to all ages" : "Ticketmaster doesn't list the show as 21+"}`
      : null,
  ]);
  return traceStep("guard", "guard", "Checks", decision, "ok", i.ledgerRefs, cause);
}

// ---------------------------------------------------------------------------
// Places the ubiquity penalty pushed off the list
// ---------------------------------------------------------------------------

export interface UbiquityDrop {
  entity: QlooEntity;
  /** Ledger id of the pool the place came from, and of its house twin. */
  ledgerRef: string;
  twinRef: string;
  qlooRank: number;
  houseRank: number;
  penalty: number;
}

/**
 * Places that make the list when the pools are scored without their house
 * twins but not with them, and that carry a penalty in their pool: the places
 * the ubiquity penalty pushed off. Same options as the real scoring, so the
 * only difference is the penalty. Order: pool order, then Qloo rank.
 */
export function ubiquityDrops(pools: readonly PartnerPool[], tiles: readonly LiftTile[], opts: PartnerScoringOptions = {}): UbiquityDrop[] {
  if (!pools.some((p) => p.house)) return [];
  const base: PartnerScoringOptions = { ...opts };
  delete base.extraChips;
  const withTwins = new Set(scorePartnersWithReport(pools, tiles, base).partners.map((p) => p.entity.entityId));
  const bare = pools.map((p) => ({ tileGeohash: p.tileGeohash, ledgerRef: p.ledgerRef, entities: p.entities }));
  const without = scorePartnersWithReport(bare, tiles, base).partners;
  const out: UbiquityDrop[] = [];
  const seen = new Set<string>();
  for (const p of without) {
    const id = p.entity.entityId;
    if (withTwins.has(id) || seen.has(id)) continue;
    const pool = pools.find((x) => x.ledgerRef === p.chips[0]?.ledgerRef && x.tileGeohash === p.tileGeohash) ?? pools.find((x) => x.tileGeohash === p.tileGeohash);
    const twin = pool?.house;
    if (!pool || !twin) continue;
    const houseRank = twin.ranks.get(id) ?? null;
    if (houseRank === null) continue;
    const penalty = ubiquityPenalty(p.qlooRank, pool.entities.length, houseRank, twin.size, opts.ubiquity ?? {});
    if (!(penalty > 0)) continue;
    seen.add(id);
    out.push({ entity: p.entity, ledgerRef: pool.ledgerRef, twinRef: twin.ledgerRef, qlooRank: p.qlooRank, houseRank, penalty });
  }
  const poolIndex = (ref: string) => pools.findIndex((x) => x.ledgerRef === ref);
  return out.sort((a, b) => poolIndex(a.ledgerRef) - poolIndex(b.ledgerRef) || a.qlooRank - b.qlooRank);
}
