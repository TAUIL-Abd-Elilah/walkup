/**
 * Public types of @walkup/orchestrator: the plan request, the injected
 * dependencies, options, and the result of one run.
 */
import type {
  Bill,
  Candidate,
  Envelope,
  LedgerEntry,
  LedgerSink,
  OperatorInputs,
  Resolution,
  RevisionToolCall,
  StreetSheet,
  StreetSheetCards,
  TraceStep,
} from "@walkup/contracts";
import type { AcsClient } from "@walkup/acs";
import type { NarratorClient, SpendGuard } from "@walkup/narrator";
import type { QlooClient } from "@walkup/qloo";
import type { TmClient } from "@walkup/tm";
import type { ChoiceStore, PlanStore } from "./store";
import type { TagPins } from "./tags";

export type CardKey = keyof StreetSheetCards;

/** Order in which cards stream (resolution first, copy hooks last). */
export const CARD_ORDER: readonly CardKey[] = [
  "resolution",
  "liftMap",
  "partners",
  "declared",
  "prePost",
  "media",
  "demographics",
  "whatsDifferent",
  "copyHooks",
];

/** A film or TV title that stands in for a thin act (popularity below THIN_POPULARITY). */
export interface ProxySeed {
  query: string;
  type: "movie" | "tv_show";
  /** Checked against properties.release_year. */
  releaseYear?: number;
}

/**
 * Stand-ins for one act. They are used only when Qloo has little on the act
 * (thin). An act Qloo knows well stays its own seed and its stand-ins are not
 * used: on Oct 15 a well-known comedian's own map had 335 areas (probe 6) and
 * his tag profile showed no sign of being skewed (probe 7). An act is never
 * weighted against its stand-ins: POST weighted signals return 400 (probe 14).
 */
export interface SeedPlan {
  /** Act name exactly as on the bill. */
  act: string;
  proxies: ProxySeed[];
  /** One sentence shown in the receipts ("why these seeds"). */
  reason: string;
}

export type PresetId = "g1-a" | "g1-b" | "g2" | "g3";

/**
 * One plan request: exactly one of tmEventId, presetId or bill. Operator
 * inputs override the preset's; resolutions resume a needs_input pause.
 */
export interface PlanRequest {
  tmEventId?: string;
  presetId?: PresetId | string;
  bill?: Bill;
  operator?: Partial<OperatorInputs>;
  /** Operator picks for ambiguous names: act name -> Qloo entity id. */
  resolutions?: Record<string, string>;
  seeds?: SeedPlan[];
  /** Partner category keys (config/tags.json). Default: the Q9 set. */
  categories?: string[];
  /** Reuse a plan id (resuming a paused plan, or fixed ids for fixtures). */
  planId?: string;
  /** Plan id of another bill in the same room ("Swap the bill"). */
  pairedPlanId?: string;
  /** Planning date (YYYY-MM-DD) for the roster window; default: the clock's date. */
  asOf?: string;
}

/**
 * Day-one probe outcomes. Everything starts false until a probe shows it.
 * Oct 15 2026 on hackathon.api.qloo.com no probe showed any of these. POST
 * weighted signals returned 400 (probe 14), so that flag and its code path are
 * gone and signals are always plain GET ids.
 */
export interface ProbeFlags {
  /**
   * signal.location changes podcast rankings (else "national"). Not shown: probe 11 ran on a
   * seed Qloo had no taste data for. A podcast call with a usable seed and signal.location answers 200.
   */
  podcastLocationMoves: boolean;
  /** signal.location changes brand rankings (else "national"). Not shown: probe 12 ran on the same unusable seed. */
  brandLocationMoves: boolean;
  /** Explainability is informative enough for the balance check. Not shown: per-row scores are shares that sum to 1. */
  explainabilityInformative: boolean;
}

export const DEFAULT_PROBES: ProbeFlags = {
  podcastLocationMoves: false,
  brandLocationMoves: false,
  explainabilityInformative: false,
};

export interface AnnotatedTile {
  name?: string;
  zctas?: string[];
  adultPopulation?: number | null;
}

/** The slice of @walkup/gazetteer the orchestrator uses. */
export interface GazetteerLike {
  annotateTile<T extends { lat: number; lon: number }>(tile: T): T & AnnotatedTile;
}

