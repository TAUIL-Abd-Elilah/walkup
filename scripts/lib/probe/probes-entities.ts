/** Probes 4-8: entity resolution, the thin-signal check (KG3), demographics/tags, venue places. */

import { anyEntities, demographicBlocks, heatCells, tagList } from "./extract.js";
import { normalizeName } from "./names.js";
import { demographicsRequest, entitiesByIds, heatmapRequest, tagProfileRequest } from "./requests.js";
import {
  type Resolved,
  below,
  exactCandidates,
  findTag,
  fmt,
  isDeniedTag,
  outcome,
  planned,
  pointOrAnchor,
  resolveAct,
  resolvePlace,
  venuePoint,
} from "./shared.js";
import type { Derived, ProbeDef } from "./types.js";
import { liftMetrics } from "./verdicts.js";

export const probe4: ProbeDef = {
  id: 4,
  slug: "club-brands-resolve",
  title: "Club brands resolve",
  criterion: "Typed brand search (types=urn:entity:brand) returns an exact match that carries a sports_organization tag, for each club.",
  ifFails: "Drop that club's list from the fan-bar test.",
  maxCalls: 1,
  async run(ctx) {
    const clubs = ctx.cfg.kg4.clubs;
    const refs = new Map<string, Resolved | null>();
    for (const club of clubs) refs.set(club.key, await resolveAct(ctx, { name: club.name, kind: "brand", aliases: club.aliases }));
    const ids = [...refs.values()].filter((r): r is Resolved => r !== null).map((r) => r.id);
    const res = ids.length > 0 ? await ctx.call(entitiesByIds(ids, "club brand entities (for tags)")) : null;
    if (ctx.dryRun) return planned();
    const ents = res && res.status === 200 ? anyEntities(res.json) : [];
    const lines: string[] = [];
    const per: Record<string, Derived> = {};
    let ok = 0;
    for (const club of clubs) {
      const r = refs.get(club.key) ?? null;
      const full = r ? ents.find((e) => e.id === r.id) : undefined;
      const tagIds = [...(r?.tagIds ?? []), ...(full?.tagIds ?? [])];
      const sportsOrg = tagIds.some((t) => t.includes("sports_organization"));
      const pass = r !== null && r.exact && sportsOrg;
      if (pass) ok++;
      per[club.key] = { resolved: r !== null, exact: r?.exact ?? false, entityId: r?.id ?? null, popularity: r?.popularity ?? null, sportsOrganizationTag: sportsOrg, pass };
      lines.push(`${club.key}: ${r ? (r.exact ? "exact" : "not exact") : "not found"}, sports_organization tag ${sportsOrg ? "yes" : "no"}`);
    }
    const status = ok === clubs.length ? "pass" : ok > 0 ? "partial" : "fail";
    return outcome(status, `${ok}/${clubs.length} clubs exact + tagged`, lines, { clubs: per, entitiesStatus: res?.status ?? null });
  },
};

export const probe5: ProbeDef = {
  id: 5,
  slug: "comedy-bill-resolution",
  title: "Comedy bill resolves (person entities)",
  criterion: "The headliner resolves exactly as a person; record the one-word name's ambiguity and the thin act.",
  ifFails: "Use proxy seeds (film/TV titles) for the comedy bill.",
  maxCalls: 3,
  async run(ctx) {
    const p = ctx.cfg.people;
    const head = await resolveAct(ctx, p.headliner);
    const amb = await exactCandidates(ctx, p.ambiguous);
    const thin = await resolveAct(ctx, p.thin);
    if (ctx.dryRun) return planned();
    const comedian = (head?.tagIds ?? []).some((t) => /comedian/.test(t));
    const derived: Derived = {
      headliner: { act: p.headliner.name, resolved: head !== null, exact: head?.exact ?? false, popularity: head?.popularity ?? null, comedianTagInSearch: comedian, entityId: head?.id ?? null },
      ambiguous: { act: p.ambiguous.name, candidates: amb?.total ?? 0, exactNameCandidates: amb?.exact ?? 0, needsInput: (amb?.exact ?? 0) !== 1 },
      thin: { act: p.thin.name, resolved: thin !== null, exact: thin?.exact ?? false, popularity: thin?.popularity ?? null },
    };
    const lines = [
      `${p.headliner.name}: ${head ? (head.exact ? "exact" : "not exact") : "not found"}, popularity ${fmt(head?.popularity ?? null)}, comedian tag in search payload ${comedian ? "yes" : "no/absent"}`,
      `${p.ambiguous.name}: ${amb?.total ?? 0} candidates, ${amb?.exact ?? 0} with the exact name`,
      `${p.thin.name}: ${thin ? (thin.exact ? "exact" : "not exact") : "not found"}, popularity ${fmt(thin?.popularity ?? null)}`,
    ];
    return outcome(head?.exact ? "pass" : "fail", head?.exact ? "headliner exact" : "headliner not exact", lines, derived);
  },
};

