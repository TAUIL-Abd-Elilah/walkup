/**
 * Q12 podcasts and Q13 one local sponsor, both with signal.location at the
 * venue. Scope reads "local" only when the day-one probe showed that
 * signal.location moves the ranking; otherwise "national". On shows that are
 * not 21+ (Ticketmaster), alcohol, tobacco and gambling brands are excluded.
 *
 * Oct 15 2026: with a seed Qloo has taste data for, both calls answer 200 with
 * 15 rows. The 400s the day-one probes saw came from a seed Qloo had no taste
 * data for, sent without signal.location. Seeds are checked in the resolve
 * step; if Qloo still ignores every seed here, the answer is ranked by place
 * alone and is not shown as this bill's list.
 *
 * Podcasts that ended or have no recent episodes (Qloo's release year, see
 * @walkup/engine media.ts) are left out when enough recent ones came back;
 * one kept to fill the list says "back catalogue". The sponsor shows by the
 * short name people know it by ("REI", not "Recreational Equipment Inc").
 */
import type { MediaPick, QlooEntity, StreetSheetCards } from "@walkup/contracts";
import { backCatalogueLabel, brandDisplayName, findAlcoholTerm, findDeniedTerm, isSensitiveTag, pickPodcasts, podcastRecency } from "@walkup/engine";
import { isAlcoholTag } from "@walkup/narrator";
import { cite, clean, droppedFrom, envelope, node, plural, signal, venuePoint, type RunContext, type Seed } from "../context";

export const PODCASTS_SHOWN = 4;
const RISKY_BRAND_WORDS = /\b(smoke|tobacco|vape|cigar|cigarette|casino|sportsbook|betting|wager|lottery|spirits|distillery|brewing|brewery|winery|liquor)\b/i;

type MediaCard = StreetSheetCards["media"];

/**
 * A podcast or brand never picked: a denied word in its name, or a tag denied for a sensitive reason. Tags denied
 * only as commercial noise (a Wikipedia category such as "Companies based in Anaheim", a credit card) never reach
 * the sheet and don't rule a well-known brand out.
 */
export function deniedEntity(e: QlooEntity): boolean {
  return findDeniedTerm(e.name) !== null || e.tags.some((t) => isSensitiveTag(t));
}

function adultOnlyBrand(e: QlooEntity): boolean {
  return (
    findAlcoholTerm(e.name) !== null ||
    RISKY_BRAND_WORDS.test(e.name) ||
    e.tags.some((t) => isAlcoholTag({ id: t.id, name: t.name }) || /(alcohol|tobacco|gambling)/.test(t.id))
  );
}

/** The plan's year (from its as-of date), for podcast recency. */
function asOfYear(ctx: RunContext): number {
  const y = Number(String(ctx.asOf).slice(0, 4));
  return Number.isFinite(y) && y > 1900 ? y : new Date(ctx.now()).getUTCFullYear();
}

