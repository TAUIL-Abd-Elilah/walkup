/**
 * Serves MapLibre's web worker from our own origin. maplibre-gl v6 resolves the
 * worker next to its own module URL, which a bundler moves; we point
 * setWorkerUrl() here instead. Generated once at build time.
 *
 * Looked up next to the working directory (app-local or hoisted node_modules),
 * then in every folder above this module, so `next dev apps/web` started from
 * another directory still finds it.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const dynamic = "force-static";

const WORKER = ["node_modules", "maplibre-gl", "dist", "maplibre-gl-worker.mjs"];

function candidates(): string[] {
  const out = [join(/*turbopackIgnore: true*/ process.cwd(), ...WORKER), join(/*turbopackIgnore: true*/ process.cwd(), "..", "..", ...WORKER)];
  try {
    let dir = dirname(/*turbopackIgnore: true*/ fileURLToPath(import.meta.url));
    for (let i = 0; i < 12; i++) {
      out.push(join(/*turbopackIgnore: true*/ dir, ...WORKER));
      const up = dirname(/*turbopackIgnore: true*/ dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    // import.meta.url is not a file URL in this bundle: the working-directory candidates stand.
  }
  return out;
}

export async function GET(): Promise<Response> {
  for (const file of candidates()) {
    try {
      // Runs once at build time (force-static); no need to trace the project for it.
      const body = await readFile(/*turbopackIgnore: true*/ file, "utf8");
      return new Response(body, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      // try the next location
    }
  }
  return new Response("// maplibre-gl worker not found", { status: 404, headers: { "content-type": "text/javascript" } });
}
