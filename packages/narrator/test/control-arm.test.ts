import type {
  BetaContentBlockParam,
  BetaToolResultBlockParam,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createMemoryLedger } from "@walkup/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_SYSTEM_PROMPT,
  CONTROL_TOOLS,
  SpendGuard,
  createMemorySpendStore,
  runControlArm,
  runLlmOnlyArm,
  type ControlArmInput,
  type ControlArmTools,
} from "../src/index";
import { fakeMessage, makeBill, makeOperator, mockClient, place, textBlock, thinkingBlock, toolUseBlock } from "./helpers";

function armInput(): ControlArmInput {
  const bill = makeBill();
  return { bill, operator: makeOperator(), center: { lat: bill.venue.lat, lon: bill.venue.lon }, radiusM: 5000 };
}

function tools(): ControlArmTools & { placesSearch: ReturnType<typeof vi.fn>; acsLookup: ReturnType<typeof vi.fn> } {
  return {
    placesSearch: vi.fn(async (query: string) => {
      if (query.includes("fail")) throw new Error("quota exceeded");
      if (query.includes("record")) return [place("gp-1", "Example Records"), place("gp-2", "Sample Spins")];
      return { places: [place("gp-3", "Fixture Tavern")], ledgerRef: "P9" };
    }),
    acsLookup: vi.fn(async () => ({ zcta: "37000", adults: 12000 })),
  };
}

function lastUserContent(p: MessageCreateParamsNonStreaming): BetaContentBlockParam[] {
  const last = p.messages[p.messages.length - 1]!;
  expect(last.role).toBe("user");
  return last.content as BetaContentBlockParam[];
}

