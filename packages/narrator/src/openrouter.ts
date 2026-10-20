/**
 * OpenRouter transport: a NarratorClient that sends each Messages API request
 * to OpenRouter's OpenAI-compatible Chat Completions endpoint
 * (https://openrouter.ai/api/v1/chat/completions) and returns the answer in the
 * Messages API shape, so narrate(), readRevision(), the control arm and the
 * show-query parser run unchanged.
 *
 * What carries over (see the package README, "Providers"):
 * - system prompt, user and assistant turns, `cache_control` on the system block;
 * - tools (`strict` kept), `tool_choice: auto`, parallel tool calls, tool results
 *   (an `is_error` result is sent with an "Error: " prefix: Chat Completions has no flag);
 * - `output_config.format` as `response_format: json_schema` (strict);
 * - `output_config.effort` as OpenRouter's `verbosity` (low / medium / high);
 * - thinking that came back as `reasoning_details` is echoed on the next turn of a tool loop.
 *
 * What does not: the server-side refusal fallback beta (`betas`, `fallbacks`) is
 * dropped, so a refusal ends in the template or the rules instead of another model.
 * `provider.require_parameters` keeps OpenRouter from routing to a provider that
 * would silently ignore tools or the response format.
 */
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaStopReason,
  BetaTextBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { NarratorClient } from "./client";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_CURL,
  OPENROUTER_ENDPOINT,
  OPENROUTER_MODEL,
  OPENROUTER_TIMEOUT_MS,
} from "./constants";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OpenRouterOptions {
  apiKey: string;
  /** OpenRouter model slug. Default `OPENROUTER_MODEL`. */
  model?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Retries on 429, 5xx and network errors (default 2, as the Anthropic SDK). */
  maxRetries?: number;
  /** Backoff before retry n (ms). Default 1000 * 2^n. Tests pass 0. */
  backoffMs?: (attempt: number) => number;
  /** Sent as HTTP-Referer / X-Title (OpenRouter app attribution). */
  appUrl?: string;
  appTitle?: string;
}

/** Thrown for a non-2xx answer or an error body; `status` is the HTTP status when there was one. */
export class OpenRouterError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

/** The narrator's OpenRouter client, plus where its ledger entries point. */
export interface OpenRouterClient extends NarratorClient {
  readonly provider: "openrouter";
  readonly model: string;
  readonly ledgerEndpoint: string;
  readonly ledgerCurl: string;
}

// ---------------------------------------------------------------------------
// Chat Completions wire types (only the fields used here)
// ---------------------------------------------------------------------------

interface ChatTextPart {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type ChatMessage =
  | { role: "system"; content: ChatTextPart[] }
  | { role: "user"; content: string | ChatTextPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[]; reasoning_details?: unknown[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatRequest {
  model: string;
  max_tokens: number;
  messages: ChatMessage[];
  tools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown; strict?: boolean } }>;
  tool_choice?: "auto" | "none";
  response_format?: { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: unknown } };
  verbosity?: "low" | "medium" | "high";
  provider: { require_parameters: boolean };
  usage: { include: boolean };
}

export interface ChatResponse {
  id?: string;
  model?: string;
  error?: { message?: string; code?: number | string };
  choices?: Array<{
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    error?: { message?: string; code?: number | string };
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: ChatToolCall[] | null;
      reasoning_details?: unknown[] | null;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

const EFFORT_TO_VERBOSITY: Record<string, ChatRequest["verbosity"]> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

function textOfToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text: unknown }).text) : ""))
    .join("");
}

/**
 * One Messages turn to Chat Completions messages. A user turn's tool results
 * become `tool` messages (they must follow the assistant's tool calls directly);
 * any text in the same turn follows as a user message.
 */
