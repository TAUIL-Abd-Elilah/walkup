/** Test helpers: a mock fetch and a live-mode client wired to in-memory stores. Nothing reaches the network. */
import { createMemoryLedger, type LedgerSink } from "@walkup/contracts";
import { createSqliteCache, type QlooCache } from "../src/cache";
import { QlooClient, type QlooClientOptions } from "../src/client";
import type { QlooConfig } from "../src/config";
import { createMemoryFixtureStore } from "../src/fixtures";
import { noLimiter } from "../src/limiter";
import type { FetchLike } from "../src/transport";

/** Obviously fake; never a real credential. */
export const TEST_KEY = "test-key-not-real-7f3a9c";

export interface MockReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type MockHandler = (call: MockCall, index: number) => MockReply | Error | Promise<MockReply | Error>;

export function mockFetch(handler: MockHandler): { fetch: FetchLike; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call: MockCall = {
      url: new URL(url),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const reply = await handler(call, calls.length - 1);
    if (reply instanceof Error) throw reply;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
    return new Response(text, { status: reply.status ?? 200, headers: { "content-type": "application/json", ...reply.headers } });
  };
  return { fetch, calls };
}

/** Always answers 200 with `body`. */
export function okFetch(body: unknown, headers: Record<string, string> = {}): { fetch: FetchLike; calls: MockCall[] } {
  return mockFetch(() => ({ status: 200, body, headers }));
}

export function liveConfig(over: Partial<QlooConfig> = {}): QlooConfig {
  return {
    apiKey: TEST_KEY,
    baseUrl: "https://hackathon.api.qloo.com",
    allowHost: false,
    dataDir: "/nonexistent-walkup-test",
    fixturesDir: "/nonexistent-walkup-test/fixtures",
    requestedMode: "live",
    mode: "live",
    record: false,
    monthGuardFloor: 1500,
    ...over,
  };
}

export function fixtureConfig(over: Partial<QlooConfig> = {}): QlooConfig {
  return liveConfig({ apiKey: null, requestedMode: "fixture", mode: "fixture", ...over });
}

export interface TestClient {
  client: QlooClient;
  ledger: LedgerSink;
  cache: QlooCache;
  sleeps: number[];
}

/** Live-mode client: in-memory SQLite, memory ledger, no limiter, recorded (instant) sleeps. */
export function liveClient(fetch: FetchLike, over: Partial<QlooClientOptions> = {}): TestClient {
  const ledger = over.ledger ?? createMemoryLedger();
  const cache = (over.cache as QlooCache | undefined) ?? createSqliteCache(":memory:");
  const sleeps: number[] = [];
  const client = new QlooClient({
    config: liveConfig(),
    fetch,
    cache,
    ledger,
    fixtures: createMemoryFixtureStore(),
    limiter: noLimiter,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...over,
  });
  return { client, ledger, cache, sleeps };
}

/** A fetch that fails the test if anything tries to use the network. */
export const forbiddenFetch: FetchLike = async () => {
  throw new Error("network must not be used in this test");
};
