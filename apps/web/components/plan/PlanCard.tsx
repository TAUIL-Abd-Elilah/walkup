"use client";
import type { ReactNode } from "react";
import type { Envelope } from "@walkup/contracts";
import { STATUS_WORD } from "../../lib/labels";
import { plainText, sourceLine } from "../../lib/sheet-utils";
import { useContext } from "react";
import { FoldBody, FoldContext } from "./fold";
import { Refs, useReceipts } from "./receipts";

/**
 * One part of the sheet as a document section: a rule above, a plain heading
 * with the status said in words beside it, one muted source line (which data,
 * when, how much from cache, and the receipts), the summary in body text, then
 * the body. Only a pause for the operator gets the yellow row.
 */
export function PlanCard<T>({
  id,
  title,
  count,
  envelope,
  summary,
  children,
  aside,
  wide = false,
}: {
  id: string;
  title: string;
  /** A count said after the heading in the muted colour: "Partners (24)". */
  count?: number;
  envelope: Envelope<T>;
  /** The summary as shown, when the section rewrites the run's own summary. */
  summary?: string;
  children: ReactNode;
  /** Extra words or a control at the right of the heading row. */
  aside?: ReactNode;
  /** Use the 1100px band (maps and tables) instead of the reading width for the body. */
  wide?: boolean;
}) {
  const { entries, sample = false } = useReceipts();
  const titleId = `${id}-title`;
  const word = STATUS_WORD[envelope.status];
  // Some reasons repeat the status first ("degraded: tag baseline ..."); the word beside the heading already says it.
  const raw = envelope.reason?.replace(/^(ok|empty|needs[_ ]input|partial|degraded|error)\s*:\s*/i, "");
  const reason = raw ? plainText(raw) : raw;
  const source = sourceLine(envelope.provenance, entries, sample);
  const text = summary ?? envelope.summary;
  // A folded section keeps its summary in view and puts the source line with the rest behind "Show".
  const folded = useContext(FoldContext);
  const sourceEl = source ? (
    <p className="mt-1 max-w-[760px] text-sm text-muted" data-testid="source-line">
      {source}
      <Refs ids={envelope.provenance} />
    </p>
  ) : null;
  return (
    <section id={id} aria-labelledby={titleId} className="section scroll-mt-4">
      {/* One piece on paper: a long heading wraps the row onto more lines, and a page must not break between them. */}
      <div className="print-avoid-break flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={titleId}>
          {title}
          {count !== undefined ? <span className="font-normal text-muted"> ({count})</span> : null}
        </h2>
        {word ? <span className={`text-base ${envelope.status === "error" ? "font-semibold text-accent" : "text-muted"}`}>{word}</span> : null}
        {aside ? <div className="ml-auto">{aside}</div> : null}
      </div>
      {folded ? null : sourceEl}
      {text ? (
        <p className="mt-2 max-w-[760px]">
          {text}
          {source ? null : <Refs ids={envelope.provenance} />}
        </p>
      ) : null}
      <FoldBody title={title}>
      {folded ? sourceEl : null}
      {reason ? (
        envelope.status === "needs_input" ? (
          <p className="note-warn mt-3 max-w-[760px]">{reason}</p>
        ) : envelope.status === "error" ? (
          <p className="note-error mt-3 max-w-[760px]">{reason}</p>
        ) : (
          <p className="mt-2 max-w-[760px] text-base">
            <span className="font-semibold">Why: </span>
            {reason}
          </p>
        )
      ) : null}
      <div className={`mt-5 ${wide ? "" : "max-w-[760px]"}`}>{children}</div>
      {envelope.limits.length > 0 ? (
        <p className="mt-4 max-w-[760px] text-sm text-muted">
          {envelope.limits.length === 1 ? envelope.limits[0] : envelope.limits.join(" ")}
        </p>
      ) : null}
      </FoldBody>
    </section>
  );
}
