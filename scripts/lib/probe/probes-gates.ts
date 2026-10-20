/**
 * Probes 1-3: the go/no-go gates that run first (KG1, KG2, KG4).
 * KG3 is probe 6 (probes-entities.ts).
 */

import type { BarRowCfg } from "./config.js";
import { heatCells, insightEntities } from "./extract.js";
import { heatmapRequest, placeInsights } from "./requests.js";
import {
  type Resolved,
  below,
  billsAt,
  chooseVenue,
  findTag,
  fmt,
  houseFor,
  outcome,
  planned,
  poolAt,
  resolveAct,
  resolveBill,
  substitutionLines,
  resolvePlace,
  scoredPoolAt,
  tagIdsFor,
  venuePoint,
} from "./shared.js";
import type { Derived, ProbeContext, ProbeDef } from "./types.js";
import {
  type Kg1VenueMetrics,
  type Kg4Row,
  derbyPairs,
  heatAgreement,
  kg1Gate,
  kg1Venue,
  kg4Gate,
  liftMetrics,
  topJaccard,
} from "./verdicts.js";

function actsDerived(refs: (Resolved | null)[], names: string[]): Derived[] {
  return names.map((name, i) => {
    const r = refs[i] ?? null;
    return {
      act: name,
      resolved: r !== null,
      exact: r?.exact ?? false,
      popularity: r?.popularity ?? null,
      entityId: r?.id ?? null,
      droppedIds: r?.droppedIds ?? [],
      substitutedFrom: r?.substitutedFrom ?? null,
    };
  });
}

export const probe1: ProbeDef = {
  id: 1,
  slug: "kg1-taste-moves-partners",
  title: "KG1: taste moves partners",
  group: 1,
  gate: "KG1",
  criterion:
    "Per room, one pool of the same places scored by two contrasting bills: Kendall tau between bills < 0.8 and top-8 overlap <= 5/8; each bill vs the no-signal popularity order top-8 overlap <= 5/8. Gate: at least kg1.venuesRequired rooms pass.",
  ifFails: 'Partner cards say "ranked by Qloo" with no claim over popularity; review the alternate product plan before building partners further.',
  // All three kg1 rooms: the-truth plans its pool once key day fills its point.
  maxCalls: 22,
  async run(ctx) {
    const c = ctx.cfg.kg1;
    const lines: string[] = [];
    const venues: Record<string, Derived> = {};
    const metrics: Kg1VenueMetrics[] = [];
    for (const vKey of c.venues) {
      if (!venuePoint(ctx, vKey)) {
        venues[vKey] = { skipped: "no coordinates" };
        lines.push(`${vKey}: skipped (no coordinates yet; fill lat/lon from the Ticketmaster venue)`);
        continue;
      }
      const pool = await poolAt(ctx, vKey);
      const a = await scoredPoolAt(ctx, vKey, 0);
      const b = await scoredPoolAt(ctx, vKey, 1);
      if (ctx.dryRun || !pool) continue;

      const bills = billsAt(ctx, vKey);
      const bill0 = bills[0];
      const bill1 = bills[1];
      const ra = bill0 ? await resolveBill(ctx, bill0) : { refs: [] };
      const rb = bill1 ? await resolveBill(ctx, bill1) : { refs: [] };
      const billInfo = {
        billA: { genre: bill0?.genre ?? null, acts: actsDerived(ra.refs, bill0?.acts.map((x) => x.name) ?? []) },
        billB: { genre: bill1?.genre ?? null, acts: actsDerived(rb.refs, bill1?.acts.map((x) => x.name) ?? []) },
      };
      // resolveAct falls back to the top search hit; say so, since that entity is the signal being tested.
      for (const [bill, refs] of [
        [bill0, ra.refs],
        [bill1, rb.refs],
      ] as const) {
        bill?.acts.forEach((act, i) => {
          const r = refs[i];
          if (r && !r.exact) lines.push(`${vKey}: warning: "${act.name}" matched no exact name; the top search hit was used as the signal`);
        });
        if (bill) lines.push(...substitutionLines(`${vKey}: `, bill.acts, refs));
      }

      let m: Kg1VenueMetrics;
      if (pool.ids.length < c.minPool) {
        m = kg1Venue(pool.ids, [], [], c); // reason: pool too small (status in poolStatus)
      } else if (!a || !b || a.status !== 200 || b.status !== 200) {
        m = { ...kg1Venue(pool.ids, [], [], c), evaluable: false, pass: false, reason: "a bill did not resolve or a scored call failed" };
      } else {
        m = kg1Venue(pool.ids, a.ids, b.ids, c);
      }
      metrics.push(m);
      const spread = (xs: (number | null)[]): number | null => {
        const v = xs.filter((x): x is number => x !== null);
        return v.length > 1 ? Math.max(...v) - Math.min(...v) : null;
      };
      venues[vKey] = {
        ...billInfo,
        poolStatus: pool.status,
        poolTagIds: pool.tagIds,
        poolMissingTagKeys: pool.missingTags,
        ...m,
        affinitySpreadA: a ? spread(a.entities.map((e) => e.affinity)) : null,
        affinitySpreadB: b ? spread(b.entities.map((e) => e.affinity)) : null,
      };
      lines.push(
        `${vKey}: pool ${m.poolSize}, tau(A,B) ${fmt(m.tauAB)} over ${m.tauN}, top-${c.topK} A/B ${m.topKAB}, A/pop ${m.topKAvsPop}, B/pop ${m.topKBvsPop} -> ${
          m.pass ? "pass" : m.evaluable ? "fail" : `not evaluable (${m.reason})`
        }`,
      );
    }
    if (ctx.dryRun) return planned(lines);
    const gate = kg1Gate(metrics, c.venuesRequired);
    return outcome(gate.status, `${gate.passed}/${gate.evaluable} rooms pass (need ${c.venuesRequired})`, lines, {
      venues,
      passed: gate.passed,
      evaluable: gate.evaluable,
      required: c.venuesRequired,
    });
  },
};

