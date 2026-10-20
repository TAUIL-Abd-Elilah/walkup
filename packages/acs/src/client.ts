import { createMemoryLedger, type EnvelopeStatus, type LedgerSink } from "@walkup/contracts";
import {
  ACS_GET_VARIABLES,
  adults21PlusOf,
  parseCensusNumber,
  parseCensusTable,
  VAR_MEDIAN_AGE,
  VAR_MEDIAN_HOUSEHOLD_INCOME,
  VAR_TOTAL_POPULATION,
  type CensusRecord,
} from "./table";

export const ACS_BASE_URL = "https://api.census.gov/data";
export const ACS_DEFAULT_YEAR = 2024;
export const ACS_FALLBACK_YEAR = 2023;
export const ACS_KEY_ENV = "CENSUS_API_KEY";
export const ACS_KEY_REF = "$CENSUS_API_KEY";
export const ACS_MAX_ZCTAS_PER_REQUEST = 50;
export const ACS_ATTRIBUTION = "U.S. Census Bureau, American Community Survey 5-year estimates.";

const ZCTA_GEO = "zip code tabulation area";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export interface AcsAreaStats {
  geoType: "zcta" | "tract";
  /** ZCTA5 ("37206") or 11-digit tract GEOID (state + county + tract). */
  geoId: string;
  name: string | null;
  totalPopulation: number | null; // B01003_001E
  medianAge: number | null; // B01002_001E
  medianHouseholdIncome: number | null; // B19013_001E
  /** B01001_001E minus the under-21 bins; see VARS_MALE_UNDER_21 / VARS_FEMALE_UNDER_21. */
  adults21Plus: number | null;
  /** ACS 5-year vintage (end year) the row came from. */
  year: number;
  // No density: ACS has no land area. Join the gazetteer's ALAND for that.
}

export interface AcsResult {
  rows: AcsAreaStats[];
  year: number;
  ledgerRefs: string[];
  /** Requested ZCTAs the API returned no row for. */
  missing: string[];
}

export interface AcsClientOptions {
  /** Optional. Defaults to process.env.CENSUS_API_KEY; omitted from requests when empty. */
  apiKey?: string;
  /** ACS 5-year end year. Default 2024. */
  year?: number;
  /** Used once when `year` answers 404. Default 2023; null disables. */
  fallbackYear?: number | null;
  baseUrl?: string;
  fetch?: FetchLike;
  ledger?: LedgerSink;
  now?: Clock;
  sleep?: Sleep;
  /** Minimum gap between request starts. Default 1000 ms (polite use of a public API). */
  minIntervalMs?: number;
  /** Retries on 429 and 5xx. Default 1. */
  maxRetries?: number;
  userAgent?: string;
}

export interface AcsClient {
  /** ACS rows for ZCTAs, batched 50 per request. */
  byZctas(zctas: string[]): Promise<AcsResult>;
  /** ACS rows for every tract in one county (2-digit state FIPS, 3-digit county FIPS). */
  tractsInCounty(stateFips: string, countyFips: string): Promise<AcsResult>;
  /** The vintage in use (changes to the fallback after a 404). */
  year(): number;
  readonly ledger: LedgerSink;
}

export class AcsError extends Error {
  readonly status: number | null;
  readonly ledgerRef: string | undefined;
  constructor(message: string, status: number | null, ledgerRef?: string) {
    super(message);
    this.name = "AcsError";
    this.status = status;
    this.ledgerRef = ledgerRef;
  }
}

/** Census reads ',' and ':' literally; keep them readable in URLs and curl. */
function enc(v: string): string {
  return encodeURIComponent(v).replace(/%2C/gi, ",").replace(/%3A/gi, ":");
}

