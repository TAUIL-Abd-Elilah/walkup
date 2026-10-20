/**
 * SYNTHETIC fake transports for the P1 runner tests: Qloo, Google Places, the Census Geocoder
 * and the model. Every id, name, address and number is invented; response bodies are built
 * here, carry "synthetic": true, and never come from a real API. Nothing reaches the network.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Message, MessageCreateParamsNonStreaming, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { noLimiter } from "@walkup/qloo";
import type { ModelClient } from "../model-arms";
import { createServices, type ServiceHandle, type ServiceOptions } from "../services";
import { haversineM, normalizeName } from "../similarity";

export const SYNTHETIC = true;
export const BARS_CSV = readFileSync(fileURLToPath(new URL("../test-data/bars_synthetic.csv", import.meta.url)), "utf8");
export const FIXED_NOW = new Date("2026-10-20T12:00:00Z");

export const BRAND = { ao: "00000000-0000-4000-8000-00000000b001", ars: "00000000-0000-4000-8000-00000000b002", lfc: "00000000-0000-4000-8000-00000000b003", band: "00000000-0000-4000-8000-00000000b009" };
export const TAG = {
  barCategory: "urn:tag:category:place:bar",
  barGenre: "urn:tag:genre:place:bar",
  pub: "urn:tag:category:place:pub",
  sportsBar: "urn:tag:category:place:sports_bar",
};

export interface WorldPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address: string;
  popularity: number;
}

export interface GooglePlaceRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  address: string;
  businessStatus: string;
}

export interface World {
  brands: Record<string, { entity_id: string; name: string; popularity: number; tags: { id: string; name: string }[] }[]>;
  brandTags: Record<string, { id: string; name: string }[]>;
  tags: Record<string, { id: string; name: string }[]>;
  places: WorldPlace[];
  /** Signal entity -> place ids, most loved first. */
  fans: Record<string, string[]>;
  google: GooglePlaceRow[];
  /** Address prefix -> point (null: no match). */
  geocode: Record<string, { lat: number; lon: number } | null>;
}

const p = (id: string, name: string, lat: number, lon: number, address: string, popularity: number): WorldPlace => ({ id, name, lat, lon, address, popularity });

