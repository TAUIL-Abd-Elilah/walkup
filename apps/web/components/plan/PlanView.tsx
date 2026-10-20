"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { revisePlan } from "../../lib/api";
import type { ExplainContribution, GuardReport, LedgerEntry, StreetSheet } from "@walkup/contracts";
import { SampleStrip } from "../SampleStrip";
import { actsLine, formatInt, formatShowDate, formatStamp, formatUsd, headlinerName, joinAnd, tMinusDays } from "../../lib/format";
import { streetDaysText } from "@walkup/exports/format";
import { entityIndex, guardNoteText, isThinSignal, sendStatus, sendSteps, sheetTitle } from "../../lib/sheet-utils";
import { CopyHooksCard, DeclaredCard, DifferentCard, MediaCard, PrePostCard } from "./MoreCards";
import { LedgerSection } from "./LedgerSection";
import { LiftCard } from "./LiftCard";
import { discoveryTarget, type ReviseHandler } from "./model";
import { PartnersCard } from "./PartnersCard";
import { ReceiptContext } from "./receipts";
import { ReceiptDrawer, type DrawerTarget } from "./ReceiptDrawer";
import { ResolutionCard } from "./ResolutionCard";
import { ReviseBox } from "./ReviseBox";
import { SendModal } from "./SendModal";
import { DiscoveryNote, RevisionNote, StepList } from "./SheetExtras";

/** What the interactive sheet renders: a finished sheet plus where it came from. */
export interface PlanPayload {
  sheet: StreetSheet;
  /** About-this-sheet note (bundled presets). */
  note: string | null;
  /** preset = bundled preset sheet; store / run = a run this server made. */
  source: "preset" | "store" | "run";
  presetId?: string;
}

export interface PlanViewProps {
  payload: PlanPayload;
  line: string | null;
  realShow: boolean;
  showName?: string;
  /** The other bill in the same room, with its show date, for "The other bill at The Truth: ...". */
  paired: { planId: string; headliner: string; date?: string } | null;
  /** The server is live: a fixture sheet then says it is a sample. */
  runtimeLive: boolean;
  /**
   * The server serves recorded sheets only (Qloo is no longer available): a live sheet says when it was recorded
   * instead of when it was planned, and a fixture sheet says it is a sample.
   */
  recorded?: boolean;
  /** Show "Run it again" (a fresh run of this preset that streams step by step). */
  canRerun: boolean;
  /**
   * Re-plans this sheet from one plain-words instruction (a server action bound to the plan id, or a
   * client helper). The "Change something" box renders only when this is given.
   */
  onRevise?: ReviseHandler;
  /**
   * Show the "Change something" box wired to POST /api/plan/<id>/revise (lib/api.ts `revisePlan`).
   * Ignored when `onRevise` is given. The server page sets it; a server component can't pass a function.
   */
  revisable?: boolean;
}

/** The default revise handler: starts the revision and hands back the new plan id, the question, or why it failed. */
function apiRevise(planId: string): ReviseHandler {
  return async (instruction) => {
    const r = await revisePlan(planId, instruction);
    if (!r.ok) return { reason: r.reason };
    if (r.body.status === "needs_input" && "question" in r.body) return { question: r.body.question };
    return { planId: r.body.planId };
  };
}

const DOWNLOADS: { file: string; label: string; what: string }[] = [
  { file: "pdf", label: "Street sheet PDF", what: "one page to print or forward" },
  { file: "ics", label: "street-team.ics", what: "the street-team days for your calendar" },
  { file: "partners.csv", label: "partners.csv", what: "the call list" },
  { file: "zips.csv", label: "zips.csv", what: "ZIP codes with lift and weight" },
  { file: "pins.csv", label: "pins.csv", what: "map pins with a radius" },
  { file: "offer-codes.csv", label: "offer-codes.csv", what: "codes to create in your ticketing platform" },
  { file: "sheet.json", label: "sheet.json", what: "the whole sheet with its ledger" },
];

/** The "On this sheet" links, in page order. Parts a sheet may not have are left out. */
function contentsFor(opts: { revise: boolean; steps: boolean }): { href: string; label: string }[] {
  return [
    { href: "#lift", label: "Areas" },
    { href: "#partners", label: "Partners" },
    ...(opts.revise ? [{ href: "#revise", label: "Change something" }] : []),
    ...(opts.steps ? [{ href: "#steps", label: "Steps" }] : []),
    { href: "#resolution", label: "Acts and venue" },
    { href: "#declared", label: "Your list" },
    { href: "#prepost", label: "Before and after" },
    { href: "#media", label: "Podcasts" },
    { href: "#hooks", label: "Copy lines" },
    { href: "#limits", label: "Limits" },
    { href: "#ledger", label: "Requests" },
  ];
}

