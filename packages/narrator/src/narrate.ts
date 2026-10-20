/**
 * narrate(): Claude writes the sheet's narration under a per-run schema, then a
 * deterministic guard re-checks every line. Any failure path (LLM off, over
 * budget, refusal, unparseable output, API error) returns templateNarrate().
 *
 * Why beta.messages.create and not messages.parse (SDK 0.133):
 * - the non-beta `messages.parse` has no `betas` / `fallbacks` params;
 * - `beta.messages.parse` does type-check with them, but it parses inside the
 *   returned promise and throws on a validation failure, which loses
 *   `stop_reason` and `usage` (a refused or malformed answer could then not be
 *   priced by the spend guard);
 * - zodOutputFormat() moves `enum` into the description (see json-schema.ts),
 *   so the per-run id enums would not constrain decoding.
 * So: `beta.messages.create` with `output_config.format` from jsonOutputFormat()
 * (zod's own converter, enums kept), check `stop_reason` first, record usage,
 * then parse the text block with the same zod schema (null on failure).
 */
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { CopyHook } from "@walkup/contracts";
import { callModel, finalText, parseJsonWith, usageFromMessage } from "./client";
import {
  DEFAULT_MAX_TOKENS,
  FALLBACK_BETA,
  FALLBACKS_MODE,
  MAX_COPY_HOOKS,
  MODEL,
  NARRATION_EFFORT,
} from "./constants";
import { prepareRun, renderFactsMessage, type PreparedRun } from "./facts";
import { jsonOutputFormat } from "./json-schema";
import { policyProblem, unlistedNumber } from "./policy";
import { NARRATOR_SYSTEM_PROMPT } from "./prompts";
import { buildNarrationSchema, toDraft, type NarrationDraft } from "./schema";
import { templateNarrate, templateSummary } from "./template";
import type { CallUsage, LlmOptions, NarrateInput, NarrationResult, TemplateReason } from "./types";

export type NarrateOptions = LlmOptions;

/** Builds the exact request narrate() sends (exported for inspection and tests). */
export function buildNarrationRequest(
  prepared: PreparedRun,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    system: [{ type: "text", text: NARRATOR_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: renderFactsMessage(prepared) }],
    output_config: {
      effort: NARRATION_EFFORT,
      format: jsonOutputFormat(buildNarrationSchema(prepared.ids)),
    },
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS_MODE,
  };
}

export interface GuardedNarration {
  /** Null when the summary itself failed the guard. */
  summary: string | null;
  tileWhy: NarrationResult["tileWhy"];
  partnerLines: NarrationResult["partnerLines"];
  copyHooks: CopyHook[];
  dropped: number;
  reasons: string[];
}

/**
 * Deterministic validator over a parsed draft: ids must be from this run, every
 * number must be a run number, policy words are rejected (alcohol words too
 * unless the ticketing age policy says 21+), copy hooks must use allowlisted
 * tags by name and no act names. Failing lines are dropped and counted.
 */
