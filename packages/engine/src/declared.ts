/**
 * The operator's own partner and group-sales list in call order (Q11:
 * `filter.results.entities` scored with the bill as signal).
 */
import type { Chip, DeclaredPartner, DeclaredPartnerScore, QlooEntity } from "@walkup/contracts";

export const DECLARED_NOT_SCORED = "not in Qloo's catalog, kept in your order" as const;

export interface RankDeclaredOptions {
  /** Ledger id of the Q11 call. Without it no chips are attached. */
  ledgerRef?: string;
  /** Chip label for scored entries. Default "ranked for this bill". */
  scoredLabel?: string;
}

/**
 * Rank = 1-based position among the returned entities that match a declared
 * entity id (Qloo response order). Declared partners with no entity id, or whose
 * id Qloo did not return, get rank null ("not in Qloo's catalog, kept in your order"). Output: scored
 * entries by rank, then unscored ones in the operator's order.
 */
export function rankDeclaredPartners(
  declared: readonly DeclaredPartner[],
  scoredEntities: readonly QlooEntity[],
  opts: RankDeclaredOptions = {},
): DeclaredPartnerScore[] {
  const wanted = new Set(declared.map((d) => d.qlooEntityId?.trim()).filter((x): x is string => !!x));
  const rankById = new Map<string, { rank: number; entity: QlooEntity }>();
  let r = 0;
  for (const e of scoredEntities) {
    const id = e?.entityId?.trim();
    if (!id || !wanted.has(id) || rankById.has(id)) continue;
    r += 1;
    rankById.set(id, { rank: r, entity: e });
  }
  const scoredLabel = opts.scoredLabel ?? "ranked for this bill";
  const rows = declared.map((d, inputIndex) => {
    const id = d.qlooEntityId?.trim();
    const hit = id ? rankById.get(id) : undefined;
    let row: DeclaredPartnerScore;
    if (hit) {
      const chips: Chip[] = opts.ledgerRef ? [{ label: scoredLabel, ledgerRef: opts.ledgerRef }] : [];
      row = { declared: d, rank: hit.rank, entity: hit.entity, chips };
    } else {
      // Sent to Qloo but not returned: the Q11 entry is the evidence. Never sent: no chip.
      const chips: Chip[] = id && opts.ledgerRef ? [{ label: DECLARED_NOT_SCORED, ledgerRef: opts.ledgerRef }] : [];
      row = { declared: d, rank: null, chips };
    }
    return { row, inputIndex };
  });
  rows.sort((a, b) => {
    const ra = a.row.rank;
    const rb = b.row.rank;
    if (ra !== null && rb !== null) return ra - rb || a.inputIndex - b.inputIndex;
    if (ra !== null) return -1;
    if (rb !== null) return 1;
    return a.inputIndex - b.inputIndex;
  });
  return rows.map((x) => x.row);
}