function translateTurn(turn: BetaMessageParam, reasoningFor: (toolCallId: string) => unknown[] | undefined): ChatMessage[] {
  if (typeof turn.content === "string") {
    return [turn.role === "user" ? { role: "user", content: turn.content } : { role: "assistant", content: turn.content }];
  }
  const blocks = turn.content as ReadonlyArray<BetaContentBlockParam | BetaContentBlock>;
  if (turn.role === "assistant") {
    let text = "";
    let reasoning: unknown[] | undefined;
    const calls: ChatToolCall[] = [];
    // Only blocks after the last fallback block are the answer (same rule as finalText).
    let start = 0;
    blocks.forEach((b, i) => {
      if (b.type === "fallback") start = i + 1;
    });
    for (const b of blocks.slice(start)) {
      if (b.type === "text") text += b.text;
      else if (b.type === "tool_use") {
        calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        reasoning ??= reasoningFor(b.id);
      }
    }
    const msg: ChatMessage = { role: "assistant", content: text || null };
    if (calls.length > 0) msg.tool_calls = calls;
    if (reasoning) msg.reasoning_details = reasoning;
    return [msg];
  }
  const tools: ChatMessage[] = [];
  const parts: ChatTextPart[] = [];
  for (const b of blocks) {
    if (b.type === "tool_result") {
      const body = textOfToolResult(b.content);
      tools.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${body}` : body });
    } else if (b.type === "text") {
      parts.push({ type: "text", text: b.text });
    }
  }
  return parts.length > 0 ? [...tools, { role: "user", content: parts }] : tools;
}

function systemMessage(system: MessageCreateParamsNonStreaming["system"]): ChatMessage | null {
  if (!system) return null;
  if (typeof system === "string") return { role: "system", content: [{ type: "text", text: system }] };
  const parts = (system as BetaTextBlockParam[]).map((b): ChatTextPart => {
    const part: ChatTextPart = { type: "text", text: b.text };
    if (b.cache_control) part.cache_control = { type: "ephemeral" };
    return part;
  });
  return parts.length > 0 ? { role: "system", content: parts } : null;
}

/** The Chat Completions body for one Messages request (exported for tests and the live check). */
export function toChatRequest(
  params: MessageCreateParamsNonStreaming,
  model: string,
  reasoningFor: (toolCallId: string) => unknown[] | undefined = () => undefined,
): ChatRequest {
  const messages: ChatMessage[] = [];
  const sys = systemMessage(params.system);
  if (sys) messages.push(sys);
  for (const turn of params.messages) messages.push(...translateTurn(turn, reasoningFor));

  const req: ChatRequest = {
    model,
    max_tokens: params.max_tokens,
    messages,
    provider: { require_parameters: true },
    usage: { include: true },
  };
  const tools = (params.tools ?? []).filter((t): t is Extract<typeof t, { input_schema: unknown }> => "input_schema" in t);
  if (tools.length > 0) {
    req.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema,
        ...(t.strict !== undefined ? { strict: t.strict } : {}),
      },
    }));
    const choice = params.tool_choice?.type;
    req.tool_choice = choice === "none" ? "none" : "auto";
  }
  const format = params.output_config?.format;
  if (format && format.type === "json_schema") {
    req.response_format = { type: "json_schema", json_schema: { name: "output", strict: true, schema: format.schema } };
  }
  const effort = params.output_config?.effort;
  if (effort && EFFORT_TO_VERBOSITY[effort]) req.verbosity = EFFORT_TO_VERBOSITY[effort];
  return req;
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

const ANTHROPIC_STOPS = new Set<BetaStopReason>(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]);

/** Anthropic's own stop reason when OpenRouter passes it through, else the mapped finish reason. */
export function stopReasonOf(finish: string | null | undefined, native: string | null | undefined): BetaStopReason | null {
  if (native && ANTHROPIC_STOPS.has(native as BetaStopReason)) return native as BetaStopReason;
  switch (finish) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return null;
  }
}

function parseArguments(raw: string): unknown {
  try {
    const v: unknown = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    // Left for the caller's schema check to reject (it answers with is_error).
    return { _unparsed_arguments: raw };
  }
}

function nonNeg(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** A Chat Completions answer as a Messages API message. */
export function fromChatResponse(body: ChatResponse, requestedModel: string): { message: BetaMessage; reasoning: unknown[] | null } {
  const choice = body.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Array<Record<string, unknown>> = [];
  const text = typeof msg.content === "string" ? msg.content : "";
  if (text) content.push({ type: "text", text, citations: null });
  for (const call of msg.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
      caller: { type: "direct" },
    });
  }
  let stop = stopReasonOf(choice?.finish_reason, choice?.native_finish_reason);
  if (msg.refusal) stop = "refusal";
  // Some providers report "stop" on a turn that only called tools.
  if (stop === "end_turn" && (msg.tool_calls?.length ?? 0) > 0) stop = "tool_use";

  const u = body.usage ?? {};
  const cached = nonNeg(u.prompt_tokens_details?.cached_tokens);
  const written = nonNeg(u.prompt_tokens_details?.cache_write_tokens);
  // prompt_tokens counts cached and written tokens too; the Messages usage block does not.
  const input = Math.max(0, nonNeg(u.prompt_tokens) - cached - written);
  const message = {
    id: body.id ?? "openrouter",
    type: "message",
    role: "assistant",
    model: body.model ?? requestedModel,
    container: null,
    context_management: null,
    diagnostics: null,
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: input,
      output_tokens: nonNeg(u.completion_tokens),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: written,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
  const reasoning = Array.isArray(msg.reasoning_details) && msg.reasoning_details.length > 0 ? msg.reasoning_details : null;
  return { message: message as unknown as BetaMessage, reasoning };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Tool calls whose thinking is kept for echoing (a tool loop needs only its latest turn). */
const MAX_REMEMBERED_CALLS = 256;

function retryable(status: number | null): boolean {
  return status === null || status === 408 || status === 409 || status === 429 || status >= 500;
}

function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const e = (body as ChatResponse).error;
    if (e?.message) return e.message;
  }
  return fallback;
}

export function createOpenRouterClient(opts: OpenRouterOptions): OpenRouterClient {
  const model = opts.model || OPENROUTER_MODEL;
  const url = `${(opts.baseUrl || OPENROUTER_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const maxRetries = opts.maxRetries ?? 2;
  const backoff = opts.backoffMs ?? ((n: number) => 1000 * 2 ** n);
  // Thinking returned with a tool call, echoed when that assistant turn is sent back.
  const reasoningByCall = new Map<string, unknown[]>();
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.apiKey}`,
    "content-type": "application/json",
  };
  if (opts.appUrl) headers["http-referer"] = opts.appUrl;
  if (opts.appTitle) headers["x-title"] = opts.appTitle;

  async function once(body: string, signal: AbortSignal | undefined, timeout: number): Promise<ChatResponse> {
    const timer = AbortSignal.timeout(timeout);
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body,
      signal: signal ? AbortSignal.any([signal, timer]) : timer,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) throw new OpenRouterError(`openrouter ${res.status}: ${errorText(json, res.statusText || "request failed")}`, res.status);
    if (!json || typeof json !== "object") throw new OpenRouterError("openrouter: response was not JSON", res.status);
    const parsed = json as ChatResponse;
    // OpenRouter can answer 200 with an error body (an upstream provider failed).
    const err = parsed.error ?? parsed.choices?.[0]?.error;
    if (err) {
      const code = typeof err.code === "number" ? err.code : Number(err.code);
      throw new OpenRouterError(`openrouter: ${err.message ?? "upstream error"}`, Number.isFinite(code) ? code : 502);
    }
    if (!parsed.choices?.length) throw new OpenRouterError("openrouter: no choices in the response", 502);
    return parsed;
  }

  return {
    provider: "openrouter",
    model,
    ledgerEndpoint: OPENROUTER_ENDPOINT,
    ledgerCurl: OPENROUTER_CURL,
    beta: {
      messages: {
        async create(params, options) {
          const body = JSON.stringify(toChatRequest(params, model, (id) => reasoningByCall.get(id)));
          const timeout = options?.timeout ?? OPENROUTER_TIMEOUT_MS;
          let attempt = 0;
          for (;;) {
            try {
              const answer = await once(body, options?.signal, timeout);
              const { message, reasoning } = fromChatResponse(answer, model);
              if (reasoning) {
                for (const b of message.content) if (b.type === "tool_use") reasoningByCall.set(b.id, reasoning);
                // A long-lived server keeps one client: forget the oldest turns.
                for (const key of reasoningByCall.keys()) {
                  if (reasoningByCall.size <= MAX_REMEMBERED_CALLS) break;
                  reasoningByCall.delete(key);
                }
              }
              return message;
            } catch (err) {
              const status = err instanceof OpenRouterError ? err.status : null;
              if (options?.signal?.aborted || attempt >= maxRetries || !retryable(status)) {
                throw err instanceof OpenRouterError ? err : new OpenRouterError(err instanceof Error ? err.message : String(err), null);
              }
              const wait = backoff(attempt);
              attempt += 1;
              if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            }
          }
        },
      },
    },
  };
}
