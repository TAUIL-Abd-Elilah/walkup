/**
 * Everything the one-page PDF prints, as plain strings: header, the discovery
 * line, the six panels and the footer. The React tree in pdf.ts only lays this
 * out, so the content rules (fan-facing filters, call order, caps, the sample
 * label) live and are tested here. The web print sheet (/s/[id]) reads the same
 * model, and `sections` says which sections the page prints, so the paper and
 * the PDF carry the same sections and say the same things.
 */
import type { Envelope, LiftTile, Partner, PartnerConfidence, StreetSheet } from "@walkup/contracts";
import { LIMITS_EVERY_SHEET } from "@walkup/contracts";
import { DISCOVERY_RULES, findAlcoholTerm, LIFT_DEFAULTS } from "@walkup/engine";
import { partnerIsFanFacing, spotIsFanFacing } from "./audience";
import {
  actsLine,
  areaLabel,
  ATTRIBUTION,
  categoryLabel,
  countsAreWhatIf,
  DECLARED_UNRANKED,
  FIXTURE_NOTICE,
  formatHours,
  formatInt,
  formatKm,
  formatLift,
  formatPct,
  formatPhone,
  formatShowDate,
  formatUsd,
  HOURS_NOT_LISTED,
  hoursWeekday,
  isAllAgesForCopy,
  ledgerRanges,
  LESS_SURE_NOTE,
  mapReachKm,
  NEAR_VENUE,
  partnerAreaText,
  partnerLessSure,
  partnerWhyLine,
  partnerWhyRefs,
  PHONE_NOT_LISTED,
  realLimits,
  receiptGroup,
  SAMPLE_ATTRIBUTION,
  SAMPLE_LABEL,
  sentencesUpTo,
  sheetAgeLabel,
  sheetSpots,
  shortDomain,
  spotSharesDiffer,
  SPOT_NOT_IN_USUAL_SHORT,
  spotsShareNote,
  spotVsUsual,
  streetDaysText,
  SUGGESTED_NOT_AFFILIATED,
  tileLabel,
  tMinusDays,
  tMinusLabel,
  topTiles,
  weekdayShort,
} from "./format";
import { areaZips } from "./area-zips";
import { partnerVisits, type PartnerVisit } from "./ics";
import { apportion, areaBudget, declaredInCallOrder } from "./tables";

/**
 * "operator": the street sheet as the operator uses it. "fan": the fan-facing
 * rules apply to panels 2 and 4 and the sponsor (on a show not known to be 21+,
 * no bars or alcohol words).
 */
export type Audience = "operator" | "fan";

export interface SheetModelOptions {
  audience?: Audience;
  /** Caps per panel (the sheet is one page). */
  maxPartners?: number; // 25
  maxDeclared?: number; // 12
  maxSpots?: number; // 8
  maxPodcasts?: number; // 4
  maxHooks?: number; // 3
  maxLimits?: number; // 8
  /** Top tiles on the map and in the list. Default 5. */
  maxTiles?: number;
  /** Where the full ledger lives (share URL or file name). Printed on the ledger line; a link when absolute. */
  ledgerUrl?: string;
  /** ISO date the T-minus count starts from. Default: the sheet's createdAt. */
  asOf?: string;
  /** The show's own name when the listing has one (e.g. "Peninsula Comedy Night"), printed after the date. */
  showName?: string;
  /** ISO time the sheet is printed, for the footer line. Default: now. */
  printedAt?: string;
  /**
   * The server serves recorded sheets only (Qloo is no longer available): a live sheet's header adds
   * "Recorded <date>", as the plan page says. Ignored on fixture sheets, which say "Sample data".
   */
  recorded?: boolean;
}

/**
 * The sections of the one-page sheet, in reading order. The PDF and the print view (/s/[id]) print exactly the
 * sections in `SheetModel.sections`: every one of these, on one page (the caps keep the lists short).
 */
export type SheetSection = "map" | "spots" | "partners" | "media" | "hooks" | "budget" | "declared" | "limits" | "requests";
export const PAGE_SECTIONS: readonly SheetSection[] = ["map", "spots", "partners", "media", "hooks", "budget", "declared", "limits", "requests"];

/** Longest area blurb (ZIPs and why) on paper, in characters, cut at a sentence end. */
export const AREA_BLURB_CHARS = 130;
/**
 * The most of that length a ZIP line takes ("ZIP 20002, 20019, 20020", three ZIPs): a longer list does not cut the
 * why line shorter, so every area keeps the same sentences whatever its number of ZIPs.
 */
export const AREA_BLURB_ZIP_CHARS = 23;

/** Blanks the paper says out loud instead of leaving a cell empty (the same words as partners.csv). */
export { HOURS_NOT_LISTED, PHONE_NOT_LISTED };

export interface TileItem {
  rank: number;
  name: string;
  geohash: string;
  lift: string;
  zips: string;
  /** The full why line (the web sheet). */
  why: string;
  /**
   * What the paper prints: "ZIP 20002, 20019. <why>", whole sentences only, about 130 characters (more when the ZIP
   * list is longer than three ZIPs, or when the why's first sentence is longer: it is never cut).
   */
  blurb: string;
}

export interface PartnerRow {
  n: string;
  /** The partner's entity id, so a view can link the row (website, phone, receipts). */
  entityId: string;
  name: string;
  category: string;
  /**
   * Rank against the room's usual crowd: "+5" (five places higher for this bill than for the house), "-2", "0",
   * "new" (not in the house list at all), or "" when no house comparison ran.
   */
  house: string;
  /** The area's number on the map and in the tile list (1-5), or null when the partner is outside the top areas. */
  tileRank: number | null;
  tile: string;
  tileLift: string;
  address: string;
  /**
   * The hours in words. With one street-team day: that day's hours ("4 pm to 2 am"), or "Hours not listed: call
   * first". With more: the day street-team.ics visits the partner and its hours that day ("Sat 10 am to 2 pm",
   * "Sat, hours not listed: call first"; each day, "; "-separated, in the rare case the passes visit on two
   * weekdays), or "Closed Thu and Sat" when it is closed on every street-team day.
   */
  hours: string;
  /** The street-team day of the visit, "Sat"; "" with one street-team day or no visit. */
  visitDay: string;
  /** True when the hours are not listed (call first) or the place is closed on every street-team day: the row to act on. */
  hoursMissing: boolean;
  phone: string;
  /** The phone, or "Phone not listed" with the website's domain when there is one ("Phone not listed · example.com"). */
  phoneText: string;
  web: string;
  webUrl: string | null;
  /** From `partner.explain`: one line the street team can act on. "" when the partner has no explain parts. */
  activation: string;
  /** One plain line on why the place is listed, e.g. "Ranks 8th here for this crowd, 20th for the room's usual crowd." */
  why: string;
  confidence: PartnerConfidence | null;
  /** Walkup is less sure of this pick (confidence below high): a dagger after the name and one note under the table. */
  lessSure: boolean;
  /** Why that confidence, in one sentence (for a title or a footnote). "" without explain parts. */
  confidenceWhy: string;
  refs: string;
}

