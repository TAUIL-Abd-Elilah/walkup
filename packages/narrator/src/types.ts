/** Local types for @walkup/narrator. Shared shapes come from @walkup/contracts. */
import type {
  Bill,
  CompareResult,
  CopyHook,
  LedgerSink,
  LiftTile,
  MediaPick,
  Partner,
  PrePostSpot,
  QlooTag,
} from "@walkup/contracts";
import type { NarratorClient } from "./client";
import type { SpendGuard } from "./spend";

/** A labelled number from this run that narration may cite (e.g. seats-left what-if). */
export interface NarrationNumber {
  label: string;
  value: number;
}

export interface NarrateInput {
  bill: Bill;
  /** Lift tiles in display order (usually the top 5). */
  tiles: LiftTile[];
  partners: Partner[];
  prePost: PrePostSpot[];
  media: MediaPick[];
  /** Bill-vs-house tag diff; only allowlisted tags from it are shown to the model. */
  compareTags: CompareResult | null;
  /** Tags that copy may use (id + display name). Denied namespaces are dropped again here. */
  allowlistTags: Array<Pick<QlooTag, "id" | "name">>;
  /** Extra numbers from the run that narration may cite. */
  numbers: NarrationNumber[];
  /** True when seat counts are operator what-ifs on a real show. */
  hypothetical?: boolean;
}

/** Usage and estimated cost of the Anthropic calls behind one result. */
export interface CallUsage {
  /** Model that served the last call (differs from the request when a fallback ran). */
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  fallbackServed: boolean;
}

export type TemplateReason =
  | "llm_off"
  | "over_budget"
  | "refusal"
  | "max_tokens"
  | "parse_failed"
  | "api_error";

export interface NarrationGuard {
  /** Lines removed by the post-parse validator (numbers, ids, policy words). */
  dropped: number;
  reasons: string[];
  /** Allowlist entries removed: tag denylist hits, plus alcohol tags when the show is not 21+. */
  deniedTagCount: number;
}

export interface NarrationResult {
  summary: string;
  tileWhy: { geohash: string; text: string }[];
  partnerLines: { entityId: string; text: string }[];
  copyHooks: CopyHook[];
  /** True when the deterministic template produced this narration. */
  templated: boolean;
  templateReason: TemplateReason | null;
  /** Null when no model call was made. */
  usage: CallUsage | null;
  guard: NarrationGuard;
  /** Ledger ids ("L1", ...) of the calls behind this narration. */
  ledgerRefs: string[];
}

/** Options shared by every function that may call the model. */
export interface LlmOptions {
  /** Injected client. Null or undefined means "LLM off": the deterministic path runs. */
  client?: NarratorClient | null;
  /** Daily cap guard. Without one, spend is not limited by this package. */
  spend?: SpendGuard;
  /** Receives one "anthropic" entry per model call. */
  ledger?: LedgerSink;
  /** USD kept in hand before a call is allowed (default 0). */
  reserveUsd?: number;
  maxTokens?: number;
}
