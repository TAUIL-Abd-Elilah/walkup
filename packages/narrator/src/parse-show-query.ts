/**
 * parseShowQuery(): free text ("Zach Bryan at The Truth, Nashville, Nov 28 2026")
 * to ticketing-search fields, via structured output at effort low. Falls back
 * to a small deterministic parser when the LLM is off, refuses, is over
 * budget, or returns something unparseable.
 */
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { callModel, finalText, parseJsonWith, usageFromMessage } from "./client";
import { FALLBACK_BETA, FALLBACKS_MODE, MODEL, PARSE_EFFORT, PARSE_MAX_TOKENS } from "./constants";
import { jsonOutputFormat } from "./json-schema";
import { PARSE_SYSTEM_PROMPT } from "./prompts";
import type { CallUsage, LlmOptions } from "./types";

export interface ShowQuery {
  artist: string;
  venue?: string;
  city?: string;
  /** YYYY-MM-DD */
  date?: string;
}

export interface ParsedShowQuery extends ShowQuery {
  source: "llm" | "heuristic";
  /** Why the heuristic ran, when it did. */
  reason?: string;
  usage: CallUsage | null;
  ledgerRefs: string[];
}

export interface ParseShowQueryOptions extends LlmOptions {
  /** Reference date (YYYY-MM-DD) for relative dates. Sent in the user message, never the system prompt. */
  today?: string;
}

export const ShowQuerySchema = z.object({
  artist: z.string().describe("The performing act, as written."),
  venue: z.string().nullable().describe("Venue name, or null if not stated."),
  city: z.string().nullable().describe("City, or null if not stated."),
  date: z.string().nullable().describe("YYYY-MM-DD, or null if not stated or unclear."),
});

const MAX_QUERY_CHARS = 500;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(s: string | null | undefined): string | undefined {
  if (!s || !ISO_DATE.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? undefined : s;
}

function clean(s: string | null | undefined): string | undefined {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  return t ? t : undefined;
}

function withFields(q: { artist: string; venue?: string | null; city?: string | null; date?: string | null }): ShowQuery {
  const out: ShowQuery = { artist: clean(q.artist) ?? "" };
  const venue = clean(q.venue);
  const city = clean(q.city);
  const date = validIsoDate(q.date ?? undefined);
  if (venue) out.venue = venue;
  if (city) out.city = city;
  if (date) out.date = date;
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic fallback
// ---------------------------------------------------------------------------

const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_DATE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i;
const WEEKDAY = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?\b\.?,?/gi;

/** "Artist at Venue, City on 2026-11-28" and close variants. Never guesses a year. */
export function heuristicShowQuery(text: string): ShowQuery {
  let rest = text.slice(0, MAX_QUERY_CHARS).replace(/\s+/g, " ").trim();
  let date: string | undefined;

  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(rest);
  if (iso) {
    date = validIsoDate(iso[1]);
    rest = rest.replace(iso[0], " ");
  } else {
    const md = MONTH_DATE.exec(rest);
    if (md) {
      const m = MONTH_INDEX[md[1]!.toLowerCase()];
      if (m) date = validIsoDate(`${md[3]}-${String(m).padStart(2, "0")}-${md[2]!.padStart(2, "0")}`);
      rest = rest.replace(md[0], " ");
    }
  }
  rest = rest
    .replace(WEEKDAY, " ")
    .replace(/\s+(on|this|next)\s*$/i, " ")
    .replace(/\s+on\s+/gi, " ")
    .replace(/[\s,;-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const at = /\s(?:at|@)\s/i.exec(rest);
  if (!at) {
    const inCity = /^(.*?)\s+in\s+(.+)$/i.exec(rest);
    if (inCity) return withFields({ artist: inCity[1]!, city: inCity[2]!, date: date ?? null });
    return withFields({ artist: rest, date: date ?? null });
  }
  const artist = rest.slice(0, at.index);
  const place = rest.slice(at.index + at[0].length);
  let venue = place;
  let city: string | undefined;
  const inCity = /^(.*?)\s+in\s+(.+)$/i.exec(place);
  if (inCity) {
    venue = inCity[1]!;
    city = inCity[2]!;
  } else {
    const comma = place.indexOf(",");
    if (comma > 0) {
      venue = place.slice(0, comma);
      city = place.slice(comma + 1);
    }
  }
  return withFields({
    artist,
    venue: venue.replace(/[\s,]+$/g, ""),
    city: city ? city.replace(/^[\s,]+|[\s,]+$/g, "") : null,
    date: date ?? null,
  });
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------

export function buildParseRequest(text: string, today?: string): MessageCreateParamsNonStreaming {
  const ref = validIsoDate(today);
  return {
    model: MODEL,
    max_tokens: PARSE_MAX_TOKENS,
    system: [{ type: "text", text: PARSE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content:
          `<query>\n${text.slice(0, MAX_QUERY_CHARS)}\n</query>\n` +
          (ref ? `Reference date: ${ref}` : "No reference date is given."),
      },
    ],
    output_config: { effort: PARSE_EFFORT, format: jsonOutputFormat(ShowQuerySchema) },
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS_MODE,
  };
}

export async function parseShowQuery(text: string, opts: ParseShowQueryOptions = {}): Promise<ParsedShowQuery> {
  const heuristic = (reason: string, usage: CallUsage | null = null, ledgerRefs: string[] = []): ParsedShowQuery => ({
    ...heuristicShowQuery(text),
    source: "heuristic",
    reason,
    usage,
    ledgerRefs,
  });
  if (!text.trim()) return heuristic("empty query");
  const client = opts.client ?? null;
  if (!client) return heuristic("llm_off");
  if (opts.spend && !(await opts.spend.canSpend(opts.reserveUsd ?? 0))) return heuristic("over_budget");

  const outcome = await callModel(
    { client, spend: opts.spend, ledger: opts.ledger, purpose: "parse show query" },
    { ...buildParseRequest(text, opts.today), ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}) },
  );
  const refs = outcome.ledgerRef ? [outcome.ledgerRef] : [];
  if (!outcome.ok) return heuristic("api_error", null, refs);
  const usage = usageFromMessage(outcome.message, outcome.costUsd);
  if (outcome.message.stop_reason === "refusal") return heuristic("refusal", usage, refs);

  const parsed = parseJsonWith(ShowQuerySchema, finalText(outcome.message.content));
  if (!parsed || !clean(parsed.artist)) return heuristic("parse_failed", usage, refs);
  return { ...withFields(parsed), source: "llm", usage, ledgerRefs: refs };
}
