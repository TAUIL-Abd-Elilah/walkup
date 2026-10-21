/**
 * Per-run state shared by the pipeline steps, plus small helpers: card
 * emission, error envelopes, citation tracking and the signal seeds.
 */
import type { Bill, Envelope, EnvelopeStatus, OperatorInputs, QlooEntity, StreetSheetCards } from "@walkup/contracts";
import { sanitizeEntityTags } from "@walkup/engine";
import { errorStatus, type QlooClient } from "@walkup/qloo";
import type { TmClient, TmEvent } from "@walkup/tm";
import type { NodeLevel, RunLedger } from "./ledger";
import type { TagPins } from "./tags";
import type { CardKey, GazetteerLike, NarratorDeps, PlanOptions, PlanRequest, ProbeFlags, SeedPlan } from "./types";

/** One entity in the bill's signal, with its role weight (internal only; Qloo gets plain ids). */
export interface Seed {
  entity: QlooEntity;
  /** Act name this seed stands for. */
  act: string;
  weight: number;
  kind: "act" | "proxy";
}

export interface HouseSet {
  ids: string[];
  weights: number[];
  /** "house" = roster headliners; "tag" = pinned genre tag; "none" = no baseline. */
  baseline: "house" | "tag" | "none";
  tag: string | null;
  rosterHeadliners: number;
  resolved: number;
  ledgerRefs: string[];
  roster: TmEvent[];
}

export interface RunContext {
  request: PlanRequest;
  options: PlanOptions;
  ledger: RunLedger;
  qloo: QlooClient;
  tm: TmClient | null;
  gazetteer: GazetteerLike;
  narrator: NarratorDeps;
  pins: TagPins;
  probes: ProbeFlags;
  mode: "live" | "fixture";
  now: () => number;
  planId: string;
  asOf: string;
  bill: Bill;
  operator: OperatorInputs;
  seeds: SeedPlan[];
  categories: string[] | null;
  cards: Partial<StreetSheetCards>;
  /** entityId -> ledger id of the call that returned it. */
  citations: Map<string, string>;
  /** Extra sheet limits (beyond LIMITS_EVERY_SHEET). */
  limits: string[];
  guardReasons: string[];
  /** Raw tags seen this run (before sanitizing), for the denied-tag receipt. */
  seenTags: { id: string; name: string; type?: string }[];
  personTagsStripped: boolean;
  thinSignal: boolean;
  /** Bill heat ledger ref (for tile chips). */
  billHeatRef: string | null;
}

export function node(ctx: RunContext, label: string, level: NodeLevel): void {
  ctx.ledger.node(label, level);
}

export function emit<K extends CardKey>(ctx: RunContext, key: K, env: StreetSheetCards[K]): void {
  ctx.cards[key] = env;
  try {
    ctx.options.onCard?.(key, env as Envelope<unknown>);
  } catch {
    // A failing listener (closed SSE stream) never breaks the run.
  }
}

export function envelope<T>(
  status: EnvelopeStatus,
  summary: string,
  results: T,
  provenance: string[],
  reason?: string,
  limits: string[] = [],
): Envelope<T> {
  const env: Envelope<T> = { status, summary, results, provenance: [...new Set(provenance.filter(Boolean))], limits };
  if (status !== "ok") env.reason = reason ?? summary;
  else if (reason) env.reason = reason;
  return env;
}

/** Envelope for a failed node: degraded for quota/fixture gaps, error otherwise. */
export function failure<T>(err: unknown, empty: T, summary: string): Envelope<T> {
  const s = errorStatus(err);
  const ref = s.ledgerRef ?? (err as { ledgerRef?: string } | null)?.ledgerRef;
  return envelope(s.status, summary, empty, ref ? [ref] : [], s.reason);
}

export function cite(ctx: RunContext, entities: readonly QlooEntity[], ledgerRef: string): void {
  for (const e of entities) if (e.entityId && !ctx.citations.has(e.entityId)) ctx.citations.set(e.entityId, ledgerRef);
}

/** Records raw tags for the receipt, then returns the entity safe to persist. */
export function clean(ctx: RunContext, e: QlooEntity): QlooEntity {
  for (const t of e.tags ?? []) ctx.seenTags.push({ id: t.id, name: t.name, ...(t.type ? { type: t.type } : {}) });
  const out = sanitizeEntityTags(e);
  if (e.subtype === "urn:entity:person" && (e.tags ?? []).length > 0) ctx.personTagsStripped = true;
  return out;
}

/**
 * Signal entities for Qloo: plain ids, never weighted objects. POST /v2/insights with
 * {entity, weight} returned 400 on Oct 15 (probe 14), so Seed.weight never leaves this process.
 */
export function signal(_ctx: RunContext, seeds: readonly Seed[]): string[] {
  return [...new Set(seeds.map((s) => s.entity.entityId))];
}

/** How many of the signal ids a call sent Qloo reported as not_found (meta.droppedSignals). */
export interface DroppedCheck {
  dropped: string[];
  /** "none": every id was used; "some": the answer rests on the others; "all": no signal was used. */
  share: "none" | "some" | "all";
}

/**
 * Reads meta.droppedSignals for the ids a call sent. Qloo ranks without an id it has no taste data
 * for and says so only in a top-level warning, so a list built on no usable id is general
 * popularity and must never be shown as ranked for the bill.
 */
export function droppedFrom(meta: { droppedSignals?: string[] } | undefined, sent: readonly string[]): DroppedCheck {
  const sentSet = new Set(sent);
  const dropped = [...new Set((meta?.droppedSignals ?? []).filter((id) => sentSet.has(id)))];
  if (dropped.length === 0 || sentSet.size === 0) return { dropped: [], share: "none" };
  return { dropped, share: dropped.length >= sentSet.size ? "all" : "some" };
}

/** Card line for a list built while Qloo ignored part or all of the bill's signal. */
export function droppedReason(check: DroppedCheck, call: string): string | null {
  if (check.share === "all") return `Qloo has no taste data for this bill's acts (${call}), so this list would only show general popularity.`;
  if (check.share === "some") return `Qloo has no taste data for ${plural(check.dropped.length, "of the names behind this bill", "of the names behind this bill")} (${call}), so this list rests on the others.`;
  return null;
}

export function seedIds(seeds: readonly Seed[]): string[] {
  return [...new Set(seeds.map((s) => s.entity.entityId))];
}

export function venuePoint(ctx: RunContext): { lat: number; lon: number } {
  return { lat: ctx.bill.venue.lat, lon: ctx.bill.venue.lon };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
