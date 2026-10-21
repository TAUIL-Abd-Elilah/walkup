/**
 * @walkup/narrator
 *
 * Every point where this project calls Claude: sheet narration (schema-bound,
 * guarded, templated on any failure), the fair-control arm F (Places + ACS tool
 * loop), the tools-free arm L for the eval page, and free-text show parsing.
 */
export {
  MODEL,
  FALLBACK_BETA,
  FALLBACKS_MODE,
  CONTROL_MAX_ITERATIONS,
  CONTROL_MAX_PLACES,
  MAX_COPY_HOOKS,
} from "./constants";

export type {
  CallUsage,
  LlmOptions,
  NarrateInput,
  NarrationGuard,
  NarrationNumber,
  NarrationResult,
  TemplateReason,
} from "./types";

export {
  createAnthropicClient,
  createNarratorClient,
  llmProvider,
  type LlmProvider,
  finalText,
  servedByFallback,
  type NarratorClient,
} from "./client";

export {
  SpendGuard,
  createFileSpendStore,
  createMemorySpendStore,
  estimateCostUsd,
  ratesFor,
  canonicalModel,
  DEFAULT_DAILY_CAP_USD,
  MODEL_RATES,
  UNLISTED_MODEL_RATES,
  type ModelRates,
  type SpendGuardOptions,
  type SpendStore,
  type UsageLike,
} from "./spend";

export {
  createOpenRouterClient,
  toChatRequest,
  fromChatResponse,
  stopReasonOf,
  OpenRouterError,
  type OpenRouterClient,
  type OpenRouterOptions,
  type ChatRequest,
  type ChatResponse,
} from "./openrouter";
export { OPENROUTER_MODEL, OPENROUTER_BASE_URL } from "./constants";

export { prepareRun, renderFactsMessage, type PreparedRun, type RunIds, type AllowTag } from "./facts";
export { buildNarrationSchema, toDraft, type NarrationDraft, type NarrationWire } from "./schema";
export { jsonOutputFormat, strictJsonSchema } from "./json-schema";
export {
  alcoholWord,
  cleanAllowlist,
  isAlcoholTag,
  isDeniedTag,
  isAllowedNumber,
  policyProblem,
  unlistedNumber,
  EXTRA_DENIED_TAG_PREFIXES,
  type PolicyOptions,
} from "./policy";
export { NARRATOR_SYSTEM_PROMPT, CONTROL_SYSTEM_PROMPT, PARSE_SYSTEM_PROMPT } from "./prompts";
export {
  headlinerName,
  isSlotTag,
  tagInProse,
  templateNarrate,
  templatePartnerLine,
  templateSummary,
  templateTileWhy,
} from "./template";
export {
  vetNarration,
  vetCopyHooks,
  vetWhatsDifferent,
  vetHookList,
  vetGeneratedLines,
  isAudienceTag,
  geohashCenter,
  compassIndex,
  COMPASS_POINTS,
  type Narration,
  type HookVetOptions,
} from "./vet";
export { AUDIENCE_TAG_PREFIXES, AUDIENCE_WORDS, audienceWordIn } from "./audience";
export { narrate, buildNarrationRequest, guardNarration, type NarrateOptions, type GuardedNarration } from "./narrate";

export {
  runControlArm,
  renderShowBlock,
  CONTROL_TOOLS,
  type AcsQuery,
  type ControlArmInput,
  type ControlArmOptions,
  type ControlArmRun,
  type ControlArmStatus,
  type ControlArmTools,
  type PlacesSearchHit,
  type PlacesSearchResponse,
} from "./control-arm";
export { runLlmOnlyArm, buildLlmOnlyRequest, LlmOnlyRankingSchema, UNVERIFIED_PREFIX, type LlmOnlyArmOptions } from "./llm-only-arm";
export {
  parseShowQuery,
  heuristicShowQuery,
  buildParseRequest,
  ShowQuerySchema,
  type ParsedShowQuery,
  type ParseShowQueryOptions,
  type ShowQuery,
} from "./parse-show-query";

export {
  findOverlapPairs,
  overlapNames,
  partnersToCandidates,
  tokenSetRatio,
  ratio as nameRatio,
  nameTokens,
  haversineM,
  OVERLAP_MIN_SIMILARITY,
  OVERLAP_MAX_DISTANCE_M,
  type OverlapCandidate,
  type OverlapPair,
} from "./overlap";

export {
  readRevision,
  renderReviseTask,
  buildReviseRequest,
  cleanInstruction,
  REVISE_SYSTEM_PROMPT,
  REVISE_EFFORT,
  REVISE_MAX_TURNS,
  type RevisionRead,
  type RevisionFallback,
} from "./revise";
export { readRevisionByRules, splitClauses, unclearQuestion, type RulesReading } from "./revise-rules";
export {
  buildReviseTools,
  checkReviseCall,
  mergeReviseCalls,
  describeReviseCall,
  categoriesInWords,
  categoryWord,
  dayWord,
  areaChoices,
  categoryChoices,
  barKeys,
  REVISE_TOOL_NAMES,
  RADIUS_MIN_KM,
  RADIUS_MAX_KM,
  MAX_INSTRUCTION_CHARS,
  type ReviseToolName,
  type ReviseCall,
  type ReviseSummary,
  type ReviseArea,
  type ReviseCategory,
  type CheckedCall,
} from "./revise-tools";
