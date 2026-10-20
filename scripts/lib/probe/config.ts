/**
 * Probe configuration (scripts/probe.config.json): types, loader and a
 * pragmatic validator. The config holds probe-only test inputs (venue points,
 * test bills, clubs and metros, tag keywords); none of it is a product claim.
 */

import { readFileSync } from "node:fs";

export interface Point {
  lat: number;
  lon: number;
}

export interface SourceRef {
  provider: string;
  retrieved: string;
  query?: string;
  osm?: string;
  url?: string;
  license?: string;
  result?: string;
}

export interface VenueCfg {
  name: string;
  city: string;
  state: string;
  /** Null until known (e.g. a room too new for OSM). Probes then skip or fall back. */
  lat: number | null;
  lon: number | null;
  note?: string;
  source: SourceRef;
  /** Used only to anchor a name search when the venue point is unknown. */
  searchAnchor?: Point & { radiusMiles: number; note?: string; source?: SourceRef };
}

export const ENTITY_KINDS = [
  "artist",
  "book",
  "brand",
  "destination",
  "movie",
  "person",
  "place",
  "podcast",
  "tv_show",
  "video_game",
  "locality",
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface ActCfg {
  name: string;
  kind: EntityKind;
  aliases?: string[];
}

export interface BillCfg {
  label: string;
  genre: string;
  acts: ActCfg[];
}

export interface TagKeywordCfg {
  key: string;
  /** Tried in order; the first query that yields a usable tag wins. */
  queries: string[];
  /** Scope for /v2/tags filter.parents.types, or null for no scope. */
  parentType: string | null;
  /** Cap when a probe keeps every matching tag (e.g. an exclusion list). Default 5. */
  max?: number;
}

export interface ClubCfg {
  key: string;
  name: string;
  aliases: string[];
}

export interface MetroCfg extends Point {
  key: string;
  name: string;
  source: SourceRef;
}

export interface BarRowCfg {
  club: string;
  metro: string;
  barName: string | null;
  lat: number | null;
  lon: number | null;
  sourceUrl: string | null;
}

export interface VenueChoiceCfg {
  venue: string;
  fallbackVenue: string;
}

export interface ProbeConfig {
  about?: string;
  run: {
    ratePerSecond: number;
    maxCalls: number;
    maxRetries: number;
    timeoutMs: number;
    minMonthRemaining: number;
  };
  venues: Record<string, VenueCfg>;
  tags: {
    pinned: Record<string, { id: string; note?: string }>;
    keywords: TagKeywordCfg[];
  };
  /** Ticketmaster-derived roster for one room (filled on key day). */
  roster: { venue: string; spotifyIds: string[]; note?: string };
  kg1: {
    note?: string;
    venues: string[];
    poolRadiusM: number;
    poolSize: number;
    poolTagKeys: string[];
    topK: number;
    maxTau: number;
    maxTopKOverlap: number;
    minPool: number;
    minCoverage: number;
    venuesRequired: number;
    bills: Record<string, BillCfg[]>;
  };
  kg2: VenueChoiceCfg & {
    radiusM: number;
    genericTagKey: string;
    houseMaxEntities: number;
    houseMinResolved: number;
    shrinkBelowPopularity: number;
    topFraction: number;
    maxSpearman: number;
    maxTopJaccard: number;
  };
  kg4: {
    note?: string;
    radiusM: number;
    take: number;
    barTagKeys: string[];
    clubs: ClubCfg[];
    metros: MetroCfg[];
    bars: BarRowCfg[];
    barsFile: string | null;
    barSearchRadiusMiles: number;
    metroSearchRadiusMiles: number;
    minResolved: number;
    minInTop: number;
    minNameSimilarity: number;
    maxBarDistanceM: number;
  };
  people: {
    note?: string;
    headliner: ActCfg;
    ambiguous: ActCfg;
    thin: ActCfg;
    proxies: ActCfg[];
  };
  p6: { venue: string; radiusM: number; minCells: number; maxSpearman: number; baselineTagKey: string };
  p7: { markerNamePatterns: string[] };
  p8: { venues: string[]; radiusMiles: number; minNameSimilarity: number };
  p9: { venue: string; radiusM: number; minRows: number; take: number; keys: string[] };
  p10: { venue: string; day: string };
  p11: VenueChoiceCfg & { take: number; maxOverlap: number };
  p12: VenueChoiceCfg & { take: number; excludeTagKey: string };
  p13: { take: number; minDistinctive: number; genericNames: string[]; genericPrefixes: string[] };
  p14: VenueChoiceCfg & { radiusM: number; weights: [number, number]; topCells: number; maxTopJaccard: number };
  p15: { venue: string; radiusM: number; names: string[]; minResolved: number; minNameSimilarity: number };
  p16: { venue: string; ageBuckets: string[]; topN: number };
  p17: { queries: string[]; rankQuery: string; venue: string; topN: number };
  p18: { minResolved: number; maxIds: number };
  p19: { venue: string; radiusM: number; tagKey: string; minCells: number };
  p20: { note?: string; podcast: ActCfg; guests: ActCfg[]; minScored: number; minAffinitySpread: number; minDistinct: number };
}

export function loadConfig(path: string): ProbeConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const errors = validateConfig(raw);
  if (errors.length > 0) {
    throw new Error(`invalid probe config ${path}:\n  - ${errors.join("\n  - ")}`);
  }
  return raw as ProbeConfig;
}

