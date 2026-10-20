"use client";
import { useState } from "react";
import { checkInstruction, type ReviseHandler } from "./model";

/**
 * "Change something": one plain-words instruction that re-plans this sheet.
 * The page passes `onRevise` (a server action or a client helper); without one
 * the box is not rendered, so the page never offers a change it cannot make.
 * A revised plan opens through `onOpen` (the page navigates to it).
 */
export function ReviseBox({ onRevise, onOpen, disabledReason }: { onRevise: ReviseHandler; onOpen: (planId: string) => void; disabledReason?: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "question"; text: string } | null>(null);

  const submit = async () => {
    const checked = checkInstruction(text);
    if (!checked.ok) {
      setMessage({ kind: "error", text: checked.message });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const r = await onRevise(checked.text);
      if (r.planId) {
        onOpen(r.planId);
        return;
      }
      if (r.question) setMessage({ kind: "question", text: r.question });
      else setMessage({ kind: "error", text: r.reason ?? "Nothing changed. Try saying it another way." });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "The change didn't go through. Try again." });
    }
    setBusy(false);
  };

  return (
    <section id="revise" aria-labelledby="revise-title" className="section scroll-mt-4 no-print">
      <h2 id="revise-title">Change something</h2>
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
          For example: all ages, no bars, street team only on Saturday, within 10 km of the room. Up to 280 characters. Walkup makes a new version of this plan
          and lists what changed; this one stays as it is.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            id="revise-input"
            className="input min-w-[12rem] flex-1"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (message?.kind === "error") setMessage(null);
            }}
            maxLength={280}
            autoComplete="off"
            aria-describedby={`revise-hint${message ? " revise-message" : ""}`}
            aria-invalid={message?.kind === "error" ? true : undefined}
            disabled={busy || Boolean(disabledReason)}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || Boolean(disabledReason)}>
            {busy ? "Re-planning…" : "Make the change"}
          </button>
        </div>
        <div aria-live="polite">
          {disabledReason ? (
            <p className="hint mt-2">{disabledReason}</p>
          ) : message ? (
            <p id="revise-message" className={message.kind === "question" ? "note-warn mt-3" : "mt-2 text-accent"}>
              {message.kind === "question" ? <span className="font-semibold">One question first: </span> : null}
              {message.text}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
