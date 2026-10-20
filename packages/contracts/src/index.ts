/**
 * @walkup/contracts
 *
 * The shared shapes every package codes against. Keep this file dependency-free
 * (types + small constants only). If a package needs a new field, add it here
 * first, then implement. Field names are camelCase on our side; raw Qloo field
 * names (entity_id, query.affinity, ...) are normalized inside @walkup/qloo.
 */

// ---------------------------------------------------------------------------
// Status envelope (mirrors the vocabulary of Qloo's official harness)
// ---------------------------------------------------------------------------

export type EnvelopeStatus = "ok" | "empty" | "needs_input" | "partial" | "degraded" | "error";

export interface Envelope<T> {
  status: EnvelopeStatus;
  /** One short human sentence: what this card/step produced. */
  summary: string;
  results: T;
  /** Why the status is not "ok" (shown on the card badge). */
  reason?: string;
  /** Ledger ids (e.g. "Q9") that produced this result. Every claim must trace here. */
  provenance: string[];
  /** "What this does not establish" lines specific to this result. */
  limits: string[];
}

// ---------------------------------------------------------------------------
// Provenance ledger
// ---------------------------------------------------------------------------

export type LedgerKind = "qloo" | "tm" | "places" | "acs" | "anthropic" | "action";

export interface LedgerEntry {
  /** "Q1".."Qn" for Qloo, "T1" Ticketmaster, "P1" Google Places (older sheets only), "C1" Census, "L1" LLM, "A1" actions. */
  id: string;
  kind: LedgerKind;
  method: "GET" | "POST" | "ACTION";
  /** Path only, e.g. "/v2/insights". Never includes the host's secrets. */
  endpoint: string;
  /** Query/body params with any secret replaced by "$QLOO_API_KEY" etc. */
  params: Record<string, string | number | boolean | string[] | null>;
  httpStatus: number | null;
  envelopeStatus: EnvelopeStatus;
  latencyMs: number;
  bytes: number;
  cacheHit: boolean;
  resultCount: number;
  /** copy-as-curl with the key as an env var reference. Empty for actions. */
  curl: string;
  startedAt: string; // ISO
  /** Free-form note: fallback taken, probe-gated flag, message id for sends, ... */
  note?: string;
}

// ---------------------------------------------------------------------------
// Qloo entities (normalized)
// ---------------------------------------------------------------------------

export interface QlooTag {
  id: string; // full URN, e.g. "urn:tag:genre:music:americana"
  name: string;
  type?: string; // tag namespace, e.g. "urn:tag:genre:music"
  subtype?: string;
}

