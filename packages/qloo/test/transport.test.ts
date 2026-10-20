import { describe, expect, it } from "vitest";
import { createSqliteCache } from "../src/cache";
import { QlooHttpError, QlooNetworkError, QlooQuotaGuardError } from "../src/errors";
import { errorStatus } from "../src/envelope";
import { backoffDelay, isRetryableStatus } from "../src/transport";
import { TEST_KEY, liveClient, mockFetch, okFetch } from "./helpers";
import * as S from "./synthetic";

describe("retries", () => {
  it("sends the key as X-Api-Key and nowhere else", async () => {
    const { fetch, calls } = okFetch(S.searchVenue);
    const { client } = liveClient(fetch);
    await client.search("The Example Hall", ["place"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["x-api-key"]).toBe(TEST_KEY);
    expect(calls[0]!.url.toString()).not.toContain(TEST_KEY);
    expect(calls[0]!.url.host).toBe("hackathon.api.qloo.com");
  });

  it("retries a 429 once and succeeds", async () => {
    const { fetch, calls } = mockFetch((_c, i) => (i === 0 ? { status: 429, body: { error: "slow down" } } : { body: S.searchVenue }));
    const { client, ledger, sleeps } = liveClient(fetch);
    const r = await client.search("The Example Hall", ["place"]);
    expect(calls).toHaveLength(2);
    expect(r.status).toBe("ok");
    expect(sleeps).toEqual([375]);
    const e = ledger.entries()[0]!;
    expect(e.httpStatus).toBe(200);
    expect(e.note).toContain("retry 1 after HTTP 429");
  });

  it("gives up after 2 retries on 5xx with a typed error and an error ledger entry", async () => {
    const { fetch, calls } = mockFetch((_c, i) => ({ status: [500, 502, 503][i] ?? 503, body: "upstream" }));
    const { client, ledger, sleeps } = liveClient(fetch);
    const err = await client.search("x", ["artist"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooHttpError);
    expect((err as QlooHttpError).status).toBe(503);
    expect((err as QlooHttpError).ledgerRef).toBe("Q1");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([375, 750]);
    const e = ledger.entries()[0]!;
    expect(e.envelopeStatus).toBe("error");
    expect(e.httpStatus).toBe(503);
    expect(errorStatus(err).status).toBe("error");
  });

  it("retries network errors, then succeeds", async () => {
    const { fetch, calls } = mockFetch((_c, i) => (i < 2 ? new TypeError("fetch failed") : { body: S.searchVenue }));
    const { client } = liveClient(fetch);
    const r = await client.search("x", ["place"]);
    expect(calls).toHaveLength(3);
    expect(r.value).toHaveLength(1);
  });

  it("throws QlooNetworkError after 3 failed attempts", async () => {
    const { fetch, calls } = mockFetch(() => new TypeError("fetch failed"));
    const { client, ledger } = liveClient(fetch);
    const err = await client.search("x", ["place"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooNetworkError);
    expect(calls).toHaveLength(3);
    expect(ledger.entries()[0]!.envelopeStatus).toBe("error");
    expect(ledger.entries()[0]!.httpStatus).toBeNull();
  });

  it("does not retry a 400", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 400, body: { error: "at least one valid signal is required" } }));
    const { client } = liveClient(fetch);
    const err = await client.insights({ "filter.type": "urn:heatmap" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooHttpError);
    expect((err as QlooHttpError).status).toBe(400);
    expect((err as QlooHttpError).bodySnippet).toContain("valid signal");
    expect(calls).toHaveLength(1);
  });

  it("honours Retry-After on 429 (capped)", async () => {
    const { fetch } = mockFetch((_c, i) => (i === 0 ? { status: 429, headers: { "retry-after": "2" } } : { body: S.searchVenue }));
    const { client, sleeps } = liveClient(fetch);
    await client.search("x", ["place"]);
    expect(sleeps).toEqual([2000]);
  });

  it("backoff is exponential with jitter", () => {
    expect(backoffDelay(0, () => 0)).toBe(250);
    expect(backoffDelay(0, () => 1)).toBe(500);
    expect(backoffDelay(1, () => 0)).toBe(500);
    expect(backoffDelay(2, () => 1)).toBe(2000);
    expect(backoffDelay(10, () => 1)).toBe(8000);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe("month quota guard", () => {
  it("records the month headers and refuses fresh calls below 1500", async () => {
    const { fetch, calls } = okFetch(S.searchVenue, {
      "x-month-ratelimit-remaining": "1499",
      "x-month-ratelimit-limit": "10000",
    });
    const { client, ledger } = liveClient(fetch);
    await client.search("first", ["place"]);
    expect(client.quota()).toMatchObject({ remaining: 1499, limit: 10000 });
    expect(client.guardTripped()).toBe(true);

    const err = await client.search("second", ["place"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooQuotaGuardError);
    expect((err as QlooQuotaGuardError).remaining).toBe(1499);
    expect(calls).toHaveLength(1);
    const refused = ledger.entries()[1]!;
    expect(refused.envelopeStatus).toBe("degraded");
    expect(refused.httpStatus).toBeNull();
    expect(refused.note).toContain("month guard");
    expect(errorStatus(err)).toMatchObject({ status: "degraded", ledgerRef: "Q2" });

    // The cache is still served while the guard is tripped.
    const again = await client.search("first", ["place"]);
    expect(again.cacheHit).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("allows calls at or above the floor", async () => {
    const { fetch, calls } = okFetch(S.searchVenue, { "x-month-ratelimit-remaining": "1500" });
    const { client } = liveClient(fetch);
    await client.search("a", ["place"]);
    await client.search("b", ["place"]);
    expect(calls).toHaveLength(2);
  });

  it("remembers the quota across clients through the cache meta table", async () => {
    const cache = createSqliteCache(":memory:");
    const first = liveClient(okFetch(S.searchVenue, { "x-month-ratelimit-remaining": "900" }).fetch, { cache });
    await first.client.search("a", ["place"]);
    const { fetch, calls } = okFetch(S.searchVenue);
    const second = liveClient(fetch, { cache });
    await expect(second.client.search("b", ["place"])).rejects.toBeInstanceOf(QlooQuotaGuardError);
    expect(calls).toHaveLength(0);
  });

  it("resetQuota lifts the guard until the next response reports the quota again", async () => {
    const { fetch, calls } = okFetch(S.searchVenue, { "x-month-ratelimit-remaining": "100" });
    const { client } = liveClient(fetch);
    await client.search("a", ["place"]);
    await expect(client.search("b", ["place"])).rejects.toBeInstanceOf(QlooQuotaGuardError);
    client.resetQuota();
    expect(client.guardTripped()).toBe(false);
    await client.search("b", ["place"]);
    expect(calls).toHaveLength(2);
    expect(client.guardTripped()).toBe(true);
  });

  it("forgets last month's quota in a long-running process (the guard lifts at the UTC month change)", async () => {
    let now = Date.parse("2026-10-31T23:00:00Z");
    const { fetch, calls } = mockFetch((_c, i) => ({
      body: S.searchVenue,
      headers: { "x-month-ratelimit-remaining": i === 0 ? "900" : "9999" },
    }));
    const { client } = liveClient(fetch, { now: () => now });
    await client.search("a", ["place"]);
    await expect(client.search("b", ["place"])).rejects.toBeInstanceOf(QlooQuotaGuardError);
    expect(calls).toHaveLength(1);

    now = Date.parse("2026-11-01T00:30:00Z");
    expect(client.guardTripped()).toBe(false);
    expect(client.quota().remaining).toBeNull();
    await client.search("b", ["place"]);
    expect(calls).toHaveLength(2);
    expect(client.quota().remaining).toBe(9999);
  });

  it("stops retrying a 429 once the month is exhausted", async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 429, headers: { "x-month-ratelimit-remaining": "0" } }));
    const { client } = liveClient(fetch);
    await expect(client.search("a", ["place"])).rejects.toBeInstanceOf(QlooHttpError);
    expect(calls).toHaveLength(1);
  });
});
