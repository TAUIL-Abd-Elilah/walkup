/**
 * Envelope helpers for the JSON API (the same shape the MCP tools and the agent
 * skill read): status, summary, planId, sheetUrl, mode, results, resolution,
 * reason, provenance, limits. Plus the browser helper for revisions
 * (`revisePlan`). This module imports no server code, so client components may
 * use it; server-only helpers live in lib/server/.
 */
import { LIMITS_EVERY_SHEET, withoutControl, type Candidate, type EnvelopeStatus, type Resolution, type SheetRevision, type StreetSheet } from "@walkup/contracts";

/** A JSON response that is never cached. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * One status for a whole sheet. needs_input when the resolution card waits for
 * a pick; error when any card errored; degraded when any card fell back to a
 * weaker method (tag baseline, tag diff, quota); partial when any card is
 * incomplete; ok otherwise. "empty" cards (nothing declared) do not lower it.
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

/**
 * `recorded`: the server serves recorded sheets only (live runs are paused), so a live sheet's envelope
 * says mode "recorded"; the sheet itself keeps mode "live". An older stored sheet's Google Places list is dropped.
 */
export function sheetEnvelope(stored: StreetSheet, origin: string, opts: { recorded?: boolean } = {}) {
  const sheet = withoutControl(stored);
  const status = sheetStatus(sheet);
  const reason = rollupReason(sheet, status);
  return {
    status,
    summary: sheet.narration?.summary ?? `Street Sheet for ${sheet.bill.acts.map((a) => a.name).join(", ")} at ${sheet.bill.venue.name}.`,
    planId: sheet.planId,
    sheetUrl: `${origin}/s/${sheet.planId}`,
    planUrl: `${origin}/plan/${sheet.planId}`,
    mode: opts.recorded && sheet.mode === "live" ? ("recorded" as const) : sheet.mode,
    results: sheet,
    resolution: sheet.cards.resolution.results,
    cards: Object.fromEntries(Object.entries(sheet.cards).map(([k, c]) => [k, c.status])),
    ...(reason ? { reason } : {}),
    provenance: sheet.ledger.map((e) => e.id),
    limits: sheet.limits,
  };
}

export interface PausedForEnvelope {
  planId: string;
  mode: "live" | "fixture";
  resolution: { summary: string; results: Resolution[]; reason?: string; provenance: string[] };
  pending: { input: string; candidates: Candidate[] }[];
}

/** A run waiting for the operator's pick: no sheet yet, candidates in `pending` and `resolution`. */
export function pausedEnvelope(p: PausedForEnvelope, origin: string) {
  return {
    status: "needs_input" as const,
    summary: p.resolution.summary,
    planId: p.planId,
    sheetUrl: `${origin}/plan/${p.planId}`,
    planUrl: `${origin}/plan/${p.planId}`,
    resolveUrl: `${origin}/api/plan/${p.planId}/resolve`,
    mode: p.mode,
    results: null,
    resolution: p.resolution.results,
    pending: p.pending,
    reason: p.resolution.reason ?? `Pick the right entity for ${p.pending.map((x) => `"${x.input}"`).join(", ")} to continue.`,
    provenance: p.resolution.provenance,
    limits: [...LIMITS_EVERY_SHEET],
  };
}

export function errorEnvelope(planId: string | null, mode: "live" | "fixture", reason: string) {
  return {
    status: "error" as const,
    summary: "The run stopped before a sheet was ready.",
    planId,
    mode,
    results: null,
    resolution: [],
    reason,
    provenance: [],
    limits: [...LIMITS_EVERY_SHEET],
  };
}

export const FIXTURE_FRESH_RUNS_REASON =
  "Fresh runs are disabled in fixture mode. Presets run on the synthetic fixture world: POST {\"presetId\": \"g1-a\"} (g1-a, g1-b, g2, g3), or open GET /api/sheet/<planId>.";

/** Every fresh path answers 503 with this in recorded state (mode "recorded"): the web API and MCP alike. */
export const RECORDED_REASON =
  "Live runs are paused for judging, so new plans, searches and revisions don't run here. The sheets recorded from live Qloo and Ticketmaster runs, and their downloads, still open.";

// ---------------------------------------------------------------------------
// Revisions: POST /api/plan/<id>/revise (browser helper)
// ---------------------------------------------------------------------------

/** 202: the revised run started (new plan id); cards and steps stream from streamUrl. */
export interface ReviseRunning {
  status: "running";
  summary: string;
  planId: string;
  parentPlanId: string;
  mode: "live" | "fixture";
  planUrl: string;
  streamUrl: string;
  sheetUrl: string;
  results: null;
  /** Who read the note and which tools they chose; `changes` stays empty until the sheet is ready. */
  revision: SheetRevision;
}

/** 200 with wait "complete": the revised sheet's envelope. `revision.changes` lists what changed. */
export type ReviseComplete = ReturnType<typeof sheetEnvelope> & { parentPlanId: string; revision: SheetRevision };

/** 200: the note was unclear. Nothing changed and nothing ran; show the question. */
export interface ReviseQuestion {
  status: "needs_input";
  summary: string;
  question: string;
  /** The parent's id (no new plan was made). */
  planId: string;
  parentPlanId: string;
  mode: "live" | "fixture";
  results: null;
  revision: SheetRevision;
  reason: string;
  provenance: string[];
}

export type ReviseResponse = ReviseRunning | ReviseComplete | ReviseQuestion;

export type ReviseOutcome =
  | { ok: true; httpStatus: number; body: ReviseResponse }
  /** 400 bad note, 404 unknown plan, 409 plan not finished, 422 run failed, 429 rate limit, 0 network error. */
  | { ok: false; httpStatus: number; reason: string };

export interface ReviseOptions {
  /** "complete" waits for the revised sheet (up to about 85 s); default "none" answers at once with the stream URL. */
  wait?: "complete" | "none";
  signal?: AbortSignal;
  /** Injected fetch (tests); default the global fetch. */
  fetchImpl?: typeof fetch;
  /** Origin to call; default same-origin ("" -> /api/...). */
  baseUrl?: string;
}

/**
 * Sends the operator's note about a finished sheet. Never throws: network and
 * HTTP failures come back as `{ok: false, reason}` with a sentence to show.
 */
export async function revisePlan(planId: string, instruction: string, opts: ReviseOptions = {}): Promise<ReviseOutcome> {
  if (!PLAN_ID_RE.test(planId)) return { ok: false, httpStatus: 400, reason: "That plan id is not valid." };
  const note = instruction.trim();
  if (!note) return { ok: false, httpStatus: 400, reason: "Type what to change first." };
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl ?? ""}/api/plan/${encodeURIComponent(planId)}/revise`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instruction: note, ...(opts.wait === "complete" ? { wait: "complete" } : {}) }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch {
    return { ok: false, httpStatus: 0, reason: "Couldn't reach the server. Check the connection and try again." };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const reason = body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string" ? (body as { reason: string }).reason : null;
  if (!res.ok) return { ok: false, httpStatus: res.status, reason: reason ?? `The server answered ${res.status}.` };
  if (!body || typeof body !== "object" || !("status" in body)) return { ok: false, httpStatus: res.status, reason: "The server sent an answer this page can't read." };
  return { ok: true, httpStatus: res.status, body: body as ReviseResponse };
}
