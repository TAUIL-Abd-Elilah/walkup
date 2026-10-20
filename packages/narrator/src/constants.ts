/** Model and request constants shared by every call this package makes. */

export const MODEL = "claude-opus-5-5" as const;

/**
 * Server-side refusal fallback, scalar form. The "default" mode routes a declined
 * request by refusal category, so no fallback model list is maintained here.
 * The array form uses a different header (2026-06-01); the two are never mixed.
 */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01" as const;
export const FALLBACKS_MODE = "default" as const;

/** Non-streaming requests stay at or below ~16k output tokens (SDK HTTP timeouts). */
export const DEFAULT_MAX_TOKENS = 16000;
export const PARSE_MAX_TOKENS = 4000;

export const NARRATION_EFFORT = "low" as const;
export const CONTROL_EFFORT = "medium" as const;
export const PARSE_EFFORT = "low" as const;

/** Arm F: hard ceiling on model turns in the tool loop. */
export const CONTROL_MAX_ITERATIONS = 8;
/** Arm F / L: at most this many ranked places come back. */
export const CONTROL_MAX_PLACES = 20;
/** Places returned to the model per places_search call. */
export const PLACES_PER_QUERY = 20;

/** Copy hooks per sheet. */
export const MAX_COPY_HOOKS = 3;

export const ANTHROPIC_ENDPOINT = "/v1/messages";
export const ANTHROPIC_CURL =
  'curl https://api.anthropic.com/v1/messages -H "x-api-key: $ANTHROPIC_API_KEY" ' +
  '-H "anthropic-version: 2023-06-01" -H "anthropic-beta: server-side-fallback-2026-07-01" ' +
  '-H "content-type: application/json" -d @request.json';

/**
 * OpenRouter (used when OPENROUTER_API_KEY is set): the Chat Completions endpoint
 * and the slug of the same Claude model. OPENROUTER_MODEL overrides the slug.
 */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_MODEL = "anthropic/claude-opus-5.5";
export const OPENROUTER_ENDPOINT = "/api/v1/chat/completions";
export const OPENROUTER_TIMEOUT_MS = 120_000;
export const OPENROUTER_CURL =
  'curl https://openrouter.ai/api/v1/chat/completions -H "Authorization: Bearer $OPENROUTER_API_KEY" ' +
  '-H "content-type: application/json" -d @request.json';
