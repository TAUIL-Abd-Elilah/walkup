/**
 * Server-only environment helpers: where the app may write (WALKUP_DATA_DIR),
 * where runtime data lives, and key presence. Never returns key values.
 *
 * Every file the server creates goes under dataDir() (/data on the host,
 * ./.cache locally). Nothing is written next to the code.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

export function dataDir(env: Env = process.env): string {
  const raw = (env.WALKUP_DATA_DIR ?? "").trim();
  return resolve(/*turbopackIgnore: true*/ raw || join(process.cwd(), ".cache"));
}

/** Walks up from `start` until `rel` exists (repository layout in dev, /app in the image). */
export function findUp(rel: string, start: string = process.cwd(), maxDepth = 6): string | null {
  let dir = resolve(/*turbopackIgnore: true*/ start);
  for (let i = 0; i <= maxDepth; i++) {
    const p = join(/*turbopackIgnore: true*/ dir, rel);
    if (existsSync(/*turbopackIgnore: true*/ p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let gazetteerChecked = false;

/**
 * The gazetteer package resolves its data from its own source location by
 * default, which the bundler moves. Point it at the repository (dev) or the
 * image copy (/app/data/gazetteer/out) through the variable it already reads.
 */
export function ensureGazetteerDir(env: NodeJS.ProcessEnv = process.env): void {
  if (gazetteerChecked) return;
  gazetteerChecked = true;
  if ((env.WALKUP_GAZETTEER_DIR ?? "").trim()) return;
  const found = findUp(join("data", "gazetteer", "out"));
  if (found) env.WALKUP_GAZETTEER_DIR = found;
}

export function has(env: Env, key: string): boolean {
  return Boolean((env[key] ?? "").trim());
}

export function keyPresence(env: Env = process.env) {
  return {
    qloo: has(env, "QLOO_API_KEY"),
    ticketmaster: has(env, "TICKETMASTER_API_KEY"),
    places: has(env, "GOOGLE_PLACES_API_KEY"),
    anthropic: has(env, "ANTHROPIC_API_KEY") || has(env, "ANTHROPIC_AUTH_TOKEN"),
    resend: has(env, "RESEND_API_KEY") && has(env, "RESEND_FROM"),
    census: has(env, "CENSUS_API_KEY"),
    signingSecret: (env.WALKUP_SIGNING_SECRET ?? "").length >= 32,
    postalAddress: has(env, "WALKUP_POSTAL_ADDRESS"),
  };
}

export function intEnv(env: Env, key: string, fallback: number, min = 0, max = 1_000_000): number {
  const raw = (env[key] ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return n >= min && n <= max ? n : fallback;
}