export async function runMedia(ctx: RunContext, seeds: Seed[]): Promise<MediaCard> {
  const picks: MediaPick[] = [];
  const provenance: string[] = [];
  const reasons: string[] = [];
  const point = venuePoint(ctx);
  const sent = signal(ctx, seeds);
  let podcastOk = false;
  let sponsorOk = false;
  let staleLeftOut = 0;
  let backCatalogue = 0;
  /** Calls where Qloo ignored part ("some") or all of the bill's seeds as not_found. */
  const drops: ("some" | "all")[] = [];

  node(ctx, "Q12 podcasts", "bill");
  try {
    const r = await ctx.qloo.entityInsights("podcast", { signalEntities: sent, signalLocationPoint: point, explainability: true, take: 15 });
    provenance.push(r.ledgerRef);
    const drop = droppedFrom(r.meta, sent);
    if (drop.share !== "none") drops.push(drop.share);
    const allowed = drop.share === "all" ? [] : r.value.filter((e) => !deniedEntity(e));
    const chosen = pickPodcasts(allowed, (e) => e, asOfYear(ctx), PODCASTS_SHOWN);
    const kept = chosen.map((c) => c.item);
    // Stale shows Qloo ranked above the last one shown: they would have been on the list.
    const cut = kept.length >= PODCASTS_SHOWN ? Math.max(...kept.map((e) => allowed.indexOf(e))) : allowed.length;
    staleLeftOut = allowed.filter((e, i) => i < cut && !kept.includes(e) && ["old", "ended"].includes(podcastRecency(e, asOfYear(ctx)).status)).length;
    backCatalogue = chosen.filter((c) => c.backCatalogue).length;
    cite(ctx, kept, r.ledgerRef);
    const scope = ctx.probes.podcastLocationMoves ? "local" : "national";
    for (const c of chosen) {
      const chips = [{ label: scope === "local" ? "ranked for this bill near the venue" : "ranked for this bill; labelled national until the local probe shows movement", ledgerRef: r.ledgerRef }];
      if (c.backCatalogue) chips.push({ label: backCatalogueLabel(c.recency), ledgerRef: r.ledgerRef });
      picks.push({ entity: clean(ctx, c.item), kind: "podcast", scope, chips });
    }

    podcastOk = kept.length > 0;
    if (drop.share === "all") reasons.push("Qloo has no taste data for this bill's acts (Q12), so the podcast list would only rank by place and is left out");
    else if (!podcastOk) reasons.push("the podcast call was empty");
    else if (drop.share === "some") reasons.push(`Qloo has no taste data for ${plural(drop.dropped.length, "of the names behind this bill", "of the names behind this bill")} (Q12), so the podcasts rest on the others`);
  } catch (err) {
    const ref = (err as { ledgerRef?: string }).ledgerRef;
    if (ref) provenance.push(ref);
    reasons.push("the podcast call failed");
  }

  node(ctx, "Q13 sponsor", "bill");
  // Ticketmaster's 21+ is the only way in; the operator's all-ages setting can only take it away.
  const adult = ctx.bill.legalAgeEnforced === true && ctx.operator.allAges !== true;
  const exclusions = adult ? [] : Object.values(ctx.pins.sponsorExclusions);
  try {
    const r = await ctx.qloo.entityInsights("brand", { signalEntities: sent, signalLocationPoint: point, excludeTags: exclusions, explainability: true, take: 15 });
    provenance.push(r.ledgerRef);
    const drop = droppedFrom(r.meta, sent);
    if (drop.share !== "none") drops.push(drop.share);
    // The name and tag filter always runs: no exclusion tag is pinned yet (Oct 15), so on a show that is
    // not 21+ it is what keeps alcohol, tobacco and gambling brands off the card.
    const brand = drop.share === "all" ? undefined : r.value.find((e) => !deniedEntity(e) && (adult || !adultOnlyBrand(e)));
    if (drop.share === "all") {
      reasons.push("Qloo has no taste data for this bill's acts (Q13), so a sponsor would only rank by place and is left out");
    } else if (brand) {
      cite(ctx, [brand], r.ledgerRef);
      const scope = ctx.probes.brandLocationMoves ? "local" : "national";
      const shown = clean(ctx, brand);
      const display = brandDisplayName(shown);
      picks.push({
        entity: display === shown.name ? shown : { ...shown, name: display, properties: { ...shown.properties, legal_name: shown.name } },
        kind: "sponsor",
        scope,
        chips: [{ label: scope === "local" ? "brand affinity for this bill near the venue" : "brand affinity for this bill; labelled national until the local probe shows movement", ledgerRef: r.ledgerRef }],
      });
      sponsorOk = true;
    } else {
      reasons.push("no sponsor brand came back");
    }
  } catch (err) {
    const ref = (err as { ledgerRef?: string }).ledgerRef;
    if (ref) provenance.push(ref);
    reasons.push("the sponsor search failed, so there is no sponsor");
  }

  const podcasts = picks.filter((p) => p.kind === "podcast").length;
  const local = picks.some((p) => p.scope === "local");
  const parts: string[] = [];
  parts.push(podcasts > 0 ? `${plural(podcasts, "podcast")}${sponsorOk ? " and 1 sponsor brand" : ""}.` : sponsorOk ? "1 sponsor brand." : "No podcasts or sponsor.");
  if (picks.length > 0 && !local) parts.push("Local ranking not checked yet, so all are national.");
  if (staleLeftOut > 0) parts.push(`${plural(staleLeftOut, "show")} with no recent episodes left out.`);
  if (backCatalogue > 0) parts.push(`${plural(backCatalogue, "show")} marked back catalogue: no recent episodes, but too few current shows came back.`);
  if (!adult && exclusions.length > 0) {
    parts.push(
      ctx.bill.legalAgeEnforced === true
        ? "Alcohol, tobacco and gambling brands are excluded (you set the show to all ages)."
        : ctx.bill.legalAgeEnforced === false
        ? "Alcohol, tobacco and gambling brands are excluded (all-ages show per Ticketmaster)."
        : "Alcohol, tobacco and gambling brands are excluded (Ticketmaster lists no age policy, so the show is not treated as 21+).",
    );
  } else if (!adult && sponsorOk) {
    parts.push("Brands whose name or tags point to alcohol, tobacco or gambling are left out.");
  }
  let status: MediaCard["status"] = podcastOk && sponsorOk ? "ok" : picks.length > 0 ? "partial" : "empty";
  if (status === "ok" && drops.length > 0) status = "partial";
  if (picks.length === 0 && drops.length === 2 && drops.every((d) => d === "all")) status = "error";
  const joined = reasons.join("; ");
  const reason = reasons.length > 0 ? `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` : undefined;
  return envelope(status, parts.join(" "), picks, provenance, status === "ok" ? undefined : reason);
}