/** Returns a list of problems; empty when the config is usable. */
export function validateConfig(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(raw)) return ["config must be a JSON object"];
  const sections = [
    "run",
    "venues",
    "tags",
    "roster",
    "kg1",
    "kg2",
    "kg4",
    "people",
    "p6",
    "p7",
    "p8",
    "p9",
    "p10",
    "p11",
    "p12",
    "p13",
    "p14",
    "p15",
    "p16",
    "p17",
    "p18",
    "p19",
    "p20",
  ];
  for (const s of sections) if (!isRecord(raw[s])) errors.push(`missing section "${s}"`);
  if (errors.length > 0) return errors;
  const cfg = raw as unknown as ProbeConfig;

  const run = cfg.run;
  if (!(run.ratePerSecond > 0 && run.ratePerSecond <= 3)) errors.push("run.ratePerSecond must be in (0, 3]");
  if (!(Number.isInteger(run.maxCalls) && run.maxCalls > 0 && run.maxCalls <= 100))
    errors.push("run.maxCalls must be an integer in 1..100");
  if (!(Number.isInteger(run.maxRetries) && run.maxRetries >= 0 && run.maxRetries <= 2))
    errors.push("run.maxRetries must be 0..2");

  for (const [key, v] of Object.entries(cfg.venues)) {
    if (typeof v.name !== "string" || v.name === "") errors.push(`venues.${key}.name missing`);
    const both = v.lat !== null && v.lon !== null;
    const neither = v.lat === null && v.lon === null;
    if (!both && !neither) errors.push(`venues.${key}: lat and lon must both be numbers or both null`);
    if (both && !validPoint({ lat: v.lat as number, lon: v.lon as number }))
      errors.push(`venues.${key}: lat/lon out of range`);
    if (neither && !v.note) errors.push(`venues.${key}: a null point needs a note saying where to fill it from`);
    if (!isRecord(v.source) || typeof v.source.provider !== "string")
      errors.push(`venues.${key}.source must cite where the point came from`);
    if (v.searchAnchor && !validPoint(v.searchAnchor)) errors.push(`venues.${key}.searchAnchor out of range`);
  }

  const venueKeys = new Set(Object.keys(cfg.venues));
  if (!venueKeys.has(cfg.roster.venue)) errors.push(`roster.venue: unknown venue "${cfg.roster.venue}"`);
  if (!Array.isArray(cfg.roster.spotifyIds)) errors.push("roster.spotifyIds must be an array");
  const tagKeys = new Set([...Object.keys(cfg.tags.pinned), ...cfg.tags.keywords.map((k) => k.key)]);
  const needVenue = (path: string, key: string): void => {
    if (!venueKeys.has(key)) errors.push(`${path}: unknown venue "${key}"`);
  };
  const needTag = (path: string, key: string): void => {
    if (!tagKeys.has(key)) errors.push(`${path}: unknown tag key "${key}"`);
  };
  for (const k of cfg.tags.keywords) {
    if (!Array.isArray(k.queries) || k.queries.length === 0) errors.push(`tags.keywords.${k.key}: needs queries`);
  }
  for (const [key, t] of Object.entries(cfg.tags.pinned)) {
    if (typeof t.id !== "string" || !t.id.startsWith("urn:tag:")) errors.push(`tags.pinned.${key}: id must be a urn:tag`);
  }

  cfg.kg1.venues.forEach((v) => needVenue("kg1.venues", v));
  cfg.kg1.poolTagKeys.forEach((t) => needTag("kg1.poolTagKeys", t));
  for (const [v, bills] of Object.entries(cfg.kg1.bills)) {
    needVenue("kg1.bills", v);
    if (!Array.isArray(bills) || bills.length !== 2) errors.push(`kg1.bills.${v}: exactly two contrasting bills expected`);
    else
      bills.forEach((b, i) => {
        if (!Array.isArray(b.acts) || b.acts.length === 0) errors.push(`kg1.bills.${v}[${i}]: needs acts`);
        b.acts?.forEach((a) => {
          if (!isKind(a.kind)) errors.push(`kg1.bills.${v}[${i}]: bad kind "${String(a.kind)}"`);
        });
      });
  }
  for (const v of cfg.kg1.venues) if (!cfg.kg1.bills[v]) errors.push(`kg1.bills: no bills for venue "${v}"`);
  if (cfg.kg1.poolSize > 50) errors.push("kg1.poolSize must be <= 50 (take max)");

  needVenue("kg2.venue", cfg.kg2.venue);
  needVenue("kg2.fallbackVenue", cfg.kg2.fallbackVenue);
  needTag("kg2.genericTagKey", cfg.kg2.genericTagKey);

  cfg.kg4.barTagKeys.forEach((t) => needTag("kg4.barTagKeys", t));
  if (cfg.kg4.take > 50) errors.push("kg4.take must be <= 50");
  const clubKeys = new Set(cfg.kg4.clubs.map((c) => c.key));
  const metroKeys = new Set(cfg.kg4.metros.map((m) => m.key));
  for (const m of cfg.kg4.metros) if (!validPoint(m)) errors.push(`kg4.metros.${m.key}: lat/lon out of range`);
  for (const r of cfg.kg4.bars) {
    if (!clubKeys.has(r.club)) errors.push(`kg4.bars: unknown club "${r.club}"`);
    if (!metroKeys.has(r.metro)) errors.push(`kg4.bars: unknown metro "${r.metro}"`);
  }

  for (const a of [cfg.people.headliner, cfg.people.ambiguous, cfg.people.thin, ...cfg.people.proxies]) {
    if (!isKind(a.kind)) errors.push(`people: bad kind for "${a.name}"`);
  }

  needVenue("p6.venue", cfg.p6.venue);
  needTag("p6.baselineTagKey", cfg.p6.baselineTagKey);
  cfg.p8.venues.forEach((v) => needVenue("p8.venues", v));
  needVenue("p9.venue", cfg.p9.venue);
  cfg.p9.keys.forEach((t) => needTag("p9.keys", t));
  needVenue("p10.venue", cfg.p10.venue);
  for (const p of [cfg.p11, cfg.p12, cfg.p14]) {
    needVenue("venue", p.venue);
    needVenue("fallbackVenue", p.fallbackVenue);
  }
  needTag("p12.excludeTagKey", cfg.p12.excludeTagKey);
  needVenue("p15.venue", cfg.p15.venue);
  needVenue("p16.venue", cfg.p16.venue);
  needVenue("p17.venue", cfg.p17.venue);
  needVenue("p19.venue", cfg.p19.venue);
  needTag("p19.tagKey", cfg.p19.tagKey);
  for (const t of [cfg.p11.take, cfg.p12.take, cfg.p13.take, cfg.p9.take]) {
    if (t > 50) errors.push("take values must be <= 50");
  }
  if (cfg.p20.guests.length !== 10) errors.push("p20.guests: exactly 10 names expected");
  return errors;
}

export function validPoint(p: { lat: number; lon: number }): boolean {
  return (
    typeof p.lat === "number" &&
    typeof p.lon === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
}

function isKind(k: unknown): k is EntityKind {
  return typeof k === "string" && (ENTITY_KINDS as readonly string[]).includes(k);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