export interface ExplainContribution {
  entityId: string;
  score: number; // 0..1
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface QlooEntity {
  entityId: string;
  name: string;
  /** The real type, e.g. "urn:entity:place" (Qloo's `subtype`; `type` is always "urn:entity"). */
  subtype: string;
  popularity: number | null; // 0..1 percentile within domain
  /** Per-query normalized; only comparable inside one response. Null when no signal was given. */
  affinity: number | null;
  tags: QlooTag[];
  /** Projected subset of properties (address, hours, phone, website, price_level, is_closed, short_description, release_year, ...). */
  properties: Record<string, unknown>;
  location?: GeoPoint & { geohash?: string };
  /** Metres from the location filter point, when Qloo returns query.distance. */
  distanceM?: number | null;
  explainability?: ExplainContribution[];
  /** External ids as Qloo returns them (spotify, imdb, wikidata, ...). */
  external?: Record<string, unknown>;
  disambiguation?: string;
}

// ---------------------------------------------------------------------------
// Heatmaps and lift
// ---------------------------------------------------------------------------

export interface HeatCell {
  geohash: string;
  lat: number;
  lon: number;
  /** Percentile within ONE response. Never compare across calls except as ranks. */
  affinity: number;
  affinityRank: number;
  popularity: number;
}

export interface LiftTile {
  geohash: string; // aggregated geohash-6
  lat: number;
  lon: number;
  lift: number; // exp(w * ln((billPct + 0.5) / (housePct + 0.5))), w = min(1, popPct / 0.25), bounded to [1/3, 3] (engine liftScore)
  billPct: number;
  housePct: number;
  popularityPct: number;
  /** Gazetteer name (neighbourhood / Census place). Never pre-written: comes from the run. */
  name?: string;
  zctas?: string[];
  adultPopulation?: number | null;
}

/**
 * How far to trust the lift map. Written by the lift step onto the lift card
 * (`StreetSheet.cards.liftMap.results.liftDiagnostics`); the card's provenance
 * covers it. Named apart from @walkup/engine's internal `LiftDiagnostics`.
 * Older sheets only have `results.diagnostics`.
 */
export interface SheetLiftDiagnostics {
  /**
   * Spearman of lift built from two disjoint halves of the bill and house
   * seeds, on the tiles both halves share. Null when there were too few seeds
   * or tiles to split.
   */
  splitHalfSpearman: number | null;
  /**
   * Spearman(lift, raw heat) on joined tiles. Near 1 means the map mostly
   * repeats where the bill is popular anyway. Same statistic as
   * `results.diagnostics.spearmanLiftVsHeat`. Null when fewer than 3 tiles.
   */
  liftVsHeatSpearman: number | null;
  /** Bill percentile a tile needs before it can be a top tile (0..1, e.g. 0.7). */
  billFloor: number;
  /** One plain line on how lift was scored, e.g. "bill percentile minus house percentile, bill floor 0.7". */
  method: string;
  /** Plain line for the card when a check is weak or could not run. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Demographics and compare
// ---------------------------------------------------------------------------

export const AGE_BUCKETS = [
  "24_and_younger",
  "25_to_29",
  "30_to_34",
  "35_to_44",
  "45_to_54",
  "55_and_older",
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export interface DemographicsBlock {
  entityId: string;
  /** Signed over/under-index per bucket. */
  age: Partial<Record<AgeBucket, number>>;
  gender: { male?: number; female?: number };
}

export interface CompareTag extends QlooTag {
  score?: number;
  count?: number;
}

export interface CompareResult {
  shared: CompareTag[];
  /** Tags distinctive to side a (the bill). Copy-hook candidates after the allowlist. */
  a: CompareTag[];
  /** Tags distinctive to side b (the house). */
  b: CompareTag[];
  /** True when we fell back to two urn:tag calls diffed by rank. */
  fromTagDiff: boolean;
}

// ---------------------------------------------------------------------------
// The show (bill), venue and operator inputs
// ---------------------------------------------------------------------------

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type ActRole = "headliner" | "co" | "support";

export interface Act {
  name: string;
  role: ActRole;
  tmAttractionId?: string;
  spotifyId?: string;
  /** Comedy bills require the comedian tag check on person entities. */
  isComedian?: boolean;
}

export interface Venue {
  name: string;
  lat: number;
  lon: number;
  city: string;
  state?: string;
  country?: string;
  tmVenueId?: string;
  qlooEntityId?: string | null;
  /** IANA time zone from Ticketmaster's venue `timezone` (e.g. "America/Chicago"). Absent when unknown. */
  timeZone?: string;
}

export interface Bill {
  acts: Act[];
  venue: Venue;
  date: string; // YYYY-MM-DD local
  weekday: Weekday;
  /** From TM ageRestrictions.legalAgeEnforced. Null when unknown. Never inferred from Qloo. */
  legalAgeEnforced: boolean | null;
  classification?: string; // TM segment/genre, e.g. "Music / Country"
  tmEventId?: string;
  tmUrl?: string;
}

export interface DeclaredPartner {
  /** Free text the operator typed (e.g. "Norfolk State alumni chapter"). */
  label: string;
  /** Set when picked from a Qloo /search pick list. */
  qlooEntityId?: string;
  contactEmail?: string; // only ever typed by the operator; never scraped
}

export interface OperatorInputs {
  /** What-if count. Always rendered with a HYPOTHETICAL watermark on real shows. */
  seatsLeft: number | null;
  capacity: number | null;
  mediaBudgetUsd: number | null;
  streetTeamDays: Weekday[];
  radiusKm: number; // default 40
  declaredPartners: DeclaredPartner[];
  /** Aggregate (ZIP, count) from the operator's own ticketing report. No names. */
  alreadyReachedZips?: { zip: string; count: number }[];
  /**
   * The operator says the show is all ages: no bar partners and no
   * alcohol-led pre/post spots. It can only add restrictions: `false` or
   * absent never relaxes Ticketmaster's age rule (`Bill.legalAgeEnforced`),
   * which still wins when it is stricter.
   */
  allAges?: boolean;
  /**
   * Partner category keys to leave out, as resolved by @walkup/engine
   * `resolveCategory` (packages/engine/src/category.ts), e.g. "bar", "record_store".
   */
  excludeCategories?: string[];
  /**
   * Areas to skip: tile geohashes (geohash-6, as `LiftTile.geohash`) or
   * gazetteer area names (as `LiftTile.name`, matched case-insensitively).
   */
  excludeAreas?: string[];
}

// ---------------------------------------------------------------------------
// Resolution (resolve, confirm, then ask)
// ---------------------------------------------------------------------------

export interface Candidate {
  entityId: string;
  name: string;
  subtype: string;
  popularity: number | null;
  shortDescription?: string;
  releaseYear?: number;
  externalUrl?: string;
}

export type ResolutionStatus = "exact" | "needs_input" | "proxy" | "unresolved";

export interface Resolution {
  input: string; // what we tried to resolve
  role: ActRole | "venue" | "house" | "partner";
  status: ResolutionStatus;
  entity?: QlooEntity;
  candidates?: Candidate[];
  /** When status = proxy: which seed stands in and why. */
  proxy?: { entity: QlooEntity; reason: string };
  /** On an extra stand-in row (the input is the stand-in's title): the act it stands in for. */
  proxyFor?: string;
  ledgerRef?: string;
  /**
   * Set when Qloo had no taste data for the first match (a signal check reported it not_found)
   * and the row uses another entry from the same search: the entry that was set aside.
   */
  replaced?: { entityId: string; name: string; reason: "not_found"; ledgerRef?: string };
  /**
   * Plain-words reason when the row is unresolved or its candidates were narrowed, or (on a row with `replaced`)
   * why the swap is not clear-cut: the entry used is billed under another name, or entries were never checked.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Street Sheet cards
// ---------------------------------------------------------------------------

export interface Chip {
  label: string; // e.g. "over-indexes for this bill"
  ledgerRef: string; // e.g. "Q9"
}

export type PartnerConfidence = "high" | "medium" | "low";

/**
 * Why a place is on the list, in parts the partner panel can show. Built from
 * this run only: every tag, name and number traces to `ledgerRefs`.
 */
export interface PartnerExplain {
  /** Allowlisted Qloo tags that tie the place to this bill's crowd. Never a denied namespace. */
  tags: { id: string; name: string }[];
  /** Gazetteer name of the area the place sits in (as `LiftTile.name`). */
  areaName?: string;
  /** Straight-line distance from the venue, in km. */
  distanceKm?: number;
  /** One plain line the street team can act on, e.g. "Ask to leave flyers at the counter." */
  activation: string;
  confidence: PartnerConfidence;
  /** Why that confidence, in one sentence, e.g. "Rank 2 of 40 in a top tile, open on the street-team day." */
  confidenceWhy: string;
  /** What this does not establish for this place. */
  limits?: string;
  ledgerRefs: string[];
}

export interface Partner {
  entity: QlooEntity;
  tileGeohash: string | null;
  tileName?: string;
  category: string; // pinned category key, e.g. "bar", "record_store"
  score: number; // deterministic engine score, 0..1
  qlooRank: number; // 1-based rank inside its Qloo response
  hoursOnDay?: string | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  chips: Chip[];
  /**
   * 1-based rank of this place in the house-signal twin (same pool, the room's
   * usual crowd as the signal). Null when the twin ran but the place was not in
   * it; absent when no twin ran.
   */
  houseRank?: number | null;
  /**
   * Penalty for places that turn up for many bills at this room (hub bars),
   * 0..1 where 0 is none. Already applied to `score`.
   */
  ubiquityPenalty?: number;
  /**
   * True when the name is on the hand-kept list of national chains (config/chains.json): listed after every local
   * place of its area. Absent otherwise, and on sheets made before the list existed.
   */
  chain?: boolean;
  /** Parts of the "why" for the partner panel. */
  explain?: PartnerExplain;
}

export interface DeclaredPartnerScore {
  declared: DeclaredPartner;
  /** Null when not in Qloo's catalog ("not in Qloo's catalog, kept in your order"). */
  rank: number | null;
  entity?: QlooEntity;
  chips: Chip[];
}

export interface PrePostSpot {
  entity: QlooEntity;
  /** Rank delta vs the house-signal twin (positive = more "tonight" than usual). */
  deltaRank: number | null;
  expectedShare: number; // 0..1 of attendance, after load balancing
  assumedCapacity: number; // operator-editable, labelled "assumed"
  fanFacingAllowed: boolean; // false for bars on all-ages shows
  /** Pinned category key, as on Partner (e.g. "bar", "coffee"). Optional for older sheets. */
  category?: string;
  /** True when the name is on the hand-kept chain list: listed after the local spots. Absent otherwise. */
  chain?: boolean;
  chips: Chip[];
}

export interface MediaPick {
  entity: QlooEntity;
  kind: "podcast" | "sponsor";
  /** "local" only when the signal.location probe showed rankings move. */
  scope: "local" | "national";
  chips: Chip[];
}

export interface CopyHook {
  text: string;
  /** Tag ids the hook was built from (must all be on the allowlist). */
  tagIds: string[];
}

/** What the lift map compared this bill with (see StreetSheetCards.liftMap diagnostics). */
export type LiftBaseline = "house" | "tag" | "none";

export interface StreetSheetCards {
  resolution: Envelope<Resolution[]>;
  liftMap: Envelope<{
    tiles: LiftTile[];
    /**
     * baseline: "house" = the room's own roster; "tag" = a pinned genre tag stood in; "none" = neither a house set
     * nor a pinned genre tag, so there is no baseline and no lift (e.g. comedy with too few roster matches).
     */
    diagnostics: { spearmanLiftVsHeat: number | null; baseline: LiftBaseline };
    /** Split-half and lift-vs-heat checks (wave 3). Absent on older sheets. */
    liftDiagnostics?: SheetLiftDiagnostics;
  }>;
  partners: Envelope<Partner[]>;
  declared: Envelope<DeclaredPartnerScore[]>;
  prePost: Envelope<PrePostSpot[]>;
  media: Envelope<MediaPick[]>;
  demographics: Envelope<{ bill: DemographicsBlock[]; house: DemographicsBlock[] }>;
  whatsDifferent: Envelope<CompareResult>;
  copyHooks: Envelope<CopyHook[]>;
}

export interface GuardReport {
  dropped: number;
  reasons: string[];
  deniedTagCount: number;
  /** Distinct denied tags per policy class (e.g. { ethnicity: 2, credit_card: 1 }). Counts only, never tag names. */
  deniedByNamespace?: Record<string, number>;
}

export interface StreetSheet {
  planId: string;
  createdAt: string; // ISO
  mode: "live" | "fixture";
  /** True when seatsLeft/capacity are operator what-ifs on a real show. */
  hypothetical: boolean;
  bill: Bill;
  operator: OperatorInputs;
  cards: StreetSheetCards;
  narration?: {
    summary: string;
    tileWhy: { geohash: string; text: string }[];
    partnerLines: { entityId: string; text: string }[];
    templated: boolean; // true when the deterministic template ran instead of the LLM
  };
  ledger: LedgerEntry[];
  guard: GuardReport;
  budgetSplit?: { geohash: string; share: number; label: "heuristic, not a forecast" }[];
  limits: string[];
  /**
   * Arm F's Google Places comparison list. No longer produced (Places was removed from the product on Oct 20
   * 2026); kept optional so older stored sheets still load. Never shown or handed out: see withoutControl.
   */
  control?: ControlArmResult;
  /** Plan id of another bill on the same date in the same room ("Swap the bill"). */
  pairedPlanId?: string;
  /** The one pick the sheet calls out at the top, chosen by a stated rule. */
  discovery?: SheetDiscovery;
  /** The step stream: what was decided at each step, in run order. */
  steps?: TraceStep[];
  /** Set when this sheet revises another one. */
  revision?: SheetRevision;
}

// ---------------------------------------------------------------------------
// Sheet extras: discovery callout, step stream, revisions
// ---------------------------------------------------------------------------

/**
 * The one area or partner the sheet calls out, picked by a deterministic rule
 * (never by the model), e.g. the highest-ranked partner that is not a bar,
 * more than 2 km from the venue and missing from the list without Qloo.
 */
export interface SheetDiscovery {
  kind: "area" | "partner";
  /** One short line, e.g. "<place>, 3.1 km out in <area>". */
  headline: string;
  /** One or two sentences on what the pick is and why it matters for this bill. */
  detail: string;
  /** The rule that picked it, in plain words (the full rule; the system card states it too). */
  rule: string;
  /**
   * The rule applied to this pick, in one short line for the sheet, e.g. "the best fit that isn't a bar or record
   * store, and the room's usual crowd ranks it 13 places lower". Older sheets have none: show `rule` instead.
   */
  why?: string;
  /** Set when kind = "partner": the partner row it points to (`Partner.entity.entityId`). */
  entityId?: string;
  /** Set when kind = "area": the lift tile it points to (`LiftTile.geohash`). */
  geohash?: string;
  ledgerRefs: string[];
}

export const TRACE_STEP_KINDS = [
  "resolve",
  "pause",
  "baseline",
  "heat",
  "partners",
  "prepost",
  "media",
  "guard",
  "narrate",
  "revise",
  "send",
  "other",
] as const;
export type TraceStepKind = (typeof TRACE_STEP_KINDS)[number];

/** One line of the step stream: a decision the run made, its cause and its receipts. */
export interface TraceStep {
  /** Unique within the sheet, e.g. "heat" or "partners-2". */
  id: string;
  kind: TraceStepKind;
  /** Short name of the step, e.g. "Lift map". */
  label: string;
  /** What was decided, stated as a decision, e.g. "Skipped <area>: this room's usual crowd already lives there." */
  decision: string;
  /** What led to it when that is not obvious: a thin signal, an operator setting, a fallback. */
  cause?: string;
  status: EnvelopeStatus;
  ledgerRefs: string[];
}

/** One tool call the revise step made while reading the instruction. */
export interface RevisionToolCall {
  tool: string;
  /** The tool input as sent. Never holds contact emails or keys. */
  input: unknown;
  /** One plain line, e.g. "Left out bar partners". */
  summary: string;
}

export const REVISION_CHANGE_KINDS = [
  "partner_added",
  "partner_removed",
  "tile_added",
  "tile_removed",
  "spot_added",
  "spot_removed",
  "setting_changed",
] as const;
export type RevisionChangeKind = (typeof REVISION_CHANGE_KINDS)[number];

/** One difference between a revised sheet and its parent. */
export interface RevisionChange {
  kind: RevisionChangeKind;
  /** What changed, e.g. a partner name, a tile name or "All ages". */
  label: string;
  detail?: string;
  /** Receipts for the new state (new calls made by the revision, or the parent's when reused). */
  ledgerRefs: string[];
}

/** What was asked, how it was read and what changed, on a sheet made by revising another. */
export interface SheetRevision {
  /** Plan id of the sheet this one revises. */
  parentPlanId: string;
  /** The operator's instruction as typed, e.g. "All ages: no bars". */
  instruction: string;
  /** "model" when Claude turned the instruction into tool calls; "rules" when the deterministic parser did. */
  interpreter: "model" | "rules";
  toolCalls: RevisionToolCall[];
  /** Differences from the parent sheet, in display order. Empty when nothing changed. */
  changes: RevisionChange[];
  /** Set when the instruction was unclear: the question asked back instead of changing the plan. */
  question?: string;
}

// ---------------------------------------------------------------------------
// Fair control arm (same model + Google Places + ACS). No longer produced: the
// shapes stay for older stored sheets and the P1 research harness.
// ---------------------------------------------------------------------------

export interface ControlPlace {
  placeId: string; // Google place id
  name: string;
  address?: string;
  rating?: number | null;
  userRatingCount?: number | null;
  businessStatus?: string | null;
  location?: GeoPoint;
  query: string; // the search query the model chose
}

export interface ControlArmResult {
  arm: "F" | "S" | "P" | "L";
  places: ControlPlace[];
  /** Names that appear in both arms (fuzzy name + 150 m match). */
  overlapWithQloo: string[];
  ledgerRefs: string[];
}

/** Limits lines older sheets carried about how their Google Places list was searched. */
const CONTROL_LIMIT = /^(The Google Places list|Without-Qloo list)/;

/**
 * The sheet without an older run's Google Places list (`control`), its "Without Qloo" step and the limits lines
 * about it: third-party content the product no longer shows, so pages, exports and MCP drop it on output.
 * Returns the same object when there is nothing to drop.
 */
export function withoutControl<T extends Pick<StreetSheet, "control" | "steps" | "limits">>(sheet: T): T {
  const controlStep = sheet.steps?.some((s) => s.id === "control") === true;
  const controlLimit = Array.isArray(sheet.limits) && sheet.limits.some((l) => CONTROL_LIMIT.test(l));
  if (sheet.control === undefined && !controlStep && !controlLimit) return sheet;
  const copy = { ...sheet };
  delete copy.control;
  if (controlStep) copy.steps = (sheet.steps ?? []).filter((s) => s.id !== "control");
  if (controlLimit) copy.limits = sheet.limits.filter((l) => !CONTROL_LIMIT.test(l));
  return copy;
}

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Tag namespaces that may never appear in copy, chips or persisted data. CI-tested. */
export const DENIED_TAG_PREFIXES = [
  "urn:tag:ethnicity:",
  "urn:tag:inclusivity:",
  "urn:tag:credit_card:",
  "urn:tag:hotel_rating:",
  "urn:tag:cost_description:",
  "urn:tag:wikipedia_category:",
  "urn:tag:religion:",
  "urn:tag:political",
  "urn:tag:sexuality:",
  "urn:tag:customer_identity:",
] as const;

/**
 * Keywords that block a tag when found in its id or name (case-insensitive).
 * Every keyword matches as a substring except "race" and "gay", which match as
 * whole words (plural allowed) so that "terrace", "grace", "Gaylord" and
 * "Marvin Gaye" are not blocked (see packages/engine/src/policy.ts). A consumer
 * that matches all of them as substrings errs toward blocking, which is allowed.
 */
export const DENIED_TAG_KEYWORDS = [
  "ethnic",
  "religio",
  "christian",
  "muslim",
  "jewish",
  "catholic",
  "political",
  "democrat",
  "republican",
  "lgbt",
  "gay",
  "lesbian",
  "race",
] as const;

export const LIMITS_EVERY_SHEET = [
  "Whether this plan sells tickets: nothing here measures sales.",
  "What fans will buy: these are tastes, not purchases.",
  "Where buyers live: the areas show where this bill's fans stand out from the room's usual crowd.",
  "Anything about one person, or whether a partner will move tickets.",
] as const;

// ---------------------------------------------------------------------------
// Ledger sink (implemented in @walkup/qloo; external clients accept any sink)
// ---------------------------------------------------------------------------

/** Clients call add() once per request/action and get back the assigned id ("Q7", "T2", "A1"). */
export interface LedgerSink {
  add(entry: Omit<LedgerEntry, "id">): string;
  entries(): LedgerEntry[];
}

/** Minimal in-memory sink, usable in tests and by any package. Ids are prefix + counter per kind. */
export function createMemoryLedger(): LedgerSink {
  const prefix: Record<LedgerKind, string> = { qloo: "Q", tm: "T", places: "P", acs: "C", anthropic: "L", action: "A" };
  const counters: Record<string, number> = {};
  const list: LedgerEntry[] = [];
  return {
    add(entry) {
      const p = prefix[entry.kind];
      counters[p] = (counters[p] ?? 0) + 1;
      const id = `${p}${counters[p]}`;
      list.push({ ...entry, id });
      return id;
    },
    entries() {
      return [...list];
    },
  };
}
