/**
 * Test helpers: fixture services with a fixed clock and counter plan ids, and
 * an MCP client connected in memory. Nothing reaches the network.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createFixtureServices, createWalkupMcpServer, createMemoryFreshRunLimiter, type Caller, type FixtureServicesOptions, type McpServices, type ToolEnvelope } from "../src/index";

export const CLOCK_MS = Date.parse("2026-10-30T15:00:00Z");
export const ORIGIN = "https://walkup.example";

export function counterIds(prefix = "plan"): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** Fixture services with their own limiter (never the process-wide one) and no burst guard. */
export function services(o: FixtureServicesOptions = {}): McpServices {
  return createFixtureServices({
    clock: () => CLOCK_MS,
    idGen: counterIds(),
    limiter: createMemoryFreshRunLimiter(),
    rate: null,
    secrets: [],
    ...o,
  });
}

export function caller(ip = "203.0.113.5"): Caller {
  return { ip, origin: ORIGIN, transport: "memory" };
}

export interface Connected {
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<{ result: CallToolResult; env: ToolEnvelope; text: string }>;
  close(): Promise<void>;
}

/** A client and server linked in memory; tools are listed first so the client validates structuredContent. */
export async function connect(s: McpServices, who: Caller = caller()): Promise<Connected> {
  const server = createWalkupMcpServer(s, who);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "walkup-test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await client.listTools();
  return {
    client,
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      return { result, env: result.structuredContent as unknown as ToolEnvelope, text };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
