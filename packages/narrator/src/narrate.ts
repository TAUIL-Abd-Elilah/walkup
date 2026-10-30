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
import { audienceWordIn, isAudienceTag } from "./audience";
import { headlinerName, prepareRun, renderFactsMessage, type PreparedRun } from "./facts";
import { jsonOutputFormat } from "./json-schema";
import { blankProtected, policyProblem, unlistedNumber } from "./policy";
import { NARRATOR_SYSTEM_PROMPT } from "./prompts";
import { buildNarrationSchema, toDraft, type NarrationDraft } from "./schema";
import { PROPER_WORD_RE, properPhrases, templateNarrate, templateSummary } from "./template";
import type { CallUsage, LlmOptions, NarrateInput, NarrationResult, TemplateReason } from "./types";
import { anBeforeNumber, classificationWording, HOOK_CLAIM_RE, HOOK_ROOM_SIZE_RE, liftFigureStyle, vetGeneratedLines } from "./vet";

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
 * tags by name, no audience tag or audience word, and name the act (the
 * headliner is put in front of a line that names no act). Failing lines are
 * dropped and counted.
 */
/**
 * Writes the run's ISO show date and "<n> USD" the way the sheet does ("Wednesday, Feb 17", "$6,000"), for a
 * model that copied them from the facts. Nothing else in the text changes.
 */
export function readableForPromoter(text: string, show: { date?: unknown; dateText?: unknown; classification?: unknown }): string {
  let out = text;
  // "this Music / R&B show" -> "this R&B show", as the sheet's header gives the genre.
  if (typeof show.classification === "string") out = classificationWording(out, show.classification);
  if (typeof show.date === "string" && typeof show.dateText === "string" && show.date) {
    // "on Wednesday, 2027-02-17" would repeat the weekday: drop a weekday written just before the date.
    out = out.replace(new RegExp(`(?:\\b[A-Z][a-z]+day,?\\s+)?${show.date.replace(/-/g, "\\-")}`, "g"), show.dateText);
  }
  // A tag name with a stray space after its hyphen ("alt- country") is written whole ("alt-country"); a suspended
  // hyphen ("pre- and post-show") stays.
  out = out.replace(/\b([A-Za-z]+)-\s+(?!(?:and|or|to|nor)\b)([a-z])/g, "$1-$2");
  // "a intimate room" -> "an intimate room" (a tag name dropped in after "a"); "a one-off", "a unique" stay.
  out = out.replace(/\b([Aa]) (?=[aeiou])(?!(?:one|once|uni|use|usu|ure|uti|eu)[a-z]*\b)/gi, (_m, a: string) => `${a}n `);
  // "a 82nd percentile" -> "an 82nd percentile".
  out = anBeforeNumber(out);
  return out.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)(?:\s*USD\b|[- ]dollars?\b)/g, (_m, n: string) => `$${Number(n.replace(/,/g, "")).toLocaleString("en-US")}`);
}


/**
 * Tag names written mid-sentence in sentence case, as the sheet writes them: "an Intimate night of Alt-country" ->
 * "an intimate night of alt-country", "American History" -> "American history". A word at the start of a sentence,
 * a proper adjective and a word with two capitals ("R&B", "DJ") keep their case.
 */
export function tagNamesInSentenceCase(text: string, names: readonly string[], protect: readonly string[] = []): string {
  let out = text;
  // Spans of names that keep their case (acts, the venue, places, areas), found once in the original text.
  const kept: [number, number][] = [];
  for (const p of protect.map((x) => x.trim()).filter((x) => x.length >= 3)) {
    let i = text.toLowerCase().indexOf(p.toLowerCase());
    while (i >= 0) {
      kept.push([i, i + p.length]);
      i = text.toLowerCase().indexOf(p.toLowerCase(), i + 1);
    }
  }
  // "Alt- Country" (as Qloo spells one tag) is matched as the text writes it after readableForPromoter: "alt-country".
  const uniq = [...new Set(names.map((n) => n.trim().replace(/-\s+/g, "-")).filter((n) => n.length >= 3))].sort((x, y) => y.length - x.length);
  for (const name of uniq) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi");
    out = out.replace(re, (hit: string, at: number) => {
      if (kept.some(([a, b]) => at < b && at + hit.length > a)) return hit;
      const before = out.slice(0, at);
      const sentenceStart = /(?:^|[.!?]\s+)$/.test(before);
      return properPhrases(
        hit
          .split(/(\s+|-)/)
          .map((w, i) => {
            if (i === 0 && sentenceStart) return w;
            const cap = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
            if (PROPER_WORD_RE.test(cap)) return cap;
            if (!/[A-Z]/.test(w) || (w.match(/[A-Z]/g)?.length ?? 0) >= 2) return w;
            return w.toLowerCase();
          })
          .join(""),
      );
    });
  }
  return out;
}