export interface DeclaredRow {
  rank: string;
  label: string;
  scored: boolean;
  /** "" when ranked, else "not in Qloo's catalog, kept in your order". */
  note: string;
  refs: string;
}

export interface SpotRow {
  name: string;
  /**
   * Every fact in one line: "Bar · 1.5 km · 2.7% of the crowd · ranks 3 places higher here than for the room's usual
   * crowd" ("Cafe · national chain · 0.9 km · ..." on a chain).
   */
  detail: string;
  /**
   * The same facts one by one, for a table: "Bar" (", national chain" on a chain, ", not for fans" on an operator-only
   * spot), "1.5 km", "2.7%".
   */
  category: string;
  distance: string;
  /** "" when every spot gets the same share (the column is then left out). */
  share: string;
  /**
   * "3 places higher", "the same", or "not in its list" when the usual crowd's list came back without this spot.
   * "" only when no spot has a usual-crowd rank (`panel4.showVsUsual` is false and the column is left out).
   */
  vsUsual: string;
  /** The assumed capacity behind the share. */
  capacity: number;
  operatorOnly: boolean;
  refs: string;
}

export interface MediaRow {
  name: string;
  scope: string;
  refs: string;
}

export interface BudgetRow {
  /** The area's number on the map (1-5). */
  rank: number | null;
  name: string;
  share: string;
  usd: string | null;
}

export interface DiscoveryLine {
  /** "none": the run went through the pick and no place or area met the rule; the line says so, as the plan page does. */
  kind: "area" | "partner" | "none";
  /** "Start with this place" or "Start in this area"; with no pick, "No top pick on this sheet" (`noTopPick`). */
  label: string;
  /** Headline and detail as one plain line; a less certain pick has the partner table's dagger after its headline. */
  text: string;
  /** One short muted line: "Why this one: the best fit that isn't a bar ...". The full rule is on the system card. */
  rule: string;
  /** The picked partner is less certain (its row carries the dagger): `LESS_SURE_NOTE`, said under the line. Else null. */
  lessSureNote: string | null;
  refs: string;
  entityId: string | null;
  geohash: string | null;
}

/**
 * Why a sheet has no top pick, read from the sheet by the rules that pick one (@walkup/engine discovery.ts): both
 * rules compare this crowd with the room's usual crowd; the partner rule takes a local place in a numbered area that
 * the usual crowd ranks at least 5 places lower (or not at all); the area rule runs only on a map that passed its
 * checks. `lead` is "No top pick on this sheet" ("after this change" on a revision), `reason` the rule that found
 * nothing and why. The plan page, the print view and the PDF all say it in these words.
 */
export function noTopPick(sheet: StreetSheet): { lead: string; reason: string } {
  const lead = sheet.revision ? "No top pick after this change" : "No top pick on this sheet";
  const lift = sheet.cards.liftMap.results;
  const baseline = lift.diagnostics.baseline;
  if (baseline === "none") return { lead, reason: "both rules compare this crowd with the room's usual crowd, and this run has no usual crowd to compare with." };
  if (baseline === "tag") return { lead, reason: `both rules compare this crowd with the room's usual crowd, and this run compared it with ${genreFans(sheet.bill.classification)} instead.` };
  return { lead, reason: `${partnerRuleMiss(sheet)}, and ${areaRuleMiss(sheet)}.` };
}

/** `noTopPick` as one line: "No top pick on this sheet: <reason>". */
export function noTopPickText(sheet: StreetSheet): string {
  const { lead, reason } = noTopPick(sheet);
  return `${lead}: ${reason}`;
}

/** Why the partner rule picked no place, on a sheet compared with the room's usual crowd. */
function partnerRuleMiss(sheet: StreetSheet): string {
  const partners = sheet.cards.partners.results;
  if (partners.length === 0) return "there are no partners to check";
  if (partners.every((p) => p.houseRank === undefined)) return "no partner has a rank for the room's usual crowd to compare with";
  const apart = partners.filter((p) => p.houseRank === null || (typeof p.houseRank === "number" && p.houseRank - p.qlooRank >= DISCOVERY_RULES.minHouseGap));
  if (apart.length === 0) return "the room's usual crowd ranks no partner here at least 5 places lower than this crowd does";
  // The rule looks only at the numbered areas (each partner's own area when there are none) and skips national chains.
  const numbered = new Set(topTiles(sheet, { maxTiles: 5 }).map((t) => t.geohash));
  const inArea = (p: Partner) => !!p.tileGeohash && (numbered.size === 0 || numbered.has(p.tileGeohash));
  if (apart.some((p) => inArea(p) && p.chain !== true)) return "no partner met the partner rule";
  const where = apart.every((p) => p.chain === true) ? "national chains, which the rule skips" : apart.every((p) => !inArea(p)) ? "outside the numbered areas" : "national chains or outside the numbered areas";
  return `the only partners the room's usual crowd ranks at least 5 places lower are ${where}`;
}

/** Why the area rule picked no area, on a sheet compared with the room's usual crowd (the map checks it needs). */
function areaRuleMiss(sheet: StreetSheet): string {
  const d = sheet.cards.liftMap.results.liftDiagnostics;
  if (!d) return "the area rule needs map checks this sheet doesn't have";
  if (d.splitHalfSpearman === null) {
    return /\bone act\b/.test(d.note ?? "") ? "the area rule needs the map's split-half check, which can't run on a one-act bill" : "the area rule needs the map's split-half check, which couldn't run this time";
  }
  if (d.splitHalfSpearman <= LIFT_DEFAULTS.minSplitHalf) {
    return `the area rule needs the two halves of the bill to agree on the map, and they didn't (${d.splitHalfSpearman.toFixed(2)}; above ${LIFT_DEFAULTS.minSplitHalf} needed)`;
  }
  if (d.note || /signal is thin/.test(sheet.cards.liftMap.reason ?? "")) return "the area rule needs a map that passed its checks, and this one didn't";
  return "no numbered area met the area rule";
}

