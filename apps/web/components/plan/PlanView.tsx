"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { revisePlan } from "../../lib/api";
import type { ExplainContribution, GuardReport, LedgerEntry, StreetSheet } from "@walkup/contracts";
import { SampleStrip } from "../SampleStrip";
import { actsLine, formatDayMonth, formatInt, formatShowDate, formatStamp, formatUsd, headlinerName, joinAnd, tMinusDays } from "../../lib/format";
import { countsAreWhatIf, partnerLessSure, streetDaysText } from "@walkup/exports/format";
import { entityIndex, footprintLine, guardNoteText, isThinSignal, replacedLineArea, runFootprint, sendStatus, sendSteps, sheetTitle, topTiles } from "../../lib/sheet-utils";
import { FANBAR_HREF, FANBAR_NO_CLAIM, FANBAR_RESULT, lastSegment } from "../../lib/labels";
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
import { DiscoveryNote, NoDiscoveryNote, RevisionNote, StepList } from "./SheetExtras";
import { FoldBody, FoldContext, openFoldsFor } from "./fold";

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
   * The server serves recorded sheets only (live runs are paused): a live sheet says when it was recorded
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
  /** Stored revisions of this sheet ("All ages, no bars"), linked from the header. */
  revisions?: readonly { planId: string; instruction: string }[];
  /** When the page is viewed (ISO), for "Days to show". Default: now. */
  today?: string;
  /** Narration lines the checks replaced with fixed-template lines at view time (said under the Summary). */
  narrationReplaced?: number;
}

/** True when the run's own checks set Claude's summary aside (a claim the sheet doesn't back) and the template's stands in. */
function summaryFixed(sheet: StreetSheet): boolean {
  return (sheet.guard?.reasons ?? []).some((r) => /^(?:replaced by the template: )?summary:/.test(r));
}

