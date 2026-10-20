"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LedgerEntry } from "@walkup/contracts";
import { formatBytes, formatClockUtc, joinAnd } from "../../lib/format";
import { addressCount } from "../../lib/sheet-utils";
import { useDialog } from "./useDialog";

export const TEST_INBOX = "delivered@resend.dev";
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/;

interface Preview {
  planId: string;
  mode: "live" | "demo";
  modeReason: string;
  recipients: { address: string; source: "test_inbox" | "typed" }[];
  subject: string;
  attachments: { kind: string; label: string; filename: string; contentType: string; bytes: number }[];
  attachmentFailures: { kind: string; reason?: string }[];
  footer: string;
  text: string;
  expiresAt: string;
  sendsLeftToday: number;
}

interface ConfirmResult {
  status: "sent" | "demo_not_sent" | "refused" | "failed";
  messageId?: string;
  reason?: string;
  ledgerEntryId: string;
  ledgerEntry: LedgerEntry;
}

type Phase =
  | { kind: "preparing" }
  | { kind: "ready"; token: string; preview: Preview; forCopy: string }
  | { kind: "confirming"; preview: Preview }
  | { kind: "done"; result: ConfirmResult; preview: Preview }
  | { kind: "refused"; reason: string };

async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; body: T }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const parsed = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * Confirm-gated send. Opening the dialog asks the server for the real preview
 * (recipients, subject, attachments with sizes, footer); nothing is sent and
 * nothing is logged until Confirm. The result is the provider's: "Sent, message
 * id ..." with Resend keys, "demo: not sent" without them. Either way the
 * ledger gains one A# entry. A typed copy address is used once and never stored.
 */
