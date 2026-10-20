"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Bill, Candidate, Envelope, EnvelopeStatus, ExplainContribution, LedgerEntry, Resolution, TraceStep } from "@walkup/contracts";
import { actsLine, formatShowDate, headlinerName, joinAnd } from "../../lib/format";
import { CARD_TITLE, STATUS_WORD } from "../../lib/labels";
import { CandidatePicker } from "./CandidatePicker";
import { mergeStep, parseStep } from "./model";
import { ReceiptContext } from "./receipts";
import { ReceiptDrawer, type DrawerTarget } from "./ReceiptDrawer";
import { ResolutionCard } from "./ResolutionCard";
import { StepList } from "./SheetExtras";

/** Card keys in stream order (mirrors CARD_ORDER in @walkup/orchestrator). */
export const LIVE_CARD_ORDER = ["resolution", "liftMap", "partners", "declared", "prePost", "media", "demographics", "whatsDifferent", "copyHooks"] as const;
type CardKey = (typeof LIVE_CARD_ORDER)[number];

export interface LiveCard {
  key: string;
  envelope: Envelope<unknown>;
}

export interface LivePending {
  input: string;
  candidates: Candidate[];
}

export interface PlanLiveProps {
  planId: string;
  mode: "live" | "fixture";
  title: string;
  status: "running" | "needs_input" | "error";
  cards: LiveCard[];
  pending?: LivePending[];
  resolution?: Envelope<Resolution[]>;
  bill?: Bill;
  error?: string;
  /** The plan resolves picks under this id (a preset id for a preset's recorded pause). */
  resolveId: string;
  /** A preset's recorded sheet, for skipping the pick. */
  recordedHref?: string;
  /** Calls made so far (receipts for the resolution section while paused). */
  ledger?: LedgerEntry[];
  /** Steps already known when the page rendered (more arrive as `step` events). */
  steps?: TraceStep[];
  /** A preset's one-line note about the pause, shown only while the run waits for a pick. */
  line?: string;
}

/** What the run is on while a section is missing: the muted last line of the step list. No spinner. */
const WORKING_ON: Record<CardKey, string> = {
  resolution: "Matching the acts and the venue…",
  liftMap: "Mapping where this crowd stands out…",
  partners: "Finding partners…",
  declared: "Ranking your list…",
  prePost: "Finding spots for before and after the show…",
  media: "Finding podcasts and a sponsor…",
  demographics: "Reading the age mix…",
  whatsDifferent: "Comparing this crowd with the usual one…",
  copyHooks: "Writing copy lines…",
};

const NO_EXPLAIN = new Map<string, { name: string; contributions: ExplainContribution[] }>();

type R = Record<string, unknown>;
const isObj = (v: unknown): v is R => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A few short items that show what a section holds while the rest stream in. */
export function previewLines(key: string, results: unknown): string[] {
  const list = Array.isArray(results) ? (results as unknown[]) : [];
  switch (key as CardKey) {
    case "resolution":
      return list.filter(isObj).map((r) => {
        const e = isObj(r.entity) ? str(r.entity.name) : isObj(r.proxy) && isObj(r.proxy.entity) ? `${str(r.proxy.entity.name)} standing in` : "";
        return e && e !== str(r.input) ? `${str(r.input)}: ${e}` : str(r.input);
      });
    case "liftMap": {
      const tiles = isObj(results) && Array.isArray(results.tiles) ? (results.tiles as unknown[]).filter(isObj) : [];
      return tiles
        .filter((t) => (num(t.lift) ?? 0) >= 1.3)
        .sort((a, b) => (num(b.lift) ?? 0) - (num(a.lift) ?? 0))
        .slice(0, 5)
        .map((t) => `${str(t.name) || str(t.geohash)} ${(num(t.lift) ?? 0).toFixed(2)}x`);
    }
    case "partners":
      return list
        .filter(isObj)
        .slice(0, 6)
        .map((p) => (isObj(p.entity) ? str(p.entity.name) : ""));
    case "declared":
      return list.filter(isObj).map((d) => `${isObj(d.declared) ? str(d.declared.label) : ""}${num(d.rank) !== null ? ` (rank ${num(d.rank)})` : ""}`);
    case "prePost":
      return list.filter(isObj).map((p) => (isObj(p.entity) ? str(p.entity.name) : ""));
    case "media":
      return list.filter(isObj).map((m) => (isObj(m.entity) ? str(m.entity.name) : ""));
    case "whatsDifferent":
      return isObj(results) && Array.isArray(results.a)
        ? (results.a as unknown[])
            .filter(isObj)
            .slice(0, 6)
            .map((t) => str(t.name))
        : [];
    case "copyHooks":
      return list.filter(isObj).map((h) => `“${str(h.text)}”`);
    default:
      return [];
  }
}

