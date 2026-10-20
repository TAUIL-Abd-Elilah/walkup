/**
 * Validates what a client may send to start or resume a plan. Only known
 * fields pass, with bounds; nothing personal is accepted (no emails here: the
 * confirm-gated send takes addresses separately and never stores them).
 */
import { WEEKDAYS, type DeclaredPartner, type OperatorInputs, type Weekday } from "@walkup/contracts";
import { looksPolitical } from "@walkup/engine";

export const ENTITY_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const TM_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[A-Za-z]{2,}/;
const CONTROL_RE = /[\x00-\x1f\x7f]/g;
const MAX_LABEL = 120;
const MAX_PARTNERS = 20;
/** Same refusal as the MCP tools (the word list is in @walkup/engine). */
export const POLITICAL_REFUSAL = "Political candidates and campaigns are out of scope for Walkup.";

export type Wait = "complete" | "none";

export interface Pick {
  input: string;
  entityId: string;
  /** "None of these: use a proxy": entityId is a film or TV title standing in. */
  proxy?: boolean;
}

export interface PlanBody {
  presetId?: string;
  tmEventId?: string;
  /** Free text ("Artist @ Venue, Date") to look up on Ticketmaster (live only). */
  freeText?: string;
  operator: Partial<OperatorInputs>;
  picks: Pick[];
  /** Partner names to rank (rank-partners). */
  partners?: string[];
  wait: Wait;
}

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function cleanText(v: unknown, max = MAX_LABEL): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  return t && t.length <= max ? t : null;
}

export function looksLikeEmail(s: string): boolean {
  return EMAIL_RE.test(s);
}

/** Ticketmaster event URL or bare id -> event id. */
export function tmEventIdFrom(text: string): string | null {
  const t = text.trim();
  try {
    const u = new URL(t);
    if (!/(^|\.)ticketmaster\.[a-z.]+$/i.test(u.hostname) && !/(^|\.)livenation\.[a-z.]+$/i.test(u.hostname)) return null;
    const m = /\/event\/([A-Za-z0-9]{4,64})(?:[/?#]|$)/.exec(u.pathname);
    return m ? (m[1] as string) : null;
  } catch {
    // Not a URL.
  }
  return /^[A-Za-z0-9]{8,40}$/.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t) ? t : null;
}

function wholeOrNull(v: unknown, max: number): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined;
}

export function parseOperator(v: unknown): Result<Partial<OperatorInputs>> {
  if (v === undefined || v === null) return { ok: true, value: {} };
  if (!isObj(v)) return { ok: false, reason: "operator must be an object." };
  const out: Partial<OperatorInputs> = {};
  for (const k of ["seatsLeft", "capacity"] as const) {
    if (!(k in v)) continue;
    const n = wholeOrNull(v[k], 200_000);
    if (n === undefined) return { ok: false, reason: `operator.${k} must be a whole number from 0 to 200,000, or null.` };
    out[k] = n;
  }
  if ("mediaBudgetUsd" in v) {
    const n = wholeOrNull(v.mediaBudgetUsd, 10_000_000);
    if (n === undefined) return { ok: false, reason: "operator.mediaBudgetUsd must be a whole number of dollars, or null." };
    out.mediaBudgetUsd = n;
  }
  if ("radiusKm" in v) {
    const r = v.radiusKm;
    if (typeof r !== "number" || !Number.isFinite(r) || r < 1 || r > 100) return { ok: false, reason: "operator.radiusKm must be between 1 and 100." };
    out.radiusKm = r;
  }
  if ("streetTeamDays" in v) {
    const days = v.streetTeamDays;
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      days.length > 7 ||
      !days.every((d) => typeof d === "string" && (WEEKDAYS as readonly string[]).includes(d.toLowerCase()))
    ) {
      return { ok: false, reason: 'operator.streetTeamDays must list weekdays, e.g. ["thursday", "saturday"].' };
    }
    out.streetTeamDays = [...new Set(days.map((d) => (d as string).toLowerCase() as Weekday))];
  }
  if ("declaredPartners" in v) {
    const dp = v.declaredPartners;
    if (!Array.isArray(dp) || dp.length > MAX_PARTNERS) return { ok: false, reason: `operator.declaredPartners must be a list of at most ${MAX_PARTNERS}.` };
    const list: DeclaredPartner[] = [];
    for (const d of dp) {
      const label = cleanText(isObj(d) ? d.label : d);
      if (!label) return { ok: false, reason: `Each declared partner needs a label of at most ${MAX_LABEL} characters.` };
      if (looksLikeEmail(label)) return { ok: false, reason: "Declared partners are names only; contact addresses go in the send dialog, which asks you to confirm." };
      if (looksPolitical(label)) return { ok: false, reason: POLITICAL_REFUSAL };
      const id = isObj(d) ? d.qlooEntityId : undefined;
      list.push(typeof id === "string" && ENTITY_ID_RE.test(id) ? { label, qlooEntityId: id } : { label });
    }
    out.declaredPartners = list;
  }
  if ("alreadyReachedZips" in v) {
    const z = v.alreadyReachedZips;
    if (!Array.isArray(z) || z.length > 300) return { ok: false, reason: "operator.alreadyReachedZips must be a list of at most 300 {zip, count}." };
    const rows: { zip: string; count: number }[] = [];
    for (const r of z) {
      if (!isObj(r) || typeof r.zip !== "string" || !/^\d{5}$/.test(r.zip) || typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 0) {
        return { ok: false, reason: 'Each already-reached row is {zip: "12345", count: whole number}. Aggregate counts only, no names.' };
      }
      rows.push({ zip: r.zip, count: r.count });
    }
    out.alreadyReachedZips = rows;
  }
  if ("allAges" in v) {
    if (typeof v.allAges !== "boolean") return { ok: false, reason: "operator.allAges must be true or false (false never lifts Ticketmaster's 21+)." };
    out.allAges = v.allAges;
  }
  for (const k of ["excludeCategories", "excludeAreas"] as const) {
    if (!(k in v)) continue;
    const list = v[k];
    if (!Array.isArray(list) || list.length > 30) return { ok: false, reason: `operator.${k} must be a list of at most 30 short names.` };
    const keep: string[] = [];
    for (const x of list) {
      const t = cleanText(x, 80);
      if (!t || looksLikeEmail(t)) return { ok: false, reason: `operator.${k}: place-type keys or area names only, at most 80 characters each.` };
      if (!keep.includes(t)) keep.push(t);
    }
    out[k] = keep;
  }
  return { ok: true, value: out };
}

