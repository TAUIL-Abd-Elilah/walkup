/**
 * createWorld(): one deterministic fixture world with three fetch-compatible
 * transports (Qloo, Ticketmaster Discovery, Google Places Text Search) and the
 * scenario knobs. Nothing here touches the network.
 */
import { type FetchLike } from "./http";
import { createPlacesTransport } from "./places-transport";
import { createQlooTransport, type WorldContext } from "./qloo-transport";
import { DEFAULT_SCENARIO, type Scenario } from "./scenario";
import { createTmTransport } from "./tm-transport";

export const WORLD_HOSTS = {
  qloo: "hackathon.api.qloo.com",
  tm: "app.ticketmaster.com",
  places: "places.googleapis.com",
} as const;

export interface WorldOptions {
  /** Changes every derived number. Default DEFAULT_WORLD_SEED. */
  seed?: string;
  scenario?: Partial<Scenario>;
}

export interface WorldStats {
  qloo: number;
  tm: number;
  places: number;
  byPath: Record<string, number>;
}

export interface World {
  readonly seed: string;
  /** Answers https://hackathon.api.qloo.com/... requests. */
  readonly qlooFetch: FetchLike;
  /** Answers https://app.ticketmaster.com/discovery/v2/... requests. */
  readonly tmFetch: FetchLike;
  /** Answers https://places.googleapis.com/v1/places:searchText. */
  readonly placesFetch: FetchLike;
  /** Routes by host to the three transports above; anything else is a 404. */
  readonly fetch: FetchLike;
  scenario(): Scenario;
  setScenario(patch: Partial<Scenario>): void;
  resetScenario(): void;
  stats(): WorldStats;
  resetStats(): void;
}

/** Predates the product name. Every fixture number derives from these bytes, so they never change. */
export const DEFAULT_WORLD_SEED = "houselights-world-v1";

/** Marker so callers can tell a world transport from a live one. */
export const WORLD_TRANSPORT = Symbol.for("walkup.qloo-world.transport");

function mark(f: FetchLike): FetchLike {
  Object.defineProperty(f, WORLD_TRANSPORT, { value: true });
  return f;
}

/** True when `f` is one of this package's synthetic transports. */
export function isWorldTransport(f: unknown): boolean {
  return typeof f === "function" && (f as unknown as Record<symbol, unknown>)[WORLD_TRANSPORT] === true;
}

export function createWorld(opts: WorldOptions = {}): World {
  const seed = opts.seed ?? DEFAULT_WORLD_SEED;
  let scenario: Scenario = { ...DEFAULT_SCENARIO, ...opts.scenario };
  let stats: WorldStats = { qloo: 0, tm: 0, places: 0, byPath: {} };
  const ctx: WorldContext = {
    seed,
    scenario: () => scenario,
    count(kind, path) {
      stats[kind] += 1;
      const k = `${kind} ${path}`;
      stats.byPath[k] = (stats.byPath[k] ?? 0) + 1;
      return stats[kind];
    },
  };
  const qlooFetch = mark(createQlooTransport(ctx));
  const tmFetch = mark(createTmTransport(ctx));
  const placesFetch = mark(createPlacesTransport(ctx));
  const fetch = mark(async (url: string, init?: RequestInit) => {
    const host = new URL(url).hostname;
    if (host === WORLD_HOSTS.qloo) return qlooFetch(url, init);
    if (host === WORLD_HOSTS.tm) return tmFetch(url, init);
    if (host === WORLD_HOSTS.places) return placesFetch(url, init);
    return new Response(JSON.stringify({ synthetic: true, error: `no world host ${host}` }), { status: 404 });
  });
  return {
    seed,
    qlooFetch,
    tmFetch,
    placesFetch,
    fetch,
    scenario: () => scenario,
    setScenario(patch) {
      scenario = { ...scenario, ...patch };
    },
    resetScenario() {
      scenario = { ...DEFAULT_SCENARIO, ...opts.scenario };
    },
    stats: () => ({ ...stats, byPath: { ...stats.byPath } }),
    resetStats() {
      stats = { qloo: 0, tm: 0, places: 0, byPath: {} };
    },
  };
}
