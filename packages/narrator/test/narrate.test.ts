import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createMemoryLedger } from "@walkup/contracts";
import { describe, expect, it } from "vitest";
import {
  NARRATOR_SYSTEM_PROMPT,
  SpendGuard,
  createMemorySpendStore,
  narrate,
  templateNarrate,
} from "../src/index";
import { fakeMessage, makeInput, mockClient, textBlock } from "./helpers";

const GOOD = {
  summary:
    "This bill's fans over-index most in North Example, at 1.84 times the room's usual crowd. Start with the record store there.",
  tileWhy: [{ geohash: "dn6m9q", text: "North Example: percentile 91 for this bill versus 49 for the room's usual crowd." }],
  partnerLines: [{ entityId: "E-P1", text: "Record store in North Example, rank 1 for this bill." }],
  copyHooks: [
    {
      text: "Test Headliner: test folk and vinyl nights at Sample Hall, Saturday.",
      tagIds: ["urn:tag:genre:music:test_folk", "urn:tag:keyword:test_vinyl"],
    },
  ],
};

const fixedNow = () => new Date("2026-10-13T12:00:00Z");

describe("narrate", () => {
  it("uses the template when no client is given (LLM off)", async () => {
    const res = await narrate(makeInput());
    expect(res.templated).toBe(true);
    expect(res.templateReason).toBe("llm_off");
    expect(res.usage).toBeNull();
  });

  it("sends a schema-bound, cached, low-effort request with server-side fallbacks", async () => {
    const { client, calls } = mockClient([fakeMessage({ content: JSON.stringify(GOOD) })]);
    const ledger = createMemoryLedger();
    const res = await narrate(makeInput(), { client, ledger });

    expect(res.templated).toBe(false);
    expect(res.summary).toBe(GOOD.summary);
    expect(res.tileWhy).toEqual(GOOD.tileWhy);
    expect(res.partnerLines).toEqual(GOOD.partnerLines);
    expect(res.copyHooks).toEqual(GOOD.copyHooks);
    expect(res.guard.dropped).toBe(0);
    expect(res.usage?.costUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6, 10);
    expect(res.ledgerRefs).toEqual(["L1"]);
    expect(ledger.entries()[0]).toMatchObject({ id: "L1", kind: "anthropic", endpoint: "/v1/messages", httpStatus: 200 });
    expect(ledger.entries()[0]!.curl).toContain("$ANTHROPIC_API_KEY");

    const p = calls[0]!;
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.output_config?.effort).toBe("low");
    expect(p.output_config?.format?.type).toBe("json_schema");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(p.fallbacks).toBe("default");
    expect(p).not.toHaveProperty("thinking");
    expect(p).not.toHaveProperty("tool_choice");
    expect(p).not.toHaveProperty("temperature");
    const system = p.system as { text: string; cache_control?: { type: string } }[];
    expect(system[0]!.text).toBe(NARRATOR_SYSTEM_PROMPT);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    const user = p.messages[0]!.content as string;
    expect(user).toContain("<run_facts>");
    expect(user).not.toContain("test faith"); // denied tag never reaches the model
  });

  it("keeps the system prompt byte-identical across runs", async () => {
    const a = mockClient([fakeMessage({ content: JSON.stringify(GOOD) })]);
    const b = mockClient([fakeMessage({ content: "{}" })]);
    const other = makeInput();
    other.bill.venue.name = "Other Room";
    await narrate(makeInput(), { client: a.client });
    await narrate(other, { client: b.client });
    expect(JSON.stringify(a.calls[0]!.system)).toBe(JSON.stringify(b.calls[0]!.system));
  });

  it("falls back to the template on stop_reason refusal", async () => {
    const { client } = mockClient([
      fakeMessage({
        content: '{"summary": "partial',
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: null, explanation: null } as never,
      }),
    ]);
    const res = await narrate(makeInput(), { client });
    expect(res.templated).toBe(true);
    expect(res.templateReason).toBe("refusal");
    expect(res.usage).not.toBeNull(); // the declined call is still priced
    expect(res.summary).toBe(templateNarrate(makeInput()).summary);
  });

  it("falls back to the template when the output does not parse (parsed null)", async () => {
    const { client } = mockClient([fakeMessage({ content: "not json" })]);
    const res = await narrate(makeInput(), { client });
    expect(res.templated).toBe(true);
    expect(res.templateReason).toBe("parse_failed");
  });

  it("falls back to the template when the output cites a foreign id", async () => {
    const bad = { ...GOOD, partnerLines: [{ entityId: "E-FOREIGN", text: "x" }] };
    const { client } = mockClient([fakeMessage({ content: JSON.stringify(bad) })]);
    const res = await narrate(makeInput(), { client });
    expect(res.templated).toBe(true);
    expect(res.templateReason).toBe("parse_failed");
  });

  it("falls back to the template on max_tokens", async () => {
    const { client } = mockClient([fakeMessage({ content: '{"summary":"', stop_reason: "max_tokens" })]);
    const res = await narrate(makeInput(), { client });
    expect(res.templateReason).toBe("max_tokens");
  });

  it("falls back to the template on an API error and logs it", async () => {
    const { client } = mockClient([new Error("network down")]);
    const ledger = createMemoryLedger();
    const res = await narrate(makeInput(), { client, ledger });
    expect(res.templateReason).toBe("api_error");
    expect(ledger.entries()[0]).toMatchObject({ kind: "anthropic", envelopeStatus: "error" });
  });

  it("uses the template without calling the model when the daily cap is reached", async () => {
    const spend = new SpendGuard({ store: createMemorySpendStore({ "2026-10-13": 5 }), now: fixedNow });
    const { client, calls } = mockClient([fakeMessage({ content: JSON.stringify(GOOD) })]);
    const res = await narrate(makeInput(), { client, spend });
    expect(res.templated).toBe(true);
    expect(res.templateReason).toBe("over_budget");
    expect(calls).toHaveLength(0);
  });

  it("records spend per call and switches to the template once the cap is crossed", async () => {
    const spend = new SpendGuard({ dailyCapUsd: 0.02, now: fixedNow });
    const { client, calls } = mockClient([fakeMessage({ content: JSON.stringify(GOOD) })]);
    expect((await narrate(makeInput(), { client, spend })).templated).toBe(false); // spent 0.014
    expect((await narrate(makeInput(), { client, spend })).templated).toBe(false); // spent 0.028
    const third = await narrate(makeInput(), { client, spend });
    expect(third.templateReason).toBe("over_budget");
    expect(calls).toHaveLength(2);
    expect(await spend.spentToday()).toBeCloseTo(0.028, 10);
  });

  it("keeps a billed answer when the spend store fails, and notes it in the ledger", async () => {
    const spend = new SpendGuard({
      store: {
        get: () => 0,
        add: () => {
          throw new Error("disk full");
        },
      },
      now: fixedNow,
    });
    const ledger = createMemoryLedger();
    const { client } = mockClient([fakeMessage({ content: JSON.stringify(GOOD) })]);
    const res = await narrate(makeInput(), { client, spend, ledger });
    expect(res.templated).toBe(false);
    expect(res.summary).toBe(GOOD.summary);
    expect(ledger.entries()[0]).toMatchObject({ envelopeStatus: "ok", note: expect.stringContaining("spend not recorded: disk full") });
  });

  it("reads the answer after the last fallback block", async () => {
    const fallback = {
      type: "fallback",
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-5" },
      trigger: { type: "refusal" },
    } as unknown as BetaContentBlock;
    const { client } = mockClient([
      fakeMessage({ content: [textBlock('{"summary":"cut'), fallback, textBlock(JSON.stringify(GOOD))], model: "claude-opus-5" }),
    ]);
    const res = await narrate(makeInput(), { client });
    expect(res.templated).toBe(false);
    expect(res.summary).toBe(GOOD.summary);
    expect(res.usage?.fallbackServed).toBe(true);
    expect(res.usage?.model).toBe("claude-opus-5");
  });

  it("guard drops lines with unlisted numbers, show-status words and unused tags, and puts the act in every hook", async () => {
    const draft = {
      summary: "Expect 5000 people.",
      tileWhy: [
        { geohash: "dn6m9q", text: "North Example: 1.84x lift." },
        { geohash: "dn6m9r", text: "This area is soft for the show." },
      ],
      partnerLines: [
        { entityId: "E-P1", text: "Record store in North Example." },
        { entityId: "E-P2", text: "Barbershop with 7 chairs." },
      ],
      copyHooks: [
        { text: "Test Headliner fans: test twang night.", tagIds: ["urn:tag:genre:music:test_twang"] },
        { text: "A night out at Sample Hall.", tagIds: ["urn:tag:genre:music:test_folk"] },
        { text: "Test folk at Sample Hall.", tagIds: ["urn:tag:genre:music:test_folk"] },
      ],
    };
    const { client } = mockClient([fakeMessage({ content: JSON.stringify(draft) })]);
    const res = await narrate(makeInput(), { client });
    expect(res.templated).toBe(false);
    expect(res.guard.dropped).toBe(4);
    expect(res.summary).toBe(templateNarrate(makeInput()).summary); // bad summary replaced
    expect(res.tileWhy.map((t) => t.geohash)).toEqual(["dn6m9q"]);
    expect(res.partnerLines.map((l) => l.entityId)).toEqual(["E-P1"]);
    // Hooks now name the act: a line that already does is kept, the others get the headliner in front.
    expect(res.copyHooks.map((h) => h.text)).toEqual(["Test Headliner fans: test twang night.", "Test Headliner: Test folk at Sample Hall."]);
    expect(res.guard.reasons.join("\n")).toMatch(/5000/);
    expect(res.guard.reasons.join("\n")).toMatch(/soft/);
    expect(res.guard.reasons.join("\n")).not.toMatch(/act name/);
  });
});
