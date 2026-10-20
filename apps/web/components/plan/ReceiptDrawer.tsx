"use client";
import { useRef, useState } from "react";
import type { ExplainContribution, LedgerEntry } from "@walkup/contracts";
import { formatBytes, formatMs, formatStampSeconds } from "../../lib/format";
import { LEDGER_KIND_LABEL, STATUS_LABEL, ledgerNoteText } from "../../lib/labels";
import { useDialog } from "./useDialog";

export interface DrawerTarget {
  ref: string;
  entityId?: string;
}

/** Parameter values; a list (or a comma-separated tag list) is one item per line so long urns never break mid-word. */
function paramLines(v: LedgerEntry["params"][string]): string[] {
  if (v === null) return ["null"];
  if (Array.isArray(v)) return v.map(String);
  const s = String(v);
  return s.includes(",") && /urn:|^[\w:.-]+(,[\w:.-]+)+$/.test(s) ? s.split(",").map((x) => x.trim()).filter(Boolean) : [s];
}

/**
 * A plain side panel for one ledger entry: the request, its parameters with
 * keys redacted, status, time, cache, and copy-as-curl. With an entity, it also
 * lists how much each seed shaped that result.
 */
export function ReceiptDrawer({
  target,
  entries,
  explain,
  entityNames,
  onClose,
  onNavigate,
  sample = false,
}: {
  target: DrawerTarget | null;
  entries: LedgerEntry[];
  /** entityId -> explainability contributions, for partner, spot and media rows */
  explain: Map<string, { name: string; contributions: ExplainContribution[] }>;
  entityNames: Map<string, string>;
  onClose: () => void;
  /** Opens another receipt (Previous / Next in ledger order). */
  onNavigate?: (ref: string) => void;
  /** A sample (fixture) sheet: every answer came from the stand-in, so nothing here may read as a live call. */
  sample?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const open = target !== null;
  useDialog(open, dialogRef, onClose, closeRef);

  if (!target) return null;
  const index = entries.findIndex((e) => e.id === target.ref);
  const entry = index >= 0 ? entries[index] : undefined;
  const prev = index > 0 ? entries[index - 1] : undefined;
  const next = index >= 0 && index < entries.length - 1 ? entries[index + 1] : undefined;
  const subject = target.entityId ? explain.get(target.entityId) : undefined;
  const note = ledgerNoteText(entry?.note);
  const titleId = "receipt-drawer-title";

  const copy = async () => {
    if (!entry?.curl) return;
    try {
      await navigator.clipboard.writeText(entry.curl);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 2500);
  };

  // Keys appear only as environment variable names, in the parameters or the curl line.
  const keyVars = entry
    ? [
        ...new Set([
          ...Object.values(entry.params)
            .flatMap((v) => (Array.isArray(v) ? v : [v]))
            .filter((v): v is string => typeof v === "string" && /^\$[A-Z][A-Z0-9_]*$/.test(v)),
          ...(entry.curl.match(/\$[A-Z][A-Z0-9_]*/g) ?? []),
        ]),
      ]
    : [];
  // On a sample sheet nothing was requested from a live service: no latency, no cache, and the source says so.
  const facts: [string, string][] = entry
    ? [
        ["Source", sample ? (entry.kind === "action" ? "Action (sample)" : `${LEDGER_KIND_LABEL[entry.kind]} format (sample)`) : LEDGER_KIND_LABEL[entry.kind]],
        ["Endpoint", `${entry.method === "ACTION" ? "" : `${entry.method} `}${entry.endpoint}`],
        [sample ? "Generated" : "Requested", formatStampSeconds(entry.startedAt)],
        [
          "Status",
          sample
            ? `${STATUS_LABEL[entry.envelopeStatus]}, ${entry.resultCount} ${entry.resultCount === 1 ? "result" : "results"}`
            : `${entry.httpStatus === null ? "No HTTP status" : `HTTP ${entry.httpStatus}`}, ${STATUS_LABEL[entry.envelopeStatus]}, ${entry.resultCount} ${entry.resultCount === 1 ? "result" : "results"}, ${formatMs(entry.latencyMs)}`,
        ],
        ...(sample ? [] : ([["Cache", entry.cacheHit ? "Hit" : "Miss"], ["Size", formatBytes(entry.bytes)]] as [string, string][])),
        ...(keyVars.length > 0 && !sample ? ([["Key", `Redacted: shown as ${keyVars.join(", ")}`]] as [string, string][]) : []),
      ]
    : [];
  // The claim restated in one sentence: what this request was for, and the place it backs when there is one.
  const claim = entry ? (subject ? `${subject.name}: ${note ? `${note.charAt(0).toLowerCase()}${note.slice(1)}` : entry.endpoint}.` : `${note || entry.endpoint}.`) : "";

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      {/* No scrim: the page stays as it was. A click outside the panel still closes it. */}
      <button type="button" tabIndex={-1} aria-hidden="true" className="absolute inset-0 cursor-default bg-transparent" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full flex-col bg-page sm:max-w-[28rem] sm:border-l sm:border-rule sm:shadow-[0_0_24px_rgb(0_0_0/0.12)]"
      >
        <header className="flex items-start gap-3 border-b border-rule px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg">
              Receipt {target.ref}
            </h2>
            {onNavigate && entries.length > 1 ? (
              <p className="link-row mt-1 text-muted">
                {index >= 0 ? <span>{`Request ${index + 1} of ${entries.length}`}</span> : null}
                <button type="button" className="text-button min-h-[36px]" aria-disabled={!prev} onClick={() => prev && onNavigate(prev.id)}>
                  Previous{prev ? <span className="sr-only">: receipt {prev.id}</span> : null}
                </button>
                <button type="button" className="text-button min-h-[36px]" aria-disabled={!next} onClick={() => next && onNavigate(next.id)}>
                  Next{next ? <span className="sr-only">: receipt {next.id}</span> : null}
                </button>
              </p>
            ) : null}
          </div>
          {/* Full screen under 640px, with Close at the top left. */}
          <button ref={closeRef} type="button" className="btn btn-ghost min-h-[40px] px-3 py-1 text-sm max-sm:order-first" onClick={onClose}>
            Close<span className="sr-only"> receipt</span>
          </button>
        </header>

        {!entry ? (
          <p className="p-5">This receipt isn&apos;t in the ledger for this sheet. The table &ldquo;Requests behind this sheet&rdquo; lists every one it has.</p>
        ) : (
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5 text-base">
            <section aria-label="Request">
              {sample ? (
                <p className="mb-3 font-semibold">
                  {entry.kind === "action"
                    ? "Recorded on a sample sheet: the places and numbers it carried are made up."
                    : `Sample answer from Walkup's stand-in. ${LEDGER_KIND_LABEL[entry.kind]} was not called.`}
                </p>
              ) : null}
              <p>{claim}</p>
              <dl className="mt-3 grid grid-cols-[40%_minmax(0,1fr)] border-t border-rule max-sm:grid-cols-1">
                {facts.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="border-b border-rule py-1.5 pr-3 text-muted max-sm:border-b-0 max-sm:pb-0">{k}</dt>
                    <dd className="tabular border-b border-rule py-1.5 [overflow-wrap:anywhere]">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>

            {subject ? (
              <section aria-labelledby="explain-title">
                <h3 id="explain-title" className="text-base">
                  What shaped this pick
                </h3>
                <p className="hint mt-0.5">
                  How much each act or title contributed to this result, {sample ? "in the sample answer" : "from Qloo"}, on a 0 to 1 scale.
                </p>
                {subject.contributions.length === 0 ? (
                  <p className="mt-2">{sample ? "The sample answer has no breakdown for this result." : "Qloo returned no breakdown for this result."}</p>
                ) : (
                  <table className="table mt-2">
                    <tbody>
                      {subject.contributions.map((c) => (
                        <tr key={c.entityId}>
                          <td className="break-words">{entityNames.get(c.entityId) ?? c.entityId}</td>
                          <td className="num">{c.score.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            ) : null}

            <section aria-labelledby="params-title">
              <h3 id="params-title" className="text-base">
                Parameters
              </h3>
              <p className="hint mt-0.5">
                {sample ? "What a live run would send. Keys show as environment variable names." : "Keys show as environment variable names, never the key itself."}
              </p>
              {Object.keys(entry.params).length === 0 ? (
                <p className="mt-2">None.</p>
              ) : (
                <table className="table mt-2 text-sm">
                  <tbody>
                    {Object.entries(entry.params).map(([k, v]) => (
                      <tr key={k}>
                        <th scope="row" className="w-[40%] font-normal [overflow-wrap:anywhere]">
                          {k}
                        </th>
                        <td className="[overflow-wrap:anywhere]">
                          {paramLines(v).map((line, i) => (
                            <span key={`${k}-${i}`} className="block">
                              {line}
                            </span>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {entry.curl ? (
              <section aria-labelledby="curl-title">
                <div className="flex items-center justify-between gap-3">
                  <h3 id="curl-title" className="text-base">
                    {sample ? "The request a live run would send" : "As a curl command"}
                  </h3>
                  <button type="button" className="btn btn-ghost min-h-0 px-3 py-1 text-sm" onClick={copy}>
                    {copied === "copied" ? "Copied" : copied === "failed" ? "Couldn't copy: select the text" : "Copy"}
                  </button>
                </div>
                {sample ? <p className="hint mt-0.5">Not sent for this sheet. Copy it to try the call with your own key.</p> : null}
                <pre className="mt-2 max-h-56 overflow-auto rounded-[4px] border border-rule bg-subtle p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
                  {entry.curl}
                </pre>
                <p className="sr-only" aria-live="polite">
                  {copied === "copied" ? "curl command copied" : ""}
                </p>
              </section>
            ) : (
              <p className="text-muted">Actions are recorded, not requested, so there is no curl command.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
