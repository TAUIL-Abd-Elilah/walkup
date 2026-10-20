/**
 * Pick-list lookups that are not plan runs:
 *
 * - searchShows(): free text ("Artist @ Venue, Date") to Ticketmaster events,
 *   so the operator picks the exact show (live mode; the search box).
 * - searchProxyTitles(): film and TV titles that can stand in for an act when
 *   none of the candidates is right ("None of these: use a proxy").
 *
 * Both write to a throwaway ledger: the plan that follows cites what it uses.
 */
import { createMemoryLedger, type Candidate } from "@walkup/contracts";
import { heuristicShowQuery } from "@walkup/narrator";
import type { PlanDeps } from "@walkup/orchestrator";
import { toCandidate } from "@walkup/qloo";
import { actsOf, toTmDateTime, type TmEvent } from "@walkup/tm";

export interface ShowHit {
  tmEventId: string;
  name: string;
  date: string | null;
  venue: string | null;
  city: string | null;
  acts: string[];
  url: string | null;
}

function hitOf(e: TmEvent): ShowHit {
  const venue = e._embedded?.venues?.[0];
  return {
    tmEventId: e.id,
    name: e.name ?? e.id,
    date: e.dates?.start?.localDate ?? null,
    venue: venue?.name ?? null,
    city: venue?.city?.name ?? null,
    acts: actsOf(e).map((a) => a.name),
    url: e.url ?? null,
  };
}

/** Ticketmaster events matching free text, nearest dates first (at most 10). */
export async function searchShows(deps: PlanDeps, text: string, today: string): Promise<{ query: ReturnType<typeof heuristicShowQuery>; hits: ShowHit[] }> {
  if (!deps.tm) throw new Error("No Ticketmaster client is configured.");
  const q = heuristicShowQuery(text);
  const tm = deps.tm(createMemoryLedger());
  const keyword = [q.artist, q.venue].filter(Boolean).join(" ").trim() || text.trim();
  // Ticketmaster's window is in UTC and shows are dated locally: search a day either side, keep the local date.
  const shift = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const start = q.date ? shift(q.date, -1) : `${today}T00:00:00Z`;
  const end = q.date ? shift(q.date, 1) : undefined;
  const r = await tm.searchEvents({
    keyword,
    ...(q.city ? { city: q.city } : {}),
    startDateTime: toTmDateTime(start),
    ...(end ? { endDateTime: toTmDateTime(end) } : {}),
    size: 10,
    sort: "date,asc",
  });
  const hits = (r.data ?? []).map(hitOf).filter((h) => !q.date || h.date === q.date);
  return { query: q, hits };
}

export type ProxyType = "movie" | "tv_show";

/** Film or TV titles for "None of these: use a proxy" (at most 5, Qloo /search). */
export async function searchProxyTitles(deps: PlanDeps, query: string, type: ProxyType | "both"): Promise<Candidate[]> {
  const types = type === "both" ? ["movie", "tv_show"] : [type];
  const run = deps.qloo.withLedger(createMemoryLedger());
  const r = await run.search(query, types, { take: 5 });
  return r.value.filter((e) => e.subtype === "urn:entity:movie" || e.subtype === "urn:entity:tv_show").map(toCandidate);
}