export const probe6: ProbeDef = {
  id: 6,
  slug: "kg3-thin-signal-heatmap",
  title: "KG3: comedy headliner heatmap density",
  gate: "KG3",
  criterion: "Headliner heatmap within 40 km of the room has >= 200 cells and Spearman(lift vs generic baseline, raw heat) < 0.8; proxies (film, TV) recorded.",
  ifFails: "The comedy scenario becomes a thin-signal showcase (proxy seeds, thin badges).",
  maxCalls: 6,
  async run(ctx) {
    const c = ctx.cfg.p6;
    const point = venuePoint(ctx, c.venue);
    if (!point) return outcome("skipped", "no venue point", [`${c.venue} has no coordinates`]);
    const p = ctx.cfg.people;
    const head = await resolveAct(ctx, p.headliner);
    const proxies: { name: string; ref: Resolved | null }[] = [];
    for (const px of p.proxies) proxies.push({ name: px.name, ref: await resolveAct(ctx, px) });
    const base = await findTag(ctx, c.baselineTagKey);
    const heat = (label: string, o: { signalEntities?: string[]; signalTags?: string[] }) =>
      ctx.call(heatmapRequest({ point, radiusM: c.radiusM, ...o, label: `heatmap ${label} near ${c.venue}` }));
    const hHead = head ? await heat(p.headliner.name, { signalEntities: [head.id] }) : null;
    const hProx = [];
    for (const px of proxies) if (px.ref) hProx.push({ name: px.name, res: await heat(px.name, { signalEntities: [px.ref.id] }) });
    const hBase = base ? await heat("generic baseline", { signalTags: [base.id] }) : null;
    if (ctx.dryRun) return planned();
    if (!head || !hHead) return outcome("fail", "headliner not resolved", [`${p.headliner.name} did not resolve`], { headlinerResolved: false });
    if (hHead.status !== 200) {
      // A transport or server error is no evidence about signal density: no gate decision.
      return outcome("inconclusive", `headliner heatmap returned HTTP ${hHead.status ?? "no response"}`, ["no decision on an HTTP error; re-run this probe"], {
        headliner: { status: hHead.status },
      });
    }

    const baseCells = hBase ? heatCells(hBase.json) : [];
    const opts = { shrinkBelow: ctx.cfg.kg2.shrinkBelowPopularity, topFraction: ctx.cfg.kg2.topFraction };
    const headCells = heatCells(hHead.json);
    const lm = liftMetrics(headCells, baseCells, opts);
    const proxyDerived: Record<string, Derived> = {};
    const lines = [`${p.headliner.name}: ${headCells.length} cells, Spearman(lift, heat) ${fmt(lm.spearmanLiftVsHeat)} over ${lm.joined} tiles`];
    for (const hp of hProx) {
      const cells = heatCells(hp.res.json);
      const m = liftMetrics(cells, baseCells, opts);
      proxyDerived[hp.name] = { status: hp.res.status, cells: cells.length, spearmanLiftVsHeat: m.spearmanLiftVsHeat, joined: m.joined };
      lines.push(`${hp.name}: ${cells.length} cells, Spearman(lift, heat) ${fmt(m.spearmanLiftVsHeat)}`);
    }
    for (const px of proxies) if (!px.ref) lines.push(`${px.name}: not resolved`);
    const pass = headCells.length >= c.minCells && below(lm.spearmanLiftVsHeat, c.maxSpearman);
    const status = pass ? "pass" : headCells.length >= c.minCells && !Number.isFinite(lm.spearmanLiftVsHeat) ? "inconclusive" : "fail";
    return outcome(status, `${headCells.length} cells, rho ${fmt(lm.spearmanLiftVsHeat)}`, lines, {
      headliner: { status: hHead.status, cells: headCells.length, tiles: lm.tiles, joined: lm.joined, spearmanLiftVsHeat: lm.spearmanLiftVsHeat },
      proxies: proxyDerived,
      baselineCells: baseCells.length,
      baselineTagId: base?.id ?? null,
    });
  },
};

