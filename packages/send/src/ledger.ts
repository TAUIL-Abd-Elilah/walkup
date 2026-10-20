/**
 * Ledger helpers for send actions. Every confirm writes exactly one `A#`
 * entry: kind "action", method "ACTION", endpoint "resend.emails.send".
 * Recipients appear only in their redacted form.
 */
import type { EnvelopeStatus, LedgerEntry, LedgerKind, LedgerSink } from "@walkup/contracts";
import { LEDGER_ENDPOINT } from "./constants";

const PREFIX: Readonly<Record<LedgerKind, string>> = { qloo: "Q", tm: "T", places: "P", acs: "C", anthropic: "L", action: "A" };

/**
 * A LedgerSink that continues a sheet's numbering: with `A1` and `A2` already
 * on the sheet, the next action is `A3`. Use it when appending a send to a
 * stored sheet's ledger.
 */
export function createSheetLedger(existing: readonly LedgerEntry[] = []): LedgerSink {
  const list: LedgerEntry[] = [...existing];
  const counters: Record<string, number> = {};
  for (const e of existing) {
    const m = /^([A-Z])(\d+)$/.exec(e.id);
    if (!m) continue;
    const p = m[1] as string;
    counters[p] = Math.max(counters[p] ?? 0, Number(m[2]));
  }
  return {
    add(entry) {
      const p = PREFIX[entry.kind];
      counters[p] = (counters[p] ?? 0) + 1;
      const id = `${p}${counters[p]}`;
      list.push({ ...entry, id });
      return id;
    },
    entries() {
      return [...list];
    },
  };
}

export interface ActionEntryInput {
  planId: string | null;
  recipients: string[];
  attachments: string[];
  subject: string | null;
  httpStatus: number | null;
  envelopeStatus: EnvelopeStatus;
  latencyMs: number;
  bytes: number;
  resultCount: number;
  startedAt: string;
  note: string;
  /** Hashed token id, so a refusal and the prepare it refers to can be matched. */
  tokenRef: string | null;
  live: boolean;
}

export function actionEntry(input: ActionEntryInput): Omit<LedgerEntry, "id"> {
  return {
    kind: "action",
    method: "ACTION",
    endpoint: LEDGER_ENDPOINT,
    params: {
      planId: input.planId,
      recipients: input.recipients,
      recipientCount: input.recipients.length,
      attachments: input.attachments,
      subject: input.subject,
      token: input.tokenRef,
      provider: input.live ? "resend" : "none (demo)",
    },
    httpStatus: input.httpStatus,
    envelopeStatus: input.envelopeStatus,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    bytes: input.bytes,
    cacheHit: false,
    resultCount: input.resultCount,
    curl: "",
    startedAt: input.startedAt,
    note: input.note,
  };
}
