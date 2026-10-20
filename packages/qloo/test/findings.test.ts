/**
 * One test per finding of the Oct 15 live shape audit (F1-F17). Bodies are small,
 * hand-written and synthetic; they copy live field names and placement, never values.
 */
import { describe, expect, it } from "vitest";
import { errorStatus } from "../src/envelope";
import { isSignalNotFoundError, parseQlooErrors, QlooHttpError } from "../src/errors";
import { droppedSignalIds, normalizeCompare, normalizeHeatmap, normalizeTagList, responseMeta, responseWarnings } from "../src/normalize";
import { extendsName, resolveFromEntities, sameAct, signalAlternates } from "../src/resolve";
import { normalizeEntityList } from "../src/normalize";
import { liveClient, mockFetch, okFetch } from "./helpers";
import * as S from "./synthetic";

const P = { lat: 36.1612, lon: -86.7785 };

describe("F1 external ids: /search and /entities use properties.external", () => {
  it("entitiesByExternal matches Spotify ids that sit under properties.external.spotify = {id}", async () => {
    const { fetch } = okFetch(S.entitiesBySpotify);
    const { client } = liveClient(fetch);
    const r = await client.entitiesByExternal("spotify", ["1SyntheticSpotifyId001"]);
    expect(r.value.matches).toEqual([{ externalId: "1SyntheticSpotifyId001", entityId: S.ID.actA }]);
    expect(r.value.missing).toEqual([]);
  });
});

describe("F2 warnings: not_found signal ids are surfaced, never silent", () => {
  it("parses the live warnings shape (dotted parameter name as a literal key)", () => {
    const body = S.placeCheckWithWarning([S.ID.wadeSolo]);
    expect(responseWarnings(body)).toEqual([{ type: "not_found", param: "signal.interests.entities", ids: [S.ID.wadeSolo] }]);
    expect(droppedSignalIds(responseWarnings(body))).toEqual([S.ID.wadeSolo]);
    expect(responseMeta(body)).toEqual({ warnings: [{ type: "not_found", param: "signal.interests.entities", ids: [S.ID.wadeSolo] }], droppedSignals: [S.ID.wadeSolo] });
  });

  it("reads a./b. compare params, ignores other warning types and odd shapes", () => {
    const w = responseWarnings({
      warnings: [
        { type: "not_found", "a.signal.interests.entities": ["x1"], "b.signal.interests.entities": ["x2", "x1"] },
        { type: "not_found", "filter.results.entities": ["p1"] },
        { type: "deprecated", message: "something" },
        "plain text",
        null,
      ],
    });
    expect(droppedSignalIds(w)).toEqual(["x1", "x2"]);
    expect(w.some((x) => x.type === "deprecated" && x.message === "something")).toBe(true);
    expect(responseWarnings({ results: {} })).toEqual([]);
    expect(responseWarnings(null)).toEqual([]);
  });

  it("the client notes the drop in the ledger, marks the entry partial and exposes meta.droppedSignals", async () => {
    const { fetch } = okFetch(S.placeCheckWithWarning([S.ID.wadeSolo]));
    const { client, ledger } = liveClient(fetch);
    const r = await client.placeInsights({ signalEntities: [S.ID.wadeSolo, S.ID.actA], point: P, radiusM: 4000, take: 5 });
    expect(r.meta?.droppedSignals).toEqual([S.ID.wadeSolo]);
    const e = ledger.entries()[0]!;
    expect(e.envelopeStatus).toBe("partial");
    expect(e.note).toContain(`Qloo ignored 1 signal id it has no taste data for (not_found): ${S.ID.wadeSolo}`);
    // A cache hit replays the same note.
    await client.placeInsights({ signalEntities: [S.ID.wadeSolo, S.ID.actA], point: P, radiusM: 4000, take: 5 });
    expect(ledger.entries()[1]!.cacheHit).toBe(true);
    expect(ledger.entries()[1]!.envelopeStatus).toBe("partial");
  });

  it("entityInsights (brands, podcasts) carry droppedSignals too", async () => {
    const { fetch } = okFetch(S.placeCheckWithWarning([S.ID.wadeSolo]));
    const { client } = liveClient(fetch);
    const r = await client.entityInsights("brand", { signalEntities: [S.ID.wadeSolo], signalLocationPoint: P, take: 5 });
    expect(r.meta?.droppedSignals).toEqual([S.ID.wadeSolo]);
  });
});

