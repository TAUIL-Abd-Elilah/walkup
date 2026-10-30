/**
 * Step 2, resolve (Q1-Q3): acts, venue and the house set, then one signal
 * check. Ambiguity pauses the run with needs_input; nothing ambiguous is ever
 * resolved silently. A one-word act name with several exact matches always
 * asks (an artist entry and a person entry for the same musician count once).
 *
 * Signal check (Q1): Qloo can list an entity under /search and still have no
 * taste data for it (Oct 15 2026: the "Jason Isbell" artist entry; "Jason
 * Isbell and The 400 Unit" works). Heatmaps, tag profiles and compare drop
 * such an id without a word, so every seed (acts, stand-ins, house ids) plus
 * up to two fallback entries per act goes through one place-insights check at
 * the venue before anything is planned. A dropped act moves to the next usable
 * entry from the same search, asks when several fit, and is left out when none
 * does. An operator pick is remembered only after Qloo accepts it.
 *
 * Stand-ins (film or TV titles) are used only for thin acts. An act Qloo knows
 * well stays its own seed (Oct 15, probes 6 and 7).
 */
import type { Act, ActRole, Candidate, Envelope, QlooEntity, Resolution } from "@walkup/contracts";
import { decideFallback, errorStatus, normalizeName, resolveFromEntities, sameAct, signalAlternates, toCandidate, type SignalCheck } from "@walkup/qloo";
import { joinAnd } from "@walkup/engine";
import { rosterHeadliners, type RosterHeadliner } from "@walkup/tm";
import { baselineTagFor } from "../tags";
import { clean, cite, envelope, node, plural, venuePoint, type HouseSet, type RunContext, type Seed } from "../context";
import type { ChoiceStore } from "../store";

export const ROLE_WEIGHT: Record<ActRole, number> = { headliner: 1, co: 0.6, support: 0.3 };
/** Popularity below this (or null) marks an act as thin. */
export const THIN_POPULARITY = 0.35;
export const HOUSE_SET_SIZE = 12;
export const HOUSE_MIN_RESOLVED = 5;
export const HOUSE_MAX_SEARCHES = 6;
/** Fallback entries per act sent with the signal check (the next ones in line if the pick is dropped). */
export const MAX_SIGNAL_ALTERNATES = 2;
/** Node label of the signal check. */
export const SIGNAL_CHECK_NODE = "Q1 signal check";
const ACT_TYPES = ["artist", "person"];

export interface ResolveResult {
  seeds: Seed[];
  card: Envelope<Resolution[]>;
  pending: { input: string; candidates: Candidate[] }[];
  venueEntityId: string | null;
  house: HouseSet;
  missingActs: string[];
  thinActs: string[];
  /** Acts whose first Qloo entry had no taste data and were swapped for another entry. */
  swappedActs: string[];
  /** Acts left out because Qloo lists them but has no taste data for any entry. */
  noDataActs: string[];
  /** The signal check, or null when there was nothing to check or the call failed. */
  signalCheck: SignalCheck | null;
}

function oneWord(name: string): boolean {
  return normalizeName(name).split(" ").length === 1;
}

function isThin(e: QlooEntity): boolean {
  return e.popularity === null || e.popularity < THIN_POPULARITY;
}

async function choiceFor(ctx: RunContext, choices: ChoiceStore | undefined, name: string): Promise<{ id: string; fromRequest: boolean } | null> {
  const fromRequest = ctx.request.resolutions?.[name];
  if (fromRequest) return { id: fromRequest, fromRequest: true };
  const cached = choices ? await choices.get(name, ACT_TYPES, ctx.now()) : null;
  return cached ? { id: cached, fromRequest: false } : null;
}

