/**
 * The response envelope every tool returns, the same one the web app's JSON API
 * serves (apps/web/lib/api.ts): status, summary, planId, sheetUrl, planUrl,
 * mode, results, resolution, cards, reason, provenance, limits; a revision adds
 * revision and parentPlanId in both; paused plans add pending. Built from a
 * sheet, a paused plan or a refusal.
 */
import { buyersLimit, LIMITS_EVERY_SHEET, withoutControl, type Candidate, type EnvelopeStatus, type Resolution, type SheetRevision, type StreetSheet, type StreetSheetCards } from "@walkup/contracts";
import { FIXTURE_LIMITS } from "@walkup/orchestrator";

/**
 * "recorded": the server serves sheets recorded from live Qloo and Ticketmaster runs, and live runs are paused
 * (for judging). Its refusals carry it, and so does the envelope of a live sheet it serves (the sheet itself keeps
 * mode "live").
 */
export type PlanMode = "live" | "fixture" | "recorded";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A recorded sheet's day, "Oct 21 2026" style (UTC), from its createdAt; null when the timestamp does not parse. */
export function recordedDay(createdAt: string | null | undefined): string | null {
  const at = typeof createdAt === "string" ? new Date(createdAt) : null;
  if (!at || !Number.isFinite(at.getTime())) return null;
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()} ${at.getUTCFullYear()}`;
}

export interface PendingPick {
  input: string;
  candidates: Candidate[];
}

export interface ToolEnvelope<T = unknown> {
  status: EnvelopeStatus;
  /** One short sentence. */
  summary: string;
  planId: string | null;
  /** Share link (/s/<planId>; the plan page while it waits for a pick). Null when the server does not know its public origin. */
  sheetUrl: string | null;
  /** The interactive plan page (/plan/<planId>). */
  planUrl?: string | null;
  mode: PlanMode;
  results: T | null;
  /** Resolution rows; needs_input candidates live here. */
  resolution: Resolution[];
  /** Status of each card, in stream order (sheets only). */
  cards?: Partial<Record<keyof StreetSheetCards, EnvelopeStatus>>;
  /** Names waiting for a pick, with their candidates (paused plans only). */
  pending?: PendingPick[];
  /** Why status is not "ok". */
  reason?: string;
  /** Ledger ids (Q#, T#, P#, L#, A#) behind this result. */
  provenance: string[];
  /** "What this does not establish". */
  limits: string[];
  /** Fresh runs left today, shown whenever a fresh run was considered. */
  freshRuns?: { leftForCaller: number; leftToday: number };
  /** revise_plan: what was asked, who read it, the tools chosen and what changed. */
  revision?: SheetRevision;
  /** revise_plan: the plan this one revises. */
  parentPlanId?: string;
  /** revise_plan: the question to put to the user when the note was unclear (nothing changed). */
  question?: string;
}

export const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const STATUS_RANK: Record<EnvelopeStatus, number> = { error: 5, needs_input: 4, degraded: 3, partial: 2, empty: 1, ok: 0 };

/** The most severe of several card statuses ("empty" never outranks a card with results). */
export function worstStatus(statuses: EnvelopeStatus[]): EnvelopeStatus {
  let worst: EnvelopeStatus = "ok";
  for (const s of statuses) if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  if (worst === "empty" && statuses.some((s) => s === "ok")) return "ok";
  return worst;
}

/**
 * One status for a whole sheet (as the web app computes it): needs_input while
 * the resolution card waits for a pick; error when any card errored; degraded
 * when any card fell back to a weaker method; partial when any card is
 * incomplete; ok otherwise. Empty cards do not lower it.
 */
export function sheetStatus(sheet: StreetSheet): EnvelopeStatus {
  const statuses = Object.values(sheet.cards).map((c) => c.status);
  if (sheet.cards.resolution.status === "needs_input") return "needs_input";
  if (statuses.includes("error")) return "error";
  if (statuses.includes("degraded")) return "degraded";
  if (statuses.includes("partial")) return "partial";
  return "ok";
}

/** The reason of the first card (in stream order) whose status matches the sheet's. */
function rollupReason(sheet: StreetSheet, status: EnvelopeStatus): string | undefined {
  if (status === "ok") return undefined;
  const cards = Object.values(sheet.cards);
  const exact = cards.find((c) => c.status === status && c.reason);
  return (exact ?? cards.find((c) => c.status !== "ok" && c.status !== "empty" && c.reason))?.reason;
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export function sheetUrlFor(origin: string | null | undefined, planId: string): string | null {
  return origin ? `${trimOrigin(origin)}/s/${encodeURIComponent(planId)}` : null;
}

export function planUrlFor(origin: string | null | undefined, planId: string): string | null {
  return origin ? `${trimOrigin(origin)}/plan/${encodeURIComponent(planId)}` : null;
}

export function actsLine(sheet: Pick<StreetSheet, "bill">): string {
  return sheet.bill.acts.map((a) => a.name).join(", ");
}

export function cardStatuses(sheet: StreetSheet): Partial<Record<keyof StreetSheetCards, EnvelopeStatus>> {
  return Object.fromEntries(Object.entries(sheet.cards).map(([k, c]) => [k, c.status])) as Partial<Record<keyof StreetSheetCards, EnvelopeStatus>>;
}

/**
 * The envelope for a finished Street Sheet (results = the whole sheet, ledger included). `recorded`: the server
 * serves recorded sheets only, so a live sheet's envelope says mode "recorded". An older stored sheet's Google
 * Places list is dropped (withoutControl): the product no longer shows it.
 */
export function sheetEnvelope(stored: StreetSheet, origin: string | null, opts: { recorded?: boolean } = {}): ToolEnvelope<StreetSheet> {
  const sheet = withoutControl(stored);
  const recorded = opts.recorded === true && sheet.mode === "live";
  const status = sheetStatus(sheet);
  const reason = rollupReason(sheet, status);
  return {
    status,
    summary: sheet.narration?.summary ?? `Street Sheet for ${actsLine(sheet)} at ${sheet.bill.venue.name}.`,
    planId: sheet.planId,
    sheetUrl: sheetUrlFor(origin, sheet.planId),
    planUrl: planUrlFor(origin, sheet.planId),
    mode: recorded ? "recorded" : sheet.mode,
    results: sheet,
    resolution: sheet.cards.resolution.results,
    cards: cardStatuses(sheet),
    ...(reason ? { reason } : {}),
    provenance: sheet.ledger.map((e) => e.id),
    limits: sheetLimits(sheet),
    // A revision says so up top, as its page does: the earlier plan, the note and what changed.
    ...(sheet.revision ? { revision: sheet.revision, parentPlanId: sheet.revision.parentPlanId } : {}),
  };
}

/** A sheet's limits as the pages and the PDF say them: "Where buyers live" said of the map this sheet has (`buyersLimit`). */
export function sheetLimits(sheet: StreetSheet): string[] {
  return (sheet.limits ?? []).map((l) => buyersLimit(l, sheet));
}

/**
 * The bill heatmap the lift tiles came from, as partners.csv and the calendar cite it: the widened one when the search
 * widened to 60 km (its ledger note says so), else the first heat request. The first request is set aside then.
 */
export function liftHeatRef(sheet: Pick<StreetSheet, "cards" | "ledger">): string | undefined {
  const prov = sheet.cards.liftMap.provenance;
  const notes = new Map((sheet.ledger ?? []).map((e) => [e.id, e.note ?? ""]));
  return prov.find((id) => /\bbill heat \(widened\b/.test(notes.get(id) ?? "")) ?? prov[0];
}

export function baseLimits(mode: PlanMode): string[] {
  return mode === "fixture" ? [...LIMITS_EVERY_SHEET, ...FIXTURE_LIMITS] : [...LIMITS_EVERY_SHEET];
}

/** What a paused plan needs for its envelope (the orchestrator's PausedPlan has more). */
export interface PauseLike {
  resolution: { summary: string; results: Resolution[]; reason?: string; provenance: string[] };
  pending: PendingPick[];
}

/** A plan paused on ambiguous names: candidates in `pending` and `resolution`, no results yet. */
export function pausedEnvelope(planId: string, pause: PauseLike, mode: PlanMode, origin: string | null = null): ToolEnvelope<null> {
  const names = pause.pending.map((p) => `"${p.input}"`).join(", ");
  return {
    status: "needs_input",
    summary: pause.resolution.summary || `${names} need${pause.pending.length === 1 ? "s" : ""} a pick before the plan can run.`,
    planId,
    sheetUrl: planUrlFor(origin, planId),
    planUrl: planUrlFor(origin, planId),
    mode,
    results: null,
    resolution: pause.resolution.results,
    pending: pause.pending,
    reason: pause.resolution.reason ?? `Pick the right entity for ${names} to continue.`,
    provenance: [...pause.resolution.provenance],
    limits: baseLimits(mode),
  };
}

export interface ErrorExtras {
  planId?: string | null;
  provenance?: string[];
  resolution?: Resolution[];
  freshRuns?: { leftForCaller: number; leftToday: number };
}

/** A refusal or failure, in the same envelope (status "error", results null). */
export function errorEnvelope(reason: string, mode: PlanMode, extras: ErrorExtras = {}): ToolEnvelope<null> {
  return {
    status: "error",
    summary: reason,
    planId: extras.planId ?? null,
    sheetUrl: null,
    mode,
    results: null,
    resolution: extras.resolution ?? [],
    reason,
    provenance: extras.provenance ?? [],
    limits: baseLimits(mode),
    ...(extras.freshRuns ? { freshRuns: extras.freshRuns } : {}),
  };
}

/**
 * Env vars whose values must never leave the server. GOOGLE_PLACES_API_KEY is no longer read (Places was removed
 * from the product); it stays here so an older deploy that still sets it never echoes it.
 */
export const SECRET_ENV_VARS = [
  "QLOO_API_KEY",
  "TICKETMASTER_API_KEY",
  "GOOGLE_PLACES_API_KEY",
  "CENSUS_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENROUTER_API_KEY",
  "RESEND_API_KEY",
  "WALKUP_SIGNING_SECRET",
  "WALKUP_OPERATOR_TOKEN",
] as const;

export interface Secret {
  name: string;
  value: string;
}

/** Secret values present in an environment (8+ characters; shorter values are not credentials). */
export function secretsFromEnv(env: Record<string, string | undefined>): Secret[] {
  const out: Secret[] = [];
  for (const name of SECRET_ENV_VARS) {
    const value = env[name]?.trim();
    if (value && value.length >= 8) out.push({ name, value });
  }
  return out;
}

/**
 * Last line of defence: every secret value anywhere in a JSON-safe value is
 * replaced by its env reference ("$QLOO_API_KEY"). Ledgers already hold only
 * references; this catches anything a dependency might echo (an error message).
 */
export function scrubSecrets<T>(value: T, secrets: readonly Secret[]): T {
  if (secrets.length === 0) return value;
  const json = JSON.stringify(value);
  if (json === undefined) return value;
  let out = json;
  for (const s of secrets) {
    // Match the value as it appears inside a JSON string.
    const encoded = JSON.stringify(s.value).slice(1, -1);
    out = out.split(encoded).join(`$${s.name}`);
  }
  return out === json ? value : (JSON.parse(out) as T);
}

export function scrubText(text: string, secrets: readonly Secret[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s.value).join(`$${s.name}`);
  return out;
}
