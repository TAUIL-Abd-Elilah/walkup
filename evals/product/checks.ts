/**
 * The checks every sheet of the product eval goes through, plus the clause
 * list they report against (docs/definition-of-done.md).
 *
 * A "subject" is one plan result to check. The universal checks are:
 * renders, card statuses, guard drops by field, ledger refs, entity citations,
 * the ID validator (fixture runs), grounding against Qloo's own place data
 * on the sheet (closed flag and hours), the call budget and the policy
 * invariants. Case-specific checks live in cases.ts.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LIMITS_EVERY_SHEET,
  type EnvelopeStatus,
  type LedgerEntry,
  type QlooEntity,
  type QlooTag,
  type StreetSheet,
  type Weekday,
} from "@walkup/contracts";
import { findAlcoholTerm, findDeniedTerm, hoursOnDay, isBarCategory, isClosedEntity, isDeniedTag } from "@walkup/engine";
import { buildSheetModel, renderStreetSheetPdf, sanitizeSheet } from "@walkup/exports";
import { BUDGET_TARGET, CARD_ORDER, type CallBudget, type CardKey, type PlanResult } from "@walkup/orchestrator";
import type { IdTap } from "./harness";

// ---------------------------------------------------------------------------
// Clauses
// ---------------------------------------------------------------------------

export type ClauseId = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "S1" | "S2" | "S3" | "S4";

export interface Clause {
  id: ClauseId;
  text: string;
  /** Where the clause comes from. */
  source: string;
  /** "eval": checked by this eval; "ci": a CI step outside this eval. */
  checkedBy: "eval" | "ci";
  /** "goldens": the clause speaks about the golden sheets; "all": every case. */
  scope: "goldens" | "all";
}

export const CLAUSES: readonly Clause[] = [
  { id: "D1", text: "For the three goldens, the Street Sheet renders.", source: "Definition of done", checkedBy: "eval", scope: "goldens" },
  { id: "D2", text: "Zero guard drops in a citation field.", source: "Definition of done; agent loop step 7", checkedBy: "eval", scope: "goldens" },
  { id: "D3", text: "Every partner is open on the street-team day per the hours Qloo returns for it.", source: "Definition of done", checkedBy: "eval", scope: "goldens" },
  { id: "D4", text: "Every cited ID appears in this run's ledger (ID validator).", source: "Definition of done", checkedBy: "eval", scope: "goldens" },
  { id: "D5", text: "The CI job re-runs the 20-case eval on fixtures.", source: "Definition of done", checkedBy: "ci", scope: "all" },
  { id: "D6", text: "The CI job re-runs the P1 analysis on fixtures.", source: "Definition of done", checkedBy: "ci", scope: "all" },
  { id: "D7", text: "The CI job commits the score file.", source: "Definition of done", checkedBy: "ci", scope: "all" },
  { id: "S1", text: "A fresh run stays within the Qloo call budget; every coded fallback call is shown on its card.", source: "Call graph, per-run budget", checkedBy: "eval", scope: "all" },
  { id: "S2", text: "Every node has a typed status and its coded fallback; a non-ok card says why.", source: "Call graph table; agent loop step 3", checkedBy: "eval", scope: "all" },
  { id: "S3", text: "Policy: aggregate affinities only, denied tags never in copy or stored data, alcohol rules from Ticketmaster only, partners suggested and not affiliated, no show-status words.", source: "Safe use and policy", checkedBy: "eval", scope: "all" },
  { id: "S4", text: "Bill specificity: two bills in the same room give different lift tiles and partner lists (top-8 overlap at most 5 of 8).", source: "Proof plan P2", checkedBy: "eval", scope: "all" },
];

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  clause?: ClauseId;
  /** Which sheet of the case this check ran on. */
  subject?: string;
  /** Set on a failure that is a known, reported product gap (known-gaps.ts): owner and note. */
  knownGap?: string;
}

/** Collects case-specific checks. */
export class Checks {
  readonly list: CheckResult[] = [];
  constructor(private readonly subject?: string) {}

  private push(name: string, status: CheckStatus, detail: string, clause?: ClauseId): void {
    const r: CheckResult = { name, status, detail };
    if (clause) r.clause = clause;
    if (this.subject) r.subject = this.subject;
    this.list.push(r);
  }

  ok(name: string, cond: boolean, detail = "", clause?: ClauseId): boolean {
    this.push(name, cond ? "pass" : "fail", detail, clause);
    return cond;
  }

  eq<T>(name: string, actual: T, expected: T, clause?: ClauseId): boolean {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    return this.ok(name, a === e, a === e ? a : `expected ${e}, got ${a}`, clause);
  }

  between(name: string, v: number, min: number, max: number, clause?: ClauseId): boolean {
    return this.ok(name, v >= min && v <= max, `${v} (allowed ${min}-${max})`, clause);
  }