interface ActOutcome {
  act: Act;
  entity?: QlooEntity;
  pending?: Candidate[];
  ledgerRef?: string;
  picked?: boolean;
  /** The operator's pick (from this request or the cache): remembered only after the signal check. */
  choice?: { fromRequest: boolean; shown: boolean };
  reason?: string;
  /** How the entity was found. */
  via?: "spotify" | "search" | "pick";
  /** Typed /search results for this act (fallback entries come from here). */
  results: QlooEntity[];
  /** Fallback entries, in tiers, tried in order when Qloo has no taste data for the pick. */
  alternates: QlooEntity[][];
  /** Set when the first pick was swapped for another entry. */
  replaced?: NonNullable<Resolution["replaced"]>;
  /** Plain reason for a needs_input or unresolved row decided by the signal check. */
  rowReason?: string;
  /** A swap that is not clear-cut (another billing name, entries never checked): said on the row and the card. */
  swapNote?: string;
  /** Left out: Qloo lists the name but has no taste data for any entry. */
  noData?: boolean;
}

/** Exact matches other than the pick that are a different act (an artist and person entry for one musician count once). */
function otherExactActs(name: string, pick: QlooEntity, results: readonly QlooEntity[]): QlooEntity[] {
  const target = normalizeName(name);
  const seen = new Set<string>([pick.entityId]);
  const out: QlooEntity[] = [];
  for (const e of results) {
    if (seen.has(e.entityId) || normalizeName(e.name) !== target) continue;
    seen.add(e.entityId);
    if (!sameAct(pick, e)) out.push(e);
  }
  return out;
}

function alternatesFor(name: string, pick: QlooEntity, results: readonly QlooEntity[], requireComedianTag: boolean): QlooEntity[][] {
  if (results.length === 0) return [];
  return signalAlternates(name, results, { requireComedianTag, exclude: new Set([pick.entityId]), subtype: pick.subtype });
}

async function typedSearch(ctx: RunContext, o: ActOutcome): Promise<boolean> {
  node(ctx, `Q1 act search: ${o.act.role}`, "bill");
  try {
    const r = await ctx.qloo.search(o.act.name, ACT_TYPES, { take: 5 });
    o.results = r.value;
    o.ledgerRef = r.ledgerRef;
    return true;
  } catch (err) {
    o.ledgerRef = (err as { ledgerRef?: string }).ledgerRef;
    o.reason = `the search call failed (${errorStatus(err).reason})`;
    return false;
  }
}

/** Decides an act from its typed search results (exact match only; one-word names with several acts ask). */
function decideFromResults(o: ActOutcome): void {
  const name = o.act.name;
  const requireComedianTag = !!o.act.isComedian;
  const results = o.results;
  const res = resolveFromEntities(name, results, { role: o.act.role, requireComedianTag, ...(o.ledgerRef ? { ledgerRef: o.ledgerRef } : {}) });
  if (res.status === "exact" && res.entity && oneWord(name) && otherExactActs(name, res.entity, results).length > 0) {
    // One-word names with several exact matches are confirmed by the operator.
    const admissible = res.entity;
    const others = otherExactActs(name, admissible, results);
    const rest = results.filter((e) => e.entityId !== admissible.entityId && !others.includes(e) && normalizeName(e.name) !== normalizeName(name));
    o.pending = [admissible, ...others, ...rest].slice(0, 5).map(toCandidate);
    return;
  }
  if (res.status === "exact" && res.entity) {
    o.entity = res.entity;
    o.via = "search";
    o.alternates = alternatesFor(name, res.entity, results, requireComedianTag);
  } else if (res.status === "needs_input" && (res.candidates?.length ?? 0) > 1) o.pending = res.candidates;
  else if (results.length === 0) o.reason = "no match in Qloo's catalog";
  else o.reason = o.act.isComedian ? "no exact match tagged as a comedian" : "no exact match";
}