function LiveRow({ k, env }: { k: string; env: Envelope<unknown> | undefined }) {
  const lines = env ? previewLines(k, env.results).filter(Boolean) : [];
  const word = env ? STATUS_WORD[env.status as EnvelopeStatus] : "";
  return (
    <li className="border-b border-rule py-3" aria-busy={!env}>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 className={`text-lg ${env ? "" : "text-muted"}`}>{CARD_TITLE[k] ?? k}</h2>
        <span className={`text-base ${env?.status === "error" ? "font-semibold text-accent" : "text-muted"}`}>{env ? word : "Waiting"}</span>
      </div>
      {env ? (
        <>
          <p className="mt-0.5 max-w-[760px] text-muted">{env.summary}</p>
          {env.reason ? (
            <p className="mt-1 max-w-[760px] text-base">
              <span className="font-semibold">Why: </span>
              {env.reason.replace(/^(ok|empty|needs[_ ]input|partial|degraded|error)\s*:\s*/i, "")}
            </p>
          ) : null}
          {lines.length > 0 ? <p className="mt-1 max-w-[760px] text-base">{lines.slice(0, 6).join("; ")}</p> : null}
          {env.provenance.length > 0 ? <p className="mt-1 text-sm text-muted">Receipts {env.provenance.join(", ")}, on the finished sheet.</p> : null}
        </>
      ) : null}
    </li>
  );
}

/**
 * A plan that is still running or waiting for a pick. Sections appear as the
 * server streams them (acts and venue first, copy lines last), and decision
 * steps fill in when the server sends them. A needs_input pause shows the
 * candidates, and one click resumes the run. When the run completes, the page
 * reloads into the full sheet.
 */
