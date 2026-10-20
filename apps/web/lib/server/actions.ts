/**
 * Where "Send to street team" A# entries are kept.
 *
 * - A plan this server ran (stored, by id): the entry is appended to the
 *   stored sheet's ledger, so every later view and export carries it.
 * - A preset sheet (shared by every visitor): the entry is kept for the
 *   visitor's session only, in memory, so one visitor's sends never show up
 *   on another visitor's sheet.
 */
import type { LedgerEntry, StreetSheet } from "@walkup/contracts";
import type { PlanStore } from "@walkup/orchestrator";

const KEY = "__walkupSessionActions";
const MAX_KEYS = 5000;

function overlay(): Map<string, LedgerEntry[]> {
  const g = globalThis as Record<string, unknown>;
  let m = g[KEY] as Map<string, LedgerEntry[]> | undefined;
  if (!m) {
    m = new Map();
    g[KEY] = m;
  }
  return m;
}

function k(planId: string, sessionId: string): string {
  return `${planId}\u0001${sessionId}`;
}

export function sessionActions(planId: string, sessionId: string | null): LedgerEntry[] {
  if (!sessionId) return [];
  return [...(overlay().get(k(planId, sessionId)) ?? [])];
}

export function addSessionAction(planId: string, sessionId: string, entry: LedgerEntry): void {
  const m = overlay();
  if (m.size >= MAX_KEYS && !m.has(k(planId, sessionId))) {
    const first = m.keys().next().value;
    if (first !== undefined) m.delete(first);
  }
  m.set(k(planId, sessionId), [...(m.get(k(planId, sessionId)) ?? []), entry]);
}

/** The sheet with this session's preset actions appended to its ledger. */
export function withSessionActions(sheet: StreetSheet, sessionId: string | null): StreetSheet {
  const extra = sessionActions(sheet.planId, sessionId);
  if (extra.length === 0) return sheet;
  const ids = new Set(sheet.ledger.map((e) => e.id));
  return { ...sheet, ledger: [...sheet.ledger, ...extra.filter((e) => !ids.has(e.id))] };
}

/** Appends an action to a stored plan's sheet. Returns false when the plan has no stored sheet. */
export async function appendStoredAction(store: PlanStore, planId: string, entry: LedgerEntry): Promise<boolean> {
  const stored = await store.get(planId);
  if (!stored?.sheet) return false;
  const ledger = stored.sheet.ledger.filter((e) => e.id !== entry.id);
  await store.put({ ...stored, sheet: { ...stored.sheet, ledger: [...ledger, entry] } });
  return true;
}

/** Next free A# id for a ledger. */
export function nextActionId(entries: readonly LedgerEntry[]): string {
  const max = entries.reduce((m, e) => (e.kind === "action" ? Math.max(m, Number(e.id.slice(1)) || 0) : m), 0);
  return `A${max + 1}`;
}

export function resetActionsForTests(): void {
  overlay().clear();
}
