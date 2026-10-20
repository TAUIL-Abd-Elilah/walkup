/**
 * The run ledger: wraps the per-run sink so every entry names the call-graph
 * node that made it ("Q9 partners, tile 2") and, in fixture mode, says the
 * answer came from the synthetic world. The node level drives the call budget.
 */
import type { LedgerEntry, LedgerSink } from "@walkup/contracts";

export type NodeLevel = "intake" | "bill" | "venue" | "arm" | "narration";

export interface NodeInfo {
  node: string;
  level: NodeLevel;
}

export interface RunLedger extends LedgerSink {
  /** Sets the node label for the entries added next (calls run one at a time). */
  node(label: string, level: NodeLevel): void;
  info(id: string): NodeInfo | undefined;
}

export function createRunLedger(base: LedgerSink, opts: { fixture: boolean }): RunLedger {
  let current: NodeInfo = { node: "intake", level: "intake" };
  const byId = new Map<string, NodeInfo>();
  return {
    node(label, level) {
      current = { node: label, level };
    },
    info(id) {
      return byId.get(id);
    },
    add(entry: Omit<LedgerEntry, "id">): string {
      const parts = [`node ${current.node}`];
      if (opts.fixture && entry.kind !== "anthropic" && entry.kind !== "action") parts.push("fixture world: synthetic response");
      if (entry.note) parts.push(entry.note);
      const id = base.add({ ...entry, note: parts.join("; ") });
      byId.set(id, { ...current });
      return id;
    },
    entries() {
      return base.entries();
    },
  };
}
