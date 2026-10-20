/**
 * The three Qloo arms (plan §8, §11; ARMS.md §2, §3, §6):
 *  - Q-pop: one call per metro (no signal), shared by every club's query there;
 *  - Q-signal: one call per query with the club's brand entity as the signal, plus rival rows;
 *  - Q-derby: one shortlist call per signal club in each metro with two or more clubs.
 * Every Q-signal and Q-pop list is checked for the location filter (any place more than 26 km
 * from P stops the run). A call that still fails after retries leaves no rows for it.
 */
import type { GeoPoint } from "@walkup/contracts";
import { QlooError, QlooHttpError } from "@walkup/qloo";
import type { Query } from "./bars";
import { StopRunError, errorText } from "./errors";
import { FILTER_CHECK_M, type ArmName, type ClubKey } from "./protocol";
import { derbyRequest, placeArmRequest, rankedEntries, type QlooIo, type RankedEntry } from "./qloo-io";
import { emptyStats, primaryBar, rowFor, type AnalyzedBar, type ArmRow, type ArmStats } from "./rows";
import { haversineM } from "./similarity";

export interface QArmContext {
  qloo: QlooIo;
  /** Selected queries, in (club, metro) order. */
  queries: readonly Query[];
  /** Analyzed bars by "<club>|<bar_key>". */
  analyzed: ReadonlyMap<string, AnalyzedBar>;
  clubEntities: Partial<Record<ClubKey, string | null>>;
  pinnedTags: readonly string[];
  log: (line: string) => void;
}

export interface QArmResult {
  rows: ArmRow[];
  stats: ArmStats;
  /** Ranked entity lists by query key (Q-signal) or metro (Q-pop); used by the viability report. */
  lists: Map<string, RankedEntry[]>;
}

/** Analyzed own bars of a query, sorted by bar_key. */
export function ownAnalyzed(q: Query, analyzed: ReadonlyMap<string, AnalyzedBar>): AnalyzedBar[] {
  return q.bars.map((b) => analyzed.get(`${b.club}|${b.barKey}`)).filter((a): a is AnalyzedBar => a !== undefined);
}

function rankOf(entries: readonly RankedEntry[], entityId: string): number | null {
  const hit = entries.find((e) => e.entityId === entityId);
  return hit ? hit.position : null;
}

/** §8 filter honoured check. Throws a stop when any returned place lies more than 26 km from P. */
export function checkFilter(entries: readonly RankedEntry[], p: GeoPoint, arm: ArmName, where: string): { withoutLocation: number; maxDistanceM: number } {
  let withoutLocation = 0;
  let maxD = 0;
  for (const e of entries) {
    const loc = e.entity?.location;
    if (!loc) {
      withoutLocation += 1;
      continue;
    }
    const d = haversineM(p.lat, p.lon, loc.lat, loc.lon);
    maxD = Math.max(maxD, d);
    if (d > FILTER_CHECK_M) {
      throw new StopRunError(
        "filter_not_honoured",
        `${arm} for ${where} returned a place ${Math.round(d)} m from the metro point (limit ${FILTER_CHECK_M} m): the location filter was not applied. Plan §8: stop, log a deviation, restart only after the fix is recorded.`,
      );
    }
  }
  return { withoutLocation, maxDistanceM: maxD };
}

/** true / false when every entry has a popularity, else null. */
export function popularityNonIncreasing(entries: readonly RankedEntry[]): boolean | null {
  const pops = entries.map((e) => e.entity?.popularity ?? null);
  if (pops.some((p) => p === null)) return null;
  for (let i = 1; i < pops.length; i++) if ((pops[i] as number) > (pops[i - 1] as number)) return false;
  return true;
}

async function fetchList(qloo: QlooIo, req: ReturnType<typeof placeArmRequest>, stats: ArmStats, label: string, log: (s: string) => void): Promise<RankedEntry[] | null> {
  try {
    const raw = await qloo.request(req);
    stats.completed += 1;
    return rankedEntries(raw.body);
  } catch (err) {
    if (err instanceof StopRunError) throw err;
    if (err instanceof QlooHttpError && (err.status === 400 || err.status === 401 || err.status === 403)) {
      // A request-shape or key problem would fail every call of the arm: stop instead of counting failures.
      throw new StopRunError("fatal_api", `${label}: ${errorText(err)}`);
    }
    if (err instanceof QlooError) {
      stats.failed += 1;
      log(`  ${label}: failed after retries (${errorText(err)}); no rows`);
      return null;
    }
    throw err;
  }
}

function requireTags(pinnedTags: readonly string[]): void {
  if (pinnedTags.length === 0) {
    throw new StopRunError("config", "no place tag was pinned (§8): the Q arms would run without a category filter; record a deviation before running them");
  }
}

