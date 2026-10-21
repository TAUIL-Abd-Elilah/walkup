import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// `npm run dev` runs `next dev` in apps/web, and Next.js reads .env files from there only. The README
// tells you to keep keys in the repository root .env, so the dev server loads that file too. Variables
// already set (your shell, apps/web/.env*) win. Builds and the Docker image never read it: the image
// gets its keys from Fly secrets at runtime.
function loadRootEnvForDev(): void {
  const file = resolve(/*turbopackIgnore: true*/ process.cwd(), "..", "..", ".env");
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    console.warn("warning: could not read the repository root .env; using the process environment only");
  }
}

const nextConfig: NextConfig = {
  // The Dockerfile runs apps/web/.next/standalone/apps/web/server.js.
  output: "standalone",
  // Workspace packages ship raw TypeScript. Every one the app imports, directly or through another, is listed.
  // Server-only packages (qloo, orchestrator, qloo-world, tm, acs, gazetteer, narrator, exports, send, mcp)
  // are imported from route handlers, server components and lib/server only, never from client components.
  transpilePackages: [
    "@walkup/contracts",
    "@walkup/engine",
    "@walkup/qloo",
    "@walkup/qloo-world",
    "@walkup/tm",
    "@walkup/acs",
    "@walkup/gazetteer",
    "@walkup/narrator",
    "@walkup/orchestrator",
    "@walkup/exports",
    "@walkup/send",
    "@walkup/mcp",
  ],
  // Native module (and the PDF renderer, which loads fonts from its package at runtime): required from
  // node_modules at runtime, never bundled. The image copies the Linux better-sqlite3 binary.
  serverExternalPackages: ["better-sqlite3", "@react-pdf/renderer"],
  // The orchestrator reads config/tags.json and the gazetteer its data directory from computed paths
  // (WALKUP_TAGS_FILE and WALKUP_GAZETTEER_DIR win at runtime), so the tracer would copy the whole
  // repository into the standalone output. Keep private and runtime data out of it (raw API bodies,
  // private tables, local SQLite and caches); the image copies data/gazetteer/out, config and
  // fixtures/synthetic itself.
  outputFileTracingExcludes: {
    "*": [
      "../../fixtures/raw/**",
      "../../data/private/**",
      "../../evals/**",
      "../../docs/**",
      "../../probe_out/**",
      "../../skills/**",
      "../../scripts/**",
      "../../packages/*/test/**",
      "../../.cache/**",
      "./.cache/**",
      "../../**/*.sqlite",
      "../../**/*.sqlite-*",
      "../../.git/**",
    ],
  },
  // On Vercel (docs/deploy-vercel.md) nothing is copied next to the server the way the Docker image does, so the
  // runtime data the server reads from computed paths is traced in: the gazetteer, the tag pins, the synthetic
  // sheets, the recorded-sheet export that WALKUP_PLAN_SEED names (git-ignored, shipped with the deploy only) and
  // better-sqlite3's Linux binary (loaded by a computed path, so the tracer misses it).
  ...(process.env.VERCEL
    ? {
        outputFileTracingIncludes: {
          "*": [
            "../../data/gazetteer/out/**",
            "../../config/*.json",
            "../../fixtures/synthetic/**",
            "../../deploy/vercel/plans.json",
            "../../node_modules/better-sqlite3/prebuilds/linux-x64.node",
          ],
        },
      }
    : {}),
  reactStrictMode: true,
  poweredByHeader: false,
  // Do not write an AGENTS.md into the app directory during `next dev`.
  agentRules: false,
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) loadRootEnvForDev();
  return nextConfig;
}