export function guardNarration(rawDraft: NarrationDraft, prepared: PreparedRun): GuardedNarration {
  const show = (prepared.facts["show"] ?? {}) as { date?: unknown; dateText?: unknown; classification?: unknown };
  const factPartners = (prepared.facts["partners"] ?? []) as { entityId: string; sharedTags?: string[] }[];
  const tagWords = [...prepared.allowlist.map((t) => t.name), ...factPartners.flatMap((p) => p.sharedTags ?? [])];
  const fix = (t: string) => readableForPromoter(t, show);
  // Names keep their case: the acts, the venue and city, places and areas (not the tag names themselves).
  const f = prepared.facts as {
    show?: { acts?: { name: string }[]; venue?: { name?: string; city?: string } };
    tiles?: { name?: string | null }[];
    partners?: { name?: string }[];
    prePost?: { name?: string }[];
    media?: { name?: string }[];
  };
  const names = [
    ...(f.show?.acts ?? []).map((a) => a.name),
    f.show?.venue?.name ?? "",
    f.show?.venue?.city ?? "",
    ...[...(f.tiles ?? []), ...(f.partners ?? []), ...(f.prePost ?? []), ...(f.media ?? [])].map((x) => x.name ?? ""),
  ];
  const fixTags = (t: string) => tagNamesInSentenceCase(fix(t), tagWords, names);
  const draft: NarrationDraft = {
    ...rawDraft,
    summary: fix(rawDraft.summary),
    tileWhy: rawDraft.tileWhy.map((t) => ({ ...t, text: fix(t.text) })),
    partnerLines: rawDraft.partnerLines.map((l) => ({ ...l, text: fixTags(l.text) })),
    copyHooks: rawDraft.copyHooks.map((h) => ({ ...h, text: fixTags(h.text) })),
  };
  const reasons: string[] = [];
  const geos = new Set(prepared.ids.geohashes);
  const ents = new Set(prepared.ids.entityIds);
  const tagById = new Map(prepared.allowlist.map((t) => [t.id, t]));
  const prot = prepared.protectedStrings;
  const showFacts = show as { acts?: { name: string; role: string }[]; venue?: { name?: string; city?: string } };
  const headliner = headlinerName({ acts: showFacts.acts ?? prepared.actNames.map((name) => ({ name, role: "headliner" })) });
  const venueNames = [showFacts.venue?.name ?? "", showFacts.venue?.city ?? ""].filter(Boolean);

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
    // A line per partner only: spots, podcasts and the sponsor have no partner line.
    if (factPartners.length > 0 && !factPartners.some((p) => p.entityId === l.entityId)) return void reasons.push(`${where}: not a partner`);
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
    if (tags.some((t) => t && isAudienceTag(t))) return void reasons.push(`${where}: audience tag in copy`);
    const p = problemOf(h.text);
    if (p) return void reasons.push(`${where}: ${p}`);
    if (audienceWordIn(blankProtected(h.text, [...prepared.actNames, ...venueNames])) !== null) {
      return void reasons.push(`${where}: audience word in copy`);
    }
    const claim = HOOK_CLAIM_RE.exec(blankProtected(h.text, [...prepared.actNames, ...venueNames]));
    if (claim) return void reasons.push(`${where}: claim the sheet can't back ("${claim[0].toLowerCase()}")`);
    const size = HOOK_ROOM_SIZE_RE.exec(blankProtected(h.text, [...prepared.actNames, ...venueNames]));
    if (size) return void reasons.push(`${where}: a room size from a taste tag ("${size[0].toLowerCase()}")`);
    const text = h.text.trim();
    const namesAct = prepared.actNames.some((a) => a && lower.includes(a.toLowerCase()));
    copyHooks.push({ text: namesAct || !headliner ? text : `${headliner}: ${text}`, tagIds });
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
  // Claims the map and the sheet's numbers do not back (directions, forecasts, superlatives, partner tags):
  // the template's line for that slot replaces the model's.
  const vetted = vetGeneratedLines(input, prepared, guarded);
  // "about 2 times" for an area at 2.04 is written as the sheet prints it: "about 2.0 times".
  const lifts = new Map(input.tiles.map((t) => [t.geohash, t.lift]));
  return {
    summary: vetted.summary ?? templateSummary(input, prepared),
    tileWhy: vetted.tileWhy.map((t) => ({ ...t, text: liftFigureStyle(t.text, lifts.get(t.geohash) ?? Number.NaN) })),
    partnerLines: vetted.partnerLines,
    copyHooks: guarded.copyHooks,
    templated: false,
    templateReason: null,
    usage,
    guard: {
      // A replaced line is not a dropped claim (the slot keeps a checked line): said in the reasons, not counted.
      dropped: guarded.dropped,
      reasons: [...guarded.reasons, ...vetted.replaced.map((r) => `replaced by the template: ${r}`)],
      deniedTagCount: prepared.deniedTagCount,
    },
    ledgerRefs: refs,
  };
}
