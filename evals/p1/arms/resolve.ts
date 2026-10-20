/**
 * Setup and resolution (plan §5, §6, §7, §8 tag pins): club brand entities, the pinned place
 * tags, each listed bar to a Qloo place (primary path near the geocoded address, fallback
 * near the metro point), each resolved bar to a Google place (closed check, arm F), and the
 * exclusion status in the preregistered order.
 */
import type { GeoPoint, QlooTag } from "@walkup/contracts";
import { normalizeTagList, QlooHttpError, QlooNetworkError, QlooError } from "@walkup/qloo";
import { PlacesError } from "@walkup/places";
import type { BarRow } from "./bars";
import type { Geocoder } from "./census";
import { StopRunError, errorText } from "./errors";
import type { PlacesIo } from "./places-io";
import {
  BRAND_TAG_MARKER,
  CLOSED_STATUSES,
  CLUB_BRAND_NAMES,
  FALLBACK_SEARCH_RADIUS_MILES,
  FALLBACK_SIM_THRESHOLD,
  METRO_RADIUS_M,
  NAME_SIM_THRESHOLD,
  PIN_PREFERRED_PREFIX,
  PLACES_PAGE_SIZE,
  PRIMARY_SEARCH_RADIUS_MILES,
  RESOLVE_RADIUS_M,
  STALE_PAGE_YEARS,
  type BarStatus,
  type ClubKey,
  type PinWord,
} from "./protocol";
import { brandSearchRequest, entitiesRequest, placeSearchRequest, rankedEntries, tagsRequest, type QlooIo } from "./qloo-io";
import { extractZip, hasStreetNumber, haversineM, nameSimilarity, normalizeName } from "./similarity";

