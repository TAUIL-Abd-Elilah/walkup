import { createMemoryLedger, type ControlPlace, type EnvelopeStatus, type GeoPoint, type LedgerSink } from "@walkup/contracts";
import {
  createMemoryCacheStore,
  createMemoryCounterStore,
  MAX_CACHE_TTL_MS,
  pacificDayKey,
  realSleep,
  type Clock,
  type DailyCounterStore,
  type PlacesCacheStore,
  type Sleep,
} from "./stores";
import type { GooglePlace, GoogleTextSearchResponse, PlaceRecord } from "./types";

export const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
export const PLACES_KEY_ENV = "GOOGLE_PLACES_API_KEY";
export const PLACES_KEY_REF = "$GOOGLE_PLACES_API_KEY";
/**
 * Fixed field mask. Phone and website are left out on purpose: they move the call
 * into a costlier billing tier and the control arm does not need them.
 */
export const PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.regularOpeningHours",
  "places.types",
].join(",");
export const PLACES_MAX_RADIUS_M = 50_000;
export const PLACES_MAX_RESULTS = 20;
export const PLACES_DAILY_CAP = 300;
export const PLACES_DEFAULT_RADIUS_M = 40_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PlacesClientOptions {
  /** Defaults to process.env.GOOGLE_PLACES_API_KEY. */
  apiKey?: string;
  url?: string;
  fetch?: FetchLike;
  ledger?: LedgerSink;
  now?: Clock;
  sleep?: Sleep;
  /** Requests sent per day before the client refuses. Default 300. Cache hits do not count. */
  dailyCap?: number;
  counterStore?: DailyCounterStore;
  /** Day bucket for the cap. Default: Pacific calendar day (when Google quotas reset). */
  dayKey?: (ms: number) => string;
  cache?: PlacesCacheStore;
  /** Clamped to 30 days. Default 30 days. 0 disables caching. */
  cacheTtlMs?: number;
  /** Retries on 429 and 5xx. Default 1. */
  maxRetries?: number;
  languageCode?: string;
  regionCode?: string;
}

export interface TextSearchRequest {
  textQuery: string;
  /** locationBias circle center. Without it the search is unbiased. */
  center?: GeoPoint;
  /** Metres, clamped to 0..50000. Default 40000 when a center is given. */
  radiusM?: number;
  /** 1..20. Default 20. */
  maxResultCount?: number;
  /** A Places (New) type such as "bar" or "night_club". */
  includedType?: string;
  strictTypeFiltering?: boolean;
}

export interface PlacesSearchResult {
  places: PlaceRecord[];
  /** The same rows in the contracts ControlPlace shape. */
  control: ControlPlace[];
  ledgerRef: string;
  httpStatus: number | null;
  cacheHit: boolean;
}

export interface PlacesUsage {
  day: string;
  used: number;
  cap: number;
}

export interface PlacesClient {
  searchText(req: TextSearchRequest): Promise<PlacesSearchResult>;
  usage(): Promise<PlacesUsage>;
  /** Deletes cache entries older than the TTL (when the store supports sweeping). */
  purgeExpired(): Promise<number>;
  readonly ledger: LedgerSink;
}

export class PlacesError extends Error {
  readonly status: number | null;
  readonly ledgerRef: string | undefined;
  constructor(message: string, status: number | null, ledgerRef?: string) {
    super(message);
    this.name = "PlacesError";
    this.status = status;
    this.ledgerRef = ledgerRef;
  }
}

export class PlacesQuotaError extends PlacesError {
  constructor(message: string, ledgerRef?: string) {
    super(message, null, ledgerRef);
    this.name = "PlacesQuotaError";
  }
}

interface SearchBody {
  textQuery: string;
  locationBias?: { circle: { center: { latitude: number; longitude: number }; radius: number } };
  maxResultCount: number;
  includedType?: string;
  strictTypeFiltering?: boolean;
  languageCode?: string;
  regionCode?: string;
}

