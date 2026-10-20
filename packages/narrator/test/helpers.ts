/**
 * Synthetic test data and a mock Anthropic client. Every name and id below is
 * invented for tests ("synthetic": true); nothing here is an API response body.
 */
import type {
  BetaContentBlock,
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type {
  Bill,
  ControlPlace,
  LiftTile,
  MediaPick,
  OperatorInputs,
  Partner,
  PrePostSpot,
  QlooEntity,
} from "@walkup/contracts";
import type { NarrateInput, NarratorClient } from "../src/index";

export const SYNTHETIC = true;

function entity(id: string, name: string, lat = 36.1, lon = -86.7): QlooEntity {
  return {
    entityId: id,
    name,
    subtype: "urn:entity:place",
    popularity: 0.5,
    affinity: 0.5,
    tags: [],
    properties: {},
    location: { lat, lon },
  };
}

export function makeBill(): Bill {
  return {
    acts: [
      { name: "Test Headliner", role: "headliner" },
      { name: "Test Support", role: "support" },
    ],
    venue: { name: "Sample Hall", lat: 36.1, lon: -86.7, city: "Exampleton", state: "TN" },
    date: "2026-11-28",
    weekday: "saturday",
    legalAgeEnforced: false,
    classification: "Music / Country",
  };
}

export function makeTiles(): LiftTile[] {
  return [
    { geohash: "dn6m9q", lat: 36.11, lon: -86.71, lift: 1.8423, billPct: 0.91, housePct: 0.49, popularityPct: 0.7, name: "North Example" },
    { geohash: "dn6m9r", lat: 36.12, lon: -86.72, lift: 1.31, billPct: 0.8, housePct: 0.61, popularityPct: 0.6 },
  ];
}

export function makePartners(): Partner[] {
  return [
    {
      entity: entity("E-P1", "Example Records", 36.1101, -86.7101),
      tileGeohash: "dn6m9q",
      tileName: "North Example",
      category: "record_store",
      score: 0.912,
      qlooRank: 1,
      hoursOnDay: "10:00-20:00",
      address: "100 Sample St",
      chips: [],
    },
    {
      entity: entity("E-P2", "Placeholder Barbers", 36.1201, -86.7201),
      tileGeohash: "dn6m9r",
      category: "barbershop",
      score: 0.7,
      qlooRank: 2,
      chips: [],
    },
  ];
}

export function makePrePost(): PrePostSpot[] {
  return [
    {
      entity: entity("E-S1", "Fixture Diner"),
      deltaRank: 3,
      expectedShare: 0.12,
      assumedCapacity: 80,
      fanFacingAllowed: true,
      chips: [],
    },
  ];
}

export function makeMedia(): MediaPick[] {
  return [{ entity: entity("E-M1", "Sample Podcast"), kind: "podcast", scope: "national", chips: [] }];
}

export function makeInput(): NarrateInput {
  return {
    bill: makeBill(),
    tiles: makeTiles(),
    partners: makePartners(),
    prePost: makePrePost(),
    media: makeMedia(),
    compareTags: {
      shared: [],
      a: [
        { id: "urn:tag:genre:music:test_folk", name: "test folk" },
        { id: "urn:tag:genre:music:test_twang", name: "test twang" },
        { id: "urn:tag:religion:test", name: "test faith" },
      ],
      b: [],
      fromTagDiff: false,
    },
    allowlistTags: [
      { id: "urn:tag:genre:music:test_folk", name: "test folk" },
      { id: "urn:tag:genre:music:test_twang", name: "test twang" },
      { id: "urn:tag:keyword:test_vinyl", name: "vinyl nights" },
      { id: "urn:tag:religion:test", name: "test faith" },
    ],
    numbers: [{ label: "seats left (what-if)", value: 340 }],
    hypothetical: true,
  };
}

export function makeOperator(): OperatorInputs {
  return {
    seatsLeft: 340,
    capacity: 1200,
    mediaBudgetUsd: null,
    streetTeamDays: ["thursday", "friday"],
    radiusKm: 40,
    declaredPartners: [{ label: "Example alumni chapter", contactEmail: "lead@example.invalid" }],
  };
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

export interface FakeMessageInit {
  content: BetaContentBlock[] | string;
  stop_reason?: BetaMessage["stop_reason"];
  stop_details?: BetaMessage["stop_details"];
  model?: string;
  usage?: Partial<BetaMessage["usage"]>;
}

export function textBlock(text: string): BetaContentBlock {
  // Test-only literal; extra SDK fields are irrelevant to the code under test.
  return { type: "text", text, citations: null } as unknown as BetaContentBlock;
}

export function toolUseBlock(id: string, name: string, input: unknown): BetaContentBlock {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } } as unknown as BetaContentBlock;
}

export function thinkingBlock(): BetaContentBlock {
  return { type: "thinking", thinking: "", signature: "sig-test" } as unknown as BetaContentBlock;
}

export function fakeMessage(init: FakeMessageInit): BetaMessage {
  const content = typeof init.content === "string" ? [textBlock(init.content)] : init.content;
  const msg = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: init.model ?? "claude-opus-5-5",
    container: null,
    context_management: null,
    diagnostics: null,
    content,
    stop_reason: init.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: init.stop_details ?? null,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      ...init.usage,
    },
  };
  return msg as unknown as BetaMessage;
}

export interface MockClient {
  client: NarratorClient;
  calls: MessageCreateParamsNonStreaming[];
}

/**
 * Replies in order from `script`; each entry is a message, an Error to throw,
 * or a function of the request. Requests are deep-copied when recorded so
 * later mutation of the caller's messages array does not change the record.
 */
export function mockClient(
  script: Array<BetaMessage | Error | ((p: MessageCreateParamsNonStreaming) => BetaMessage)>,
): MockClient {
  const calls: MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const client: NarratorClient = {
    beta: {
      messages: {
        async create(params) {
          calls.push(structuredClone(params));
          const step = script[Math.min(i, script.length - 1)];
          i += 1;
          if (!step) throw new Error("mock script is empty");
          if (step instanceof Error) throw step;
          return typeof step === "function" ? step(params) : step;
        },
      },
    },
  };
  return { client, calls };
}

export function place(id: string, name: string, lat = 36.11, lon = -86.71): Omit<ControlPlace, "query"> {
  return { placeId: id, name, address: `${id} Example Ave`, rating: 4.5, userRatingCount: 120, businessStatus: "OPERATIONAL", location: { lat, lon } };
}
