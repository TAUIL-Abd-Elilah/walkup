/**
 * Launcher for the sealed P1 runner (evals/p1/run_arms.ts) with one transport fix, logged in
 * docs/preregistration/p1-deviations.md (2026-10-22 row on /search filter.location).
 *
 * The sealed runner sends `filter.location=POINT(<lon> <lat>)` to Qloo `/search` (ARMS.md §1).
 * The hackathon host answers HTTP 400 "filter.location must be in the form lat,lon". This
 * launcher rewrites that one parameter, on Qloo `/search` requests only, to `<lat>,<lon>` with
 * the same coordinates. Nothing else changes: the radius, the query, the take, every threshold,
 * the cache keys (they are built from the sealed request before this rewrite) and every other
 * request (insights, tags, entities, Census) pass through untouched. Every sealed file stays
 * byte-identical (`sha256sum -c docs/preregistration/p1-code.sha256`).
 *
 *   npx tsx evals/p1/run_arms_latlon.ts <same flags as run_arms.ts>
 */
import { main } from "./run_arms";

const WKT = /^\s*POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)\s*$/i;

/** Returns the URL with a WKT filter.location on /search rewritten to "lat,lon", or null when untouched. */
export function rewriteSearchLocation(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!u.hostname.endsWith("qloo.com") || u.pathname !== "/search") return null;
  const loc = u.searchParams.get("filter.location");
  const m = loc === null ? null : WKT.exec(loc);
  if (!m) return null;
  const [, lon, lat] = m;
  u.searchParams.set("filter.location", `${lat},${lon}`);
  return u.toString();
}

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  if (typeof input === "string" || input instanceof URL) {
    const next = rewriteSearchLocation(String(input));
    if (next !== null) return realFetch(next, init);
  }
  return realFetch(input, init);
}) as typeof fetch;

// Self-check before any call: the rewrite keeps the coordinates and swaps only their format.
{
  const probe = "https://hackathon.api.qloo.com/search?query=x&filter.location=POINT%28-95.407774+29.742706%29&filter.radius=1";
  const out = rewriteSearchLocation(probe);
  if (out === null || new URL(out).searchParams.get("filter.location") !== "29.742706,-95.407774" || new URL(out).searchParams.get("filter.radius") !== "1") {
    console.error("run_arms_latlon: self-check failed; nothing was sent");
    process.exit(1);
  }
  if (rewriteSearchLocation("https://hackathon.api.qloo.com/v2/insights?filter.location=POINT%28-95.4+29.7%29") !== null) {
    console.error("run_arms_latlon: self-check failed (insights must pass through); nothing was sent");
    process.exit(1);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