export async function runQPop(ctx: QArmContext): Promise<QArmResult> {
  requireTags(ctx.pinnedTags);
  const stats = emptyStats();
  const lists = new Map<string, RankedEntry[]>();
  const metros = new Map<string, GeoPoint>();
  for (const q of ctx.queries) if (ownAnalyzed(q, ctx.analyzed).length > 0 && !metros.has(q.metro)) metros.set(q.metro, q.point);
  stats.planned = metros.size;
  let monotone = 0;
  let notMonotone = 0;
  let unknown = 0;
  let noLocation = 0;
  for (const [metro, p] of [...metros.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entries = await fetchList(ctx.qloo, placeArmRequest(null, p, ctx.pinnedTags), stats, `Q-pop ${metro}`, ctx.log);
    if (!entries) continue;
    noLocation += checkFilter(entries, p, "Q-pop", `metro ${metro}`).withoutLocation;
    const mono = popularityNonIncreasing(entries);
    if (mono === true) monotone += 1;
    else if (mono === false) notMonotone += 1;
    else unknown += 1;
    lists.set(metro, entries);
  }
  const rows: ArmRow[] = [];
  for (const q of ctx.queries) {
    const own = ownAnalyzed(q, ctx.analyzed);
    const entries = lists.get(q.metro);
    if (own.length === 0 || !entries) continue;
    stats.queriesWithRows += 1;
    for (const a of own) rows.push(rowFor("Q-pop", q.club, q.metro, a, rankOf(entries, a.entityId), entries.length));
  }
  stats.rows = rows.length;
  stats.extra = { popularity_non_increasing: monotone, popularity_not_monotone: notMonotone, popularity_unknown: unknown, places_without_location: noLocation };
  return { rows, stats, lists };
}

export async function runQSignal(ctx: QArmContext): Promise<QArmResult> {
  requireTags(ctx.pinnedTags);
  const stats = emptyStats();
  const lists = new Map<string, RankedEntry[]>();
  const rows: ArmRow[] = [];
  let rivalRows = 0;
  let noLocation = 0;
  const work = ctx.queries.filter((q) => ownAnalyzed(q, ctx.analyzed).length > 0);
  stats.planned = work.length;
  for (const q of work) {
    const entity = ctx.clubEntities[q.club];
    if (!entity) continue; // cannot happen: analyzed bars need a brand entity
    const entries = await fetchList(ctx.qloo, placeArmRequest(entity, q.point, ctx.pinnedTags), stats, `Q-signal ${q.key}`, ctx.log);
    if (!entries) continue;
    noLocation += checkFilter(entries, q.point, "Q-signal", `query ${q.key}`).withoutLocation;
    lists.set(q.key, entries);
    stats.queriesWithRows += 1;
    for (const a of ownAnalyzed(q, ctx.analyzed)) rows.push(rowFor("Q-signal", q.club, q.metro, a, rankOf(entries, a.entityId), entries.length));
    // Rival rows (ARMS.md §2): other clubs' analyzed bars in this metro, ranked in this same list.
    for (const other of ctx.queries) {
      if (other.metro !== q.metro || other.club === q.club) continue;
      for (const a of ownAnalyzed(other, ctx.analyzed)) {
        rows.push(rowFor("Q-signal", q.club, q.metro, a, rankOf(entries, a.entityId), entries.length));
        rivalRows += 1;
      }
    }
  }
  stats.rows = rows.length;
  stats.extra = { rival_rows: rivalRows, places_without_location: noLocation };
  return { rows, stats, lists };
}

export async function runQDerby(ctx: QArmContext): Promise<QArmResult> {
  const stats = emptyStats();
  const lists = new Map<string, RankedEntry[]>();
  const rows: ArmRow[] = [];
  // metro -> club -> primary analyzed bar
  const byMetro = new Map<string, Map<ClubKey, AnalyzedBar>>();
  for (const q of ctx.queries) {
    const prim = primaryBar(ownAnalyzed(q, ctx.analyzed));
    if (!prim) continue;
    let m = byMetro.get(q.metro);
    if (!m) byMetro.set(q.metro, (m = new Map()));
    m.set(q.club, prim);
  }
  const metros = [...byMetro.entries()].filter(([, m]) => m.size >= 2).sort(([a], [b]) => (a < b ? -1 : 1));
  stats.planned = metros.reduce((n, [, m]) => n + m.size, 0);
  let sharedPairs = 0;
  for (const [metro, clubs] of metros) {
    const order = [...clubs.keys()].sort();
    for (const c of order) {
      const entity = ctx.clubEntities[c];
      const own = clubs.get(c)!;
      if (!entity) continue;
      const rivals = order.filter((r) => r !== c).map((r) => clubs.get(r)!);
      // The same Qloo place listed by two clubs is sent once (ARMS.md §6); both rows keep its id.
      const shortlist = [...new Set([own.entityId, ...rivals.map((r) => r.entityId)])];
      sharedPairs += rivals.filter((r) => r.entityId === own.entityId).length;
      const entries = await fetchList(ctx.qloo, derbyRequest(entity, shortlist), stats, `Q-derby ${c}|${metro}`, ctx.log);
      if (!entries) continue;
      lists.set(`${c}|${metro}`, entries);
      stats.queriesWithRows += 1;
      rows.push(rowFor("Q-derby", c, metro, own, rankOf(entries, own.entityId), entries.length));
      for (const r of rivals) rows.push(rowFor("Q-derby", c, metro, r, rankOf(entries, r.entityId), entries.length));
    }
  }
  stats.rows = rows.length;
  stats.extra = { metros: metros.length, shared_primary_pairs: sharedPairs };
  return { rows, stats, lists };
}