/** "About this sheet" in one sentence. */
function aboutNote(p: PlanPayload, recorded: boolean): string {
  if (p.sheet.mode === "fixture") {
    return "Made with Walkup's sample data, so no live service was called; the venue and area names are real, and every act, business, podcast, brand and number is made up.";
  }
  if (p.source === "preset" && p.note) return p.note;
  if (recorded) return `Recorded from a live run on ${formatStamp(p.sheet.createdAt)} and not refreshed since. Every footnote points to the request that produced the claim.`;
  return "A live run. Every footnote points to the request that produced the claim.";
}

/** "Country", "Comedy": the genre from a Ticketmaster classification ("Music / Country", "Arts & Theatre / Comedy"). */
function genreOnly(classification: string | undefined): string {
  const g = (classification ?? "").split("/").pop()?.trim() ?? "";
  return /^(undefined|other|miscellaneous)$/i.test(g) ? "" : g;
}

/** The header's line of assumed inputs, in plain sentences, honest about blanks. */
function inputsSentences(sheet: StreetSheet, realShow: boolean): string {
  const op = sheet.operator;
  const parts: string[] = [];
  const cap = op.capacity === null ? null : `capacity ${formatInt(op.capacity)}`;
  const budget = op.mediaBudgetUsd === null ? null : `budget ${formatUsd(op.mediaBudgetUsd)}`;
  if (cap && budget) parts.push(`Capacity ${formatInt(op.capacity as number)} and budget ${formatUsd(op.mediaBudgetUsd as number)} are assumed numbers.`);
  else if (cap) parts.push(`Capacity ${formatInt(op.capacity as number)} is an assumed number; no budget entered.`);
  else if (budget) parts.push(`Budget ${formatUsd(op.mediaBudgetUsd as number)} is an assumed number; no capacity entered.`);
  else parts.push("No capacity or budget entered.");
  parts.push(`Radius ${op.radiusKm} km.`);
  const tm = sheet.bill.legalAgeEnforced;
  const listed = tm === true ? "Ticketmaster lists the show as 21+" : tm === false ? "Ticketmaster lists the show as all ages" : "Ticketmaster lists no age policy, so the show is treated as all ages";
  parts.push(op.allAges === true && tm === true ? `${listed}; you set it to all ages.` : `${listed}.`);
  if (sheet.hypothetical) parts.push(realShow ? "The bill, venue and date are public listing facts; Walkup has no sales data for this show." : "Walkup has no sales data for this show.");
  return parts.join(" ");
}

/**
 * Lines about where the data came from are not limits: "About this sheet" says it in one sentence. (Older sheets
 * also said how their Google Places list was searched; withoutControl drops those lines.)
 */
const ABOUT_LINE = /^(Sample data|Venue points for rooms|Venue coordinates in this synthetic fixture|Fixture mode)/;
/** Already said in the header (the what-if note), so not repeated in the limits. */
const HEADER_LINE = /^Planning tool/;
/** Said by the Summary note already ("Written from a fixed template"). */
const TEMPLATE_NO_KEY = /^(The summary came from a fixed template \(no model key\)|Narration by the deterministic template \(llm_off\))/;

/** "Checks removed 0 claims. 4 tags were left out under the data policy (ethnicity, inclusivity, credit card)." */
function checksLine(guard: GuardReport): string {
  const by = guard.deniedByNamespace;
  const classes = by ? Object.keys(by).filter((k) => (by[k] ?? 0) > 0).map((k) => k.replace(/_/g, " ")) : [];
  const n = guard.deniedTagCount;
  const claims = `Checks removed ${guard.dropped} ${guard.dropped === 1 ? "claim" : "claims"}.`;
  if (n === 0) return `${claims} No tag was left out under the data policy.`;
  return `${claims} ${n} ${n === 1 ? "tag was" : "tags were"} left out under the data policy${classes.length > 0 ? ` (${classes.join(", ")})` : ""}.`;
}

