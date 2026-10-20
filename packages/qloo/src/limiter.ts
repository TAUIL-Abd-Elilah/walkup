/**
 * Token bucket. Default: 3 requests per second with a burst of 1, i.e. calls
 * are spaced about 334 ms apart. Qloo's per-second limit is 5; bursts of ~8
 * parallel calls get 429s, so we stay well under it.
 */

export interface RateLimiter {
  /** Resolves when the caller may send one request. Calls are served in order. */
  acquire(): Promise<void>;
}

export interface TokenBucketOptions {
  ratePerSec?: number;
  /** Max tokens held. 1 = evenly spaced calls. */
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createTokenBucket(opts: TokenBucketOptions = {}): RateLimiter {
  const rate = opts.ratePerSec ?? 3;
  if (!(rate > 0)) throw new RangeError("ratePerSec must be > 0");
  const burst = Math.max(1, opts.burst ?? 1);
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  let tokens = burst;
  let last = now();
  let tail: Promise<void> = Promise.resolve();

  const refill = (): void => {
    const t = now();
    tokens = Math.min(burst, tokens + ((t - last) * rate) / 1000);
    last = t;
  };

  const take = async (): Promise<void> => {
    refill();
    while (tokens < 1) {
      await sleep(Math.ceil(((1 - tokens) * 1000) / rate));
      refill();
    }
    tokens -= 1;
  };

  return {
    acquire() {
      const p = tail.then(take);
      tail = p.catch(() => undefined);
      return p;
    },
  };
}

/** A limiter that never waits (fixture mode, tests). */
export const noLimiter: RateLimiter = { acquire: () => Promise.resolve() };

let globalBucket: RateLimiter | null = null;
/** The process-wide 3 req/s bucket shared by every client that does not inject its own. */
export function globalLimiter(): RateLimiter {
  globalBucket ??= createTokenBucket({ ratePerSec: 3, burst: 1 });
  return globalBucket;
}
