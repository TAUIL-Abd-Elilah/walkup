"use client";
/**
 * Parts of the sheet that render only when the run wrote them: the discovery
 * callout, the step list and the revision note. Each takes its contract type
 * and nothing else from the page, so the live view can reuse them.
 */
import type { RevisionChange, SheetDiscovery, SheetRevision, TraceStep } from "@walkup/contracts";
import { STEP_STATUS_WORD } from "../../lib/labels";
import { changeCountLine, groupChanges, readAsLine } from "./model";
import { Refs } from "./receipts";

/** A plain section after the Summary: the pick a stated rule calls out, with its receipts and a link to it on the sheet. */
export function DiscoveryNote({
  discovery,
  target,
  onGo,
}: {
  discovery: SheetDiscovery;
  target: { href: string; label: string } | null;
  /** Called before following the link (selects the tile when the pick is an area). */
  onGo?: () => void;
}) {
  return (
    <section id="discovery" aria-labelledby="discovery-title" className="section scroll-mt-4">
      <h2 id="discovery-title">{discovery.kind === "partner" ? "Start with this place" : "Start in this area"}</h2>
      <p className="mt-2 max-w-[760px] font-semibold">
        {discovery.headline}
        <Refs ids={discovery.ledgerRefs} />
      </p>
      <p className="mt-1 max-w-[760px]">{discovery.detail}</p>
      <p className="mt-1 max-w-[760px] text-sm text-muted">
        Why this one: {discovery.why ?? `${discovery.rule.charAt(0).toLowerCase()}${discovery.rule.slice(1).replace(/\.$/, "")}`}.
        {target ? (
          <>
            {" "}
            <a href={target.href} className="link" onClick={onGo}>
              {target.label}
            </a>
            .
          </>
        ) : null}
      </p>
    </section>
  );
}

/**
 * The step list: what was decided at each step, in run order. `live` marks it
 * as filling in (the live view passes steps as they stream).
 */
export function StepList({
  steps,
  live = false,
  working,
  headingLevel = 2,
}: {
  steps: readonly TraceStep[];
  live?: boolean;
  /** During a live run, the muted last line: what the run is on now ("Finding partners…"). No spinner. */
  working?: string | null;
  headingLevel?: 2 | 3;
}) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section id="steps" aria-labelledby="steps-title" className={headingLevel === 2 ? "section scroll-mt-4" : "mt-6"}>
      <H id="steps-title" className={headingLevel === 2 ? undefined : "text-base"}>
        What Walkup decided
      </H>
      {live ? <p className="hint mt-0.5">Each step is added as the run reaches it.</p> : null}
      {steps.length === 0 ? (
        <p className="mt-2 text-muted">{live ? (working ?? "Waiting for the first step.") : "No steps were recorded for this sheet."}</p>
      ) : (
        <>
          <ol className="mt-3 max-w-[760px] list-decimal space-y-2 pl-6" aria-live={live ? "polite" : undefined}>
            {steps.map((s) => {
              const word = STEP_STATUS_WORD[s.status];
              // Line 1: label, the status word when it isn't ok, the decision. Line 2 (muted): what led to it, with the receipts.
              return (
                <li key={s.id} className={`pl-1 ${s.status === "empty" ? "text-muted" : ""}`} data-status={s.status}>
                  <span className="font-semibold">{s.label}.</span>{" "}
                  {word ? <span className={`font-semibold ${s.status === "error" ? "text-accent" : ""}`}>{word}: </span> : null}
                  {s.decision}
                  {s.cause ? null : <Refs ids={s.ledgerRefs} />}
                  {s.cause ? (
                    <span className="mt-0.5 block text-sm text-muted">
                      {s.cause}
                      <Refs ids={s.ledgerRefs} />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {live && working ? <p className="mt-2 max-w-[760px] text-muted">{working}</p> : null}
        </>
      )}
    </section>
  );
}

/** How many changes a group lists before the rest fold into "N more". */
const GROUP_SHOWN = 5;

function ChangeItem({ c, look }: { c: RevisionChange; look: "added" | "removed" | "changed" }) {
  return (
    <li>
      {look === "removed" ? <del className="text-muted">{c.label}</del> : c.label}
      {look === "added" ? <span className="text-sm text-muted"> new</span> : null}
      <Refs ids={c.ledgerRefs} />
      {c.detail ? <span className="block text-base text-muted">{c.detail}</span> : null}
    </li>
  );
}

/** One group of changes. Removed items are struck through in the muted colour; added ones are marked "new". */
function ChangeGroup({ title, items, look }: { title: string; items: RevisionChange[]; look: "added" | "removed" | "changed" }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, GROUP_SHOWN);
  const rest = items.slice(GROUP_SHOWN);
  return (
    <div className="min-w-0">
      <h3 className="text-base">
        {title} <span className="font-normal text-muted">({items.length})</span>
      </h3>
      <ul className="mt-1 space-y-1">
        {shown.map((c, i) => (
          <ChangeItem key={`${c.kind}-${c.label}-${i}`} c={c} look={look} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-sm text-muted">{rest.length} more</summary>
          <ul className="mt-1 space-y-1">
            {rest.map((c, i) => (
              <ChangeItem key={`${c.kind}-${c.label}-${i}`} c={c} look={look} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** The banner on a revised sheet: what was asked, how it was read, and what changed from the earlier plan. */
export function RevisionNote({ revision }: { revision: SheetRevision }) {
  const groups = groupChanges(revision.changes);
  const readAs = readAsLine(revision.toolCalls);
  return (
    <section id="revision" aria-labelledby="revision-title" className="mt-6 max-w-[760px] border-y border-rule py-4">
      <h2 id="revision-title" className="text-lg">
        Revised plan
      </h2>
      <p className="mt-1">
        This version: &ldquo;{revision.instruction}&rdquo;.{" "}
        <a href={`/plan/${encodeURIComponent(revision.parentPlanId)}`} className="link">
          Open the earlier plan
        </a>
        .
      </p>
      {readAs ? <p className="mt-1">{readAs}</p> : null}
      {revision.question ? (
        <p className="note-warn mt-3">
          <span className="font-semibold">Walkup needs an answer before it changes anything: </span>
          {revision.question}
        </p>
      ) : (
        <p className="mt-1">{changeCountLine(revision.changes)}</p>
      )}
      <p className="mt-1 text-sm text-muted">
        {revision.interpreter === "model" ? "Claude read the note and chose these changes." : "Fixed rules read the note; no model was called."}
      </p>
      {revision.changes.length > 0 ? (
        <div className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-3">
          <ChangeGroup title="Changed" items={groups.changed} look="changed" />
          <ChangeGroup title="Removed" items={groups.removed} look="removed" />
          <ChangeGroup title="Added" items={groups.added} look="added" />
        </div>
      ) : null}
    </section>
  );
}
