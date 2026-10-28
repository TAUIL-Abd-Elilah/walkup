/**
 * "Claude alone, same areas" and the "why lift" numbers for /eval. Every number comes from the files
 * scripts/llm-baseline.ts and scripts/why-lift.ts write (evals/llm-baseline/out/); nothing is typed in by hand.
 * The plan, the fixed sentences and the deviations: evals/llm-baseline/protocol.md and results.md.
 */
import completedFile from "../../../../evals/llm-baseline/out/summary.json";
import preregisteredFile from "../../../../evals/llm-baseline/out/preregistered/summary.json";
import exploratoryFile from "../../../../evals/llm-baseline/out/exploratory.json";
import whyLiftFile from "../../../../evals/llm-baseline/out/why-lift.json";

export type MissKey = "not_found" | "outside_area" | "closed" | "not_open" | "chain" | "repeat";

export interface BaselineCounts {
  asked: number;
  returned: number;
  foundInQloo: number;
  foundInArea: number;
  notFound: number;
  outsideArea: number;
  closed: number;
  notOpen: number;
  hoursNotListed: number;
  chain: number;
  repeat: number;
  usable: number;
  onWalkupList: number;
  byOutcome: Record<MissKey | "usable", number>;
}

export interface WalkupBaselineCounts {
  listed: number;
  chains: number;
  usable: number;
  calibrationFound: number | null;
  calibrationInArea: number | null;
}

export interface BaselineBill {
  key: string;
  planId: string;
  headliner: string;
  venue: string;
  checkDay: string;
  areas: Array<{ area: number; label: string; radiusM: number; asked: number; returned: number; answered: boolean }>;
  claude: BaselineCounts;
  walkup: WalkupBaselineCounts;
}

export interface BaselineSummary {
  protocolSha256: string;
  scoredAt: string;
  model: string | null;
  checkDays: string[];
  bills: BaselineBill[];
  total: { claude: BaselineCounts; walkup: WalkupBaselineCounts };
  sentences: string[];
  shows: string;
  doesNotShow: string;
}

export interface ExploratoryCounts {
  namesWithANote: number;
  areasOneAndAHalfTimesAsWide: BaselineCounts;
  notesRemovedBeforeSearch: BaselineCounts;
}

export interface WhyLiftRoom {
  room: string;
  venue: string;
  bills: Array<{ bill: string; radiusKm: number; joinedTiles: number; rawVsUsualCrowd: { rho: number | null; n: number } }>;
  top5: {
    raw: { sameTile: number; samePlace: number; of: number };
    lift: { sameTile: number; samePlace: number; of: number };
  };
}

/** All 12 areas answered (3 of them asked again with a larger token limit: deviation 3). */
export const BASELINE = completedFile as unknown as BaselineSummary;
/** The run exactly as planned: 3 areas got no answer. */
export const BASELINE_PREREGISTERED = preregisteredFile as unknown as BaselineSummary;
/** Checked after the run, not in the plan. */
export const BASELINE_EXPLORATORY = exploratoryFile as unknown as ExploratoryCounts;
export const WHY_LIFT = (whyLiftFile as unknown as { rooms: WhyLiftRoom[] }).rooms;

export const RESULTS_HREF = "https://github.com/TAUIL-Abd-Elilah/walkup/blob/main/evals/llm-baseline/results.md";

export interface BaselineRow {
  bill: string;
  venue: string;
  asked: number;
  usable: number;
  walkupUsable: number;
  sameAsWalkup: number;
}

/** One row per bill, in the protocol's order, then "All four". */
export function baselineRows(s: BaselineSummary = BASELINE): BaselineRow[] {
  const rows = s.bills.map((b) => ({
    bill: b.headliner,
    venue: b.venue,
    asked: b.claude.asked,
    usable: b.claude.usable,
    walkupUsable: b.walkup.usable,
    sameAsWalkup: b.claude.onWalkupList,
  }));
  rows.push({
    bill: "All four",
    venue: "",
    asked: s.total.claude.asked,
    usable: s.total.claude.usable,
    walkupUsable: s.total.walkup.usable,
    sameAsWalkup: s.total.claude.onWalkupList,
  });
  return rows;
}