async function resolveActs(ctx: RunContext, choices: ChoiceStore | undefined): Promise<ActOutcome[]> {
  const acts = ctx.bill.acts;
  const out: ActOutcome[] = acts.map((act) => ({ act, results: [], alternates: [] }));
  // Q1a: one /entities call for every Spotify id Ticketmaster listed.
  const withSpotify = out.filter((o) => o.act.spotifyId);
  if (withSpotify.length > 0) {
    node(ctx, "Q1 acts by Spotify id", "bill");
    try {
      const r = await ctx.qloo.entitiesByExternal(
        "spotify",
        withSpotify.map((o) => o.act.spotifyId as string),
      );
      for (const o of withSpotify) {
        const m = r.value.matches.find((x) => x.externalId === o.act.spotifyId);
        const e = m ? r.value.entities.find((x) => x.entityId === m.entityId) : undefined;
        if (!e) continue;
        if (o.act.isComedian && !e.tags.some((t) => ctx.pins.comedianTags.includes(t.id) || /comedian/.test(t.id))) continue;
        o.entity = e;
        o.via = "spotify";
        o.ledgerRef = r.ledgerRef;
      }
    } catch {
      // Fall through to typed search for every act.
    }
  }
  // Q1b: typed /search, exact normalized name only.
  for (const o of out) {
    if (o.entity) continue;
    const name = o.act.name;
    const choice = await choiceFor(ctx, choices, name);
    if (!(await typedSearch(ctx, o))) continue;
    if (choice) {
      let picked = o.results.find((e) => e.entityId === choice.id);
      const shown = !!picked;
      if (!picked) {
        node(ctx, "Q1 operator pick", "bill");
        try {
          const r = await ctx.qloo.entitiesByIds([choice.id]);
          picked = r.value[0];
          if (picked) o.ledgerRef = r.ledgerRef;
        } catch {
          picked = undefined;
        }
      }
      if (picked) {
        o.entity = picked;
        o.picked = true;
        o.via = "pick";
        // Only a pick among the candidates this search shows is remembered, and only once Qloo accepts it.
        o.choice = { fromRequest: choice.fromRequest, shown };
        continue;
      }
    }
    decideFromResults(o);
  }
  return out;
}

async function resolveProxy(ctx: RunContext, query: string, type: "movie" | "tv_show", year: number | undefined): Promise<{ entity: QlooEntity; ledgerRef: string } | null> {
  node(ctx, `Q1 proxy seed: ${type}`, "bill");
  try {
    const r = await ctx.qloo.search(query, [type], { take: 5 });
    const exact = r.value.filter((e) => normalizeName(e.name) === normalizeName(query) && e.subtype === `urn:entity:${type}`);
    const ok = year === undefined ? exact : exact.filter((e) => e.properties.release_year === year);
    const best = [...ok].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
    return best ? { entity: best, ledgerRef: r.ledgerRef } : null;
  } catch {
    return null;
  }
}

async function resolveVenue(ctx: RunContext): Promise<{ row: Resolution; entityId: string | null; ref: string | null }> {
  node(ctx, "Q2 venue", "venue");
  const v = ctx.bill.venue;
  try {
    const res = await ctx.qloo.resolveExact(v.name, ["place"], { nearPoint: { lat: v.lat, lon: v.lon }, radiusMiles: 1, role: "venue" });
    if (res.status === "exact" && res.entity) {
      cite(ctx, [res.entity], res.ledgerRef ?? "");
      return { row: { ...res, entity: clean(ctx, res.entity) }, entityId: res.entity.entityId, ref: res.ledgerRef ?? null };
    }
    const row: Resolution = { input: v.name, role: "venue", status: "unresolved" };
    if (res.ledgerRef) row.ledgerRef = res.ledgerRef;
    return { row, entityId: null, ref: res.ledgerRef ?? null };
  } catch (err) {
    const ref = (err as { ledgerRef?: string }).ledgerRef ?? null;
    const row: Resolution = { input: v.name, role: "venue", status: "unresolved" };
    if (ref) row.ledgerRef = ref;
    return { row, entityId: null, ref };
  }
}

function tagBaseline(ctx: RunContext, partial: Omit<HouseSet, "baseline" | "tag" | "ids" | "weights">): HouseSet {
  const tag = baselineTagFor(ctx.pins, ctx.bill.classification);
  return { ...partial, ids: [], weights: [], baseline: tag ? "tag" : "none", tag };
}

