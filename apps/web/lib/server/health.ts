/**
 * What /healthz reports beyond key presence, without spending quota:
 *
 * - lastCall: the outcome of the most recent real call per service, read from
 *   the ledgers of runs this process made (no extra request).
 * - probe (live mode only): an unauthenticated GET to each service's host,
 *   at most once per PROBE_TTL_MS, in the background. Any HTTP answer means the
 *   host is reachable; no key is sent, so no quota is used. /healthz never
 *   waits for it.
 */
import type { LedgerEntry } from "@walkup/contracts";

export type Service = "qloo" | "ticketmaster" | "places" | "anthropic";

export interface LastCall {
  httpStatus: number | null;
  envelopeStatus: string;
  at: string;
  cacheHit: boolean;
}

export interface ProbeResult {
  reachable: boolean;
  httpStatus: number | null;
  checkedAt: string;
  ms: number;
  error?: string;
}

export const PROBE_TTL_MS = 10 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 2500;

export const PROBE_URLS: Record<Service, string> = {
  qloo: "https://hackathon.api.qloo.com/",
  ticketmaster: "https://app.ticketmaster.com/discovery/v2/",
  places: "https://places.googleapis.com/",
  anthropic: "https://api.anthropic.com/",
};

/** The LLM probe follows the configured route (OpenRouter or Anthropic). */
export const OPENROUTER_PROBE_URL = "https://openrouter.ai/api/v1/";

const KIND_TO_SERVICE: Partial<Record<LedgerEntry["kind"], Service>> = { qloo: "qloo", tm: "ticketmaster", places: "places", anthropic: "anthropic" };

interface HealthState {
  last: Partial<Record<Service, LastCall>>;
  probes: Partial<Record<Service, ProbeResult>>;
  probing: boolean;
  probedAt: number;
}

const KEY = "__walkupHealth";

function hs(): HealthState {
  const g = globalThis as Record<string, unknown>;
  let s = g[KEY] as HealthState | undefined;
  if (!s) {
    s = { last: {}, probes: {}, probing: false, probedAt: 0 };
    g[KEY] = s;
  }
  return s;
}

/** Remembers the last non-cached call per service from a run's ledger. */
export function recordLedgerOutcomes(entries: readonly LedgerEntry[]): void {
  const s = hs();
  for (const e of entries) {
    const svc = KIND_TO_SERVICE[e.kind];
    if (!svc || e.cacheHit) continue;
    if ((e.note ?? "").includes("fixture world")) continue;
    s.last[svc] = { httpStatus: e.httpStatus, envelopeStatus: e.envelopeStatus, at: e.startedAt, cacheHit: e.cacheHit };
  }
}

export function lastCalls(): Partial<Record<Service, LastCall>> {
  return { ...hs().last };
}

export function probes(): Partial<Record<Service, ProbeResult>> {
  return { ...hs().probes };
}

async function probeOne(url: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "walkup-healthz/1 (reachability only, no key)" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    try {
      await res.body?.cancel();
    } catch {
      // Body not needed.
    }
    return { reachable: true, httpStatus: res.status, checkedAt: new Date().toISOString(), ms: Date.now() - t0 };
  } catch (err) {
    return { reachable: false, httpStatus: null, checkedAt: new Date().toISOString(), ms: Date.now() - t0, error: err instanceof Error ? err.name : "error" };
  }
}

/** Starts a background probe round when the last one is stale. Never awaits on the request path. */
export function refreshProbes(
  services: Service[],
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
  urls: Record<Service, string> = PROBE_URLS,
): Promise<void> | null {
  const s = hs();
  if (s.probing || now - s.probedAt < PROBE_TTL_MS) return null;
  s.probing = true;
  s.probedAt = now;
  return (async () => {
    try {
      const results = await Promise.all(services.map(async (svc) => [svc, await probeOne(urls[svc], fetchImpl)] as const));
      for (const [svc, r] of results) s.probes[svc] = r;
    } finally {
      s.probing = false;
    }
  })();
}

export function resetHealthForTests(): void {
  const s = hs();
  s.last = {};
  s.probes = {};
  s.probing = false;
  s.probedAt = 0;
}
