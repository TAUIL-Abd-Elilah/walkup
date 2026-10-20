/**
 * Harness for the product eval: fixture-world deps with a fixed clock, a tap
 * that records every string the Qloo transport returned (the ID validator's
 * ground truth), world variants for the edge cases the scenario knobs do not
 * cover, a preset runner that answers a needs_input pause the way an operator
 * would and a mock narrator model.
 *
 * Nothing here reaches the network: every transport is @walkup/qloo-world.
 */
import type { HeatCell } from "@walkup/contracts";
import { computeLiftAll } from "@walkup/engine";
import type { NarratorClient } from "@walkup/narrator";
import {
  createFixtureDeps,
  planShow,
  type FixtureDeps,
  type FixtureDepsOptions,
  type PlanOptions,
  type PlanRequest,
  type PlanResult,
} from "@walkup/orchestrator";
import { normalizeHeatmap } from "@walkup/qloo";
import { createWorld, WORLD_TAG_PINS, type FetchLike, type Scenario, type World } from "@walkup/qloo-world";

/** Planning clock for every fixture run (the presets' asOf dates are earlier). */
export const EVAL_CLOCK_MS = Date.parse("2026-10-30T15:00:00Z");

// ---------------------------------------------------------------------------
// ID tap: every string value in every Qloo response body of one case
// ---------------------------------------------------------------------------

export interface IdTap {
  /** Every string value seen in a Qloo response body (ids, tag ids, names). */
  strings: Set<string>;
  /** Qloo responses read. */
  responses: number;
}

export function newTap(): IdTap {
  return { strings: new Set<string>(), responses: 0 };
}

function collectStrings(v: unknown, out: Set<string>): void {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v as Record<string, unknown>)) collectStrings(x, out);
}

/** Wraps the world's Qloo transport so every body it returns is recorded in `tap`. */
export function tapQloo(world: World, tap: IdTap): World {
  const qlooFetch: FetchLike = async (url, init) => {
    const res = await world.qlooFetch(url, init);
    try {
      collectStrings(await res.clone().json(), tap.strings);
      tap.responses++;
    } catch {
      // Not JSON: nothing to record (the client reports it as an error).
    }
    return res;
  };
  return { ...world, qlooFetch };
}

// ---------------------------------------------------------------------------
// World variants
// ---------------------------------------------------------------------------

function isHeatmap(u: URL): boolean {
  return u.pathname === "/v2/insights" && u.searchParams.get("filter.type") === "urn:heatmap";
}

/**
 * Lift that tracks raw foot traffic. The generic heatmap (Q6, the diagnostic's
 * raw heat) is rewritten so each cell's affinity is the lift of its geohash-6
 * tile, computed by the engine from the bill and house heatmaps this run
 * already received. Spearman(lift, raw heat) is then 1, above the 0.9 bar.
 */
export function liftWeakVariant(world: World): World {
  const entityHeat: { key: string; cells: HeatCell[] }[] = [];
  const qlooFetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (!isHeatmap(u)) return world.qlooFetch(url, init);
    const res = await world.qlooFetch(url, init);
    if (!res.ok) return res;
    if (u.searchParams.has("signal.interests.entities")) {
      if (!entityHeat.some((h) => h.key === u.search)) entityHeat.push({ key: u.search, cells: normalizeHeatmap(await res.clone().json()).value });
      return res;
    }
    if (u.searchParams.get("signal.interests.tags") !== WORLD_TAG_PINS.genericHeatTag || entityHeat.length < 2) return res;
    // Bill heat (possibly widened) comes first, the house heat right after it.
    const bill = entityHeat[entityHeat.length - 2]?.cells ?? [];
    const house = entityHeat[entityHeat.length - 1]?.cells ?? [];
    const lift = new Map(computeLiftAll(bill, house).map((t) => [t.geohash, t.lift]));
    const max = Math.max(1e-9, ...lift.values());
    const body = (await res.clone().json()) as { results?: { heatmap?: { location?: { geohash?: string }; query?: Record<string, number> }[] } };
    for (const row of body.results?.heatmap ?? []) {
      const gh = (row.location?.geohash ?? "").slice(0, 6);
      if (row.query) row.query.affinity = Math.round(((lift.get(gh) ?? 0) / max) * 1e6) / 1e6;
    }
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  };
  return { ...world, qlooFetch };
}

/** The house-set heatmap (any entity heatmap after the bill's) answers HTTP 500. */
export function failingHouseHeatVariant(world: World): World {
  let billHeat: string | null = null;
  const qlooFetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    if (isHeatmap(u) && u.searchParams.has("signal.interests.entities")) {
      billHeat ??= u.search;
      if (u.search !== billHeat) {
        return new Response(JSON.stringify({ synthetic: true, error: { message: "synthetic failure" } }), {
          status: 500,
          headers: { "content-type": "application/json", "x-walkup-world": "synthetic" },
        });
      }
    }
    return world.qlooFetch(url, init);
  };
  return { ...world, qlooFetch };
}