/** Longest revise note accepted (characters). */
export const MAX_REVISE_CHARS = 300;

export interface ReviseBody {
  instruction: string;
  /** "none" (default): answer 202 with the new plan id at once; "complete": wait for the revised sheet. */
  wait: Wait;
}

/** POST /api/plan/<id>/revise bodies: {instruction, wait?}. */
export function parseReviseBody(v: unknown): Result<ReviseBody> {
  if (!isObj(v)) return { ok: false, reason: 'Send a JSON object, e.g. {"instruction": "All ages: no bars"}.' };
  const raw = v.instruction;
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: 'Send instruction: a short note on what to change, e.g. "All ages: no bars" or "skip Germantown".' };
  const instruction = cleanText(raw, MAX_REVISE_CHARS);
  if (!instruction) return { ok: false, reason: `Keep the note to ${MAX_REVISE_CHARS} characters or fewer.` };
  if (looksLikeEmail(instruction)) return { ok: false, reason: "That looks like contact details. Say what to change on the sheet instead." };
  if (looksPolitical(instruction)) return { ok: false, reason: POLITICAL_REFUSAL };
  return { ok: true, value: { instruction, wait: v.wait === "complete" ? "complete" : "none" } };
}

export function parsePicks(v: unknown): Result<Pick[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  let list: unknown[];
  if (Array.isArray(v)) list = v;
  else if (isObj(v)) list = Object.entries(v).map(([input, entityId]) => ({ input, entityId }));
  else return { ok: false, reason: "picks must be a list of {input, entityId}." };
  if (list.length > 10) return { ok: false, reason: "At most 10 picks per request." };
  const out: Pick[] = [];
  for (const p of list) {
    const input = cleanText(isObj(p) ? p.input : undefined);
    const entityId = isObj(p) ? p.entityId : undefined;
    if (!input || typeof entityId !== "string" || !ENTITY_ID_RE.test(entityId)) {
      return { ok: false, reason: "Each pick is {input: <the ambiguous name>, entityId: <a candidate id>}." };
    }
    out.push({ input, entityId, ...(isObj(p) && p.proxy === true ? { proxy: true } : {}) });
  }
  return { ok: true, value: out };
}

/** POST /api/plan and /api/rank-partners bodies. */
export function parsePlanBody(v: unknown, presetIds: readonly string[]): Result<PlanBody> {
  if (!isObj(v)) return { ok: false, reason: 'Send a JSON object, e.g. {"presetId": "g1-a"} or {"event": "<Ticketmaster event URL>"}.' };
  const op = parseOperator(v.operator);
  if (!op.ok) return op;
  const picks = parsePicks(v.picks ?? v.resolutions);
  if (!picks.ok) return picks;
  const wait: Wait = v.wait === "none" || v.wait === false ? "none" : "complete";
  const body: PlanBody = { operator: op.value, picks: picks.value, wait };

  if (v.partners !== undefined) {
    if (!Array.isArray(v.partners) || v.partners.length === 0 || v.partners.length > MAX_PARTNERS) {
      return { ok: false, reason: `partners must list 1 to ${MAX_PARTNERS} names.` };
    }
    const names: string[] = [];
    for (const n of v.partners) {
      const t = cleanText(n);
      if (!t || looksLikeEmail(t)) return { ok: false, reason: "Partner names only (no contact details), at most 120 characters each." };
      if (looksPolitical(t)) return { ok: false, reason: POLITICAL_REFUSAL };
      names.push(t);
    }
    body.partners = names;
  }

  const preset = typeof v.presetId === "string" ? v.presetId.trim() : null;
  const tm = typeof v.tmEventId === "string" ? v.tmEventId.trim() : null;
  const event = typeof v.event === "string" ? v.event.trim().slice(0, 300) : null;
  const sources = [preset, tm, event].filter((x) => x).length;
  if (sources !== 1) return { ok: false, reason: "Send exactly one of presetId, tmEventId or event." };
  if (preset) {
    if (!presetIds.includes(preset)) return { ok: false, reason: `Unknown preset ${preset}. Presets: ${presetIds.join(", ")}.` };
    body.presetId = preset;
  } else if (tm) {
    if (!TM_ID_RE.test(tm)) return { ok: false, reason: "tmEventId must be a Ticketmaster event id." };
    body.tmEventId = tm;
  } else if (event) {
    if (presetIds.includes(event)) body.presetId = event;
    else {
      const id = tmEventIdFrom(event);
      if (id) body.tmEventId = id;
      else if (looksLikeEmail(event)) return { ok: false, reason: "That looks like an email address. Send an event, not contact details." };
      else if (looksPolitical(event)) return { ok: false, reason: POLITICAL_REFUSAL };
      else body.freeText = event;
    }
  }
  return { ok: true, value: body };
}