export interface SheetModel {
  planId: string;
  mode: StreetSheet["mode"];
  audience: Audience;
  docTitle: string;
  /** "Walkup street sheet": the day sheet's top-left line. */
  kicker: string;
  /** "Sample data" on a fixture sheet, else null. Printed in the header. */
  sampleLabel: string | null;
  /** The acts, e.g. "Juniper Wire, The Lantern Choir, Mesa Static". */
  title: string;
  /** The bill as the header sets it: the headliner (bold), then "with" the others ("" when alone). */
  headliner: string;
  support: string;
  /** "Fri Nov 20 2026", then the show's own name when the listing has one. */
  dateLine: string;
  /** "Example Hall, Nashville, TN". */
  placeLine: string;
  /** "All ages · street team Thu and Sat · 40 km radius". */
  subline: string;
  tMinus: string;
  /**
   * Short header labels in reading order: "Sample data", "Recorded <date>" on a recorded live sheet, and "Counts are
   * what-ifs" when no what-if line says so.
   */
  labels: string[];
  /** Light page watermarks: one, "Sample data", on sample (fixture) sheets only. A live sheet has none. */
  watermarks: string[];
  /** The sections this page prints, in order: the PDF and the print view both follow it. */
  sections: readonly SheetSection[];
  /** Counts as "n of m": "640 of 1,200 seats left", "Capacity 4,400", with "(assumed)" on a sample sheet's what-if counts. */
  seatsLine: string | null;
  notes: string[];
  /** One line calling out the sheet's discovery, when the sheet has one. */
  discovery: DiscoveryLine | null;

  panel1: {
    title: string;
    status: string | null;
    tiles: TileItem[];
    allTiles: LiftTile[];
    topTiles: LiftTile[];
    venue: { lat: number; lon: number; name: string };
    /** The map key's caption, naming what the shading is compared with. */
    legendCaption: string;
    baseline: string;
    empty: string | null;
  };
  panel2: {
    title: string;
    status: string | null;
    hoursHeader: string;
    /** True when at least one listed partner has explain parts: the table shows Activation and Why. */
    explained: boolean;
    /** True when at least one listed partner has a house comparison: the table shows a "vs house" column. */
    hasHouse: boolean;
    /** What the "vs house" column means, or null without one. */
    houseNote: string | null;
    rows: PartnerRow[];
    omitted: number;
    /** Bars left out of a fan-facing version on a show that is not 21+. */
    withheld: number;
    footer: string;
    refsNote: string;
  };
  panel3: { title: string; status: string | null; rows: DeclaredRow[]; omitted: number; empty: string | null };
  panel4: {
    title: string;
    status: string | null;
    rows: SpotRow[];
    withheld: number;
    ageLine: string;
    /** False when every listed spot gets the same share: the table has no Share column and no share note. */
    showShare: boolean;
    /** What the share column assumes, said once (`spotsShareNote`, the same sentence as the web sheet); null without the column. */
    shareNote: string | null;
    /**
     * False when no spot has a rank for the room's usual crowd (there is no usual-crowd list to compare with): the
     * table then has no "Vs usual crowd" column.
     */
    showVsUsual: boolean;
    empty: string | null;
  };
  panel5: {
    title: string;
    status: string | null;
    podcasts: MediaRow[];
    /** Podcasts past the cap (the plan page and sheet.json list them): the paper says how many. */
    podcastsOmitted: number;
    sponsor: MediaRow | null;
    /** Why there is no sponsor; null when there is one, or when the status line above already says it. */
    sponsorNote: string | null;
  };
  panel6: { title: string; status: string | null; hooks: string[]; withheld: number; note: string };
  footer: {
    budgetTitle: string;
    budget: BudgetRow[];
    budgetEmpty: string | null;
    limitsTitle: string;
    limits: string[];
    receiptsTitle: string;
    /** How many requests, and where every Q number is explained. */
    ledgerLine: string;
    ledgerUrl: string | null;
    /** The data credits; on a sample sheet, the sample credit line instead (no live source is credited). */
    attribution: string;
    /** Kept for callers that want it; the PDF and the print view say "Sample" in the header, the footer line and the watermark only. */
    fixtureNote: string | null;
    /** What the files carry that the page doesn't (the calendar, and the ad files when the sheet has numbered areas). */
    elsewhere: string;
    /** One small line for the foot of the page: headliner, room and date, print date, data date, "Sample" on fixtures. */
    printLine: string;
  };
}

/** The status said in words, as beside each heading on the web sheet. "ok" says nothing. */
export const STATUS_WORD: Readonly<Record<Envelope<unknown>["status"], string>> = {
  ok: "",
  empty: "Nothing found",
  needs_input: "Needs your pick",
  partial: "Partial",
  degraded: "Fell back",
  error: "Failed",
};

/**
 * "Fell back: only 1 of the room's headliners matched Qloo ...". A reason that repeats the status first
 * ("degraded: tag baseline ...") loses that word, as on the web sheet; a reason is capitalised and ends
 * with a full stop.
 */
function statusOf(env: Pick<Envelope<unknown>, "status" | "reason">): string | null {
  if (env.status === "ok") return null;
  const word = STATUS_WORD[env.status] || env.status.replace(/_/g, " ");
  const raw = (env.reason ?? "").replace(/^(ok|empty|needs[_ ]input|partial|degraded|error)\s*:\s*/i, "").trim();
  if (!raw) return word;
  const reason = sentence(`${raw.charAt(0).toUpperCase()}${raw.slice(1)}`);
  return `${word}: ${reason}`;
}

/** Receipts as one compact, sorted footnote group ("Q6-Q7, Q13 +2"), no brackets. */
function refsOf(chips: readonly { ledgerRef: string }[]): string {
  return receiptGroup(chips.map((c) => c.ledgerRef));
}

function refsList(refs: readonly string[]): string {
  return receiptGroup(refs);
}

function tagNames(e: { tags?: { name: string }[] }): string {
  return (e.tags ?? []).map((t) => t.name).join(" ");
}

/**
 * The house comparison for a partner row, short enough for a narrow column. `houseRank` (contracts) wins: a
 * number is compared with the partner's rank for this bill, null means the house list did not have it. Older
 * sheets carry it as a chip added by the web layer ("tonight vs house +5 ranks", "tonight vs house: not in the
 * house top 20").
 */
