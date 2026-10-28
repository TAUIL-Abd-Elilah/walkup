/**
 * Pure helpers for the plan page (no React, no Next): what the sheet extras
 * point at, how a revision's changes group, how streamed steps merge. Relative
 * imports only, so the tests can load this file directly.
 */
import { partnerWhyLine, partnerWhyRefs, spotVsUsual } from "@walkup/exports/format";
import { TRACE_STEP_KINDS } from "@walkup/contracts";
import type { EnvelopeStatus, Partner, PartnerConfidence, RevisionChange, SheetDiscovery, StreetSheet, TraceStep, Weekday } from "@walkup/contracts";
import { weekdayShort } from "../../lib/format";

/** The id a partner row carries, so the discovery callout and receipts can link to it. */
export function partnerAnchor(entityId: string): string {
  return `partner-${entityId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/** Where the discovery callout links: a partner row, a tile on the map, or nowhere when it points at nothing on this sheet. */
export function discoveryTarget(sheet: StreetSheet, d: SheetDiscovery): { href: string; label: string; geohash?: string } | null {
  if (d.kind === "partner" && d.entityId) {
    const p = sheet.cards.partners.results.find((x) => x.entity.entityId === d.entityId);
    return p ? { href: `#${partnerAnchor(p.entity.entityId)}`, label: "See it in the partner list" } : null;
  }
  if (d.kind === "area" && d.geohash) {
    const t = sheet.cards.liftMap.results.tiles.find((x) => x.geohash === d.geohash);
    return t ? { href: "#lift", label: "See it on the map", geohash: t.geohash } : null;
  }
  return null;
}

export interface RevisionGroups {
  added: RevisionChange[];
  removed: RevisionChange[];
  changed: RevisionChange[];
}

/** A revision's changes in three plain groups, display order kept inside each. */
export function groupChanges(changes: readonly RevisionChange[]): RevisionGroups {
  const out: RevisionGroups = { added: [], removed: [], changed: [] };
  for (const c of changes) {
    if (c.kind.endsWith("_added")) out.added.push(c);
    else if (c.kind.endsWith("_removed")) out.removed.push(c);
    else out.changed.push(c);
  }
  return out;
}

/** "partner", "area", "spot" or "setting" for a change kind. */
export function changeNoun(kind: RevisionChange["kind"]): string {
  if (kind.startsWith("partner")) return "partner";
  if (kind.startsWith("tile")) return "area";
  if (kind.startsWith("spot")) return "spot";
  return "setting";
}

