/**
 * Run state that makes a P1 run resumable. It lives in the meta table of the run's private
 * SQLite file (the same file as the Qloo response cache, under data/private/p1/run/, which is
 * git-ignored): frozen per-bar resolutions, the club entities and tag pins, the run date, the
 * F subset, model-arm answers, Places and Census responses, and call counters.
 */
import { createHash } from "node:crypto";
import type { DailyCounterStore, PlacesCacheEntry, PlacesCacheStore } from "@walkup/places";

/** The two meta methods of @walkup/qloo's QlooCache. */
export interface KvBackend {
  getMeta(name: string): string | null;
  setMeta(name: string, value: string): void;
}

export function createMemoryKv(): KvBackend {
  const map = new Map<string, string>();
  return {
    getMeta: (name) => map.get(name) ?? null,
    setMeta: (name, value) => {
      map.set(name, value);
    },
  };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export class RunStore {
  constructor(
    private readonly kv: KvBackend,
    private readonly prefix = "p1:",
  ) {}

  get<T>(key: string): T | null {
    const raw = this.kv.getMeta(this.prefix + key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    this.kv.setMeta(this.prefix + key, JSON.stringify(value ?? null));
  }

  delete(key: string): void {
    this.kv.setMeta(this.prefix + key, "null");
  }

  number(key: string): number {
    const v = this.get<number>(key);
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }

  increment(key: string, by = 1): number {
    const next = this.number(key) + by;
    this.set(key, next);
    return next;
  }
}

/** Places response cache for @walkup/places, persisted in the run store. */
export function storePlacesCache(store: RunStore): PlacesCacheStore {
  const k = (key: string): string => `places-cache:${sha256(key)}`;
  return {
    get: (key) => store.get<PlacesCacheEntry>(k(key)) ?? undefined,
    set: (key, entry) => store.set(k(key), entry),
    delete: (key) => store.delete(k(key)),
  };
}

export const PLACES_TOTAL_KEY = "places-sent-total";

/**
 * Daily request counter for @walkup/places that also keeps the run total. When the total
 * reaches `totalCap` it reports the day as full, so the client refuses to send (no request goes
 * out past the plan's cap); the runner then reads the total to tell the two caps apart.
 */
export function storePlacesCounter(store: RunStore, totalCap: number): DailyCounterStore {
  return {
    get(day) {
      if (store.number(PLACES_TOTAL_KEY) >= totalCap) return Number.POSITIVE_INFINITY;
      return store.number(`places-day:${day}`);
    },
    increment(day) {
      store.increment(PLACES_TOTAL_KEY);
      return store.increment(`places-day:${day}`);
    },
  };
}
