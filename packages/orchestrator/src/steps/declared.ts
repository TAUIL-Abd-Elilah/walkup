/**
 * Q11: the operator's own partner list in call order. Typed names go through
 * a /search pick list (exact match only, capped at 20); then one
 * filter.results.entities call scores the shortlist with the bill as signal.
 * Partners not in the catalog stay on the list in the operator's order ("not in Qloo's catalog, kept in your order").
 * Contact emails are never sent anywhere.
 */
import type { DeclaredPartner, DeclaredPartnerScore, StreetSheetCards } from "@walkup/contracts";
import { DECLARED_NOT_SCORED, rankDeclaredPartners } from "@walkup/engine";
import { resolveFromEntities } from "@walkup/qloo";
import { cite, clean, droppedFrom, droppedReason, envelope, failure, node, plural, signal, venuePoint, type RunContext, type Seed } from "../context";

export const MAX_TYPED_LOOKUPS = 20;

type DeclaredCard = StreetSheetCards["declared"];

export async function runDeclared(ctx: RunContext, seeds: Seed[]): Promise<DeclaredCard> {
  const declared = ctx.operator.declaredPartners ?? [];
  const empty: DeclaredPartnerScore[] = [];
  if (declared.length === 0) {
    return envelope("empty", "No list of your own partners came with this plan.", empty, []);
  }
  const provenance: string[] = [];
  const resolved: DeclaredPartner[] = [];
  let lookups = 0;
  for (const d of declared) {
    // Only the label is used; contactEmail never leaves this process.
    const copy: DeclaredPartner = { label: d.label };
    if (d.qlooEntityId) copy.qlooEntityId = d.qlooEntityId;
    if (!copy.qlooEntityId && lookups < MAX_TYPED_LOOKUPS) {
      lookups++;
      node(ctx, "Q11 declared pick list", "bill");
      try {
        const r = await ctx.qloo.search(d.label, ["place"], {
          location: venuePoint(ctx),
          radiusMiles: Math.min(100, Math.max(1, ctx.operator.radiusKm / 1.609344)),
          take: 5,
        });
        provenance.push(r.ledgerRef);
        const res = resolveFromEntities(d.label, r.value, { role: "partner" });
        if (res.status === "exact" && res.entity) copy.qlooEntityId = res.entity.entityId;
      } catch (err) {
        const ref = (err as { ledgerRef?: string }).ledgerRef;
        if (ref) provenance.push(ref);
      }
    }
    resolved.push(copy);
  }
  const ids = resolved.map((d) => d.qlooEntityId).filter((x): x is string => !!x);
  if (ids.length === 0) {
    const rows = rankDeclaredPartners(resolved, []);
    return envelope("partial", `${plural(declared.length, "declared partner")}, none in Qloo's catalog.`, rows, provenance, "None of your partners is a Qloo place, so none could be ranked; all stay on the list in your order.");
  }
  node(ctx, "Q11 declared partners", "bill");
  try {
    const sent = signal(ctx, seeds);
    const r = await ctx.qloo.placeInsights({ signalEntities: sent, resultsEntities: ids, explainability: true, take: Math.min(50, ids.length) });
    provenance.push(r.ledgerRef);
    const drop = droppedFrom(r.meta, sent);
    if (drop.share === "all") {
      // No usable signal: Qloo's order would be general popularity, so the list stays in the operator's order.
      return envelope("partial", `${plural(declared.length, "declared partner")}, kept in your order.`, rankDeclaredPartners(resolved, []), provenance, droppedReason(drop, "Q11") ?? undefined);
    }
    cite(ctx, r.value, r.ledgerRef);
    const rows = rankDeclaredPartners(resolved, r.value, { ledgerRef: r.ledgerRef }).map((row) => (row.entity ? { ...row, entity: clean(ctx, row.entity) } : row));
    const scored = rows.filter((x) => x.rank !== null).length;
    const unscored = rows.length - scored;
    const summary =
      unscored > 0
        ? `${scored} of ${rows.length} of your partners ranked for this bill; ${unscored} ${unscored === 1 ? "is" : "are"} ${DECLARED_NOT_SCORED}.`
        : `All ${rows.length} of your partners ranked for this bill, in call order.`;
    if (drop.share === "some") return envelope("partial", summary, rows, provenance, droppedReason(drop, "Q11") ?? undefined);
    return envelope("ok", summary, rows, provenance);
  } catch (err) {
    return failure(err, rankDeclaredPartners(resolved, []), "Your list, in call order");
  }
}