describe("runControlArm (arm F)", () => {
  it("answers parallel tool_use blocks in one user message, with is_error on failures", async () => {
    const t = tools();
    const { client, calls } = mockClient([
      fakeMessage({
        stop_reason: "tool_use",
        content: [
          thinkingBlock(),
          toolUseBlock("tu1", "places_search", { query: "record store Exampleton" }),
          toolUseBlock("tu2", "places_search", { query: "fail this one" }),
          toolUseBlock("tu3", "acs_lookup", { zcta: "37000", lat: null, lon: null }),
        ],
      }),
      fakeMessage({
        stop_reason: "tool_use",
        content: [
          toolUseBlock("tu4", "submit_ranking", {
            places: [
              { place_id: "gp-2", reason: "Record store near the venue." },
              { place_id: "gp-unseen", reason: "Made up." },
              { place_id: "gp-1", reason: "Record store." },
              { place_id: "gp-2", reason: "Duplicate." },
            ],
          }),
        ],
      }),
    ]);
    const ledger = createMemoryLedger();
    const run = await runControlArm(armInput(), t, { client, ledger });

    expect(calls).toHaveLength(2);
    // Second request: assistant turn echoed unchanged, then ONE user message with all three results.
    const second = calls[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]!.role).toBe("assistant");
    expect((second.messages[1]!.content as { type: string }[])[0]!.type).toBe("thinking");
    const results = lastUserContent(second) as BetaToolResultBlockParam[];
    expect(results.map((r) => r.type)).toEqual(["tool_result", "tool_result", "tool_result"]);
    expect(results.map((r) => r.tool_use_id)).toEqual(["tu1", "tu2", "tu3"]);
    expect(results[0]!.is_error).toBeUndefined();
    expect(results[1]!.is_error).toBe(true);
    expect(String(results[1]!.content)).toContain("quota exceeded");
    expect(JSON.parse(String(results[2]!.content))).toEqual({ zcta: "37000", adults: 12000 });
    expect(t.acsLookup).toHaveBeenCalledWith({ zcta: "37000" });
    expect(t.placesSearch).toHaveBeenCalledWith("record store Exampleton", { lat: 36.1, lon: -86.7 }, 5000);

    expect(run.status).toBe("ok");
    expect(run.arm).toBe("F");
    expect(run.toolErrors).toBe(1);
    expect(run.queries).toEqual(["record store Exampleton", "fail this one"]);
    expect(run.places.map((p) => p.placeId)).toEqual(["gp-2", "gp-1"]);
    expect(run.places[0]!.query).toBe("record store Exampleton");
    expect(run.droppedUnseen).toBe(1);
    expect(run.droppedIds).toEqual(["gp-unseen"]);
    expect(run.iterations).toBe(2);
    expect(run.ledgerRefs).toEqual(["L1", "L2"]);
  });

  it("sends strict tools, tool_choice auto, effort medium, and the same system prompt every run", async () => {
    const script = [fakeMessage({ stop_reason: "tool_use", content: [toolUseBlock("s", "submit_ranking", { places: [] })] })];
    const a = mockClient(script);
    const b = mockClient(script);
    await runControlArm(armInput(), tools(), { client: a.client });
    const other = armInput();
    other.bill.venue.name = "Other Room";
    await runControlArm(other, tools(), { client: b.client });

    const p = a.calls[0]!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.tool_choice).toEqual({ type: "auto" });
    expect(p.output_config?.effort).toBe("medium");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect(p).not.toHaveProperty("thinking");
    for (const tool of p.tools as typeof CONTROL_TOOLS) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema["additionalProperties"]).toBe(false);
      expect(Array.isArray(tool.input_schema.required)).toBe(true);
    }
    expect((p.system as { text: string }[])[0]!.text).toBe(CONTROL_SYSTEM_PROMPT);
    expect(JSON.stringify(a.calls[0]!.system)).toBe(JSON.stringify(b.calls[0]!.system));
    expect(JSON.stringify(a.calls[0]!.tools)).toBe(JSON.stringify(b.calls[0]!.tools));
    // Operator-typed emails never go to the model.
    expect(String(p.messages[0]!.content)).not.toContain("example.invalid");
  });

  it("re-prompts once when no tool is called, then reports no_ranking", async () => {
    const { client, calls } = mockClient([fakeMessage({ content: [textBlock("Here are some ideas.")] })]);
    const run = await runControlArm(armInput(), tools(), { client });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages[2]).toEqual({
      role: "user",
      content: expect.stringContaining("submit_ranking"),
    });
    expect(run.status).toBe("no_ranking");
    expect(run.places).toEqual([]);
  });

  it("stops after 8 model turns and nudges before the last one", async () => {
    let n = 0;
    const { client, calls } = mockClient([
      () => fakeMessage({ stop_reason: "tool_use", content: [toolUseBlock(`t${++n}`, "places_search", { query: `bar ${n}` })] }),
    ]);
    const t = tools();
    const run = await runControlArm(armInput(), t, { client, maxIterations: 50 });
    expect(calls).toHaveLength(8);
    expect(t.placesSearch).toHaveBeenCalledTimes(7); // the 8th turn's searches are not run
    expect(run.status).toBe("iteration_limit");
    const nudged = lastUserContent(calls[7]!);
    expect(nudged[nudged.length - 1]).toMatchObject({ type: "text", text: expect.stringContaining("submit_ranking") });
  });

  it("answers an unknown tool and a malformed submission with is_error", async () => {
    const { client, calls } = mockClient([
      fakeMessage({
        stop_reason: "tool_use",
        content: [toolUseBlock("u1", "web_search", { q: "x" }), toolUseBlock("u2", "submit_ranking", { nope: true })],
      }),
      fakeMessage({ stop_reason: "tool_use", content: [toolUseBlock("u3", "submit_ranking", { places: [] })] }),
    ]);
    const run = await runControlArm(armInput(), tools(), { client });
    const results = lastUserContent(calls[1]!) as BetaToolResultBlockParam[];
    expect(results.map((r) => [r.tool_use_id, r.is_error])).toEqual([
      ["u1", true],
      ["u2", true],
    ]);
    expect(run.status).toBe("ok");
    expect(run.toolErrors).toBe(2);
  });

  it("merges parallel search results in tool_use order, whatever order they resolve in", async () => {
    const slowFirst: ControlArmTools = {
      placesSearch: async (query: string) => {
        if (query === "first") {
          await new Promise((r) => setTimeout(r, 20));
          return { places: [place("gp-1", "Example Records")], ledgerRef: "P1" };
        }
        return { places: [place("gp-1", "Example Records")], ledgerRef: "P2" };
      },
      acsLookup: async () => null,
    };
    const { client } = mockClient([
      fakeMessage({
        stop_reason: "tool_use",
        content: [toolUseBlock("a", "places_search", { query: "first" }), toolUseBlock("b", "places_search", { query: "second" })],
      }),
      fakeMessage({ stop_reason: "tool_use", content: [toolUseBlock("c", "submit_ranking", { places: [{ place_id: "gp-1", reason: "r" }] })] }),
    ]);
    const run = await runControlArm(armInput(), slowFirst, { client, ledger: createMemoryLedger() });
    expect(run.places[0]!.query).toBe("first");
    expect(run.ledgerRefs).toEqual(["L1", "P1", "P2", "L2"]);
  });

  it("passes the Qloo arm's categories to the model when given", async () => {
    const { client, calls } = mockClient([
      fakeMessage({ stop_reason: "tool_use", content: [toolUseBlock("s", "submit_ranking", { places: [] })] }),
    ]);
    await runControlArm({ ...armInput(), categories: ["record_store", "cafe"] }, tools(), { client });
    expect(String(calls[0]!.messages[0]!.content)).toContain('"record_store"');
  });

  it("stops on refusal", async () => {
    const { client } = mockClient([fakeMessage({ content: [], stop_reason: "refusal" })]);
    const run = await runControlArm(armInput(), tools(), { client });
    expect(run.status).toBe("refused");
  });

  it("stops when the daily cap is reached", async () => {
    const spend = new SpendGuard({ store: createMemorySpendStore({ "2026-10-13": 9 }), now: () => new Date("2026-10-13T00:00:00Z") });
    const { client, calls } = mockClient([fakeMessage({ content: "x" })]);
    const run = await runControlArm(armInput(), tools(), { client, spend });
    expect(run.status).toBe("over_budget");
    expect(calls).toHaveLength(0);
  });

  it("does not run without a client", async () => {
    const run = await runControlArm(armInput(), tools());
    expect(run.status).toBe("llm_off");
  });

  it("computes overlap with Qloo partners (name >= 0.85 and <= 150 m)", async () => {
    const { client } = mockClient([
      fakeMessage({ stop_reason: "tool_use", content: [toolUseBlock("a", "places_search", { query: "record shops" })] }),
      fakeMessage({
        stop_reason: "tool_use",
        content: [
          toolUseBlock("b", "submit_ranking", {
            places: [
              { place_id: "gp-1", reason: "r" },
              { place_id: "gp-2", reason: "r" },
            ],
          }),
        ],
      }),
    ]);
    const run = await runControlArm(armInput(), tools(), {
      client,
      qlooPartners: [
        { name: "The Example Records", location: { lat: 36.1101, lon: -86.7101 } },
        { name: "Sample Spins", location: { lat: 36.2, lon: -86.9 } }, // same name, far away
      ],
    });
    expect(run.overlapWithQloo).toEqual(["The Example Records"]);
  });
});

