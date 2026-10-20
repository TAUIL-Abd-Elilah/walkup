/**
 * The OpenRouter transport against a fake fetch (no network): provider choice,
 * request and response translation, the tool loop with is_error, narration and
 * revisions end to end, retries, and the ledger. Synthetic names only.
 */
import type { BetaMessageParam, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createMemoryLedger } from "@walkup/contracts";
import { DEFAULT_BAR_CATEGORIES } from "@walkup/engine";
import { describe, expect, it } from "vitest";
import {
  buildReviseRequest,
  createNarratorClient,
  createOpenRouterClient,
  estimateCostUsd,
  fromChatResponse,
  llmProvider,
  narrate,
  OPENROUTER_MODEL,
  readRevision,
  stopReasonOf,
  toChatRequest,
  type ChatRequest,
  type ChatResponse,
  type ReviseSummary,
} from "../src/index";
import { makeInput } from "./helpers";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: ChatRequest;
}

type Reply = { status?: number; body: unknown } | Error;

/** A fetch that answers from `script` in order and records every request. */
function fakeFetch(script: Reply[]) {
  const sent: Sent[] = [];
  let i = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as ChatRequest });
    const step = script[Math.min(i, script.length - 1)]!;
    i += 1;
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body), { status: step.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, sent };
}

function chat(message: Record<string, unknown>, finish = "stop", usage: Record<string, unknown> = {}): ChatResponse {
  return {
    id: "gen-test",
    model: OPENROUTER_MODEL,
    choices: [{ finish_reason: finish, native_finish_reason: null, message: { ...message } }],
    usage: { prompt_tokens: 1000, completion_tokens: 500, ...usage },
  } as ChatResponse;
}

function toolCall(id: string, name: string, args: unknown) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function client(script: Reply[]) {
  const f = fakeFetch(script);
  return { client: createOpenRouterClient({ apiKey: "placeholder-not-a-key", fetch: f.fetch, backoffMs: () => 0 }), sent: f.sent };
}

function summary(): ReviseSummary {
  const cats = ["bar", "restaurant", "cafe", "record_store", ...DEFAULT_BAR_CATEGORIES];
  return {
    show: { acts: ["Test Headliner"], venue: "Sample Hall", city: "Exampleton", date: "2026-11-28", weekday: "saturday", agePolicy: "21+" },
    settings: { allAges: false, streetTeamDays: ["thursday", "saturday"], radiusKm: 40, excludeCategories: [], excludeAreas: [] },
    areas: [
      { name: "North Example", geohash: "dn6m9q", partners: 6 },
      { name: "West Example", geohash: "dn6m9r", partners: 5 },
    ],
    categories: [...new Set(cats)].map((key) => ({ key, partners: key === "bar" ? 4 : 1, spots: 0 })),
    partners: 11,
    spots: 4,
  };
}

describe("provider choice", () => {
  it("OpenRouter when its key is set, Anthropic otherwise, none without keys", () => {
    expect(llmProvider({})).toBeNull();
    expect(llmProvider({ ANTHROPIC_API_KEY: "a" })).toBe("anthropic");
    expect(llmProvider({ OPENROUTER_API_KEY: "o" })).toBe("openrouter");
    expect(llmProvider({ OPENROUTER_API_KEY: "o", ANTHROPIC_API_KEY: "a" })).toBe("openrouter");
    expect(llmProvider({ OPENROUTER_API_KEY: "o", ANTHROPIC_API_KEY: "a", WALKUP_LLM_PROVIDER: "anthropic" })).toBe("anthropic");
    expect(llmProvider({ OPENROUTER_API_KEY: "  " })).toBeNull();
  });

  it("builds the matching client without calling any API", () => {
    expect(createNarratorClient({})).toBeNull();
    const or = createNarratorClient({ OPENROUTER_API_KEY: "placeholder-not-a-key", OPENROUTER_MODEL: "anthropic/claude-test" });
    expect(or?.provider).toBe("openrouter");
    expect(or?.model).toBe("anthropic/claude-test");
    expect(createNarratorClient({ OPENROUTER_API_KEY: "placeholder-not-a-key" })?.model).toBe(OPENROUTER_MODEL);
    const an = createNarratorClient({ ANTHROPIC_API_KEY: "placeholder-not-a-key" });
    expect(an?.provider).toBeUndefined();
    expect(typeof an?.beta.messages.create).toBe("function");
  });
});