async function resolveHouse(ctx: RunContext): Promise<HouseSet> {
  const base = { rosterHeadliners: 0, resolved: 0, ledgerRefs: [] as string[], roster: [] as HouseSet["roster"] };
  const venueId = ctx.bill.venue.tmVenueId;
  if (!ctx.tm || !venueId) return tagBaseline(ctx, base);
  node(ctx, "Q3 house roster (Ticketmaster)", "venue");
  let heads: RosterHeadliner[] = [];
  try {
    const roster = await ctx.tm.eventsByVenue(venueId, { startDateTime: ctx.asOf, size: 60 });
    base.ledgerRefs.push(roster.ledgerRef);
    base.roster = roster.data;
    // The candidate list is per venue (no bill-specific exclusions) so the Q3
    // calls are the same for every bill at the room and come from cache; the
    // bill's own acts are removed afterwards so the bill never leaks into its baseline.
    heads = rosterHeadliners(roster.data, { top: 20, referenceDate: ctx.asOf });
  } catch {
    return tagBaseline(ctx, base);
  }
  const billAttractions = new Set(ctx.bill.acts.map((a) => a.tmAttractionId).filter((x): x is string => !!x));
  const billNames = new Set(ctx.bill.acts.map((a) => normalizeName(a.name)));
  const isBillAct = (h: RosterHeadliner) => (h.act.tmAttractionId ? billAttractions.has(h.act.tmAttractionId) : false) || billNames.has(normalizeName(h.act.name));
  base.rosterHeadliners = heads.filter((h) => !isBillAct(h)).length;
  const resolved = new Map<string, { entity: QlooEntity; ref: string }>();
  const spotify = heads.filter((h) => h.act.spotifyId);
  if (spotify.length > 0) {
    node(ctx, "Q3 house set by Spotify id", "venue");
    try {
      const r = await ctx.qloo.entitiesByExternal("spotify", spotify.map((h) => h.act.spotifyId as string));
      base.ledgerRefs.push(...r.ledgerRefs);
      for (const h of spotify) {
        const m = r.value.matches.find((x) => x.externalId === h.act.spotifyId);
        const e = m ? r.value.entities.find((x) => x.entityId === m.entityId) : undefined;
        if (e) resolved.set(h.key, { entity: e, ref: r.ledgerRef });
      }
    } catch {
      // Typed search below covers what it can.
    }
  }
  // Typed search for unresolved headliners in rank order, until the top 12
  // (in roster order) are settled or the search cap is reached.
  let searches = 0;
  let inOrder = 0;
  for (const h of heads) {
    if (inOrder >= HOUSE_SET_SIZE || searches >= HOUSE_MAX_SEARCHES) break;
    if (isBillAct(h)) continue;
    if (resolved.has(h.key)) {
      inOrder++;
      continue;
    }
    searches++;
    node(ctx, "Q3 house set search", "venue");
    try {
      const r = await ctx.qloo.search(h.act.name, ACT_TYPES, { take: 5 });
      base.ledgerRefs.push(r.ledgerRef);
      const res = resolveFromEntities(h.act.name, r.value, { role: "house", requireComedianTag: !!h.act.isComedian });
      if (res.status === "exact" && res.entity) {
        resolved.set(h.key, { entity: res.entity, ref: r.ledgerRef });
        inOrder++;
      }
    } catch (err) {
      const ref = (err as { ledgerRef?: string }).ledgerRef;
      if (ref) base.ledgerRefs.push(ref);
    }
  }
  const ordered = heads.filter((h) => !isBillAct(h) && resolved.has(h.key)).slice(0, HOUSE_SET_SIZE);
  base.resolved = ordered.length;
  if (ordered.length < HOUSE_MIN_RESOLVED) return tagBaseline(ctx, base);
  const total = ordered.reduce((s, h) => s + h.weight, 0) || 1;
  for (const h of ordered) {
    const x = resolved.get(h.key);
    if (x) cite(ctx, [x.entity], x.ref);
  }
  return {
    ...base,
    ids: ordered.map((h) => (resolved.get(h.key) as { entity: QlooEntity }).entity.entityId),
    weights: ordered.map((h) => h.weight / total),
    baseline: "house",
    tag: null,
  };
}

/** The house set without the ids Qloo has no taste data for; below HOUSE_MIN_RESOLVED the tag baseline stands in. */
function withoutDropped(ctx: RunContext, house: HouseSet, dropped: ReadonlySet<string>): HouseSet {
  if (house.baseline !== "house" || !house.ids.some((id) => dropped.has(id))) return house;
  const keep = house.ids.map((id, i) => ({ id, w: house.weights[i] ?? 0 })).filter((x) => !dropped.has(x.id));
  const { ids: _ids, weights: _weights, baseline: _baseline, tag: _tag, ...rest } = house;
  const partial = { ...rest, resolved: keep.length };
  if (keep.length < HOUSE_MIN_RESOLVED) return tagBaseline(ctx, partial);
  const total = keep.reduce((s, x) => s + x.w, 0) || 1;
  return { ...partial, ids: keep.map((x) => x.id), weights: keep.map((x) => x.w / total), baseline: "house", tag: null };
}

