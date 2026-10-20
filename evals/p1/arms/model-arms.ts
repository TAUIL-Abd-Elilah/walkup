/**
 * The two model arms exactly as ARMS.md §4 and §5 specify them: claude-opus-5-5 with the
 * shared P1 system prompt, a structured JSON answer, no server-side fallback and no thinking
 * parameter. F runs a manual tool loop with one strict `places_search` tool backed by
 * @walkup/places (at most 5 tool calls); L is one call without tools.
 *
 * These are P1-specific on purpose: @walkup/narrator's runControlArm / runLlmOnlyArm
 * serve the product (their prompts, tools, list length, effort and server-side fallback differ
 * from the sealed P1 protocol). This module reuses the narrator's model id and spend guard.
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type {
  ContentBlock,
  ContentBlockParam,
  Message,
  MessageCreateParamsNonStreaming,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { GeoPoint, LedgerSink } from "@walkup/contracts";
import { estimateCostUsd, MODEL, type SpendGuard } from "@walkup/narrator";
import { PlacesError } from "@walkup/places";
import { z } from "zod";
import { StopRunError, errorText } from "./errors";
import type { PlacesIo } from "./places-io";
import {
  F_EFFORT,
  F_KEEP,
  F_MAX_TOOL_CALLS,
  F_MAX_TURNS,
  fPrompt,
  L_EFFORT,
  L_KEEP,
  lPrompt,
  METRO_RADIUS_M,
  MODEL_MAX_TOKENS,
  PLACES_PAGE_SIZE,
  PLACES_SEARCH_TOOL,
  SYSTEM_PROMPT,
  TOOL_BUDGET_MESSAGE,
} from "./protocol";

export const FAnswer = z.object({ place_ids: z.array(z.string()) });
export const LAnswer = z.object({ names: z.array(z.string()) });

/** The slice of the Anthropic client the model arms use; `new Anthropic({ maxRetries: 0 })` satisfies it. */
export interface ModelClient {
  messages: {
    create(params: MessageCreateParamsNonStreaming): PromiseLike<Message>;
  };
}

export interface ModelDeps {
  client: ModelClient;
  spend: SpendGuard | null;
  ledger: LedgerSink | null;
  sleep: (ms: number) => Promise<void>;
  /** USD kept in hand before each call (default 0). */
  reserveUsd?: number;
  /** Transient-error retries per call (default 3, backoff 1 s, 2 s, 4 s). */
  maxRetries?: number;
}

export interface ModelCallStats {
  calls: number;
  estUsd: number;
  modelMismatchRetries: number;
}

export function newModelStats(): ModelCallStats {
  return { calls: 0, estUsd: 0, modelMismatchRetries: 0 };
}

/** A call that still failed: the query gets no rows for this arm. */
export class ModelCallFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCallFailed";
  }
}

