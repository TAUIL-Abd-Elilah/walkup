/**
 * The two-guard rule with a mock model: operator-facing lines pass the
 * narrator's guard, and fan-facing copy hooks also pass the engine guard with
 * the all-ages alcohol rule. A hook that sends an all-ages crowd "to a bar"
 * survives the narrator's word list but not the engine's.
 */
import { describe, expect, it } from "vitest";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { NarratorClient } from "@walkup/narrator";
import { planShow } from "../src/index";
import { deps, sheetOf } from "./helpers";

interface Facts {
  tiles: { geohash: string; name: string | null }[];
  partners: { entityId: string; name: string }[];
  allowlistedTags: { id: string; name: string }[];
}

function factsOf(params: MessageCreateParamsNonStreaming): Facts {
  const msg = params.messages[0];
  const text = typeof msg?.content === "string" ? msg.content : "";
  const m = /<run_facts>\n([\s\S]*)\n<\/run_facts>/.exec(text);
  return JSON.parse(m?.[1] ?? "{}") as Facts;
}

function message(text: string): BetaMessage {
  // Test-only literal: only the fields the narrator reads.
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as BetaMessage;
}

function mockModel(): { client: NarratorClient; calls: number } {
  const state = { calls: 0 };
  const client: NarratorClient = {
    beta: {
      messages: {
        async create(params) {
          state.calls++;
          const f = factsOf(params);
          const [t1, t2] = f.allowlistedTags;
          const draft = {
            summary: "This bill's crowd over-indexes in a few named areas, listed below.",
            tileWhy: f.tiles.slice(0, 2).map((t) => ({ geohash: t.geohash, text: `${t.name ?? "This area"} leans toward this bill more than the house crowd.` })),
            partnerLines: f.partners.slice(0, 3).map((p) => ({ entityId: p.entityId, text: `${p.name} sits in one of the top tiles.` })),
            copyHooks: [
              { text: `${t1?.name ?? "Live"} night out, then a bar nearby.`, tagIds: t1 ? [t1.id] : [] },
              { text: `${t2?.name ?? "Live"}, one night only.`, tagIds: t2 ? [t2.id] : [] },
            ],
          };
          return message(JSON.stringify(draft));
        },
      },
    },
  };
  return {
    client,
    get calls() {
      return state.calls;
    },
  };
}

describe("narration with a model", () => {
  it("drops the bar hook on an all-ages show through the fan-facing engine guard", async () => {
    const model = mockModel();
    const r = await planShow({ presetId: "g1-b" }, deps({ narratorClient: model.client }));
    const s = sheetOf(r);
    expect(model.calls).toBe(1);
    expect(s.narration?.templated).toBe(false);
    expect(s.ledger.some((e) => e.kind === "anthropic")).toBe(true);
    expect(s.cards.copyHooks.results.map((h) => h.text)).not.toContainEqual(expect.stringContaining(" bar "));
    expect(s.cards.copyHooks.results).toHaveLength(1);
    expect(s.guard.dropped).toBe(1);
    expect(s.guard.reasons.some((x) => x.startsWith("fan-facing guard: copyHooks[0]") && /not 21\+/.test(x))).toBe(true);
    expect(s.narration?.partnerLines).toHaveLength(3);
  });

  it("keeps the same hook on a 21+ show (age rule from Ticketmaster)", async () => {
    const model = mockModel();
    const r = await planShow({ presetId: "g1-a" }, deps({ narratorClient: model.client }));
    const s = sheetOf(r);
    expect(s.bill.legalAgeEnforced).toBe(true);
    expect(s.cards.copyHooks.results).toHaveLength(2);
    expect(s.guard.dropped).toBe(0);
  });
});