function houseShort(p: Partner): string {
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  if (p.houseRank === null) return "new";
  if (typeof p.houseRank === "number" && Number.isFinite(p.houseRank)) return signed(p.houseRank - p.qlooRank);
  const chip = p.chips.find((c) => c.label.startsWith("tonight vs house"))?.label;
  if (!chip) return "";
  const ranks = /([+-]?\d+) ranks?$/.exec(chip);
  if (ranks) return signed(Number(ranks[1]));
  return /not in the house/.test(chip) ? "new" : "";
}

/** "Example Hall, Nashville, TN". */
function placeOf(venue: StreetSheet["bill"]["venue"]): string {
  const where = [venue.city, venue.state].filter((x) => x && x.trim() !== "").join(", ");
  return [venue.name, where].filter((x) => x && x.trim() !== "").join(", ");
}

/** "comedy fans in general" from a Ticketmaster classification ("Comedy", "Music / Country (Americana)"). */
function genreFans(classification: string | undefined): string {
  const raw = classification ?? "";
  const g = (/\(([^)]+)\)\s*$/.exec(raw)?.[1] ?? raw.split("/").pop() ?? "").trim();
  if (!g || /^(undefined|other|miscellaneous)$/i.test(g)) return "fans of this genre in general";
  return `${/^[A-Z]{2,}/.test(g) ? g : g.toLowerCase()} fans in general`;
}

function sentence(s: string): string {
  const t = s.trim();
  if (t === "") return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** "+1 more podcast on the plan page and in sheet.json.": the podcasts past the paper's cap, counted. */
export function podcastsOmittedText(n: number): string {
  return `+${n} more ${n === 1 ? "podcast" : "podcasts"} on the plan page and in sheet.json.`;
}

/** Said once in the header when the signal is thin (the same words as the web sheet). */
export const THIN_SIGNAL_NOTE = "The signal is thin here, so treat this as a starting list.";

/** "Hollis Creek String Band" and "with Marla Vane and The Ferry Lights": headliners first, then the rest in bill order. */
function billParts(bill: StreetSheet["bill"]): { headliner: string; support: string } {
  const order: Record<string, number> = { headliner: 0, co: 1, support: 2 };
  const named = (bill.acts ?? [])
    .map((a, i) => ({ name: (a.name ?? "").trim(), rank: order[a.role] ?? 3, i }))
    .filter((a) => a.name !== "")
    .sort((x, y) => x.rank - y.rank || x.i - y.i)
    .map((a) => a.name);
  if (named.length === 0) return { headliner: actsLine(bill), support: "" };
  const [first, ...rest] = named;
  const others = rest.length <= 1 ? rest.join("") : `${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]}`;
  return { headliner: first ?? "", support: others ? `with ${others}` : "" };
}

/** "640 of 1,200 seats left", "640 seats left", "Capacity 1,200", or null without counts. */
function seatsText(seatsLeft: number | null, capacity: number | null): string | null {
  const seats = seatsLeft !== null && Number.isFinite(seatsLeft) ? seatsLeft : null;
  const cap = capacity !== null && Number.isFinite(capacity) ? capacity : null;
  if (seats !== null && cap !== null) return `${formatInt(seats)} of ${formatInt(cap)} seats left`;
  if (seats !== null) return `${formatInt(seats)} seats left`;
  if (cap !== null) return `Capacity ${formatInt(cap)}`;
  return null;
}

/** "91st", "27th": a percentile as people say it. */
function ordinalWord(n: number): string {
  const m100 = n % 100;
  const m10 = n % 10;
  return `${n}${m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`;
}

/** "Fri Nov 20" from "2026-11-20", for the footer line (the header carries the year). */
function shortDate(ymd: string): string {
  const full = formatShowDate(ymd);
  return /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4}$/.test(full) ? full.slice(0, -5) : full;
}