/** One line counting a revision's changes, e.g. "2 partners removed, 1 area added." */
export function changeCountLine(changes: readonly RevisionChange[]): string {
  if (changes.length === 0) return "Nothing on the sheet changed.";
  const counts = new Map<string, number>();
  for (const c of changes) {
    const verb = c.kind.endsWith("_added") ? "added" : c.kind.endsWith("_removed") ? "removed" : "changed";
    const key = `${changeNoun(c.kind)}|${verb}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([key, n]) => {
    const [noun, verb] = key.split("|") as [string, string];
    return `${n} ${n === 1 ? noun : `${noun}s`} ${verb}`;
  });
  const line = parts.join(", ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

/**
 * What the revise step understood, as one short line built from its tool calls: "Read as: all ages; bars and
 * drink-led spots left out." Null when nothing was read (a question back is shown on its own).
 */
export function readAsLine(toolCalls: readonly { tool: string; summary: string; input?: unknown }[]): string | null {
  const calls = toolCalls.filter((t) => t.tool !== "ask_operator");
  const allAges = calls.some((t) => t.tool === "set_all_ages" && /^Marked the show all ages/.test(t.summary));
  const parts: string[] = [];
  for (const t of calls) {
    const s = t.summary.trim().replace(/[.;\s]+$/, "");
    if (!s) continue;
    if (t.tool === "set_all_ages" && allAges) {
      parts.push("all ages");
      // Without a type exclusion, say what all ages does to the list.
      if (!calls.some((c) => c.tool === "exclude_partner_categories")) parts.push("bar partners and drink-led spots left out");
      continue;
    }
    const left = /^Left out (.+)$/.exec(s);
    if (t.tool === "exclude_partner_categories" && left) {
      const what = left[1]!;
      parts.push(allAges && /^bars\b/.test(what) ? `${what.replace(/^bars and other drinking places/, "bars")} and drink-led spots left out` : `${what} left out`);
      continue;
    }
    parts.push(/^[A-Z][a-z]/.test(s) ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s);
  }
  return parts.length > 0 ? `Read as: ${parts.join("; ")}.` : null;
}

const STATUSES: readonly EnvelopeStatus[] =["ok", "empty", "needs_input", "partial", "degraded", "error"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** A TraceStep from an SSE `step` event (`{step}` or the step itself), or null when the shape is wrong. */
export function parseStep(data: unknown): TraceStep | null {
  const s = isRecord(data) && isRecord(data.step) ? data.step : data;
  if (!isRecord(s)) return null;
  const { id, kind, label, decision, cause, status, ledgerRefs } = s;
  if (typeof id !== "string" || typeof label !== "string" || typeof decision !== "string") return null;
  if (typeof kind !== "string" || !(TRACE_STEP_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof status !== "string" || !STATUSES.includes(status as EnvelopeStatus)) return null;
  const refs = Array.isArray(ledgerRefs) ? ledgerRefs.filter((r): r is string => typeof r === "string") : [];
  return {
    id,
    kind: kind as TraceStep["kind"],
    label,
    decision,
    ...(typeof cause === "string" && cause ? { cause } : {}),
    status: status as EnvelopeStatus,
    ledgerRefs: refs,
  };
}

/** Adds a streamed step, replacing one with the same id (a step can be restated when it finishes). */
export function mergeStep(steps: readonly TraceStep[], step: TraceStep): TraceStep[] {
  const i = steps.findIndex((s) => s.id === step.id);
  if (i === -1) return [...steps, step];
  const next = [...steps];
  next[i] = step;
  return next;
}

/** The weekday the partner hours are for: the first street-team day ("Thu"), or null when none is set. */
export function streetDayShort(days: readonly Weekday[]): string | null {
  const d = days[0];
  return d ? weekdayShort(d) : null;
}

export const CONFIDENCE_LABEL: Record<PartnerConfidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

/**
 * Plain lines on how this place compares with the room's usual crowd, from the
 * house twin and the ubiquity penalty. Empty when neither was computed.
 */
export function houseLines(p: Partner): string[] {
  const out: string[] = [];
  if (typeof p.ubiquityPenalty === "number" && p.ubiquityPenalty > 0) {
    out.push("It also ranks for the room's usual crowd, so its score was marked down.");
  }
  return out;
}

function ordinal(n: number): string {
  const i = Math.round(n);
  const m100 = Math.abs(i) % 100;
  const m10 = Math.abs(i) % 10;
  return `${i}${m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`;
}

/**
 * The partner table's Why cell: one sentence, the same as on the printed sheet (`partnerWhyLine` in
 * @walkup/exports). How sure the pick is shows as a dagger after the name, not in this line. The receipts are the
 * pool's request and the usual-crowd search.
 */
export function partnerWhy(p: Partner): { text: string; refs: string[] } {
  let text: string;
  if (p.houseRank !== undefined) text = partnerWhyLine(p);
  else {
    // Older sheets carry the comparison as a chip only.
    const twin = p.chips.find((c) => /^tonight vs house/.test(c.label))?.label ?? "";
    const delta = /([+-]?\d+) ranks?$/.exec(twin);
    const missing = /not in the house top (\d+)/.exec(twin);
    if (delta) text = partnerWhyLine({ qlooRank: p.qlooRank, houseRank: p.qlooRank + Number(delta[1]) });
    else if (missing) text = `Ranks ${ordinal(p.qlooRank)} here for this crowd; not in the usual crowd's top ${missing[1]}.`;
    else text = partnerWhyLine({ qlooRank: p.qlooRank });
  }
  return { text, refs: partnerWhyRefs(p) };
}

/** "Mostly from Marla Vane's fans", from the explainability chip, or null. */
export function influenceLine(p: Partner): string | null {
  const who = p.chips.find((c) => /^most influenced by /.test(c.label))?.label.replace(/^most influenced by /, "");
  return who ? `Mostly from ${who}${/s$/.test(who) ? "'" : "'s"} fans.` : null;
}

/** Outcome of the revise handler the integrator wires (server action or client helper). */
export interface ReviseOutcome {
  /** The revised plan (or the running revision) to open. */
  planId?: string;
  /** The instruction was unclear: the question asked back instead of changing the plan. */
  question?: string;
  /** Why nothing happened (refused, rate limited, failed). */
  reason?: string;
  /** Recorded mode: nothing was wrong, but nothing opens (the change was not made ahead, or changes nothing). */
  notice?: string;
  /** Recorded mode: how the note was read (who read it, the tools chosen), shown before anything opens. */
  reading?: ReviseReading;
  /** Recorded mode: the ready-made change `planId` is, when the reading matched one. */
  recorded?: { instruction: string; recordedAt: string };
}

export interface ReviseReading {
  interpreter: "model" | "rules";
  toolCalls: readonly { tool: string; summary: string; input?: unknown }[];
}

export type ReviseHandler = (instruction: string) => Promise<ReviseOutcome>;

/** One change made ahead for a recorded sheet (GET /api/plan/<id>/ready-made), as the revise box lists it. */
export interface ReadyMadeChange {
  planId: string;
  instruction: string;
  createdAt: string;
}

/** What the recorded revise box shows: the ready-made changes and who reads notes on this server. */
export interface ReadyMade {
  changes: readonly ReadyMadeChange[];
  reader: "model" | "rules";
}

/** The GET /api/plan/<id>/ready-made answer as the box uses it, or null when there is nothing to show. */
export function parseReadyMade(body: unknown): ReadyMade | null {
  if (!isRecord(body) || body.enabled !== true || !Array.isArray(body.changes)) return null;
  const changes = body.changes.filter(
    (c): c is ReadyMadeChange => isRecord(c) && typeof c.planId === "string" && typeof c.instruction === "string" && c.instruction.trim() !== "" && typeof c.createdAt === "string",
  );
  if (changes.length === 0) return null;
  return { changes, reader: body.reader === "model" ? "model" : "rules" };
}

/** Who read the note, in words. */
export function readerLine(interpreter: "model" | "rules"): string {
  return interpreter === "model" ? "Claude read your note." : "Fixed rules read your note; no model was called.";
}

/**
 * A recorded-mode revise answer (lib/server/recorded-revise.ts) as the box's outcome: a matched ready-made change to
 * open, a question, or a notice that nothing opens.
 */
export function recordedOutcome(body: unknown): ReviseOutcome {
  if (!isRecord(body)) return { reason: "The server sent an answer this page can't read." };
  const rev = isRecord(body.revision) ? body.revision : null;
  const reading: ReviseReading | undefined = rev
    ? {
        interpreter: rev.interpreter === "model" ? "model" : "rules",
        toolCalls: Array.isArray(rev.toolCalls)
          ? rev.toolCalls.filter((t): t is { tool: string; summary: string; input?: unknown } => isRecord(t) && typeof t.tool === "string" && typeof t.summary === "string")
          : [],
      }
    : undefined;
  const withReading = <T extends ReviseOutcome>(o: T): T => (reading ? { ...o, reading } : o);
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);
  switch (body.status) {
    case "recorded": {
      const rec = isRecord(body.recorded) ? body.recorded : {};
      if (typeof body.planId !== "string") return { reason: "The server sent an answer this page can't read." };
      return withReading({
        planId: body.planId,
        recorded: { instruction: text(rec.instruction, ""), recordedAt: text(rec.recordedAt, "") },
      });
    }
    case "needs_input":
      return withReading({ question: text(body.question, "What should change?") });
    case "not_recorded":
    case "unchanged":
      return withReading({ notice: text(body.reason ?? body.summary, "Nothing changed.") });
    default:
      return { reason: text(body.reason, "Nothing changed. Try saying it another way.") };
  }
}

