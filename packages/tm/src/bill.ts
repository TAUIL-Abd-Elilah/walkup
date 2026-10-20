import type { Act, ActRole, Bill, Venue } from "@walkup/contracts";
import { weekdayOfLocalDate } from "./dates";
import type { TmAttraction, TmClassification, TmEvent, TmVenue } from "./types";

/** Shown wherever Ticketmaster data is displayed; event pages deep-link via Bill.tmUrl. */
export const TM_ATTRIBUTION = "Event data from Ticketmaster.";
export const TM_ATTRIBUTION_URL = "https://developer.ticketmaster.com";

const SPOTIFY_ARTIST = /(?:open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?artist\/|spotify:artist:)([A-Za-z0-9]{22})(?![A-Za-z0-9])/;

/** Spotify artist id from an open.spotify.com/artist/... or spotify:artist:... link. */
export function parseSpotifyArtistId(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  return SPOTIFY_ARTIST.exec(url)?.[1];
}

/** Spotify id from an attraction's externalLinks.spotify[0].url, when present. */
export function attractionSpotifyId(a: TmAttraction): string | undefined {
  return parseSpotifyArtistId(a.externalLinks?.spotify?.[0]?.url);
}

const usable = (name: string | undefined): name is string => !!name && name.trim() !== "" && name !== "Undefined";

/** "Segment / Genre" (e.g. "Music / Country"); Discovery's "Undefined" placeholders are dropped. */
export function classificationLabel(c: TmClassification | undefined): string | undefined {
  if (!c) return undefined;
  const parts = [c.segment?.name, c.genre?.name].filter(usable);
  return parts.length > 0 ? parts.join(" / ") : undefined;
}

function isComedyClassification(c: TmClassification | undefined): boolean {
  return [c?.genre?.name, c?.subGenre?.name].some((n) => typeof n === "string" && /comedy/i.test(n));
}

function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Words that introduce supporting acts in an event title ("A with B", "A w/ B", "A featuring B", ...). */
const SUPPORT_MARKER = /\s+(?:with|w\/|featuring|feat\.|ft\.|plus|\+|special guests?|support(?:ing)?(?:\s+(?:from|by))?)\s+/i;

/**
 * Role of attraction `index` on an event. Index 0 is the headliner. Later acts are "co"
 * when their name appears in the title before any support marker ("A & B" -> co),
 * otherwise "support" ("A with B" -> support). A heuristic: Discovery has no role field.
 */
export function inferRole(eventName: string | undefined, attractionName: string | undefined, index: number): ActRole {
  if (index === 0) return "headliner";
  if (!eventName || !attractionName) return "support";
  const headSegment = normalizeName(eventName.split(SUPPORT_MARKER)[0] ?? "");
  const name = normalizeName(attractionName);
  if (!name) return "support";
  return ` ${headSegment} `.includes(` ${name} `) ? "co" : "support";
}

function num(v: string | number | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Contracts Venue from a Discovery venue. Null when name or coordinates are missing. */
export function toVenue(v: TmVenue | undefined): Venue | null {
  if (!v || !usable(v.name)) return null;
  const lat = num(v.location?.latitude);
  const lon = num(v.location?.longitude);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const venue: Venue = { name: v.name, lat, lon, city: v.city?.name ?? "" };
  const state = v.state?.stateCode ?? v.state?.name;
  if (state) venue.state = state;
  if (v.country?.countryCode) venue.country = v.country.countryCode;
  if (v.id) venue.tmVenueId = v.id;
  if (typeof v.timezone === "string" && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(v.timezone)) venue.timeZone = v.timezone;
  return venue;
}

/** Acts in Discovery order: first is the headliner, the rest co/support (see inferRole). */
export function actsOf(event: TmEvent): Act[] {
  const attractions = event._embedded?.attractions ?? [];
  const eventComedy = isComedyClassification(event.classifications?.[0]);
  const acts: Act[] = [];
  attractions.forEach((a, i) => {
    if (!usable(a.name)) return;
    const act: Act = { name: a.name, role: inferRole(event.name, a.name, acts.length === 0 ? 0 : i) };
    if (a.id) act.tmAttractionId = a.id;
    const spotifyId = attractionSpotifyId(a);
    if (spotifyId) act.spotifyId = spotifyId;
    const own = a.classifications?.[0];
    if (own ? isComedyClassification(own) : eventComedy) act.isComedian = true;
    acts.push(act);
  });
  return acts;
}

export interface BillMapResult {
  bill: Bill | null;
  /** Why the bill is null (fatal) or what is thin (e.g. "no attractions"). */
  issues: string[];
}

/** Non-throwing variant of toBill. */
export function tryToBill(event: TmEvent): BillMapResult {
  const issues: string[] = [];
  const venue = toVenue(event._embedded?.venues?.[0]);
  if (!venue) issues.push(event._embedded?.venues?.[0] ? "venue has no name or coordinates" : "event has no venue");
  const localDate = event.dates?.start?.localDate;
  let weekday: Bill["weekday"] | null = null;
  if (!localDate) {
    issues.push("event has no local start date (TBA/TBD)");
  } else {
    try {
      weekday = weekdayOfLocalDate(localDate);
    } catch {
      issues.push(`unparseable local date: ${localDate}`);
    }
  }
  const acts = actsOf(event);
  if (acts.length === 0) issues.push("event has no attractions");
  if (!venue || !localDate || !weekday) return { bill: null, issues };

  const legal = event.ageRestrictions?.legalAgeEnforced;
  const bill: Bill = {
    acts,
    venue,
    date: localDate,
    weekday,
    // Alcohol / 21+ rules come only from here. Absent means unknown, never "all ages".
    legalAgeEnforced: typeof legal === "boolean" ? legal : null,
    tmEventId: event.id,
  };
  const classification = classificationLabel(event.classifications?.[0]);
  if (classification) bill.classification = classification;
  if (event.url) bill.tmUrl = event.url;
  return { bill, issues };
}

export class TmMapError extends Error {
  readonly issues: string[];
  constructor(eventId: string, issues: string[]) {
    super(`Cannot build a bill from Ticketmaster event ${eventId}: ${issues.join("; ")}`);
    this.name = "TmMapError";
    this.issues = issues;
  }
}

/** Contracts Bill from a Discovery event. Throws TmMapError when venue or local date is missing. */
export function toBill(event: TmEvent): Bill {
  const { bill, issues } = tryToBill(event);
  if (!bill) throw new TmMapError(event.id, issues);
  return bill;
}