  match(name: string, text: string | undefined | null, re: RegExp, clause?: ClauseId): boolean {
    const t = text ?? "";
    return this.ok(name, re.test(t), re.test(t) ? `matches ${re}` : `"${t}" does not match ${re}`, clause);
  }

  skip(name: string, detail: string, clause?: ClauseId): void {
    this.push(name, "skip", detail, clause);
  }
}

// ---------------------------------------------------------------------------
// Sheet walkers
// ---------------------------------------------------------------------------

/** Every Qloo entity anywhere in a value (deep). */
export function allEntities(v: unknown, out: QlooEntity[] = []): QlooEntity[] {
  if (Array.isArray(v)) {
    for (const x of v) allEntities(x, out);
  } else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.entityId === "string" && typeof o.subtype === "string" && Array.isArray(o.tags)) out.push(o as unknown as QlooEntity);
    for (const x of Object.values(o)) allEntities(x, out);
  }
  return out;
}

function deepLedgerRefs(v: unknown, out: string[]): void {
  if (Array.isArray(v)) v.forEach((x) => deepLedgerRefs(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.ledgerRef === "string") out.push(o.ledgerRef);
    Object.values(o).forEach((x) => deepLedgerRefs(x, out));
  }
}

/** Ledger refs cited anywhere on the sheet: card provenance, chips, resolution rows. */
export function citedRefs(sheet: StreetSheet): string[] {
  const refs: string[] = [];
  for (const card of Object.values(sheet.cards)) {
    refs.push(...card.provenance);
    deepLedgerRefs(card.results, refs);
  }
  return refs;
}

/** Every tag on the sheet that copy, chips or stored data could carry. */
export function allSheetTags(sheet: StreetSheet): { id: string; name: string }[] {
  const tags: { id: string; name: string }[] = [];
  for (const e of allEntities(sheet)) tags.push(...e.tags);
  const cmp = sheet.cards.whatsDifferent.results;
  for (const side of [cmp.shared, cmp.a, cmp.b]) tags.push(...side);
  for (const h of sheet.cards.copyHooks.results) for (const id of h.tagIds) tags.push({ id, name: "" });
  return tags;
}

/** Top-k partner entity ids, in sheet order. */
export function topPartnerIds(sheet: StreetSheet, k = 8): string[] {
  return sheet.cards.partners.results.slice(0, k).map((p) => p.entity.entityId);
}

// ---------------------------------------------------------------------------
// Guard drops by field
// ---------------------------------------------------------------------------

const DROP_LINE = /^(summary|tileWhy\[\d+\]|partnerLines\[\d+\]|copyHooks\[\d+\]|summary sentence \d+): |^fan-facing guard: |^\d+ partner line\(s\) dropped/;
// "cites no tag" is the narrator guard's wording, "cites no allowlisted tag" the fan-facing (engine) guard's.
const CITATION_PROBLEM = /not in this run|not on the allowlist|cites no (allowlisted )?tag|not traced to this run's ledger|duplicate (tile|entity)/;

export interface GuardBreakdown {
  /** Drops in a citation field: an id, geohash, tag or number that this run did not return. */
  citation: number;
  /** Drops for policy or style (alcohol on all-ages copy, denied words, act names in copy, ...). */
  policy: number;
  /** Lines of the guard report that are not drops (receipts, template notes). */
  info: number;
  citationReasons: string[];
  policyReasons: string[];
}