/** "Opening the version made for “Street team only on Saturday”, recorded Oct 28." */
export function openingLine(recorded: { instruction: string; recordedAt: string }, formatDay: (iso: string) => string): string {
  const when = recorded.recordedAt ? `, recorded ${formatDay(recorded.recordedAt)}` : "";
  return recorded.instruction ? `Opening the version made for “${recorded.instruction}”${when}.` : `Opening the version made for that change${when}.`;
}

/** Trims and checks a revise instruction; returns the text to send or a message for the field. */
export function checkInstruction(raw: string): { ok: true; text: string } | { ok: false; message: string } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 3) return { ok: false, message: "Say what to change, for example: all ages, no bars." };
  if (text.length > 280) return { ok: false, message: "Keep it under 280 characters." };
  return { ok: true, text };
}

/**
 * A receipt chip's label as plain words, e.g. "tonight vs house +5 ranks" ->
 * "ranks 5 places higher here than for the room's usual crowd" (the same words as on paper). Unknown labels pass through unchanged.
 */
export function chipText(label: string): string {
  const twin = /^tonight vs house ([+-]?\d+) ranks?$/.exec(label);
  if (twin) {
    const n = Number(twin[1]);
    return spotVsUsual(n);
  }
  const missing = /^tonight vs house: not in the house top (\d+)$/.exec(label);
  if (missing) return `not in the usual crowd's top ${missing[1]}`;
  const tile = /^in a ([\d.]+)x lift tile$/.exec(label);
  if (tile) return `in an area with ${tile[1]}x lift`;
  return label.replace(/labell?ed national until the local probe shows movement/, "national ranking until a local one is checked");
}

/** First letter upper case, for a run of claims that starts a cell. */
export function capitalize(s: string): string {
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s;
}
