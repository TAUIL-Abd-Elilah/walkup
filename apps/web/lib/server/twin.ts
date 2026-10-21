/**
 * "Tonight vs house +N ranks" on partner rows, for sheets made before the
 * orchestrator ran the house twin itself.
 *
 * Current runs get the twin inside the orchestrator's partner step
 * (`Q9 house twin, tile N`): it feeds the ubiquity penalty and writes the
 * chip, `Partner.houseRank` and `Partner.ubiquityPenalty`. Such a sheet is
 * returned as is. For an older sheet, this step adds one twin per partner
 * pool: the same Q9 request (same tile point, radius, category tags,
 * street-team hours, price and exclusions), with the signal swapped for the
 * house signal the run already used for its Q10 twin. The chip is the rank
 * difference inside those two responses: houseRank - billRank (positive =
 * this place ranks higher for tonight's bill than for the room's usual
 * crowd). One Qloo call per pool, written to the sheet's own ledger and cited
 * by the chip. It does not re-score: an older sheet keeps its order.
 */
import type { Chip, LedgerEntry, LedgerSink, Partner, StreetSheet } from "@walkup/contracts";
import { createRunLedger } from "@walkup/orchestrator";
import type { QlooClient } from "@walkup/qloo";

export const TWIN_CHIP_PREFIX = "tonight vs house";
export const TWIN_NODE = "Q9 house twin";
export const TWIN_LIMIT =
  "The usual-crowd rank comes from the same Qloo search run for the room's usual crowd, in the same area with the same filters.";

export interface TwinOutcome {
  sheet: StreetSheet;
  /** Qloo calls made (one per partner pool). */
  calls: number;
  /** Partner rows that got a chip. */
  chips: number;
  /** Why nothing was added, when nothing was. */
  skipped?: string;
  errors: string[];
}

type ParamValue = LedgerEntry["params"][string];

/** A sink that continues an existing ledger's numbering (Q29 after Q28, A3 after A2). */
export function continueLedger(existing: readonly LedgerEntry[]): LedgerSink {
  const max: Record<string, number> = {};
  for (const e of existing) {
    const m = /^([A-Z]+)(\d+)$/.exec(e.id);
    if (m) max[m[1] as string] = Math.max(max[m[1] as string] ?? 0, Number(m[2]));
  }
  const prefix: Record<LedgerEntry["kind"], string> = { qloo: "Q", tm: "T", places: "P", acs: "C", anthropic: "L", action: "A" };
  const added: LedgerEntry[] = [];
  return {
    add(entry) {
      const p = prefix[entry.kind];
      max[p] = (max[p] ?? 0) + 1;
      const id = `${p}${max[p]}`;
      added.push({ ...entry, id });
      return id;
    },
    entries() {
      return [...existing, ...added];
    },
  };
}

function isNode(e: LedgerEntry, node: string): boolean {
  return typeof e.note === "string" && e.note.includes(`node ${node}`);
}

/** The house signal the run used for its Q10 twin: house entity ids, or the genre tag baseline. */
export function houseSignalOf(ledger: readonly LedgerEntry[]): Record<string, string[]> | null {
  const twin = ledger.find((e) => e.kind === "qloo" && e.httpStatus === 200 && isNode(e, "Q10 house twin"));
  if (!twin) return null;
  const ids = twin.params["signal.interests.entities"];
  const tags = twin.params["signal.interests.tags"];
  const out: Record<string, string[]> = {};
  if (Array.isArray(ids) && ids.length > 0) out["signal.interests.entities"] = ids.map(String);
  if (Array.isArray(tags) && tags.length > 0) out["signal.interests.tags"] = tags.map(String);
  return Object.keys(out).length > 0 ? out : null;
}

function poolRefOf(p: Partner, byId: Map<string, LedgerEntry>): string | null {
  for (const c of p.chips) {
    const e = byId.get(c.ledgerRef);
    if (e && e.kind === "qloo" && isNode(e, "Q9 partners")) return c.ledgerRef;
  }
  return null;
}

function tileLabel(entry: LedgerEntry): string {
  const m = /node Q9 partners, ([^;]+)/.exec(entry.note ?? "");
  return (m?.[1] ?? "pool").replace(/\s*\(.*\)$/, "");
}

export function twinChipLabel(delta: number | null, listSize: number): string {
  if (delta === null) return `${TWIN_CHIP_PREFIX}: not in the house top ${listSize}`;
  return `${TWIN_CHIP_PREFIX} ${delta > 0 ? "+" : ""}${delta} ranks`;
}

