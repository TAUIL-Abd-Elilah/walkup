/**
 * Streamable HTTP in stateless mode, on Web-standard Request/Response (a Next
 * route handler, or any fetch-style server). Each POST gets its own server and
 * transport bound to the caller's address; responses are plain JSON. GET,
 * DELETE and every other method answer the same JSON-RPC 405 (Allow: POST):
 * there is no session to stream to or to end.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { callerKey, clientIpFrom } from "./limits";
import { createWalkupMcpServer } from "./server";
import type { McpServices } from "./services";

/** Tool inputs are small; anything larger is refused before parsing. */
export const MAX_MCP_BODY_BYTES = 64 * 1024;

type HeaderBag = { get(name: string): string | null };

export interface HttpHandlerOptions {
  /** Public origin for share links. Default: the request's own origin. */
  origin?: string | null;
  /** How the host reads the caller's address (so REST and MCP share one key per caller). Default: clientIpFrom. */
  clientIp?: (headers: HeaderBag) => string | null;
}

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Browsers send Origin; a page on another site must not drive this server (MCP transport guidance). */
function crossSite(req: Request, self: string | null): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    return host !== new URL(req.url).host && (!self || host !== new URL(self).host);
  } catch {
    return true;
  }
}

export async function handleMcpHttpRequest(req: Request, services: McpServices, opts: HttpHandlerOptions = {}): Promise<Response> {
  // GET, DELETE, PUT, PATCH and the rest: one JSON-RPC 405 that says what to send instead.
  if (req.method !== "POST") return rpcError(405, -32000, "Method not allowed: this MCP server is stateless; send JSON-RPC with POST.", { allow: "POST" });
  const origin = opts.origin === undefined ? new URL(req.url).origin : opts.origin;
  if (crossSite(req, origin)) return rpcError(403, -32000, "Forbidden: cross-site requests are not accepted.");

  const ip = (opts.clientIp ? opts.clientIp(req.headers) : clientIpFrom(req.headers)) ?? "unknown";
  if (services.rate && !services.rate.hit(callerKey(ip), services.now())) {
    return rpcError(429, -32000, "Too many requests: slow down and retry in a minute.", { "retry-after": "60" });
  }

  const server = createWalkupMcpServer(services, { ip, origin, transport: "http" });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
  });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    const headers = new Headers(res.headers);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  } finally {
    // JSON mode: the response is complete once handleRequest resolves.
    await server.close().catch(() => {});
  }
}