export const probe2: ProbeDef = {
  id: 2,
  slug: "kg2-lift-differs-from-heat",
  title: "KG2: lift differs from heat",
  group: 2,
  gate: "KG2",
  criterion:
    "Bill, house and generic heatmaps around the room, for both bills: Spearman(lift, raw heat) < 0.8 for each bill, and top-decile lift tile Jaccard between the bills < 0.5.",
  ifFails: "Demote the map to context; rank partners near the venue instead of by tile.",
  maxCalls: 8,
  async run(ctx) {
    const c = ctx.cfg.kg2;
    const v = chooseVenue(ctx, c.venue, c.fallbackVenue);
    if (!v) return outcome("skipped", "no venue with coordinates", ["neither the room nor its fallback has coordinates"]);
    const lines: string[] = [];
    if (v.note) lines.push(v.note);
    const bills = billsAt(ctx, v.key);
    const bill0 = bills[0];
    const bill1 = bills[1];
    if (!bill0 || !bill1) return outcome("skipped", "no bills", [`no test bills configured for ${v.key}`]);
    const A = await resolveBill(ctx, bill0);
    const B = await resolveBill(ctx, bill1);
    lines.push(...substitutionLines("bill A: ", bill0.acts, A.refs), ...substitutionLines("bill B: ", bill1.acts, B.refs));
    const house = await houseFor(ctx, v.key);
    lines.push(`house: ${house.note}`);
    const generic = await findTag(ctx, c.genericTagKey);
    if (!ctx.dryRun && (A.ids.length === 0 || B.ids.length === 0 || house.ids.length === 0)) {
      return outcome("inconclusive", "bill or house did not resolve", lines, { venue: v.key, houseSize: house.ids.length });
    }
    const heat = (label: string, o: { signalEntities?: string[]; signalTags?: string[] }) =>
      ctx.call(heatmapRequest({ point: v.point, radiusM: c.radiusM, ...o, label: `heatmap ${label} at ${v.key}` }));
    const hA = await heat("bill A", { signalEntities: A.ids });
    const hB = await heat("bill B", { signalEntities: B.ids });
    const hH = await heat("house", { signalEntities: house.ids });
    const hG = generic ? await heat("generic baseline", { signalTags: [generic.id] }) : null;
    if (ctx.dryRun) return planned(lines);

    const cellsA = heatCells(hA.json);
    const cellsB = heatCells(hB.json);
    const cellsH = heatCells(hH.json);
    const cellsG = hG ? heatCells(hG.json) : [];
    const opts = { shrinkBelow: c.shrinkBelowPopularity, topFraction: c.topFraction };
    const la = liftMetrics(cellsA, cellsH, opts);
    const lb = liftMetrics(cellsB, cellsH, opts);
    const jac = topJaccard(la.top, lb.top);
    const diag = cellsG.length > 0 ? heatAgreement(cellsA, cellsG) : { joined: 0, rho: NaN };
    const derived: Derived = {
      venue: v.key,
      houseSource: house.source,
      houseSize: house.ids.length,
      genericTagId: generic?.id ?? null,
      statuses: { billA: hA.status, billB: hB.status, house: hH.status, generic: hG?.status ?? null },
      cells: { billA: cellsA.length, billB: cellsB.length, house: cellsH.length, generic: cellsG.length },
      tiles: { billA: la.tiles, billB: lb.tiles },
      joined: { billA: la.joined, billB: lb.joined },
      spearmanLiftVsHeat: { billA: la.spearmanLiftVsHeat, billB: lb.spearmanLiftVsHeat },
      topDecileJaccardAB: jac,
      topDecileSize: { billA: la.top.size, billB: lb.top.size },
      diagnosticSpearmanHeatAVsGeneric: diag.rho,
      diagnosticJoinedAVsGeneric: diag.joined,
    };
    lines.push(
      `cells A/B/house/generic: ${cellsA.length}/${cellsB.length}/${cellsH.length}/${cellsG.length}`,
      `Spearman(lift, heat): A ${fmt(la.spearmanLiftVsHeat)}, B ${fmt(lb.spearmanLiftVsHeat)} (max ${c.maxSpearman})`,
      `top-decile lift Jaccard A vs B: ${fmt(jac)} (max ${c.maxTopJaccard})`,
      `diagnostic: Spearman(raw heat A, generic heat) ${fmt(diag.rho)} over ${diag.joined} tiles`,
    );
    if (la.joined < 20 || lb.joined < 20) return outcome("inconclusive", "too few joined tiles", lines, derived);
    const pass = below(la.spearmanLiftVsHeat, c.maxSpearman) && below(lb.spearmanLiftVsHeat, c.maxSpearman) && below(jac, c.maxTopJaccard);
    return outcome(
      pass ? "pass" : "fail",
      `rho A ${fmt(la.spearmanLiftVsHeat)}, B ${fmt(lb.spearmanLiftVsHeat)}; top-decile J ${fmt(jac)}`,
      lines,
      derived,
    );
  },
};

