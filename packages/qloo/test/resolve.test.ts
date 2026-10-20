import { describe, expect, it } from "vitest";
import { normalizeEntityList } from "../src/normalize";
import { externalUrl, normalizeName, resolveFromEntities, toCandidate } from "../src/resolve";
import { liveClient, mockFetch, okFetch } from "./helpers";
import * as S from "./synthetic";

const ents = (body: unknown) => normalizeEntityList(body).value;

describe("normalizeName", () => {
  it.each([
    ["Beyoncé", "beyonce"],
    ["  BEYONCE ", "beyonce"],
    ["Simon & Garfunkel", "simon and garfunkel"],
    ["The Chicks", "chicks"],
    ["the  chicks!", "chicks"],
    ["Guns N' Roses", "guns n roses"],
    ["Sigur Rós", "sigur ros"],
    ["Mø", "mo"],
    ["Motörhead", "motorhead"],
    ["AC/DC", "ac dc"],
    ["The The", "the"],
    ["Sidecar", "sidecar"],
  ])("%s -> %s", (input, out) => {
    expect(normalizeName(input)).toBe(out);
  });
});

describe("resolveFromEntities", () => {
  it("ambiguous 'Sidecar' (comedian and band share the name) -> needs_input, exact matches first", () => {
    const r = resolveFromEntities("Sidecar", ents(S.searchSidecar), { ledgerRef: "Q1" });
    expect(r.status).toBe("needs_input");
    expect(r.entity).toBeUndefined();
    expect(r.ledgerRef).toBe("Q1");
    expect(r.candidates!.map((c) => c.entityId)).toEqual([S.ID.sidecarPerson, S.ID.sidecarBand, S.ID.sidecarWeather]);
    expect(r.candidates![0]).toEqual({
      entityId: S.ID.sidecarPerson,
      name: "Sidecar",
      subtype: "urn:entity:person",
      popularity: 0.71,
      shortDescription: "Stand-up comedian (synthetic)",
      externalUrl: "https://www.wikidata.org/wiki/Q100000001",
    });
    expect(r.candidates![1]!.externalUrl).toBe("https://open.spotify.com/artist/0SyntheticSpotifyId001");
  });

  it("comedy bill: the comedian tag makes 'Sidecar' exact", () => {
    const r = resolveFromEntities("Sidecar", ents(S.searchSidecar), { requireComedianTag: true });
    expect(r.status).toBe("exact");
    expect(r.entity!.entityId).toBe(S.ID.sidecarPerson);
  });

  it("comedy bill: an exact name without the comedian tag is not admissible", () => {
    const band = ents(S.searchSidecar).filter((e) => e.entityId !== S.ID.sidecarPerson);
    const r = resolveFromEntities("Sidecar", band, { requireComedianTag: true });
    expect(r.status).toBe("needs_input");
    expect(r.candidates![0]!.entityId).toBe(S.ID.sidecarBand);
  });

  it("diacritics, ampersands and a leading 'The' still match exactly", () => {
    const list = ents(S.searchDiacritics);
    expect(resolveFromEntities("Beyonce", list).entity?.entityId).toBe(S.ID.beyonce);
    expect(resolveFromEntities("simon and garfunkel", list).entity?.entityId).toBe(S.ID.simonGarfunkel);
    expect(resolveFromEntities("Chicks", list).entity?.entityId).toBe(S.ID.theChicks);
    expect(resolveFromEntities("Beyoncé", list).status).toBe("exact");
  });

  it("no exact match but results -> needs_input with at most 5 candidates", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...ents(S.searchDiacritics)[0]!, entityId: `id-${i}`, name: `Beyoncé Tribute ${i}` }));
    const r = resolveFromEntities("Beyonce", many);
    expect(r.status).toBe("needs_input");
    expect(r.candidates).toHaveLength(5);
  });

  it("no results -> unresolved; role is carried", () => {
    expect(resolveFromEntities("Anyone", [], { role: "support" })).toEqual({ input: "Anyone", role: "support", status: "unresolved" });
    expect(resolveFromEntities("!!!", ents(S.searchDiacritics)).status).toBe("unresolved");
  });

  it("candidates carry release year and an IMDb link for titles", () => {
    const c = toCandidate(ents(S.searchSidecarMovie)[0]!);
    expect(c).toMatchObject({ releaseYear: 1987, externalUrl: "https://www.imdb.com/title/tt0000001/", shortDescription: "Road movie (synthetic)" });
    expect(externalUrl({ ...ents(S.searchSidecarMovie)[0]!, external: undefined })).toBeUndefined();
  });
});

describe("client.resolveExact", () => {
  it("searches typed and resolves the comedian", async () => {
    const { fetch, calls } = okFetch(S.searchSidecar);
    const { client } = liveClient(fetch);
    const r = await client.resolveExact("Sidecar", ["person", "artist"], { requireComedianTag: true });
    expect(r).toMatchObject({ status: "exact", role: "headliner", ledgerRef: "Q1" });
    expect(calls[0]!.url.searchParams.get("types")).toBe("urn:entity:person,urn:entity:artist");
    expect(calls[0]!.url.searchParams.get("take")).toBe("10");
  });

  it("venues search near a point within 1 mile and default to role venue", async () => {
    const { fetch, calls } = mockFetch(() => ({ body: S.searchVenue }));
    const { client } = liveClient(fetch);
    const r = await client.resolveExact("Example Hall", ["place"], { nearPoint: { lat: 36.1612, lon: -86.7785 } });
    expect(r).toMatchObject({ status: "exact", role: "venue" });
    expect(r.entity!.entityId).toBe(S.ID.venue);
    const q = calls[0]!.url.searchParams;
    expect(q.get("filter.location")).toBe("36.1612,-86.7785");
    expect(q.get("filter.radius")).toBe("1");
  });

  it("404 from /search -> unresolved", async () => {
    const { fetch } = mockFetch(() => ({ status: 404, body: {} }));
    const { client } = liveClient(fetch);
    const r = await client.resolveExact("Nobody", ["artist"]);
    expect(r.status).toBe("unresolved");
    expect(r.ledgerRef).toBe("Q1");
  });
});