describe("request translation", () => {
  const params = buildReviseRequest(summary(), [{ role: "user", content: "<note>no bars</note>" }]);

  it("keeps the system cache marker, strict tools, auto choice and effort; drops the fallback beta", () => {
    const req = toChatRequest(params, "anthropic/claude-test");
    expect(req.model).toBe("anthropic/claude-test");
    expect(req.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: expect.any(String), cache_control: { type: "ephemeral" } }] });
    expect(req.messages[1]).toEqual({ role: "user", content: "<note>no bars</note>" });
    expect(req.tools?.map((t) => t.function.name)).toContain("set_all_ages");
    expect(req.tools?.every((t) => t.function.strict === true && t.type === "function")).toBe(true);
    expect(req.tool_choice).toBe("auto");
    expect(req.verbosity).toBe("medium");
    expect(req.provider).toEqual({ require_parameters: true });
    expect(JSON.stringify(req)).not.toContain("server-side-fallback");
    expect(req).not.toHaveProperty("fallbacks");
    expect(req).not.toHaveProperty("response_format");
  });

  it("sends a json_schema output format as a strict response_format", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: false };
    const p: MessageCreateParamsNonStreaming = {
      model: "claude-opus-5-5",
      max_tokens: 100,
      messages: [{ role: "user", content: "x" }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    };
    const req = toChatRequest(p, OPENROUTER_MODEL);
    expect(req.response_format).toEqual({ type: "json_schema", json_schema: { name: "output", strict: true, schema } });
    expect(req.verbosity).toBe("low");
    expect(req.tools).toBeUndefined();
  });

  it("turns tool turns into tool_calls and tool messages, errors marked, text after the results", () => {
    const messages: BetaMessageParam[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "s" },
          { type: "text", text: "Searching." },
          { type: "tool_use", id: "tu1", name: "places_search", input: { query: "record store" } },
          { type: "tool_use", id: "tu2", name: "acs_lookup", input: { zcta: "00000" } },
        ] as never,
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: '{"places":[]}' },
          { type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: "unknown zcta" }], is_error: true },
          { type: "text", text: "Last turn: submit now." },
        ],
      },
    ];
    const req = toChatRequest({ model: "m", max_tokens: 10, messages }, "m", (id) => (id === "tu1" ? [{ type: "reasoning.encrypted", data: "x" }] : undefined));
    expect(req.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Searching.",
        tool_calls: [
          { id: "tu1", type: "function", function: { name: "places_search", arguments: '{"query":"record store"}' } },
          { id: "tu2", type: "function", function: { name: "acs_lookup", arguments: '{"zcta":"00000"}' } },
        ],
        reasoning_details: [{ type: "reasoning.encrypted", data: "x" }],
      },
      { role: "tool", tool_call_id: "tu1", content: '{"places":[]}' },
      { role: "tool", tool_call_id: "tu2", content: "Error: unknown zcta" },
      { role: "user", content: [{ type: "text", text: "Last turn: submit now." }] },
    ]);
  });
});