export const probe7: ProbeDef = {
  id: 7,
  slug: "headliner-demographics-and-tags",
  title: "Headliner demographics and tag profile",
  criterion: "urn:demographics returns a block and urn:tag returns a profile; record whether denied tag families and the known film/kids markers appear (denylist regression case).",
  ifFails: "Use proxy seeds' blocks; mark demographics partial.",
  maxCalls: 2,
  async run(ctx) {
    const p = ctx.cfg.people;
    const head = await resolveAct(ctx, p.headliner);
    if (!head) {
      if (ctx.dryRun) return planned();
      return outcome("fail", "headliner not resolved", [`${p.headliner.name} did not resolve`]);
    }
    const demo = await ctx.call(demographicsRequest([head.id], `demographics of ${p.headliner.name}`));
    const prof = await ctx.call(tagProfileRequest([head.id], 50, `tag profile of ${p.headliner.name}`));
    if (ctx.dryRun) return planned();
    const blocks = demographicBlocks(demo.json);
    const tags = tagList(prof.json);
    const denied = tags.filter((t) => isDeniedTag(t.id, t.name));
    const families: Record<string, number> = {};
    for (const t of denied) {
      const fam = t.id.split(":").slice(0, 3).join(":");
      families[fam] = (families[fam] ?? 0) + 1;
    }
    const markers: Record<string, number> = {};
    for (const pat of ctx.cfg.p7.markerNamePatterns) {
      markers[pat] = tags.filter((t) => normalizeName(t.name).includes(normalizeName(pat))).length;
    }
    const ethnicity = tags.filter((t) => t.id.startsWith("urn:tag:ethnicity:")).length;
    const pass = blocks.length > 0 && blocks[0]!.ageKeys.length > 0 && tags.length > 0;
    const lines = [
      `demographics: ${blocks.length} block(s), age buckets ${blocks[0]?.ageKeys.length ?? 0}, gender keys ${blocks[0]?.genderKeys.length ?? 0}`,
      `tag profile: ${tags.length} tags, ${denied.length} denied by policy (ethnicity ${ethnicity})`,
      `markers: ${Object.entries(markers)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    ];
    return outcome(pass ? "pass" : "fail", `${blocks.length} block(s), ${tags.length} tags, ${denied.length} denied`, lines, {
      demographicsStatus: demo.status,
      tagStatus: prof.status,
      blocks: blocks.length,
      ageBuckets: blocks[0]?.ageKeys.length ?? 0,
      genderKeys: blocks[0]?.genderKeys.length ?? 0,
      tags: tags.length,
      deniedTags: denied.length,
      deniedByNamespace: families,
      ethnicityTagsPresent: ethnicity,
      markerHits: markers,
      denylistRegressionCaseFound: denied.length > 0,
    });
  },
};

export const probe8: ProbeDef = {
  id: 8,
  slug: "venues-as-places",
  title: "Venues resolve as Qloo places",
  criterion: "Record whether each room resolves by name as a place near its point (name similarity >= 0.85).",
  ifFails: "Use POINT(lon lat) from Ticketmaster and label the venue as not in the catalog yet.",
  maxCalls: 3,
  async run(ctx) {
    const c = ctx.cfg.p8;
    const lines: string[] = [];
    const per: Record<string, Derived> = {};
    for (const key of c.venues) {
      const v = ctx.cfg.venues[key];
      const p = pointOrAnchor(ctx, key);
      if (!v || !p) {
        per[key] = { skipped: "no point or anchor" };
        lines.push(`${key}: skipped (no point or anchor)`);
        continue;
      }
      const radiusMiles = p.anchored ? (v.searchAnchor?.radiusMiles ?? 10) : c.radiusMiles;
      const m = await resolvePlace(ctx, v.name, { ...p.point, radiusMiles }, { minSimilarity: c.minNameSimilarity, truePoint: p.anchored ? null : p.point });
      if (ctx.dryRun) continue;
      per[key] = {
        anchoredSearch: p.anchored,
        found: m.resolved !== null,
        entityId: m.resolved?.id ?? null,
        nameSimilarity: m.similarity,
        distanceM: m.distanceM,
        popularity: m.resolved?.popularity ?? null,
      };
      lines.push(
        `${key}: ${m.resolved ? `found (similarity ${fmt(m.similarity)}, ${m.distanceM === null ? "distance n/a" : `${Math.round(m.distanceM)} m`})` : "not found"}${p.anchored ? " [city anchor search]" : ""}`,
      );
    }
    if (ctx.dryRun) return planned(lines);
    const found = Object.values(per).filter((d) => d.found === true).length;
    return outcome("info", `${found}/${c.venues.length} rooms found as places`, lines, { venues: per });
  },
};