export function createAcsClient(options: AcsClientOptions = {}): AcsClient {
  const apiKey = options.apiKey ?? process.env[ACS_KEY_ENV] ?? "";
  const baseUrl = (options.baseUrl ?? ACS_BASE_URL).replace(/\/+$/, "");
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init));
  const ledger = options.ledger ?? createMemoryLedger();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const minInterval = options.minIntervalMs ?? 1000;
  const maxRetries = options.maxRetries ?? 1;
  const fallbackYear = options.fallbackYear === undefined ? ACS_FALLBACK_YEAR : options.fallbackYear;
  let year = options.year ?? ACS_DEFAULT_YEAR;
  let nextSlot = Number.NEGATIVE_INFINITY;
  let chain: Promise<void> = Promise.resolve();

  const redact = (s: string): string => (apiKey ? s.split(apiKey).join(ACS_KEY_REF) : s);

  function pace(): Promise<void> {
    const run = chain.then(async () => {
      const t = now();
      if (t < nextSlot) await sleep(nextSlot - t);
      nextSlot = Math.max(now(), nextSlot) + minInterval;
    });
    chain = run.catch(() => undefined);
    return run;
  }

  interface Fetched {
    records: CensusRecord[];
    year: number;
    ledgerRefs: string[];
  }

  async function fetchTable(geo: { for: string; in?: string }): Promise<Fetched> {
    const ledgerRefs: string[] = [];
    for (;;) {
      const vintage = year;
      const path = `/${vintage}/acs/acs5`;
      const query = [`get=${enc(ACS_GET_VARIABLES.join(","))}`, `for=${enc(geo.for)}`, ...(geo.in ? [`in=${enc(geo.in)}`] : [])].join("&");
      const url = `${baseUrl}${path}?${query}${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ""}`;
      const curl = `curl -s "${baseUrl}${path}?${query}${apiKey ? `&key=${ACS_KEY_REF}` : ""}"`;
      const params: Record<string, string | string[]> = { get: [...ACS_GET_VARIABLES], for: geo.for };
      if (geo.in) params.in = geo.in;
      if (apiKey) params.key = ACS_KEY_REF;
      const startedMs = now();
      const base = {
        kind: "acs" as const,
        method: "GET" as const,
        endpoint: `${basePath}${path}`,
        params,
        curl,
        startedAt: new Date(startedMs).toISOString(),
        cacheHit: false,
      };

      let attempt = 0;
      let res: Response;
      for (;;) {
        await pace();
        try {
          res = await doFetch(url, {
            method: "GET",
            headers: { Accept: "application/json", "User-Agent": options.userAgent ?? "walkup-acs/0.0.1 (aggregate ACS lookups)" },
          });
        } catch (err) {
          const msg = redact(err instanceof Error ? err.message : String(err));
          const ref = ledger.add({ ...base, httpStatus: null, envelopeStatus: "error", latencyMs: now() - startedMs, bytes: 0, resultCount: 0, note: `network error: ${msg}` });
          throw new AcsError(`Census request failed: ${msg}`, null, ref);
        }
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          attempt += 1;
          await res.text().catch(() => "");
          await sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        break;
      }
      const notes: string[] = attempt > 0 ? [`retried ${attempt}x`] : [];
      const text = await res.text();
      const bytes = new TextEncoder().encode(text).length;
      const latencyMs = now() - startedMs;

      if (res.status === 404 && fallbackYear !== null && vintage !== fallbackYear) {
        ledgerRefs.push(
          ledger.add({ ...base, httpStatus: 404, envelopeStatus: "error", latencyMs, bytes, resultCount: 0, note: [...notes, `ACS ${vintage} not available; falling back to ${fallbackYear}`].join("; ") }),
        );
        year = fallbackYear;
        continue;
      }

      // 204 No Content: the query matched no geographies.
      if (res.status === 204 || (res.ok && text.trim() === "")) {
        ledgerRefs.push(ledger.add({ ...base, httpStatus: res.status, envelopeStatus: "empty", latencyMs, bytes, resultCount: 0, ...(notes.length ? { note: notes.join("; ") } : {}) }));
        return { records: [], year: vintage, ledgerRefs };
      }

      let records: CensusRecord[] | null = null;
      let parseProblem = "";
      if (res.ok) {
        try {
          records = parseCensusTable(JSON.parse(text));
        } catch (err) {
          parseProblem = /invalid key/i.test(text)
            ? "Census rejected the API key (check CENSUS_API_KEY)"
            : `Census response was not an ACS table: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (!records) {
        const detail = parseProblem || text.replace(/\s+/g, " ").trim().slice(0, 200);
        const ref = ledger.add({ ...base, httpStatus: res.status, envelopeStatus: "error", latencyMs, bytes, resultCount: 0, note: [...notes, redact(detail)].join("; ") });
        throw new AcsError(`Census HTTP ${res.status}: ${redact(detail)}`, res.status, ref);
      }
      const envelopeStatus: EnvelopeStatus = records.length > 0 ? "ok" : "empty";
      ledgerRefs.push(
        ledger.add({ ...base, httpStatus: res.status, envelopeStatus, latencyMs, bytes, resultCount: records.length, ...(notes.length ? { note: notes.join("; ") } : {}) }),
      );
      return { records, year: vintage, ledgerRefs };
    }
  }

  return {
    ledger,
    year: () => year,

    async byZctas(zctas) {
      const wanted = [...new Set(zctas.map((z) => z.trim()))];
      const bad = wanted.filter((z) => !/^\d{5}$/.test(z));
      if (bad.length > 0) throw new RangeError(`Not 5-digit ZCTAs: ${bad.join(", ")}`);
      const rows: AcsAreaStats[] = [];
      const ledgerRefs: string[] = [];
      for (let i = 0; i < wanted.length; i += ACS_MAX_ZCTAS_PER_REQUEST) {
        const batch = wanted.slice(i, i + ACS_MAX_ZCTAS_PER_REQUEST);
        const got = await fetchTable({ for: `${ZCTA_GEO}:${batch.join(",")}` });
        ledgerRefs.push(...got.ledgerRefs);
        for (const r of got.records) {
          const geoId = r[ZCTA_GEO];
          if (geoId) rows.push(toStats(r, "zcta", geoId, got.year));
        }
      }
      const seen = new Set(rows.map((r) => r.geoId));
      return { rows, year: year, ledgerRefs, missing: wanted.filter((z) => !seen.has(z)) };
    },

    async tractsInCounty(stateFips, countyFips) {
      if (!/^\d{2}$/.test(stateFips) || !/^\d{3}$/.test(countyFips)) {
        throw new RangeError(`Expected 2-digit state and 3-digit county FIPS, got ${stateFips}/${countyFips}`);
      }
      const got = await fetchTable({ for: "tract:*", in: `state:${stateFips} county:${countyFips}` });
      const rows: AcsAreaStats[] = [];
      for (const r of got.records) {
        const geoId = `${r.state ?? ""}${r.county ?? ""}${r.tract ?? ""}`;
        if (geoId.length === 11) rows.push(toStats(r, "tract", geoId, got.year));
      }
      return { rows, year: got.year, ledgerRefs: got.ledgerRefs, missing: [] };
    },
  };
}

function toStats(r: CensusRecord, geoType: AcsAreaStats["geoType"], geoId: string, year: number): AcsAreaStats {
  return {
    geoType,
    geoId,
    name: r.NAME ?? null,
    totalPopulation: parseCensusNumber(r[VAR_TOTAL_POPULATION]),
    medianAge: parseCensusNumber(r[VAR_MEDIAN_AGE]),
    medianHouseholdIncome: parseCensusNumber(r[VAR_MEDIAN_HOUSEHOLD_INCOME]),
    adults21Plus: adults21PlusOf(r),
    year,
  };
}

export interface AreaSummary {
  areas: number;
  /** Sum over areas with a value; null when no area has one. */
  totalPopulation: number | null;
  adults21Plus: number | null;
  /** Areas whose adults21Plus was null (left out of the sum). */
  adultsMissing: number;
  /** Population-weighted mean of area medians: an approximation, not a true median. */
  approxMedianAge: number | null;
}

/** Rolls ZCTA/tract rows up to one tile (e.g. LiftTile.adultPopulation). */
export function summarizeAreas(rows: AcsAreaStats[]): AreaSummary {
  const sum = (xs: (number | null)[]): number | null => {
    const vals = xs.filter((x): x is number => x !== null);
    return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
  };
  let wSum = 0;
  let wAge = 0;
  for (const r of rows) {
    if (r.medianAge !== null && r.totalPopulation !== null && r.totalPopulation > 0) {
      wSum += r.totalPopulation;
      wAge += r.medianAge * r.totalPopulation;
    }
  }
  return {
    areas: rows.length,
    totalPopulation: sum(rows.map((r) => r.totalPopulation)),
    adults21Plus: sum(rows.map((r) => r.adults21Plus)),
    adultsMissing: rows.filter((r) => r.adults21Plus === null).length,
    approxMedianAge: wSum > 0 ? wAge / wSum : null,
  };
}
