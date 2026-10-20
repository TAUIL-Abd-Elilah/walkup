/**
 * The one place this package talks to the Messages API.
 *
 * Every request goes through `client.beta.messages.create` because the
 * server-side refusal fallback (`fallbacks: "default"` + the
 * `server-side-fallback-2026-07-01` beta) is only typed on the beta surface.
 * The client is injected so tests run against a mock and never reach the API.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { LedgerEntry, LedgerSink } from "@walkup/contracts";
import { ANTHROPIC_CURL, ANTHROPIC_ENDPOINT, MODEL } from "./constants";
import { estimateCostUsd, type SpendGuard } from "./spend";
import type { CallUsage } from "./types";

/** The slice of the Anthropic client this package uses. A real `new Anthropic()` satisfies it. */
export interface NarratorClient {
  beta: {
    messages: {
      create(
        params: MessageCreateParamsNonStreaming,
        options?: { signal?: AbortSignal; timeout?: number },
      ): PromiseLike<BetaMessage>;
    };
  };
}

/**
 * Builds a real client from the environment (ANTHROPIC_API_KEY or
 * ANTHROPIC_AUTH_TOKEN). Returns null when no credential is set, which callers
 * treat as "LLM off" and answer from the deterministic template.
 */
export function createAnthropicClient(env: NodeJS.ProcessEnv = process.env): NarratorClient | null {
  const apiKey = env["ANTHROPIC_API_KEY"] || null;
  const authToken = env["ANTHROPIC_AUTH_TOKEN"] || null;
  if (!apiKey && !authToken) return null;
  try {
    return new Anthropic({ apiKey, authToken });
  } catch {
    return null;
  }
}

export interface CallContext {
  client: NarratorClient;
  spend?: SpendGuard | undefined;
  ledger?: LedgerSink | undefined;
  /** Short purpose label written to the ledger note ("narrate", "arm F turn 2"). */
  purpose: string;
}

export type CallOutcome =
  | {
      ok: true;
      message: BetaMessage;
      costUsd: number;
      ledgerRef: string | null;
      /** Set when the spend store failed to record this (billed) call. */
      spendError: string | null;
    }
  | { ok: false; error: string; status: number | null; ledgerRef: string | null };

function describeError(err: unknown): { error: string; status: number | null } {
  // Most specific first; all SDK errors extend Anthropic.APIError.
  if (err instanceof Anthropic.BadRequestError) return { error: `bad request: ${err.message}`, status: 400 };
  if (err instanceof Anthropic.AuthenticationError) return { error: "authentication failed", status: 401 };
  if (err instanceof Anthropic.RateLimitError) return { error: "rate limited", status: 429 };
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    return { error: `api error${status ? ` ${status}` : ""}: ${err.message}`, status };
  }
  return { error: err instanceof Error ? err.message : String(err), status: null };
}

function ledgerParams(params: MessageCreateParamsNonStreaming): Record<string, string | number | boolean | string[] | null> {
  return {
    model: params.model,
    effort: params.output_config?.effort ?? null,
    max_tokens: params.max_tokens,
    betas: (params.betas ?? []).map(String),
    fallbacks: typeof params.fallbacks === "string" ? params.fallbacks : params.fallbacks ? "array" : null,
    format: params.output_config?.format ? "json_schema" : null,
    tools: (params.tools ?? []).map((t) => ("name" in t ? String(t.name) : "tool")),
    messages: params.messages.length,
  };
}

