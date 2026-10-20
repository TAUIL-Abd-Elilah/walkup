/**
 * Arm F, the fair control: the same model with Google Places text search and
 * Census ACS lookups instead of Qloo. The model picks its own queries and
 * returns a ranked list through the strict `submit_ranking` tool. Only place
 * ids it actually received from places_search survive; others are dropped and
 * counted.
 *
 * Manual loop: strict tools, tool_choice auto (forced choice is a 400 on this
 * model), effort medium, at most 8 model turns, every tool_result of a turn in
 * ONE user message, failures returned with is_error rather than dropped.
 */
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Bill, ControlArmResult, ControlPlace, GeoPoint, OperatorInputs } from "@walkup/contracts";
import { z } from "zod";
import { callModel, mergeUsage, toolUses, usageFromMessage } from "./client";
import {
  CONTROL_EFFORT,
  CONTROL_MAX_ITERATIONS,
  CONTROL_MAX_PLACES,
  DEFAULT_MAX_TOKENS,
  FALLBACK_BETA,
  FALLBACKS_MODE,
  MODEL,
  PLACES_PER_QUERY,
} from "./constants";
import { displayDate } from "./facts";
import { overlapNames, type OverlapCandidate } from "./overlap";
import { CONTROL_SYSTEM_PROMPT } from "./prompts";
import type { CallUsage, LlmOptions } from "./types";

// ---------------------------------------------------------------------------
// Inputs and injected tools
// ---------------------------------------------------------------------------

export interface ControlArmInput {
  bill: Bill;
  operator: OperatorInputs;
  /** Search center (normally the venue). */
  center: GeoPoint;
  radiusM: number;
  /** The partner categories the Qloo arm searched (e.g. "record_store"), so both arms get the same inputs. */
  categories?: string[];
}

/** One Places hit as the places package returns it (query is added here). */
export type PlacesSearchHit = Omit<ControlPlace, "query"> & {
  openingHours?: string[] | null;
  types?: string[] | null;
};

export type PlacesSearchResponse = PlacesSearchHit[] | { places: PlacesSearchHit[]; ledgerRef?: string };

export type AcsQuery = { zcta: string } | { point: GeoPoint };

export interface ControlArmTools {
  placesSearch(query: string, center: GeoPoint, radiusM: number): Promise<PlacesSearchResponse>;
  /** Returns JSON-serializable ACS figures. */
  acsLookup(query: AcsQuery): Promise<unknown>;
}

export interface ControlArmOptions extends LlmOptions {
  /** Default and hard maximum: 8 model turns. */
  maxIterations?: number;
  /** Qloo partners to compute overlapWithQloo against. */
  qlooPartners?: OverlapCandidate[];
}

export type ControlArmStatus =
  | "ok"
  | "no_ranking"
  | "iteration_limit"
  | "refused"
  | "over_budget"
  | "llm_off"
  | "api_error";

