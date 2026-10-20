/**
 * "Send to street team" for the web app, on @walkup/send:
 *
 *   POST /api/send/prepare  {planId, copyTo?, attachments?}  -> preview + confirm token (nothing sent, nothing logged)
 *   POST /api/send/confirm  {planId, confirmToken}           -> sent | demo_not_sent | refused | failed, and one A# entry
 *
 * The sheet always comes from the server's own copy (by plan id), never from
 * the request. Typed addresses are passed through once, inside the encrypted
 * token, and never stored. The A# entry is kept with the plan (see actions.ts).
 */
import type { LedgerEntry } from "@walkup/contracts";
import { ATTACHMENT_KINDS, confirmSend, createSheetLedger, prepareSend, type AttachmentKind, type ConfirmDeps, type PrepareDeps } from "@walkup/send";
import { PLAN_ID_RE } from "../api";
import { addSessionAction, appendStoredAction, nextActionId } from "./actions";
import { stores } from "./engine";
import type { RequestContext } from "./http";
import { rateLimit } from "./limits";
import { loadPlan, type ServiceResponse } from "./service";

export const PREPARE_PER_HOUR = 30;
const MAX_TOKEN = 8192;

/** Test seams: config, store, mail client and clock for @walkup/send. */
export interface SendSeams {
  prepare?: PrepareDeps;
  confirm?: Omit<ConfirmDeps, "ledger" | "requesterIp">;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typedAddresses(v: unknown): string[] | null {
  if (v === undefined || v === null || v === "") return [];
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((x) => typeof x === "string")) return null;
  return (list as string[]).map((s) => s.trim()).filter(Boolean);
}

export async function prepareSendFor(raw: unknown, ctx: RequestContext, seams: SendSeams = {}): Promise<ServiceResponse> {
  if (!isObj(raw)) return { status: 400, body: { status: "refused", reason: "Send {planId, copyTo?, attachments?}." } };
  const planId = typeof raw.planId === "string" ? raw.planId : "";
  if (!PLAN_ID_RE.test(planId)) return { status: 400, body: { status: "refused", reason: "planId is missing or malformed." } };
  const limit = rateLimit("send-prepare", ctx.ip, PREPARE_PER_HOUR, 60 * 60 * 1000);
  if (!limit.ok) return { status: 429, body: { status: "refused", reason: `Too many send previews from this network; try again in ${limit.retryAfterS} s.` } };

  const typed = typedAddresses(raw.copyTo ?? raw.recipients);
  if (typed === null) return { status: 400, body: { status: "refused", reason: "copyTo must be an address or a list of addresses you typed." } };
  let attachments: AttachmentKind[] | undefined;
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || !raw.attachments.every((a) => typeof a === "string" && (ATTACHMENT_KINDS as readonly string[]).includes(a))) {
      return { status: 400, body: { status: "refused", reason: `attachments must be chosen from ${ATTACHMENT_KINDS.join(", ")}.` } };
    }
    attachments = raw.attachments as AttachmentKind[];
  }

  const v = await loadPlan(planId, { view: "api", sessionId: ctx.sessionId });
  if (!v) return { status: 404, body: { status: "refused", reason: `No plan with id ${planId}.` } };
  if (v.kind !== "sheet") return { status: 409, body: { status: "refused", reason: "This plan has no finished sheet to send yet." } };

  const res = await prepareSend(
    {
      sheet: v.sheet,
      recipients: typed.map((address) => ({ address, typedByOperator: true as const })),
      ...(attachments ? { attachments } : {}),
      requesterIp: ctx.ip,
      includeTestInbox: raw.includeTestInbox !== false,
    },
    seams.prepare ?? {},
  );
  if (res.status === "refused") return { status: 400, body: res };
  return { status: 200, body: res };
}

export async function confirmSendFor(raw: unknown, ctx: RequestContext, seams: SendSeams = {}): Promise<ServiceResponse> {
  if (!isObj(raw)) return { status: 400, body: { status: "refused", reason: "Send {planId, confirmToken}." } };
  const planId = typeof raw.planId === "string" ? raw.planId : "";
  const token = typeof raw.confirmToken === "string" ? raw.confirmToken : "";
  if (!PLAN_ID_RE.test(planId) || !token || token.length > MAX_TOKEN) {
    return { status: 400, body: { status: "refused", reason: "planId and confirmToken are required." } };
  }
  const v = await loadPlan(planId, { view: "api", sessionId: ctx.sessionId });
  if (!v || v.kind !== "sheet") return { status: 404, body: { status: "refused", reason: `No finished sheet with id ${planId}.` } };

  const ledger = createSheetLedger(v.sheet.ledger);
  const res = await confirmSend(token, { ...(seams.confirm ?? {}), ledger, requesterIp: ctx.ip });
  let entry: LedgerEntry = res.ledgerEntry;
  let targetId = planId;
  let target = v;
  if (res.planId && res.planId !== planId && PLAN_ID_RE.test(res.planId)) {
    // The token was prepared for another plan: number the entry in that plan's ledger.
    const other = await loadPlan(res.planId, { view: "api", sessionId: ctx.sessionId });
    if (other?.kind === "sheet") {
      targetId = res.planId;
      target = other;
      entry = { ...entry, id: nextActionId(other.sheet.ledger) };
    }
  }

  let kept: "plan" | "session" | "none" = "none";
  if (target.source === "preset") {
    if (ctx.sessionId) {
      addSessionAction(targetId, ctx.sessionId, entry);
      kept = "session";
    }
  } else if (await appendStoredAction(stores().plans, targetId, entry)) {
    kept = "plan";
  }

  return {
    status: 200,
    body: {
      status: res.status,
      planId: targetId,
      ...(res.messageId ? { messageId: res.messageId } : {}),
      ...(res.reason ? { reason: res.reason } : {}),
      ledgerEntryId: entry.id,
      ledgerEntry: entry,
      kept,
    },
  };
}
