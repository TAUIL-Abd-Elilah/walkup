import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Loads a synthetic fixture and refuses anything not labelled synthetic. */
export function loadSynthetic<T>(name: string): T {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8")) as {
    synthetic?: unknown;
    body: T;
  };
  if (raw.synthetic !== true) throw new Error(`${name} is not labelled synthetic`);
  return raw.body;
}

export interface FakeCall {
  url: string;
  init: RequestInit | undefined;
  at: number;
}

/** Deterministic clock whose sleep advances time instantly. */
export function fakeClock(start = Date.UTC(2026, 9, 13, 12, 0, 0)) {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += Math.max(0, ms);
    },
  };
  return clock;
}

/** fetch stand-in that replays queued responses (or a responder) and records calls. */
export function fakeFetch(
  responder: (url: string, init: RequestInit | undefined, n: number) => Response | Promise<Response>,
  clock?: { now: () => number },
) {
  const calls: FakeCall[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init, at: clock ? clock.now() : 0 });
    return responder(url, init, calls.length);
  };
  return { fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