export function classifyGuardReasons(reasons: readonly string[]): GuardBreakdown {
  const out: GuardBreakdown = { citation: 0, policy: 0, info: 0, citationReasons: [], policyReasons: [] };
  for (const r of reasons) {
    if (!DROP_LINE.test(r)) {
      out.info++;
      continue;
    }
    const multi = /^(\d+) partner line\(s\) dropped/.exec(r);
    const n = multi ? Number(multi[1]) : 1;
    if (multi || CITATION_PROBLEM.test(r)) {
      out.citation += n;
      out.citationReasons.push(r);
    } else {
      out.policy += n;
      out.policyReasons.push(r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Call budget
// ---------------------------------------------------------------------------

export interface BudgetBounds {
  /** Bill-level fresh calls, not counting coded fallbacks and typed-partner lookups. */
  coreMax: number;
  venueMin: number;
  venueMax: number;
  /** Coded fallback calls (each must show on its card). */
  fallbackMax: number;
  /** Q11 pick-list lookups for typed partner names (cap 20). */
  typedMax: number;
  /** Trust checks: up to 4 split-half heatmaps, and one house twin and one popularity twin per partner pool (3 each). */
  checksMax: number;
  /** Qloo calls by comparison arms. None run, so this stays 0. */
  armsMax: number;
  /** Exact number of fresh Qloo calls, when the case pins it (e.g. 0 when served from cache). */
  freshExact?: number;
}

export const DEFAULT_BOUNDS: BudgetBounds = {
  coreMax: BUDGET_TARGET.billLevel.max,
  venueMin: 0,
  venueMax: BUDGET_TARGET.coldVenueExtra.max,
  fallbackMax: 10,
  typedMax: 20,
  checksMax: 10,
  armsMax: 0,
};

/** Coded fallbacks: the node label, the card that must show it, and the words its reason must use. */
const FALLBACK_NODES: { re: RegExp; card: CardKey; reason: RegExp; extra: boolean }[] = [
  { re: /^Q4 .*\(widened to 60 km\)$/, card: "liftMap", reason: /60 km/, extra: true },
  { re: /^Q9 .*\(3,500 m\)$/, card: "partners", reason: /3\.5 km/, extra: true },
  { re: /^Q9 .*\(more categories\)$/, card: "partners", reason: /more types of place/, extra: true },
  { re: /^Q9 .*\(rebalanced\)$/, card: "partners", reason: /rebalanced/, extra: true },
  { re: /^Q10 .*\(2,500 m\)$/, card: "prePost", reason: /2\.5 km|2,500 m/, extra: true },
  { re: /^Q8 fallback/, card: "whatsDifferent", reason: /compares (the two crowds' top tags|two tag lists)/, extra: true },
  // A replacement for Q5 (same call count), shown as the tag baseline.
  { re: /^Q5 house heat \(tag baseline\)$/, card: "liftMap", reason: /compares this bill with/, extra: false },
];
const TYPED_NODE = /^Q11 declared pick list$/;
/**
 * Trust checks on top of the plan: split-half heatmaps (Q4 halves bill-level, Q5 halves venue-level), partner house
 * twins and partner popularity twins (bill-level).
 */
const CHECK_NODES_BILL = [/^Q4 .*\(split-half check\)$/, /^Q9 house twin\b/, /^Q9 popularity twin\b/];
const CHECK_NODES_VENUE = [/^Q5 .*\(split-half check\)$/];

export function sumBudgets(a: CallBudget, b: CallBudget | undefined): CallBudget {
  if (!b) return a;
  const byNode: Record<string, number> = { ...a.byNode };
  for (const [k, v] of Object.entries(b.byNode)) byNode[k] = (byNode[k] ?? 0) + v;
  return {
    qlooFresh: a.qlooFresh + b.qlooFresh,
    qlooCached: a.qlooCached + b.qlooCached,
    qlooTotal: a.qlooTotal + b.qlooTotal,
    billLevel: a.billLevel + b.billLevel,
    venueLevel: a.venueLevel + b.venueLevel,
    arms: a.arms + b.arms,
    tm: a.tm + b.tm,
    places: a.places + b.places,
    anthropic: a.anthropic + b.anthropic,
    byNode,
  };
}

export interface BudgetReading {
  fresh: number;
  cached: number;
  core: number;
  venue: number;
  fallback: number;
  typed: number;
  /** Trust-check calls (split-half heatmaps, partner house and popularity twins), bill- and venue-level together. */
  checks: number;
  arms: number;
  fallbackNodes: string[];
}

export function readBudget(b: CallBudget): BudgetReading {
  let fallback = 0;
  let typed = 0;
  let checksBill = 0;
  let checksVenue = 0;
  const fallbackNodes: string[] = [];
  for (const [node, n] of Object.entries(b.byNode)) {
    const f = FALLBACK_NODES.find((x) => x.re.test(node));
    if (f?.extra) {
      fallback += n;
      fallbackNodes.push(node);
    }
    if (TYPED_NODE.test(node)) typed += n;
    if (CHECK_NODES_BILL.some((re) => re.test(node))) checksBill += n;
    if (CHECK_NODES_VENUE.some((re) => re.test(node))) checksVenue += n;
  }
  return {
    fresh: b.qlooFresh,
    cached: b.qlooCached,
    core: b.billLevel - fallback - typed - checksBill,
    venue: b.venueLevel - checksVenue,
    fallback,
    typed,
    checks: checksBill + checksVenue,
    arms: b.arms,
    fallbackNodes,
  };
}

// ---------------------------------------------------------------------------
// Grounding against Qloo's own place data on the sheet
// ---------------------------------------------------------------------------

export interface GroundingRow {
  kind: "partner" | "prePost";
  entityId: string;
  name: string;
  day: Weekday;
  /** Qloo marks the place closed (`properties.is_closed`). */
  closed: boolean;
  /** From `properties.hours` for the day; null when Qloo lists no hours for it. */
  openOnDay: boolean | null;
  /** Open on every street-team day (partners only; informational). */
  openAllDays: boolean | null;
  /** The sheet already says the hours are unknown ("call ahead"). */
  sheetSaysUnknown: boolean;
  /** Not closed, Qloo lists no hours for the day, yet the sheet presents it as open. */
  shownOpenWithoutHours: boolean;
  ok: boolean;
  why?: string;
}

export const PARTNERS_OPEN_CHECK = "every partner open on the street-team day per Qloo's hours";
export const SPOTS_OPEN_CHECK = "every pre/post spot open on show night per Qloo's hours";

export interface GroundingOptions {
  /** Count a place with no hours from Qloo as a failure even when the sheet says "call ahead". Default false. */
  strictHours?: boolean;
}

function openOn(e: QlooEntity, day: Weekday): boolean | null {
  const h = hoursOnDay(e.properties?.hours, day);
  return h.status === "unknown" ? null : h.status === "open";
}

/**
 * Every partner (street-team day: the first one, which Q9 filters on) and
 * every pre/post spot (show night) is checked against the place data Qloo
 * returned for it, as stored on the sheet: not marked closed, and open that
 * day per `properties.hours`. A place with no hours for the day passes only
 * when the sheet already says its hours are unknown: a partner row with no
 * hours for the day (shown as "call ahead"), or a pre/post card that says
 * some hours are unknown. With strictHours it never passes.
 *
 * This checks the sheet against its own source, not an independent one: the
 * Google Places lookup that used to stand here was removed with Places.
 */
export function groundSheet(sheet: StreetSheet, opts: GroundingOptions = {}): GroundingRow[] {
  const rows: GroundingRow[] = [];
  const days = sheet.operator.streetTeamDays.length > 0 ? sheet.operator.streetTeamDays : [sheet.bill.weekday];
  const prePostSaysUnknown = /unknown hours|call ahead/i.test(`${sheet.cards.prePost.summary} ${sheet.cards.prePost.reason ?? ""}`);
  const items = [
    ...sheet.cards.partners.results.map((p) => ({ kind: "partner" as const, e: p.entity, unknown: p.hoursOnDay === null, days })),
    ...sheet.cards.prePost.results.map((s) => ({ kind: "prePost" as const, e: s.entity, unknown: prePostSaysUnknown, days: [sheet.bill.weekday] })),
  ];
  for (const it of items) {
    const day = it.days[0] as Weekday;
    const all = it.days.map((d) => openOn(it.e, d));
    const row: GroundingRow = {
      kind: it.kind,
      entityId: it.e.entityId,
      name: it.e.name,
      day,
      closed: isClosedEntity(it.e),
      openOnDay: openOn(it.e, day),
      openAllDays: all.some((x) => x === null) ? null : all.every((x) => x === true),
      sheetSaysUnknown: it.unknown,
      shownOpenWithoutHours: false,
      ok: false,
    };
    if (row.closed) row.why = "Qloo marks it closed";
    else if (row.openOnDay === false) row.why = `closed on ${day}`;
    else if (row.openOnDay === null && (opts.strictHours || !it.unknown)) {
      row.why = it.unknown ? `no hours from Qloo for ${day} (strict hours)` : `no hours from Qloo, but the sheet presents it as open on ${day}`;
      row.shownOpenWithoutHours = !it.unknown;
    }
    row.ok = !row.why;
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

type ValidateFn = (s: unknown) => string[];
let webValidator: ValidateFn | null | undefined;
/** Why the web validator is unavailable (shown on the skipped check). */
let webValidatorMissing = "";

/** The web app's sheet validator, loaded by path so this eval does not depend on the app's types. Null when absent or not loadable. */
export async function loadWebValidator(): Promise<ValidateFn | null> {
  if (webValidator !== undefined) return webValidator;
  const file = fileURLToPath(new URL("../../apps/web/lib/validate.ts", import.meta.url));
  if (!existsSync(file)) {
    webValidatorMissing = "apps/web/lib/validate.ts not found";
    return (webValidator = null);
  }
  try {
    const mod = (await import(pathToFileURL(file).href)) as { validateSheet?: ValidateFn };
    webValidator = typeof mod.validateSheet === "function" ? mod.validateSheet : null;
    if (!webValidator) webValidatorMissing = "apps/web/lib/validate.ts has no validateSheet export";
  } catch (err) {
    webValidator = null;
    webValidatorMissing = `apps/web/lib/validate.ts failed to load: ${err instanceof Error ? err.message : String(err)}`;
  }
  return webValidator;
}

// ---------------------------------------------------------------------------
// Subjects and the universal checks
// ---------------------------------------------------------------------------

export interface SubjectExpect {
  /** Default "complete". */
  status?: PlanResult["status"];
  /** Expected status per card (one value or the allowed set). */
  cards?: Partial<Record<CardKey, EnvelopeStatus | readonly EnvelopeStatus[]>>;
  /** Total guard drops on the sheet. Default 0. */
  guardDrops?: number;
  /** Drops in citation fields. Default 0. */
  citationDrops?: number;
  /** Budget bounds (merged over DEFAULT_BOUNDS), or false to skip the budget check. */
  budget?: Partial<BudgetBounds> | false;
  /** Also render the one-page PDF (goldens). */
  pdf?: boolean;
  /** Run the grounding check. Default true. */
  grounding?: boolean;
}

export interface Subject {
  label: string;
  result: PlanResult;
  /** The paused answer when the run asked for input first (its calls count toward the budget). */
  first?: PlanResult;
  /** ID tap of the case's world (fixture runs only). */
  tap?: IdTap;
  expect: SubjectExpect;
}

export interface SubjectMetrics {
  partners: number;
  prePost: number;
  /** Grounding numbers are null when grounding did not run for this sheet. */
  grounded: number | null;
  groundingFailures: number | null;
  hoursUnverified: number | null;
  /** Partners with no hours from Qloo that passed because the sheet shows them as "call ahead". */
  partnersCallAhead: number | null;
  openAllStreetDays: number | null;
  ledgerEntries: number;
  qlooFresh: number;
  qlooCached: number;
  coreBillCalls: number;
  venueCalls: number;
  fallbackCalls: number;
  typedLookups: number;
  guardDropped: number;
  citationDrops: number;
}

const SHOW_STATUS_WORDS = /\b(soft|tracking)\b/i;

function cardText(sheet: StreetSheet): string[] {
  const out: string[] = [];
  for (const card of Object.values(sheet.cards)) out.push(card.summary, card.reason ?? "");
  if (sheet.narration) {
    out.push(sheet.narration.summary, ...sheet.narration.tileWhy.map((t) => t.text), ...sheet.narration.partnerLines.map((l) => l.text));
  }
  out.push(...sheet.cards.copyHooks.results.map((h) => h.text));
  return out;
}

function list(names: string[], max = 4): string {
  return names.length <= max ? names.join("; ") : `${names.slice(0, max).join("; ")}; +${names.length - max} more`;
}

export interface CheckOptions {
  /** See GroundingOptions.strictHours. */
  strictHours?: boolean;
}

/** Runs every universal check on one subject. */
export async function checkSubject(s: Subject, opts: CheckOptions = {}): Promise<{ checks: CheckResult[]; metrics: SubjectMetrics | null }> {
  const c = new Checks(s.label);
  const e = s.expect;
  const wantStatus = e.status ?? "complete";
  c.eq("plan status", s.result.status, wantStatus, "S2");
  const sheet = s.result.sheet;
  if (!sheet) {
    if (wantStatus === "complete") c.ok("sheet present", false, s.result.error ?? "no sheet", "D1");
    return { checks: c.list, metrics: null };
  }
  const ledgerIds = new Set(sheet.ledger.map((x) => x.id));
  const byId = new Map<string, LedgerEntry>(sheet.ledger.map((x) => [x.id, x]));

  // ---- D1: renders ----------------------------------------------------------
  const missing = CARD_ORDER.filter((k) => !sheet.cards[k]);
  c.ok("every card present", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : `${CARD_ORDER.length} cards`, "D1");
  const unexplained = CARD_ORDER.filter((k) => sheet.cards[k] && sheet.cards[k].status !== "ok" && !sheet.cards[k].reason);
  c.ok("every non-ok card says why", unexplained.length === 0, unexplained.join(", ") || "all explained", "S2");
  const lostLimits = LIMITS_EVERY_SHEET.filter((l) => !sheet.limits.includes(l));
  c.ok("prints what the sheet does not establish", lostLimits.length === 0, lostLimits.length ? `missing: ${lostLimits.join(" | ")}` : "5 limits", "D1");
  const fixtureLine = sheet.limits.some((l) => /^Sample data/.test(l));
  const fixtureNotes = sheet.ledger.filter((x) => /fixture world: synthetic response/.test(x.note ?? "")).length;
  c.ok(
    "mode is labelled honestly",
    sheet.mode === "fixture" ? fixtureLine : !fixtureLine && fixtureNotes === 0,
    `mode ${sheet.mode}, fixture limit line ${fixtureLine}, synthetic ledger notes ${fixtureNotes}`,
    "D1",
  );
  const op = sheet.operator;
  c.eq("hypothetical watermark follows the what-ifs", sheet.hypothetical, op.seatsLeft !== null || op.capacity !== null, "S3");
  try {
    const model = buildSheetModel(sheet);
    c.ok("sheet model builds", !!model, "header, six panels, footer", "D1");
  } catch (err) {
    c.ok("sheet model builds", false, err instanceof Error ? err.message : String(err), "D1");
  }
  const validate = await loadWebValidator();
  if (validate) {
    const errors = validate(sheet);
    c.ok("web app sheet validator accepts it", errors.length === 0, errors.length ? list(errors) : "no errors", "D1");
  } else {
    c.skip("web app sheet validator accepts it", webValidatorMissing, "D1");
  }
  if (e.pdf) {
    try {
      const pdf = await renderStreetSheetPdf(sheet);
      c.ok("renders to a one-page PDF", pdf.pages === 1, `${pdf.pages} page(s), scale ${pdf.scale}${pdf.truncated ? ", lists shortened" : ""}`, "D1");
    } catch (err) {
      c.ok("renders to a one-page PDF", false, err instanceof Error ? err.message : String(err), "D1");
    }
  }

  // ---- S2: card statuses -------------------------------------------------------
  for (const [key, want] of Object.entries(e.cards ?? {}) as [CardKey, EnvelopeStatus | readonly EnvelopeStatus[]][]) {
    const got = sheet.cards[key]?.status;
    const allowed: readonly EnvelopeStatus[] = typeof want === "string" ? [want] : want;
    c.ok(`card ${key} status`, !!got && allowed.includes(got), `${got ?? "missing"} (expected ${allowed.join(" or ")})${sheet.cards[key]?.reason ? `: ${sheet.cards[key].reason}` : ""}`, "S2");
  }

  // ---- D2: guard drops by field ------------------------------------------------
  const g = classifyGuardReasons(sheet.guard.reasons);
  c.eq("guard drops in citation fields", g.citation, e.citationDrops ?? 0, "D2");
  c.eq("guard drops in total", sheet.guard.dropped, e.guardDrops ?? 0, "D2");
  c.ok("every drop is classified", g.citation + g.policy === sheet.guard.dropped, `${g.citation} citation + ${g.policy} policy vs ${sheet.guard.dropped} dropped`, "D2");

  // ---- D4: ledger refs, entity citations, ID validator ------------------------------
  const refs = citedRefs(sheet);
  const unknownRefs = [...new Set(refs.filter((r) => !ledgerIds.has(r)))];
  c.ok("every cited ledger ref is in this run's ledger", unknownRefs.length === 0 && refs.length > 0, unknownRefs.length ? list(unknownRefs) : `${refs.length} refs`, "D4");
  c.eq("ledger ids are unique", ledgerIds.size, sheet.ledger.length, "D4");

  const cited: { eid: string; chipRefs: string[]; where: string }[] = [
    ...sheet.cards.partners.results.map((p) => ({ eid: p.entity.entityId, chipRefs: p.chips.map((x) => x.ledgerRef), where: "partner" })),
    ...sheet.cards.prePost.results.map((p) => ({ eid: p.entity.entityId, chipRefs: p.chips.map((x) => x.ledgerRef), where: "pre/post" })),
    ...sheet.cards.media.results.map((m) => ({ eid: m.entity.entityId, chipRefs: m.chips.map((x) => x.ledgerRef), where: "media" })),
    ...sheet.cards.declared.results.filter((d) => d.entity).map((d) => ({ eid: d.entity!.entityId, chipRefs: d.chips.map((x) => x.ledgerRef), where: "declared" })),
  ];
  const chipsById = new Map(cited.map((x) => [x.eid, x.chipRefs]));
  for (const l of sheet.narration?.partnerLines ?? []) cited.push({ eid: l.entityId, chipRefs: chipsById.get(l.entityId) ?? [], where: "partner line" });
  const untraced: string[] = [];
  // The run's citation map when there is one; a stored wrapper without it falls back to the item's chips.
  const haveCitations = Object.keys(s.result.citations ?? {}).length > 0;
  for (const x of cited) {
    const ref = haveCitations ? s.result.citations[x.eid] : x.chipRefs.find((r) => byId.get(r)?.kind === "qloo");
    const entry = ref ? byId.get(ref) : undefined;
    if (!entry || entry.kind !== "qloo" || entry.resultCount <= 0) untraced.push(`${x.where} ${x.eid}${ref ? ` -> ${ref}` : ""}`);
  }
  c.ok("every cited entity traces to a Qloo call of this run that returned results", untraced.length === 0, untraced.length ? list(untraced) : `${cited.length} entities`, "D4");

  const tiles = new Set(sheet.cards.liftMap.results.tiles.map((t) => t.geohash));
  const strayTiles = [
    ...sheet.cards.partners.results.filter((p) => p.tileGeohash && !tiles.has(p.tileGeohash)).map((p) => `partner tile ${p.tileGeohash}`),
    ...(sheet.budgetSplit ?? []).filter((b) => !tiles.has(b.geohash)).map((b) => `budget tile ${b.geohash}`),
    ...(sheet.narration?.tileWhy ?? []).filter((t) => !tiles.has(t.geohash)).map((t) => `tile line ${t.geohash}`),
  ];
  c.ok("every cited tile is on this run's lift map", strayTiles.length === 0, strayTiles.length ? list(strayTiles) : `${tiles.size} tiles`, "D4");

  if (s.tap) {
    const seen = s.tap.strings;
    const ids = new Set<string>();
    for (const ent of allEntities(sheet)) ids.add(ent.entityId);
    for (const l of sheet.narration?.partnerLines ?? []) ids.add(l.entityId);
    if (sheet.bill.venue.qlooEntityId) ids.add(sheet.bill.venue.qlooEntityId);
    const tagIds = new Set(allSheetTags(sheet).map((t) => t.id));
    const unseenIds = [...ids].filter((id) => !seen.has(id));
    const unseenTags = [...tagIds].filter((id) => !seen.has(id));
    c.ok(
      "ID validator: every entity and tag id on the sheet came back in a Qloo response",
      unseenIds.length === 0 && unseenTags.length === 0,
      unseenIds.length + unseenTags.length > 0 ? list([...unseenIds, ...unseenTags]) : `${ids.size} entity ids, ${tagIds.size} tag ids, ${s.tap.responses} responses`,
      "D4",
    );
  } else {
    c.skip("ID validator: every entity and tag id on the sheet came back in a Qloo response", "no transport tap (recorded run): the ledger checks above still apply", "D4");
  }

  // ---- D3: grounding against Qloo's place data -----------------------------------------
  let grounding: GroundingRow[] | null = null;
  if (e.grounding === false) {
    // Not part of this subject (the case grounds a sibling sheet of the same plan).
  } else {
    grounding = groundSheet(sheet, { strictHours: opts.strictHours === true });
    const bad = grounding.filter((r) => !r.ok);
    const partnerRows = grounding.filter((r) => r.kind === "partner");
    c.ok(
      PARTNERS_OPEN_CHECK,
      bad.filter((r) => r.kind === "partner").length === 0,
      bad.some((r) => r.kind === "partner")
        ? list(bad.filter((r) => r.kind === "partner").map((r) => `${r.name}: ${r.why}`))
        : `${partnerRows.length} partners checked for ${partnerRows[0]?.day ?? "the street-team day"}; ${partnerRows.filter((r) => r.openOnDay === null).length} with no hours from Qloo, shown as call ahead`,
      "D3",
    );
    // Two checks for pre/post spots, so a known gap on spots without hours (known-gaps.ts)
    // never hides a spot Qloo marks closed or lists as closed that night.
    const badSpots = bad.filter((r) => r.kind === "prePost" && !r.shownOpenWithoutHours);
    const unmarkedSpots = bad.filter((r) => r.kind === "prePost" && r.shownOpenWithoutHours);
    c.ok(
      SPOTS_OPEN_CHECK,
      badSpots.length === 0,
      badSpots.length ? list(badSpots.map((r) => `${r.name}: ${r.why}`)) : `${grounding.length - partnerRows.length} spots checked`,
      "D3",
    );
    c.ok(
      "every pre/post spot without hours from Qloo is marked call ahead",
      unmarkedSpots.length === 0,
      unmarkedSpots.length ? list(unmarkedSpots.map((r) => `${r.name}: ${r.why}`)) : "none presented as open without hours",
      "D3",
    );
  }

  // ---- S1: call budget -----------------------------------------------------------------
  const budget = sumBudgets(s.result.budget, s.first && s.first !== s.result ? s.first.budget : undefined);
  const b = readBudget(budget);
  if (e.budget !== false) {
    const bounds: BudgetBounds = { ...DEFAULT_BOUNDS, ...(e.budget ?? {}) };
    const problems: string[] = [];
    if (b.core > bounds.coreMax) problems.push(`core bill-level calls ${b.core} > ${bounds.coreMax}`);
    if (b.venue < bounds.venueMin || b.venue > bounds.venueMax) problems.push(`venue calls ${b.venue} outside ${bounds.venueMin}-${bounds.venueMax}`);
    if (b.fallback > bounds.fallbackMax) problems.push(`fallback calls ${b.fallback} > ${bounds.fallbackMax}`);
    if (b.typed > bounds.typedMax) problems.push(`typed-partner lookups ${b.typed} > ${bounds.typedMax}`);
    if (b.checks > bounds.checksMax) problems.push(`trust-check calls ${b.checks} > ${bounds.checksMax}`);
    if (b.arms > bounds.armsMax) problems.push(`arm calls ${b.arms} > ${bounds.armsMax}`);
    if (bounds.freshExact !== undefined && b.fresh !== bounds.freshExact) problems.push(`fresh calls ${b.fresh}, expected ${bounds.freshExact}`);
    if (budget.qlooFresh !== budget.billLevel + budget.venueLevel + budget.arms) problems.push("fresh calls do not add up to bill + venue + arms");
    c.ok(
      "call budget",
      problems.length === 0,
      problems.length ? problems.join("; ") : `${b.fresh} fresh (${b.core} core bill-level, ${b.venue} venue, ${b.fallback} fallback, ${b.typed} typed lookups, ${b.checks} trust checks, ${b.arms} arms), ${b.cached} cached`,
      "S1",
    );
    const hidden: string[] = [];
    for (const node of Object.keys(budget.byNode)) {
      const f = FALLBACK_NODES.find((x) => x.re.test(node));
      if (!f) continue;
      const card = sheet.cards[f.card];
      if (!card || card.status === "ok" || !f.reason.test(card.reason ?? "")) hidden.push(`${node} -> ${f.card} ${card?.status ?? "missing"}`);
    }
    c.ok("every coded fallback call shows on its card", hidden.length === 0, hidden.length ? list(hidden) : `${b.fallbackNodes.length} fallback node(s)`, "S1");
  }

  // ---- S3: policy invariants ---------------------------------------------------------------
  const deniedOnSheet = allSheetTags(sheet).filter((t) => isDeniedTag(t as QlooTag));
  c.ok("no denied tag on the sheet", deniedOnSheet.length === 0, deniedOnSheet.length ? list(deniedOnSheet.map((t) => t.id)) : "none", "S3");
  const taggedPersons = allEntities(sheet).filter((x) => x.subtype === "urn:entity:person" && x.tags.length > 0);
  c.ok("person entities carry no tags", taggedPersons.length === 0, taggedPersons.map((x) => x.name).join(", ") || "none", "S3");
  const texts = cardText(sheet);
  const statusWords = texts.filter((t) => SHOW_STATUS_WORDS.test(t));
  c.ok("no show-status words (soft, tracking)", statusWords.length === 0, statusWords.length ? list(statusWords) : "none", "S3");
  const deniedWords = texts.filter((t) => findDeniedTerm(t) !== null);
  c.ok("no denied term in narration, copy or card text", deniedWords.length === 0, deniedWords.length ? `${deniedWords.length} line(s)` : "none", "S3");
  c.ok(
    "partners are suggested, not affiliated",
    sheet.cards.partners.limits.some((l) => /^Suggested, not affiliated/.test(l)) || sheet.cards.partners.results.length === 0,
    sheet.cards.partners.limits.join(" | "),
    "S3",
  );
  const contacts = sheet.operator.declaredPartners.filter((d) => d.contactEmail !== undefined);
  c.ok("no operator-typed contact on the sheet", contacts.length === 0, contacts.length ? `${contacts.length} contact(s)` : "none", "S3");
  const san = sanitizeSheet(sheet);
  c.ok("export sanitizer finds nothing to remove", san.tagsRemoved === 0 && san.secretsRedacted === 0, `tags removed ${san.tagsRemoved}, secrets redacted ${san.secretsRedacted}`, "S3");

  const adult = sheet.bill.legalAgeEnforced === true;
  const ageProblems: string[] = [];
  for (const spot of sheet.cards.prePost.results) {
    const bar = isBarCategory(spot.category ?? "");
    if (bar && spot.fanFacingAllowed !== adult) ageProblems.push(`${spot.entity.name}: bar fan-facing ${spot.fanFacingAllowed}`);
    if (!bar && !spot.fanFacingAllowed) ageProblems.push(`${spot.entity.name}: non-bar held back`);
  }
  if (!adult) {
    for (const h of sheet.cards.copyHooks.results) if (findAlcoholTerm(h.text)) ageProblems.push(`hook "${h.text}"`);
    const sponsor = sheet.cards.media.results.find((m) => m.kind === "sponsor");
    if (sponsor && sponsor.entity.tags.some((t) => /alcohol|tobacco|gambling/.test(t.id))) ageProblems.push(`sponsor ${sponsor.entity.name}`);
  }
  c.ok(
    "alcohol rules follow Ticketmaster's age policy",
    ageProblems.length === 0,
    ageProblems.length ? list(ageProblems) : `legalAgeEnforced ${String(sheet.bill.legalAgeEnforced)}`,
    "S3",
  );

  const metrics: SubjectMetrics = {
    partners: sheet.cards.partners.results.length,
    prePost: sheet.cards.prePost.results.length,
    grounded: grounding ? grounding.filter((r) => r.ok).length : null,
    groundingFailures: grounding ? grounding.filter((r) => !r.ok).length : null,
    hoursUnverified: grounding ? grounding.filter((r) => r.openOnDay === null).length : null,
    partnersCallAhead: grounding ? grounding.filter((r) => r.kind === "partner" && r.ok && r.openOnDay === null).length : null,
    openAllStreetDays: grounding ? grounding.filter((r) => r.kind === "partner" && r.openAllDays === true).length : null,
    ledgerEntries: sheet.ledger.length,
    qlooFresh: b.fresh,
    qlooCached: b.cached,
    coreBillCalls: b.core,
    venueCalls: b.venue,
    fallbackCalls: b.fallback,
    typedLookups: b.typed,
    guardDropped: sheet.guard.dropped,
    citationDrops: g.citation,
  };
  return { checks: c.list, metrics };
}