/**
 * Applies the signal check to one act. A usable pick stays. A dropped pick moves to the first tier of
 * fallback entries with a usable entry (decideFallback): one entry is used (and the swap recorded, citing the
 * batch call that dropped the pick; a swap to another billing name, or one made while entries of the deciding
 * tier went unchecked, is said on the sheet), several ask, none leaves the act out. A dropped operator pick is
 * forgotten and the operator is asked again.
 */
async function applyCheck(
  ctx: RunContext,
  o: ActOutcome,
  dropped: ReadonlySet<string>,
  checked: ReadonlySet<string>,
  choices: ChoiceStore | undefined,
  refById: Readonly<Record<string, string>>,
  checkRef: string | undefined,
): Promise<void> {
  const name = o.act.name;
  if (o.pending) {
    const kept = o.pending.filter((c) => !dropped.has(c.entityId));
    const n = o.pending.length - kept.length;
    if (n === 0) return;
    if (kept.length === 0) {
      delete o.pending;
      o.noData = true;
      o.rowReason = `${name}: Qloo lists this name but has no taste data for it, so the run continued on the other acts.`;
      return;
    }
    o.pending = kept;
    o.rowReason = `Left out ${plural(n, "match", "matches")} Qloo has no taste data for.`;
    return;
  }
  const pick = o.entity;
  if (!pick || !dropped.has(pick.entityId)) {
    if (pick && o.choice?.fromRequest && o.choice.shown && choices) await choices.set(name, ACT_TYPES, pick.entityId, ctx.now());
    return;
  }
  const dropRef = refById[pick.entityId] ?? checkRef;
  const replaced: NonNullable<Resolution["replaced"]> = { entityId: pick.entityId, name: pick.name, reason: "not_found", ...(dropRef ? { ledgerRef: dropRef } : {}) };
  delete o.entity;
  if (o.via === "pick") {
    // The operator's pick has no taste data: forget it and ask again without it.
    if (choices?.delete) await choices.delete(name, ACT_TYPES);
    delete o.picked;
    delete o.choice;
    const unusable = new Set(dropped);
    const candidates = o.results.filter((e) => !unusable.has(e.entityId)).slice(0, 5).map(toCandidate);
    if (candidates.length > 0) {
      o.pending = candidates;
      o.rowReason = `Qloo has no taste data for the entry picked for "${name}". Pick the entry that matches this act.`;
    } else {
      o.noData = true;
      o.rowReason = `${name}: Qloo lists this name but has no taste data for it, so the run continued on the other acts.`;
    }
    o.replaced = replaced;
    return;
  }
  if (o.via === "spotify") {
    // No fallback list on the Spotify path: search the name and check the result once.
    if (await typedSearch(ctx, o)) {
      const res = await ctx.qloo.resolveUsable(name, o.results.filter((e) => !dropped.has(e.entityId)), {
        checkSignalAt: venuePoint(ctx),
        role: o.act.role,
        requireComedianTag: !!o.act.isComedian,
        ...(o.ledgerRef ? { ledgerRef: o.ledgerRef } : {}),
      });
      o.replaced = replaced;
      if (res.status === "exact" && res.entity) {
        o.entity = res.entity;
        o.via = "search";
        // resolveUsable says when its own swap was not clear-cut; a search hit under another name is said too.
        const notes: string[] = [];
        if (res.replaced && res.reason) notes.push(res.reason);
        else if (normalizeName(res.entity.name) !== normalizeName(name)) notes.push(`"${res.entity.name}" is billed under a different name, so check it's the same act.`);
        if (notes.length > 0) o.swapNote = notes.join(" ");
        return;
      }
      if (res.status === "needs_input" && (res.candidates?.length ?? 0) > 0) {
        o.pending = res.candidates;
        o.rowReason = `Qloo's first match for "${name}" has no taste data. Pick the entry that matches this act.`;
        return;
      }
    }
    o.replaced = replaced;
    o.noData = true;
    o.rowReason = `${name}: Qloo lists this name but has no taste data for it, so the run continued on the other acts.`;
    return;
  }
  o.replaced = replaced;
  const decision = decideFallback(name, o.alternates, checked, dropped);
  if (decision.kind === "use" && decision.entity) {
    o.entity = decision.entity;
    if (decision.note) o.swapNote = decision.note;
    return;
  }
  if (decision.kind === "ask" && decision.candidates) {
    o.pending = decision.candidates.map(toCandidate);
    o.rowReason = `Qloo's first match for "${name}" has no taste data. Pick the entry that matches this act.`;
    return;
  }
  o.noData = true;
  o.rowReason = `${name}: Qloo lists this name but has no taste data for it, so the run continued on the other acts.`;
}

