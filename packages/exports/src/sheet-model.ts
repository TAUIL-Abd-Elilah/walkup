/**
 * Everything the one-page PDF prints, as plain strings: header, the discovery
 * line, the six panels and the footer. The React tree in pdf.ts only lays this
 * out, so the content rules (fan-facing filters, call order, caps, the sample
 * label) live and are tested here. The web print sheet (/s/[id]) reads the same
 * model, so the paper and the PDF say the same things.
 */
import type { Envelope, LiftTile, Partner, PartnerConfidence, StreetSheet } from "@walkup/contracts";
import { LIMITS_EVERY_SHEET } from "@walkup/contracts";
import { findAlcoholTerm, isBarCategory } from "@walkup/engine";
import {
  actsLine,
  ATTRIBUTION,
  categoryLabel,
  DECLARED_UNRANKED,
  FIXTURE_NOTICE,
  formatHours,
  formatInt,
  formatLift,
  formatPct,
  formatShowDate,
  formatUsd,
  isAllAgesForCopy,
  ledgerRanges,
  partnerLessSure,
  partnerWhyLine,
  partnerWhyRefs,
  realLimits,
  receiptGroup,
  SAMPLE_ATTRIBUTION,
  SAMPLE_LABEL,
  sheetAgeLabel,
  shortDomain,
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
import { declaredInCallOrder } from "./tables";

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
  maxPodcasts?: number; // 5
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

/** Blanks the paper says out loud instead of leaving a cell empty. */
export const PHONE_NOT_LISTED = "Phone not listed";
export const HOURS_NOT_LISTED = "Hours not listed: call first";

export interface TileItem {
  rank: number;
  name: string;
  geohash: string;
  lift: string;
  zips: string;
  why: string;
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
  /** Hours on the first street-team day in words ("4 pm to 2 am"), or "Hours not listed: call first". */
  hours: string;
  /** True when the hours are not listed: the row the street team must act on (call first). */
  hoursMissing: boolean;
  phone: string;
  /** The phone, or "Phone not listed" (the paper never leaves the blank silent). */
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
  /** Every fact in one line: "Bar · 1.5 km · 2.7% of the crowd · ranks 3 places higher here than for the room's usual crowd". */
  detail: string;
  /** The same facts one by one, for a table: "Bar" (", not for fans" on an operator-only spot), "1.5 km", "2.7%", "3 places higher" / "the same" / "". */
  category: string;
  distance: string;
  share: string;
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
  name: string;
  share: string;
  usd: string | null;
}

export interface DiscoveryLine {
  kind: "area" | "partner";
  /** "Start with this place" or "Start in this area". */
  label: string;
  /** Headline and detail as one plain line. */
  text: string;
  /** One short muted line: "Why this one: the best fit that isn't a bar ...". The full rule is on the system card. */
  rule: string;
  refs: string;
  entityId: string | null;
  geohash: string | null;
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
  /** Light page watermarks: "Sample data" on fixture sheets, "What-if counts" on live what-if sheets. */
  watermarks: string[];
  /** Counts as "n of m": "640 of 1,200 seats left", "Capacity 4,400", with "(assumed)" on a what-if sheet. */
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
    /** What the share column assumes, said once (`spotsShareNote`, the same sentence as the web sheet). */
    shareNote: string | null;
    empty: string | null;
  };
  panel5: { title: string; status: string | null; podcasts: MediaRow[]; sponsor: MediaRow | null; sponsorNote: string | null };
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
    /** What the one-page PDF leaves to the web sheet and sheet.json (podcasts, sponsor, copy lines, budget split). */
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

function distanceText(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return "";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
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
  const subline = [
    age.short,
    days.length > 0 ? `street team ${streetDaysText(days)}` : "no street-team days set",
    `${sheet.operator.radiusKm} km radius`,
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
  const whatIf = sheet.hypothetical ? " (assumed)" : "";
  const seats = seatsText(sheet.operator.seatsLeft, sheet.operator.capacity);
  if (sheet.hypothetical) {
    // The seats line already says "(what-if)"; the label is only needed when no count is printed.
    if (seats === null) labels.push("Counts are what-ifs");
    // A sample sheet already carries one watermark; a live what-if sheet carries this one.
    if (!fixture) watermarks.push("What-if counts");
  }
  const notes: string[] = [];
  // Said once: a sheet whose limits already carry the planning-tool line doesn't repeat it in the header.
  if (sheet.hypothetical) notes.push("Planning tool: Walkup has no sales data for this show.");
  const baselineIsTag = cards.liftMap.results.diagnostics.baseline === "tag";
  // "none": no house set and no pinned genre tag, so there is nothing to compare with and no lift map.
  const noBaseline = cards.liftMap.results.diagnostics.baseline === "none";
  if (baselineIsTag || noBaseline || cards.partners.results.length < 15) notes.push(THIN_SIGNAL_NOTE);

  // Discovery ----------------------------------------------------------------
  const d = sheet.discovery;
  const discovery: DiscoveryLine | null =
    d && d.headline && d.headline.trim() !== ""
      ? {
          kind: d.kind,
          label: d.kind === "partner" ? "Start with this place" : "Start in this area",
          text: [sentence(d.headline), sentence(d.detail ?? "")].filter((x) => x !== "").join(" "),
          rule:
            d.why && d.why.trim() !== ""
              ? `Why this one: ${sentence(d.why)}`
              : d.rule && d.rule.trim() !== ""
                ? `Why this one: ${sentence(d.rule.charAt(0).toLowerCase() + d.rule.slice(1))}`
                : "",
          refs: refsList(d.ledgerRefs ?? []),
          entityId: d.entityId ?? null,
          geohash: d.geohash ?? null,
        }
      : null;

  // Panel 1 ----------------------------------------------------------------
  const top = topTiles(sheet, { maxTiles: opts.maxTiles ?? 5 });
  const why = new Map((sheet.narration?.tileWhy ?? []).map((w) => [w.geohash, w.text]));
  const tiles: TileItem[] = top.map((t, i) => {
    // Same rule as zips.csv: 5-digit ZCTAs only.
    const zips = [...new Set((t.zctas ?? []).map((z) => String(z).trim()).filter((z) => /^\d{5}$/.test(z)))];
    return {
      rank: i + 1,
      name: tileLabel(t),
      geohash: t.geohash,
      lift: formatLift(t.lift),
      zips: zips.length > 0 ? `ZIP ${zips.join(", ")}` : "ZIP n/a",
      why:
        withoutLeadName(why.get(t.geohash), tileLabel(t)) ??
        `${ordinalWord(Math.round(t.billPct * 100))} percentile for this crowd, ${ordinalWord(Math.round(t.housePct * 100))} for ${baselineIsTag ? genreFans(bill.classification) : "the room's usual crowd"}.`,
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
  // Same alcohol rule as panel 4: a fan-facing version of a show not known to be
  // 21+ lists no bars (category or drinking word in the name).
  const partners =
    audience === "fan" && allAges
      ? cards.partners.results.filter((p) => !isBarCategory(p.category) && findAlcoholTerm(p.entity.name) === null)
      : cards.partners.results;
  const partnersWithheld = cards.partners.results.length - partners.length;
  const listed = partners.slice(0, maxPartners);
  const rows: PartnerRow[] = listed.map((p, i) => {
    const tile = p.tileGeohash ? tileByHash.get(p.tileGeohash) : undefined;
    const web = p.website ?? (typeof p.entity.properties?.website === "string" ? (p.entity.properties.website as string) : null);
    const ex = p.explain;
    return {
      n: String(i + 1),
      entityId: p.entity.entityId,
      name: p.entity.name,
      category: categoryLabel(p.category),
      house: houseShort(p),
      tileRank: p.tileGeohash && topRank.has(p.tileGeohash) ? (topRank.get(p.tileGeohash) as number) : null,
      tile: p.tileName ?? (tile ? tileLabel(tile) : p.tileGeohash ?? "near venue"),
      tileLift: tile ? formatLift(tile.lift) : "",
      address: (p.address ?? (typeof p.entity.properties?.address === "string" ? (p.entity.properties.address as string) : "")).replace(/, [A-Z]{2}$/, ""),
      hours: p.hoursOnDay ? formatHours(p.hoursOnDay.replace(/^[A-Z][a-z]{2} /, "")) : HOURS_NOT_LISTED,
      hoursMissing: !p.hoursOnDay,
      phone: p.phone ?? "",
      phoneText: p.phone && p.phone.trim() !== "" ? p.phone : PHONE_NOT_LISTED,
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
  const firstDay = days[0];

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
  // Alcohol rules come from Ticketmaster's age policy only (the operator's
  // all-ages setting can only add to them). On a show not known to be 21+,
  // bars are operator-only (B2B); the fan version leaves them out.
  const maxSpots = opts.maxSpots ?? 8;
  let withheld = 0;
  const spots: SpotRow[] = [];
  for (const sp of cards.prePost.results) {
    const barLike = sp.category ? isBarCategory(sp.category) : false;
    const alcoholName = findAlcoholTerm(sp.entity.name) !== null;
    const operatorOnly = !sp.fanFacingAllowed || (allAges && (barLike || alcoholName));
    if (audience === "fan" && operatorOnly) {
      withheld += 1;
      continue;
    }
    if (spots.length >= maxSpots) continue;
    const category = sp.category ? categoryLabel(sp.category) : "";
    const distance = distanceText(sp.entity.distanceM);
    const share = formatPct(sp.expectedShare, 1);
    // "3 places higher" here than for the room's usual crowd (the table's short form of `spotVsUsual`).
    const moved = sp.deltaRank === null ? "" : sp.deltaRank === 0 ? "the same" : `${Math.abs(sp.deltaRank)} ${Math.abs(sp.deltaRank) === 1 ? "place" : "places"} ${sp.deltaRank > 0 ? "higher" : "lower"}`;
    const notForFans = operatorOnly && audience === "operator";
    const bits = [
      category,
      distance,
      `${share} of the crowd`,
      spotVsUsual(sp.deltaRank),
      notForFans ? "not for fans" : "",
    ].filter((b) => b !== "");
    spots.push({
      name: sp.entity.name,
      detail: bits.join(" · "),
      category: [category, notForFans ? "not for fans" : ""].filter((x) => x !== "").join(", "),
      distance,
      share,
      vsUsual: moved,
      capacity: sp.assumedCapacity,
      operatorOnly,
      refs: refsOf(sp.chips),
    });
  }

  // Panel 5 ----------------------------------------------------------------
  const maxPodcasts = opts.maxPodcasts ?? 5;
  const podcasts: MediaRow[] = cards.media.results
    .filter((m) => m.kind === "podcast")
    .slice(0, maxPodcasts)
    .map((m) => ({ name: m.entity.name, scope: m.scope === "local" ? "local" : "national", refs: refsOf(m.chips) }));
  const sponsorPick = cards.media.results.find((m) => m.kind === "sponsor");
  let sponsor: MediaRow | null = sponsorPick ? { name: sponsorPick.entity.name, scope: sponsorPick.scope === "local" ? "local" : "national", refs: refsOf(sponsorPick.chips) } : null;
  let sponsorNote: string | null = sponsor ? null : "No sponsor brand came back.";
  if (sponsorPick && audience === "fan" && allAges && findAlcoholTerm(`${sponsorPick.entity.name} ${tagNames(sponsorPick.entity)}`) !== null) {
    sponsor = null;
    sponsorNote = "Sponsor left out: an alcohol brand on a show that is not 21+.";
  }

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
  const budget: BudgetRow[] = (sheet.budgetSplit ?? []).map((b) => {
    const t = tileByHash.get(b.geohash);
    return {
      name: t ? tileLabel(t) : b.geohash,
      share: formatPct(b.share),
      usd: sheet.operator.mediaBudgetUsd !== null && Number.isFinite(sheet.operator.mediaBudgetUsd) ? formatUsd(sheet.operator.mediaBudgetUsd * b.share) : null,
    };
  });
  // The real limits only: lines about where the data came from (sample data, approximate venue points) belong in
  // the header, the footer line and the watermark, not here.
  const limits = realLimits(sheet.limits, LIMITS_EVERY_SHEET).slice(
    0,
    opts.maxLimits ?? 8,
  );
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
      hoursHeader: firstDay ? `Open ${weekdayShort(firstDay)}` : "Hours",
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
      shareNote: spotsShareNote(spots.map((sp) => sp.capacity)),
      empty: spots.length === 0 ? "No spots on this sheet." : null,
    },
    panel5: { title: "Podcasts and a sponsor", status: statusOf(cards.media), podcasts, sponsor, sponsorNote },
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
      elsewhere: "Podcasts, the sponsor pick, copy lines and the budget split are on the web sheet and in sheet.json.",
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
  if (m.discovery) out.push(m.discovery.label, m.discovery.text, m.discovery.rule, m.discovery.refs);
  out.push(m.panel1.title, ...m.panel1.tiles.flatMap((t) => [t.name, t.lift, t.zips, t.why]), m.panel1.legendCaption, m.panel1.baseline);
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
