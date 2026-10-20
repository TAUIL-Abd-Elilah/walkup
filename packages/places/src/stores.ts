import type { GooglePlace } from "./types";

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Upper bound for keeping any Places content (place ids excepted). See the README on which fields Google's terms name. */
export const MAX_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Request counts per day key. Sync or async; the client awaits either. */
export interface DailyCounterStore {
  get(day: string): number | Promise<number>;
  increment(day: string): number | Promise<number>;
}

export function createMemoryCounterStore(): DailyCounterStore {
  const counts = new Map<string, number>();
  return {
    get: (day) => counts.get(day) ?? 0,
    increment(day) {
      const next = (counts.get(day) ?? 0) + 1;
      counts.set(day, next);
      return next;
    },
  };
}

export interface PlacesCacheEntry {
  storedAt: number; // epoch ms
  httpStatus: number;
  places: GooglePlace[];
}

export interface PlacesCacheStore {
  get(key: string): PlacesCacheEntry | undefined | Promise<PlacesCacheEntry | undefined>;
  set(key: string, entry: PlacesCacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  /** Optional sweep of expired entries. */
  purgeOlderThan?(cutoffMs: number): number | Promise<number>;
}

export function createMemoryCacheStore(): PlacesCacheStore & { size(): number } {
  const map = new Map<string, PlacesCacheEntry>();
  return {
    get: (key) => map.get(key),
    set: (key, entry) => {
      map.set(key, entry);
    },
    delete: (key) => {
      map.delete(key);
    },
    purgeOlderThan(cutoffMs) {
      let n = 0;
      for (const [k, v] of map) {
        if (v.storedAt < cutoffMs) {
          map.delete(k);
          n += 1;
        }
      }
      return n;
    },
    size: () => map.size,
  };
}

const pacificDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Google Cloud daily quotas reset at midnight Pacific time; count requests on that calendar. */
export function pacificDayKey(ms: number): string {
  return pacificDay.format(new Date(ms)); // en-CA formats as YYYY-MM-DD
}
