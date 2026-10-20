/**
 * "None of these: use a proxy". When no candidate is the act on the bill, the
 * operator picks a film or TV title to stand in. The orchestrator resumes with
 * that title's entity id as the pick for the act (it fetches it by id, cites it
 * in the run's ledger, and does not remember it as the act's identity); this
 * step then labels the row honestly as a proxy seed, not an exact match.
 */
import type { Resolution, StreetSheet } from "@walkup/contracts";

/** Act name -> the film/TV entity id the operator chose to stand in. */
export type ProxyPicks = Record<string, string>;

function typeLabel(subtype: string): string {
  if (subtype.endsWith(":movie")) return "film";
  if (subtype.endsWith(":tv_show")) return "TV show";
  return subtype.split(":").pop() ?? subtype;
}

export function proxyReason(actName: string, row: Resolution): string {
  const e = row.entity;
  const year = typeof e?.properties.release_year === "number" ? `, ${e.properties.release_year}` : "";
  return `None of the candidates was ${actName}; the operator chose ${e?.name ?? "a title"} (${e ? typeLabel(e.subtype) : "title"}${year}) to stand in.`;
}

/** Relabels operator-chosen proxy rows on a finished sheet. */
export function applyProxyPicks(sheet: StreetSheet, picks: ProxyPicks | undefined): StreetSheet {
  if (!picks || Object.keys(picks).length === 0) return sheet;
  const card = sheet.cards.resolution;
  let changed = 0;
  const results = card.results.map((r): Resolution => {
    const want = picks[r.input];
    if (!want || r.entity?.entityId !== want || r.status !== "exact" || !r.entity) return r;
    changed++;
    const row: Resolution = { input: r.input, role: r.role, status: "proxy", proxy: { entity: r.entity, reason: proxyReason(r.input, r) } };
    if (r.ledgerRef) row.ledgerRef = r.ledgerRef;
    return row;
  });
  if (changed === 0) return sheet;
  const note = `${changed === 1 ? "1 act stands" : `${changed} acts stand`} in through a film or TV title the operator chose.`;
  const status = card.status === "ok" ? "partial" : card.status;
  const reason = card.reason ? `${card.reason} ${note}` : note;
  return {
    ...sheet,
    cards: { ...sheet.cards, resolution: { ...card, status, summary: `${card.summary} ${note}`, results, reason } },
  };
}