export function guardNarration(draft: NarrationDraft, prepared: PreparedRun): GuardedNarration {
  const reasons: string[] = [];
  const geos = new Set(prepared.ids.geohashes);
  const ents = new Set(prepared.ids.entityIds);
  const tagById = new Map(prepared.allowlist.map((t) => [t.id, t]));
  const prot = prepared.protectedStrings;

  const problemOf = (text: string): string | null => {
    const p = policyProblem(text, prot, { alcoholAllowed: prepared.alcoholAllowed });
    if (p) return p;
    const n = unlistedNumber(text, prepared.allowedNumbers, prot);
    return n ? `number ${n} is not in this run` : null;
  };

  let summary: string | null = draft.summary.trim();
  const sp = problemOf(summary);
  if (sp) {
    reasons.push(`summary: ${sp}`);
    summary = null;
  }

  const tileWhy: GuardedNarration["tileWhy"] = [];
  draft.tileWhy.forEach((t, i) => {
    const where = `tileWhy[${i}]`;
    if (!geos.has(t.geohash)) return void reasons.push(`${where}: geohash not in this run`);
    if (tileWhy.some((x) => x.geohash === t.geohash)) return void reasons.push(`${where}: duplicate tile`);
    const p = problemOf(t.text);
    if (p) return void reasons.push(`${where}: ${p}`);
    tileWhy.push({ geohash: t.geohash, text: t.text.trim() });
  });

  const partnerLines: GuardedNarration["partnerLines"] = [];
  draft.partnerLines.forEach((l, i) => {
    const where = `partnerLines[${i}]`;
    if (!ents.has(l.entityId)) return void reasons.push(`${where}: entityId not in this run`);
    if (partnerLines.some((x) => x.entityId === l.entityId)) return void reasons.push(`${where}: duplicate entity`);
    const p = problemOf(l.text);
    if (p) return void reasons.push(`${where}: ${p}`);
    partnerLines.push({ entityId: l.entityId, text: l.text.trim() });
  });

  const copyHooks: CopyHook[] = [];
  draft.copyHooks.forEach((h, i) => {
    const where = `copyHooks[${i}]`;
    if (copyHooks.length >= MAX_COPY_HOOKS) return void reasons.push(`${where}: more than ${MAX_COPY_HOOKS} hooks`);
    const tagIds = [...new Set(h.tagIds)];
    if (tagIds.length === 0) return void reasons.push(`${where}: cites no tag`);
    const tags = tagIds.map((id) => tagById.get(id));
    if (tags.some((t) => !t)) return void reasons.push(`${where}: tag not on the allowlist`);
    const lower = h.text.toLowerCase();
    if (!tags.some((t) => t && (lower.includes(t.name.toLowerCase()) || lower.includes(t.name.toLowerCase().replace(/\s+fans$/, ""))))) {
      return void reasons.push(`${where}: text does not use a cited tag name`);
    }
    if (prepared.actNames.some((a) => a && lower.includes(a.toLowerCase()))) {
      return void reasons.push(`${where}: act name in copy`);
    }
    const p = problemOf(h.text);
    if (p) return void reasons.push(`${where}: ${p}`);
    copyHooks.push({ text: h.text.trim(), tagIds });
  });

  return { summary, tileWhy, partnerLines, copyHooks, dropped: reasons.length, reasons };
}

function fallback(
  input: NarrateInput,
  prepared: PreparedRun,
  reason: TemplateReason,
  usage: CallUsage | null,
  ledgerRefs: string[],
  note?: string,
): NarrationResult {
  const t = templateNarrate(input, reason, prepared);
  return {
    ...t,
    usage,
    ledgerRefs,
    guard: { ...t.guard, reasons: note ? [note] : t.guard.reasons },
  };
}

export async function narrate(input: NarrateInput, opts: NarrateOptions = {}): Promise<NarrationResult> {
  const prepared = prepareRun(input);
  const client = opts.client ?? null;
  if (!client) return fallback(input, prepared, "llm_off", null, []);

  if (opts.spend && !(await opts.spend.canSpend(opts.reserveUsd ?? 0))) {
    return fallback(input, prepared, "over_budget", null, []);
  }

  const schema = buildNarrationSchema(prepared.ids);
  const params = buildNarrationRequest(prepared, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  const outcome = await callModel({ client, spend: opts.spend, ledger: opts.ledger, purpose: "narrate" }, params);
  const refs = outcome.ledgerRef ? [outcome.ledgerRef] : [];
  if (!outcome.ok) return fallback(input, prepared, "api_error", null, refs, outcome.error);

  const { message } = outcome;
  const usage = usageFromMessage(message, outcome.costUsd);
  // Check stop_reason before reading content.
  if (message.stop_reason === "refusal") {
    const cat = message.stop_details?.category ?? null;
    return fallback(input, prepared, "refusal", usage, refs, `refusal${cat ? ` (${cat})` : ""}`);
  }
  if (message.stop_reason === "max_tokens") {
    return fallback(input, prepared, "max_tokens", usage, refs);
  }

  const wire = parseJsonWith(schema, finalText(message.content));
  if (wire === null) return fallback(input, prepared, "parse_failed", usage, refs);

  const guarded = guardNarration(toDraft(wire), prepared);
  return {
    summary: guarded.summary ?? templateSummary(input, prepared),
    tileWhy: guarded.tileWhy,
    partnerLines: guarded.partnerLines,
    copyHooks: guarded.copyHooks,
    templated: false,
    templateReason: null,
    usage,
    guard: { dropped: guarded.dropped, reasons: guarded.reasons, deniedTagCount: prepared.deniedTagCount },
    ledgerRefs: refs,
  };
}
