/**
 * Google Places access for the P1 runner through @walkup/places (ledger, cache, daily
 * cap, retries), with the plan's run-wide cap of 2,500 Text Search requests (§8 Budget).
 *
 * The shared client retries 429 and 5xx itself (3 times at 1 s, 2 s, 4 s with the runner's
 * settings) but raises a network error or timeout at once. Plan §8 retries timeouts too, so
 * this wrapper retries those (PlacesError with no HTTP status) 3 times at 1 s, 2 s and 4 s.
 * Every attempt goes through the client, so each one still counts toward the caps.
 */
import { PlacesError, PlacesQuotaError, type PlacesClient, type PlacesSearchResult, type TextSearchRequest } from "@walkup/places";
import { StopRunError } from "./errors";
import { PLACES_TOTAL_KEY, type RunStore } from "./store";

export interface PlacesIo {
  search(req: TextSearchRequest): Promise<PlacesSearchResult>;
  /** Requests sent so far in this run directory (all invocations). */
  sentTotal(): number;
  readonly totalCap: number;
  readonly stats: { live: number; cached: number };
}

export interface PlacesIoOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Retries after a network error or timeout (default 3). */
  maxNetworkRetries?: number;
}

export function createPlacesIo(client: PlacesClient, store: RunStore, totalCap: number, opts: PlacesIoOptions = {}): PlacesIo {
  const stats = { live: 0, cached: 0 };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxNetworkRetries = opts.maxNetworkRetries ?? 3;
  return {
    stats,
    totalCap,
    sentTotal: () => store.number(PLACES_TOTAL_KEY),
    async search(req) {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await client.searchText(req);
          if (res.cacheHit) stats.cached += 1;
          else stats.live += 1;
          return res;
        } catch (err) {
          if (err instanceof PlacesQuotaError) {
            if (store.number(PLACES_TOTAL_KEY) >= totalCap) {
              throw new StopRunError("places_total", `the plan's cap of ${totalCap} Google Places requests is used up`);
            }
            throw new StopRunError("places_daily", `${err.message}; resume tomorrow or raise --places-daily-cap`);
          }
          if (err instanceof PlacesError && err.status === null && attempt < maxNetworkRetries) {
            await sleep(1000 * 2 ** attempt);
            continue;
          }
          throw err;
        }
      }
    },
  };
}
