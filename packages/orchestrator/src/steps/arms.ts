/**
 * The comparison arm, run after the sheet when asked (opts.arms):
 *  F: the fair control ("Without Qloo"). Same model with Google Places and ACS
 *     tools. With no model configured, fixed category queries ranked by Google
 *     rating stand in, and the arm says so.
 * Overlap with the Qloo list always uses @walkup/places matchPlaces.
 */
import type { ControlPlace, Partner } from "@walkup/contracts";
import { overlapWithQloo, type PlaceRecord } from "@walkup/places";
import { runControlArm, type AcsQuery, type PlacesSearchHit } from "@walkup/narrator";
import { node, venuePoint, type RunContext } from "../context";
import type { ArmRun } from "../types";

export const ARM_F_RADIUS_M = 5000;
const CATEGORY_QUERY: Record<string, string> = {
  bar: "bar",
  restaurant: "restaurant",
  cafe: "coffee shop",
  record_store: "record store",
  book_store: "book store",
  clothing_store: "clothing boutique",
  barber_shop: "barber shop",
  beauty_salon: "beauty salon",
  soul_food: "soul food restaurant",
  pub: "pub",
  sports_bar: "sports bar",
  bakery: "bakery",
};

function qlooPoints(partners: Partner[]) {
  return partners.map((p) => ({ name: p.entity.name, location: p.entity.location ? { lat: p.entity.location.lat, lon: p.entity.location.lon } : null }));
}

function hitOf(p: PlaceRecord): PlacesSearchHit {
  const hit: PlacesSearchHit = {
    placeId: p.placeId,
    name: p.name,
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? null,
    businessStatus: p.businessStatus ?? null,
    openingHours: p.regularOpeningHours?.weekdayDescriptions ?? null,
    types: p.types,
  };
  if (p.address !== undefined) hit.address = p.address;
  if (p.location) hit.location = p.location;
  return hit;
}

async function acsLookup(ctx: RunContext, q: AcsQuery): Promise<unknown> {
  if ("zcta" in q && ctx.acs) {
    node(ctx, "arm F (ACS lookup)", "arm");
    const r = await ctx.acs.byZctas([q.zcta]);
    return r.rows[0] ?? { zcta: q.zcta, note: "No ACS row for this ZCTA." };
  }
  return acsFromGazetteer(ctx, q);
}

function acsFromGazetteer(ctx: RunContext, q: AcsQuery): unknown {
  if ("point" in q) {
    const t = ctx.gazetteer.annotateTile({ lat: q.point.lat, lon: q.point.lon });
    return { name: t.name ?? null, zctas: t.zctas ?? [], adults21Plus: t.adultPopulation ?? null, source: "gazetteer (ACS 5-year)" };
  }
  return { zcta: q.zcta, note: "Look up by point for adults 21+ from the offline gazetteer." };
}

export async function runArmF(ctx: RunContext, partners: Partner[], categories: string[]): Promise<ArmRun> {
  const empty: ArmRun = { arm: "F", places: [], overlapWithQloo: [], ledgerRefs: [], status: "skipped", notes: [] };
  if (!ctx.places) return { ...empty, notes: ["No Google Places client configured; the control arm did not run."] };
  const places = ctx.places;
  const center = venuePoint(ctx);
  if (ctx.narrator.client) {
    node(ctx, "arm F (model + Google Places)", "arm");
    const run = await runControlArm(
      { bill: ctx.bill, operator: ctx.operator, center, radiusM: ARM_F_RADIUS_M, categories },
      {
        placesSearch: async (query, c, radiusM) => {
          const r = await places.searchText({ textQuery: query, center: c, radiusM });
          return { places: r.places.map(hitOf), ledgerRef: r.ledgerRef };
        },
        acsLookup: (q) => acsLookup(ctx, q),
      },
      { client: ctx.narrator.client, ...(ctx.narrator.spend ? { spend: ctx.narrator.spend } : {}), ledger: ctx.ledger },
    );
    return {
      arm: "F",
      places: run.places,
      overlapWithQloo: overlapWithQloo(run.places, qlooPoints(partners)),
      ledgerRefs: [...new Set(run.ledgerRefs)],
      status: `model: ${run.status}`,
      notes: run.notes,
    };
  }
  // Model off: fixed queries per partner category, ranked by rating x review count.
  const seen = new Map<string, { p: ControlPlace; s: number }>();
  const refs: string[] = [];
  for (const key of categories) {
    const label = CATEGORY_QUERY[key] ?? key.replace(/_/g, " ");
    const query = `${label} near ${ctx.bill.venue.city}`;
    node(ctx, "arm F (Google Places, model off)", "arm");
    try {
      const r = await places.searchText({ textQuery: query, center, radiusM: ARM_F_RADIUS_M, maxResultCount: 20 });
      refs.push(r.ledgerRef);
      for (const p of r.places) {
        if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
        const s = (p.rating ?? 0) * Math.log10((p.userRatingCount ?? 0) + 10);
        const prev = seen.get(p.placeId);
        if (!prev || s > prev.s) {
          const c: ControlPlace = { placeId: p.placeId, name: p.name, rating: p.rating ?? null, userRatingCount: p.userRatingCount ?? null, businessStatus: p.businessStatus ?? null, query };
          if (p.address !== undefined) c.address = p.address;
          if (p.location) c.location = p.location;
          seen.set(p.placeId, { p: c, s });
        }
      }
    } catch (err) {
      const ref = (err as { ledgerRef?: string }).ledgerRef;
      if (ref) refs.push(ref);
    }
  }
  const ranked = [...seen.values()].sort((a, b) => b.s - a.s || (a.p.placeId < b.p.placeId ? -1 : 1)).slice(0, 20).map((x) => x.p);
  return {
    arm: "F",
    places: ranked,
    overlapWithQloo: overlapWithQloo(ranked, qlooPoints(partners)),
    ledgerRefs: refs,
    status: "template",
    notes: ["No model key is set, so fixed searches by type, sorted by Google rating and review count, stood in for the model's own searches."],
  };
}