describe("runLlmOnlyArm (arm L)", () => {
  it("returns unverified places from a tools-free structured answer", async () => {
    const answer = {
      places: [
        { name: "Example Records", address: null, reason: "r" },
        { name: "example records", address: null, reason: "dup" },
        { name: "Fixture Tavern", address: "1 Example Ave", reason: "r" },
      ],
    };
    const { client, calls } = mockClient([fakeMessage({ content: JSON.stringify(answer) })]);
    const run = await runLlmOnlyArm(armInput(), { client });
    expect(run.arm).toBe("L");
    expect(run.status).toBe("ok");
    expect(run.places.map((p) => [p.placeId, p.name])).toEqual([
      ["unverified:1", "Example Records"],
      ["unverified:2", "Fixture Tavern"],
    ]);
    const p = calls[0]!;
    expect(p).not.toHaveProperty("tools");
    expect(p.output_config?.format?.type).toBe("json_schema");
    expect((p.system as { text: string }[])[0]!.text).toBe(CONTROL_SYSTEM_PROMPT);
  });

  it("reports refusal and unparseable answers", async () => {
    const refused = await runLlmOnlyArm(armInput(), {
      client: mockClient([fakeMessage({ content: [], stop_reason: "refusal" })]).client,
    });
    expect(refused.status).toBe("refused");
    const junk = await runLlmOnlyArm(armInput(), { client: mockClient([fakeMessage({ content: "nope" })]).client });
    expect(junk.status).toBe("no_ranking");
  });
});
