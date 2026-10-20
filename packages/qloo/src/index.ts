/**
 * @walkup/qloo: the only module that talks to Qloo.
 * See README.md for the method -> endpoint table.
 */
export { QlooClient, createQlooClient, SIGNAL_CHECK_BATCH, SIGNAL_CHECK_MAX_IDS } from "./client";
export type { QlooClientOptions, RequestOptions, ResolveExactOptions, ExternalLookup, CheckSignalsOptions } from "./client";

export {
  loadConfig,
  assertAllowedBaseUrl,
  envValue,
  findFixturesDir,
  QLOO_DEFAULT_BASE_URL,
  QLOO_ALLOWED_HOST,
  DEFAULT_MONTH_GUARD_FLOOR,
} from "./config";
export type { QlooConfig, EnvLike } from "./config";

export {
  QlooError,
  QlooHttpError,
  QlooQuotaGuardError,
  QlooFixtureMissingError,
  QlooHostRefusedError,
  QlooNetworkError,
  QlooConfigError,
  parseQlooErrors,
  isSignalNotFoundError,
  SIGNAL_ENTITIES_PARAM,
} from "./errors";
export type { QlooErrorDetail } from "./errors";

export { createTokenBucket, globalLimiter, noLimiter } from "./limiter";
export type { RateLimiter, TokenBucketOptions } from "./limiter";

export { send, buildUrl, backoffDelay, isRetryableStatus } from "./transport";
export type { FetchLike, RetryOptions, TransportDeps, TransportResult } from "./transport";

export { createSqliteCache, DEFAULT_TTL_MS } from "./cache";
export type { QlooCache, CacheEntry, SqliteCacheOptions } from "./cache";

export { canonicalKey, sha256Hex, encodeQuery, stableStringify, cleanParams } from "./canonical";

export { KEY_PLACEHOLDER, redactString, redactParams, ledgerParams, buildCurl } from "./ledger";

export {
  createFileFixtureStore,
  createMemoryFixtureStore,
  parseFixture,
  fixtureHash,
  fixtureFileName,
  syntheticFixtureFor,
} from "./fixtures";
export type { FixtureStore, FixtureRecord, FixtureWrite, FixtureOrigin } from "./fixtures";

export {
  buildSearch,
  buildEntitiesByIds,
  buildEntitiesByExternal,
  buildInsights,
  buildHeatmap,
  buildDemographics,
  buildPlaceInsights,
  buildEntityInsights,
  buildTagProfile,
  buildCompare,
  buildTagsSearch,
  finalizeInsights,
  splitSignal,
  wktPoint,
  latLonString,
  searchTypeUrn,
  insightsTypeUrn,
  uniqueIds,
  isExternalNamespace,
  EXTERNAL_NAMESPACES,
  INSIGHTS_MAX_TAKE,
  SEARCH_MAX_RADIUS_MILES,
  INSIGHTS_MAX_RADIUS_M,
  ENTITIES_BATCH,
} from "./builders";
export type {
  SearchOptions,
  HeatmapOptions,
  DemographicsOptions,
  PlaceInsightsOptions,
  EntityInsightsOptions,
  TagProfileOptions,
  TagsSearchOptions,
  ExternalNamespace,
  SplitSignal,
} from "./builders";

export {
  normalizeEntity,
  normalizeEntityList,
  normalizeHeatmap,
  normalizeDemographics,
  normalizeCompare,
  normalizeTagList,
  normalizeTagRef,
  normalizeInsights,
  countResults,
  projectProperties,
  tagNamespace,
  emptyCompare,
  responseMeta,
  responseWarnings,
  droppedSignalIds,
  zipOf,
  PROJECTED_PROPERTIES,
} from "./normalize";
export type { InsightsValue, InsightsKind } from "./normalize";

export {
  normalizeName,
  resolveFromEntities,
  toCandidate,
  externalUrl,
  hasComedianTag,
  defaultRole,
  extendsName,
  signalAlternates,
  decideFallback,
  sameAct,
  hasMusicianTag,
  MUSICIAN_TAGS,
  COMEDIAN_TAGS,
  MAX_CANDIDATES,
} from "./resolve";
export type { ResolveOptions, AlternateOptions, FallbackDecision } from "./resolve";

export { errorStatus, toEnvelope, errorEnvelope } from "./envelope";
export type { ErrorStatus } from "./envelope";

export { decodeGeohash } from "./geohash";

export type {
  ParamValue,
  Params,
  LedgerParamValue,
  RequestClass,
  HttpMethod,
  SignalEntity,
  QlooRequest,
  QlooMode,
  RequestedMode,
  ResponseSource,
  RawResponse,
  Normalized,
  ResultMeta,
  QlooResult,
  RankedTag,
  ExternalMatch,
  QuotaSnapshot,
  QlooWarning,
  SignalCheck,
} from "./types";
