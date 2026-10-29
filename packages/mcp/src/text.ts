/**
 * The short text block beside structuredContent: what an agent that reads only
 * text needs to relay the result honestly (status, the top rows with their
 * receipts, pending picks, the reason, the limits). Built only from the
 * envelope; it adds no places or numbers of its own.
 */
import type { DeclaredPartnerScore, LiftTile, StreetSheet } from "@walkup/contracts";
import { areaLabel } from "@walkup/exports/format";
import { numberedTiles } from "@walkup/orchestrator";
import { recordedDay, type ToolEnvelope } from "./envelope";
import { TM_EVENT_SUBTYPE } from "./event";
import type { BillVsHouse } from "./tools";

const MAX_PARTNERS = 10;
const MAX_TILES = 5;
const MAX_CANDIDATES = 6;

function isSheet(v: unknown): v is StreetSheet {
  return !!v && typeof v === "object" && "cards" in v && "ledger" in v && "bill" in v;
}

function isBillVsHouse(v: unknown): v is BillVsHouse {
  return !!v && typeof v === "object" && "tiles" in v && "baseline" in v && "whatsDifferent" in v;
}

function isDeclaredList(v: unknown): v is DeclaredPartnerScore[] {
  return Array.isArray(v) && v.every((x) => x && typeof x === "object" && "declared" in x && "rank" in x);
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function statusLine(status: string, reason: string | undefined): string {
  if (!reason) return status;
  return reason.toLowerCase().startsWith(status.toLowerCase()) ? reason : `${status}: ${reason}`;
}

function ref(r: string | undefined): string {
  return r ? ` [${r}]` : "";
}

/**
 * The sheet's numbered areas 1-5, as the Street Sheet page, the PDF and the CSVs list them: lift 1.3 and up, highest
 * first, none within 3 km of another or sharing its ZIP (numberedTiles), each named with its own state (areaLabel).
 * Never the map's first five squares, which can be one area twice.
 */
function areaLines(tiles: readonly LiftTile[], provenance: string | undefined): string[] {
  return numberedTiles(tiles, MAX_TILES).map((t, i) => `  ${i + 1}. ${t.name ? areaLabel(t) : `tile ${t.geohash}`} (lift ${t.lift.toFixed(2)})${ref(provenance)}`);
}

/** Said when the map has squares but none reached the lift floor, as the page says it. */
const NO_NUMBERED_AREA = "No area reached a lift of 1.3, so the sheet numbers none.";

function sheetLines(s: StreetSheet): string[] {
  const out: string[] = [];
  const b = s.bill;
  out.push(`Show: ${b.acts.map((a) => a.name).join(", ")} · ${b.venue.name}, ${b.venue.city} · ${cap(b.weekday)} ${b.date}`);
  const lift = s.cards.liftMap;
  if (lift.results.tiles.length > 0 && lift.results.diagnostics.baseline !== "none") {
    const base = lift.results.diagnostics.baseline === "house" ? "the room's usual crowd" : "a genre baseline";
    const areas = areaLines(lift.results.tiles, lift.provenance[0]);
    out.push(areas.length > 0 ? `Numbered areas on the sheet, where this crowd over-indexes vs ${base}:` : NO_NUMBERED_AREA);
    out.push(...areas);
  }
  const partners = s.cards.partners.results;
  if (partners.length > 0) {
    out.push(`Partners (top ${Math.min(MAX_PARTNERS, partners.length)} of ${partners.length}; suggested, not affiliated):`);
    partners.slice(0, MAX_PARTNERS).forEach((p, i) => {
      const where = p.tileName ? `, ${p.tileName}` : "";
      out.push(`  ${i + 1}. ${p.entity.name} (${p.category.replace(/_/g, " ")}${where})${ref(p.chips[0]?.ledgerRef)}`);
    });
  }
  const cards = Object.entries(s.cards).map(([k, c]) => `${k} ${c.status}`);
  out.push(`Cards: ${cards.join(" · ")}`);
  for (const [k, c] of Object.entries(s.cards)) {
    if (c.status !== "ok" && c.reason) out.push(`  ${k}: ${statusLine(c.status, c.reason)}`);
  }
  // What-if counts are a sample sheet's only: a live sheet's counts are the operator's own, whatever an older stored
  // sheet's `hypothetical` says (the same rule as countsAreWhatIf in @walkup/exports).
  if (s.mode === "fixture" && s.hypothetical === true) out.push("Seat counts are operator what-ifs (HYPOTHETICAL), not sales data.");
  return out;
}

function billVsHouseLines(r: BillVsHouse, provenance: string[]): string[] {
  const out: string[] = [];
  out.push(`Show: ${r.bill.acts.map((a) => a.name).join(", ")} · ${r.bill.venue.name}, ${r.bill.venue.city} · ${r.bill.date}`);
  out.push(
    `Baseline: ${
      r.baseline === "house"
        ? "the room's own roster"
        : r.baseline === "tag"
          ? "a pinned genre tag (the roster did not resolve)"
          : "none (the roster did not resolve and no genre tag is pinned, so there is no lift map)"
    }`,
  );
  if (r.tiles.length > 0) {
    const areas = areaLines(r.tiles, provenance[0]);
    out.push(areas.length > 0 ? "Numbered areas on the sheet (highest lift first):" : NO_NUMBERED_AREA);
    out.push(...areas);
  }
  const distinct = r.whatsDifferent.a.slice(0, 5).map((t) => t.name);
  if (distinct.length > 0) out.push(`Distinctive to this bill: ${distinct.join(", ")}`);
  for (const [k, c] of Object.entries(r.cards)) out.push(`  ${k}: ${statusLine(c.status, c.reason)}`);
  return out;
}

function declaredLines(rows: DeclaredPartnerScore[]): string[] {
  return rows.map((r) => {
    const place = r.rank === null ? "not in Qloo's catalog, kept in your order" : `#${r.rank}`;
    return `  ${place}: ${r.declared.label}${ref(r.chips[0]?.ledgerRef)}`;
  });
}

function candidateLines(env: ToolEnvelope): string[] {
  const out: string[] = [];
  for (const row of env.resolution) {
    if (row.status !== "needs_input" || !row.candidates?.length) continue;
    const events = row.candidates.every((c) => c.subtype === TM_EVENT_SUBTYPE);
    out.push(`Needs a pick: "${row.input}"`);
    for (const c of row.candidates.slice(0, MAX_CANDIDATES)) {
      const bits = [events ? "event" : c.subtype.replace(/^urn:entity:/, "")];
      if (c.popularity !== null) bits.push(`popularity ${c.popularity.toFixed(2)}`);
      if (c.shortDescription) bits.push(c.shortDescription);
      if (c.releaseYear) bits.push(String(c.releaseYear));
      out.push(`  - ${c.name}: entityId ${c.entityId} (${bits.join("; ")})`);
    }
  }
  if (out.length > 0) {
    out.push(
      env.planId
        ? `Ask the user to choose, then call plan_show with {"planId": "${env.planId}", "picks": [{"input": "<name>", "entityId": "<id>"}]}. Never pick for them.`
        : 'Ask the user to choose, then call plan_show again with the same event and "picks". Never pick for them.',
    );
  }
  return out;
}

function revisionLines(r: NonNullable<ToolEnvelope["revision"]>): string[] {
  const out: string[] = [];
  out.push(`Revision of ${r.parentPlanId} ("${r.instruction}"), read by ${r.interpreter === "model" ? "the model" : "fixed rules"}:`);
  for (const c of r.toolCalls) out.push(`  - ${c.tool}: ${c.summary}`);
  if (r.changes.length > 0) {
    out.push(`Changes (${r.changes.length}):`);
    for (const c of r.changes.slice(0, 12)) out.push(`  ${c.kind.replace(/_/g, " ")}: ${c.label}${c.detail ? ` (${c.detail})` : ""}${ref(c.ledgerRefs[0])}`);
    if (r.changes.length > 12) out.push(`  ... and ${r.changes.length - 12} more in structuredContent.revision.changes`);
  }
  return out;
}

/**
 * The mode line on a recorded server: what it serves was recorded from live runs, and live runs are paused for
 * judging. A sheet says its own day (from createdAt).
 */
function recordedModeLine(env: ToolEnvelope): string {
  if (isSheet(env.results)) {
    const day = recordedDay(env.results.createdAt);
    return `Mode: recorded (recorded from live Qloo and Ticketmaster runs${day ? ` on ${day}` : ""}; live runs are paused for judging, and this sheet comes from a live run, with any change since made offline and no API call).`;
  }
  if (env.status === "error") return "Mode: recorded (live runs are paused for judging; the recorded sheets come from live Qloo and Ticketmaster runs, with any change since made offline, and get_sheet reads them).";
  return "Mode: recorded (read from a sheet recorded from live Qloo and Ticketmaster runs; live runs are paused for judging).";
}

/** The text content for a tool result. */
export function envelopeText(tool: string, env: ToolEnvelope): string {
  const lines: string[] = [];
  lines.push(`Walkup ${tool}: ${env.status}. ${env.summary}`);
  lines.push(
    env.mode === "fixture"
      ? "Mode: fixture (synthetic data; no live API was called)."
      : env.mode === "recorded"
        ? recordedModeLine(env)
        : "Mode: live.",
  );
  if (env.planId) lines.push(`Plan id: ${env.planId}${env.sheetUrl ? ` · Street Sheet: ${env.sheetUrl}` : ""}`);
  if (env.reason && env.reason !== env.summary) lines.push(`Reason: ${env.reason}`);
  if (env.freshRuns) lines.push(`Fresh runs left today: ${env.freshRuns.leftForCaller} for you, ${env.freshRuns.leftToday} on this server.`);
  if (env.question) lines.push(`Question for the user: ${env.question}`);
  if (env.revision) lines.push(...revisionLines(env.revision));
  if (isSheet(env.results)) lines.push(...sheetLines(env.results));
  else if (isBillVsHouse(env.results)) lines.push(...billVsHouseLines(env.results, env.provenance));
  else if (isDeclaredList(env.results)) {
    lines.push("Your list, in call order:");
    lines.push(...declaredLines(env.results));
  }
  lines.push(...candidateLines(env));
  if (env.limits.length > 0) {
    lines.push("What this does not establish:");
    for (const l of env.limits) lines.push(`  - ${l}`);
  }
  if (env.status !== "error") lines.push("Cite places and numbers with their receipts as given. The full envelope is in structuredContent.");
  return lines.join("\n");
}
