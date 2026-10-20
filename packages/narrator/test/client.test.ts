import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { describe, expect, it } from "vitest";
import { ShowQuerySchema, createAnthropicClient, finalText, servedByFallback, strictJsonSchema } from "../src/index";
import { fakeMessage, textBlock, thinkingBlock } from "./helpers";

describe("createAnthropicClient", () => {
  it("returns null without a credential (LLM off)", () => {
    expect(createAnthropicClient({})).toBeNull();
  });

  it("builds a client from the given env without calling the API", () => {
    const client = createAnthropicClient({ ANTHROPIC_API_KEY: "placeholder-not-a-key" });
    expect(typeof client?.beta.messages.create).toBe("function");
  });
});

describe("finalText / servedByFallback", () => {
  const fb = { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal" } } as unknown as BetaContentBlock;

  it("joins text blocks and skips thinking blocks", () => {
    expect(finalText([thinkingBlock(), textBlock('{"a":'), textBlock("1}")])).toBe('{"a":1}');
  });

  it("reads only after the last fallback block", () => {
    expect(finalText([textBlock("declined part"), fb, textBlock("kept")])).toBe("kept");
    expect(servedByFallback(fakeMessage({ content: [fb, textBlock("x")] }))).toBe(true);
    expect(servedByFallback(fakeMessage({ content: "x" }))).toBe(false);
    expect(
      servedByFallback(fakeMessage({ content: "x", usage: { iterations: [{ type: "fallback_message" }] as never } })),
    ).toBe(true);
  });
});

describe("strictJsonSchema", () => {
  it("turns nullable fields into anyOf and closes every object", () => {
    const json = strictJsonSchema(ShowQuerySchema) as { properties: Record<string, unknown>; additionalProperties: boolean };
    expect(json.additionalProperties).toBe(false);
    expect(json.properties["venue"]).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
      description: "Venue name, or null if not stated.",
    });
  });
});