/** First failing check per name, in the protocol's order and words. */
export function missRows(c: BaselineCounts, day = "Thursday"): Array<{ key: MissKey; label: string; count: number }> {
  const label: Record<MissKey, string> = {
    not_found: "Not found in Qloo",
    outside_area: "Found in Qloo, but outside the area",
    closed: "Marked closed in Qloo",
    not_open: `Closed on ${day}`,
    chain: "A national chain",
    repeat: "A repeat of an earlier name",
  };
  return (Object.keys(label) as MissKey[]).map((key) => ({ key, label: label[key], count: c.byOutcome[key] ?? 0 }));
}

function areaCount(s: BaselineSummary): { all: number; unanswered: number } {
  const areas = s.bills.flatMap((b) => b.areas);
  return { all: areas.length, unanswered: areas.filter((a) => !a.answered).length };
}

/** The run as planned, in one sentence, from its own summary. */
export function preregisteredLine(pre: BaselineSummary = BASELINE_PREREGISTERED): string {
  const { all, unanswered } = areaCount(pre);
  const c = pre.total.claude;
  if (unanswered === 0) return `As planned, every area got an answer, and Claude alone named ${c.usable} usable places of ${c.asked}.`;
  return (
    `As planned, ${unanswered} of the ${all} areas got no answer: the model's reasoning used up most of the 2,000-token limit and the answer was cut off. ` +
    `Counted that way, Claude alone named ${c.usable} usable places in the ${c.returned} names it gave, of ${c.asked} asked. ` +
    `The table counts all ${all} areas, those ${unanswered} asked again with a larger limit.`
  );
}

/** Checked after the run, not in the plan, and said so. */
export function exploratoryLine(e: ExploratoryCounts = BASELINE_EXPLORATORY, done: BaselineSummary = BASELINE): string {
  return (
    `Not in the plan, checked afterwards: with every area 1.5 times as wide, ${e.areasOneAndAHalfTimesAsWide.usable} of Claude's names are usable. ` +
    `${e.namesWithANote} of its ${done.total.claude.returned} names carry its own note, such as "(unverified)" or "(verify name and existence)"; ` +
    `searched without the note, ${e.notesRemovedBeforeSearch.usable} are usable.`
  );
}

/** "anthropic/claude-haiku-5.5" -> "Claude Haiku 5.5". */
export function modelName(slug: string | null): string {
  if (!slug) return "Claude";
  const words = (slug.split("/").pop() ?? slug).split("-").filter(Boolean);
  return words.map((w) => (/^[a-z]/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w)).join(" ");
}

function headliner(key: string): string {
  return BASELINE.bills.find((b) => b.key === key)?.headliner ?? key;
}

function roomName(venue: string): string {
  return venue.split(",")[0]?.trim() || venue;
}

/** Two decimals, half up ("0.4251" -> "0.43"). */
export function rho(v: number | null): string {
  return v === null ? "not computed" : (Math.round(v * 100 + 1e-9) / 100).toFixed(2);
}

/** Protocol section 8, in its fixed words. */
export function whyLiftSentences(r: WhyLiftRoom): string[] {
  const raw = r.top5.raw.sameTile;
  const lift = r.top5.lift.sameTile;
  const [a, b] = r.bills;
  return [
    `At ${roomName(r.venue)}, the two bills share ${raw} of their top 5 raw-heat areas and ${lift} of their top 5 lift areas.`,
    lift < raw ? "Lift separates the two bills more than raw heat does here." : "Raw heat alone separates the two bills as much as lift does here.",
    `Raw heat against the room's usual crowd, over the same areas: Spearman ${rho(a?.rawVsUsualCrowd.rho ?? null)} (${headliner(a?.bill ?? "")}) and ${rho(b?.rawVsUsualCrowd.rho ?? null)} (${headliner(b?.bill ?? "")}).`,
  ];
}

export interface WhyLiftRow {
  room: string;
  rawShared: number;
  rawSharedPlace: number;
  liftShared: number;
  liftSharedPlace: number;
  of: number;
  rhos: string;
}

export function whyLiftRows(rooms: readonly WhyLiftRoom[] = WHY_LIFT): WhyLiftRow[] {
  return rooms.map((r) => ({
    room: roomName(r.venue),
    rawShared: r.top5.raw.sameTile,
    rawSharedPlace: r.top5.raw.samePlace,
    liftShared: r.top5.lift.sameTile,
    liftSharedPlace: r.top5.lift.samePlace,
    of: Math.min(r.top5.raw.of, r.top5.lift.of),
    rhos: r.bills.map((b) => rho(b.rawVsUsualCrowd.rho)).join(" and "),
  }));
}
