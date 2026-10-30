/** Round 8: OPTIONS answers 204 and every 405 lists the same methods (Allow: POST, OPTIONS). */
import { describe, expect, it } from "vitest";
import { handleMcpHttpRequest, MCP_ALLOW } from "../src/index";
import type { McpServices } from "../src/services";

const URL_MCP = "https://walkup.example/mcp";
// Neither answer reaches the services.
const services = {} as McpServices;

describe("/mcp Allow header", () => {
  it("is the same on OPTIONS and on a 405", async () => {
    expect(MCP_ALLOW).toBe("POST, OPTIONS");
    const opts = await handleMcpHttpRequest(new Request(URL_MCP, { method: "OPTIONS" }), services);
    expect(opts.status).toBe(204);
    expect(opts.headers.get("allow")).toBe(MCP_ALLOW);
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await handleMcpHttpRequest(new Request(URL_MCP, { method, ...(method === "PUT" ? { body: "{}" } : {}) }), services);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe(MCP_ALLOW);
    }
  });
});