export function SendModal({
  open,
  planId,
  onClose,
  onRecorded,
  onViewReceipt,
}: {
  open: boolean;
  planId: string;
  onClose: () => void;
  onRecorded: (entry: LedgerEntry) => void;
  onViewReceipt: (id: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [copyTo, setCopyTo] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "preparing" });

  const close = () => {
    setCopyTo("");
    setFieldError(null);
    setPhase({ kind: "preparing" });
    onClose();
  };
  useDialog(open, dialogRef, close);

  const prepare = useCallback(
    async (copy: string) => {
      setPhase({ kind: "preparing" });
      type PrepareBody = { status: string; confirmToken?: string; preview?: Preview; reason?: string };
      const r = await postJson<PrepareBody>("/api/send/prepare", {
        planId,
        ...(copy ? { copyTo: copy } : {}),
      }).catch((err: unknown) => ({ ok: false, status: 0, body: { status: "refused", reason: err instanceof Error ? err.message : "Network error." } as PrepareBody }));
      if (r.ok && r.body.status === "ready" && r.body.confirmToken && r.body.preview) {
        setPhase({ kind: "ready", token: r.body.confirmToken, preview: r.body.preview, forCopy: copy });
      } else {
        setPhase({ kind: "refused", reason: r.body.reason ?? `The server answered ${r.status}.` });
      }
    },
    [planId],
  );

  useEffect(() => {
    if (open) void prepare("");
  }, [open, prepare]);

  if (!open) return null;

  const typed = copyTo.trim();
  const stale = phase.kind === "ready" && phase.forCopy !== typed;

  const updatePreview = () => {
    if (typed && !EMAIL_RE.test(typed)) {
      setFieldError("That address does not look complete. Fix it or leave the field empty.");
      return;
    }
    setFieldError(null);
    void prepare(typed);
  };

  const confirm = async () => {
    if (phase.kind !== "ready" || stale) return;
    const preview = phase.preview;
    setPhase({ kind: "confirming", preview });
    const r = await postJson<ConfirmResult & { reason?: string }>("/api/send/confirm", { planId, confirmToken: phase.token }).catch((err: unknown) => ({
      ok: false,
      status: 0,
      body: { status: "failed", reason: err instanceof Error ? err.message : "Network error." } as ConfirmResult,
    }));
    if (r.body.ledgerEntry) onRecorded(r.body.ledgerEntry);
    if (r.body.ledgerEntryId) setPhase({ kind: "done", result: r.body, preview });
    else setPhase({ kind: "refused", reason: r.body.reason ?? `The server answered ${r.status}.` });
    setCopyTo("");
  };

  return (
    <div className="fixed inset-0 z-50 sm:grid sm:place-items-center" role="presentation">
      <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default bg-black/30" onClick={close} />
      {/* Full screen under 640px; a centred dialog with one shadow above that. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-title"
        aria-describedby="send-desc"
        className="relative h-full w-full overflow-y-auto bg-page sm:h-auto sm:max-h-[92dvh] sm:max-w-xl sm:rounded-[4px] sm:border sm:border-rule sm:shadow-[0_4px_24px_rgb(0_0_0/0.14)]"
      >
        <div className="p-4 sm:p-6">
          <h2 id="send-title" className="text-xl">
            Send to street team
          </h2>
          {phase.kind === "done" ? null : (
            <p id="send-desc" className="mt-1">
              {phase.kind === "ready" || phase.kind === "confirming"
                ? topSentence(phase.preview)
                : "Only the addresses below get this email, and only after you confirm. Partners are never emailed."}
            </p>
          )}

          {phase.kind === "done" ? (
            <SendResult result={phase.result} preview={phase.preview} onView={() => onViewReceipt(phase.result.ledgerEntryId)} onDone={close} />
          ) : phase.kind === "refused" ? (
            <div className="mt-4 space-y-4" role="alert">
              <p className="note-error">
                <span className="font-semibold">Not ready to send.</span> {phase.reason}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" className="btn btn-ghost" onClick={close}>
                  Close
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void prepare("")}>
                  Try again
                </button>
              </div>
            </div>
          ) : (
            <PreviewBody
              phase={phase}
              copyTo={copyTo}
              setCopyTo={(v) => {
                setCopyTo(v);
                setFieldError(null);
              }}
              fieldError={fieldError}
              stale={stale}
              onUpdate={updatePreview}
              onCancel={close}
              onConfirm={() => void confirm()}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const ATTACHED_WORDS: Record<string, string> = {
  pdf: "the PDF",
  ics: "the street-team calendar",
  partners: "the partner call list",
};

/** "Sending the street sheet with the PDF and the partner call list to 2 addresses." Demo mode says what would happen. */
function topSentence(p: Preview): string {
  const files = p.attachments.map((a) => ATTACHED_WORDS[a.kind] ?? a.filename);
  const what = `the street sheet${files.length > 0 ? ` with ${joinAnd(files)}` : ""} to ${addressCount(p.recipients.length)}`;
  return p.mode === "live" ? `Sending ${what}. Nothing goes out until you press the button.` : `This would send ${what}. In demo mode nothing leaves the server.`;
}

/** "The PDF didn't attach (reason). Send without it, or close this and try again." */
function failureSentence(f: { kind: string; reason?: string }): string {
  const what = ATTACHED_WORDS[f.kind] ?? f.kind;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} didn't attach${f.reason ? ` (${f.reason.replace(/\.$/, "")})` : ""}. Send without it, or close this and try again.`;
}

/** The confirm button names what it does and for how many: "Send to 2 addresses", or in demo mode "Record demo send (1 address)". */
function confirmLabel(kind: Phase["kind"], preview: { mode: string; recipients: unknown[] } | null): string {
  const demo = preview?.mode !== "live";
  if (kind === "preparing") return "Preparing…";
  if (kind === "confirming") return demo ? "Recording…" : "Sending…";
  const n = preview?.recipients.length ?? 0;
  if (demo) return `Record demo send (${addressCount(n)})`;
  return `Send to ${addressCount(n)}`;
}

function PreviewBody({
  phase,
  copyTo,
  setCopyTo,
  fieldError,
  stale,
  onUpdate,
  onCancel,
  onConfirm,
}: {
  phase: Extract<Phase, { kind: "preparing" | "ready" | "confirming" }>;
  copyTo: string;
  setCopyTo: (v: string) => void;
  fieldError: string | null;
  stale: boolean;
  onUpdate: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const preview = phase.kind === "preparing" ? null : phase.preview;
  const recipients = preview?.recipients ?? [{ address: TEST_INBOX, source: "test_inbox" as const }];
  const row = "border-b border-rule py-2";
  return (
    <div aria-busy={phase.kind !== "ready"}>
      {/* Check your answers: one row per fact, a bold key column, nothing to toggle. */}
      <dl className="mt-4 grid grid-cols-[30%_minmax(0,1fr)] border-t border-rule">
        <dt className={`${row} pr-3 font-semibold`}>To</dt>
        <dd className={`${row} flex items-start justify-between gap-3`}>
          <span className="min-w-0">
            {recipients.map((r) => (
              <span key={r.address} className="block [overflow-wrap:anywhere]">
                {r.address} <span className="text-sm text-muted">{r.source === "test_inbox" ? "(Resend's test inbox)" : "(typed by you)"}</span>
              </span>
            ))}
          </span>
          <a
            href="#send-copy"
            className="link shrink-0 text-sm"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("send-copy")?.focus();
            }}
          >
            Change<span className="sr-only"> who gets it</span>
          </a>
        </dd>
        <dt className={`${row} pr-3 font-semibold`}>Subject</dt>
        <dd className={`${row} [overflow-wrap:anywhere]`}>{preview ? preview.subject : <span className="text-muted">Building the message…</span>}</dd>
        <dt className={`${row} pr-3 font-semibold`}>Attached</dt>
        <dd className={row}>
          {preview ? (
            preview.attachments.length > 0 ? (
              preview.attachments.map((a) => (
                <span key={a.filename} className="block [overflow-wrap:anywhere]" title={a.contentType}>
                  {a.filename}, <span className="tabular">{formatBytes(a.bytes)}</span>
                </span>
              ))
            ) : (
              "Nothing"
            )
          ) : (
            <span className="text-muted">Building the PDF, calendar and call list…</span>
          )}
        </dd>
        <dt className={`${row} pr-3 font-semibold`}>Mode</dt>
        <dd className={row}>
          {preview ? (
            preview.mode === "live" ? (
              "Live: sent through Resend"
            ) : (
              <>
                Demo: nothing leaves the server
                {preview.modeReason ? <span className="block text-sm text-muted">{preview.modeReason}</span> : null}
              </>
            )
          ) : (
            <span className="text-muted">Checking…</span>
          )}
        </dd>
      </dl>

      {preview && preview.attachmentFailures.length > 0 ? (
        <div className="mt-3 space-y-2">
          {preview.attachmentFailures.map((f) => (
            <p key={f.kind} className="note-warn">
              {failureSentence(f)}
            </p>
          ))}
        </div>
      ) : null}

      <label htmlFor="send-copy" className="label mt-5">
        Street-team email <span className="font-normal text-muted">(optional)</span>
      </label>
      <p id="send-copy-help" className="hint mt-0.5">
        Added to the list above for this send only, and not stored.
      </p>
      <div className="mt-1 flex gap-2">
        <input
          id="send-copy"
          type="email"
          autoComplete="off"
          inputMode="email"
          value={copyTo}
          onChange={(e) => setCopyTo(e.target.value)}
          aria-describedby="send-copy-help"
          aria-invalid={fieldError ? true : undefined}
          className="input min-w-0 flex-1"
        />
        {stale ? (
          <button type="button" className="btn btn-ghost" onClick={onUpdate}>
            Update preview
          </button>
        ) : null}
      </div>
      {fieldError ? (
        <p className="mt-2 text-accent" role="alert">
          {fieldError}
        </p>
      ) : null}

      {preview ? (
        <figure className="mt-5">
          <figcaption className="font-semibold">What they will get</figcaption>
          <pre className="mt-2 max-h-72 overflow-auto rounded-[4px] border border-rule p-3 font-sans text-base leading-normal whitespace-pre-wrap">{`${preview.text}\n\n${preview.footer}`}</pre>
        </figure>
      ) : null}
      {preview ? (
        <p className="hint mt-2">
          {preview.sendsLeftToday} {preview.sendsLeftToday === 1 ? "send" : "sends"} left today from this connection. This preview expires at{" "}
          {preview.expiresAt.slice(11, 16)} UTC.
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={phase.kind !== "ready" || stale}>
          {confirmLabel(phase.kind, preview)}
        </button>
      </div>
    </div>
  );
}

function SendResult({ result, preview, onView, onDone }: { result: ConfirmResult; preview: Preview; onView: () => void; onDone: () => void }) {
  const ok = result.status === "sent";
  const demo = result.status === "demo_not_sent";
  const at = result.ledgerEntry?.startedAt ? formatClockUtc(result.ledgerEntry.startedAt) : null;
  const n = preview.recipients.length;
  return (
    <div className="mt-4 space-y-4" role="status">
      <p id="send-desc" className={ok || demo ? "" : "note-error"}>
        {ok ? (
          <>
            <span className="font-semibold">
              Sent to {addressCount(n)}
              {at ? ` at ${at}` : ""}.
            </span>{" "}
            Message id <span className="break-all">{result.messageId}</span>, recorded as {result.ledgerEntryId}.
          </>
        ) : demo ? (
          <>
            <span className="font-semibold">Recorded{at ? ` at ${at}` : ""}, not sent.</span> This copy of Walkup can&apos;t send email, so nothing went to the{" "}
            {n === 1 ? "address" : `${n} addresses`}. Recorded as {result.ledgerEntryId}.
          </>
        ) : (
          <>
            <span className="font-semibold">{result.status === "refused" ? "Refused." : "Failed."}</span> {result.reason} Nothing was sent. Recorded as{" "}
            {result.ledgerEntryId}.
          </>
        )}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={onView}>
          View receipt {result.ledgerEntryId}
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
