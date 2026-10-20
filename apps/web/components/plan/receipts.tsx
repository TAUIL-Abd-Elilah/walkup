"use client";
import { createContext, Fragment, useContext } from "react";
import type { LedgerEntry } from "@walkup/contracts";
import { receiptGroups } from "../../lib/sheet-utils";

export interface ReceiptContextValue {
  entries: LedgerEntry[];
  /** Open the receipt drawer on a ledger id; entityId adds that entity's explainability. */
  open: (ref: string, entityId?: string) => void;
  /** Sample data: section source lines say so instead of "fetched". */
  sample?: boolean;
}

export const ReceiptContext = createContext<ReceiptContextValue | null>(null);

export function useReceipts(): ReceiptContextValue {
  const ctx = useContext(ReceiptContext);
  if (!ctx) throw new Error("useReceipts must be used inside <ReceiptContext.Provider>");
  return ctx;
}

/** The id of a ledger row, so a footnote still lands somewhere without JavaScript. */
export function receiptAnchor(id: string): string {
  return `receipt-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function describe(entries: LedgerEntry[], id: string): string {
  const e = entries.find((x) => x.id === id);
  return e ? `Receipt ${id}: ${e.method === "ACTION" ? "" : `${e.method} `}${e.endpoint}` : `Receipt ${id}`;
}

/**
 * One footnote group after a claim: "North Hills Estates<sup>Q6–Q8, Q13</sup>". Ids are sorted, runs collapse to
 * ranges, and past three groups the rest fold into "+N". Each group opens the receipt drawer on its first id (the
 * drawer steps through the rest) and links to its ledger row without JavaScript. Muted until hovered or focused.
 */
export function Refs({ ids, entityId, className = "" }: { ids: readonly string[]; entityId?: string; className?: string }) {
  const { open, entries } = useReceipts();
  const { groups, hidden } = receiptGroups(ids);
  if (groups.length === 0) return null;
  const link = (id: string, label: string, aria: string) => (
    <a
      href={`#${receiptAnchor(id)}`}
      aria-haspopup="dialog"
      aria-label={aria}
      onClick={(e) => {
        e.preventDefault();
        open(id, entityId);
      }}
    >
      {label}
    </a>
  );
  return (
    <sup className={`fn fn-flat ${className}`}>
      {groups.map((g, i) => (
        <Fragment key={g.label}>
          {i > 0 ? ", " : null}
          {link(g.ids[0]!, g.label, g.ids.length > 1 ? `Receipts ${g.ids[0]} to ${g.ids[g.ids.length - 1]}` : describe(entries, g.ids[0]!))}
        </Fragment>
      ))}
      {hidden.length > 0 ? (
        <>
          {" "}
          {link(hidden[0]!, `+${hidden.length}`, `${hidden.length} more receipts, starting with ${hidden[0]}`)}
        </>
      ) : null}
    </sup>
  );
}

/**
 * Claims as one sentence with a single footnote group at its end: "A, b and c.<sup>Q9, Q13</sup>". `wording`
 * rewrites a label for display (the receipts are unchanged); the run starts with a capital and ends with a full stop.
 */
export function ClaimList({
  chips,
  entityId,
  wording = (l) => l,
}: {
  chips: readonly { label: string; ledgerRef: string }[];
  entityId?: string;
  wording?: (label: string) => string;
}) {
  const parts = chips.map((c) => wording(c.label)).filter((t) => t.trim() !== "");
  if (parts.length === 0) return null;
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const text = `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`;
  return (
    <span>
      {/[.!?]$/.test(text) ? text : `${text}.`}
      <Refs ids={chips.map((c) => c.ledgerRef)} {...(entityId ? { entityId } : {})} />
    </span>
  );
}