/** The run's reasons for replacing an area or partner line with the template's line. */
function lineFixReasons(sheet: StreetSheet): string[] {
  return (sheet.guard?.reasons ?? []).filter((r) => /^replaced by the template: (?:tileWhy|partnerLines)\[/.test(r));
}

/** Area and partner lines the run's own checks replaced with the template's line (said with the view-time count). */
function lineFixes(sheet: StreetSheet): number {
  return lineFixReasons(sheet).length;
}

/**
 * A check reason that says the text claimed something the sheet doesn't back (a number, place or superlative), as
 * opposed to a wording or policy rule (a banned word, an alcohol word on an all-ages show, "house" for the usual crowd).
 */
const UNBACKED_CLAIM = /not backed|not in this run|isn't on this sheet|can't back|the sheet has \d+/i;

/**
 * Who wrote the summary, said in one muted line after it (the summary itself opens the section): the template, Claude,
 * or the template standing in for Claude's draft. What the checks changed is said under Checks, not here.
 */
export function summaryNote(sheet: StreetSheet, narrationReplaced = 0): string {
  if (sheet.narration?.templated) return "Written from a fixed template; no model was called.";
  const fixes = lineFixes(sheet) + narrationReplaced;
  const checks = "under checks that let it cite only names and numbers from this run";
  // Claude did write a summary (the steps say so); the checks set that draft aside, so the note says whose words these are.
  if (summaryFixed(sheet)) return `Summary in fixed wording, in place of Claude's draft. Claude wrote the area and partner lines ${checks}; what the checks changed is under Checks.`;
  return `Written by Claude ${checks}.${fixes > 0 ? ` ${fixes} ${fixes === 1 ? "line was" : "lines were"} replaced with fixed wording; see Checks.` : ""}`;
}

/**
 * What the checks did to Claude's text, in one plain line for the Checks list: "Claude's draft summary made a claim
 * the sheet doesn't back, so fixed wording replaced it. 2 of Claude's area and partner lines were replaced the same
 * way." It says "made a claim the sheet doesn't back" only when every reason on record is one; otherwise "didn't
 * pass the checks" (each reason is listed right after it). Null when nothing was replaced.
 */
export function checksFixLine(sheet: StreetSheet, narrationReplaced = 0): string | null {
  if (sheet.narration?.templated) return null;
  const reasons = sheet.guard?.reasons ?? [];
  const lineReasons = lineFixReasons(sheet);
  const fixes = lineReasons.length + narrationReplaced;
  if (summaryFixed(sheet)) {
    const claim = reasons.filter((r) => /^(?:replaced by the template: )?summary:/.test(r)).every((r) => UNBACKED_CLAIM.test(r));
    const head = `Claude's draft summary ${claim ? "made a claim the sheet doesn't back" : "didn't pass the checks"}, so fixed wording replaced it.`;
    return fixes > 0 ? `${head} ${fixes} of Claude's area and partner lines ${fixes === 1 ? "was" : "were"} replaced the same way.` : head;
  }
  if (fixes > 0) {
    // Lines replaced at view time carry no reason here, so only the run's own reasons can name a claim.
    const claim = narrationReplaced === 0 && lineReasons.every((r) => UNBACKED_CLAIM.test(r));
    return `${fixes} of Claude's area and partner lines ${claim ? "made a claim the sheet doesn't back" : "didn't pass the checks"}, so fixed wording replaced ${fixes === 1 ? "it" : "them"}.`;
  }
  return null;
}

/** sm-width columns for the key facts row: one per fact, so a left-out blank leaves no empty cell. */
const FACT_COLS: Record<number, string> = { 1: "sm:grid-cols-1", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3", 4: "sm:grid-cols-4" };

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
  {
    file: "partners.csv",
    label: "partners.csv",
    what: "the call list; called, outcome and notes are blank for your street team to fill in, and contact_email is filled only from your own partner list",
  },
  { file: "zips.csv", label: "zips.csv", what: "ZIP codes with lift and weight" },
  { file: "pins.csv", label: "pins.csv", what: "map pins with a radius" },
  { file: "offer-codes.csv", label: "offer-codes.csv", what: "codes to create in your ticketing platform" },
  { file: "sheet.json", label: "sheet.json", what: "the whole sheet as recorded, before the view-time checks, with its ledger" },
];

/** The "On this sheet" links, in page order. Parts a sheet may not have are left out. */
function contentsFor(opts: { revise: boolean; steps: boolean }): { href: string; label: string }[] {
  return [
    { href: "#lift", label: "Areas" },
    { href: "#partners", label: "Partners" },
    { href: "#downloads", label: "Downloads" },
    ...(opts.revise ? [{ href: "#revise", label: "Change something" }] : []),
    ...(opts.steps ? [{ href: "#steps", label: "Steps" }] : []),
    { href: "#prepost", label: "Before and after" },
    { href: "#resolution", label: "Acts and venue" },
    { href: "#declared", label: "Your list" },
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
  if (recorded) {
    return `Recorded from a live Qloo and Ticketmaster run on ${formatStamp(p.sheet.createdAt)}. Live runs are paused for judging; this sheet comes from that run, and any change since was made offline, with no API call. Every footnote points to the request that produced the claim.`;
  }
  return "A live run. Every footnote points to the request that produced the claim.";
}

/** "Country", "Comedy": the genre from a Ticketmaster classification ("Music / Country", "Arts & Theatre / Comedy"). */
function genreOnly(classification: string | undefined): string {
  const g = lastSegment(classification ?? "");
  return /^(undefined|other|miscellaneous)$/i.test(g) ? "" : g;
}

/** The "Start with this place" pick is a partner the table marks less certain (the same rule as its dagger there). */
export function discoveryLessSure(sheet: StreetSheet): boolean {
  const d = sheet.discovery;
  if (!d || d.kind !== "partner") return false;
  const p = sheet.cards.partners.results.find((x) => x.entity.entityId === d.entityId);
  if (!p) return false;
  // When every pick is less certain the table draws no dagger (PartnersCard), so neither does the callout.
  const all = sheet.cards.partners.results;
  const allThin = all.length > 1 && all.every((x) => partnerLessSure(x));
  return !allThin && partnerLessSure(p);
}

/**
 * The radius the lift map was searched at when it widened past the operator's ("The search widened to 60 km ..." on
 * the map card, as the orchestrator's `mapSearchKm` reads it), else null.
 */
export function mapReachKm(sheet: StreetSheet): number | null {
  const m = /The search widened to (\d+(?:\.\d+)?) km/.exec(sheet.cards.liftMap.reason ?? "");
  const km = m ? Number(m[1]) : null;
  return km !== null && km !== sheet.operator.radiusKm ? km : null;
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
  const reach = mapReachKm(sheet);
  parts.push(reach ? `Radius ${op.radiusKm} km; the map search widened to ${reach} km because too few map squares came back within ${op.radiusKm} km.` : `Radius ${op.radiusKm} km.`);
  const tm = sheet.bill.legalAgeEnforced;
  const listed = tm === true ? "Ticketmaster lists the show as 21+" : tm === false ? "Ticketmaster lists the show as all ages" : "Ticketmaster lists no age policy, so the show is treated as all ages";
  parts.push(op.allAges === true && tm === true ? `${listed}; you set it to all ages.` : `${listed}.`);
  // What-if counts are a sample sheet's only (`countsAreWhatIf`): a live sheet is never read as a what-if, whatever an
  // older stored sheet's `hypothetical` says.
  if (countsAreWhatIf(sheet)) parts.push(realShow ? "The bill, venue and date are public listing facts; Walkup has no sales data for this show." : "Walkup has no sales data for this show.");
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

/** A guard reason for a line the checks left out (not one the template replaced, not a note). */
const DROPPED_LINE = /^(?:summary|tileWhy\[\d+\]|partnerLines\[\d+\]|copyHooks\[\d+\]): /;
/** A line left out for an id, number or tag this run did not return (the engine's guard step uses the same test). */
const CITATION_DROP = /not in this run|not on the allowlist|cites no (?:allowlisted )?tag|not traced to this run's ledger|duplicate (?:tile|entity)/;

/** Of the lines the checks left out, how many made a claim the run didn't back (the rest broke a wording or policy rule). */
export function unbackedDrops(guard: GuardReport): number {
  let n = 0;
  for (const r of guard.reasons) {
    // "2 partner lines dropped: ...", "1 partner line dropped: ..." (older runs wrote "2 partner line(s) dropped").
    const many = /^(\d+) partner line(?:s|\(s\))? dropped: /.exec(r);
    if (many) n += Number(many[1]);
    else if (DROPPED_LINE.test(r) && CITATION_DROP.test(r)) n++;
  }
  return Math.min(n, guard.dropped);
}

/**
 * "Checks left out no line. 4 tags were left out under the data policy (ethnicity, inclusivity, credit card)." A line
 * left out for a wording or policy rule (an alcohol word on an all-ages show, a line about a place that isn't a partner)
 * is not a claim: "Checks left out 15 lines, none for a claim the run didn't back." A summary the checks set aside is
 * not left out: fixed wording stands in for it, and the next line says so with the other replaced lines (the run's
 * "replaced by the template" notes, plus lines swapped at view time). Never "removed 0 claims".
 */
export function checksLine(guard: GuardReport): string {
  const by = guard.deniedByNamespace;
  const classes = by ? Object.keys(by).filter((k) => (by[k] ?? 0) > 0).map((k) => k.replace(/_/g, " ")) : [];
  const n = guard.deniedTagCount;
  // The run counts a set-aside summary as dropped ("summary: number 1.8 is not in this run"); the template replaced it.
  const summary = guard.reasons.find((r) => /^summary: /.test(r));
  const dropped = Math.max(guard.dropped - (summary ? 1 : 0), 0);
  const unbacked = Math.min(Math.max(unbackedDrops(guard) - (summary && CITATION_DROP.test(summary) ? 1 : 0), 0), dropped);
  const other = dropped - unbacked;
  const lines = (x: number) => `${x} ${x === 1 ? "line" : "lines"}`;
  // A failed line with no fixed wording for its slot ("... (dropped)") was left out, though `dropped` does not count it;
  // its reason is not sorted into claim or wording rule, so the count is said without a split (the Checks step agrees).
  const swapDrops = guard.reasons.filter((r) => /^replaced by the template: .*\(dropped\)$/.test(r)).length;
  const claims =
    swapDrops > 0
      ? `Checks left out ${lines(dropped + swapDrops)}.`
      : dropped === 0
        ? "Checks left out no line."
        : other === 0
          ? `Checks removed ${dropped} ${dropped === 1 ? "claim" : "claims"}.`
          : unbacked === 0
            ? dropped === 1
              ? "Checks left out 1 line, for a wording or policy rule."
              : `Checks left out ${lines(dropped)}, none for a claim the run didn't back.`
            : `Checks left out ${lines(dropped)}: ${unbacked} for a claim the run didn't back, ${other} for a wording or policy rule.`;
  if (n === 0) return `${claims} No tag was left out under the data policy.`;
  return `${claims} ${n} ${n === 1 ? "tag was" : "tags were"} left out under the data policy${classes.length > 0 ? ` (${classes.join(", ")})` : ""}.`;
}

/**
 * The Checks list: each check note in plain words, the same note once with its count ("13 of Claude's partner lines
 * were left out: each was about a place that isn't a partner on this sheet.", and "9 of Claude's partner lines were
 * replaced with fixed wording: each names tags ...") rather than 13 times in a row. With the
 * sheet, a replaced area line names the area its geohash is in (`replacedLineArea`), not its place in the list.
 */
export function checkNotes(reasons: readonly string[], sheet?: StreetSheet): string[] {
  const counts = new Map<string, number>();
  const areaOfLine = sheet ? replacedLineArea(sheet) : undefined;
  for (const r of reasons) {
    // "partnerLines[22]: not a partner": Claude wrote a line for a spot, a podcast or the sponsor.
    const text = /^partnerLines\[\d+\]: not a partner$/.test(r)
      ? "One of Claude's partner lines was left out: it was about a place that isn't a partner on this sheet."
      : guardNoteText(r, areaOfLine);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return [...counts].map(([text, n]) => {
    if (n === 1) return text;
    const m = /^One of Claude's (partner|copy|area) lines was (left out|replaced with fixed wording): (.+)$/.exec(text);
    if (m)
      return `${n} of Claude's ${m[1]} lines were ${m[2]}: ${m[3]!
        .replace(/^it was about a place that isn't/, "each was about a place that isn't")
        .replace(/^it /, "each ")
        .replace(/^(names|says|merges) /, "each $1 ")}`;
    // The count goes inside the sentence: "... ("coffee") (9 times).", never "... ("coffee"). (9 times)".
    return /[.!?]$/.test(text) ? `${text.slice(0, -1)} (${n} times)${text.slice(-1)}` : `${text} (${n} times)`;
  });
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

export function PlanView({
  payload,
  line,
  realShow,
  showName,
  paired,
  runtimeLive,
  recorded = false,
  canRerun,
  onRevise,
  revisable = false,
  revisions = [],
  today,
  narrationReplaced = 0,
}: PlanViewProps) {
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

  // A footnote link shared as /plan/<id>#receipt-Q13 opens that receipt; a link to a folded section opens it.
  useEffect(() => {
    const fromHash = () => {
      const m = /^#receipt-([A-Za-z0-9_-]+)$/.exec(window.location.hash);
      if (m && sheet.ledger.some((e) => e.id === m[1])) setDrawer({ ref: m[1]! });
      else openFoldsFor(decodeURIComponent(window.location.hash.slice(1)));
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

  // Counted from the day the page is viewed, not the day the sheet was made; a recording says its own date.
  const days = tMinusDays(today ?? new Date().toISOString(), sheet.bill.date);
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
  // What the checks did to Claude's text, said once under Checks (the Summary only says who wrote it).
  const fixLine = checksFixLine(sheet, narrationReplaced);
  const note = sheet.narration ? summaryNote(sheet, narrationReplaced) : "";

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

  // Key facts, label over value. A number the operator typed says so in its label; a blank input is left out rather
  // than shown as a placeholder ("Seats left: Not entered").
  const streetDays = streetDaysText(op.streetTeamDays);
  const facts: { k: string; v: string; note?: string }[] = [
    ...(op.seatsLeft === null ? [] : [{ k: "Seats left, your number", v: formatInt(op.seatsLeft) }]),
    {
      k: "Days to show",
      v: days >= 0 ? String(days) : "Past",
      ...(recorded && !sample ? { note: `from today · recorded ${formatDayMonth(sheet.createdAt)}` } : {}),
    },
    ...(streetDays ? [{ k: op.streetTeamDays.length > 1 ? "Street-team days" : "Street-team day", v: streetDays }] : []),
    { k: "Partners found", v: String(partnersFound) },
  ];
  // What this run sent, counted from its own ledger (live runs only: a sample sheet called nothing).
  const footprint = sample ? null : footprintLine(runFootprint(entries));
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
              {/* A live sheet names whose genre it is (Ticketmaster's listing), so it never reads as Walkup's own call. */}
              {genre ? <span className="text-muted"> {sample ? `${genre}.` : `Listed as ${genre} on Ticketmaster.`}</span> : null}
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
            {footprint ? (
              <p className="mt-1 text-sm text-muted" data-testid="footprint">
                {footprint}
              </p>
            ) : null}
            {revisions.length > 0 ? (
              <p className="mt-2" data-testid="revision-links">
                {revisions.map((r, i) => (
                  <span key={r.planId}>
                    {i > 0 ? <span className="text-muted"> · </span> : null}
                    <span className="text-muted">Revised: </span>
                    <Link href={`/plan/${r.planId}`} className="link">
                      {r.instruction} &rarr;
                    </Link>
                  </span>
                ))}
              </p>
            ) : null}
            {/* The one link to the other bill in the same room (the old "Swap the bill" link said the same thing). */}
            {paired ? (
              <p className="mt-2">
                The other bill at {venue.name}:{" "}
                <Link href={`/plan/${paired.planId}`} className="link">
                  {paired.headliner}
                  {paired.date ? `, ${formatShowDate(paired.date)}` : ""}
                </Link>
                .
              </p>
            ) : null}
            {line && !pairLine ? <p className="mt-2 text-muted">{line}</p> : null}
          </div>

          <dl className={`mt-5 grid max-w-[760px] grid-cols-2 gap-y-3 border-y border-rule py-3 ${FACT_COLS[facts.length] ?? "sm:grid-cols-4"}`}>
            {facts.map((x, i) => (
              <div key={x.k} className={`min-w-0 px-3 ${i % 2 === 1 ? "border-l border-rule" : ""} ${i === 0 ? "pl-0" : ""} ${i === 2 ? "max-sm:pl-0 sm:border-l sm:border-rule" : ""}`}>
                <dt className="text-sm text-muted">{x.k}</dt>
                <dd className="tabular text-xl">
                  {x.v}
                  {x.note ? <span className="block text-sm text-muted">{x.note}</span> : null}
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
            {/* The show and what the sheet found come first; who wrote it follows, and what the checks changed is under Checks. */}
            <p className="mt-2 max-w-[760px]">{sheet.narration.summary}</p>
            <p className="mt-1 max-w-[760px] text-sm text-muted" data-testid="summary-note">
              {note.split(/\b(Checks)\b/).map((part, i) =>
                part === "Checks" ? (
                  <a key={i} href="#checks" className="underline underline-offset-2 hover:text-ink">
                    Checks
                  </a>
                ) : (
                  part
                ),
              )}
            </p>
          </section>
        ) : null}

        {sheet.discovery ? (
          <DiscoveryNote
            discovery={sheet.discovery}
            target={target}
            lessSure={discoveryLessSure(sheet)}
            {...(target?.geohash ? { onGo: () => setTile(target.geohash ?? null) } : {})}
          />
        ) : (sheet.steps ?? []).length > 0 ? (
          // A run that went through the pick and found none says so where the callout would be.
          <NoDiscoveryNote sheet={sheet} />
        ) : null}

        {/* The street team's part first: where to go, who to call, the files to hand out. How the plan was made follows. */}
        <LiftCard sheet={sheet} selected={tile} onSelect={setTile} />
        <PartnersCard sheet={sheet} canRevise={revise !== null} />

        <section id="downloads" aria-labelledby="downloads-title" className="section no-print scroll-mt-4">
          <h2 id="downloads-title">Downloads</h2>
          <p className="mt-1 max-w-[760px] text-sm text-muted">
            Built on the server from this sheet.{sample ? " File names start with fixture- so they never pass for a live run." : ""}
          </p>
          <ul className="mt-3 max-w-[760px] space-y-1">
            {/* With no areas on the lift map, zips.csv and pins.csv would be headers only: leave them out. */}
            {DOWNLOADS.filter((x) => topTiles(sheet).length > 0 || (x.file !== "zips.csv" && x.file !== "pins.csv")).map((x) => (
              <li key={x.file}>
                <a href={`${base}/${x.file}`} download className="link">
                  {x.label}
                </a>
                <span className="text-muted">: {x.what}</span>
              </li>
            ))}
          </ul>
        </section>

        {revise ? <ReviseBox onRevise={revise} onOpen={(id) => router.push(`/plan/${id}`)} /> : recorded && !sample && !sheet.revision ? <ReviseBox recordedPlanId={sheet.planId} onOpen={(id) => router.push(`/plan/${id}`)} /> : null}
        {steps.length > 0 ? <StepList steps={steps} /> : null}
        <PrePostCard sheet={sheet} />

        {/* Lower sections: heading and summary in view, the rest behind a plain "Show". */}
        <FoldContext.Provider value={true}>
          <ResolutionCard sheet={sheet} />
          <DeclaredCard sheet={sheet} />
          <MediaCard sheet={sheet} />
          <CopyHooksCard sheet={sheet} />
          <DifferentCard sheet={sheet} />

          <section id="limits" aria-labelledby="limits-title" className="section scroll-mt-4">
            <h2 id="limits-title">What this sheet doesn&apos;t show</h2>
            {/* The Fan-Bar Test, stated once per sheet with its scope, in view (not behind Show). */}
            <p className="mt-2 max-w-[760px]" data-testid="fanbar-limit">
              <span className="font-semibold">Whether these picks beat popularity.</span> {FANBAR_RESULT} {FANBAR_NO_CLAIM}{" "}
              <a href={FANBAR_HREF} className="link">
                The test
              </a>
            </p>
            <p className="mt-2 max-w-[760px]">Limits, the checks run on every line, and where this sheet came from.</p>
            <FoldBody title="limits, checks and about this sheet">
              <ul className="mt-3 max-w-[760px] list-disc space-y-1 pl-5">
                {limits.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <h3 id="checks" className="mt-6 scroll-mt-4 text-base">
                Checks
              </h3>
              <p className="mt-1 max-w-[760px]">{checksLine(sheet.guard)}</p>
              {fixLine ? (
                <p className="mt-1 max-w-[760px]" data-testid="checks-fix">
                  {fixLine}
                </p>
              ) : null}
              {guardNotes.length > 0 ? (
                <ul className="mt-1 max-w-[760px] list-disc space-y-1 pl-5 text-muted">
                  {checkNotes(guardNotes, sheet).map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
              <h3 className="mt-6 text-base">About this sheet</h3>
              <p className="mt-1 max-w-[760px] text-muted">{aboutNote(payload, recorded)}</p>
            </FoldBody>
          </section>

          <LedgerSection entries={entries} exportHref={`${base}/sheet.json`} sample={sample} />
        </FoldContext.Provider>
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