/** Resolution calls must all succeed: the coverage table is frozen before any arm call. */
function resolutionFailure(what: string, err: unknown): never {
  if (err instanceof StopRunError) throw err;
  if (err instanceof QlooHttpError || err instanceof QlooNetworkError || err instanceof QlooError || err instanceof PlacesError) {
    throw new StopRunError("resolution_failed", `${what} failed after retries (${errorText(err)}); run again to resume`);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// §6 club entities
// ---------------------------------------------------------------------------

export interface ClubEntityRecord {
  club: ClubKey;
  entityId: string | null;
  name: string | null;
  /** The preregistered name whose /search call produced the accepted result. */
  acceptedQuery: string | null;
  queriesTried: string[];
}

export async function resolveClubEntity(qloo: QlooIo, club: ClubKey): Promise<ClubEntityRecord> {
  const names = CLUB_BRAND_NAMES[club];
  const tried: string[] = [];
  for (const query of names) {
    tried.push(query);
    let entries;
    try {
      entries = rankedEntries((await qloo.request(brandSearchRequest(query))).body);
    } catch (err) {
      resolutionFailure(`brand search "${query}"`, err);
    }
    const nameOk = entries.filter((e) => e.entity && names.some((n) => nameSimilarity(e.entity!.name, n) >= NAME_SIM_THRESHOLD));
    if (nameOk.length === 0) continue;
    const tags = new Map<string, QlooTag[]>();
    const missing: string[] = [];
    for (const e of nameOk) {
      if (e.entity!.tags.length > 0) tags.set(e.entity!.entityId, e.entity!.tags);
      else missing.push(e.entity!.entityId);
    }
    if (missing.length > 0) {
      try {
        const raw = await qloo.request(entitiesRequest(missing));
        for (const r of rankedEntries(raw.body)) if (r.entity) tags.set(r.entity.entityId, r.entity.tags);
      } catch (err) {
        resolutionFailure("brand tag lookup (/entities)", err);
      }
    }
    const qualifying = nameOk.filter((e) => (tags.get(e.entity!.entityId) ?? []).some((t) => t.id.includes(BRAND_TAG_MARKER)));
    if (qualifying.length === 0) continue;
    // Several qualify: the higher popularity; equal (or missing) popularity keeps response order.
    let best = qualifying[0]!;
    for (const e of qualifying.slice(1)) {
      if ((e.entity!.popularity ?? -Infinity) > (best.entity!.popularity ?? -Infinity)) best = e;
    }
    return { club, entityId: best.entity!.entityId, name: best.entity!.name, acceptedQuery: query, queriesTried: tried };
  }
  return { club, entityId: null, name: null, acceptedQuery: null, queriesTried: tried };
}

// ---------------------------------------------------------------------------
// §8 tag pins
// ---------------------------------------------------------------------------

export interface TagPin {
  word: PinWord;
  tagId: string | null;
  /** Tags whose normalized name equals the word. */
  exactMatches: number;
  note?: string;
}

export async function pinTag(qloo: QlooIo, word: PinWord): Promise<TagPin> {
  let tags;
  try {
    tags = normalizeTagList((await qloo.request(tagsRequest(word))).body).value;
  } catch (err) {
    resolutionFailure(`tag lookup "${word}"`, err);
  }
  const want = normalizeName(word);
  const matches = tags.filter((t) => normalizeName(t.name) === want);
  if (matches.length === 0) return { word, tagId: null, exactMatches: 0, note: "no tag with this exact name; dropped from the union" };
  const preferred = matches.filter((t) => t.id.startsWith(PIN_PREFERRED_PREFIX));
  const pool = preferred.length > 0 ? preferred : matches;
  const pin: TagPin = { word, tagId: pool[0]!.id, exactMatches: matches.length };
  if (pool.length > 1) pin.note = `${pool.length} equally eligible tags; the first in response order was taken`;
  return pin;
}

// ---------------------------------------------------------------------------
// §7 candidate choice (shared by Qloo and Google)
// ---------------------------------------------------------------------------

export interface PlaceCandidate {
  id: string;
  name: string;
  location: GeoPoint | null;
  address: string | null;
}

export interface Pick {
  status: "resolved" | "unresolved";
  candidate?: PlaceCandidate;
  similarity?: number;
  distanceM?: number;
  reason: string;
}

/** Primary path: within 300 m of A and similarity >= 0.85; best similarity, then nearest; an exact tie on both is unresolved. */
export function pickPrimary(cands: readonly PlaceCandidate[], listedName: string, a: GeoPoint): Pick {
  const ok = cands
    .filter((c) => c.location)
    .map((c) => ({ c, sim: nameSimilarity(listedName, c.name), d: haversineM(a.lat, a.lon, c.location!.lat, c.location!.lon) }))
    .filter((x) => x.d <= RESOLVE_RADIUS_M && x.sim >= NAME_SIM_THRESHOLD)
    .sort((x, y) => y.sim - x.sim || x.d - y.d);
  const top = ok[0];
  if (!top) return { status: "unresolved", reason: cands.length === 0 ? "no results" : "no qualifying candidate" };
  const second = ok[1];
  if (second && second.sim === top.sim && second.d === top.d) return { status: "unresolved", reason: "ambiguous: exact tie" };
  return { status: "resolved", candidate: top.c, similarity: top.sim, distanceM: top.d, reason: "primary" };
}

/**
 * Fallback path: exactly one candidate with similarity >= 0.95 within 25 km of P; then, when both
 * the listing and that candidate show a 5-digit ZIP, they must be equal (plan §7 wording: the ZIP
 * check applies to the one candidate).
 */
export function pickFallback(cands: readonly PlaceCandidate[], listedName: string, listedAddress: string, p: GeoPoint): Pick {
  const ok = cands
    .filter((c) => c.location)
    .map((c) => ({ c, sim: nameSimilarity(listedName, c.name), d: haversineM(p.lat, p.lon, c.location!.lat, c.location!.lon) }))
    .filter((x) => x.sim >= FALLBACK_SIM_THRESHOLD && x.d <= METRO_RADIUS_M);
  if (ok.length === 0) return { status: "unresolved", reason: cands.length === 0 ? "no results" : "no qualifying candidate" };
  if (ok.length > 1) return { status: "unresolved", reason: `ambiguous: ${ok.length} candidates qualify` };
  const only = ok[0]!;
  const zipListed = extractZip(listedAddress);
  const zipCand = extractZip(only.c.address);
  if (zipListed && zipCand && zipListed !== zipCand) return { status: "unresolved", reason: "ZIP mismatch" };
  return { status: "resolved", candidate: only.c, similarity: only.sim, distanceM: only.d, reason: "fallback" };
}

// ---------------------------------------------------------------------------
// Per-bar resolution
// ---------------------------------------------------------------------------

export type ResolutionPath = "primary" | "fallback";

export interface QlooBarResolution {
  status: "resolved" | "unresolved";
  path: ResolutionPath;
  /** Geocoded listing point (primary path only). */
  pointA: GeoPoint | null;
  entityId: string | null;
  name: string | null;
  location: GeoPoint | null;
  similarity: number | null;
  reason: string;
}

export interface GoogleBarResolution {
  status: "resolved" | "unresolved";
  placeId: string | null;
  businessStatus: string | null;
  similarity: number | null;
  reason: string;
}

/** Point A, or null (fallback path). Only addresses starting with a street number are geocoded. */
export async function locateListing(bar: BarRow, geocoder: Geocoder): Promise<GeoPoint | null> {
  if (!hasStreetNumber(bar.address)) return null;
  return geocoder.geocode(`${bar.address}, ${bar.city}, ${bar.state}`);
}

export async function resolveBarInQloo(bar: BarRow, qloo: QlooIo, geocoder: Geocoder): Promise<QlooBarResolution> {
  const p = bar.metroPoint;
  if (!p) throw new Error(`bar ${bar.club}|${bar.barKey} has no metro point`);
  const a = await locateListing(bar, geocoder);
  const path: ResolutionPath = a ? "primary" : "fallback";
  const base: QlooBarResolution = { status: "unresolved", path, pointA: a, entityId: null, name: null, location: null, similarity: null, reason: "" };
  if (!bar.barName) return { ...base, reason: "empty bar name" };
  let entries;
  try {
    const req = a
      ? placeSearchRequest(bar.barName, a, PRIMARY_SEARCH_RADIUS_MILES)
      : placeSearchRequest(bar.barName, p, FALLBACK_SEARCH_RADIUS_MILES);
    entries = rankedEntries((await qloo.request(req)).body);
  } catch (err) {
    resolutionFailure(`place search for ${bar.club}|${bar.barKey}`, err);
  }
  const cands: PlaceCandidate[] = entries
    .filter((e) => e.entity)
    .map((e) => {
      const addr = e.entity!.properties["address"];
      return { id: e.entity!.entityId, name: e.entity!.name, location: e.entity!.location ? { lat: e.entity!.location.lat, lon: e.entity!.location.lon } : null, address: typeof addr === "string" ? addr : null };
    });
  const pick = a ? pickPrimary(cands, bar.barName, a) : pickFallback(cands, bar.barName, bar.address, p);
  if (pick.status !== "resolved" || !pick.candidate) return { ...base, reason: pick.reason };
  return {
    ...base,
    status: "resolved",
    entityId: pick.candidate.id,
    name: pick.candidate.name,
    location: pick.candidate.location,
    similarity: pick.similarity ?? null,
    reason: pick.reason,
  };
}

/** Google Text Search with the same path and acceptance rules (§7 "Google place for each bar"). */
export async function resolveBarInGoogle(bar: BarRow, path: ResolutionPath, pointA: GeoPoint | null, places: PlacesIo): Promise<GoogleBarResolution> {
  const p = bar.metroPoint;
  if (!p) throw new Error(`bar ${bar.club}|${bar.barKey} has no metro point`);
  const primary = path === "primary" && pointA !== null;
  const textQuery = `${bar.barName}, ${bar.address || `${bar.city}, ${bar.state}`}`;
  let res;
  try {
    res = await places.search({
      textQuery,
      center: primary ? pointA! : p,
      radiusM: primary ? RESOLVE_RADIUS_M : METRO_RADIUS_M,
      maxResultCount: PLACES_PAGE_SIZE,
    });
  } catch (err) {
    resolutionFailure(`Google place search for ${bar.club}|${bar.barKey}`, err);
  }
  const byId = new Map(res.places.map((pl) => [pl.placeId, pl]));
  const cands: PlaceCandidate[] = res.places.map((pl) => ({ id: pl.placeId, name: pl.name, location: pl.location ?? null, address: pl.address ?? null }));
  const pick = primary ? pickPrimary(cands, bar.barName, pointA!) : pickFallback(cands, bar.barName, bar.address, p);
  if (pick.status !== "resolved" || !pick.candidate) {
    return { status: "unresolved", placeId: null, businessStatus: null, similarity: null, reason: pick.reason };
  }
  return {
    status: "resolved",
    placeId: pick.candidate.id,
    businessStatus: byId.get(pick.candidate.id)?.businessStatus ?? null,
    similarity: pick.similarity ?? null,
    reason: pick.reason,
  };
}

// ---------------------------------------------------------------------------
// §5 status, in the preregistered order
// ---------------------------------------------------------------------------

/** True when the page shows a date more than 2 years before the run date (YYYY-MM-DD). */
export function isStalePage(pageLastUpdated: string, runDate: string): boolean {
  const s = pageLastUpdated.trim();
  if (!s) return false;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return false;
  const page = new Date(t).toISOString().slice(0, 10);
  const [y, m, d] = runDate.split("-");
  const threshold = `${String(Number(y) - STALE_PAGE_YEARS).padStart(4, "0")}-${m}-${d}`;
  return page < threshold;
}

export interface BarDecision {
  status: BarStatus;
  qloo: QlooBarResolution | null;
  google: GoogleBarResolution | null;
}

export function decideStatus(
  bar: BarRow,
  runDate: string,
  clubEntity: string | null,
  qloo: QlooBarResolution | null,
  google: GoogleBarResolution | null,
): BarStatus {
  if (isStalePage(bar.pageLastUpdated, runDate)) return "stale_page";
  if (!bar.metroPoint) return "no_metro";
  if (!clubEntity) return "no_brand";
  if (!qloo || qloo.status !== "resolved" || !qloo.location) return "unresolved";
  if (google?.status === "resolved" && google.businessStatus && (CLOSED_STATUSES as readonly string[]).includes(google.businessStatus)) {
    return "closed";
  }
  const p = bar.metroPoint;
  if (haversineM(p.lat, p.lon, qloo.location.lat, qloo.location.lon) > METRO_RADIUS_M) return "out_of_radius";
  return "analyzed";
}