describe("response translation", () => {
  it("maps finish reasons, preferring Anthropic's own stop reason", () => {
    expect(stopReasonOf("stop", null)).toBe("end_turn");
    expect(stopReasonOf("tool_calls", null)).toBe("tool_use");
    expect(stopReasonOf("length", null)).toBe("max_tokens");
    expect(stopReasonOf("content_filter", null)).toBe("refusal");
    expect(stopReasonOf("stop", "refusal")).toBe("refusal");
    expect(stopReasonOf("error", "something_else")).toBeNull();
  });

  it("builds text and tool_use blocks and a Messages usage block", () => {
    const { message } = fromChatResponse(
      chat({ content: "ok", tool_calls: [toolCall("c1", "set_radius", { km: 10 }), { id: "c2", type: "function", function: { name: "x", arguments: "{bad" } }] }, "stop", {
        prompt_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 150, cache_write_tokens: 50 },
      }),
      "m",
    );
    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      { type: "text", text: "ok", citations: null },
      { type: "tool_use", id: "c1", name: "set_radius", input: { km: 10 }, caller: { type: "direct" } },
      { type: "tool_use", id: "c2", name: "x", input: { _unparsed_arguments: "{bad" }, caller: { type: "direct" } },
    ]);
    expect(message.usage).toMatchObject({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 150, cache_creation_input_tokens: 50 });
    expect(message.model).toBe(OPENROUTER_MODEL);
  });

  it("treats a refusal field as a refusal", () => {
    expect(fromChatResponse(chat({ content: null, refusal: "no" }), "m").message.stop_reason).toBe("refusal");
  });

  it("prices the OpenRouter slug at the Anthropic rates", () => {
    const usage = { input_tokens: 1000, output_tokens: 500 };
    expect(estimateCostUsd(usage, OPENROUTER_MODEL)).toBeCloseTo(estimateCostUsd(usage, "claude-opus-5-5"), 12);
  });
});

