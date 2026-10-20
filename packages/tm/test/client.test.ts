import { createMemoryLedger } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import { createRateLimiter, createTmClient, TmError, TmQuotaError, type TmEventSearchResponse, type TmUsage } from "../src/index";
import { fakeClock, fakeFetch, json, loadSynthetic } from "./helpers";

// Not a real key: a placeholder that must never reach the ledger or curl.
const KEY = "unit-test-placeholder-key";
const roster = loadSynthetic<TmEventSearchResponse>("venue-roster.synthetic.json");

describe("createTmClient requests", () => {
  it("builds the venue roster query and writes a redacted ledger entry", async () => {
    const clock = fakeClock();
    const ledger = createMemoryLedger();
    const f = fakeFetch(() => json(roster), clock);
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn, ledger, now: clock.now, sleep: clock.sleep });

    const res = await tm.eventsByVenue("SynVen01", {
      startDateTime: "2026-11-20",
      endDateTime: new Date(Date.UTC(2027, 4, 1, 0, 0, 0, 123)),
    });

    expect(res.data).toHaveLength(9);
    expect(res.ledgerRef).toBe("T1");
    expect(res.page?.totalElements).toBe(9);

    const url = new URL(f.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://app.ticketmaster.com/discovery/v2/events.json");
    expect(url.searchParams.get("venueId")).toBe("SynVen01");
    expect(url.searchParams.get("startDateTime")).toBe("2026-11-20T00:00:00Z");
    expect(url.searchParams.get("endDateTime")).toBe("2027-05-01T00:00:00Z");
    expect(url.searchParams.get("size")).toBe("60");
    expect(url.searchParams.get("sort")).toBe("date,asc");
    expect(url.searchParams.get("apikey")).toBe(KEY);

    const [entry] = ledger.entries();
    expect(entry).toMatchObject({
      id: "T1",
      kind: "tm",
      method: "GET",
      endpoint: "/discovery/v2/events.json",
      httpStatus: 200,
      envelopeStatus: "ok",
      resultCount: 9,
      cacheHit: false,
    });
    expect(entry!.params.apikey).toBe("$TICKETMASTER_API_KEY");
    expect(entry!.bytes).toBeGreaterThan(0);
    expect(entry!.curl).toContain("apikey=$TICKETMASTER_API_KEY");
    expect(entry!.curl.startsWith('curl -s "https://app.ticketmaster.com/discovery/v2/events.json?')).toBe(true);
    expect(JSON.stringify(ledger.entries())).not.toContain(KEY);
  });

  it("clamps size to 200 and notes it", async () => {
    const ledger = createMemoryLedger();
    const f = fakeFetch(() => json({ page: { size: 200, totalElements: 0, totalPages: 0, number: 0 } }));
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn, ledger, sleep: async () => {} });
    const res = await tm.eventsByVenue("V", { size: 500, sort: "date,desc" });
    expect(res.data).toEqual([]);
    expect(new URL(f.calls[0]!.url).searchParams.get("size")).toBe("200");
    expect(ledger.entries()[0]).toMatchObject({ envelopeStatus: "empty", note: "size clamped from 500 to 200" });
  });

  it("refuses deep pages before sending", async () => {
    const f = fakeFetch(() => json({}));
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn });
    await expect(tm.searchEvents({ keyword: "x", size: 200, page: 5 })).rejects.toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });

  it("passes search filters through and omits empty ones", async () => {
    const f = fakeFetch(() => json(roster));
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn });
    await tm.searchEvents({
      keyword: "Marlow Pines",
      city: "Riverton",
      stateCode: "TN",
      classificationName: "Country",
      startDateTime: "2026-11-20T00:00:00-06:00",
    });
    const p = new URL(f.calls[0]!.url).searchParams;
    expect(p.get("keyword")).toBe("Marlow Pines");
    expect(p.get("city")).toBe("Riverton");
    expect(p.get("stateCode")).toBe("TN");
    expect(p.get("classificationName")).toBe("Country");
    expect(p.get("startDateTime")).toBe("2026-11-20T06:00:00Z");
    expect(p.has("endDateTime")).toBe(false);
    expect(p.has("sort")).toBe(false);
  });

  it("searches venues", async () => {
    const f = fakeFetch(() => json({ _embedded: { venues: [{ id: "SynVen01", name: "The Lantern Hall" }] } }));
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn });
    const res = await tm.searchVenues("Lantern Hall", { stateCode: "TN" });
    expect(res.data.map((v) => v.id)).toEqual(["SynVen01"]);
    const url = new URL(f.calls[0]!.url);
    expect(url.pathname).toBe("/discovery/v2/venues.json");
    expect(url.searchParams.get("keyword")).toBe("Lantern Hall");
    expect(url.searchParams.get("stateCode")).toBe("TN");
  });

  it("returns null for a 404 event and records it as empty", async () => {
    const ledger = createMemoryLedger();
    const f = fakeFetch(() => json({ errors: [{ code: "DIS1004", detail: "Resource not found" }] }, 404));
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn, ledger });
    const res = await tm.getEvent("Missing01");
    expect(res.data).toBeNull();
    expect(res.httpStatus).toBe(404);
    expect(f.calls[0]!.url).toContain("/events/Missing01.json?apikey=");
    expect(ledger.entries()[0]).toMatchObject({ httpStatus: 404, envelopeStatus: "empty", resultCount: 0 });
  });

  it("returns an event body for getEvent", async () => {
    const event = loadSynthetic<{ id: string }>("event.synthetic.json");
    const f = fakeFetch(() => json(event));
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn });
    const res = await tm.getEvent("SynEvt0001");
    expect(res.data?.id).toBe("SynEvt0001");
  });

  it("throws TmError on 401 without leaking the key", async () => {
    const ledger = createMemoryLedger();
    const f = fakeFetch(() => json({ fault: { faultstring: "Invalid ApiKey", detail: { errorcode: "oauth.v2.InvalidApiKey" } } }, 401));
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn, ledger });
    const err = await tm.searchVenues("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmError);
    expect((err as TmError).status).toBe(401);
    expect((err as TmError).message).toContain("Invalid ApiKey");
    expect((err as TmError).ledgerRef).toBe("T1");
    expect(ledger.entries()[0]).toMatchObject({ envelopeStatus: "error", httpStatus: 401 });
    expect(JSON.stringify(ledger.entries()) + (err as Error).message).not.toContain(KEY);
  });

  it("redacts the key from network errors", async () => {
    const ledger = createMemoryLedger();
    const tm = createTmClient({
      apiKey: KEY,
      ledger,
      fetch: async (url) => {
        throw new Error(`connect failed for ${url}`);
      },
    });
    const err = (await tm.getEvent("E1").catch((e: unknown) => e)) as TmError;
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain("$TICKETMASTER_API_KEY");
    expect(ledger.entries()[0]!.note).not.toContain(KEY);
  });

  it("treats a 200 that is not JSON as an error, not an empty roster", async () => {
    const ledger = createMemoryLedger();
    const f = fakeFetch(() => new Response("<html>gateway page</html>", { status: 200 }));
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn, ledger });
    const err = (await tm.eventsByVenue("V").catch((e: unknown) => e)) as TmError;
    expect(err).toBeInstanceOf(TmError);
    expect(err.status).toBe(200);
    expect(err.message).toContain("not a JSON object");
    expect(ledger.entries()[0]).toMatchObject({ httpStatus: 200, envelopeStatus: "error", resultCount: 0 });
  });

  it("refuses to run without a key", async () => {
    const f = fakeFetch(() => json({}));
    const tm = createTmClient({ apiKey: "", fetch: f.fn });
    await expect(tm.getEvent("E1")).rejects.toThrow(/TICKETMASTER_API_KEY is not set/);
    expect(f.calls).toHaveLength(0);
  });

  it("retries a 429 once and notes it in a single ledger entry", async () => {
    const clock = fakeClock();
    const ledger = createMemoryLedger();
    const f = fakeFetch((_u, _i, n) => (n === 1 ? json({ fault: { faultstring: "Spike arrest" } }, 429) : json(roster)), clock);
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn, ledger, now: clock.now, sleep: clock.sleep });
    const res = await tm.eventsByVenue("V");
    expect(res.data).toHaveLength(9);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.at - f.calls[0]!.at).toBeGreaterThanOrEqual(1000);
    expect(ledger.entries()).toHaveLength(1);
    expect(ledger.entries()[0]!.note).toBe("retried 1x");
    expect((await tm.usage()).used).toBe(2);
  });
});