export async function resolveAll(ctx: RunContext, choices: ChoiceStore | undefined): Promise<ResolveResult> {
  const outcomes = await resolveActs(ctx, choices);

  // Stand-ins only for thin acts (decided on the pick; a swapped-in entry is judged again below).
  const proxiesByAct = new Map<string, { entity: QlooEntity; ledgerRef: string }[]>();
  for (const o of outcomes) {
    if (!o.entity || !isThin(o.entity)) continue;
    const plan = ctx.seeds.find((s) => s.act === o.act.name);
    const hits: { entity: QlooEntity; ledgerRef: string }[] = [];
    for (const p of plan?.proxies ?? []) {
      const hit = await resolveProxy(ctx, p.query, p.type, p.releaseYear);
      if (hit) hits.push(hit);
    }
    if (hits.length > 0) proxiesByAct.set(o.act.name, hits);
  }

  const venue = await resolveVenue(ctx);
  let house = await resolveHouse(ctx);

  // Q1 signal check: every seed, the fallback entries and the house ids, in one call at the venue.
  const ids: string[] = [];
  for (const o of outcomes) {
    if (o.entity) {
      ids.push(o.entity.entityId);
      ids.push(...o.alternates.flat().slice(0, MAX_SIGNAL_ALTERNATES).map((e) => e.entityId));
    } else if (o.pending) ids.push(...o.pending.map((c) => c.entityId));
  }
  for (const hits of proxiesByAct.values()) ids.push(...hits.map((h) => h.entity.entityId));
  if (house.baseline === "house") ids.push(...house.ids);
  let check: SignalCheck | null = null;
  const checkProvenance: string[] = [];
  if (ids.length > 0) {
    node(ctx, SIGNAL_CHECK_NODE, "bill");
    try {
      check = await ctx.qloo.checkSignals(ids, venuePoint(ctx));
      checkProvenance.push(...check.ledgerRefs);
    } catch (err) {
      const ref = (err as { ledgerRef?: string }).ledgerRef;
      if (ref) checkProvenance.push(ref);
      ctx.limits.push(`Qloo's check of which acts it has taste data for failed (${errorStatus(err).reason}), so the acts were used unchecked.`);
    }
  }
  const dropped = new Set(check?.dropped ?? []);
  const checked = new Set(check?.checked ?? []);
  const checkRef = check?.ledgerRefs[0];
  const refById = check?.ledgerRefById ?? {};
  for (const o of outcomes) await applyCheck(ctx, o, dropped, checked, choices, refById, checkRef);
  const droppedHouse = house.baseline === "house" ? house.ids.filter((id) => dropped.has(id)).length : 0;
  house = withoutDropped(ctx, house, dropped);

  const rows: Resolution[] = [];
  const seeds: Seed[] = [];
  const pending: ResolveResult["pending"] = [];
  const missing: string[] = [];
  const missingWhy: string[] = [];
  const thin: string[] = [];
  const swapped: string[] = [];
  const noData: string[] = [];
  const swapLines: string[] = [];
  const provenance: string[] = [];
  let pickedCount = 0;
  let proxied = 0;
  let proxiesDropped = 0;

  for (const o of outcomes) {
    const { act } = o;
    const w = ROLE_WEIGHT[act.role];
    if (o.ledgerRef) provenance.push(o.ledgerRef);
    if (o.replaced) provenance.push(...checkProvenance);
    if (o.pending) {
      const row: Resolution = { input: act.name, role: act.role, status: "needs_input", candidates: o.pending };
      if (o.ledgerRef) row.ledgerRef = o.ledgerRef;
      if (o.replaced) row.replaced = o.replaced;
      if (o.rowReason) row.reason = o.rowReason;
      rows.push(row);
      pending.push({ input: act.name, candidates: o.pending });
      continue;
    }
    if (!o.entity) {
      const row: Resolution = { input: act.name, role: act.role, status: "unresolved" };
      if (o.ledgerRef) row.ledgerRef = o.ledgerRef;
      if (o.replaced) row.replaced = o.replaced;
      if (o.rowReason) row.reason = o.rowReason;
      rows.push(row);
      missing.push(act.name);
      if (o.noData) {
        noData.push(act.name);
        missingWhy.push(`${act.name}: Qloo lists this name but has no taste data for it`);
      } else missingWhy.push(`${act.name}: ${o.reason ?? "no exact match"}`);
      continue;
    }
    if (o.picked) pickedCount++;
    const entity = o.entity;
    cite(ctx, [entity], o.ledgerRef ?? "");
    if (o.replaced) {
      swapped.push(act.name);
      swapLines.push(`${act.name}: Qloo's entry under this name has no taste data, so the run uses "${entity.name}".${o.swapNote ? ` ${o.swapNote}` : ""}`);
    }
    const actThin = isThin(entity);
    if (actThin) thin.push(act.name);
    const plan = ctx.seeds.find((s) => s.act === act.name);
    const hits = actThin ? (proxiesByAct.get(act.name) ?? []) : [];
    const proxies = hits.filter((h) => !dropped.has(h.entity.entityId));
    proxiesDropped += hits.length - proxies.length;
    const safe = clean(ctx, entity);
    if (plan && proxies.length > 0) {
      // Thin act: its stand-ins carry the signal.
      proxied++;
      const share = w / proxies.length;
      proxies.forEach((p, i) => {
        provenance.push(p.ledgerRef);
        cite(ctx, [p.entity], p.ledgerRef);
        const row: Resolution = {
          input: i === 0 ? act.name : p.entity.name,
          role: act.role,
          status: "proxy",
          proxy: { entity: clean(ctx, p.entity), reason: plan.reason },
          ledgerRef: p.ledgerRef,
        };
        if (i === 0) {
          row.entity = safe;
          if (o.replaced) row.replaced = o.replaced;
          if (o.swapNote) row.reason = o.swapNote;
        } else row.proxyFor = act.name;
        rows.push(row);
      });
      for (const p of proxies) seeds.push({ entity: p.entity, act: act.name, weight: share, kind: "proxy" });
      continue;
    }
    const row: Resolution = { input: act.name, role: act.role, status: "exact", entity: safe };
    if (o.ledgerRef) row.ledgerRef = o.ledgerRef;
    if (o.replaced) row.replaced = o.replaced;
    if (o.swapNote) row.reason = o.swapNote;
    rows.push(row);
    seeds.push({ entity, act: act.name, weight: w, kind: "act" });
  }
  if (proxiesDropped > 0) provenance.push(...checkProvenance);

  rows.push(venue.row);
  if (venue.ref) provenance.push(venue.ref);
  if (venue.entityId) ctx.bill = { ...ctx.bill, venue: { ...ctx.bill.venue, qlooEntityId: venue.entityId } };
  else ctx.bill = { ...ctx.bill, venue: { ...ctx.bill.venue, qlooEntityId: null } };

  const houseRow: Resolution = {
    input: house.roster.length > 0 ? `The room's next ${plural(house.roster.length, "show")} on Ticketmaster` : "The room's upcoming shows on Ticketmaster",
    role: "house",
    status: house.baseline === "house" ? "exact" : "unresolved",
  };
  if (house.ledgerRefs[0]) houseRow.ledgerRef = house.ledgerRefs[0];
  rows.push(houseRow);
  provenance.push(...house.ledgerRefs);
  if (droppedHouse > 0) provenance.push(...checkProvenance);

  const unclearSwaps = outcomes.filter((o) => o.entity && o.replaced && o.swapNote).map((o) => o.act.name);
  const acts = ctx.bill.acts.length;
  const resolvedActs = outcomes.filter((o) => o.entity).length;
  const comedy = /comedy/i.test(ctx.bill.classification ?? "");
  const parts: string[] = [];
  parts.push(`${resolvedActs} of ${acts} ${acts === 1 ? "act" : "acts"} resolved${pickedCount > 0 ? ` (${plural(pickedCount, "pick")} by the operator)` : ""}.`);
  parts.push(...swapLines);
  if (pending.length > 0) parts.push(`${plural(pending.length, "name")} waiting for your pick: ${pending.map((p) => p.input).join(", ")}.`);
  if (proxied > 0) parts.push(`${plural(proxied, "act")} Qloo has little on ${proxied === 1 ? "is" : "are"} matched through a film or TV title (see the receipts).`);
  parts.push(
    venue.entityId
      ? "Venue resolved as a Qloo place and left out of partner lists."
      : "Venue not in the catalog yet, so the run uses the Ticketmaster point.",
  );
  if (droppedHouse > 0) parts.push(`Left out ${plural(droppedHouse, "of the room's headliners", "of the room's headliners")} Qloo has no taste data for.`);
  parts.push(
    house.baseline === "house"
      ? `Usual crowd: built from ${plural(house.resolved, "headliner")}${house.roster.length > 0 ? ` on the room's next ${plural(house.roster.length, "show")}` : ""}.`
      : house.baseline === "tag"
        ? `Only ${plural(house.resolved, "of the room's headliners", "of the room's headliners")} matched Qloo (${HOUSE_MIN_RESOLVED} needed), so a genre stands in.`
        : comedy
          ? `Only ${plural(house.resolved, "of the room's headliners", "of the room's headliners")} matched Qloo (${HOUSE_MIN_RESOLVED} needed), and there is no comedy-wide crowd to stand in, so there is no usual crowd to compare with.`
          : "There is no usual crowd to compare with.",
  );

  let status: Envelope<Resolution[]>["status"] = "ok";
  let reason: string | undefined;
  if (pending.length > 0) {
    status = "needs_input";
    reason = pending.length === 1 ? "One name matches more than one entry. Pick the right one to go on." : "Some names match more than one entry. Pick the right ones to go on.";
    const narrowed = outcomes.filter((o) => o.pending && o.rowReason).map((o) => o.rowReason as string);
    if (narrowed.length > 0) reason = `${reason} ${narrowed.join(" ")}`;
  } else if (seeds.length === 0) {
    status = "error";
    reason = `No act resolved, so there is no signal to plan with${missingWhy.length > 0 ? ` (${missingWhy.join("; ")})` : ""}.`;
  } else if (missing.length > 0 || thin.length > 0 || proxiesDropped > 0 || unclearSwaps.length > 0) {
    status = "partial";
    const why: string[] = [];
    if (unclearSwaps.length > 0) why.push(`check the swapped ${unclearSwaps.length === 1 ? "act" : "acts"} (${unclearSwaps.join(", ")}): the entry used may not be the same act`);
    if (missing.length > 0) why.push(`${missingWhy.join("; ")}; the run continued on the matched acts`);
    if (thin.length > 0) why.push(`Qloo has little on ${joinAnd(thin)}${proxied > 0 ? `, so ${proxied === 1 ? "a stand-in is" : "stand-ins are"} used` : ""}`);
    if (proxiesDropped > 0) why.push(`Qloo has no taste data for ${plural(proxiesDropped, "stand-in title")}, so ${proxiesDropped === 1 ? "it was" : "they were"} left out`);
    reason = `${why.join("; ")}.`;
  }
  ctx.thinSignal = seeds.length > 0 && seeds.every((s) => isThin(s.entity));
  return {
    seeds,
    card: envelope(status, parts.join(" "), rows, provenance, reason),
    pending,
    venueEntityId: venue.entityId,
    house,
    missingActs: missing,
    thinActs: thin,
    swappedActs: swapped,
    noDataActs: noData,
    signalCheck: check,
  };
}