export interface ControlArmRun extends ControlArmResult {
  status: ControlArmStatus;
  /** Ranked entries whose place_id never came back from places_search. */
  droppedUnseen: number;
  droppedIds: string[];
  /** Model turns used. */
  iterations: number;
  /** Queries the model chose, in call order. */
  queries: string[];
  toolErrors: number;
  /** Reasons the model gave, keyed by place id (kept places only). */
  reasons: Record<string, string>;
  usage: CallUsage | null;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Tool definitions (strict; frozen so the cached prefix is stable)
// ---------------------------------------------------------------------------

const nullable = (type: "string" | "number", description: string) => ({
  anyOf: [{ type }, { type: "null" }],
  description,
});

export const CONTROL_TOOLS: BetaTool[] = [
  {
    name: "places_search",
    description:
      "Text search for places near the venue (Google Places). The center and radius are fixed for this run. " +
      "Returns up to 20 places with place_id, name, address, rating, user_rating_count, business_status, location and opening hours.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'What to search for, e.g. "record store East Nashville" or "soul food restaurant Norfolk".',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "acs_lookup",
    description:
      "Census ACS 5-year figures (adults, median age, density) for one ZCTA or one point. " +
      "Pass zcta with lat and lon null, or lat and lon with zcta null.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        zcta: nullable("string", "5-digit ZCTA, or null when passing a point."),
        lat: nullable("number", "Latitude, or null when passing a ZCTA."),
        lon: nullable("number", "Longitude, or null when passing a ZCTA."),
      },
      required: ["zcta", "lat", "lon"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_ranking",
    description:
      "Submit the final ranked list, best first, at most 20 places. Use only place_id values returned by places_search. Call once, at the end.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        places: {
          type: "array",
          items: {
            type: "object",
            properties: {
              place_id: { type: "string", description: "A place_id returned by places_search." },
              reason: { type: "string", description: "One short, factual reason." },
            },
            required: ["place_id", "reason"],
            additionalProperties: false,
          },
        },
      },
      required: ["places"],
      additionalProperties: false,
    },
  },
];

