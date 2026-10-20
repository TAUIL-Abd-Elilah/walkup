/**
 * Ticketmaster Discovery v2 side of the fixture world: GET /events/{id}.json,
 * GET /events.json (venueId, keyword, date window, size, page, sort) and
 * GET /venues.json. Bodies follow the shapes @walkup/tm reads, plus a
 * top-level "synthetic": true.
 */
import { catalogByKey } from "./catalog-entities";
import { WORLD_EVENTS, WORLD_VENUES, worldEventById, type WorldAttraction, type WorldEvent, type WorldVenue } from "./catalog-tm";
import { jsonResponse, type FetchLike } from "./http";
import { tmId } from "./ids";
import type { WorldContext } from "./qloo-transport";

function venueBody(v: WorldVenue): Record<string, unknown> {
  return {
    id: v.id,
    name: v.name,
    type: "venue",
    url: `https://tickets.example/venue/${v.id}`,
    postalCode: v.postalCode,
    timezone: v.timezone,
    city: { name: v.city },
    state: { name: v.stateName, stateCode: v.state },
    country: { name: "United States Of America", countryCode: "US" },
    address: { line1: v.address },
    location: { longitude: String(v.lon), latitude: String(v.lat) },
  };
}

function attractionBody(a: WorldAttraction, ev: WorldEvent): Record<string, unknown> {
  const body: Record<string, unknown> = { id: tmId("att", a.key), name: a.name, type: "attraction" };
  if (a.spotify && a.catalogKey) {
    const sid = catalogByKey(a.catalogKey).spotifyId;
    if (sid) body.externalLinks = { spotify: [{ url: `https://open.spotify.com/artist/${sid}` }] };
  }
  const genre = a.comedy ? "Comedy" : ev.genre;
  const segment = a.comedy ? "Arts & Theatre" : ev.segment;
  body.classifications = [{ primary: true, segment: { name: segment }, genre: { name: genre } }];
  return body;
}

function utcInstant(ev: WorldEvent, v: WorldVenue): string {
  const [hh, mm] = ev.localTime.split(":").map(Number);
  const d = new Date(`${ev.localDate}T00:00:00Z`);
  d.setUTCHours((hh ?? 0) + v.utcOffsetHours, mm ?? 0, 0, 0);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function eventBody(ev: WorldEvent): Record<string, unknown> {
  const v = WORLD_VENUES[ev.venue];
  const cls: Record<string, unknown> = { primary: true, segment: { name: ev.segment }, genre: { name: ev.genre } };
  if (ev.subGenre) cls.subGenre = { name: ev.subGenre };
  const body: Record<string, unknown> = {
    id: ev.id,
    name: ev.name,
    type: "event",
    url: `https://tickets.example/event/${ev.id}`,
    dates: {
      start: { localDate: ev.localDate, localTime: ev.localTime, dateTime: utcInstant(ev, v) },
      timezone: v.timezone,
      status: { code: ev.status ?? "onsale" },
    },
    classifications: [cls],
    _embedded: { venues: [venueBody(v)], attractions: ev.attractions.map((a) => attractionBody(a, ev)) },
  };
  if (ev.legalAgeEnforced !== undefined) body.ageRestrictions = { legalAgeEnforced: ev.legalAgeEnforced };
  return body;
}

function parseTmDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function searchEvents(q: URLSearchParams): Record<string, unknown> {
  const venueId = q.get("venueId");
  const keyword = (q.get("keyword") ?? "").toLowerCase();
  const start = parseTmDate(q.get("startDateTime"));
  const end = parseTmDate(q.get("endDateTime"));
  const size = Math.max(1, Math.min(200, Number(q.get("size") ?? 20) || 20));
  const page = Math.max(0, Number(q.get("page") ?? 0) || 0);
  const rows = WORLD_EVENTS.filter((ev) => {
    if (venueId && WORLD_VENUES[ev.venue].id !== venueId) return false;
    if (keyword) {
      const hay = `${ev.name} ${ev.attractions.map((a) => a.name).join(" ")} ${WORLD_VENUES[ev.venue].name} ${WORLD_VENUES[ev.venue].city}`.toLowerCase();
      if (!keyword.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    const t = Date.parse(utcInstant(ev, WORLD_VENUES[ev.venue]));
    if (start !== null && t < start) return false;
    if (end !== null && t > end) return false;
    return true;
  }).sort((a, b) => (a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : a.id < b.id ? -1 : 1));
  const slice = rows.slice(page * size, (page + 1) * size);
  const body: Record<string, unknown> = {
    synthetic: true,
    page: { size, totalElements: rows.length, totalPages: Math.ceil(rows.length / size), number: page },
  };
  if (slice.length > 0) body._embedded = { events: slice.map(eventBody) };
  return body;
}

export function createTmTransport(ctx: WorldContext): FetchLike {
  return async (url: string) => {
    const u = new URL(url);
    ctx.count("tm", u.pathname);
    const path = u.pathname.replace(/^\/discovery\/v2/, "");
    const one = /^\/events\/([^/]+)\.json$/.exec(path);
    if (one) {
      const ev = worldEventById(decodeURIComponent(one[1] as string));
      if (!ev) return jsonResponse(404, { synthetic: true, errors: [{ code: "DIS1004", detail: "Resource not found" }] });
      return jsonResponse(200, { synthetic: true, ...eventBody(ev) });
    }
    if (path === "/events.json") return jsonResponse(200, searchEvents(u.searchParams));
    if (path === "/venues.json") {
      const kw = (u.searchParams.get("keyword") ?? "").toLowerCase();
      const venues = Object.values(WORLD_VENUES).filter((v) => !kw || `${v.name} ${v.city}`.toLowerCase().includes(kw));
      const body: Record<string, unknown> = { synthetic: true, page: { size: 20, totalElements: venues.length, totalPages: 1, number: 0 } };
      if (venues.length > 0) body._embedded = { venues: venues.map(venueBody) };
      return jsonResponse(200, body);
    }
    return jsonResponse(404, { synthetic: true, errors: [{ detail: `no route for ${u.pathname}` }] });
  };
}
