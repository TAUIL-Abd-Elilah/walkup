/**
 * Partial shapes of Ticketmaster Discovery API v2 responses. Every field is
 * optional except event ids because Discovery omits keys freely (no `_embedded`
 * on empty searches, no `ageRestrictions` on many events, ...).
 */

export interface TmNamed {
  id?: string;
  name?: string;
}

export interface TmClassification {
  primary?: boolean;
  segment?: TmNamed;
  genre?: TmNamed;
  subGenre?: TmNamed;
  type?: TmNamed;
  subType?: TmNamed;
  family?: boolean;
}

export interface TmExternalLink {
  url?: string;
  id?: string;
}

export interface TmAttraction {
  id?: string;
  name?: string;
  type?: string;
  url?: string;
  /** Keyed by service: spotify, youtube, musicbrainz, homepage, ... */
  externalLinks?: Record<string, TmExternalLink[] | undefined>;
  classifications?: TmClassification[];
}

export interface TmVenue {
  id?: string;
  name?: string;
  url?: string;
  postalCode?: string;
  timezone?: string;
  city?: { name?: string };
  state?: { name?: string; stateCode?: string };
  country?: { name?: string; countryCode?: string };
  address?: { line1?: string; line2?: string };
  /** Discovery sends coordinates as strings. */
  location?: { latitude?: string | number; longitude?: string | number };
}

export interface TmEventStart {
  localDate?: string; // YYYY-MM-DD, venue-local
  localTime?: string; // HH:mm:ss, venue-local
  dateTime?: string; // UTC instant
  dateTBD?: boolean;
  dateTBA?: boolean;
  timeTBA?: boolean;
  noSpecificTime?: boolean;
}

export interface TmEvent {
  id: string;
  name?: string;
  type?: string;
  url?: string;
  dates?: {
    start?: TmEventStart;
    timezone?: string;
    /** onsale | offsale | canceled | postponed | rescheduled */
    status?: { code?: string };
  };
  classifications?: TmClassification[];
  ageRestrictions?: { legalAgeEnforced?: boolean };
  _embedded?: {
    venues?: TmVenue[];
    attractions?: TmAttraction[];
  };
}

export interface TmPage {
  size: number;
  totalElements: number;
  totalPages: number;
  number: number;
}

export interface TmEventSearchResponse {
  _embedded?: { events?: TmEvent[] };
  page?: TmPage;
}

export interface TmVenueSearchResponse {
  _embedded?: { venues?: TmVenue[] };
  page?: TmPage;
}

/** Sort keys Discovery accepts on /events. Other strings pass through untouched. */
export type TmEventSort =
  | "date,asc"
  | "date,desc"
  | "name,asc"
  | "name,desc"
  | "relevance,asc"
  | "relevance,desc"
  | "distance,asc"
  | "date,name,asc"
  | "name,date,asc"
  | "onSaleStartDate,asc"
  | "id,asc"
  | "random";
