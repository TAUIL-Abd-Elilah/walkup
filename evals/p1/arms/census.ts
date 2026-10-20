/**
 * U.S. Census Geocoder (onelineaddress, benchmark Public_AR_Current) for the primary
 * resolution path (plan §7, ARMS.md §1). Polite: robots.txt read once and honoured,
 * at most one request per second, the collector's User-Agent, retries on 429 / 5xx /
 * network errors (1 s, 2 s, 4 s), and every answer cached in the run store.
 */
import type { GeoPoint } from "@walkup/contracts";
import { StopRunError, errorText } from "./errors";
import { USER_AGENT } from "./protocol";
import { sha256, type RunStore } from "./store";

export const GEOCODER_ORIGIN = "https://geocoding.geo.census.gov";
export const GEOCODER_PATH = "/geocoder/locations/onelineaddress";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface GeocoderOptions {
  fetch: FetchFn;
  store: RunStore;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum gap between requests (default 1000 ms). */
  minIntervalMs?: number;
  maxRetries?: number;
}

export interface Geocoder {
  /** Point A for "address, city, state", or null when the geocoder finds no match. */
  geocode(oneLine: string): Promise<GeoPoint | null>;
  readonly stats: { live: number; cached: number };
}

export function geocoderUrl(oneLine: string): string {
  const qs = new URLSearchParams({ address: oneLine, benchmark: "Public_AR_Current", format: "json" });
  return `${GEOCODER_ORIGIN}${GEOCODER_PATH}?${qs.toString()}`;
}

/** First result.addressMatches[].coordinates (x = lon, y = lat), or null. */
export function parseGeocoderMatch(body: unknown): GeoPoint | null {
  const result = typeof body === "object" && body !== null ? (body as { result?: unknown }).result : undefined;
  const matches = typeof result === "object" && result !== null ? (result as { addressMatches?: unknown }).addressMatches : undefined;
  if (!Array.isArray(matches) || matches.length === 0) return null;
  const first = matches[0] as { coordinates?: { x?: unknown; y?: unknown } } | undefined;
  const x = Number(first?.coordinates?.x);
  const y = Number(first?.coordinates?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { lat: y, lon: x };
}

// ---------------------------------------------------------------------------
// robots.txt (the subset of urllib.robotparser behaviour this runner needs)
// ---------------------------------------------------------------------------

interface RobotsGroup {
  agents: string[];
  rules: { allow: boolean; path: string }[];
}

export function parseRobots(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      current.rules.push({ allow: field === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/** True when `path` may be fetched by `userAgent` under these rules (longest match wins; allow wins ties). */
export function robotsAllows(groups: readonly RobotsGroup[], userAgent: string, path: string): boolean {
  const token = (userAgent.split("/")[0] ?? userAgent).toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const group = specific ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (r.path === "") continue; // "Disallow:" with no path allows everything
    const pattern = new RegExp(
      "^" +
        r.path
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")
          .replace(/\\\$$/, "$"),
    );
    if (!pattern.test(path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export function createGeocoder(opts: GeocoderOptions): Geocoder {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? 1000;
  const maxRetries = opts.maxRetries ?? 3;
  const stats = { live: 0, cached: 0 };
  let last = -Infinity;
  let robots: Promise<boolean> | null = null;
  const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };

  async function pace(): Promise<void> {
    const wait = last + minInterval - now();
    if (wait > 0) await sleep(wait);
    last = now();
  }

  async function allowed(): Promise<boolean> {
    if (!robots) {
      robots = (async () => {
        await pace();
        try {
          const res = await opts.fetch(`${GEOCODER_ORIGIN}/robots.txt`, { headers });
          const text = await res.text();
          // As urllib.robotparser: 401/403 disallow all, other 4xx allow all, 5xx unknown (skip the host).
          if (res.status === 401 || res.status === 403 || res.status >= 500) return false;
          if (res.status >= 400) return true;
          return robotsAllows(parseRobots(text), USER_AGENT, GEOCODER_PATH);
        } catch {
          return false;
        }
      })();
    }
    return robots;
  }

  return {
    stats,
    async geocode(oneLine) {
      const url = geocoderUrl(oneLine);
      const key = `census:${sha256(url)}`;
      const hit = opts.store.get<{ point: GeoPoint | null }>(key);
      if (hit) {
        stats.cached += 1;
        return hit.point;
      }
      if (!(await allowed())) {
        throw new StopRunError("resolution_failed", "the Census Geocoder's robots.txt does not allow this request (or could not be read); the primary resolution path cannot run");
      }
      let lastProblem = "";
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
        await pace();
        let res: Response;
        try {
          res = await opts.fetch(url, { headers });
          stats.live += 1;
        } catch (err) {
          lastProblem = `network error: ${errorText(err)}`;
          continue;
        }
        const text = await res.text();
        if (res.status === 200) {
          let body: unknown;
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            lastProblem = "response was not JSON";
            continue;
          }
          const point = parseGeocoderMatch(body);
          opts.store.set(key, { point });
          return point;
        }
        lastProblem = `HTTP ${res.status}`;
        if (!isRetryable(res.status)) break;
      }
      throw new StopRunError("resolution_failed", `Census Geocoder failed (${lastProblem}); resume later`);
    },
  };
}