export function createPlacesClient(options: PlacesClientOptions = {}): PlacesClient {
  const apiKey = options.apiKey ?? process.env[PLACES_KEY_ENV] ?? "";
  const url = options.url ?? PLACES_TEXT_SEARCH_URL;
  const endpoint = new URL(url).pathname;
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init));
  const ledger = options.ledger ?? createMemoryLedger();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const cap = options.dailyCap ?? PLACES_DAILY_CAP;
  const counter = options.counterStore ?? createMemoryCounterStore();
  const dayKey = options.dayKey ?? pacificDayKey;
  const cache = options.cache ?? createMemoryCacheStore();
  const ttl = Math.min(MAX_CACHE_TTL_MS, Math.max(0, options.cacheTtlMs ?? MAX_CACHE_TTL_MS));
  const maxRetries = options.maxRetries ?? 1;

  // Check-and-count runs one caller at a time, so concurrent searches cannot all pass the cap check.
  let quotaGate: Promise<unknown> = Promise.resolve();
  function reserve(day: string): Promise<{ sent: boolean; used: number }> {
    const run = quotaGate.then(async () => {
      const used = await counter.get(day);
      if (used >= cap) return { sent: false, used };
      return { sent: true, used: await counter.increment(day) };
    });
    quotaGate = run.catch(() => undefined);
    return run;
  }

  const redact = (s: string): string => (apiKey ? s.split(apiKey).join(PLACES_KEY_REF) : s);

  function buildBody(req: TextSearchRequest, note: string[]): SearchBody {
    const textQuery = req.textQuery.trim();
    if (!textQuery) throw new RangeError("textQuery is empty");
    const wantMax = req.maxResultCount ?? PLACES_MAX_RESULTS;
    const maxResultCount = Math.min(PLACES_MAX_RESULTS, Math.max(1, Math.floor(wantMax)));
    if (maxResultCount !== wantMax) note.push(`maxResultCount clamped from ${wantMax} to ${maxResultCount}`);
    const body: SearchBody = { textQuery, maxResultCount };
    if (req.center) {
      const { lat, lon } = req.center;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw new RangeError(`invalid center ${lat},${lon}`);
      }
      const wantR = req.radiusM ?? PLACES_DEFAULT_RADIUS_M;
      const radius = Math.min(PLACES_MAX_RADIUS_M, Math.max(0, wantR));
      if (radius !== wantR) note.push(`radius clamped from ${wantR} to ${radius}`);
      body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius } };
    }
    if (req.includedType) body.includedType = req.includedType;
    if (req.strictTypeFiltering !== undefined) body.strictTypeFiltering = req.strictTypeFiltering;
    if (options.languageCode) body.languageCode = options.languageCode;
    if (options.regionCode) body.regionCode = options.regionCode;
    return body;
  }

  function ledgerParams(body: SearchBody): Record<string, string | number | boolean | null> {
    const p: Record<string, string | number | boolean | null> = { textQuery: body.textQuery, maxResultCount: body.maxResultCount };
    if (body.locationBias) {
      p["locationBias.circle.center.latitude"] = body.locationBias.circle.center.latitude;
      p["locationBias.circle.center.longitude"] = body.locationBias.circle.center.longitude;
      p["locationBias.circle.radius"] = body.locationBias.circle.radius;
    }
    if (body.includedType) p.includedType = body.includedType;
    if (body.strictTypeFiltering !== undefined) p.strictTypeFiltering = body.strictTypeFiltering;
    if (body.languageCode) p.languageCode = body.languageCode;
    if (body.regionCode) p.regionCode = body.regionCode;
    p["X-Goog-FieldMask"] = PLACES_FIELD_MASK;
    p["X-Goog-Api-Key"] = PLACES_KEY_REF;
    return p;
  }

  function curlOf(body: SearchBody): string {
    const data = JSON.stringify(body).replace(/'/g, `'\\''`);
    return [
      `curl -s -X POST "${url}"`,
      `-H "Content-Type: application/json"`,
      `-H "X-Goog-Api-Key: ${PLACES_KEY_REF}"`,
      `-H "X-Goog-FieldMask: ${PLACES_FIELD_MASK}"`,
      `-d '${data}'`,
    ].join(" ");
  }

  function result(raw: GooglePlace[], query: string, ledgerRef: string, httpStatus: number | null, cacheHit: boolean): PlacesSearchResult {
    const places = raw.map((p) => toPlaceRecord(p, query)).filter((p): p is PlaceRecord => p !== null);
    return { places, control: places.map(toControlPlace), ledgerRef, httpStatus, cacheHit };
  }

  return {
    ledger,

    async searchText(req) {
      const note: string[] = [];
      const body = buildBody(req, note);
      const params = ledgerParams(body);
      const curl = curlOf(body);
      const cacheKey = JSON.stringify({ url, mask: PLACES_FIELD_MASK, body });
      const startedMs = now();
      const startedAt = new Date(startedMs).toISOString();
      const base = { kind: "places" as const, method: "POST" as const, endpoint, params, curl, startedAt };

      if (ttl > 0) {
        const hit = await cache.get(cacheKey);
        if (hit && startedMs - hit.storedAt < ttl) {
          const out = result(hit.places, body.textQuery, "", hit.httpStatus, true);
          const ledgerRef = ledger.add({
            ...base,
            httpStatus: hit.httpStatus,
            envelopeStatus: out.places.length > 0 ? "ok" : "empty",
            latencyMs: now() - startedMs,
            bytes: 0,
            cacheHit: true,
            resultCount: out.places.length,
            note: [...note, `cached ${new Date(hit.storedAt).toISOString()}`].join("; "),
          });
          return { ...out, ledgerRef };
        }
        if (hit) await cache.delete(cacheKey);
      }

      if (!apiKey) throw new PlacesError(`${PLACES_KEY_ENV} is not set`, null);

      let attempt = 0;
      for (;;) {
        const day = dayKey(now());
        const slot = await reserve(day);
        if (!slot.sent) {
          const ledgerRef = ledger.add({
            ...base,
            httpStatus: null,
            envelopeStatus: "error",
            latencyMs: 0,
            bytes: 0,
            cacheHit: false,
            resultCount: 0,
            note: [...note, `not sent: daily cap ${cap} reached for ${day}`].join("; "),
          });
          throw new PlacesQuotaError(`Google Places daily cap reached (${slot.used}/${cap} on ${day})`, ledgerRef);
        }

        let res: Response;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask": PLACES_FIELD_MASK,
            },
            body: JSON.stringify(body),
          });
        } catch (err) {
          const msg = redact(err instanceof Error ? err.message : String(err));
          const ledgerRef = ledger.add({
            ...base,
            httpStatus: null,
            envelopeStatus: "error",
            latencyMs: now() - startedMs,
            bytes: 0,
            cacheHit: false,
            resultCount: 0,
            note: [...note, `network error: ${msg}`].join("; "),
          });
          throw new PlacesError(`Google Places request failed: ${msg}`, null, ledgerRef);
        }

        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          attempt += 1;
          await res.text().catch(() => "");
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        if (attempt > 0) note.push(`retried ${attempt}x`);

        const text = await res.text();
        const bytes = new TextEncoder().encode(text).length;
        let parsed: unknown = null;
        try {
          // Google answers "no results" with "{}"; an empty body is a failure and must not be cached.
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        const ok = res.ok && isObject(parsed);
        const raw = ok ? placesOf(parsed) : [];
        const out = result(raw, body.textQuery, "", res.status, false);
        const envelopeStatus: EnvelopeStatus = !ok ? "error" : out.places.length > 0 ? "ok" : "empty";
        const ledgerRef = ledger.add({
          ...base,
          httpStatus: res.status,
          envelopeStatus,
          latencyMs: now() - startedMs,
          bytes,
          cacheHit: false,
          resultCount: out.places.length,
          ...(note.length > 0 ? { note: note.join("; ") } : {}),
        });
        if (!ok) {
          const detail = res.ok ? "response was not JSON" : googleError(parsed, text);
          throw new PlacesError(`Google Places HTTP ${res.status}: ${redact(detail)}`, res.status, ledgerRef);
        }
        if (ttl > 0) await cache.set(cacheKey, { storedAt: now(), httpStatus: res.status, places: raw });
        return { ...out, ledgerRef };
      }
    },

    async usage() {
      const day = dayKey(now());
      return { day, used: await counter.get(day), cap };
    },

    async purgeExpired() {
      return cache.purgeOlderThan ? await cache.purgeOlderThan(now() - ttl) : 0;
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function placesOf(body: unknown): GooglePlace[] {
  if (!isObject(body)) return [];
  const list = (body as GoogleTextSearchResponse).places;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function googleError(body: unknown, text: string): string {
  if (isObject(body) && isObject(body.error)) {
    const e = body.error;
    const parts = [e.status, e.message].filter((x): x is string => typeof x === "string");
    if (parts.length > 0) return parts.join(": ");
  }
  return text.slice(0, 200);
}

/** Normalizes one Places (New) result. Null when it has no id or name. */
export function toPlaceRecord(p: GooglePlace, query: string): PlaceRecord | null {
  const name = p.displayName?.text?.trim();
  if (!p.id || !name) return null;
  const rec: PlaceRecord = {
    placeId: p.id,
    name,
    rating: typeof p.rating === "number" ? p.rating : null,
    userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    businessStatus: p.businessStatus ?? null,
    query,
    types: Array.isArray(p.types) ? p.types.filter((t) => typeof t === "string") : [],
    regularOpeningHours: p.regularOpeningHours ?? null,
  };
  if (p.formattedAddress) rec.address = p.formattedAddress;
  const lat = p.location?.latitude;
  const lon = p.location?.longitude;
  if (typeof lat === "number" && typeof lon === "number") rec.location = { lat, lon };
  return rec;
}

/** Strips the grounding-only fields to the contracts ControlPlace shape. */
export function toControlPlace(p: PlaceRecord): ControlPlace {
  const c: ControlPlace = {
    placeId: p.placeId,
    name: p.name,
    rating: p.rating ?? null,
    userRatingCount: p.userRatingCount ?? null,
    businessStatus: p.businessStatus ?? null,
    query: p.query,
  };
  if (p.address !== undefined) c.address = p.address;
  if (p.location) c.location = { lat: p.location.lat, lon: p.location.lon };
  return c;
}
