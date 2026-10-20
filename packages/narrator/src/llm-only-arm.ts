/**
 * Arm L: the same model and system prompt as arm F, with no tools. Shown only
 * on the eval page as hallucination and contamination context. Names are
 * unverified model output, so place ids are synthetic ("unverified:N").
 */
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ControlPlace } from "@walkup/contracts";
import { z } from "zod";
import { callModel, finalText, parseJsonWith, usageFromMessage } from "./client";
import {
  CONTROL_EFFORT,
  CONTROL_MAX_PLACES,
  DEFAULT_MAX_TOKENS,
  FALLBACK_BETA,
  FALLBACKS_MODE,
  MODEL,
} from "./constants";
import { renderShowBlock, type ControlArmInput, type ControlArmRun } from "./control-arm";
import { jsonOutputFormat } from "./json-schema";
import { overlapNames, type OverlapCandidate } from "./overlap";
import { CONTROL_SYSTEM_PROMPT } from "./prompts";
import type { LlmOptions } from "./types";

export const LlmOnlyRankingSchema = z.object({
  places: z.array(
    z.object({
      name: z.string().describe("The place's name as you know it."),
      address: z.string().nullable().describe("Street address, or null if you do not know it."),
      reason: z.string().describe("One short reason."),
    }),
  ),
});

export interface LlmOnlyArmOptions extends LlmOptions {
  qlooPartners?: OverlapCandidate[];
}

export const UNVERIFIED_PREFIX = "unverified:";

export function buildLlmOnlyRequest(input: ControlArmInput, maxTokens: number = DEFAULT_MAX_TOKENS): MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    system: [{ type: "text", text: CONTROL_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `${renderShowBlock(input)}\n\n` +
          "You have no tools in this run. List up to 20 real places near the venue where this bill's audience is " +
          "likely to spend time, best first.",
      },
    ],
    output_config: { effort: CONTROL_EFFORT, format: jsonOutputFormat(LlmOnlyRankingSchema) },
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS_MODE,
  };
}

export async function runLlmOnlyArm(input: ControlArmInput, opts: LlmOnlyArmOptions = {}): Promise<ControlArmRun> {
  const base: ControlArmRun = {
    arm: "L",
    places: [],
    overlapWithQloo: [],
    ledgerRefs: [],
    status: "ok",
    droppedUnseen: 0,
    droppedIds: [],
    iterations: 0,
    queries: [],
    toolErrors: 0,
    reasons: {},
    usage: null,
    notes: ["No tools: names are unverified model output, shown for contamination context only."],
  };
  const client = opts.client ?? null;
  if (!client) return { ...base, status: "llm_off", notes: ["LLM is off; arm L did not run."] };
  if (opts.spend && !(await opts.spend.canSpend(opts.reserveUsd ?? 0))) {
    return { ...base, status: "over_budget", notes: ["Daily model spend cap reached."] };
  }

  const outcome = await callModel(
    { client, spend: opts.spend, ledger: opts.ledger, purpose: "arm L" },
    buildLlmOnlyRequest(input, opts.maxTokens ?? DEFAULT_MAX_TOKENS),
  );
  if (outcome.ledgerRef) base.ledgerRefs.push(outcome.ledgerRef);
  if (!outcome.ok) return { ...base, status: "api_error", notes: [outcome.error] };
  base.iterations = 1;
  base.usage = usageFromMessage(outcome.message, outcome.costUsd);
  if (outcome.message.stop_reason === "refusal") return { ...base, status: "refused", notes: ["The model declined."] };

  const parsed = parseJsonWith(LlmOnlyRankingSchema, finalText(outcome.message.content));
  if (!parsed) return { ...base, status: "no_ranking", notes: ["The answer did not match the output schema."] };

  const places: ControlPlace[] = [];
  const reasons: Record<string, string> = {};
  for (const p of parsed.places) {
    if (places.length >= CONTROL_MAX_PLACES) break;
    const name = p.name.trim();
    if (!name || places.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    const placeId = `${UNVERIFIED_PREFIX}${places.length + 1}`;
    places.push({ placeId, name, ...(p.address ? { address: p.address } : {}), query: "" });
    reasons[placeId] = p.reason;
  }
  // No coordinates come back, so overlap can only be computed when a caller
  // geocodes these names first; with no locations it is empty by construction.
  const overlapWithQloo = opts.qlooPartners ? overlapNames(opts.qlooPartners, places) : [];
  return { ...base, places, reasons, overlapWithQloo };
}
