/**
 * "Send to street team", in two steps with a human confirm between them.
 *
 *   prepareSend  validates recipients and attachments, renders the exports and
 *                the message, and returns a preview plus a confirm token.
 *                Nothing is sent and nothing is written to the ledger.
 *   confirmSend  checks the token (signature, expiry, single use, binding),
 *                the per-requester daily cap and the config, then sends through
 *                Resend, or records "demo: not sent" when the keys are absent.
 *                Every confirm writes exactly one A# ledger entry.
 */
import type { LedgerEntry, LedgerSink, StreetSheet } from "@walkup/contracts";
import {
  checkAttachmentKinds,
  renderAttachments,
  ATTACHMENT_LABELS,
  type AttachmentFailure,
  type AttachmentFile,
  type SheetExporters,
} from "./attachments";
import { fromAddress, hasMailKeys, resolveSendConfig, type SendConfig } from "./config";
import { TEST_INBOX, TOKEN_TTL_MS, type AttachmentKind } from "./constants";
import { deriveKeys, keyedId, randomId, sha256Hex, type SendKeys } from "./crypto";
import { defaultExporters } from "./default-exporters";
import { actionEntry, type ActionEntryInput } from "./ledger";
import { createResendClient, type MailClient } from "./mail-client";
import { buildMessage } from "./message";
import { checkRecipients, redactRecipient, type Recipient, type TypedRecipient } from "./recipients";
import { createMemorySendStore, utcDay, type SendStore } from "./store";
import { signToken, verifyToken, type AttachmentDigest } from "./token";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PrepareSendInput {
  sheet: StreetSheet;
  /** Addresses the operator typed into this request (max 5). Omit or [] for the test inbox only. */
  recipients?: TypedRecipient[];
  /** Which exports to attach. Default: all three (pdf, ics, partners). */
  attachments?: AttachmentKind[];
  /** Used only as a keyed hash for the daily cap. Never stored raw. */
  requesterIp: string | null | undefined;
  /** Default true. False sends only to the typed addresses. */
  includeTestInbox?: boolean;
}

export interface SendDeps {
  /** Default: resolveSendConfig(process.env). */
  config?: SendConfig;
  /** Default: one in-memory store per process (getDefaultSendStore()). */
  store?: SendStore;
  /** Clock, epoch ms. Default Date.now. */
  now?: () => number;
}

export interface PrepareDeps extends SendDeps {
  /** Default: the @walkup/exports functions. */
  exporters?: SheetExporters;
}

export interface ConfirmDeps extends SendDeps {
  /** Where the A# entry goes (createSheetLedger(sheet.ledger) continues a sheet's numbering). */
  ledger: LedgerSink;
  /** Default: a Resend client built from RESEND_API_KEY. Only used in live mode. */
  mailClient?: MailClient;
  /** When given, it must match the requester the token was prepared for. */
  requesterIp?: string | null;
}

export interface PreviewAttachment {
  kind: AttachmentKind;
  label: string;
  filename: string;
  contentType: string;
  bytes: number;
}

export interface SendPreview {
  planId: string;
  /** "live": confirm sends through Resend. "demo": confirm records "demo: not sent". */
  mode: "live" | "demo";
  /** Why the mode is demo (empty in live mode). */
  modeReason: string;
  recipients: Recipient[];
  subject: string;
  attachments: PreviewAttachment[];
  /** Exports that failed to build and are left out. */
  attachmentFailures: AttachmentFailure[];
  /** CAN-SPAM footer: who sent it, opt-out line, physical postal address. */
  footer: string;
  /** Plain-text body, for the confirm dialog. */
  text: string;
  /** The token stops working at this time (ISO). */
  expiresAt: string;
  /** Sends left today for this requester, before this one. */
  sendsLeftToday: number;
}

export type PrepareSendResult =
  | { status: "ready"; confirmToken: string; preview: SendPreview }
  | { status: "refused"; reason: string };

/**
 * sent           Resend accepted it; `messageId` is set.
 * demo_not_sent  No RESEND_API_KEY / RESEND_FROM: nothing left the server, the ledger says so.
 * refused        A rule stopped it (token, expiry, replay, cap, config). Nothing was sent.
 * failed         Resend was called and did not return a message id. A 4xx means nothing
 *                was sent; after a network error or a 5xx the outcome is unknown and
 *                the reason says so.
 */
export type ConfirmStatus = "sent" | "demo_not_sent" | "refused" | "failed";

