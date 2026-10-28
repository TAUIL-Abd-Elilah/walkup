"use client";
import { useEffect, useRef, useState } from "react";
import { revisePlan } from "../../lib/api";
import { formatDayMonth } from "../../lib/format";
import { checkInstruction, openingLine, parseReadyMade, readAsLine, readerLine, recordedOutcome, type ReadyMade, type ReviseHandler, type ReviseReading } from "./model";

/** How long the reading stays on screen before a ready-made change opens (ms). */
export const OPEN_DELAY_MS = 1800;

/** The recorded-mode handler: POST /api/plan/<id>/revise, answered from the sheet's ready-made changes. */
export function recordedRevise(planId: string): ReviseHandler {
  return async (instruction) => {
    const r = await revisePlan(planId, instruction);
    if (!r.ok) return { reason: r.reason };
    return recordedOutcome(r.body);
  };
}

type Message =
  | { kind: "error" | "question" | "notice"; text: string; reading?: ReviseReading }
  | { kind: "opening"; text: string; reading?: ReviseReading; planId: string };

/**
 * "Change something": one plain-words instruction that re-plans this sheet.
 * The page passes `onRevise` (a server action or a client helper); without one
 * the box is not rendered, so the page never offers a change it cannot make.
 * A revised plan opens through `onOpen` (the page navigates to it).
 *
 * Recorded mode (live runs paused): the page passes `recordedPlanId` instead. The box asks the server for the
 * sheet's ready-made changes and stays hidden when there are none; the note is read as in live mode and the version
 * made ahead for the same change opens, after the reading is shown. `readyMade` skips the fetch (tests).
 */
export function ReviseBox({
  onRevise,
  onOpen,
  disabledReason,
  recordedPlanId,
  readyMade: given,
}: {
  onRevise?: ReviseHandler;
  onOpen: (planId: string) => void;
  disabledReason?: string;
  recordedPlanId?: string;
  readyMade?: ReadyMade;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [fetched, setFetched] = useState<ReadyMade | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // The page may pass a new onOpen on every render; the timer below must not restart because of it.
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  });
  const recorded = Boolean(recordedPlanId);
  const readyMade = given ?? fetched;

  useEffect(() => {
    if (!recordedPlanId || given) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/plan/${encodeURIComponent(recordedPlanId)}/ready-made`, { cache: "no-store" });
        const body: unknown = res.ok ? await res.json() : null;
        if (live) setFetched(parseReadyMade(body));
      } catch {
        if (live) setFetched(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [recordedPlanId, given]);

  // A matched ready-made change opens once its reading has been on screen for a moment.
  useEffect(() => {
    if (message?.kind !== "opening") return;
    const id = message.planId;
    const t = setTimeout(() => openRef.current(id), OPEN_DELAY_MS);
    return () => clearTimeout(t);
  }, [message]);

  const handler: ReviseHandler | null = onRevise ?? (recordedPlanId ? recordedRevise(recordedPlanId) : null);
  if (!handler || (recorded && !readyMade)) return null;

  const submit = async () => {
    const checked = checkInstruction(text);
    if (!checked.ok) {
      setMessage({ kind: "error", text: checked.message });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const r = await handler(checked.text);
      const reading = r.reading ? { reading: r.reading } : {};
      if (r.planId && r.recorded) {
        setMessage({ kind: "opening", text: openingLine(r.recorded, formatDayMonth), planId: r.planId, ...reading });
        return;
      }
      if (r.planId) {
        onOpen(r.planId);
        return;
      }
      if (r.question) setMessage({ kind: "question", text: r.question, ...reading });
      else if (r.notice) setMessage({ kind: "notice", text: r.notice, ...reading });
      else setMessage({ kind: "error", text: r.reason ?? "Nothing changed. Try saying it another way." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "The change didn't go through. Try again." });
    }
    setBusy(false);
  };

  const fill = (note: string) => {
    setText(note);
    setMessage(null);
    input.current?.focus();
  };

  const readAs = message?.reading ? readAsLine(message.reading.toolCalls) : null;
  const locked = busy || message?.kind === "opening" || Boolean(disabledReason);

  return (
    <section id="revise" aria-labelledby="revise-title" className="section scroll-mt-4 no-print">
      <h2 id="revise-title">Change something</h2>
      {recorded ? (
        <p className="mt-1 max-w-[760px] text-muted" data-testid="revise-recorded-line">
          Live runs are paused for judging. Walkup reads your note now and, if it asks for one of the changes recorded ahead for this sheet (listed
          below), opens that version. Nothing is sent to Qloo.
        </p>
      ) : null}
      <form
        className="mt-3 max-w-[760px]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-busy={busy}
      >
        <label htmlFor="revise-input" className="label">
          What should change?
        </label>
        <p id="revise-hint" className="hint mt-0.5">
          {recorded
            ? `Up to 280 characters. ${readyMade?.reader === "model" ? "Claude reads" : "Fixed rules read"} your note on this server${readyMade?.reader === "model" ? "" : " (it has no model key)"}; the earlier plan stays as it is.`
            : "For example: all ages, no bars, street team only on Saturday, within 10 km of the room. Up to 280 characters. Walkup makes a new version of this plan and lists what changed; this one stays as it is."}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id="revise-input"
            ref={input}
            className="input min-w-[12rem] flex-1"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (message?.kind === "error" || message?.kind === "notice") setMessage(null);
            }}
            maxLength={280}
            autoComplete="off"
            aria-describedby={`revise-hint${message ? " revise-message" : ""}`}
            aria-invalid={message?.kind === "error" ? true : undefined}
            disabled={locked}
          />
          <button type="submit" className="btn btn-primary" disabled={locked}>
            {message?.kind === "opening" ? "Opening…" : busy ? (recorded ? "Reading…" : "Re-planning…") : "Make the change"}
          </button>
        </div>
        <div aria-live="polite">
          {disabledReason ? (
            <p className="hint mt-2">{disabledReason}</p>
          ) : message ? (
            <div id="revise-message" className="mt-3">
              {message.reading && message.kind !== "error" ? (
                <p className="text-muted">
                  {readerLine(message.reading.interpreter)}
                  {readAs ? ` ${readAs}` : ""}
                </p>
              ) : null}
              {message.kind === "question" ? (
                <p className="note-warn mt-2">
                  <span className="font-semibold">One question first: </span>
                  {message.text}
                </p>
              ) : message.kind === "error" ? (
                <p className="text-accent">{message.text}</p>
              ) : message.kind === "opening" ? (
                <p className="mt-1">
                  {message.text}{" "}
                  <a href={`/plan/${encodeURIComponent(message.planId)}`} className="link">
                    Open it now
                  </a>
                </p>
              ) : (
                <p className="mt-1">{message.text}</p>
              )}
            </div>
          ) : null}
        </div>
      </form>
      {recorded && readyMade ? (
        <div className="mt-4 max-w-[760px]" data-testid="ready-made">
          <p className="text-muted">Recorded ahead for this sheet. Pick one to fill the box:</p>
          <ul className="mt-1">
            {readyMade.changes.map((c) => (
              <li key={c.planId} className="mt-1">
                <button type="button" className="link text-left" onClick={() => fill(c.instruction)} disabled={locked}>
                  {c.instruction}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