/** "claude-opus-5-5", or a dated snapshot of it. */
export function isExpectedModel(model: string | null | undefined): boolean {
  return model === MODEL || new RegExp(`^${MODEL}-\\d{8}$`).test(model ?? "");
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

function isTransient(err: unknown): boolean {
  const status = statusOf(err);
  if (status === null) return true; // connection errors and timeouts carry no status
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function createOnce(deps: ModelDeps, stats: ModelCallStats, params: MessageCreateParamsNonStreaming, purpose: string): Promise<Message> {
  const maxRetries = deps.maxRetries ?? 3;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await deps.sleep(1000 * 2 ** (attempt - 1));
    if (deps.spend && !(await deps.spend.canSpend(deps.reserveUsd ?? 0))) {
      throw new StopRunError("llm_spend", `daily model spend cap of $${deps.spend.dailyCapUsd} reached; resume tomorrow or raise --llm-daily-cap-usd`);
    }
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let msg: Message;
    try {
      msg = await deps.client.messages.create(params);
    } catch (err) {
      lastErr = err;
      const status = statusOf(err);
      if (status === 400 || status === 401 || status === 403 || status === 404) {
        throw new StopRunError("fatal_api", `model request rejected (HTTP ${status}): ${errorText(err)}`);
      }
      if (isTransient(err)) continue;
      break;
    }
    const usage = msg.usage;
    const cost = estimateCostUsd(
      {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
      },
      msg.model ?? MODEL,
    );
    stats.calls += 1;
    stats.estUsd += cost;
    if (deps.spend) await deps.spend.recordUsd(cost);
    deps.ledger?.add({
      kind: "anthropic",
      method: "POST",
      endpoint: "/v1/messages",
      params: {
        model: params.model,
        effort: params.output_config?.effort ?? null,
        max_tokens: params.max_tokens,
        tools: (params.tools ?? []).map((t) => ("name" in t ? String(t.name) : "tool")),
        messages: params.messages.length,
      },
      httpStatus: 200,
      envelopeStatus: msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens" ? "degraded" : "ok",
      latencyMs: Date.now() - t0,
      bytes: 0,
      cacheHit: (usage?.cache_read_input_tokens ?? 0) > 0,
      resultCount: msg.content.length,
      curl: "",
      startedAt,
      note: `${purpose}; model=${msg.model}; stop_reason=${msg.stop_reason ?? "null"}; est $${cost.toFixed(4)}`,
    });
    return msg;
  }
  throw new ModelCallFailed(`model call failed after ${maxRetries} retries: ${errorText(lastErr)}`);
}

/** Discard and retry once any response whose model is not claude-opus-5-5 (§8). */
async function createChecked(deps: ModelDeps, stats: ModelCallStats, params: MessageCreateParamsNonStreaming, purpose: string): Promise<Message> {
  const first = await createOnce(deps, stats, params, purpose);
  if (isExpectedModel(first.model)) return first;
  stats.modelMismatchRetries += 1;
  const second = await createOnce(deps, stats, params, `${purpose} (retry: model was ${first.model})`);
  if (isExpectedModel(second.model)) return second;
  throw new ModelCallFailed(`response model was ${second.model}, not ${MODEL}, twice`);
}

function textOf(content: readonly ContentBlock[]): string {
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function parseWith<T>(schema: z.ZodType<T>, text: string): T | null {
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

const SYSTEM = [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }];

export function fRequest(messages: MessageParam[]): MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: MODEL_MAX_TOKENS,
    output_config: { effort: F_EFFORT, format: zodOutputFormat(FAnswer) },
    system: SYSTEM,
    tools: [PLACES_SEARCH_TOOL],
    messages,
  };
}

export function lRequest(prompt: string): MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: MODEL_MAX_TOKENS,
    output_config: { effort: L_EFFORT, format: zodOutputFormat(LAnswer) },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  };
}

// ---------------------------------------------------------------------------
// Arm F
// ---------------------------------------------------------------------------

export interface FQuery {
  metroDisplay: string;
  state: string;
  clubDisplay: string;
  point: GeoPoint;
}

export type ModelArmStatus = "ok" | "refused" | "failed";

export interface FOutcome {
  status: ModelArmStatus;
  reason: string | null;
  /** The model's answer, first 50 entries. */
  answer: string[];
  /** Final ranked list: answer minus ids the tool never returned and repeats. */
  placeIds: string[];
  droppedUnseen: number;
  repeats: number;
  toolCalls: number;
  toolErrors: number;
  queries: string[];
  turns: number;
}

/** Keep the first 50 answer entries, then drop ids the tool never returned and repeats (first kept). */
export function rankFAnswer(answer: readonly string[], seen: ReadonlySet<string>): { answer: string[]; placeIds: string[]; droppedUnseen: number; repeats: number } {
  const head = answer.slice(0, F_KEEP);
  const placeIds: string[] = [];
  const used = new Set<string>();
  let droppedUnseen = 0;
  let repeats = 0;
  for (const raw of head) {
    const id = raw.trim();
    if (!seen.has(id)) {
      droppedUnseen += 1;
      continue;
    }
    if (used.has(id)) {
      repeats += 1;
      continue;
    }
    used.add(id);
    placeIds.push(id);
  }
  return { answer: head, placeIds, droppedUnseen, repeats };
}

