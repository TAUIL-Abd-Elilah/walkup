/**
 * The stdio entry, end to end: spawned with tsx in fixture mode (no keys in
 * its environment), driven by the SDK's stdio client.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { ToolEnvelope } from "../src/index";

const ROOT = resolve(__dirname, "../../..");
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const ENTRY = resolve(__dirname, "../src/stdio.ts");

describe("stdio entry", () => {
  it.skipIf(!existsSync(TSX_CLI))(
    "starts in fixture mode without keys and answers tool calls over stdio",
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), "walkup-mcp-"));
      const stderr: string[] = [];
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [TSX_CLI, ENTRY],
        env: { WALKUP_MODE: "fixture", WALKUP_DATA_DIR: dataDir, WALKUP_URL: "http://localhost:3000" },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (b: Buffer) => stderr.push(b.toString()));
      const client = new Client({ name: "walkup-stdio-test", version: "0.0.0" });
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(["bill_vs_house", "get_sheet", "plan_show", "rank_partners", "revise_plan"]);
        const result = (await client.callTool({ name: "bill_vs_house", arguments: { planId: "g1-b" } })) as CallToolResult;
        const env = result.structuredContent as unknown as ToolEnvelope;
        expect(result.isError).toBeFalsy();
        expect(env.mode).toBe("fixture");
        expect(env.planId).toBe("g1-b");
        expect(env.sheetUrl).toBe("http://localhost:3000/s/g1-b");
        const refused = (await client.callTool({ name: "plan_show", arguments: { presetId: "g5" } })) as CallToolResult;
        expect(refused.isError).toBe(true);
        expect(stderr.join("")).toContain("stdio server ready (fixture mode)");
        // Plans persist in SQLite under the data dir.
        expect(existsSync(join(dataDir, "plans.sqlite"))).toBe(true);
      } finally {
        await client.close();
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    },
    90_000,
  );
});