describe("pacing and daily quota", () => {
  it("reserves at most 5 slots per second", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ maxPerWindow: 5, windowMs: 1000, now: clock.now, sleep: clock.sleep });
    const t0 = clock.t;
    const starts: number[] = [];
    await Promise.all(Array.from({ length: 11 }, () => limiter.acquire().then(() => starts.push(clock.t - t0))));
    expect(starts).toEqual([0, 0, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 2000]);
  });

  it("never sends more than 5 requests in any 1 s window", async () => {
    const clock = fakeClock();
    const f = fakeFetch(() => json({}), clock);
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn, now: clock.now, sleep: clock.sleep });
    await Promise.all(Array.from({ length: 11 }, (_, i) => tm.getEvent(`E${i}`)));
    const at = f.calls.map((c) => c.at).sort((a, b) => a - b);
    expect(at).toHaveLength(11);
    for (let i = 5; i < at.length; i++) expect(at[i]! - at[i - 5]!).toBeGreaterThanOrEqual(1000);
    expect(at[10]! - at[0]!).toBeGreaterThanOrEqual(2000);
  });

  it("warns once near the daily limit and refuses at the limit", async () => {
    const clock = fakeClock();
    const ledger = createMemoryLedger();
    const warnings: TmUsage[] = [];
    const f = fakeFetch(() => json({}), clock);
    const tm = createTmClient({
      apiKey: KEY,
      fetch: f.fn,
      ledger,
      now: clock.now,
      sleep: clock.sleep,
      dailyLimit: 5,
      dailyWarnAt: 4,
      onQuotaWarning: (u) => warnings.push(u),
    });
    for (let i = 0; i < 5; i++) await tm.getEvent(`E${i}`);
    expect(warnings).toEqual([{ day: "2026-10-13", used: 4, limit: 5, warnAt: 4 }]);

    const err = await tm.getEvent("E6").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmQuotaError);
    expect(f.calls).toHaveLength(5);
    const last = ledger.entries().at(-1)!;
    expect(last).toMatchObject({ httpStatus: null, envelopeStatus: "error" });
    expect(last.note).toMatch(/not sent: daily cap 5/);

    // A new UTC day resets the counter.
    clock.t += 86_400_000;
    await tm.getEvent("E7");
    expect(f.calls).toHaveLength(6);
  });

  it("holds the daily cap when calls run concurrently", async () => {
    const clock = fakeClock();
    const ledger = createMemoryLedger();
    const f = fakeFetch(() => json({}), clock);
    const tm = createTmClient({ apiKey: KEY, fetch: f.fn, ledger, now: clock.now, sleep: clock.sleep, dailyLimit: 3, onQuotaWarning: () => {} });
    const settled = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => tm.getEvent(`E${i}`)));
    expect(f.calls).toHaveLength(3);
    expect(settled.filter((s) => s.status === "rejected" && s.reason instanceof TmQuotaError)).toHaveLength(5);
    expect((await tm.usage()).used).toBe(3);
    expect(ledger.entries()).toHaveLength(8);
  });

  it("defaults the warning to 90% of 5000", async () => {
    const tm = createTmClient({ apiKey: KEY, fetch: async () => json({}) });
    expect(await tm.usage()).toMatchObject({ limit: 5000, warnAt: 4500, used: 0 });
  });
});
