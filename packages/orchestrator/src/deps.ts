/**
 * Dependency factories.
 *
 * - createFixtureDeps(): the real clients wired to @walkup/qloo-world
 *   transports. Mode is always "fixture". Used by tests, the fixture
 *   generator and the web app while no keys exist.
 * - createDepsFromEnv(): live clients when QLOO_API_KEY and
 *   TICKETMASTER_API_KEY are set (and WALKUP_MODE is not "fixture" or
 *   "recorded"); otherwise the fixture deps. Server-side only.
 */
import { join, resolve } from "node:path";
import { createMemoryLedger, type LedgerSink } from "@walkup/contracts";
import { createAcsClient } from "@walkup/acs";
import { createNarratorClient, createFileSpendStore, createMemorySpendStore, SpendGuard, type NarratorClient } from "@walkup/narrator";
import { createMemoryCacheStore as createPlacesCache, createMemoryCounterStore as createPlacesCounter, createPlacesClient } from "@walkup/places";
import {
  createMemoryFixtureStore,
  createQlooClient,
  createSqliteCache,
  noLimiter,
  QLOO_DEFAULT_BASE_URL,
  QlooClient,
  walkupModeValue,
  type QlooCache,
} from "@walkup/qloo";
import { createWorld, WORLD_TAG_PINS, type Scenario, type World } from "@walkup/qloo-world";
import { createMemoryCounterStore as createTmCounter, createTmClient } from "@walkup/tm";
import type { ChoiceStore, PlanStore } from "./store";
import { loadTagPins } from "./tags";
import type { PlanDeps, ProbeFlags } from "./types";

/** Never a credential: the world transports ignore it, and ledgers show $ENV references. */
const FIXTURE_KEY = "fixture-world-no-key";

export interface FixtureDepsOptions {
  world?: World;
  seed?: string;
  scenario?: Partial<Scenario>;
  clock?: () => number;
  idGen?: () => string;
  store?: PlanStore;
  choices?: ChoiceStore;
  /** A narrator client (e.g. a mock). Default null: the template narrates. */
  narratorClient?: NarratorClient | null;
  spend?: SpendGuard;
  /** Qloo response cache shared by runs. Default: in-memory SQLite. Null disables. */
  cache?: QlooCache | null;
  probes?: Partial<ProbeFlags>;
}

export type FixtureDeps = PlanDeps & { world: World; qloo: QlooClient };

export function createFixtureDeps(o: FixtureDepsOptions = {}): FixtureDeps {
  const world = o.world ?? createWorld({ ...(o.seed ? { seed: o.seed } : {}), ...(o.scenario ? { scenario: o.scenario } : {}) });
  const clock = o.clock ?? (() => Date.now());
  const sleep = async () => {};
  const qloo = new QlooClient({
    config: {
      apiKey: FIXTURE_KEY,
      baseUrl: QLOO_DEFAULT_BASE_URL,
      allowHost: false,
      dataDir: resolve(".cache", "fixture-world-unused"),
      fixturesDir: resolve("fixtures"),
      requestedMode: "live",
      mode: "live",
      record: false,
      monthGuardFloor: 1500,
    },
    fetch: world.qlooFetch,
    cache: o.cache === undefined ? createSqliteCache(":memory:") : o.cache,
    fixtures: createMemoryFixtureStore(),
    limiter: noLimiter,
    now: clock,
    sleep,
    random: () => 0.5,
  });
  const tmCounter = createTmCounter();
  const placesCounter = createPlacesCounter();
  const placesCache = createPlacesCache();
  const deps: FixtureDeps = {
    world,
    mode: "fixture",
    qloo,
    tm: (ledger: LedgerSink) =>
      createTmClient({ apiKey: FIXTURE_KEY, fetch: world.tmFetch, ledger, now: clock, sleep, ratePerSecond: 10_000, counterStore: tmCounter, onQuotaWarning: () => {} }),
    places: (ledger: LedgerSink) =>
      createPlacesClient({ apiKey: FIXTURE_KEY, fetch: world.placesFetch, ledger, now: clock, sleep, counterStore: placesCounter, cache: placesCache }),
    narrator: { client: o.narratorClient ?? null, spend: o.spend ?? new SpendGuard({ store: createMemorySpendStore(), now: () => new Date(clock()) }) },
    ledger: () => createMemoryLedger(),
    clock,
    tags: WORLD_TAG_PINS,
  };
  if (o.idGen) deps.idGen = o.idGen;
  if (o.store) deps.store = o.store;
  if (o.choices) deps.choices = o.choices;
  if (o.probes) deps.probes = o.probes;
  return deps;
}

export interface EnvDepsOptions {
  store?: PlanStore;
  choices?: ChoiceStore;
  clock?: () => number;
}

/**
 * True when the environment has what a live run needs. Reads key presence only. WALKUP_MODE=recorded
 * (Qloo is no longer available) never runs live, like fixture.
 */
export function liveKeysPresent(env: Record<string, string | undefined> = process.env): boolean {
  const mode = walkupModeValue(env);
  return mode !== "fixture" && mode !== "recorded" && !!env.QLOO_API_KEY && !!env.TICKETMASTER_API_KEY;
}

export function createDepsFromEnv(env: Record<string, string | undefined> = process.env, o: EnvDepsOptions = {}): PlanDeps & { world?: World } {
  const dataDir = resolve(/*turbopackIgnore: true*/ env.WALKUP_DATA_DIR ?? ".cache");
  // OpenRouter when OPENROUTER_API_KEY is set, else Anthropic, else null (template and rules).
  const narratorClient = createNarratorClient(env as NodeJS.ProcessEnv);
  const spend = new SpendGuard({ store: createFileSpendStore(join(/*turbopackIgnore: true*/ dataDir, "anthropic-spend.json")) });
  if (!liveKeysPresent(env)) {
    return createFixtureDeps({
      narratorClient,
      spend,
      ...(o.store ? { store: o.store } : {}),
      ...(o.choices ? { choices: o.choices } : {}),
      ...(o.clock ? { clock: o.clock } : {}),
    });
  }
  const tmCounter = createTmCounter();
  const placesCounter = createPlacesCounter();
  const placesCache = createPlacesCache();
  // Keys come from the same env that decided the mode (the clients would otherwise read process.env).
  const tmKey = env.TICKETMASTER_API_KEY as string;
  const placesKey = env.GOOGLE_PLACES_API_KEY;
  const deps: PlanDeps = {
    mode: "live",
    qloo: createQlooClient({ env }),
    tm: (ledger) => createTmClient({ apiKey: tmKey, ledger, counterStore: tmCounter }),
    acs: (ledger) => createAcsClient({ apiKey: env.CENSUS_API_KEY ?? "", ledger }),
    narrator: { client: narratorClient, spend },
    ledger: () => createMemoryLedger(),
    tags: loadTagPins(),
  };
  if (placesKey) deps.places = (ledger) => createPlacesClient({ apiKey: placesKey, ledger, counterStore: placesCounter, cache: placesCache });
  if (o.store) deps.store = o.store;
  if (o.choices) deps.choices = o.choices;
  if (o.clock) deps.clock = o.clock;
  return deps;
}