/** One request, with spend recording and a ledger entry. Never throws. */
export async function callModel(ctx: CallContext, params: MessageCreateParamsNonStreaming): Promise<CallOutcome> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let message: BetaMessage;
  try {
    message = await ctx.client.beta.messages.create(params);
  } catch (err) {
    const { error, status } = describeError(err);
    let ledgerRef: string | null = null;
    if (ctx.ledger) {
      ledgerRef = safeLedgerAdd(ctx.ledger, {
        kind: "anthropic",
        method: "POST",
        endpoint: ANTHROPIC_ENDPOINT,
        params: ledgerParams(params),
        httpStatus: status,
        envelopeStatus: "error",
        latencyMs: Date.now() - t0,
        bytes: 0,
        cacheHit: false,
        resultCount: 0,
        curl: ANTHROPIC_CURL,
        startedAt,
        note: `${ctx.purpose}; ${error}`,
      });
    }
    return { ok: false, error, status, ledgerRef };
  }
  // The call succeeded and was billed: a spend-store failure must not turn it into an API error.
  const latencyMs = Date.now() - t0;
  const costUsd = estimateCostUsd(message.usage, message.model ?? MODEL);
  let spendError: string | null = null;
  if (ctx.spend) {
    try {
      await ctx.spend.recordUsd(costUsd);
    } catch (err) {
      spendError = err instanceof Error ? err.message : String(err);
    }
  }
  let ledgerRef: string | null = null;
  if (ctx.ledger) {
    const degraded = message.stop_reason === "refusal" || message.stop_reason === "max_tokens";
    const fallback = servedByFallback(message);
    ledgerRef = safeLedgerAdd(ctx.ledger, {
      kind: "anthropic",
      method: "POST",
      endpoint: ANTHROPIC_ENDPOINT,
      params: ledgerParams(params),
      httpStatus: 200,
      envelopeStatus: degraded ? "degraded" : "ok",
      latencyMs,
      bytes: safeLength(message),
      cacheHit: (message.usage.cache_read_input_tokens ?? 0) > 0,
      resultCount: message.content.filter((b) => b.type === "text" || b.type === "tool_use").length,
      curl: ANTHROPIC_CURL,
      startedAt,
      note:
        `${ctx.purpose}; stop_reason=${message.stop_reason ?? "null"}; est $${costUsd.toFixed(4)}` +
        (fallback ? `; served by fallback ${message.model}` : "") +
        (spendError ? `; spend not recorded: ${spendError}` : ""),
    });
  }
  return { ok: true, message, costUsd, ledgerRef, spendError };
}

/** A throwing ledger sink must not turn a billed answer into an error, or make callModel throw. */
function safeLedgerAdd(ledger: LedgerSink, entry: Omit<LedgerEntry, "id">): string | null {
  try {
    return ledger.add(entry);
  } catch {
    return null;
  }
}

function safeLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** True when a server-side fallback model answered (switch block or fallback usage iteration). */
export function servedByFallback(message: BetaMessage): boolean {
  if (message.content.some((b) => b.type === "fallback")) return true;
  const iterations = message.usage.iterations ?? [];
  return iterations.some((it) => it.type === "fallback_message");
}

/**
 * The answer's text. When a fallback ran, text from a model that declined
 * mid-answer can sit before the switch block, so only blocks after the last
 * `fallback` block count.
 */
export function finalText(content: ReadonlyArray<BetaContentBlock>): string {
  let start = 0;
  content.forEach((b, i) => {
    if (b.type === "fallback") start = i + 1;
  });
  let text = "";
  for (const block of content.slice(start)) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

export function toolUses(content: ReadonlyArray<BetaContentBlock>): BetaToolUseBlock[] {
  return content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
}

export function usageFromMessage(message: BetaMessage, costUsd: number): CallUsage {
  return {
    model: message.model ?? MODEL,
    calls: 1,
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    costUsd,
    fallbackServed: servedByFallback(message),
  };
}

export function mergeUsage(a: CallUsage | null, b: CallUsage | null): CallUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    model: b.model,
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    costUsd: a.costUsd + b.costUsd,
    fallbackServed: a.fallbackServed || b.fallbackServed,
  };
}

/** JSON.parse + zod-style safeParse; null on any failure (never throws). */
export function parseJsonWith<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  text: string,
): T | null {
  if (!text.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const res = schema.safeParse(raw);
  return res.success ? res.data : null;
}
