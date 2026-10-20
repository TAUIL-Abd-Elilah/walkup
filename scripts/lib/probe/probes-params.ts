/** Probes 9-20: tag pinning and the parameters the product only uses if they are honoured. */

import { jaccard, topKOverlap } from "../stats.js";
import { anyEntities, audienceList, compareSides, dayState, heatCells, insightEntities } from "./extract.js";
import { aggregateTiles, topTiles } from "./heat.js";
import { nameSimilarity, normalizeName } from "./names.js";
import {
  audiencesRequest,
  compareRequest,
  entitiesBySpotify,
  heatmapRequest,
  placeInsights,
  typedInsights,
  weightedHeatmapPost,
} from "./requests.js";
import {
  type Resolved,
  billsAt,
  chooseVenue,
  findTag,
  findTagsAll,
  fmt,
  houseFor,
  httpFailureStatus,
  isDeniedTag,
  outcome,
  placeholderId,
  planned,
  pointOrAnchor,
  poolAt,
  resolveAct,
  resolveBill,
  scoredPoolAt,
  venuePoint,
} from "./shared.js";
import type { CallResult, Derived, ProbeContext, ProbeDef } from "./types.js";

function sameSequence(a: readonly string[], b: readonly string[], n: number): boolean {
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

/** Probe 9 pins a tag only when at least this share of the filtered rows carry it. */
const MIN_TAG_CARRY_SHARE = 0.5;

/** Bill A at the chosen room (first configured bill). */
async function billAAt(ctx: ProbeContext, venueKey: string): Promise<string[]> {
  const bill = billsAt(ctx, venueKey)[0];
  return bill ? (await resolveBill(ctx, bill)).ids : [];
}

export const probe9: ProbeDef = {
  id: 9,
  slug: "pin-place-tags",
  title: "Pin place category tags",
  criterion:
    "For each category keyword: a tag id is found via /v2/tags and filter.tags returns >= 5 places within 25 km of the room, at least half of which carry that tag (or a child of it), so a silently ignored filter is not pinned.",
  ifFails: "Drop that category from the pinned set.",
  maxCalls: 16,
  async run(ctx) {
    const c = ctx.cfg.p9;
    const point = venuePoint(ctx, c.venue);
    if (!point) return outcome("skipped", "no venue point", [`${c.venue} has no coordinates`]);
    const lines: string[] = [];
    const keys: Record<string, Derived> = {};
    const pinned: Record<string, string> = {};
    let ok = 0;
    for (const key of c.keys) {
      const tag = await findTag(ctx, key);
      if (!tag) {
        keys[key] = { found: false, pass: false };
        lines.push(`${key}: no tag found`);
        continue;
      }
      const res = await ctx.call(
        placeInsights({ point, radiusM: c.radiusM, tags: [tag.id], take: c.take, label: `places tagged ${key} near ${c.venue}` }),
      );
      if (ctx.dryRun) continue;
      const ents = res.status === 200 ? insightEntities(res.json) : [];
      // Unknown or inapplicable filters are ignored with 200, so row count alone does not show the filter worked.
      const carrying = ents.filter((e) => e.tagIds.some((t) => t === tag.id || t.startsWith(`${tag.id}:`))).length;
      const carryShare = ents.length > 0 ? carrying / ents.length : null;
      const pass = ents.length >= c.minRows && carryShare !== null && carryShare >= MIN_TAG_CARRY_SHARE;
      if (pass) {
        ok++;
        pinned[key] = tag.id;
      }
      keys[key] = { found: true, tagId: tag.id, exactName: tag.exact, query: tag.query, rows: ents.length, carryShare, status: res.status, pass };
      lines.push(
        `${key}: ${tag.id}${tag.exact ? "" : " (not an exact name match)"}, ${ents.length} rows, ${
          carryShare === null ? "n/a" : `${Math.round(carryShare * 100)}%`
        } carry the tag${carryShare !== null && carryShare < MIN_TAG_CARRY_SHARE ? " (filter may be ignored: not pinned)" : ""}${
          res.status === 200 ? "" : ` (HTTP ${res.status ?? "no response"})`
        }`,
      );
    }
    if (ctx.dryRun) return planned();
    const status = ok === c.keys.length ? "pass" : ok > 0 ? "partial" : "fail";
    return outcome(status, `${ok}/${c.keys.length} categories pinnable`, lines, { keys, pinnedCandidates: pinned });
  },
};

export const probe10: ProbeDef = {
  id: 10,
  slug: "filter-hours",
  title: "filter.hours is honoured",
  criterion: "Adding filter.hours=<day> to the room's pool call changes the results.",
  ifFails: "Parse properties.hours only.",
  maxCalls: 1,
  async run(ctx) {
    const c = ctx.cfg.p10;
    const base = await poolAt(ctx, c.venue);
    const hrs = await poolAt(ctx, c.venue, { hours: c.day });
    if (ctx.dryRun) return planned();
    if (!base || !hrs || base.ids.length === 0) return outcome("inconclusive", "empty pool", [`no pool near ${c.venue}`]);
    if (hrs.status !== 200) {
      return outcome(
        httpFailureStatus(hrs.status),
        `filtered call returned HTTP ${hrs.status ?? "no response"}`,
        [`the pool call with filter.hours=${c.day} returned HTTP ${hrs.status ?? "no response"}`],
        { day: c.day, filteredStatus: hrs.status },
      );
    }
    if (hrs.ids.length === 0) {
      return outcome("inconclusive", "filtered call returned no rows", [`filter.hours=${c.day} returned 0 rows (base ${base.ids.length})`], {
        day: c.day,
        baseRows: base.ids.length,
        filteredRows: 0,
      });
    }
    const changed = !sameSequence(base.ids, hrs.ids, Math.max(base.ids.length, hrs.ids.length));
    const closedBase = base.entities.filter((e) => dayState(e.hours, c.day) === "closed").length;
    const closedHrs = hrs.entities.filter((e) => dayState(e.hours, c.day) === "closed").length;
    const unknownBase = base.entities.filter((e) => dayState(e.hours, c.day) === "unknown").length;
    const derived = {
      day: c.day,
      baseRows: base.ids.length,
      filteredRows: hrs.ids.length,
      overlap: topKOverlap(base.ids, hrs.ids, base.ids.length),
      changed,
      closedOnDayInBase: closedBase,
      closedOnDayInFiltered: closedHrs,
      hoursUnknownInBase: unknownBase,
    };
    const lines = [
      `rows ${base.ids.length} -> ${hrs.ids.length}, overlap ${derived.overlap}, changed ${changed ? "yes" : "no"}`,
      `closed on ${c.day} (parsed properties.hours): ${closedBase} in base, ${closedHrs} with the filter; ${unknownBase} unknown`,
    ];
    if (changed) return outcome("pass", "results change", lines, derived);
    if (closedBase === 0) return outcome("inconclusive", "no change, but nothing in the pool is closed that day", lines, derived);
    return outcome("fail", "no change although some places are closed that day", lines, derived);
  },
};

export const probe11: ProbeDef = {
  id: 11,
  slug: "podcasts-signal-location",
  title: "Podcasts move with signal.location",
  criterion: "Podcasts for bill A with signal.location=POINT(room) vs none: top-15 overlap <= 12/15.",
  ifFails: 'Label the podcast card "national, not local".',
  maxCalls: 2,
  async run(ctx) {
    const c = ctx.cfg.p11;
    const v = chooseVenue(ctx, c.venue, c.fallbackVenue);
    if (!v) return outcome("skipped", "no venue point");
    const ids = await billAAt(ctx, v.key);
    if (ids.length === 0 && !ctx.dryRun) return outcome("inconclusive", "bill A not resolved");
    const a = await ctx.call(typedInsights({ kind: "podcast", signalEntities: ids, take: c.take, label: "podcasts for bill A (no location)" }));
    const b = await ctx.call(
      typedInsights({ kind: "podcast", signalEntities: ids, signalLocation: v.point, take: c.take, label: `podcasts for bill A at ${v.key}` }),
    );
    if (ctx.dryRun) return planned(v.note ? [v.note] : []);
    const la = insightEntities(a.json).map((e) => e.id);
    const lb = insightEntities(b.json).map((e) => e.id);
    const overlap = topKOverlap(la, lb, c.take);
    const derived = { venue: v.key, rowsNoLocation: la.length, rowsWithLocation: lb.length, overlap, sameOrder: sameSequence(la, lb, c.take) };
    const lines = [`top-${c.take} overlap ${overlap}/${c.take} (max ${c.maxOverlap}); rows ${la.length}/${lb.length}`];
    if (la.length === 0 || lb.length === 0) return outcome("inconclusive", "empty podcast list", lines, derived);
    return outcome(overlap <= c.maxOverlap ? "pass" : "fail", `overlap ${overlap}/${c.take}`, lines, derived);
  },
};

export const probe12: ProbeDef = {
  id: 12,
  slug: "brands-signal-location-exclusions",
  title: "Brands: signal.location and exclusions",
  criterion: "Brand ranking for bill A changes with signal.location, and filter.exclude.tags (alcohol) removes brands carrying those tags.",
  ifFails: "Hide the local sponsor card.",
  maxCalls: 5,
  async run(ctx) {
    const c = ctx.cfg.p12;
    const v = chooseVenue(ctx, c.venue, c.fallbackVenue);
    if (!v) return outcome("skipped", "no venue point");
    const ids = await billAAt(ctx, v.key);
    if (ids.length === 0 && !ctx.dryRun) return outcome("inconclusive", "bill A not resolved");
    const excl = await findTagsAll(ctx, c.excludeTagKey);
    const exclIds = excl.map((t) => t.id);
    const a = await ctx.call(typedInsights({ kind: "brand", signalEntities: ids, take: c.take, label: "brands for bill A (no location)" }));
    const b = await ctx.call(
      typedInsights({ kind: "brand", signalEntities: ids, signalLocation: v.point, take: c.take, label: `brands for bill A at ${v.key}` }),
    );
    const x =
      exclIds.length > 0
        ? await ctx.call(
            typedInsights({
              kind: "brand",
              signalEntities: ids,
              signalLocation: v.point,
              excludeTags: exclIds,
              take: c.take,
              label: `brands for bill A at ${v.key} excluding ${c.excludeTagKey}`,
            }),
          )
        : null;
    if (ctx.dryRun) return planned(v.note ? [v.note] : []);
    for (const [what, r] of [
      ["no-location", a],
      ["with-location", b],
    ] as const) {
      if (r.status !== 200) {
        return outcome(httpFailureStatus(r.status), `${what} brand call returned HTTP ${r.status ?? "no response"}`, [], { venue: v.key });
      }
    }
    const ea = insightEntities(a.json);
    const eb = insightEntities(b.json);
    const ex = x ? insightEntities(x.json) : [];
    const carries = (list: typeof eb): number => list.filter((e) => e.tagIds.some((t) => exclIds.includes(t))).length;
    const changed = !sameSequence(
      ea.map((e) => e.id),
      eb.map((e) => e.id),
      c.take,
    );
    const carriedWithLocation = carries(eb);
    const carriedExcluded = carries(ex);
    const derived = {
      venue: v.key,
      excludeTagIds: exclIds,
      rows: { noLocation: ea.length, withLocation: eb.length, excluded: ex.length },
      rankingChanged: changed,
      overlap: topKOverlap(
        ea.map((e) => e.id),
        eb.map((e) => e.id),
        c.take,
      ),
      carryingExcludedTagWithLocation: carriedWithLocation,
      carryingExcludedTagAfterExclusion: carriedExcluded,
    };
    const lines = [
      `ranking changed with signal.location: ${changed ? "yes" : "no"} (overlap ${derived.overlap}/${c.take})`,
      exclIds.length === 0
        ? `no ${c.excludeTagKey} tags found; exclusion untested`
        : `brands carrying ${c.excludeTagKey} tags: ${carriedWithLocation} before, ${carriedExcluded} after exclusion`,
    ];
    if (ea.length === 0 || eb.length === 0) return outcome("inconclusive", "empty brand list", lines, derived);
    if (x && x.status !== 200) {
      lines.push(`the exclusion call returned HTTP ${x.status ?? "no response"}`);
      return outcome(
        changed ? httpFailureStatus(x.status) : "fail",
        `changed ${changed ? "yes" : "no"}; exclusion call HTTP ${x.status ?? "no response"}`,
        lines,
        derived,
      );
    }
    if (x && ex.length === 0) {
      lines.push("the exclusion call returned no rows");
      return outcome(changed ? "inconclusive" : "fail", `changed ${changed ? "yes" : "no"}; exclusion returned no rows`, lines, derived);
    }
    if (!changed || carriedExcluded > 0) return outcome("fail", `changed ${changed ? "yes" : "no"}, excluded leftovers ${carriedExcluded}`, lines, derived);
    if (exclIds.length === 0 || carriedWithLocation === 0) return outcome("partial", "ranking changes; exclusion not testable here", lines, derived);
    return outcome("pass", "ranking changes; exclusions honoured", lines, derived);
  },
};

export const probe13: ProbeDef = {
  id: 13,
  slug: "compare-bill-vs-house",
  title: "Compare: bill vs house",
  criterion: "/v2/analysis/compare (a = bill A, b = house) returns at least 5 non-generic, policy-allowed tags distinctive to side a.",
  ifFails: "Use the tag-diff fallback (two urn:tag calls diffed by rank) with a degraded badge.",
  maxCalls: 1,
  async run(ctx) {
    const c = ctx.cfg.p13;
    const v = chooseVenue(ctx, ctx.cfg.kg2.venue, ctx.cfg.kg2.fallbackVenue);
    if (!v) return outcome("skipped", "no venue point");
    const a = await billAAt(ctx, v.key);
    const house = await houseFor(ctx, v.key);
    if (!ctx.dryRun && (a.length === 0 || house.ids.length === 0)) return outcome("inconclusive", "bill or house not resolved");
    const res = await ctx.call(compareRequest(a, house.ids, c.take, `compare bill A vs house at ${v.key}`));
    if (ctx.dryRun) return planned([`house: ${house.note}`]);
    const sides = compareSides(res.json);
    const genericNames = new Set(c.genericNames.map(normalizeName));
    const isGeneric = (id: string, name: string): boolean =>
      genericNames.has(normalizeName(name)) || c.genericPrefixes.some((p) => id.startsWith(p));
    const denied = sides.a.filter((t) => isDeniedTag(t.id, t.name)).length;
    const distinctive = sides.a.filter((t) => !isDeniedTag(t.id, t.name) && !isGeneric(t.id, t.name)).length;
    const derived = {
      venue: v.key,
      houseSource: house.source,
      status: res.status,
      sharedTags: sides.shared.length,
      aTags: sides.a.length,
      bTags: sides.b.length,
      aDenied: denied,
      aDistinctiveUsable: distinctive,
    };
    const lines = [`shared ${sides.shared.length}, a ${sides.a.length}, b ${sides.b.length}; usable distinctive a-tags ${distinctive} (denied ${denied})`];
    return outcome(distinctive >= c.minDistinctive ? "pass" : "fail", `${distinctive} usable a-tags`, lines, derived);
  },
};

export const probe14: ProbeDef = {
  id: 14,
  slug: "post-weighted-signals",
  title: "POST insights with weighted entities",
  criterion: "POST /v2/insights with {entity, weight} objects returns 200, and swapping the weights changes the top heatmap tiles.",
  ifFails: "GET only; no weight-based bill balance.",
  maxCalls: 2,
  async run(ctx) {
    const c = ctx.cfg.p14;
    const v = chooseVenue(ctx, c.venue, c.fallbackVenue);
    if (!v) return outcome("skipped", "no venue point");
    const bills = billsAt(ctx, v.key);
    const actA = bills[0]?.acts[0];
    const actB = bills[1]?.acts[0];
    if (!actA || !actB) return outcome("skipped", "needs two bills");
    const ra = await resolveAct(ctx, actA);
    const rb = await resolveAct(ctx, actB);
    if (!ra || !rb) {
      if (ctx.dryRun) return planned();
      return outcome("inconclusive", "acts not resolved");
    }
    const [hi, lo] = c.weights;
    const w1 = await ctx.call(
      weightedHeatmapPost({
        point: v.point,
        radiusM: c.radiusM,
        weighted: [
          { entity: ra.id, weight: hi },
          { entity: rb.id, weight: lo },
        ],
        label: `POST heatmap weighted toward bill A at ${v.key}`,
      }),
    );
    const w2 = await ctx.call(
      weightedHeatmapPost({
        point: v.point,
        radiusM: c.radiusM,
        weighted: [
          { entity: ra.id, weight: lo },
          { entity: rb.id, weight: hi },
        ],
        label: `POST heatmap weighted toward bill B at ${v.key}`,
      }),
    );
    if (ctx.dryRun) return planned(v.note ? [v.note] : []);
    const t1 = topTiles(aggregateTiles(heatCells(w1.json)), c.topCells);
    const t2 = topTiles(aggregateTiles(heatCells(w2.json)), c.topCells);
    const jac = jaccard(t1, t2);
    const derived = { venue: v.key, statuses: [w1.status, w2.status], topTiles: [t1.size, t2.size], topTileJaccard: jac };
    const lines = [`statuses ${w1.status}/${w2.status}; top-${c.topCells} tile Jaccard between weightings ${fmt(jac)} (pass below ${c.maxTopJaccard})`];
    if (w1.status !== 200 || w2.status !== 200) return outcome("fail", `POST status ${w1.status}/${w2.status}`, lines, derived);
    if (t1.size === 0 || t2.size === 0) return outcome("inconclusive", "empty heatmaps", lines, derived);
    return outcome(jac < c.maxTopJaccard ? "pass" : "fail", `top-tile J ${fmt(jac)}`, lines, derived);
  },
};

export const probe15: ProbeDef = {
  id: 15,
  slug: "results-entities-by-name",
  title: "filter.results.entities.query by name",
  criterion: "Scoring a shortlist given by place names (no ids) resolves at least 2 of the 3 names.",
  ifFails: "Partner lists come from a /search pick list only.",
  maxCalls: 1,
  async run(ctx) {
    const c = ctx.cfg.p15;
    const point = venuePoint(ctx, c.venue);
    if (!point) return outcome("skipped", "no venue point");
    const ids = await billAAt(ctx, c.venue);
    const res = await ctx.call(
      placeInsights({
        point,
        radiusM: c.radiusM,
        signalEntities: ids,
        resultsEntitiesQuery: c.names,
        take: Math.max(c.names.length * 2, 5),
        label: `shortlist by name near ${c.venue}`,
      }),
    );
    if (ctx.dryRun) {
      ctx.state.nameQueryWorks = true;
      return planned(["dry run assumes this passes, so probe 20 is planned with one name-query call"]);
    }
    const ents = res.status === 200 ? insightEntities(res.json) : [];
    const matched = c.names.filter((n) => ents.some((e) => nameSimilarity(e.name, n) >= c.minNameSimilarity)).length;
    const works = matched >= c.minResolved;
    ctx.state.nameQueryWorks = works;
    return outcome(works ? "pass" : "fail", `${matched}/${c.names.length} names resolved`, [`status ${res.status}, rows ${ents.length}, names matched ${matched}/${c.names.length}`], {
      status: res.status,
      rows: ents.length,
      namesMatched: matched,
      names: c.names.length,
    });
  },
};

export const probe16: ProbeDef = {
  id: 16,
  slug: "demographics-signal-on-places",
  title: "signal.demographics.age moves place ranking",
  criterion: "Adding signal.demographics.age to the scored pool call changes the top 10.",
  ifFails: "Do not feed demographics back into place calls.",
  maxCalls: 1,
  async run(ctx) {
    const c = ctx.cfg.p16;
    const base = await scoredPoolAt(ctx, c.venue, 0);
    const demo = await scoredPoolAt(ctx, c.venue, 0, { demographicsAge: c.ageBuckets });
    if (ctx.dryRun) return planned();
    if (!base || !demo || base.ids.length === 0) return outcome("inconclusive", "no scored pool");
    if (demo.status !== 200) {
      return outcome(httpFailureStatus(demo.status), `age-signal call returned HTTP ${demo.status ?? "no response"}`, [], {
        statuses: [base.status, demo.status],
      });
    }
    if (demo.ids.length === 0) return outcome("inconclusive", "age-signal call returned no rows", [], { statuses: [base.status, demo.status] });
    const changed = !sameSequence(base.ids, demo.ids, c.topN);
    const overlap = topKOverlap(base.ids, demo.ids, c.topN);
    const lines = [`age buckets ${c.ageBuckets.join(", ")}: top-${c.topN} ${changed ? "changed" : "unchanged"}, overlap ${overlap}/${c.topN}`];
    return outcome(changed ? "pass" : "fail", `top-${c.topN} ${changed ? "changed" : "unchanged"} (overlap ${overlap})`, lines, {
      ageBuckets: c.ageBuckets,
      changed,
      overlap,
      statuses: [base.status, demo.status],
    });
  },
};

export const probe17: ProbeDef = {
  id: 17,
  slug: "audiences",
  title: "/v2/audiences lookup and effect",
  criterion: "Audience search returns URNs for each keyword, and the first alumni URN as signal.demographics.audiences moves the scored pool's top 10.",
  ifFails: "Cut the declared-audience re-ranking.",
  maxCalls: 3,
  async run(ctx) {
    const c = ctx.cfg.p17;
    const found: Record<string, Derived> = {};
    let rankUrn: string | null = null;
    for (const q of c.queries) {
      const res = await ctx.call(audiencesRequest(q));
      if (res.dry) {
        if (q === c.rankQuery) rankUrn = placeholderId("audience", q);
        continue;
      }
      const list = audienceList(res.json);
      const families = [...new Set(list.map((a) => a.id.split(":").slice(0, 3).join(":")))];
      found[q] = { status: res.status, urns: list.length, families };
      if (q === c.rankQuery && list[0]) rankUrn = list[0].id;
    }
    let moved: boolean | null = null;
    let overlap: number | null = null;
    let audStatus: number | null = null;
    if (rankUrn) {
      const base = await scoredPoolAt(ctx, c.venue, 0);
      const aud = await scoredPoolAt(ctx, c.venue, 0, { audiences: [rankUrn] });
      audStatus = aud?.status ?? null;
      // A failed or empty audience call is "not tested", never "moved".
      if (!ctx.dryRun && base && aud && base.ids.length > 0 && aud.status === 200 && aud.ids.length > 0) {
        moved = !sameSequence(base.ids, aud.ids, c.topN);
        overlap = topKOverlap(base.ids, aud.ids, c.topN);
      }
    }
    if (ctx.dryRun) return planned();
    const allFound = c.queries.every((q) => ((found[q]?.urns as number | undefined) ?? 0) > 0);
    const lines = [
      ...c.queries.map((q) => `${q}: ${(found[q]?.urns as number | undefined) ?? 0} URNs`),
      `ranking moved with "${c.rankQuery}" audience: ${moved === null ? "not tested" : moved ? "yes" : "no"}${
        rankUrn && audStatus !== 200 ? ` (audience call HTTP ${audStatus ?? "no response"})` : ""
      }`,
    ];
    const status = allFound && moved ? "pass" : allFound && moved === null ? "inconclusive" : "fail";
    return outcome(status, `URNs for ${Object.values(found).filter((f) => (f.urns as number) > 0).length}/${c.queries.length}; moved ${moved ?? "n/a"}`, lines, {
      queries: found,
      rankUrn,
      moved,
      overlap,
      audienceCallStatus: audStatus,
    });
  },
};

export const probe18: ProbeDef = {
  id: 18,
  slug: "entities-by-spotify-id",
  title: "/entities by Spotify id for the room's roster",
  criterion: "At least 7 of 10 Ticketmaster roster acts resolve via external.spotify.ids.",
  ifFails: "Resolve the roster with typed /search instead.",
  maxCalls: 1,
  async run(ctx) {
    const c = ctx.cfg.p18;
    const ids = ctx.cfg.roster.spotifyIds.slice(0, c.maxIds);
    if (ids.length === 0) {
      return outcome("skipped", "needs roster.spotifyIds", ["fill roster.spotifyIds from the room's Ticketmaster attractions (externalLinks.spotify)"]);
    }
    const res = await ctx.call(entitiesBySpotify(ids, `roster acts by spotify id (${ids.length})`));
    if (ctx.dryRun) return planned();
    const resolved = res.status === 200 ? anyEntities(res.json).length : 0;
    const need = Math.ceil((c.minResolved / 10) * ids.length);
    return outcome(resolved >= need ? "pass" : "fail", `${resolved}/${ids.length} resolved`, [`status ${res.status}; resolved ${resolved}/${ids.length} (need ${need})`], {
      status: res.status,
      requested: ids.length,
      resolved,
      needed: need,
    });
  },
};

export const probe19: ProbeDef = {
  id: 19,
  slug: "comedy-heatmap-density-tacoma",
  title: "Comedy heatmap density around the club",
  criterion: "A comedy-tag heatmap within 60 km of the club has at least 200 cells.",
  ifFails: "The club scenario becomes a degraded card.",
  maxCalls: 3,
  async run(ctx) {
    const c = ctx.cfg.p19;
    const p = pointOrAnchor(ctx, c.venue);
    if (!p) return outcome("skipped", "no point or anchor");
    const tag = await findTag(ctx, c.tagKey);
    if (!tag) {
      if (ctx.dryRun) return planned();
      return outcome("inconclusive", "comedy tag not found");
    }
    const res = await ctx.call(
      heatmapRequest({ point: p.point, radiusM: c.radiusM, signalTags: [tag.id], label: `heatmap ${c.tagKey} tag near ${c.venue}${p.anchored ? " (city anchor)" : ""}` }),
    );
    if (ctx.dryRun) return planned(p.anchored ? [`${c.venue} has no coordinates; used its city anchor`] : []);
    if (res.status !== 200) {
      return outcome("inconclusive", `heatmap returned HTTP ${res.status ?? "no response"}`, ["no decision on an HTTP error; re-run this probe"], {
        status: res.status,
        tagId: tag.id,
        anchored: p.anchored,
      });
    }
    const cells = heatCells(res.json).length;
    return outcome(cells >= c.minCells ? "pass" : "fail", `${cells} cells`, [`status ${res.status}, ${cells} cells (need ${c.minCells}), tag ${tag.id}`], {
      status: res.status,
      cells,
      tagId: tag.id,
      anchored: p.anchored,
    });
  },
};

export const probe20: ProbeDef = {
  id: 20,
  slug: "guest-slate-scoring",
  title: "Guest-slate scoring (alternate plan check)",
  criterion: "Person entities scored against a podcast signal via filter.results.entities with explainability: 10/10 scored with non-uniform affinities.",
  ifFails: "The alternate plan is weaker; record it.",
  maxCalls: 12,
  async run(ctx) {
    const c = ctx.cfg.p20;
    const pod = await resolveAct(ctx, c.podcast);
    if (!pod) {
      if (ctx.dryRun) return planned();
      return outcome("fail", "podcast not resolved");
    }
    const useNames = ctx.state.nameQueryWorks === true;
    let res: CallResult;
    const resolvedGuests: (Resolved | null)[] = [];
    if (useNames) {
      res = await ctx.call(
        typedInsights({
          kind: "person",
          signalEntities: [pod.id],
          resultsEntitiesQuery: c.guests.map((g) => g.name),
          explainability: true,
          take: Math.min(50, c.guests.length * 2),
          label: "guest slate scored by name against the podcast",
        }),
      );
    } else {
      for (const g of c.guests) resolvedGuests.push(await resolveAct(ctx, g));
      const ids = resolvedGuests.filter((r): r is Resolved => r !== null).map((r) => r.id);
      if (ids.length === 0 && !ctx.dryRun) return outcome("fail", "no guests resolved");
      res = await ctx.call(
        typedInsights({
          kind: "person",
          signalEntities: [pod.id],
          resultsEntities: ids,
          explainability: true,
          take: Math.min(50, Math.max(ids.length, 10)),
          label: "guest slate scored by id against the podcast",
        }),
      );
    }
    if (ctx.dryRun) return planned([useNames ? "path: name query (one call)" : "path: typed /search per guest"]);
    const ents = res.status === 200 ? insightEntities(res.json) : [];
    const scored = useNames
      ? c.guests.filter((g) => ents.some((e) => nameSimilarity(e.name, g.name) >= 0.85)).length
      : ents.filter((e) => resolvedGuests.some((r) => r?.id === e.id)).length;
    const aff = ents.map((e) => e.affinity).filter((a): a is number => a !== null);
    const spread = aff.length > 1 ? Math.max(...aff) - Math.min(...aff) : 0;
    const distinct = new Set(aff.map((a) => a.toFixed(4))).size;
    const explained = ents.filter((e) => e.explainCount > 0).length;
    const pass = scored >= c.minScored && spread >= c.minAffinitySpread && distinct >= c.minDistinct;
    if (!pass && useNames && scored < c.minScored) {
      // Probe 15 showed name queries work for places; persons may resolve differently, so a short
      // match count here says nothing about scoring. The id path runs when probe 15 is not in the run.
      return outcome(
        "inconclusive",
        `name query matched ${scored}/${c.guests.length} guests`,
        [
          `path name query; matched ${scored}/${c.guests.length} (status ${res.status})`,
          "re-run with `npm run probe -- --only=20` to resolve each guest with typed /search and score by id",
        ],
        { path: "name-query", status: res.status, scored, affinitySpread: spread, distinctAffinities: distinct, withExplainability: explained },
      );
    }
    return outcome(
      pass ? "pass" : "fail",
      `${scored}/${c.guests.length} scored, spread ${fmt(spread, 3)}`,
      [`path ${useNames ? "name query" : "typed search"}; scored ${scored}/${c.guests.length}; affinity spread ${fmt(spread, 3)}, ${distinct} distinct; ${explained} with explainability`],
      { path: useNames ? "name-query" : "typed-search", status: res.status, scored, affinitySpread: spread, distinctAffinities: distinct, withExplainability: explained },
    );
  },
};