describe("through the narrator", () => {
  it("narration: schema-bound request, parsed answer, ledger names OpenRouter", async () => {
    const draft = {
      summary: "This bill's fans over-index most in North Example, at 1.84x the house crowd.",
      tileWhy: [],
      partnerLines: [],
      copyHooks: [],
    };
    const { client: c, sent } = client([{ body: chat({ content: JSON.stringify(draft) }) }]);
    const ledger = createMemoryLedger();
    const res = await narrate(makeInput(), { client: c, ledger });
    expect(res.templated).toBe(false);
    expect(res.summary).toBe(draft.summary);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0]!.headers["authorization"]).toBe("Bearer placeholder-not-a-key");
    expect(sent[0]!.body.response_format?.type).toBe("json_schema");
    const entry = ledger.entries()[0]!;
    expect(entry).toMatchObject({ id: "L1", kind: "anthropic", endpoint: "/api/v1/chat/completions", httpStatus: 200 });
    expect(entry.params).toMatchObject({ provider: "openrouter", model: OPENROUTER_MODEL, effort: "low", format: "json_schema" });
    expect(entry.curl).toContain("$OPENROUTER_API_KEY");
    expect(entry.curl).not.toContain("placeholder-not-a-key");
  });

  it("narration falls back to the template on a refusal and on an HTTP error", async () => {
    const refused = client([{ body: chat({ content: "" }, "content_filter") }]);
    expect((await narrate(makeInput(), { client: refused.client })).templateReason).toBe("refusal");
    const failed = client([{ status: 400, body: { error: { message: "bad param", code: 400 } } }]);
    const ledger = createMemoryLedger();
    const res = await narrate(makeInput(), { client: failed.client, ledger });
    expect(res.templateReason).toBe("api_error");
    expect(failed.sent).toHaveLength(1);
    expect(ledger.entries()[0]).toMatchObject({ httpStatus: 400, envelopeStatus: "error" });
    expect(ledger.entries()[0]!.note).toContain("bad param");
  });

  it("revise: parallel tool calls in one turn become the merged change list", async () => {
    const s = summary();
    const bars = DEFAULT_BAR_CATEGORIES.filter((k) => s.categories.some((c) => c.key === k));
    const { client: c, sent } = client([
      {
        body: chat(
          { content: null, tool_calls: [toolCall("c1", "set_all_ages", { allAges: true }), toolCall("c2", "exclude_partner_categories", { categories: bars })] },
          "tool_calls",
        ),
      },
    ]);
    const read = await readRevision(s, "All ages, no bars", { client: c });
    expect(read.interpreter).toBe("model");
    expect(read.question).toBeNull();
    expect(read.calls).toEqual([
      { tool: "set_all_ages", input: { allAges: true } },
      { tool: "exclude_partner_categories", input: { categories: bars } },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.tools?.length).toBe(6);
  });

  it("revise: an invalid call goes back as an error tool message and the fix is used", async () => {
    const { client: c, sent } = client([
      { body: chat({ content: null, tool_calls: [toolCall("c1", "exclude_areas", { areas: ["Nowhere"] })] }, "tool_calls") },
      { body: chat({ content: null, tool_calls: [toolCall("c2", "exclude_areas", { areas: ["West Example"] })] }, "tool_calls") },
    ]);
    const read = await readRevision(summary(), "skip the west", { client: c });
    expect(read.calls).toEqual([{ tool: "exclude_areas", input: { areas: ["West Example"] } }]);
    const second = sent[1]!.body.messages;
    const tool = second.find((m) => m.role === "tool");
    expect(tool).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect((tool as { content: string }).content.startsWith("Error: ")).toBe(true);
    const assistant = second.find((m) => m.role === "assistant") as { tool_calls: unknown[] };
    expect(assistant.tool_calls).toHaveLength(1);
  });

  it("echoes returned reasoning on the next turn of a tool loop", async () => {
    const reasoning = [{ type: "reasoning.encrypted", data: "opaque", id: "r1" }];
    const { client: c, sent } = client([
      { body: chat({ content: null, reasoning_details: reasoning, tool_calls: [toolCall("c1", "exclude_areas", { areas: ["Nowhere"] })] }, "tool_calls") },
      { body: chat({ content: null, tool_calls: [toolCall("c2", "set_radius", { km: 10 })] }, "tool_calls") },
    ]);
    await readRevision(summary(), "within 10 km", { client: c });
    const assistant = sent[1]!.body.messages.find((m) => m.role === "assistant") as { reasoning_details?: unknown };
    expect(assistant.reasoning_details).toEqual(reasoning);
  });

  it("revise: falls back to the rules when OpenRouter keeps failing", async () => {
    const { client: c, sent } = client([{ status: 503, body: { error: { message: "upstream" } } }]);
    const read = await readRevision(summary(), "All ages, no bars", { client: c });
    expect(read.interpreter).toBe("rules");
    expect(read.fallback).toBe("api_error");
    expect(sent).toHaveLength(3); // first try + 2 retries
  });
});

describe("transport", () => {
  it("retries 429 and network errors, then succeeds", async () => {
    const { client: c, sent } = client([
      { status: 429, body: { error: { message: "rate limited" } } },
      new TypeError("fetch failed"),
      { body: chat({ content: "hi" }) },
    ]);
    const msg = await c.beta.messages.create({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }] });
    expect(msg.content[0]).toMatchObject({ type: "text", text: "hi" });
    expect(sent).toHaveLength(3);
  });

  it("does not retry a 400, and surfaces an error body sent with 200", async () => {
    const bad = client([{ status: 400, body: { error: { message: "nope" } } }]);
    await expect(bad.client.beta.messages.create({ model: "m", max_tokens: 10, messages: [] })).rejects.toMatchObject({ status: 400 });
    expect(bad.sent).toHaveLength(1);
    const inBody = client([{ body: { error: { message: "provider down", code: 502 } } }, { body: chat({ content: "ok" }) }]);
    const msg = await inBody.client.beta.messages.create({ model: "m", max_tokens: 10, messages: [] });
    expect(msg.content[0]).toMatchObject({ text: "ok" });
  });
});
