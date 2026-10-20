import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Dockerfile runs apps/web/.next/standalone/apps/web/server.js.
  output: "standalone",
  // Workspace packages ship raw TypeScript. Every one the app imports, directly or through another, is listed.
  // Server-only packages (qloo, orchestrator, qloo-world, tm, places, acs, gazetteer, narrator, exports, send, mcp)
  // are imported from route handlers, server components and lib/server only, never from client components.
  transpilePackages: [
    "@walkup/contracts",
    "@walkup/engine",
    "@walkup/qloo",
    "@walkup/qloo-world",
    "@walkup/tm",
    "@walkup/places",
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
  reactStrictMode: true,
  poweredByHeader: false,
  // Do not write an AGENTS.md into the app directory during `next dev`.
  agentRules: false,
};

export default nextConfig;