export interface ConfirmSendResult {
  status: ConfirmStatus;
  messageId?: string;
  ledgerEntryId: string;
  ledgerEntry: LedgerEntry;
  /** From the verified token; null when the token could not be verified. */
  planId: string | null;
  /** Plain sentence for the dialog when the status is not "sent". */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

let defaultStore: SendStore | null = null;

/** The per-process store used when none is injected. */
export function getDefaultSendStore(): SendStore {
  defaultStore ??= createMemorySendStore();
  return defaultStore;
}

function requesterKey(keys: SendKeys, ip: string | null | undefined): string {
  const v = typeof ip === "string" && ip.trim().length > 0 ? ip.trim().toLowerCase() : "unknown";
  return keyedId(keys.id, `ip:${v}`, 16);
}

function messageDigest(subject: string, text: string, html: string): string {
  return sha256Hex(`${subject}\u0000${text}\u0000${html}`);
}

/** Digests recomputed from the bytes themselves, never taken from a stored field. */
function digestsOf(files: AttachmentFile[]): AttachmentDigest[] {
  return files.map((f) => ({ filename: f.filename, sha256: sha256Hex(f.content), bytes: f.content.byteLength }));
}

/** Why a configured send would be blocked, or null when it may go out. */
function liveBlocker(config: SendConfig): string | null {
  if (!hasMailKeys(config)) return null;
  if (!config.postalAddress) {
    return "A real send needs WALKUP_POSTAL_ADDRESS for the footer (CAN-SPAM). Set it, or remove RESEND_API_KEY to use demo mode.";
  }
  return null;
}

function demoReason(config: SendConfig): string {
  const missing = [config.resendApiKey ? null : "RESEND_API_KEY", config.resendFrom ? null : "RESEND_FROM"].filter(Boolean);
  return `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not set on this server, so nothing is sent.`;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Shape check of the fields the message and the exports read, so a bad request body is refused, not thrown. */
function looksLikeSheet(v: unknown): v is StreetSheet {
  const s = rec(v);
  if (!s) return false;
  const bill = rec(s["bill"]);
  const venue = rec(bill?.["venue"]);
  const cards = rec(s["cards"]);
  const partners = rec(cards?.["partners"]);
  const liftResults = rec(rec(cards?.["liftMap"])?.["results"]);
  const operator = rec(s["operator"]);
  return (
    typeof s["planId"] === "string" &&
    s["planId"].length > 0 &&
    (s["mode"] === "live" || s["mode"] === "fixture") &&
    typeof s["hypothetical"] === "boolean" &&
    !!bill &&
    Array.isArray(bill["acts"]) &&
    typeof bill["date"] === "string" &&
    !!venue &&
    typeof venue["name"] === "string" &&
    Array.isArray(partners?.["results"]) &&
    Array.isArray(liftResults?.["tiles"]) &&
    !!operator &&
    Array.isArray(operator["streetTeamDays"]) &&
    Array.isArray(s["limits"]) &&
    Array.isArray(s["ledger"])
  );
}

/** Provider messages are kept short and any address-like text is masked before it reaches the ledger. */
function scrubProviderMessage(msg: string): string {
  return msg
    .replace(/[^\s@<>"'`,;:()]+@[^\s@<>"'`,;:()]+/g, "[address]")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// Step 1: prepare
// ---------------------------------------------------------------------------

export async function prepareSend(input: PrepareSendInput, deps: PrepareDeps = {}): Promise<PrepareSendResult> {
  const config = deps.config ?? resolveSendConfig();
  const store = deps.store ?? getDefaultSendStore();
  const now = deps.now ?? Date.now;
  const keys = deriveKeys(config.signingSecret);

  if (!looksLikeSheet(input?.sheet)) return { status: "refused", reason: "No Street Sheet to send." };
  const sheet = input.sheet;

  const rec = checkRecipients(input.recipients, input.includeTestInbox ?? true);
  if (!rec.ok) return { status: "refused", reason: rec.reason };

  const kinds = checkAttachmentKinds(input.attachments);
  if (!kinds.ok) return { status: "refused", reason: kinds.reason };

  const blocker = liveBlocker(config);
  if (blocker) return { status: "refused", reason: blocker };

  const t0 = now();
  const rq = requesterKey(keys, input.requesterIp);
  const used = await store.sendsToday(rq, utcDay(t0));
  if (used >= config.dailyCap) {
    return { status: "refused", reason: `Daily limit reached: ${config.dailyCap} sends per requester per day. Try again tomorrow (UTC).` };
  }

  const { files, failures } = await renderAttachments(sheet, kinds.kinds, deps.exporters ?? defaultExporters);
  const msg = buildMessage(sheet, files, {
    postalAddress: config.postalAddress,
    replyAddress: config.resendFrom ? fromAddress(config.resendFrom) : null,
  });

  const live = hasMailKeys(config);
  const id = randomId();
  const exp = t0 + TOKEN_TTL_MS;
  await store.putPending(id, {
    planId: sheet.planId,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: files,
    expiresAtMs: exp,
  });
  const confirmToken = signToken(
    keys,
    {
      id,
      planId: sheet.planId,
      iat: t0,
      exp,
      rq,
      md: live ? "live" : "demo",
      msg: messageDigest(msg.subject, msg.text, msg.html),
      att: digestsOf(files),
    },
    rec.recipients,
  );

  return {
    status: "ready",
    confirmToken,
    preview: {
      planId: sheet.planId,
      mode: live ? "live" : "demo",
      modeReason: live ? "" : demoReason(config),
      recipients: rec.recipients,
      subject: msg.subject,
      attachments: files.map((f) => ({
        kind: f.kind,
        label: ATTACHMENT_LABELS[f.kind],
        filename: f.filename,
        contentType: f.contentType,
        bytes: f.bytes,
      })),
      attachmentFailures: failures,
      footer: msg.footer,
      text: msg.text,
      expiresAt: new Date(exp).toISOString(),
      sendsLeftToday: Math.max(0, config.dailyCap - used),
    },
  };
}

// ---------------------------------------------------------------------------
// Step 2: confirm
// ---------------------------------------------------------------------------

export async function confirmSend(confirmToken: string, deps: ConfirmDeps): Promise<ConfirmSendResult> {
  const config = deps.config ?? resolveSendConfig();
  const store = deps.store ?? getDefaultSendStore();
  const now = deps.now ?? Date.now;
  const keys = deriveKeys(config.signingSecret);
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const live = hasMailKeys(config);

  const base: ActionEntryInput = {
    planId: null,
    recipients: [],
    attachments: [],
    subject: null,
    httpStatus: null,
    envelopeStatus: "error",
    latencyMs: 0,
    bytes: 0,
    resultCount: 0,
    startedAt,
    note: "",
    tokenRef: null,
    live,
  };

  const record = (
    status: ConfirmStatus,
    entry: ActionEntryInput,
    extra: { messageId?: string; reason?: string } = {},
  ): ConfirmSendResult => {
    const ledgerEntryId = deps.ledger.add(actionEntry(entry));
    const ledgerEntry = deps.ledger.entries().find((e) => e.id === ledgerEntryId) ?? { ...actionEntry(entry), id: ledgerEntryId };
    return { status, ledgerEntryId, ledgerEntry, planId: entry.planId, ...extra };
  };
  const refuse = (entry: ActionEntryInput, reason: string): ConfirmSendResult =>
    record("refused", { ...entry, envelopeStatus: "error", note: `refused: ${reason} Nothing was sent.` }, { reason });

  // 1. Signature and shape.
  const check = verifyToken(keys, confirmToken);
  if (!check.ok) return refuse(base, check.reason.replace(/ Nothing was sent\.$/, ""));
  const { payload, recipients } = check;
  const known: ActionEntryInput = {
    ...base,
    planId: payload.planId,
    recipients: recipients.map((r) => redactRecipient(r, keys.id)),
    attachments: payload.att.map((a) => a.filename),
    tokenRef: keyedId(keys.id, `token:${payload.id}`, 10),
  };

  // 2. Expiry.
  if (startedMs > payload.exp) {
    await store.takePending(payload.id);
    return refuse(known, "The confirm token expired (10 minutes). Prepare the send again.");
  }

  // 3. Same requester, when the caller tells us who is confirming.
  if (deps.requesterIp !== undefined && requesterKey(keys, deps.requesterIp) !== payload.rq) {
    return refuse(known, "This confirm token was prepared for a different requester.");
  }

  // 4. Single use.
  if (!(await store.markUsed(payload.id, payload.exp))) {
    return refuse(known, "This confirm token was already used.");
  }
  const pending = await store.takePending(payload.id);
  if (!pending || pending.planId !== payload.planId) {
    return refuse(known, "The prepared send is no longer on this server (restarted or expired). Prepare it again.");
  }

  // 5. The exact message and attachments that were previewed.
  const sameMessage = messageDigest(pending.subject, pending.text, pending.html) === payload.msg;
  const att = digestsOf(pending.attachments);
  const sameAttachments =
    att.length === payload.att.length &&
    att.every((a, i) => {
      const b = payload.att[i];
      return !!b && a.filename === b.filename && a.sha256 === b.sha256 && a.bytes === b.bytes;
    });
  if (!sameMessage || !sameAttachments) {
    return refuse(known, "The message or attachments changed after the preview.");
  }
  const withMessage: ActionEntryInput = {
    ...known,
    subject: pending.subject,
  };

  // 6. Config still allows it, and the mode is the one the person confirmed:
  // a preview that said "demo: nothing is sent" must never turn into a real send.
  const blocker = liveBlocker(config);
  if (blocker) return refuse(withMessage, blocker);
  const mode = live ? "live" : "demo";
  if (payload.md !== mode) {
    return refuse(withMessage, `The server's send mode changed after the preview (was ${payload.md}, now ${mode}). Prepare the send again.`);
  }

  // 7. Daily cap (counted for demo and live confirms alike; a provider error still counts).
  const cap = await store.reserveSend(payload.rq, utcDay(startedMs), config.dailyCap);
  if (!cap.allowed) {
    return refuse(withMessage, `Daily limit reached: ${config.dailyCap} sends per requester per day.`);
  }

  const bytes =
    pending.attachments.reduce((n, f) => n + f.bytes, 0) + Buffer.byteLength(pending.text) + Buffer.byteLength(pending.html);

  // 8a. Demo: no keys, nothing leaves the server.
  if (!live) {
    const reason = demoReason(config);
    return record(
      "demo_not_sent",
      { ...withMessage, envelopeStatus: "degraded", bytes: 0, note: `demo: not sent. ${reason}` },
      { reason: `demo: not sent. ${reason}` },
    );
  }

  // 8b. Live send. Typed addresses never see each other: with more than one
  // recipient, typed addresses go in bcc.
  const from = config.resendFrom as string;
  const reply = fromAddress(from);
  const typed = recipients.filter((r) => r.source === "typed").map((r) => r.address);
  const hasInbox = recipients.some((r) => r.source === "test_inbox");
  const single = recipients.length === 1;
  const to = single ? [recipients[0]?.address ?? TEST_INBOX] : hasInbox ? [TEST_INBOX] : [reply];
  const bcc = single ? [] : typed;

  const client = deps.mailClient ?? createResendClient(config.resendApiKey as string);
  const t1 = now();
  let messageId: string | null = null;
  let httpStatus: number | null = null;
  let failure: string | null = null;
  // Only a 4xx answer proves Resend refused the message. A network error, a
  // timeout or a 5xx leaves the outcome unknown, and the ledger says so.
  let rejected = false;
  try {
    const res = await client.emails.send(
      {
        from,
        to,
        ...(bcc.length > 0 ? { bcc } : {}),
        subject: pending.subject,
        text: pending.text,
        html: pending.html,
        attachments: pending.attachments.map((f) => ({
          filename: f.filename,
          content: Buffer.from(f.content),
          contentType: f.contentType,
        })),
        headers: { "List-Unsubscribe": `<mailto:${reply}?subject=unsubscribe>` },
        tags: [{ name: "kind", value: "street_sheet" }],
      },
      { idempotencyKey: `walkup-send-${payload.id}` },
    );
    if (res.error) {
      httpStatus = res.error.statusCode ?? null;
      rejected = httpStatus !== null && httpStatus >= 400 && httpStatus < 500;
      failure = `Resend returned ${res.error.name}${httpStatus ? ` (${httpStatus})` : ""}: ${scrubProviderMessage(res.error.message)}`;
    } else if (res.data && typeof res.data.id === "string" && res.data.id.length > 0) {
      messageId = res.data.id;
      httpStatus = 200;
    } else {
      failure = "Resend returned no message id.";
    }
  } catch (err) {
    failure = `Resend call failed: ${scrubProviderMessage(err instanceof Error ? err.message : String(err))}`;
  }
  const latencyMs = now() - t1;

  if (messageId === null) {
    const outcome = rejected
      ? "Nothing was sent."
      : "Resend did not confirm the send, so it may or may not have gone out; check the Resend dashboard before sending again.";
    const reason = `${failure ?? "Resend returned no message id."} ${outcome}`;
    return record(
      "failed",
      { ...withMessage, httpStatus, envelopeStatus: "error", latencyMs, bytes: 0, note: `failed: ${reason}` },
      { reason },
    );
  }
  return record(
    "sent",
    {
      ...withMessage,
      httpStatus,
      envelopeStatus: "ok",
      latencyMs,
      bytes,
      resultCount: recipients.length,
      note: `sent: message id ${messageId}`,
    },
    { messageId },
  );
}
