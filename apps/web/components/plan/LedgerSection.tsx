"use client";
import type { LedgerEntry } from "@walkup/contracts";
import { formatMs } from "../../lib/format";
import { LEDGER_KIND_LABEL, STATUS_LABEL, ledgerNoteText } from "../../lib/labels";
import { FoldBody } from "./fold";
import { receiptAnchor, useReceipts } from "./receipts";

/** Every request and action behind the sheet, as a plain table. Each id opens its receipt. */
export function LedgerSection({ entries, exportHref, sample = false }: { entries: LedgerEntry[]; exportHref: string; sample?: boolean }) {
  const { open } = useReceipts();
  const qloo = entries.filter((e) => e.kind === "qloo");
  const cached = qloo.filter((e) => e.cacheHit).length;
  return (
    <section id="ledger" aria-labelledby="ledger-title" className="section scroll-mt-4">
      <h2 id="ledger-title">Requests behind this sheet</h2>
      <p className="mt-1 max-w-[760px] text-sm text-muted">
        {/* A sample run can reuse its own stand-in answers (a resumed run), so the cache count is said here too. */}
        {sample
          ? `${entries.length} entries, ${qloo.length} of them in Qloo's format (${cached} from cache). Sample data: every answer came from Walkup's made-up stand-in, so nothing was timed.`
          : `${entries.length} entries, ${qloo.length} of them Qloo calls (${cached} from cache).`}{" "}
        Every footnote on this sheet points to one of
        these. Keys show only as environment variable names.{" "}
        <a href={exportHref} download className="link">
          Download sheet.json
        </a>{" "}
        to keep the full ledger.
      </p>
      <FoldBody title="the requests">
      <table className="table mt-4">
        <caption className="sr-only">Every request and action behind this sheet</caption>
        <thead>
          <tr>
            <th scope="col">Id</th>
            <th scope="col" className="hidden md:table-cell">
              Source
            </th>
            <th scope="col">Request</th>
            <th scope="col" className="hidden sm:table-cell">
              Status
            </th>
            <th scope="col" className="num hidden sm:table-cell">
              Time
            </th>
            <th scope="col" className="num hidden md:table-cell">
              Results
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} id={receiptAnchor(e.id)} className="scroll-mt-4">
              <td>
                <button
                  type="button"
                  onClick={() => open(e.id)}
                  aria-haspopup="dialog"
                  className="font-semibold text-accent underline underline-offset-2"
                  aria-label={`Open receipt ${e.id}: ${e.method} ${e.endpoint}`}
                >
                  {e.id}
                </button>
              </td>
              <td className="hidden text-muted md:table-cell">{LEDGER_KIND_LABEL[e.kind]}</td>
              <td className="max-w-0 w-full">
                <span className="block truncate text-base max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere]" title={`${e.method} ${e.endpoint}`}>
                  {e.method === "ACTION" ? "" : <span className="text-muted">{e.method} </span>}
                  {e.endpoint}
                </span>
                {e.note ? <span className="block truncate text-sm text-muted max-sm:whitespace-normal">{ledgerNoteText(e.note)}</span> : null}
              </td>
              <td className={`hidden whitespace-nowrap sm:table-cell ${e.envelopeStatus === "ok" ? "text-muted" : "font-semibold"}`}>{STATUS_LABEL[e.envelopeStatus]}</td>
              <td className="num hidden whitespace-nowrap sm:table-cell">
                {sample ? (
                  <span className="text-muted" aria-label="not timed: sample answer">
                    –
                  </span>
                ) : (
                  <>
                    {e.cacheHit ? <span className="text-muted">cache, </span> : null}
                    {formatMs(e.latencyMs)}
                  </>
                )}
              </td>
              <td className="num hidden md:table-cell">{e.resultCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </FoldBody>
    </section>
  );
}