// ---------------------------------------------------------------------------
// Deps and runs
// ---------------------------------------------------------------------------

export interface EvalRig {
  deps: FixtureDeps;
  /** The world the pipeline sees (variants and the tap applied). */
  world: World;
  tap: IdTap;
}

export interface RigOptions extends Omit<FixtureDepsOptions, "world" | "clock" | "idGen"> {
  scenario?: Partial<Scenario>;
  /** Wraps the base world before the tap (edge-case variants). */
  variant?: (w: World) => World;
  /** Plan id prefix (counter ids keep runs deterministic). */
  idPrefix?: string;
}

/** Fixture deps on a fresh world: fixed clock, counter plan ids, every Qloo body tapped. */
export function newRig(o: RigOptions = {}): EvalRig {
  const { scenario, variant, idPrefix, ...rest } = o;
  const base = createWorld(scenario ? { scenario } : {});
  const tap = newTap();
  const world = tapQloo(variant ? variant(base) : base, tap);
  let n = 0;
  const prefix = idPrefix ?? "plan";
  const deps = createFixtureDeps({ ...rest, world, clock: () => EVAL_CLOCK_MS, idGen: () => `${prefix}-${++n}` });
  return { deps, world, tap };
}

export interface PresetRun {
  /** The first answer: needs_input when the run paused. */
  first: PlanResult;
  /** The answer after the operator's pick (same object as first when no pause). */
  final: PlanResult;
  /** Candidate the operator picked per paused name. */
  picks: Record<string, string>;
}

/**
 * Runs a plan request; a needs_input pause is resumed with the candidate an
 * operator would pick (the person entity, i.e. the comedian, else the first).
 */
export async function runWithPick(request: PlanRequest, deps: FixtureDeps, opts: PlanOptions = {}): Promise<PresetRun> {
  const first = await planShow(request, deps, opts);
  if (first.status !== "needs_input" || !first.pause) return { first, final: first, picks: {} };
  const picks: Record<string, string> = {};
  for (const p of first.pause.pending) {
    const pick = p.candidates.find((c) => c.subtype === "urn:entity:person") ?? p.candidates[0];
    if (pick) picks[p.input] = pick.entityId;
  }
  const final = await planShow({ ...request, resolutions: { ...request.resolutions, ...picks }, planId: first.planId }, deps, opts);
  return { first, final, picks };
}

// ---------------------------------------------------------------------------
// Mock narrator model
// ---------------------------------------------------------------------------

export interface RunFacts {
  tiles: { geohash: string; name: string | null }[];
  partners: { entityId: string; name: string }[];
  allowlistedTags: { id: string; name: string }[];
}

export interface MockDraft {
  summary: string;
  tileWhy: { geohash: string; text: string }[];
  partnerLines: { entityId: string; text: string }[];
  copyHooks: { text: string; tagIds: string[] }[];
}

type CreateFn = NarratorClient["beta"]["messages"]["create"];
type CreateParams = Parameters<CreateFn>[0];
type CreateReturn = Awaited<ReturnType<CreateFn>>;

function factsOf(params: CreateParams): RunFacts {
  const msg = params.messages[0];
  let text = "";
  if (typeof msg?.content === "string") text = msg.content;
  else if (Array.isArray(msg?.content)) {
    for (const b of msg.content) if (b && typeof b === "object" && "text" in b && typeof b.text === "string") text += b.text;
  }
  const m = /<run_facts>\n([\s\S]*)\n<\/run_facts>/.exec(text);
  const parsed = JSON.parse(m?.[1] ?? "{}") as Partial<RunFacts>;
  return { tiles: parsed.tiles ?? [], partners: parsed.partners ?? [], allowlistedTags: parsed.allowlistedTags ?? [] };
}

function message(text: string): CreateReturn {
  // Test-only literal with the fields the narrator reads; the SDK type has many more.
  return {
    id: "msg_eval",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as CreateReturn;
}

export interface MockModel {
  client: NarratorClient;
  calls(): number;
}

/** A narrator client that answers every request with `draft(facts)` as JSON text. */
export function mockModel(draft: (f: RunFacts) => MockDraft): MockModel {
  let calls = 0;
  const client: NarratorClient = {
    beta: {
      messages: {
        async create(params) {
          calls++;
          return message(JSON.stringify(draft(factsOf(params))));
        },
      },
    },
  };
  return { client, calls: () => calls };
}

/** A narrator client whose every call fails (the API is down). */
export function failingModel(): MockModel {
  let calls = 0;
  const client: NarratorClient = {
    beta: {
      messages: {
        async create() {
          calls++;
          throw new Error("synthetic API failure");
        },
      },
    },
  };
  return { client, calls: () => calls };
}