/** Fills null bar rows from the optional private bar file (same club/metro keys). */
export function mergeBars(rows: readonly BarRowCfg[], file: unknown): BarRowCfg[] {
  const extra = Array.isArray(file) ? file : [];
  return rows.map((r) => {
    if (r.barName) return r;
    const hit = extra.find(
      (x): x is Record<string, unknown> =>
        typeof x === "object" && x !== null && (x as Record<string, unknown>).club === r.club && (x as Record<string, unknown>).metro === r.metro,
    );
    if (!hit || typeof hit.barName !== "string" || hit.barName === "") return r;
    return {
      club: r.club,
      metro: r.metro,
      barName: hit.barName,
      lat: typeof hit.lat === "number" ? hit.lat : null,
      lon: typeof hit.lon === "number" ? hit.lon : null,
      sourceUrl: typeof hit.sourceUrl === "string" ? hit.sourceUrl : null,
    };
  });
}

export const probe3: ProbeDef = {
  id: 3,
  slug: "kg4-fan-bar-viability",
  title: "KG4: fan-bar test viability",
  group: 3,
  gate: "KG4",
  criterion:
    "3 clubs x 3 metros: official supporters' bars resolve as Qloo places and land in the club-signal top 50 bars/pubs within 25 km. Pass: >= 6/9 resolve and >= 3/9 in the top 50.",
  ifFails: "The fan-bar test still runs; the headline proof moves to the same-room (P2) and blind-review (P4) checks.",
  maxCalls: 24,
  async run(ctx: ProbeContext) {
    const c = ctx.cfg.kg4;
    const lines: string[] = [];
    const clubs = new Map<string, Resolved | null>();
    for (const club of c.clubs) clubs.set(club.key, await resolveAct(ctx, { name: club.name, kind: "brand", aliases: club.aliases }));
    const tags = await tagIdsFor(ctx, c.barTagKeys);
    if (tags.missing.length > 0 && !ctx.dryRun) lines.push(`bar tag keys not found: ${tags.missing.join(", ")}`);

    const lists = new Map<string, string[]>();
    const listStatus: Record<string, number | null> = {};
    for (const club of c.clubs) {
      const r = clubs.get(club.key);
      if (!r) continue;
      for (const m of c.metros) {
        const res = await ctx.call(
          placeInsights({
            point: m,
            radiusM: c.radiusM,
            signalEntities: [r.id],
            tags: tags.ids,
            tagsOperator: "union",
            take: c.take,
            label: `bars near ${m.key} ranked by ${club.key} signal`,
          }),
        );
        listStatus[`${club.key}|${m.key}`] = res.status;
        if (!res.dry && res.status === 200) lists.set(`${club.key}|${m.key}`, insightEntities(res.json).map((e) => e.id));
      }
    }

    const rows = mergeBars(c.bars, c.barsFile ? ctx.readOptionalJson(c.barsFile) : null);
    const unlisted = rows.filter((r) => !r.barName).length;
    if (unlisted > 0) lines.push(`${unlisted}/${rows.length} rows have no bar yet (fill kg4.bars or the private bars file)`);
    const out: Kg4Row[] = [];
    const rowDerived: Derived[] = [];
    const barIds = new Map<string, string>();
    for (const row of rows) {
      const metro = c.metros.find((m) => m.key === row.metro);
      if (!row.barName || !metro) {
        out.push({ club: row.club, metro: row.metro, barListed: false, resolved: false, rank: null });
        rowDerived.push({ club: row.club, metro: row.metro, barListed: false });
        continue;
      }
      const truePoint = row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : null;
      const near = truePoint
        ? { ...truePoint, radiusMiles: c.barSearchRadiusMiles }
        : { lat: metro.lat, lon: metro.lon, radiusMiles: c.metroSearchRadiusMiles };
      const match = await resolvePlace(ctx, row.barName, near, {
        minSimilarity: c.minNameSimilarity,
        maxDistanceM: c.maxBarDistanceM,
        truePoint,
      });
      const id = match.resolved?.id ?? null;
      const list = lists.get(`${row.club}|${row.metro}`);
      const idx = id && list ? list.indexOf(id) : -1;
      const rank = idx >= 0 ? idx + 1 : null;
      if (id) barIds.set(`${row.club}|${row.metro}`, id);
      out.push({ club: row.club, metro: row.metro, barListed: true, resolved: id !== null, rank });
      rowDerived.push({
        club: row.club,
        metro: row.metro,
        barListed: true,
        resolved: id !== null,
        entityId: id,
        nameSimilarity: match.similarity,
        distanceM: match.distanceM,
        rankInClubSignalTop: rank,
        clubListSize: list?.length ?? null,
      });
    }
    if (ctx.dryRun) return planned(lines);

    let gate = kg4Gate(out, c.minResolved, c.minInTop);
    // A list call that errored cannot rank its bar: treat a fail that may come from it as no decision.
    const failedLists = Object.entries(listStatus).filter(([, s]) => s !== 200).map(([k]) => k);
    if (gate.status === "fail" && failedLists.length > 0) {
      lines.push(`club-signal list calls without a 200: ${failedLists.join(", ")}; no decision until they succeed`);
      gate = { ...gate, status: "inconclusive" };
    }
    const derby = derbyPairs(
      lists,
      barIds,
      c.clubs.map((x) => x.key),
      c.metros.map((m) => m.key),
    );
    const clubDerived: Record<string, Derived> = {};
    for (const [k, r] of clubs) clubDerived[k] = { resolved: r !== null, exact: r?.exact ?? false, entityId: r?.id ?? null, popularity: r?.popularity ?? null };
    lines.push(
      `clubs resolved: ${[...clubs.values()].filter((r) => r !== null).length}/${c.clubs.length}`,
      `bars listed ${gate.listed}/${rows.length}, resolved ${gate.resolved}/${rows.length}, in club-signal top ${c.take}: ${gate.inTop}/${rows.length}`,
      `derby pairs (own bar above rival bar): ${derby.correct}/${derby.total}`,
    );
    return outcome(gate.status, `resolved ${gate.resolved}/${rows.length}, top-${c.take} ${gate.inTop}/${rows.length}`, lines, {
      clubs: clubDerived,
      barTagIds: tags.ids,
      missingBarTagKeys: tags.missing,
      listStatus,
      listSizes: Object.fromEntries([...lists].map(([k, v]) => [k, v.length])),
      rows: rowDerived,
      listed: gate.listed,
      resolved: gate.resolved,
      inTop: gate.inTop,
      derbyCorrect: derby.correct,
      derbyTotal: derby.total,
    });
  },
};
