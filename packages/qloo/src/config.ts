/**
 * Configuration from the environment. Server-side only: the key never leaves
 * this process except as the X-Api-Key header to the hackathon host.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { QlooConfigError, QlooHostRefusedError } from "./errors";
import type { QlooMode, RequestedMode } from "./types";

export const QLOO_DEFAULT_BASE_URL = "https://hackathon.api.qloo.com";
export const QLOO_ALLOWED_HOST = "hackathon.api.qloo.com";
/** Fresh calls stop when x-month-ratelimit-remaining drops below this. */
export const DEFAULT_MONTH_GUARD_FLOOR = 1500;

export type EnvLike = Record<string, string | undefined>;

export interface QlooConfig {
  apiKey: string | null;
  /** No trailing slash. */
  baseUrl: string;
  /** QLOO_ALLOW_HOST=1: accept a base URL other than the hackathon host (local mocks only). */
  allowHost: boolean;
  /** Absolute directory for the private SQLite cache. */
  dataDir: string;
  /** Absolute directory holding raw/ and synthetic/. */
  fixturesDir: string;
  requestedMode: RequestedMode;
  /** Effective mode: auto resolves to live when a key is present, else fixture; recorded is fixture. */
  mode: QlooMode;
  /** WALKUP_RECORD=1: write live bodies to fixtures/raw (git-ignored). */
  record: boolean;
  monthGuardFloor: number;
}

/** Reads one env var, dropping inline "# comment" tails that some .env loaders keep. */
export function envValue(env: EnvLike, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const v = raw.replace(/\s+#.*$/, "").trim();
  return v === "" ? undefined : v;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v);
}

/** Throws QlooHostRefusedError unless the URL is https://hackathon.api.qloo.com (or allowHost). */
export function assertAllowedBaseUrl(baseUrl: string, allowHost: boolean): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new QlooHostRefusedError(baseUrl);
  }
  const ok = url.protocol === "https:" && url.hostname === QLOO_ALLOWED_HOST && (url.port === "" || url.port === "443");
  if (!ok && !allowHost) throw new QlooHostRefusedError(url.host || baseUrl);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * WALKUP_MODE as one lower-case word ("auto" when unset), read the same way by this config, the
 * orchestrator's liveKeysPresent and the web app's runtime mode. Not validated here.
 */
export function walkupModeValue(env: EnvLike): string {
  return (envValue(env, "WALKUP_MODE") ?? "auto").split(/\s+/)[0]?.toLowerCase() ?? "auto";
}

function parseMode(env: EnvLike): RequestedMode {
  const m = walkupModeValue(env);
  if (m === "auto" || m === "live" || m === "fixture" || m === "recorded") return m;
  throw new QlooConfigError(`WALKUP_MODE must be auto, live, fixture or recorded (got "${envValue(env, "WALKUP_MODE")}")`);
}

/** Walks up from `start` looking for a checkout root (a dir with fixtures/ and packages/). */
export function findFixturesDir(start: string): string {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "fixtures")) && existsSync(join(dir, "packages"))) return join(dir, "fixtures");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(start, "fixtures");
}

export function loadConfig(env: EnvLike = process.env, cwd: string = process.cwd()): QlooConfig {
  const apiKey = envValue(env, "QLOO_API_KEY") ?? null;
  const allowHost = truthy(envValue(env, "QLOO_ALLOW_HOST"));
  const baseUrl = assertAllowedBaseUrl(envValue(env, "QLOO_BASE_URL") ?? QLOO_DEFAULT_BASE_URL, allowHost);
  const requestedMode = parseMode(env);
  // "recorded" serves stored sheets only: like fixture mode, the client never calls Qloo.
  const mode: QlooMode = requestedMode === "auto" ? (apiKey ? "live" : "fixture") : requestedMode === "recorded" ? "fixture" : requestedMode;
  if (mode === "live" && !apiKey) {
    throw new QlooConfigError("WALKUP_MODE=live needs QLOO_API_KEY; use fixture or auto");
  }
  const floorRaw = envValue(env, "QLOO_MONTH_GUARD_FLOOR");
  const floor = floorRaw !== undefined && Number.isFinite(Number(floorRaw)) ? Number(floorRaw) : DEFAULT_MONTH_GUARD_FLOOR;
  const fixturesEnv = envValue(env, "WALKUP_FIXTURES_DIR");
  return {
    apiKey,
    baseUrl,
    allowHost,
    dataDir: resolve(cwd, envValue(env, "WALKUP_DATA_DIR") ?? "./.cache"),
    fixturesDir: fixturesEnv ? resolve(cwd, fixturesEnv) : findFixturesDir(cwd),
    requestedMode,
    mode,
    record: truthy(envValue(env, "WALKUP_RECORD")),
    monthGuardFloor: floor,
  };
}