export function PlanLive(props: PlanLiveProps) {
  const router = useRouter();
  const [status, setStatus] = useState(props.status);
  const [cards, setCards] = useState<Record<string, Envelope<unknown>>>(() => Object.fromEntries(props.cards.map((c) => [c.key, c.envelope])));
  const [steps, setSteps] = useState<TraceStep[]>(props.steps ?? []);
  const [pending, setPending] = useState<LivePending[]>(props.pending ?? []);
  const [resolution, setResolution] = useState<Envelope<Resolution[]> | undefined>(props.resolution);
  const [bill, setBill] = useState<Bill | undefined>(props.bill);
  const [error, setError] = useState<string | undefined>(props.error);
  const [generation, setGeneration] = useState(0);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (status !== "running") return;
    const es = new EventSource(`/api/plan/${encodeURIComponent(props.planId)}/stream`);
    es.addEventListener("card", (ev) => {
      const d = JSON.parse((ev as MessageEvent<string>).data) as { key: string; envelope: Envelope<unknown> };
      setCards((c) => ({ ...c, [d.key]: d.envelope }));
      setLost(false);
    });
    es.addEventListener("step", (ev) => {
      let data: unknown = null;
      try {
        data = JSON.parse((ev as MessageEvent<string>).data);
      } catch {
        return;
      }
      const step = parseStep(data);
      if (step) setSteps((s) => mergeStep(s, step));
    });
    es.addEventListener("needs_input", (ev) => {
      const d = JSON.parse((ev as MessageEvent<string>).data) as { pending: LivePending[]; resolution: Envelope<Resolution[]>; bill: Bill };
      setPending(d.pending);
      setResolution(d.resolution);
      setBill(d.bill);
    });
    es.addEventListener("done", (ev) => {
      const d = JSON.parse((ev as MessageEvent<string>).data) as { status: "complete" | "needs_input" | "error"; error?: string };
      es.close();
      if (d.status === "complete") {
        setStatus("running");
        router.refresh();
      } else if (d.status === "needs_input") setStatus("needs_input");
      else {
        setError(d.error ?? "The run stopped.");
        setStatus("error");
      }
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) setLost(true);
    };
    return () => es.close();
  }, [status, props.planId, generation, router]);

  const onResolved = (newId: string) => {
    if (newId !== props.planId) {
      router.push(`/plan/${newId}`);
      return;
    }
    setCards({});
    setSteps([]);
    setPending([]);
    setStatus("running");
    setGeneration((g) => g + 1);
  };

  const done = useMemo(() => LIVE_CARD_ORDER.filter((k) => cards[k]).length, [cards]);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const entries = useMemo(() => props.ledger ?? [], [props.ledger]);
  const open = useCallback((ref: string) => setDrawer({ ref }), []);
  const ctx = useMemo(() => ({ entries, open, sample: props.mode === "fixture" }), [entries, open, props.mode]);
  const next = LIVE_CARD_ORDER.find((k) => !cards[k]);
  const working = status === "running" && next ? WORKING_ON[next] : null;

  // The tab title says what the run is waiting on.
  useEffect(() => {
    document.title = `${props.title} (${status === "needs_input" ? "needs your pick" : status === "running" ? "planning" : "stopped"}) · Walkup`;
  }, [status, props.title]);
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of pending) for (const c of p.candidates) m.set(c.entityId, c.name);
    return m;
  }, [pending]);
  const waitingFor = pending.map((p) => `“${p.input}”`).join(" and ");
  const others = bill ? bill.acts.filter((a) => a.name !== headlinerName(bill)).map((a) => a.name) : [];

  return (
    <ReceiptContext.Provider value={ctx}>
      <div className="wrap-wide pt-6 pb-8">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link href="/#sheets" className="underline-offset-2 hover:text-ink hover:underline">
            Sheets
          </Link>{" "}
          / {bill ? `${bill.venue.name}, ${formatShowDate(bill.date)}` : "Planning"}
        </nav>
        <header className="mt-5 max-w-[760px]">
          {/* The same identity block as the finished sheet: the headliner in 600, the rest of the bill in 400. */}
          <h1>
            {bill ? headlinerName(bill) || actsLine(bill) : props.title}
            {others.length > 0 ? <span className="font-normal"> with {joinAnd(others)}</span> : null}
          </h1>
          {bill ? (
            <p className="mt-2">
              {bill.venue.name}, {bill.venue.city}
              {bill.venue.state ? `, ${bill.venue.state}` : ""}. {formatShowDate(bill.date)}.
            </p>
          ) : null}
          <p className="mt-1 text-sm text-muted">{props.mode === "fixture" ? "Sample street sheet" : "Street sheet"}</p>
          <p className="mt-2 text-muted" aria-live="polite">
            {status === "running"
              ? done === LIVE_CARD_ORDER.length
                ? "Every section is in. Opening the full sheet…"
                : `Planning: ${done} of ${LIVE_CARD_ORDER.length} sections in.`
              : status === "needs_input"
                ? `Paused before planning: Walkup needs you to pick ${waitingFor || "an act"}.`
                : "Stopped."}
          </p>
        </header>
        {lost && status === "running" ? (
          <p className="note-error mt-4 max-w-[760px]" role="alert">
            The connection to the run dropped.{" "}
            <button type="button" className="underline underline-offset-2" onClick={() => router.refresh()}>
              Reload the plan
            </button>
            .
          </p>
        ) : null}

        {status === "needs_input" ? (
          <div className="mt-2">
            {props.line ? <p className="mt-2 max-w-[760px] text-muted">{props.line}</p> : null}
            {/* The one decision first: which entry is on this bill. */}
            {pending.map((p) => (
              <CandidatePicker key={p.input} planId={props.resolveId} input={p.input} candidates={p.candidates} onResolved={onResolved} sample={props.mode === "fixture"} />
            ))}
            {props.recordedHref ? (
              <p className="mt-2 max-w-[760px] text-muted">
                Or{" "}
                <Link href={props.recordedHref} className="link">
                  open the recorded sheet
                </Link>
                , made when this sample was generated, with the pick an operator would make.
              </p>
            ) : null}
            {resolution ? (
              <details className="mt-8 border-t border-rule pt-4">
                <summary className="cursor-pointer font-semibold">How each act was matched</summary>
                <ResolutionCard envelope={{ ...resolution, reason: undefined }} planId={props.resolveId} onResolved={onResolved} pickers={false} />
              </details>
            ) : null}
          </div>
        ) : status === "error" ? (
          <section className="section mt-6" role="alert" aria-labelledby="stopped-title">
            <h2 id="stopped-title">The run stopped</h2>
            <p className="note-error mt-2 max-w-[760px]">{error}</p>
            <p className="mt-3">
              <Link href="/#sheets" className="link">
                Back to the sheets
              </Link>{" "}
              to start again.
            </p>
          </section>
        ) : (
          <>
            <StepList steps={steps} live working={working} />
            <ol className="mt-6 border-t border-rule" aria-label="Sections as they arrive">
              {LIVE_CARD_ORDER.map((k) => (
                <LiveRow key={k} k={k} env={cards[k]} />
              ))}
            </ol>
          </>
        )}
      </div>
      <ReceiptDrawer target={drawer} entries={entries} explain={NO_EXPLAIN} entityNames={names} onClose={() => setDrawer(null)} sample={props.mode === "fixture"} />
    </ReceiptContext.Provider>
  );
}
