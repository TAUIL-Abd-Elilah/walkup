/**
 * Streamable HTTP (stateless) through the SDK's own HTTP client, with fetch
 * routed straight into handleMcpHttpRequest: the same path the Next route uses.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createMemoryFreshRunLimiter, createRequestRateLimiter, handleMcpHttpRequest, type McpServices, type ToolEnvelope } from "../src/index";
import { services } from "./helpers";

const URL_MCP = "https://walkup.example/mcp";

async function httpClient(s: McpServices, headers: Record<string, string> = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), {
    fetch: (input, init) => handleMcpHttpRequest(new Request(input, init), s),
    requestInit: { headers },
  });
  const client = new Client({ name: "walkup-http-test", version: "0.0.0" });
  await client.connect(transport);
  await client.listTools();
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ result: CallToolResult; env: ToolEnvelope }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { result, env: result.structuredContent as unknown as ToolEnvelope };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Streamable HTTP", () => {
  it("initializes, lists the tools and returns envelopes with share links on the request's origin", async () => {
    const s = services();
    const client = await httpClient(s);
    try {
      expect(client.getServerVersion()?.name).toBe("walkup");
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(5);
      const { env, result } = await call(client, "get_sheet", { planId: "g3" });
      expect(result.isError).toBeFalsy();
      expect(env.planId).toBe("g3");
      expect(env.sheetUrl).toBe("https://walkup.example/s/g3");
      expect(env.mode).toBe("fixture");
      const refused = await call(client, "plan_show", { presetId: "nope" });
      expect(refused.result.isError).toBe(true);
      expect(refused.env.reason).toMatch(/Unknown preset/);
    } finally {
      await client.close();
    }
  });

  it("keys caps on the caller's address from the proxy headers", async () => {
    const s = services({ limiter: createMemoryFreshRunLimiter({ perCallerPerDay: 1, perDay: 10 }) });
    const a = await httpClient(s, { "fly-client-ip": "198.51.100.1", "x-forwarded-for": "10.0.0.1" });
    const a2 = await httpClient(s, { "x-forwarded-for": "10.9.9.9, 198.51.100.1" });
    const b = await httpClient(s, { "fly-client-ip": "198.51.100.2" });
    try {
      const first = await call(a, "plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" });
      expect(first.env.freshRuns?.leftForCaller).toBe(0);
      // Same address seen through X-Forwarded-For's last hop: same bucket.
      const again = await call(a2, "plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" });
      expect(again.env.reason).toMatch(/^limit reached/);
      const other = await call(b, "plan_show", { event: "Hollis Creek String Band @ The Truth, Nov 20 2026" });
      expect(other.env.status).not.toBe("error");
    } finally {
      await Promise.all([a.close(), a2.close(), b.close()]);
    }
  });

  it("answers 405 to GET and DELETE (stateless), 403 to cross-site browsers, 429 to bursts", async () => {
    const s = services();
    const get = await handleMcpHttpRequest(new Request(URL_MCP, { method: "GET", headers: { accept: "text/event-stream" } }), s);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, OPTIONS");
    const del = await handleMcpHttpRequest(new Request(URL_MCP, { method: "DELETE" }), s);
    expect(del.status).toBe(405);
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const cross = await handleMcpHttpRequest(post(init, { origin: "https://evil.example" }), s);
    expect(cross.status).toBe(403);
    const same = await handleMcpHttpRequest(post(init, { origin: "https://walkup.example" }), s);
    expect(same.status).toBe(200);
    const body = (await same.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("walkup");
    expect(same.headers.get("mcp-session-id")).toBeNull();

    const limited = services({ rate: createRequestRateLimiter(2) });
    expect((await handleMcpHttpRequest(post(init), limited)).status).toBe(200);
    expect((await handleMcpHttpRequest(post(init), limited)).status).toBe(200);
    const third = await handleMcpHttpRequest(post(init), limited);
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("60");
  });

  it("calls a tool in one stateless POST and refuses oversized bodies and bad Accept headers", async () => {
    const s = services();
    const res = await handleMcpHttpRequest(
      post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_sheet", arguments: { planId: "g1-b" } } }, { "mcp-protocol-version": "2025-06-18" }),
      s,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as { id: number; result: CallToolResult };
    expect(body.id).toBe(7);
    expect((body.result.structuredContent as unknown as ToolEnvelope).planId).toBe("g1-b");

    const big = await handleMcpHttpRequest(post({ jsonrpc: "2.0", id: 8, method: "tools/list", params: { pad: "x".repeat(70_000) } }), s);
    expect(big.status).toBe(413);
    const noAccept = await handleMcpHttpRequest(
      new Request(URL_MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }),
      s,
    );
    expect(noAccept.status).toBe(406);
  });
});