// Runtime validation of tool inputs (strict mode guarantees shape on the real
// API; this also covers mocks and malformed inputs).
const PlacesSearchInput = z.object({ query: z.string().trim().min(1).max(200) });
const AcsLookupInput = z.object({
  zcta: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
});
const SubmitRankingInput = z.object({
  places: z.array(z.object({ place_id: z.string(), reason: z.string() })),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function ageLine(bill: Bill): string {
  if (bill.legalAgeEnforced === true) return "21+ (from the ticketing age policy)";
  if (bill.legalAgeEnforced === false) return "all ages (from the ticketing age policy)";
  return "unknown";
}

/** The per-run task, shared by arms F and L. Data only; the instructions live in the system prompt. */
export function renderShowBlock(input: ControlArmInput): string {
  const { bill, operator } = input;
  const show = {
    acts: bill.acts.map((a) => ({ name: a.name, role: a.role })),
    venue: { name: bill.venue.name, city: bill.venue.city, state: bill.venue.state ?? null },
    date: bill.date,
    when: displayDate(bill.weekday, bill.date),
    classification: bill.classification ?? null,
    agePolicy: ageLine(bill),
    searchCenter: input.center,
    radiusM: Math.round(input.radiusM),
    ...(input.categories && input.categories.length > 0 ? { categories: input.categories } : {}),
    operator: {
      seatsLeftWhatIf: operator.seatsLeft,
      capacity: operator.capacity,
      streetTeamDays: operator.streetTeamDays,
      declaredPartners: operator.declaredPartners.map((p) => p.label),
      alreadyReachedZips: operator.alreadyReachedZips ?? [],
    },
  };
  return `<show>\n${JSON.stringify(show, null, 1)}\n</show>`;
}

function renderControlTask(input: ControlArmInput): string {
  return (
    `${renderShowBlock(input)}\n\n` +
    "Find up to 20 real places near the venue where this bill's audience is likely to spend time, " +
    "search with places_search, then call submit_ranking with your ranked list."
  );
}

const REPROMPT = "Call submit_ranking now with your ranked list of place_id values from places_search.";
const LAST_TURN = "One model turn is left: call submit_ranking next with your ranked list.";

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function emptyRun(status: ControlArmStatus, notes: string[] = []): ControlArmRun {
  return {
    arm: "F",
    places: [],
    overlapWithQloo: [],
    ledgerRefs: [],
    status,
    droppedUnseen: 0,
    droppedIds: [],
    iterations: 0,
    queries: [],
    toolErrors: 0,
    reasons: {},
    usage: null,
    notes,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runControlArm(
  input: ControlArmInput,
  tools: ControlArmTools,
  opts: ControlArmOptions = {},
): Promise<ControlArmRun> {
  const client = opts.client ?? null;
  if (!client) return emptyRun("llm_off", ["LLM is off; the control arm did not run."]);

  const maxIterations = Math.max(1, Math.min(opts.maxIterations ?? CONTROL_MAX_ITERATIONS, CONTROL_MAX_ITERATIONS));
  const run = emptyRun("iteration_limit");
  const seen = new Map<string, ControlPlace>();
  const messages: BetaMessageParam[] = [{ role: "user", content: renderControlTask(input) }];
  let ranking: { place_id: string; reason: string }[] | null = null;
  let reprompted = false;

  const baseParams: Omit<MessageCreateParamsNonStreaming, "messages"> = {
    model: MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: [{ type: "text", text: CONTROL_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: CONTROL_TOOLS,
    tool_choice: { type: "auto" },
    output_config: { effort: CONTROL_EFFORT },
    betas: [FALLBACK_BETA],
    fallbacks: FALLBACKS_MODE,
  };

  /**
   * Places hits per tool_use, merged into `seen` (and their ledger refs into the
   * run) in tool_use order after the turn's calls settle, so a place returned by
   * two parallel searches always keeps the query that came first.
   */
  type SearchBatch = { query: string; hits: PlacesSearchHit[]; ledgerRef: string | null };

  async function execute(tu: BetaToolUseBlock, batches: Map<string, SearchBatch>): Promise<BetaToolResultBlockParam> {
    const fail = (msg: string): BetaToolResultBlockParam => {
      run.toolErrors += 1;
      return { type: "tool_result", tool_use_id: tu.id, content: msg, is_error: true };
    };
    try {
      if (tu.name === "places_search") {
        const parsed = PlacesSearchInput.safeParse(tu.input);
        if (!parsed.success) return fail("places_search needs a non-empty query string.");
        const query = parsed.data.query;
        run.queries.push(query);
        const res = await tools.placesSearch(query, input.center, input.radiusM);
        const hits = (Array.isArray(res) ? res : res.places).slice(0, PLACES_PER_QUERY);
        batches.set(tu.id, { query, hits, ledgerRef: !Array.isArray(res) && res.ledgerRef ? res.ledgerRef : null });
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({
            query,
            results: hits.map((h) => ({
              place_id: h.placeId,
              name: h.name,
              address: h.address ?? null,
              rating: h.rating ?? null,
              user_rating_count: h.userRatingCount ?? null,
              business_status: h.businessStatus ?? null,
              location: h.location ?? null,
              opening_hours: h.openingHours ?? null,
              types: h.types ?? null,
            })),
          }),
        };
      }
      if (tu.name === "acs_lookup") {
        const parsed = AcsLookupInput.safeParse(tu.input);
        if (!parsed.success) return fail("acs_lookup needs zcta, lat and lon (use null for the unused ones).");
        const { zcta, lat, lon } = parsed.data;
        let q: AcsQuery;
        if (zcta && /^\d{5}$/.test(zcta.trim())) q = { zcta: zcta.trim() };
        else if (lat !== null && lon !== null) q = { point: { lat, lon } };
        else return fail("acs_lookup needs a 5-digit zcta, or lat and lon.");
        const data = await tools.acsLookup(q);
        return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(data ?? null) };
      }
      return fail(`Unknown tool "${tu.name}". Available: places_search, acs_lookup, submit_ranking.`);
    } catch (err) {
      return fail(`${tu.name} failed: ${errorMessage(err)}`);
    }
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    if (opts.spend && !(await opts.spend.canSpend(opts.reserveUsd ?? 0))) {
      run.status = "over_budget";
      run.notes.push("Daily model spend cap reached; the loop stopped.");
      break;
    }
    const outcome = await callModel(
      { client, spend: opts.spend, ledger: opts.ledger, purpose: `arm F turn ${iter + 1}` },
      { ...baseParams, messages },
    );
    if (outcome.ledgerRef) run.ledgerRefs.push(outcome.ledgerRef);
    if (!outcome.ok) {
      run.status = "api_error";
      run.notes.push(outcome.error);
      break;
    }
    run.iterations += 1;
    const { message } = outcome;
    run.usage = mergeUsage(run.usage, usageFromMessage(message, outcome.costUsd));

    if (message.stop_reason === "refusal") {
      run.status = "refused";
      const cat = message.stop_details?.category;
      run.notes.push(`The model declined${cat ? ` (${cat})` : ""}.`);
      break;
    }

    // Echo the assistant turn back unchanged (thinking blocks included).
    messages.push({ role: "assistant", content: message.content });
    const uses = toolUses(message.content);

    const submit = uses.find((u) => u.name === "submit_ranking");
    if (submit) {
      const parsed = SubmitRankingInput.safeParse(submit.input);
      if (parsed.success) {
        ranking = parsed.data.places;
        run.status = "ok";
        break;
      }
      // Malformed submission: answer every tool_use of the turn, flag this one.
    }

    if (uses.length === 0) {
      if (message.stop_reason === "pause_turn") continue;
      if (!reprompted) {
        reprompted = true;
        messages.push({ role: "user", content: REPROMPT });
        continue;
      }
      run.status = "no_ranking";
      run.notes.push("The model ended without calling submit_ranking.");
      break;
    }
    // Last allowed turn and still searching: do not spend tool quota on results nobody will read.
    if (iter === maxIterations - 1) break;

    const batches = new Map<string, SearchBatch>();
    const results = await Promise.all(
      uses.map((u) => {
        if (u.name !== "submit_ranking") return execute(u, batches);
        run.toolErrors += 1;
        return Promise.resolve<BetaToolResultBlockParam>({
          type: "tool_result",
          tool_use_id: u.id,
          content: "submit_ranking input did not match its schema: places must be [{place_id, reason}].",
          is_error: true,
        });
      }),
    );
    for (const u of uses) {
      const b = batches.get(u.id);
      if (!b) continue;
      if (b.ledgerRef) run.ledgerRefs.push(b.ledgerRef);
      for (const h of b.hits) {
        if (!h.placeId || seen.has(h.placeId)) continue;
        seen.set(h.placeId, {
          placeId: h.placeId,
          name: h.name,
          ...(h.address !== undefined ? { address: h.address } : {}),
          ...(h.rating !== undefined ? { rating: h.rating } : {}),
          ...(h.userRatingCount !== undefined ? { userRatingCount: h.userRatingCount } : {}),
          ...(h.businessStatus !== undefined ? { businessStatus: h.businessStatus } : {}),
          ...(h.location !== undefined ? { location: h.location } : {}),
          query: b.query,
        });
      }
    }
    const content: BetaContentBlockParam[] = [...results];
    if (iter === maxIterations - 2) content.push({ type: "text", text: LAST_TURN });
    // All results of this turn in ONE user message.
    messages.push({ role: "user", content });
  }

  if (ranking) {
    const used = new Set<string>();
    for (const r of ranking) {
      if (run.places.length >= CONTROL_MAX_PLACES) break;
      const place = seen.get(r.place_id);
      if (!place) {
        run.droppedUnseen += 1;
        run.droppedIds.push(r.place_id);
        continue;
      }
      if (used.has(r.place_id)) continue;
      used.add(r.place_id);
      run.places.push(place);
      run.reasons[r.place_id] = r.reason;
    }
    if (run.droppedUnseen > 0) {
      run.notes.push(`${run.droppedUnseen} ranked place id(s) never came back from places_search and were dropped.`);
    }
  } else if (run.status === "iteration_limit") {
    run.notes.push(`No ranking after ${maxIterations} model turns.`);
  }

  if (opts.qlooPartners && run.places.length > 0) {
    run.overlapWithQloo = overlapNames(opts.qlooPartners, run.places);
  }
  return run;
}