/**
 * True for a chip comparing a place's rank with the room's usual crowd: this file's "tonight vs house ..." wording or
 * the engine's plain one ("ranks 3 places higher here than for the room's usual crowd", "not in the room's usual
 * crowd's top 25").
 */
export function isTwinChip(label: string): boolean {
  return label.startsWith(TWIN_CHIP_PREFIX) || /(?:here (?:than|as) for|not in|no list for) the room's usual crowd/.test(label);
}

export function hasTwinChips(sheet: StreetSheet): boolean {
  return sheet.cards.partners.results.some((p) => p.chips.some((c) => isTwinChip(c.label)));
}

/** True when the run itself already asked for the house twin (whether or not it answered). */
export function ranTwinInRun(sheet: StreetSheet): boolean {
  return sheet.ledger.some((e) => e.kind === "qloo" && isNode(e, TWIN_NODE)) || sheet.cards.partners.results.some((p) => p.houseRank !== undefined);
}

/**
 * Adds the chip to every partner whose pool can be replayed with the house
 * signal. Idempotent (a sheet that already has the chips is returned as is).
 * Never throws: a failed twin call leaves that pool without chips.
 */
export async function addPartnerHouseRanks(sheet: StreetSheet, qloo: QlooClient, opts: { fixture: boolean }): Promise<TwinOutcome> {
  const none = (skipped: string): TwinOutcome => ({ sheet, calls: 0, chips: 0, skipped, errors: [] });
  const partners = sheet.cards.partners.results;
  if (partners.length === 0) return none("no partners on this sheet");
  if (hasTwinChips(sheet) || ranTwinInRun(sheet)) return none("already added");
  const signal = houseSignalOf(sheet.ledger);
  if (!signal) return none("no house signal on this sheet (no Q10 house twin)");

  const byId = new Map(sheet.ledger.map((e) => [e.id, e]));
  const groups = new Map<string, Partner[]>();
  for (const p of partners) {
    const ref = poolRefOf(p, byId);
    if (!ref) continue;
    groups.set(ref, [...(groups.get(ref) ?? []), p]);
  }
  if (groups.size === 0) return none("partner rows do not cite a Q9 pool");

  const sink = continueLedger(sheet.ledger);
  const ledger = createRunLedger(sink, { fixture: opts.fixture });
  const run = qloo.withLedger(ledger);
  const chipsFor = new Map<string, Chip>();
  const refs: string[] = [];
  const errors: string[] = [];
  let calls = 0;

  for (const [ref, rows] of groups) {
    const entry = byId.get(ref) as LedgerEntry;
    if (entry.method !== "GET") {
      errors.push(`${ref}: weighted (POST) pools are not replayed`);
      continue;
    }
    const params: Record<string, ParamValue> = { ...entry.params };
    delete params["signal.interests.entities"];
    delete params["signal.interests.tags"];
    delete params["feature.explainability"];
    Object.assign(params, signal);
    ledger.node(`${TWIN_NODE}, ${tileLabel(entry)}`, "venue");
    calls++;
    try {
      const r = await run.insights(params as Parameters<QlooClient["insights"]>[0]);
      refs.push(r.ledgerRef);
      const houseRank = new Map<string, number>();
      r.value.entities.forEach((e, i) => {
        if (!houseRank.has(e.entityId)) houseRank.set(e.entityId, i + 1);
      });
      for (const p of rows) {
        const h = houseRank.get(p.entity.entityId);
        const delta = h === undefined ? null : h - p.qlooRank;
        chipsFor.set(p.entity.entityId, { label: twinChipLabel(delta, r.value.entities.length), ledgerRef: r.ledgerRef });
      }
    } catch (err) {
      const failedRef = (err as { ledgerRef?: string }).ledgerRef;
      if (failedRef) refs.push(failedRef);
      errors.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ledgerOut = sink.entries();
  if (chipsFor.size === 0 && ledgerOut.length === sheet.ledger.length) return { ...none("no twin answered"), calls, errors };
  const card = sheet.cards.partners;
  const next: StreetSheet = {
    ...sheet,
    ledger: ledgerOut,
    cards: {
      ...sheet.cards,
      partners: {
        ...card,
        results: card.results.map((p) => {
          const chip = chipsFor.get(p.entity.entityId);
          return chip ? { ...p, chips: [...p.chips, chip] } : p;
        }),
        provenance: [...new Set([...card.provenance, ...refs])],
        limits: chipsFor.size > 0 && !card.limits.includes(TWIN_LIMIT) ? [...card.limits, TWIN_LIMIT] : card.limits,
      },
    },
  };
  return { sheet: next, calls, chips: chipsFor.size, errors };
}
