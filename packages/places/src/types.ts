import type { ControlPlace } from "@walkup/contracts";

/** Places API (New) opening-hours point. day: 0 = Sunday .. 6 = Saturday. */
export interface GooglePoint {
  day?: number;
  hour?: number;
  minute?: number;
  truncated?: boolean;
}

export interface GoogleOpeningHours {
  openNow?: boolean;
  /** A place open 24/7 has one period: open {day 0, 00:00} and no close. */
  periods?: { open?: GooglePoint; close?: GooglePoint }[];
  weekdayDescriptions?: string[];
}

/** One element of `places[]` under our field mask. */
export interface GooglePlace {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  userRatingCount?: number;
  /** OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY */
  businessStatus?: string;
  regularOpeningHours?: GoogleOpeningHours;
  types?: string[];
}

export interface GoogleTextSearchResponse {
  places?: GooglePlace[];
  nextPageToken?: string;
}

/** ControlPlace plus the fields the grounding checks need. */
export interface PlaceRecord extends ControlPlace {
  types: string[];
  regularOpeningHours: GoogleOpeningHours | null;
}
