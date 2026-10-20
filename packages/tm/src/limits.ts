/**
 * Request pacing (sliding window) and a per-day request counter.
 * Clock and sleep are injected so tests never wait on real time.
 */

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export interface RateLimiter {
  /** Resolves when a request may start. Slots are reserved in call order. */
  acquire(): Promise<void>;
}

/** At most `maxPerWindow` starts in any `windowMs` span. */
export function createRateLimiter(opts: { maxPerWindow: number; windowMs: number; now: Clock; sleep: Sleep }): RateLimiter {
  const stamps: number[] = [];
  let chain: Promise<void> = Promise.resolve();
  return {
    acquire() {
      const run = chain.then(async () => {
        for (;;) {
          const t = opts.now();
          while (stamps.length > 0 && t - (stamps[0] as number) >= opts.windowMs) stamps.shift();
          if (stamps.length < opts.maxPerWindow) {
            stamps.push(t);
            return;
          }
          await opts.sleep((stamps[0] as number) + opts.windowMs - t);
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** Persists request counts per day key. Sync or async; the client awaits either. */
export interface DailyCounterStore {
  get(day: string): number | Promise<number>;
  increment(day: string): number | Promise<number>;
}

export function createMemoryCounterStore(): DailyCounterStore {
  const counts = new Map<string, number>();
  return {
    get(day) {
      return counts.get(day) ?? 0;
    },
    increment(day) {
      const next = (counts.get(day) ?? 0) + 1;
      counts.set(day, next);
      return next;
    },
  };
}

/** UTC calendar day of an epoch-ms instant, "YYYY-MM-DD". */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