function RerunLink({ presetId }: { presetId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ presetId, wait: "none" }) });
      const body = (await res.json().catch(() => ({}))) as { planId?: string; reason?: string };
      if (!res.ok || !body.planId) throw new Error(body.reason ?? `The server answered ${res.status}.`);
      router.push(`/plan/${body.planId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <span>
      <button type="button" className="text-button" onClick={() => void run()} disabled={busy}>
        {busy ? "Starting…" : "Run it again"}
      </button>
      {error ? (
        <span className="ml-2 text-accent" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function PlanView({ payload, line, realShow, showName, paired, runtimeLive, recorded = false, canRerun, onRevise, revisable = false }: PlanViewProps) {
  const router = useRouter();
  const sheet = payload.sheet;
  const [actions, setActions] = useState<LedgerEntry[]>([]);
  const [drawer, setDrawer] = useState<DrawerTarget | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [tile, setTile] = useState<string | null>(null);

  const entries = useMemo(() => {
    const ids = new Set(sheet.ledger.map((e) => e.id));
    return [...sheet.ledger, ...actions.filter((a) => !ids.has(a.id))];
  }, [sheet.ledger, actions]);
  const open = useCallback((ref: string, entityId?: string) => setDrawer(entityId ? { ref, entityId } : { ref }), []);
  const ctx = useMemo(() => ({ entries, open, sample: sheet.mode === "fixture" }), [entries, open, sheet.mode]);

  // A footnote link shared as /plan/<id>#receipt-Q13 opens that receipt.
  useEffect(() => {
    const fromHash = () => {
      const m = /^#receipt-([A-Za-z0-9_-]+)$/.exec(window.location.hash);
      if (m && sheet.ledger.some((e) => e.id === m[1])) setDrawer({ ref: m[1]! });
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, [sheet.ledger]);

  const explain = useMemo(() => {
    const m = new Map<string, { name: string; contributions: ExplainContribution[] }>();
    const c = sheet.cards;
    for (const e of [
      ...c.partners.results.map((p) => p.entity),
      ...c.prePost.results.map((p) => p.entity),
      ...c.media.results.map((p) => p.entity),
      ...c.declared.results.flatMap((d) => (d.entity ? [d.entity] : [])),
    ]) {
      m.set(e.entityId, { name: e.name, contributions: e.explainability ?? [] });
    }
    return m;
  }, [sheet]);
  const names = useMemo(() => entityIndex(sheet), [sheet]);

  const days = tMinusDays(sheet.createdAt, sheet.bill.date);
  const thin = isThinSignal(sheet);
  const op = sheet.operator;
  const venue = sheet.bill.venue;
  const sample = sheet.mode === "fixture";
  const base = `/api/sheet/${encodeURIComponent(sheet.planId)}`;
  const target = sheet.discovery ? discoveryTarget(sheet, sheet.discovery) : null;
  const revise = useMemo(() => onRevise ?? (revisable ? apiRevise(sheet.planId) : null), [onRevise, revisable, sheet.planId]);
  const limits = sheet.limits.filter((l) => !ABOUT_LINE.test(l) && !HEADER_LINE.test(l));
  // The denied-tag count is said in the checks line; the "no model key" template line is said under the Summary.
  const guardNotes = sheet.guard.reasons.filter((r) => !/denied by policy/i.test(r) && !(sheet.narration?.templated && TEMPLATE_NO_KEY.test(r)));

  const status = sendStatus(entries);
  const requestCount = entries.filter((e) => e.kind !== "action").length;
  const steps = useMemo(() => [...(sheet.steps ?? []), ...sendSteps(entries)], [sheet.steps, entries]);
  const contents = contentsFor({ revise: revise !== null, steps: steps.length > 0 });
  const others = sheet.bill.acts.filter((a) => a.name !== headlinerName(sheet.bill)).map((a) => a.name);
  const partnersFound = sheet.cards.partners.results.length;

  // The tab title follows the status once this visit records a send ("... street sheet (sent Oct 14)").
  useEffect(() => {
    if (actions.length > 0) document.title = `${sheetTitle(sheet, entries)} · Walkup`;
  }, [actions.length, sheet, entries]);

  // Four key facts, label over value. A number the operator typed says so in its label.
  const facts: { k: string; v: string; note?: string }[] = [
    op.seatsLeft === null ? { k: "Seats left", v: "Not entered" } : { k: "Seats left, your number", v: formatInt(op.seatsLeft) },
    { k: "Days to show", v: days >= 0 ? String(days) : "Past" },
    { k: op.streetTeamDays.length > 1 ? "Street-team days" : "Street-team day", v: streetDaysText(op.streetTeamDays) || "None set" },
    { k: "Partners found", v: String(partnersFound), ...(partnersFound < 15 ? { note: "of 15 wanted" } : {}) },
  ];
  // The rest of the inputs as one muted line, honest about blanks.
  const inputsLine = inputsSentences(sheet, realShow);
  const genre = genreOnly(sheet.bill.classification);
  // The preset's pair line becomes a link to the other bill when there is one.
  const pairLine = paired && line && /^Same room, two crowds/.test(line);

  return (
    <ReceiptContext.Provider value={ctx}>
      {(runtimeLive || recorded) && sample ? <SampleStrip variant="sheet" recorded={recorded} /> : null}
      <div className="wrap-wide pt-6 pb-4">
        <nav aria-label="Breadcrumb" className="no-print text-sm text-muted">
          <Link href="/#sheets" className="underline-offset-2 hover:text-ink hover:underline">
            Sheets
          </Link>{" "}
          / {showName ?? `${venue.name}, ${formatShowDate(sheet.bill.date)}`}
        </nav>

        <header className="mt-5">
          <div className="max-w-[760px]">
            {/* The bill is the largest text: the headliner in 600, the rest of the bill in 400. */}
            <h1>
              {headlinerName(sheet.bill) || actsLine(sheet.bill)}
              {others.length > 0 ? <span className="font-normal"> with {joinAnd(others)}</span> : null}
            </h1>
            <p className="mt-2">
              {showName ? `${showName}. ` : ""}
              {venue.name}, {venue.city}
              {venue.state ? `, ${venue.state}` : ""}. {formatShowDate(sheet.bill.date)}.
              {genre ? <span className="text-muted"> {genre}.</span> : null}
            </p>
            <p className="mt-1 text-sm text-muted" data-testid="meta-line">
              {sample ? "Sample street sheet" : "Street sheet"} · {status.line} · {recorded && !sample ? "Recorded" : "Planned"} {formatStamp(sheet.createdAt)} from{" "}
              <a href="#ledger" className="underline underline-offset-2 hover:text-ink">
                {requestCount} {requestCount === 1 ? "request" : "requests"}
              </a>
              {steps.length > 0 ? (
                <>
                  {" "}
                  in{" "}
                  <a href="#steps" className="underline underline-offset-2 hover:text-ink">
                    {steps.length} {steps.length === 1 ? "step" : "steps"}
                  </a>
                </>
              ) : null}
            </p>
            {pairLine && paired ? (
              <p className="mt-2">
                The other bill at {venue.name}:{" "}
                <Link href={`/plan/${paired.planId}`} className="link">
                  {paired.headliner}
                  {paired.date ? `, ${formatShowDate(paired.date)}` : ""}
                </Link>
                .
              </p>
            ) : line ? (
              <p className="mt-2 text-muted">{line}</p>
            ) : null}
          </div>

          <dl className="mt-5 grid max-w-[760px] grid-cols-2 gap-y-3 border-y border-rule py-3 sm:grid-cols-4">
            {facts.map((x, i) => (
              <div key={x.k} className={`min-w-0 px-3 ${i % 2 === 1 ? "border-l border-rule" : ""} ${i === 0 ? "pl-0" : ""} ${i === 2 ? "max-sm:pl-0 sm:border-l sm:border-rule" : ""}`}>
                <dt className="text-sm text-muted">{x.k}</dt>
                <dd className="tabular text-xl">
                  {x.v}
                  {x.note ? <span className="text-sm text-muted"> {x.note}</span> : null}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 max-w-[760px] text-sm text-muted">{inputsLine}</p>
          {thin ? (
            <p className="mt-3 max-w-[760px]">
              <span className="font-semibold">The signal is thin here, so treat this as a starting list.</span> Each section says where it fell back and why.
            </p>
          ) : null}
        </header>

        <div className="no-print mt-5">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-primary" aria-haspopup="dialog" onClick={() => setSendOpen(true)}>
              Send to street team
            </button>
            <a href={`${base}/pdf`} download className="btn btn-ghost">
              Download PDF
            </a>
          </div>
          <p className="link-row mt-3">
            <Link href={`/s/${sheet.planId}`} className="text-button">
              Print view
            </Link>
            {paired ? (
              <Link href={`/plan/${paired.planId}`} className="text-button" aria-label={`Swap the bill: open ${paired.headliner} in the same room`}>
                Swap the bill
              </Link>
            ) : (
              <button type="button" className="text-button" aria-disabled="true" aria-describedby="swap-help" onClick={() => undefined}>
                Swap the bill
                <span id="swap-help" className="sr-only">
                  No second bill is recorded for this room yet.
                </span>
              </button>
            )}
            {canRerun && payload.presetId ? <RerunLink presetId={payload.presetId} /> : null}
          </p>
        </div>

        {sheet.revision ? <RevisionNote revision={sheet.revision} /> : null}

        <nav aria-label="On this sheet" className="no-print mt-6 text-sm">
          <span className="text-muted">On this sheet: </span>
          {contents.map((c, i) => (
            <span key={c.href}>
              {i > 0 ? <span className="text-muted"> · </span> : null}
              <a href={c.href} className="underline-offset-2 hover:underline">
                {c.label}
              </a>
            </span>
          ))}
        </nav>

        {sheet.narration ? (
          <section id="summary" aria-labelledby="summary-title" className="section mt-8 scroll-mt-4">
            <h2 id="summary-title">Summary</h2>
            <p className="mt-1 max-w-[760px] text-sm text-muted">
              {sheet.narration.templated
                ? "Written from a fixed template; no model was called."
                : "Written by Claude under checks that let it cite only names and numbers from this run."}
            </p>
            <p className="mt-2 max-w-[760px]">{sheet.narration.summary}</p>
          </section>
        ) : null}

        {sheet.discovery ? (
          <DiscoveryNote
            discovery={sheet.discovery}
            target={target}
            {...(target?.geohash ? { onGo: () => setTile(target.geohash ?? null) } : {})}
          />
        ) : null}

        {/* The street team's part first: where to go, then who to call. How the plan was made follows. */}
        <LiftCard sheet={sheet} selected={tile} onSelect={setTile} />
        <PartnersCard sheet={sheet} canRevise={revise !== null} />
        {revise ? <ReviseBox onRevise={revise} onOpen={(id) => router.push(`/plan/${id}`)} /> : null}
        {steps.length > 0 ? <StepList steps={steps} /> : null}
        <ResolutionCard sheet={sheet} />
        <DeclaredCard sheet={sheet} />
        <PrePostCard sheet={sheet} />
        <MediaCard sheet={sheet} />
        <CopyHooksCard sheet={sheet} />
        <DifferentCard sheet={sheet} />

        <section id="limits" aria-labelledby="limits-title" className="section scroll-mt-4">
          <h2 id="limits-title">What this sheet doesn&apos;t show</h2>
          <ul className="mt-3 max-w-[760px] list-disc space-y-1 pl-5">
            {limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <h3 className="mt-6 text-base">Checks</h3>
          <p className="mt-1 max-w-[760px]">{checksLine(sheet.guard)}</p>
          {guardNotes.length > 0 ? (
            <ul className="mt-1 max-w-[760px] list-disc space-y-1 pl-5 text-muted">
              {guardNotes.map((r) => (
                <li key={r}>{guardNoteText(r)}</li>
              ))}
            </ul>
          ) : null}
          <h3 className="mt-6 text-base">About this sheet</h3>
          <p className="mt-1 max-w-[760px] text-muted">{aboutNote(payload, recorded)}</p>
        </section>

        <section id="downloads" aria-labelledby="downloads-title" className="section no-print scroll-mt-4">
          <h2 id="downloads-title">Downloads</h2>
          <p className="mt-1 max-w-[760px] text-sm text-muted">
            Built on the server from this sheet.{sample ? " File names start with fixture- so they never pass for a live run." : ""}
          </p>
          <ul className="mt-3 max-w-[760px] space-y-1">
            {DOWNLOADS.map((x) => (
              <li key={x.file}>
                <a href={`${base}/${x.file}`} download className="link">
                  {x.label}
                </a>
                <span className="text-muted">: {x.what}</span>
              </li>
            ))}
          </ul>
        </section>

        <LedgerSection entries={entries} exportHref={`${base}/sheet.json`} sample={sample} />
      </div>

      <ReceiptDrawer
        target={drawer}
        entries={entries}
        explain={explain}
        entityNames={names}
        onClose={() => setDrawer(null)}
        sample={sample}
        onNavigate={(ref) => setDrawer((d) => (d?.entityId ? { ref, entityId: d.entityId } : { ref }))}
      />
      <SendModal
        open={sendOpen}
        planId={sheet.planId}
        onClose={() => setSendOpen(false)}
        onRecorded={(e) => setActions((a) => [...a, e])}
        onViewReceipt={(id) => {
          setSendOpen(false);
          setDrawer({ ref: id });
        }}
      />
    </ReceiptContext.Provider>
  );
}
