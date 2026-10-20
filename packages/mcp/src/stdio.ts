/**
 * stdio entry for local MCP clients (Claude Desktop, Claude Code, OpenClaw):
 *
 *   node <repo>/node_modules/tsx/dist/cli.mjs <repo>/packages/mcp/src/stdio.ts [--unlimited]
 *   npx tsx packages/mcp/src/stdio.ts            (from the repository root)
 *
 * Keys come from the environment (QLOO_API_KEY, TICKETMASTER_API_KEY, ...);
 * without them the server runs in fixture mode on the synthetic world. Plans go
 * to WALKUP_DATA_DIR (default: <repo>/.cache). WALKUP_URL, when set,
 * is the web app that serves share links (/s/<planId>) from the same data dir.
 * --unlimited lifts the fresh-run caps (only for a server on your own keys).
 */
import { fileURLToPath } from "node:url";

// stdout carries the protocol: route every console line to stderr before anything else loads.
const toStderr = (...args: unknown[]) => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

async function main(): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createServicesFromEnv, createWalkupMcpServer, createUnlimitedFreshRunLimiter } = await import("./index");
  const unlimited = process.argv.slice(2).includes("--unlimited");
  const repoCache = fileURLToPath(new URL("../../../.cache", import.meta.url));
  const services = createServicesFromEnv(process.env, {
    dataDirFallback: repoCache,
    // Fixture runs on the synthetic world cost nothing; live runs keep the caps unless --unlimited.
    policy: { fixtureEventRuns: true, capFixtureRuns: false },
    ...(unlimited ? { limiter: createUnlimitedFreshRunLimiter() } : {}),
    onWarning: (m) => process.stderr.write(`walkup-mcp: ${m}\n`),
  });
  const origin = process.env.WALKUP_URL?.trim().replace(/\/+$/, "") || null;
  const server = createWalkupMcpServer(services, { ip: "stdio", origin, transport: "stdio" });
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await server.close().catch(() => {});
    services.close?.();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  transport.onclose = () => {
    services.close?.();
  };
  await server.connect(transport);
  process.stderr.write(`walkup-mcp: stdio server ready (${services.mode} mode${unlimited ? ", no fresh-run caps" : ""})\n`);
}

main().catch((err) => {
  process.stderr.write(`walkup-mcp: failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