export interface NarratorDeps {
  /** Null: the deterministic template narrates (labelled as such). */
  client: NarratorClient | null;
  spend?: SpendGuard;
}

export interface PlanDeps {
  /** Shared client (cache, quota, limiter); each run views it with its own ledger. */
  qloo: QlooClient;
  /** Ticketmaster client per run ledger. */
  tm?: (ledger: LedgerSink) => TmClient;
  /**
   * Census ACS client per run ledger. No step calls it since arm F (its only user, through acs_lookup) was
   * removed on Oct 20 2026; adult counts come from the gazetteer. Kept, with @walkup/acs, for now.
   */
  acs?: (ledger: LedgerSink) => AcsClient;
  gazetteer?: GazetteerLike;
  narrator?: NarratorDeps;
  /** One ledger per run. Default createMemoryLedger. */
  ledger?: () => LedgerSink;
  /** Epoch ms. Default Date.now. */
  clock?: () => number;
  /** Plan ids. Default: random UUID. */
  idGen?: () => string;
  store?: PlanStore;
  /** Operator picks cached per (query, types) for 30 days. */
  choices?: ChoiceStore;
  tags?: TagPins;
  probes?: Partial<ProbeFlags>;
  /**
   * "live" only when real keys and live transports are used. Anything else is
   * "fixture", and the sheet says so.
   */
  mode?: "live" | "fixture";
}

export interface PlanOptions {
  /** Called as each card is ready, in CARD_ORDER. */
  onCard?: (key: CardKey, envelope: Envelope<unknown>) => void;
  /** When the Qloo month guard has tripped, serve a stored sheet for a preset. Default true. */
  serveFromStoreWhenGuarded?: boolean;
  /** Write the result to deps.store. Default true when a store is given. */
  persist?: boolean;
  /** Called with each step of `sheet.steps` as the run reaches it (SSE "step" events). A paused run streams its pause step. */
  onStep?: (step: TraceStep) => void;
  /** Set by the revise loop (src/revise): this run revises `parent`. */
  revise?: ReviseHook;
}

/**
 * What planShow needs to mark a run as a revision: the revise step goes first
 * in the step stream, and `sheet.revision` is filled (with the differences
 * from the parent) before the sheet is stored.
 */
export interface ReviseHook {
  parent: StreetSheet;
  instruction: string;
  interpreter: "model" | "rules";
  toolCalls: RevisionToolCall[];
  step: TraceStep;
  /** Receipts for the setting rows (the model calls that read the note, in this run's ledger). */
  settingRefs: string[];
}

export interface CallBudget {
  /** Qloo requests sent (not served from cache). */
  qlooFresh: number;
  qlooCached: number;
  qlooTotal: number;
  /**
   * Fresh Qloo calls by level: bill-specific, venue baseline (Q2/Q3/Q5/Q6/Q10
   * twin), arms. `arms` stays 0: no comparison arm runs (the field is kept so
   * stored plans keep their shape).
   */
  billLevel: number;
  venueLevel: number;
  arms: number;
  tm: number;
  /** Google Places requests. Stays 0 since Places was removed (Oct 20 2026); kept so stored plans keep their shape. */
  places: number;
  anthropic: number;
  byNode: Record<string, number>;
}

export interface PausedPlan {
  resolution: Envelope<Resolution[]>;
  /** Names waiting for an operator pick, with their candidates. */
  pending: { input: string; candidates: Candidate[] }[];
  bill: Bill;
  operator: OperatorInputs;
  ledger: LedgerEntry[];
}

export interface PlanResult {
  status: "complete" | "needs_input" | "error";
  planId: string;
  mode: "live" | "fixture";
  sheet?: StreetSheet;
  pause?: PausedPlan;
  error?: string;
  budget: CallBudget;
  /** Every entity id the sheet cites -> the ledger id of the call that returned it. */
  citations: Record<string, string>;
  /** True when a stored sheet was served because the quota guard tripped. */
  servedFromStore: boolean;
  presetId?: string;
  /**
   * The calls a run made before it stopped with an error (a sheet or a pause carries its own ledger), so a host
   * can see why: e.g. Qloo refusing the key on every search.
   */
  ledger?: LedgerEntry[];
}
