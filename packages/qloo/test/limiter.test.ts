import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTokenBucket } from "../src/limiter";
import { mockFetch, liveClient } from "./helpers";
import * as S from "./synthetic";

describe("token bucket (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spaces calls about 334 ms apart at 3 req/s", async () => {
    const bucket = createTokenBucket({ ratePerSec: 3 });
    const t0 = Date.now();
    const times: number[] = [];
    const all = Array.from({ length: 6 }, () => bucket.acquire().then(() => times.push(Date.now() - t0)));
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all(all);
    expect(times).toHaveLength(6);
    expect(times[0]).toBe(0);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(333);
      expect(times[i]! - times[i - 1]!).toBeLessThanOrEqual(335);
    }
    // Never more than 3 grants inside the first second.
    expect(times.filter((t) => t < 1000)).toHaveLength(3);
  });

  it("serves callers in order", async () => {
    const bucket = createTokenBucket({ ratePerSec: 3 });
    const order: number[] = [];
    const all = [0, 1, 2, 3].map((i) => bucket.acquire().then(() => order.push(i)));
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.all(all);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("allows a burst when configured", async () => {
    const bucket = createTokenBucket({ ratePerSec: 3, burst: 3 });
    const t0 = Date.now();
    const times: number[] = [];
    const all = Array.from({ length: 4 }, () => bucket.acquire().then(() => times.push(Date.now() - t0)));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(all);
    expect(times.slice(0, 3)).toEqual([0, 0, 0]);
    expect(times[3]).toBeGreaterThanOrEqual(333);
  });

  it("refills after idle time without exceeding the burst", async () => {
    const bucket = createTokenBucket({ ratePerSec: 3 });
    await bucket.acquire();
    await vi.advanceTimersByTimeAsync(5000);
    const t0 = Date.now();
    const times: number[] = [];
    const all = Array.from({ length: 2 }, () => bucket.acquire().then(() => times.push(Date.now() - t0)));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(all);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeGreaterThanOrEqual(333);
  });

  it("paces real client calls through the shared bucket", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: S.searchVenue }));
    const sent: number[] = [];
    const t0 = Date.now();
    const timedFetch: typeof fetch = async (url, init) => {
      sent.push(Date.now() - t0);
      return fetch(url, init);
    };
    const { client } = liveClient(timedFetch, { limiter: createTokenBucket({ ratePerSec: 3 }) });
    const p = Promise.all(["a", "b", "c", "d"].map((q) => client.search(q, ["place"])));
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(calls).toHaveLength(4);
    expect(sent[3]! - sent[0]!).toBeGreaterThanOrEqual(999);
  });
});