describe("F3/F4 errors: {errors:[{message,path}]} and the all-invalid signal 400", () => {
  it("parses the error body and flags a signal.interests.entities 400", () => {
    expect(parseQlooErrors(JSON.stringify(S.errorSignalNotFound))).toEqual([{ message: "No valid signal entity (synthetic message)", path: "signal.interests.entities" }]);
    expect(parseQlooErrors("not json")).toEqual([]);
    expect(parseQlooErrors({ error: { message: "old shape" } })).toEqual([]);
    const err = new QlooHttpError(400, "", "/v2/insights", parseQlooErrors(S.errorSignalNotFound));
    expect(isSignalNotFoundError(err)).toBe(true);
    expect(isSignalNotFoundError(new QlooHttpError(400, "", "/v2/insights", [{ message: "bad", path: "filter.type" }]))).toBe(false);
    expect(isSignalNotFoundError(new QlooHttpError(500, "", "/v2/insights", parseQlooErrors(S.errorSignalNotFound)))).toBe(false);
  });

  it("the client keeps the parsed errors on the thrown error, notes the blamed param and errorStatus says why", async () => {
    const { fetch } = mockFetch(() => ({ status: 400, body: S.errorSignalNotFound }));
    const { client, ledger } = liveClient(fetch);
    // Live: entity insights with only not_found ids and nothing else to rank by are a 400 (a heatmap is a 200 with cells).
    const err = await client.entityInsights("brand", { signalEntities: [S.ID.wadeSolo], take: 5 }).catch((e: unknown) => e);
    expect(isSignalNotFoundError(err)).toBe(true);
    expect((err as QlooHttpError).qlooErrors[0]!.path).toBe("signal.interests.entities");
    expect(ledger.entries()[0]!.note).toContain("Qloo blamed signal.interests.entities");
    const s = errorStatus(err);
    expect(s.status).toBe("error");
    expect(s.reason).toMatch(/no taste data for any act sent/);
  });
});

describe("F5 all-not_found signal plus signal.location", () => {
  it("droppedSignals covers every seed id, so callers can tell a location-only ranking apart", async () => {
    const { fetch } = okFetch(S.placeCheckWithWarning([S.ID.wadeSolo]));
    const { client } = liveClient(fetch);
    const seeds = [S.ID.wadeSolo];
    const r = await client.entityInsights("brand", { signalEntities: seeds, signalLocationPoint: P, take: 5 });
    expect(seeds.every((id) => r.meta?.droppedSignals?.includes(id))).toBe(true);
  });
});

describe("F7 heatmap shape", () => {
  it("affinity_rank is kept as the 0-1 fraction Qloo sends; entity_artist_* fields are ignored", () => {
    const n = normalizeHeatmap({
      success: true,
      results: {
        heatmap: [
          { location: { geohash: "dn6m9p", latitude: 36.16, longitude: -86.78 }, query: { affinity: 0.97, affinity_rank: 0.4706, popularity: 0.8, entity_artist_affinity: 0.97, entity_artist_affinity_rank: 0.4706 } },
        ],
      },
    });
    expect(n.value).toEqual([{ geohash: "dn6m9p", lat: 36.16, lon: -86.78, affinity: 0.97, affinityRank: 0.4706, popularity: 0.8 }]);
    expect(n.reason).toBeUndefined();
    expect(responseMeta({ success: true, results: { heatmap: [] } })).toEqual({});
  });
});

describe("F9 compare ignores take", () => {
  it("the client cuts shared, a and b to take", async () => {
    const { fetch, calls } = okFetch(S.compareLong);
    const { client } = liveClient(fetch);
    const r = await client.compare([S.ID.actA], [S.ID.houseA], 3);
    expect(calls[0]!.url.searchParams.get("take")).toBe("3");
    expect([r.value.shared.length, r.value.a.length, r.value.b.length]).toEqual([3, 3, 3]);
    expect(r.value.shared[0]!.score).toBe(0.9);
    // Without take nothing is cut.
    const all = normalizeCompare(S.compareLong).value;
    expect([all.shared.length, all.a.length, all.b.length]).toEqual([6, 5, 4]);
  });
});

describe("F10 urn:tag profile shape", () => {
  it("reads tag_id, subtype (namespace), types[] (entity types) and tag_value; no id/type fields", () => {
    const n = normalizeTagList({
      success: true,
      results: {
        tags: [
          { tag_id: "urn:tag:genre:music:country", name: "Country", subtype: "urn:tag:genre:music", types: ["urn:entity:artist", "urn:entity:album"], tag_value: "urn:tag:genre:music:country", popularity: 0.9, query: { affinity: 0.99 } },
        ],
      },
    });
    expect(n.value).toEqual([
      { id: "urn:tag:genre:music:country", name: "Country", type: "urn:tag:genre:music", subtype: "urn:tag:genre:music", rank: 1, affinity: 0.99, popularity: 0.9, parents: ["urn:entity:artist", "urn:entity:album"] },
    ]);
  });
});