/** A why line that starts with the area's own name ("Mount Juliet: about 1.7 times ...") drops it: the list prints the name. */
function withoutLeadName(text: string | undefined, name: string): string | undefined {
  if (!text) return undefined;
  const lead = `${name}: `;
  if (!text.startsWith(lead)) return text;
  const rest = text.slice(lead.length).trim();
  return rest ? `${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : text;
}

/**
 * The spots table's column widths, the same on the PDF and the print view: no Share column when every spot gets the
 * same share, no "Vs usual crowd" column without a usual-crowd list (the Spot column takes its width).
 */
export function spotColumnWidths(showShare: boolean, showVsUsual: boolean): { spot: string; type: string; distance: string; share: string | null; vsUsual: string | null } {
  const extra = showVsUsual ? 0 : 20;
  return showShare
    ? { spot: `${35 + extra}%`, type: "23%", distance: "12%", share: "10%", vsUsual: showVsUsual ? "20%" : null }
    : { spot: `${40 + extra}%`, type: "25%", distance: "15%", share: null, vsUsual: showVsUsual ? "20%" : null };
}

/** One partner's cell in the hours column. */
export interface PartnerHoursCell {
  /** As `PartnerRow.hours`: "4 pm to 2 am" with one street-team day, "Sat 10 am to 2 pm" with more. */
  hours: string;
  /** As `PartnerRow.visitDay`. */
  visitDay: string;
  /** As `PartnerRow.hoursMissing`. */
  hoursMissing: boolean;
  /**
   * The same hours always led by their day, for a line of text (the email, a phone-width list): "Sat noon to
   * 3 pm", "Thu 10 am to 7 pm", "Hours not listed: call first", "Closed Thu and Sat".
   */
  withDay: string;
}

/**
 * The partner hours column, one rule for the PDF, the print view, partners.csv and street-team.ics, and for the plan
 * page and the email when they use it. With more than one street-team day: the day street-team.ics visits each
 * partner and its hours that day (header "Visit day"). With one: the hours the plan read for that day ("Open Thu").
 */
export function partnerHoursColumn(
  sheet: StreetSheet,
  opts: { maxTiles?: number } = {},
): { header: string; byVisit: boolean; cell: (p: Pick<Partner, "entity" | "hoursOnDay">) => PartnerHoursCell } {
  const days = sheet.operator.streetTeamDays ?? [];
  const visits: Map<string, PartnerVisit> = days.length > 1 ? partnerVisits(sheet, { maxTiles: opts.maxTiles ?? 5 }) : new Map();
  const byVisit = visits.size > 0;
  // The day the plan read the hours for (first street-team day, else show day).
  const firstDay = hoursWeekday(sheet);
  const cell = (p: Pick<Partner, "entity" | "hoursOnDay">): PartnerHoursCell => {
    if (!byVisit) {
      const body = p.hoursOnDay ? formatHours(p.hoursOnDay.replace(/^[A-Z][a-z]{2} /, "")) : HOURS_NOT_LISTED;
      return { hours: body, visitDay: "", hoursMissing: !p.hoursOnDay, withDay: p.hoursOnDay && firstDay ? `${weekdayShort(firstDay)} ${body}` : body };
    }
    const v = visits.get(p.entity.entityId);
    if (!v) {
      const closed = `Closed ${streetDaysText(days)}`;
      return { hours: closed, visitDay: "", hoursMissing: true, withDay: closed };
    }
    // One weekday in every pass (a holiday's stops move to the same weekday when it is free); a holiday's stops moved
    // to another day of its week can visit on a second weekday, and then both are named, each with its own hours.
    const hours = v.days.map((d) => (d.hours ? `${weekdayShort(d.weekday)} ${formatHours(d.hours)}` : `${weekdayShort(d.weekday)}, hours not listed: call first`)).join("; ");
    return { hours, visitDay: v.days.map((d) => weekdayShort(d.weekday)).join("; "), hoursMissing: v.days.some((d) => d.hours === null), withDay: hours };
  };
  return { header: byVisit ? "Visit day" : firstDay ? `Open ${weekdayShort(firstDay)}` : "Hours", byVisit, cell };
}

export function buildSheetModel(sheet: StreetSheet, opts: SheetModelOptions = {}): SheetModel {
  const audience: Audience = opts.audience ?? "operator";
  const bill = sheet.bill;
  const venue = bill.venue;
  const cards = sheet.cards;
  const acts = actsLine(bill);
  const date = formatShowDate(bill.date);
  const age = sheetAgeLabel(bill, sheet.operator);
  const allAges = isAllAgesForCopy(bill, sheet.operator);
  const fixture = sheet.mode === "fixture";
  const days = sheet.operator.streetTeamDays ?? [];

  // Header -----------------------------------------------------------------
  const { headliner, support } = billParts(bill);
  const placeLine = placeOf(venue);
  const dateLine = [date, opts.showName?.trim() ?? ""].filter((x) => x !== "").join(" · ");
  const reach = mapReachKm(sheet);
  const subline = [
    age.short,
    days.length > 0 ? `street team ${streetDaysText(days)}` : "no street-team days set",
    // The plan page's words when the map search widened past the operator's radius: the header never claims a
    // radius the map didn't keep to.
    reach !== null ? `radius ${sheet.operator.radiusKm} km; the map search widened to ${reach} km` : `${sheet.operator.radiusKm} km radius`,
    audience === "fan" ? "fan-facing version" : "",
  ]
    .filter((x) => x !== "")
    .join(" · ");
  const labels: string[] = [];
  const watermarks: string[] = [];
  if (fixture) {
    labels.push(SAMPLE_LABEL);
    watermarks.push(SAMPLE_LABEL);
  } else if (opts.recorded) {
    labels.push(`Recorded ${formatShowDate(sheet.createdAt.slice(0, 10))}`);
  }
  // What-if counts are a sample sheet's only: a live sheet's counts are the operator's own, whatever an older stored
  // sheet's `hypothetical` says. The sample watermark already covers them, so there is never a second watermark.
  const countsWhatIf = countsAreWhatIf(sheet);
  const whatIf = countsWhatIf ? " (assumed)" : "";
  const seats = seatsText(sheet.operator.seatsLeft, sheet.operator.capacity);
  // The seats line already says "(assumed)"; the label is only needed when no count is printed.
  if (countsWhatIf && seats === null) labels.push("Counts are what-ifs");
  const notes: string[] = [];
  // Said once: a sheet whose limits already carry the planning-tool line doesn't repeat it in the header.
  if (countsWhatIf) notes.push("Planning tool: Walkup has no sales data for this show.");
  const baselineIsTag = cards.liftMap.results.diagnostics.baseline === "tag";
  // "none": no house set and no pinned genre tag, so there is nothing to compare with and no lift map.
  const noBaseline = cards.liftMap.results.diagnostics.baseline === "none";
  if (baselineIsTag || noBaseline || cards.partners.results.length < 15) notes.push(THIN_SIGNAL_NOTE);

  // Discovery ----------------------------------------------------------------
  const d = sheet.discovery;
  // A picked partner the table marks less certain gets the same dagger and note here (as on the plan page).
  const picked = d?.kind === "partner" && d.entityId ? cards.partners.results.find((p) => p.entity.entityId === d.entityId) : undefined;
  const pickLessSure = !!picked && partnerLessSure(picked);
  const discovery: DiscoveryLine | null =
    d && d.headline && d.headline.trim() !== ""
      ? {
          kind: d.kind,
          label: d.kind === "partner" ? "Start with this place" : "Start in this area",
          text: [sentence(`${d.headline.trim().replace(/[.!?]$/, "")}${pickLessSure ? "†" : ""}`), sentence(d.detail ?? "")].filter((x) => x !== "").join(" "),
          rule:
            d.why && d.why.trim() !== ""
              ? `Why this one: ${sentence(d.why)}`
              : d.rule && d.rule.trim() !== ""
                ? `Why this one: ${sentence(d.rule.charAt(0).toLowerCase() + d.rule.slice(1))}`
                : "",
          lessSureNote: pickLessSure ? LESS_SURE_NOTE : null,
          refs: refsList(d.ledgerRefs ?? []),
          entityId: d.entityId ?? null,
          geohash: d.geohash ?? null,
        }
      : (sheet.steps ?? []).length > 0
        ? // A run that went through the pick and found none says so, and why, where the line would be (as the plan page).
          { kind: "none", label: noTopPick(sheet).lead, text: sentence(noTopPick(sheet).reason), rule: "", lessSureNote: null, refs: "", entityId: null, geohash: null }
        : null;

  // Panel 1 ----------------------------------------------------------------
  const top = topTiles(sheet, { maxTiles: opts.maxTiles ?? 5 });
  const why = new Map((sheet.narration?.tileWhy ?? []).map((w) => [w.geohash, w.text]));
  const tiles: TileItem[] = top.map((t, i) => {
    // Same rule as zips.csv: residential 5-digit ZIPs only.
    const zips = areaZips(t.zctas);
    const zipLine = zips.length > 0 ? `ZIP ${zips.join(", ")}` : "ZIP n/a";
    const whyLine =
      withoutLeadName(why.get(t.geohash), tileLabel(t)) ??
      `${ordinalWord(Math.round(t.billPct * 100))} percentile for this crowd, ${ordinalWord(Math.round(t.housePct * 100))} for ${baselineIsTag ? genreFans(bill.classification) : "the room's usual crowd"}.`;
    return {
      rank: i + 1,
      name: areaLabel(t),
      geohash: t.geohash,
      lift: formatLift(t.lift),
      zips: zipLine,
      why: whyLine,
      // The why line keeps at least its first sentence whole, however long. A long ZIP list takes no more than
      // three ZIPs' worth of the length, so an area with four ZIPs keeps the same sentences as its neighbours.
      blurb: `${zipLine}. ${sentencesUpTo(whyLine, Math.max(0, AREA_BLURB_CHARS - Math.min(zipLine.length, AREA_BLURB_ZIP_CHARS) - 2))}`.trim(),
    };
  });
  const checks = cards.liftMap.results.liftDiagnostics;
  const checkLine =
    checks && typeof checks.splitHalfSpearman === "number" && Number.isFinite(checks.splitHalfSpearman)
      ? ` The map holds up when the bill is split in two (${checks.splitHalfSpearman.toFixed(2)}; 1 means identical).`
      : "";
  const genre = genreFans(bill.classification);
  const baseline = noBaseline
    ? "Nothing to compare with: too few of the room's headliners matched Qloo and no genre-wide map stands in, so there is no lift map for this bill."
    : baselineIsTag
    ? `Compared with ${genre}: too few of the room's headliners matched Qloo.${checkLine} Shading shows where this bill's fans stand out, not where buyers live.`
    : `Compared with the shows this room usually books.${checkLine} Shading shows where this bill's fans stand out, not where buyers live.`;

  // Panel 2 ----------------------------------------------------------------
  const tileByHash = new Map(cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  const topRank = new Map(top.map((t, i) => [t.geohash, i + 1]));
  const maxPartners = opts.maxPartners ?? 25;
  // The shared fan-facing rule (./audience), the same as panel 4 and the plan page: a fan-facing version of a
  // show not known to be 21+ lists no bars (category or drinking word in the name).
  const partners = audience === "fan" ? cards.partners.results.filter((p) => partnerIsFanFacing(p, sheet)) : cards.partners.results;
  const partnersWithheld = cards.partners.results.length - partners.length;
  const listed = partners.slice(0, maxPartners);
  // With more than one street-team day, the hours column names the day street-team.ics visits each partner and
  // gives that day's hours (from the place's own week), so the paper, partners.csv and the calendar agree.
  const hoursCol = partnerHoursColumn(sheet, { maxTiles: opts.maxTiles });
  const rows: PartnerRow[] = listed.map((p, i) => {
    const tile = p.tileGeohash ? tileByHash.get(p.tileGeohash) : undefined;
    // The cleaned website only (`Partner.website`), as the plan page and partners.csv: a site the engine's rule
    // dropped (another business's server, a host that doesn't carry the name) is not printed either.
    const web = p.website ?? null;
    const h = hoursCol.cell(p);
    const ex = p.explain;
    return {
      n: String(i + 1),
      entityId: p.entity.entityId,
      name: p.entity.name,
      // "Cafe, national chain", as the plan page's partner table says it.
      category: p.chain === true ? `${categoryLabel(p.category)}, national chain` : categoryLabel(p.category),
      house: houseShort(p),
      tileRank: p.tileGeohash && topRank.has(p.tileGeohash) ? (topRank.get(p.tileGeohash) as number) : null,
      tile: partnerAreaText(p, tileByHash) || NEAR_VENUE,
      tileLift: tile ? formatLift(tile.lift) : "",
      address: (p.address ?? (typeof p.entity.properties?.address === "string" ? (p.entity.properties.address as string) : "")).replace(/, [A-Z]{2}$/, ""),
      hours: h.hours,
      visitDay: h.visitDay,
      hoursMissing: h.hoursMissing,
      phone: p.phone ?? "",
      // No phone: said out loud, with the website's domain when there is one, so the row still has a way in.
      phoneText: p.phone && p.phone.trim() !== "" ? formatPhone(p.phone) : web ? `${PHONE_NOT_LISTED} · ${shortDomain(web)}` : PHONE_NOT_LISTED,
      web: web ? shortDomain(web) : "",
      webUrl: web && /^https?:\/\//i.test(web) ? web : null,
      activation: ex?.activation?.trim() ?? "",
      why: partnerWhyLine(p),
      confidence: ex?.confidence ?? null,
      lessSure: partnerLessSure(p),
      confidenceWhy: ex?.confidenceWhy?.trim() ?? "",
      // Receipts: the same ids as the web sheet's Why cell (the pool's request and the usual-crowd search).
      refs: refsList(partnerWhyRefs(p)),
    };
  });
  const explained = listed.some((p) => !!p.explain);
  const hasHouse = rows.some((r) => r.house !== "");

  // Panel 3 ----------------------------------------------------------------
  const maxDeclared = opts.maxDeclared ?? 12;
  const declared = declaredInCallOrder(cards.declared.results);
  const declaredRows: DeclaredRow[] = declared.slice(0, maxDeclared).map((dp) => ({
    rank: dp.rank !== null ? String(dp.rank) : "–",
    label: dp.declared.label,
    scored: dp.rank !== null,
    note: dp.rank !== null ? "" : DECLARED_UNRANKED,
    refs: refsOf(dp.chips),
  }));

  // Panel 4 ----------------------------------------------------------------
  // The shared fan-facing rule (./audience): alcohol rules come from Ticketmaster's age policy (the operator's
  // all-ages setting can only add to them). On a show not known to be 21+, bars and places with a drinking word
  // in the name are operator-only (B2B); the fan version leaves them out. The plan page uses the same rule.
  // No carts, kiosks, stands or food trucks; local spots nearest to the venue first, then national chains
  // (`sheetSpots`, the same list as the web).
  const maxSpots = opts.maxSpots ?? 8;
  let withheld = 0;
  const spots: SpotRow[] = [];
  const spotPicks = sheetSpots(cards.prePost.results);
  const listedSpots = (audience === "fan" ? spotPicks.filter((sp) => spotIsFanFacing(sp, sheet)) : spotPicks).slice(0, maxSpots);
  const showShare = spotSharesDiffer(listedSpots.map((sp) => sp.expectedShare));
  // The usual crowd's list came back when any spot has a rank on it: a spot without one is then "not in its list",
  // said in words. With no rank at all there is nothing to compare with, and the column is left out.
  const usualRanked = spotPicks.some((sp) => sp.deltaRank !== null && Number.isFinite(sp.deltaRank));
  for (const sp of spotPicks) {
    const operatorOnly = !spotIsFanFacing(sp, sheet);
    if (audience === "fan" && operatorOnly) {
      withheld += 1;
      continue;
    }
    if (spots.length >= maxSpots) continue;
    const category = sp.category ? categoryLabel(sp.category) : "";
    // Marked as on the plan page: the card's chain sentence says why a chain was kept.
    const chain = sp.chain === true ? "national chain" : "";
    const distance = formatKm(sp.entity.distanceM);
    const share = showShare ? formatPct(sp.expectedShare, 1) : "";
    // "3 places higher" here than for the room's usual crowd (the table's short form of `spotVsUsual`).
    const moved =
      sp.deltaRank === null || !Number.isFinite(sp.deltaRank)
        ? usualRanked
          ? SPOT_NOT_IN_USUAL_SHORT
          : ""
        : sp.deltaRank === 0
          ? "the same"
          : `${Math.abs(sp.deltaRank)} ${Math.abs(sp.deltaRank) === 1 ? "place" : "places"} ${sp.deltaRank > 0 ? "higher" : "lower"}`;
    const notForFans = operatorOnly && audience === "operator";
    const bits = [
      category,
      chain,
      distance,
      share ? `${share} of the crowd` : "",
      spotVsUsual(sp.deltaRank, usualRanked),
      notForFans ? "not for fans" : "",
    ].filter((b) => b !== "");
    spots.push({
      name: sp.entity.name,
      detail: bits.join(" · "),
      category: [category, chain, notForFans ? "not for fans" : ""].filter((x) => x !== "").join(", "),
      distance,
      share,
      vsUsual: moved,
      capacity: sp.assumedCapacity,
      operatorOnly,
      refs: refsOf(sp.chips),
    });
  }

  // Panel 5 ----------------------------------------------------------------
  const maxPodcasts = opts.maxPodcasts ?? 4;
  const allPodcasts = cards.media.results.filter((m) => m.kind === "podcast");
  const podcasts: MediaRow[] = allPodcasts
    .slice(0, maxPodcasts)
    .map((m) => ({ name: m.entity.name, scope: m.scope === "local" ? "local" : "national", refs: refsOf(m.chips) }));
  const sponsorPick = cards.media.results.find((m) => m.kind === "sponsor");
  let sponsor: MediaRow | null = sponsorPick ? { name: sponsorPick.entity.name, scope: sponsorPick.scope === "local" ? "local" : "national", refs: refsOf(sponsorPick.chips) } : null;
  let sponsorNote: string | null = sponsor ? null : "No sponsor brand came back.";
  if (sponsorPick && audience === "fan" && allAges && findAlcoholTerm(`${sponsorPick.entity.name} ${tagNames(sponsorPick.entity)}`) !== null) {
    sponsor = null;
    sponsorNote = "Sponsor left out: an alcohol brand on a show that is not 21+.";
  }
  // Said once: a status line that already gives the reason ("Partial: No sponsor brand came back.") needs no note.
  const mediaStatus = statusOf(cards.media);
  if (sponsorNote && mediaStatus?.includes(sponsorNote)) sponsorNote = null;

  // Panel 6 ----------------------------------------------------------------
  // Copy hooks are fan-facing whatever the audience: on a show not known to be
  // 21+, a hook with an alcohol word is withheld (the guard should already have
  // dropped it; this is the second check).
  const maxHooks = opts.maxHooks ?? 3;
  let hooksWithheld = 0;
  const hooks: string[] = [];
  for (const h of cards.copyHooks.results) {
    if (allAges && findAlcoholTerm(h.text) !== null) {
      hooksWithheld += 1;
      continue;
    }
    if (hooks.length < maxHooks) hooks.push(h.text);
  }
  const hookRefs = receiptGroup(cards.copyHooks.provenance);

  // Footer -----------------------------------------------------------------
  // By area number, each area with its own share of the budget split (`areaBudget`, the same weights as zips.csv and
  // the plan page). Shares to one decimal, as the area text says them ("14.3%"), adding up to 100.0%.
  const areaShares = areaBudget(sheet, { maxTiles: opts.maxTiles ?? 5 });
  const pct = apportion(areaShares.map((b) => ({ key: b.tile.geohash, w: b.share })), 1000);
  const budget: BudgetRow[] = areaShares.map((b) => ({
    rank: b.rank,
    name: areaLabel(b.tile),
    share: formatPct(pct.get(b.tile.geohash) ?? b.share, 1),
    usd: sheet.operator.mediaBudgetUsd !== null && Number.isFinite(sheet.operator.mediaBudgetUsd) ? formatUsd(sheet.operator.mediaBudgetUsd * b.share) : null,
  }));
  // The real limits only: lines about where the data came from (sample data, approximate venue points) belong in
  // the header, the footer line and the watermark, not here.
  // The thin-signal warning is said once, in the header note; the limits don't repeat it.
  const thinSaid = notes.includes(THIN_SIGNAL_NOTE);
  const limits = realLimits(sheet.limits, LIMITS_EVERY_SHEET)
    .filter((l) => !(thinSaid && /^thin signal:/i.test(l)))
    .slice(0, opts.maxLimits ?? 8);
  const ranges = ledgerRanges(sheet.ledger ?? []);
  const n = (sheet.ledger ?? []).length;
  const ledgerUrl = opts.ledgerUrl && opts.ledgerUrl.trim() !== "" ? opts.ledgerUrl.trim() : null;
  const ledgerLine =
    n > 0
      ? `${n === 1 ? "1 request" : `${formatInt(n)} requests`}: ${ranges}. Receipts for every Q number: ${ledgerUrl ?? "sheet.json"}${ledgerUrl ? " (also in sheet.json)" : ""}. Plan ${sheet.planId}.`
      : `No requests on this sheet. Plan ${sheet.planId}.`;
  const printed = opts.printedAt ?? new Date().toISOString();
  const printLine = [
    headliner,
    venue.name,
    shortDate(bill.date),
    `printed ${formatShowDate(printed.slice(0, 10))}`,
    `data from ${formatShowDate(sheet.createdAt.slice(0, 10))}`,
    fixture ? "Sample" : "",
  ]
    .filter((x) => x && x.trim() !== "")
    .join(" · ");

  return {
    planId: sheet.planId,
    mode: sheet.mode,
    audience,
    docTitle: `${fixture ? "Sample street sheet" : "Street sheet"}: ${acts}, ${venue.name}, ${date}`,
    kicker: "Walkup street sheet",
    sampleLabel: fixture ? SAMPLE_LABEL : null,
    title: acts,
    headliner,
    support,
    dateLine,
    placeLine,
    subline,
    tMinus: tMinusLabel(tMinusDays(opts.asOf ?? sheet.createdAt, bill.date)),
    labels,
    watermarks,
    sections: PAGE_SECTIONS,
    seatsLine: seats ? `${seats}${whatIf}` : null,
    notes,
    discovery,
    panel1: {
      // The same heading as the plan page: what the section is, and what it is compared with.
      title: noBaseline ? "Where this crowd stands out" : `Where this crowd stands out, compared with ${baselineIsTag ? genre : "the room's usual crowd"}`,
      status: statusOf(cards.liftMap),
      tiles,
      allTiles: cards.liftMap.results.tiles,
      topTiles: top,
      venue: { lat: venue.lat, lon: venue.lon, name: venue.name },
      legendCaption: noBaseline ? "No usual crowd to compare with" : baselineIsTag ? `Fans compared with ${genre}` : "Fans compared with the room's usual crowd",
      baseline,
      empty: tiles.length === 0 ? (noBaseline ? "No lift map: there is no usual crowd to compare this bill with." : "No area reaches a lift of 1.3x on this sheet.") : null,
    },
    panel2: {
      title: `Partners (${partners.length})`,
      status: statusOf(cards.partners),
      hoursHeader: hoursCol.header,
      explained,
      hasHouse,
      houseNote: null,
      rows,
      omitted: Math.max(0, partners.length - rows.length),
      withheld: partnersWithheld,
      footer: SUGGESTED_NOT_AFFILIATED,
      refsNote: "The small Q numbers point to the request behind each row. partners.csv has every row in full.",
    },
    panel3: {
      title: "Your list",
      // An empty list needs no status word: the line below says it once.
      status: declared.length === 0 ? null : statusOf(cards.declared),
      rows: declaredRows,
      omitted: Math.max(0, declared.length - declaredRows.length),
      empty: declared.length === 0 ? "No list of your own partners came with this plan." : null,
    },
    panel4: {
      title: "Before and after the show",
      status: statusOf(cards.prePost),
      rows: spots,
      withheld,
      ageLine: bill.legalAgeEnforced === null && sheet.operator.allAges !== true ? "Age policy: not on the listing, so treated as all ages." : `Age policy: ${age.long}.`,
      showShare,
      shareNote: showShare ? spotsShareNote(spots.map((sp) => sp.capacity)) : null,
      showVsUsual: usualRanked,
      empty: spots.length === 0 ? "No spots on this sheet." : null,
    },
    panel5: {
      title: "Podcasts and a sponsor",
      status: mediaStatus,
      podcasts,
      podcastsOmitted: Math.max(0, allPodcasts.length - podcasts.length),
      sponsor,
      sponsorNote,
    },
    panel6: {
      title: "Copy lines",
      status: statusOf(cards.copyHooks),
      hooks,
      withheld: hooksWithheld,
      note: `Each line is built only from approved Qloo tags${hookRefs ? ` (${hookRefs})` : ""}. No jokes, no artist voice.`,
    },
    footer: {
      budgetTitle: "Budget split (a heuristic, not a forecast)",
      budget,
      budgetEmpty: budget.length === 0 ? "No budget split on this sheet." : null,
      limitsTitle: "What this sheet doesn't show",
      limits,
      receiptsTitle: "Requests behind this sheet",
      ledgerLine,
      ledgerUrl: ledgerUrl && /^https?:\/\//i.test(ledgerUrl) ? ledgerUrl : null,
      attribution: fixture ? SAMPLE_ATTRIBUTION : ATTRIBUTION,
      fixtureNote: fixture ? FIXTURE_NOTICE : null,
      // Without a numbered area there are no ad ZIPs or pins to point to (the plan page drops those downloads too).
      elsewhere:
        top.length > 0 ? "Street-team days and times are in street-team.ics; ad ZIPs and pins in zips.csv and pins.csv." : "Street-team days and times are in street-team.ics.",
      printLine,
    },
  };
}

/** Every string the model prints, in reading order (used by tests and for plain-text previews). */
export function sheetModelText(m: SheetModel): string[] {
  const out: string[] = [m.kicker];
  if (m.sampleLabel) out.push(m.sampleLabel);
  out.push(m.title, m.headliner, m.support, m.dateLine, m.placeLine, m.subline, m.tMinus, ...m.labels);
  if (m.seatsLine) out.push(m.seatsLine);
  out.push(...m.notes);
  if (m.discovery) out.push(m.discovery.label, m.discovery.text, m.discovery.lessSureNote ?? "", m.discovery.rule, m.discovery.refs);
  out.push(m.panel1.title, ...m.panel1.tiles.flatMap((t) => [t.name, t.lift, t.blurb]), m.panel1.legendCaption, m.panel1.baseline);
  if (m.panel1.empty) out.push(m.panel1.empty);
  out.push(
    m.panel2.title,
    ...m.panel2.rows.flatMap((r) => [r.name, r.category, r.house, r.tile, r.address, r.hours, r.phoneText, r.activation, r.why, r.refs]),
    m.panel2.houseNote ?? "",
    m.panel2.footer,
  );
  out.push(m.panel3.title, ...m.panel3.rows.flatMap((r) => [r.rank, r.label, r.note, r.refs]));
  out.push(m.panel4.title, ...m.panel4.rows.flatMap((r) => [r.name, r.detail, r.refs]), m.panel4.ageLine);
  out.push(m.panel5.title, ...m.panel5.podcasts.flatMap((p) => [p.name, p.scope, p.refs]));
  if (m.panel5.podcastsOmitted > 0) out.push(podcastsOmittedText(m.panel5.podcastsOmitted));
  if (m.panel5.sponsor) out.push(m.panel5.sponsor.name);
  if (m.panel5.sponsorNote) out.push(m.panel5.sponsorNote);
  out.push(m.panel6.title, ...m.panel6.hooks, m.panel6.note);
  out.push(
    m.footer.budgetTitle,
    ...m.footer.budget.map((b) => b.name),
    m.footer.limitsTitle,
    ...m.footer.limits,
    m.footer.receiptsTitle,
    m.footer.ledgerLine,
    m.footer.attribution,
  );
  out.push(m.footer.printLine);
  out.push(...m.watermarks);
  return out.filter((s) => s !== "");
}
