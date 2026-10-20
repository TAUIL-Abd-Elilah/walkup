/**
 * An agent using Walkup over MCP (`npm run agent:demo`): connects to a Walkup
 * server's /mcp endpoint (WALKUP_URL, default the hosted site), hands its tools
 * to Claude through OpenRouter (OPENROUTER_API_KEY from .env), and lets the
 * model work a promoter's request. Every tool call and a short view of each
 * result is printed as it happens; --transcript=path also writes them as JSON
 * lines with timings (for a screen recording).
 *
 * The task: plan the street team for a preset show, make the plan all ages with
 * no bars, then fetch the final sheet. A preset is served from its stored run;
 * the revision is a fresh run that counts against the server's caps.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = process.env["OPENROUTER_MODEL"]?.trim() || "anthropic/claude-haiku-5.5";
const MAX_TURNS = 8;
const TASK =
  "I promote FLO's show at The Anthem in Washington DC (Walkup preset g1-b). Plan where my street team should go. " +
  'Then change the plan to "All ages, no bars" and fetch the final sheet with get_sheet. Tell me in three short lines where to start and what changed.';

function loadDotEnv(): void {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  try {
    process.loadEnvFile(p);
  } catch {
    console.error("warning: could not read .env; using the process environment only");
  }
}

interface Line {
  t: number;
  kind: "task" | "call" | "result" | "answer" | "info";
  text: string;
}

const t0 = Date.now();
let transcript: string | null = null;

function say(kind: Line["kind"], text: string): void {
  const prefix = { task: "you    ", call: "agent →", result: "walkup ←", answer: "agent  ", info: "       " }[kind];
  for (const [i, l] of text.split("\n").entries()) console.log(`${i === 0 ? prefix : " ".repeat(prefix.length)} ${l}`);
  if (transcript) appendFileSync(transcript, `${JSON.stringify({ t: Date.now() - t0, kind, text } satisfies Line)}\n`);
}

/** A short view of a tool result: the envelope's status, summary and the first lines of its text. */
function brief(result: { content?: unknown; structuredContent?: unknown; isError?: boolean }): string {
  const env = (result.structuredContent ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof env["status"] === "string") parts.push(`status ${env["status"]}${typeof env["planId"] === "string" ? ` · plan ${String(env["planId"]).slice(0, 8)}` : ""}`);
  if (typeof env["summary"] === "string") parts.push(String(env["summary"]));
  if (parts.length === 0) {
    const text = (Array.isArray(result.content) ? result.content : []).map((c) => (c as { text?: string }).text ?? "").join("\n");
    parts.push(text.split("\n").slice(0, 4).join("\n"));
  }
  return parts.join("\n").slice(0, 600);
}

async function main(): Promise<number> {
  loadDotEnv();
  const arg = process.argv.find((a) => a.startsWith("--transcript="));
  if (arg) {
    transcript = arg.slice("--transcript=".length);
    writeFileSync(transcript, "");
  }
  const key = process.env["OPENROUTER_API_KEY"]?.trim();
  if (!key) {
    console.error("OPENROUTER_API_KEY is not set.");
    return 2;
  }
  const base = (process.env["WALKUP_URL"]?.trim() || "https://walkup-agent.fly.dev").replace(/\/+$/, "");
  const client = new Client({ name: "walkup-agent-demo", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const { tools } = await client.listTools();
  say("info", `connected to ${base}/mcp · tools: ${tools.map((t) => t.name).join(", ")} · model ${MODEL}`);

  const fnTools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema } }));
  type Msg = Record<string, unknown>;
  const messages: Msg[] = [
    { role: "system", content: "You are a promoter's assistant. Use the Walkup tools to answer; never invent places or numbers. Keep the final answer to three short lines of plain text, no markdown." },
    { role: "user", content: TASK },
  ];
  say("task", TASK);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages, tools: fnTools, tool_choice: "auto" }),
    });
    if (!res.ok) {
      console.error(`OpenRouter answered ${res.status}`);
      return 1;
    }
    const body = (await res.json()) as { choices: { message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    const msg = body.choices[0]!.message;
    messages.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    if (!msg.tool_calls?.length) {
      say("answer", (msg.content ?? "").trim());
      await client.close();
      return 0;
    }
    for (const call of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      say("call", `${call.function.name} ${JSON.stringify(args)}`);
      const result = (await client.callTool({ name: call.function.name, arguments: args })) as { content?: unknown; structuredContent?: unknown; isError?: boolean };
      say("result", brief(result));
      const text = (Array.isArray(result.content) ? result.content : []).map((c) => (c as { text?: string }).text ?? "").join("\n");
      messages.push({ role: "tool", tool_call_id: call.id, content: text.slice(0, 12000) });
    }
  }
  say("info", `stopped after ${MAX_TURNS} turns`);
  await client.close();
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