describe("F12 place insights fields", () => {
  it("projects zip from localities, drops the always-null neighborhood, keeps numeric rating and closed-flag hours", () => {
    const bar = normalizeEntityList(S.placeInsights).value[0]!;
    expect(bar.properties.zip).toBe("37999");
    expect(bar.properties).not.toHaveProperty("neighborhood");
    expect(bar.properties.business_rating).toBe(4.6);
    expect((bar.properties.hours as Record<string, unknown>).monday).toEqual([{ closed: true, opens: null, closes: null }]);
    expect(bar.location?.geohash).toHaveLength(12);
  });
});

describe("F13 explainability units", () => {
  it("per-row scores are kept as shares (they sum to 1 on live rows); the aggregate passes through", () => {
    const bar = normalizeEntityList(S.placeInsights).value[0]!;
    const sum = (bar.explainability ?? []).reduce((s, c) => s + c.score, 0);
    expect(sum).toBeCloseTo(1, 6);
    const meta = responseMeta(S.placeInsights);
    expect(Object.keys((meta.explainability as Record<string, Record<string, unknown>>)["signal.interests.entities"]!)).toEqual(["effect_on_all_recs", "effect_on_top3_recs"]);
  });
});

describe("Q1 not_found fallback helpers", () => {
  it("extendsName matches billing names only", () => {
    expect(extendsName("Wade Corley", "Wade Corley and The Low Ten")).toBe(true);
    expect(extendsName("Wade Corley", "Wade Corley & The Low Ten")).toBe(true);
    expect(extendsName("Wade Corley", "Wade Corley with Strings")).toBe(true);
    expect(extendsName("Wade Corley", "Wade Corley Tribute Night")).toBe(false);
    expect(extendsName("Wade Corley", "Wade Corley")).toBe(false);
    expect(extendsName("Wade", "Wade Corley and The Low Ten")).toBe(false);
  });

  it("signalAlternates orders exact matches, then aliases, then billing-name extensions", () => {
    const ents = normalizeEntityList(S.searchWade).value;
    const tiers = signalAlternates("Wade Corley", ents, { exclude: new Set([S.ID.wadeSolo]), aliases: ["Wade Corley Tribute Night"] });
    expect(tiers.map((t) => t.map((e) => e.entityId))).toEqual([[], [S.ID.wadeTribute], [S.ID.wadeBand], []]);
  });
});

describe("Q1 artist and person entries for one musician (live /search, Oct 15)", () => {
  const ents = () => normalizeEntityList(S.searchMusicianPair).value;

  it("an artist entry plus the musician's person entry resolve to the artist, not needs_input", () => {
    const r = resolveFromEntities("Wade Corley", ents(), { role: "headliner" });
    expect(r.status).toBe("exact");
    expect(r.entity?.entityId).toBe(S.ID.wadeSolo);
    expect(sameAct(ents()[0]!, ents()[1]!)).toBe(true);
  });

  it("a shared Spotify, MusicBrainz or Wikidata id also links the pair; a comedian and a band stay ambiguous", () => {
    const [artist, person] = ents();
    const plainPerson = { ...person!, tags: [], external: { musicbrainz: { id: "mb-wade" } } };
    expect(sameAct({ ...artist!, external: { musicbrainz: { id: "mb-wade" } } }, plainPerson)).toBe(true);
    expect(sameAct({ ...artist!, external: { musicbrainz: { id: "mb-other" } } }, plainPerson)).toBe(false);
    const sidecar = resolveFromEntities("Sidecar", normalizeEntityList(S.searchSidecar).value);
    expect(sidecar.status).toBe("needs_input");
  });

  it("one entity id listed as artist and as person counts once", () => {
    const dup = normalizeEntityList({ results: [
      { name: "Wade Corley", entity_id: S.ID.wadeBand, types: ["urn:entity:artist"], properties: {} },
      { name: "Wade Corley", entity_id: S.ID.wadeBand, types: ["urn:entity:person"], properties: {} },
    ] }).value;
    const r = resolveFromEntities("Wade Corley", dup);
    expect(r).toMatchObject({ status: "exact", entity: { entityId: S.ID.wadeBand, subtype: "urn:entity:artist" } });
  });

  it("with a not_found artist entry, the billing-name artist beats the musician's person entry", async () => {
    const { fetch } = mockFetch((c) => {
      if (c.url.pathname === "/search") return { body: S.searchMusicianPair };
      const ids = (c.url.searchParams.get("signal.interests.entities") ?? "").split(",");
      return { body: S.placeCheckWithWarning(ids.filter((id) => id === S.ID.wadeSolo)) };
    });
    const { client } = liveClient(fetch);
    const r = await client.resolveExact("Wade Corley", ["artist", "person"], { take: 5, checkSignalAt: P });
    expect(r.status).toBe("exact");
    expect(r.entity?.entityId).toBe(S.ID.wadeBand);
    expect(r.replaced?.entityId).toBe(S.ID.wadeSolo);
  });
});