export function makeWorld(): World {
  return {
    brands: {
      "United States men's national soccer team": [
        { entity_id: BRAND.ao, name: "United States men's national soccer team", popularity: 0.9, tags: [] }, // tags via /entities
      ],
      "Arsenal F.C.": [
        { entity_id: BRAND.band, name: "Arsenal", popularity: 0.95, tags: [{ id: "urn:tag:genre:music:rock", name: "Rock" }] },
        { entity_id: BRAND.ars, name: "Arsenal F.C.", popularity: 0.8, tags: [{ id: "urn:tag:category:brand:sports_organization", name: "Sports organization" }] },
      ],
      "Liverpool F.C.": [{ entity_id: "00000000-0000-4000-8000-00000000b00a", name: "Liverpool Fictional Ferries", popularity: 0.2, tags: [] }],
      "Liverpool FC": [{ entity_id: BRAND.lfc, name: "Liverpool FC", popularity: 0.85, tags: [{ id: "urn:tag:category:brand:sports_organization", name: "Sports organization" }] }],
    },
    brandTags: {
      [BRAND.ao]: [{ id: "urn:tag:category:brand:sports_organization", name: "Sports organization" }],
      "00000000-0000-4000-8000-00000000b00a": [{ id: "urn:tag:category:brand:transport", name: "Transport" }],
    },
    tags: {
      bar: [
        { id: TAG.barGenre, name: "Bar" },
        { id: TAG.barCategory, name: "Bar" },
        { id: "urn:tag:category:place:wine_bar", name: "Wine Bar" },
      ],
      pub: [{ id: TAG.pub, name: "Pub" }],
      "sports bar": [{ id: TAG.sportsBar, name: "Sports Bar" }],
      "irish pub": [{ id: "urn:tag:category:place:gastropub", name: "Gastropub" }],
    },
    places: [
      // Exampleton (P = 30.0, -97.0)
      p("q-ao-1", "Corner Flag Tavern", 30.0103, -97.01, "101 Example St, Exampleton, TX 75001", 0.3),
      p("q-ao-2", "Offside Pub", 30.05, -97.02, "55 Fictional Blvd, Exampleton, TX 75002", 0.1),
      p("q-ars-7", "Gunners Rest", 29.9902, -96.99, "202 Example St, Exampleton, TX 75001", 0.9),
      p("q-ars-8", "Old Cannon Ale House", 29.991, -96.99, "210 Example St, Exampleton, TX 75001", 0.7),
      p("q-lfc-10", "Kop End Bar", 30.02, -97.0, "9 Fictional Way, Exampleton, TX 75001", 0.2),
      p("q-fill-1", "Filler Lounge One", 30.001, -97.001, "1 Filler Rd, Exampleton, TX 75001", 0.6),
      p("q-fill-2", "Filler Lounge Two", 30.002, -97.002, "2 Filler Rd, Exampleton, TX 75001", 0.5),
      p("q-fill-3", "Corner Flag Taproom", 30.0104, -97.0101, "103 Example St, Exampleton, TX 75001", 0.4),
      // Sampleville (P = 40.0, -83.0)
      p("q-ao-3", "Stoppage Time Saloon", 40.01, -83.0, "300 Sample Rd, Sampleville, OH 43001", 0.4),
      p("q-ars-9", "Far Field Pub", 40.4, -83.0, "900 Distant Rd, Farburg, OH 43100", 0.3),
      p("q-lfc-11", "Red Scarf Tavern", 40.0052, -83.005, "410 Sample Rd, Sampleville, OH 43001", 0.5),
      p("q-fill-4", "Filler Lounge Four", 40.001, -83.001, "4 Filler Rd, Sampleville, OH 43001", 0.6),
      // Durham (P = 35.98, -78.90)
      p("q-ao-6", "Durham Goal Bar", 35.9902, -78.9, "12 Fictional Ave, Durham, NC 27701", 0.5),
      p("q-fill-5", "Filler Lounge Five", 35.981, -78.901, "5 Filler Rd, Durham, NC 27701", 0.7),
    ],
    fans: {
      [BRAND.ao]: ["q-ao-6", "q-ao-1", "q-ao-3", "q-ao-2"],
      [BRAND.ars]: ["q-ars-7", "q-ars-9"],
      [BRAND.lfc]: ["q-lfc-11"],
    },
    google: [
      { id: "gp-1", name: "Corner Flag Tavern", lat: 30.0103, lon: -97.01, address: "101 Example St, Exampleton, TX 75001, USA", businessStatus: "OPERATIONAL" },
      { id: "gp-2", name: "Offside Pub", lat: 30.05, lon: -97.02, address: "55 Fictional Blvd, Exampleton, TX 75002, USA", businessStatus: "OPERATIONAL" },
      { id: "gp-7", name: "Gunners Rest", lat: 29.9902, lon: -96.99, address: "202 Example St, Exampleton, TX 75001, USA", businessStatus: "OPERATIONAL" },
      { id: "gp-3", name: "Stoppage Time Saloon", lat: 40.01, lon: -83.0, address: "300 Sample Rd, Sampleville, OH 43001, USA", businessStatus: "CLOSED_PERMANENTLY" },
      { id: "gp-9", name: "Far Field Pub", lat: 40.4, lon: -83.0, address: "900 Distant Rd, Farburg, OH 43100, USA", businessStatus: "OPERATIONAL" },
      { id: "gp-11", name: "Red Scarf Tavern", lat: 40.0052, lon: -83.005, address: "410 Sample Rd, Sampleville, OH 43001, USA", businessStatus: "OPERATIONAL" },
      { id: "gp-6", name: "Durham Goal Bar", lat: 35.9902, lon: -78.9, address: "12 Fictional Ave, Durham, NC 27701, USA", businessStatus: "OPERATIONAL" },
      { id: "gp-x", name: "Generic Sports Grill", lat: 30.003, lon: -97.003, address: "7 Generic Rd, Exampleton, TX 75001, USA", businessStatus: "OPERATIONAL" },
    ],
    geocode: {
      "101 Example St": { lat: 30.01, lon: -97.01 },
      "202 Example St": { lat: 29.99, lon: -96.99 },
      "210 Example St": { lat: 29.991, lon: -96.99 },
      "300 Sample Rd": null,
      "400 Nowhere Rd": { lat: 40.02, lon: -83.02 },
      "900 Distant Rd": { lat: 40.4, lon: -83.0 },
      "410 Sample Rd": { lat: 40.005, lon: -83.005 },
      "12 Fictional Ave": { lat: 35.99, lon: -78.9 },
    },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function parsePoint(wkt: string | null): { lat: number; lon: number } | null {
  const m = /^POINT\(([-\d.]+) ([-\d.]+)\)$/.exec(wkt ?? "");
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
}

function rawPlace(pl: WorldPlace): Record<string, unknown> {
  return {
    entity_id: pl.id,
    name: pl.name,
    types: ["urn:entity:place"],
    popularity: pl.popularity,
    location: { lat: pl.lat, lon: pl.lon },
    properties: { address: pl.address },
    tags: [{ id: TAG.barCategory, name: "Bar" }],
  };
}

const firstToken = (s: string): string => normalizeName(s).split(" ")[0] ?? "";

export interface QlooFake {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: URL[];
  /** Status to answer for a call matching the predicate (e.g. 500), or a body override. */
  failWhen?: (u: URL) => number | null;
  /** Extra place (any distance) appended to every non-shortlist place list: the filter-check test. */
  intruder?: WorldPlace | null;
}

export function qlooFake(world: World, opts: { failWhen?: (u: URL) => number | null; intruder?: WorldPlace | null } = {}): QlooFake {
  const calls: URL[] = [];
  const fake: QlooFake = {
    calls,
    async fetch(url) {
      const u = new URL(url);
      calls.push(u);
      const fail = opts.failWhen?.(u) ?? null;
      if (fail) return json({ synthetic: true, error: "synthetic failure" }, fail);
      const q = u.searchParams;
      const headers = { "x-month-ratelimit-remaining": "9000", "x-month-ratelimit-limit": "10000" };
      if (u.pathname === "/search") {
        const types = q.get("types") ?? "";
        const query = q.get("query") ?? "";
        if (types === "urn:entity:brand") return json({ synthetic: true, results: world.brands[query] ?? [] }, 200, headers);
        const at = parsePoint(q.get("filter.location"));
        const miles = Number(q.get("filter.radius") ?? "0");
        const take = Number(q.get("take") ?? "10");
        const hits = world.places.filter(
          (pl) => at && firstToken(pl.name) === firstToken(query) && haversineM(at.lat, at.lon, pl.lat, pl.lon) <= miles * 1609.344,
        );
        if (hits.length === 0) return json({ synthetic: true, message: "not found" }, 404, headers);
        return json({ synthetic: true, results: hits.slice(0, take).map(rawPlace) }, 200, headers);
      }
      if (u.pathname === "/entities") {
        const ids = (q.get("entity_ids") ?? "").split(",");
        const results = ids.map((id) => {
          const brand = Object.values(world.brands).flat().find((b) => b.entity_id === id);
          return brand ? { ...brand, tags: world.brandTags[id] ?? brand.tags } : null;
        });
        return json({ synthetic: true, results: results.filter(Boolean) }, 200, headers);
      }
      if (u.pathname === "/v2/tags") {
        return json({ synthetic: true, results: { tags: world.tags[q.get("filter.query") ?? ""] ?? [] } }, 200, headers);
      }
      if (u.pathname === "/v2/insights") {
        const signal = q.get("signal.interests.entities");
        const fans = signal ? (world.fans[signal] ?? []) : [];
        const score = (pl: WorldPlace): number => {
          const i = fans.indexOf(pl.id);
          return i >= 0 ? 10 - i : pl.popularity;
        };
        const shortlist = q.get("filter.results.entities");
        if (shortlist) {
          const ids = shortlist.split(",");
          const list = world.places.filter((pl) => ids.includes(pl.id)).sort((a, b) => score(b) - score(a));
          return json({ synthetic: true, results: { entities: list.map(rawPlace) } }, 200, headers);
        }
        const at = parsePoint(q.get("filter.location"));
        const radius = Number(q.get("filter.location.radius") ?? "0");
        const take = Number(q.get("take") ?? "20");
        let list = world.places.filter((pl) => at && haversineM(at.lat, at.lon, pl.lat, pl.lon) <= radius);
        list = list.sort((a, b) => (signal ? score(b) - score(a) : b.popularity - a.popularity));
        if (opts.intruder) list = [...list, opts.intruder];
        return json({ synthetic: true, results: { entities: list.slice(0, take).map(rawPlace) } }, 200, headers);
      }
      return json({ synthetic: true, error: "unknown path" }, 400);
    },
  };
  return fake;
}

export interface PlacesFake {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  bodies: { textQuery: string; locationBias?: { circle: { center: { latitude: number; longitude: number }; radius: number } }; maxResultCount: number }[];
}

export interface PlacesFakeOptions {
  /** Answer every places_search tool request (a text query without a comma) with this HTTP status. */
  toolStatus?: number;
  /** Throw a network error for the first N requests, then answer normally. */
  networkFailures?: number;
}

export function placesFake(world: World, opts: PlacesFakeOptions = {}): PlacesFake {
  const bodies: PlacesFake["bodies"] = [];
  let networkFailures = opts.networkFailures ?? 0;
  return {
    bodies,
    async fetch(_url, init) {
      const body = JSON.parse(String(init?.body ?? "{}")) as PlacesFake["bodies"][number];
      bodies.push(body);
      if (networkFailures > 0) {
        networkFailures -= 1;
        throw new TypeError("synthetic network failure");
      }
      if (opts.toolStatus && !body.textQuery.includes(",")) {
        return json({ synthetic: true, error: { status: "UNAVAILABLE", message: "synthetic failure" } }, opts.toolStatus);
      }
      const c = body.locationBias?.circle;
      const near = (g: GooglePlaceRow, m: number): boolean => !c || haversineM(c.center.latitude, c.center.longitude, g.lat, g.lon) <= m;
      let hits: GooglePlaceRow[];
      if (body.textQuery.includes(",")) {
        const name = body.textQuery.split(",")[0] ?? "";
        hits = world.google.filter((g) => firstToken(g.name) === firstToken(name) && near(g, 60_000));
      } else {
        hits = world.google.filter((g) => near(g, c?.radius ?? 25_000));
      }
      return json({
        synthetic: true,
        places: hits.slice(0, body.maxResultCount).map((g) => ({
          id: g.id,
          displayName: { text: g.name },
          formattedAddress: g.address,
          location: { latitude: g.lat, longitude: g.lon },
          businessStatus: g.businessStatus,
          rating: 4.2,
          userRatingCount: 120,
        })),
      });
    },
  };
}

export interface CensusFake {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  urls: string[];
}

export function censusFake(world: World, robots = "User-agent: *\nDisallow: /private/\n"): CensusFake {
  const urls: string[] = [];
  return {
    urls,
    async fetch(url) {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === "/robots.txt") return new Response(robots, { status: 200 });
      const address = u.searchParams.get("address") ?? "";
      const key = Object.keys(world.geocode).find((k) => address.startsWith(k));
      const pt = key ? world.geocode[key] : null;
      return json({ synthetic: true, result: { input: { address: { address } }, addressMatches: pt ? [{ coordinates: { x: pt.lon, y: pt.lat }, matchedAddress: address }] : [] } });
    },
  };
}

// ---------------------------------------------------------------------------
// Fake model
// ---------------------------------------------------------------------------

export interface ModelFakeOptions {
  /** Metro display name -> names arm L returns. */
  lNames?: Record<string, string[]>;
  /** Refuse when the first user message contains this text (both arms). */
  refuseWhen?: string;
  /** Answer the first call with another model id (tests the discard-and-retry rule). */
  wrongModelFirst?: boolean;
  /** F: number of places_search calls before answering (default 1). */
  fSearches?: number;
}

export interface ModelFake {
  client: ModelClient;
  requests: MessageCreateParamsNonStreaming[];
}

function message(content: unknown[], stopReason: string, model = "claude-opus-5-5"): Message {
  // Synthetic response object; only the fields the runner reads are filled in.
  return {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Message;
}

export function modelFake(opts: ModelFakeOptions = {}): ModelFake {
  const requests: MessageCreateParamsNonStreaming[] = [];
  let wrongPending = opts.wrongModelFirst ?? false;
  const client: ModelClient = {
    messages: {
      async create(params) {
        // What goes over the wire: JSON (the SDK format helper carries a parse function that is not sent).
        requests.push(JSON.parse(JSON.stringify(params)) as MessageCreateParamsNonStreaming);
        if (wrongPending) {
          wrongPending = false;
          return message([{ type: "text", text: "{}" }], "end_turn", "claude-some-other-model");
        }
        const first = params.messages[0]?.content;
        const prompt = typeof first === "string" ? first : "";
        if (opts.refuseWhen && prompt.includes(opts.refuseWhen)) return message([], "refusal");
        const isF = (params.tools ?? []).length > 0;
        if (!isF) {
          const metro = Object.keys(opts.lNames ?? {}).find((m) => prompt.includes(` in ${m},`));
          return message([{ type: "text", text: JSON.stringify({ names: metro ? opts.lNames![metro] : ["Unknown Example Bar"] }) }], "end_turn");
        }
        const searchesWanted = opts.fSearches ?? 1;
        const toolTurns = params.messages.filter((m) => m.role === "assistant").length;
        if (toolTurns < searchesWanted) {
          return message([{ type: "tool_use", id: `tu_${toolTurns + 1}`, name: "places_search", input: { query: `soccer pub ${toolTurns + 1}` } }], "tool_use");
        }
        const ids: string[] = [];
        for (const m of params.messages) {
          if (m.role !== "user" || typeof m.content === "string") continue;
          for (const block of m.content as ToolResultBlockParam[]) {
            if (block.type !== "tool_result" || block.is_error || typeof block.content !== "string") continue;
            for (const pl of JSON.parse(block.content) as { id: string }[]) if (!ids.includes(pl.id)) ids.push(pl.id);
          }
        }
        // Best first: reversed tool order, plus an id the tool never returned and a repeat.
        const answer = ["gp-never-returned", ...[...ids].reverse(), ...(ids[0] ? [ids[0]] : [])];
        return message([{ type: "text", text: JSON.stringify({ place_ids: answer }) }], "end_turn");
      },
    },
  };
  return { client, requests };
}

// ---------------------------------------------------------------------------
// Services wired to the fakes
// ---------------------------------------------------------------------------

export interface Harness {
  handle: ServiceHandle;
  qloo: QlooFake;
  places: PlacesFake;
  census: CensusFake;
  model: ModelFake;
  logs: string[];
}

export function harness(
  world: World,
  over: Partial<ServiceOptions> & { qlooOpts?: Parameters<typeof qlooFake>[1]; modelOpts?: ModelFakeOptions; placesOpts?: PlacesFakeOptions; robots?: string } = {},
): Harness {
  const { qlooOpts, modelOpts, placesOpts, robots, ...rest } = over;
  const qloo = qlooFake(world, qlooOpts);
  const places = placesFake(world, placesOpts);
  const census = censusFake(world, robots);
  const model = modelFake(modelOpts ?? { lNames: { Exampleton: ["Corner Flag Tavern", "Some Other Example Bar"] } });
  const logs: string[] = [];
  const handle = createServices({
    stateFile: ":memory:",
    spendFile: null,
    env: { QLOO_API_KEY: "test-qloo-key-not-real", GOOGLE_PLACES_API_KEY: "test-places-key-not-real" },
    qlooFetch: qloo.fetch,
    placesFetch: places.fetch,
    censusFetch: census.fetch,
    modelClient: model.client,
    usePlaces: true,
    maxQlooCalls: 900,
    placesDailyCap: 300,
    llmDailyCapUsd: 5,
    sleep: async () => {},
    limiter: noLimiter,
    censusIntervalMs: 0,
    now: () => FIXED_NOW,
    log: (line) => logs.push(line),
    ...rest,
  });
  return { handle, qloo, places, census, model, logs };
}