export async function runFConversation(q: FQuery, deps: ModelDeps, places: PlacesIo, stats: ModelCallStats): Promise<FOutcome> {
  const out: FOutcome = { status: "failed", reason: null, answer: [], placeIds: [], droppedUnseen: 0, repeats: 0, toolCalls: 0, toolErrors: 0, queries: [], turns: 0 };
  const messages: MessageParam[] = [{ role: "user", content: fPrompt(q.metroDisplay, q.state, q.clubDisplay) }];
  const seen = new Set<string>();
  try {
    for (let turn = 1; turn <= F_MAX_TURNS; turn++) {
      const msg = await createChecked(deps, stats, fRequest(messages), `P1 arm F turn ${turn}`);
      out.turns = turn;
      if (msg.stop_reason === "refusal") return { ...out, status: "refused", reason: "refusal" };
      const uses = msg.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) {
        if (msg.stop_reason === "max_tokens") return { ...out, reason: "max_tokens" };
        const parsed = parseWith(FAnswer, textOf(msg.content));
        if (!parsed) return { ...out, reason: "answer did not match the output schema" };
        return { ...out, status: "ok", ...rankFAnswer(parsed.place_ids, seen) };
      }
      // Echo the assistant turn unchanged; every tool_result of the turn goes back in one user message.
      messages.push({ role: "assistant", content: msg.content as unknown as ContentBlockParam[] });
      const results: ToolResultBlockParam[] = [];
      for (const u of uses) {
        const fail = (text: string): void => {
          out.toolErrors += 1;
          results.push({ type: "tool_result", tool_use_id: u.id, content: text, is_error: true });
        };
        if (u.name !== "places_search") {
          fail(`unknown tool "${u.name}"; the only tool is places_search`);
          continue;
        }
        if (out.toolCalls >= F_MAX_TOOL_CALLS) {
          fail(TOOL_BUDGET_MESSAGE);
          continue;
        }
        out.toolCalls += 1;
        const query = typeof (u.input as { query?: unknown } | null)?.query === "string" ? ((u.input as { query: string }).query.trim()) : "";
        if (!query) {
          fail("places_search needs a non-empty query");
          continue;
        }
        out.queries.push(query);
        try {
          const res = await places.search({ textQuery: query, center: q.point, radiusM: METRO_RADIUS_M, maxResultCount: PLACES_PAGE_SIZE });
          for (const p of res.places) seen.add(p.placeId);
          const payload = res.places.map((p) => ({
            id: p.placeId,
            name: p.name,
            address: p.address ?? null,
            rating: p.rating ?? null,
            userRatingCount: p.userRatingCount ?? null,
            businessStatus: p.businessStatus ?? null,
          }));
          results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(payload) });
        } catch (err) {
          if (err instanceof StopRunError) throw err;
          if (err instanceof PlacesError && (err.status === 401 || err.status === 403)) {
            throw new StopRunError("fatal_api", `places_search rejected (HTTP ${err.status}): ${errorText(err)}`);
          }
          if (err instanceof PlacesError && (err.status === null || err.status === 429 || err.status >= 500)) {
            // Plan §8 "Failures": a call that still fails after its retries leaves no rows for this
            // (query, arm). Handing the model an error instead would let it answer from a shorter
            // candidate list, so F's ranks would carry an outage rather than the protocol.
            throw new ModelCallFailed(`places_search failed after retries: ${errorText(err)}`);
          }
          // Any other Places answer (for example a 400 for the model's query text) goes back to
          // the model as a tool error, as a fair tool would report it.
          fail(`places_search failed: ${errorText(err)}`);
        }
      }
      messages.push({ role: "user", content: results });
    }
    return { ...out, reason: `no answer after ${F_MAX_TURNS} model turns` };
  } catch (err) {
    if (err instanceof ModelCallFailed) return { ...out, status: "failed", reason: err.message };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Arm L
// ---------------------------------------------------------------------------

export interface LOutcome {
  status: ModelArmStatus;
  reason: string | null;
  /** First 3 names as returned. */
  names: string[];
}

export async function runLCall(q: Omit<FQuery, "point">, deps: ModelDeps, stats: ModelCallStats): Promise<LOutcome> {
  try {
    const msg = await createChecked(deps, stats, lRequest(lPrompt(q.clubDisplay, q.metroDisplay, q.state)), "P1 arm L");
    if (msg.stop_reason === "refusal") return { status: "refused", reason: "refusal", names: [] };
    if (msg.stop_reason === "max_tokens") return { status: "failed", reason: "max_tokens", names: [] };
    const parsed = parseWith(LAnswer, textOf(msg.content));
    if (!parsed) return { status: "failed", reason: "answer did not match the output schema", names: [] };
    return { status: "ok", reason: null, names: parsed.names.slice(0, L_KEEP) };
  } catch (err) {
    if (err instanceof ModelCallFailed) return { status: "failed", reason: err.message, names: [] };
    throw err;
  }
}
