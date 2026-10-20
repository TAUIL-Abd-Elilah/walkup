/**
 * checkSignals and the not_found fallback in resolveExact / resolveUsable.
 * Live behaviour these mocks follow (Oct 15): a place-insights call with take=1 answers 200 with
 * warnings[{type:"not_found","signal.interests.entities":[ids]}] listing only the ids Qloo has no
 * data for; a call whose ids are all unknown can also be a 400 on signal.interests.entities.
 */
import { describe, expect, it } from "vitest";
import { decideFallback } from "../src/resolve";
import { normalizeEntityList } from "../src/normalize";
import { liveClient, mockFetch, type MockCall } from "./helpers";
import * as S from "./synthetic";

const RYMAN_LIKE = { lat: 36.1612, lon: -86.7785 };

/** Mock Qloo: /search answers `search`; insights warn about any signal id in `notFound`. */
function world(search: unknown, notFound: string[], opts: { allInvalid400?: boolean } = {}) {
  return mockFetch((c: MockCall) => {
    if (c.url.pathname === "/search") return { body: search };
    if (c.url.pathname === "/v2/insights") {
      const ids = (c.url.searchParams.get("signal.interests.entities") ?? "").split(",").filter(Boolean);
      const dropped = ids.filter((id) => notFound.includes(id));
      if (opts.allInvalid400 && dropped.length === ids.length) return { status: 400, body: S.errorSignalNotFound };
      return { body: S.placeCheckWithWarning(dropped) };
    }
    return { status: 404, body: {} };
  });
}

describe("checkSignals", () => {
  it("sends one cheap place-insights call (take 1, 1500 m) and splits usable from dropped", async () => {
    const { fetch, calls } = world(S.searchWade, [S.ID.wadeSolo]);
    const { client, ledger } = liveClient(fetch);
    const r = await client.checkSignals([S.ID.wadeSolo, S.ID.wadeBand, S.ID.wadeSolo], RYMAN_LIKE);
    expect(calls).toHaveLength(1);
    const q = calls[0]!.url.searchParams;
    expect(q.get("filter.type")).toBe("urn:entity:place");
    expect(q.get("take")).toBe("1");
    expect(q.get("filter.location.radius")).toBe("1500");
    expect(q.get("signal.interests.entities")).toBe(`${S.ID.wadeSolo},${S.ID.wadeBand}`);
    expect(r).toMatchObject({ checked: [S.ID.wadeSolo, S.ID.wadeBand], usable: [S.ID.wadeBand], dropped: [S.ID.wadeSolo], cacheHit: false });
    expect(r.ledgerRefs).toEqual([ledger.entries()[0]!.id]);
    expect(ledger.entries()[0]!.note).toMatch(/signal check/);
    expect(ledger.entries()[0]!.note).toMatch(/not_found/);
    // Cached: a second check costs no call.
    const again = await client.checkSignals([S.ID.wadeSolo, S.ID.wadeBand], RYMAN_LIKE);
    expect(calls).toHaveLength(1);
    expect(again.cacheHit).toBe(true);
  });

  it("treats a 400 on signal.interests.entities as every id dropped; other errors throw", async () => {
    const { fetch } = world(S.searchWade, [S.ID.wadeSolo], { allInvalid400: true });
    const { client } = liveClient(fetch);
    const r = await client.checkSignals([S.ID.wadeSolo], RYMAN_LIKE);
    expect(r.usable).toEqual([]);
    expect(r.dropped).toEqual([S.ID.wadeSolo]);
    expect(r.ledgerRefs).toHaveLength(1);

    const broken = mockFetch(() => ({ status: 403, body: { errors: [{ message: "nope", path: "filter.type" }] } }));
    const c2 = liveClient(broken.fetch, { retry: { maxRetries: 0 } }).client;
    await expect(c2.checkSignals([S.ID.actA], RYMAN_LIKE)).rejects.toThrow(/HTTP 403/);
  });

  it("makes no call for an empty list and batches 25 ids per call", async () => {
    const { fetch, calls } = world(S.searchWade, []);
    const { client } = liveClient(fetch);
    expect((await client.checkSignals([], RYMAN_LIKE)).checked).toEqual([]);
    expect(calls).toHaveLength(0);
    const ids = Array.from({ length: 30 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const r = await client.checkSignals(ids, RYMAN_LIKE);
    expect(calls).toHaveLength(2);
    expect(r.usable).toHaveLength(30);
  });

  it("keeps a per-id ledger ref: each id points at the batch call that judged it", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const late = ids[27]!;
    const { fetch, calls } = world(S.searchWade, [late]);
    const { client, ledger } = liveClient(fetch);
    const r = await client.checkSignals(ids, RYMAN_LIKE);
    expect(calls).toHaveLength(2);
    expect(r.dropped).toEqual([late]);
    const [first, second] = ledger.entries().map((e) => e.id);
    expect(r.ledgerRefs).toEqual([first, second]);
    expect(Object.keys(r.ledgerRefById)).toHaveLength(30);
    expect(r.ledgerRefById[ids[0]!]).toBe(first);
    expect(r.ledgerRefById[ids[24]!]).toBe(first);
    expect(r.ledgerRefById[ids[25]!]).toBe(second);
    // The dropped id cites the second batch, the one whose warning named it.
    expect(r.ledgerRefById[late]).toBe(second);
    expect(ledger.entries()[1]!.note).toContain(late);
  });
});

describe("resolveExact with checkSignalAt (acts)", () => {
  it("replaces a not_found exact pick with the billing-name entry and records it", async () => {
    const { fetch, calls } = world(S.searchWade, [S.ID.wadeSolo]);
    const { client, ledger } = liveClient(fetch);
    const r = await client.resolveExact("Wade Corley", ["artist", "person"], { checkSignalAt: RYMAN_LIKE });
    expect(r.status).toBe("exact");
    expect(r.entity?.entityId).toBe(S.ID.wadeBand);
    expect(r.replaced).toEqual({ entityId: S.ID.wadeSolo, name: "Wade Corley", reason: "not_found", ledgerRef: ledger.entries()[1]!.id });
    // A different billing name is never a silent swap: the row says so.
    expect(r.reason).toBe(`"Wade Corley and The Low Ten" is billed under a different name, so check it's the same act.`);
    expect(r.ledgerRef).toBe(ledger.entries()[0]!.id);
    // One search plus one check that covered the pick and its alternate.
    expect(calls.map((c) => c.url.pathname)).toEqual(["/search", "/v2/insights"]);
    expect(calls[1]!.url.searchParams.get("signal.interests.entities")).toBe(`${S.ID.wadeSolo},${S.ID.wadeBand}`);
  });

  it("keeps a usable pick as it is (one check call, no replaced)", async () => {
    const { fetch, calls } = world(S.searchWade, []);
    const { client } = liveClient(fetch);
    const r = await client.resolveExact("Wade Corley", ["artist"], { checkSignalAt: RYMAN_LIKE });
    expect(r.status).toBe("exact");
    expect(r.entity?.entityId).toBe(S.ID.wadeSolo);
    expect(r.replaced).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("asks when several fallback entries are usable in the same tier", async () => {
    const search = {
      synthetic: true,
      results: [
        ...S.searchWade.results.slice(0, 2),
        { name: "Wade Corley with Strings", entity_id: S.ID.wadeTribute, types: ["urn:entity:artist"], popularity: 0.3, properties: {} },
      ],
    };
    const { fetch } = world(search, [S.ID.wadeSolo]);
    const { client } = liveClient(fetch);
    const r = await client.resolveExact("Wade Corley", ["artist"], { checkSignalAt: RYMAN_LIKE });
    expect(r.status).toBe("needs_input");
    expect(r.entity).toBeUndefined();
    expect(r.candidates?.map((c) => c.entityId)).toEqual([S.ID.wadeBand, S.ID.wadeTribute]);
    expect(r.replaced?.entityId).toBe(S.ID.wadeSolo);
    expect(r.reason).toMatch(/has no taste data\. Pick the entry/);
  });

  it("says so when entries in the deciding tier were never checked", async () => {
    // Seven billing-name entries: the check covers the pick plus five alternates, so two go unchecked.
    const extra = Array.from({ length: 7 }, (_, i) => ({
      name: `Wade Corley and Band ${i + 1}`,
      entity_id: `00000000-0000-4000-8000-0000000009${String(i).padStart(2, "0")}`,
      types: ["urn:entity:artist"],
      popularity: 0.5,
      properties: {},
    }));
    const search = { synthetic: true, results: [S.searchWade.results[0], ...extra] };
    const dropped = [S.ID.wadeSolo, ...extra.slice(0, 4).map((e) => e.entity_id)];
    const { fetch, calls } = world(search, dropped);
    const { client } = liveClient(fetch);
    const r = await client.resolveExact("Wade Corley", ["artist"], { checkSignalAt: RYMAN_LIKE, take: 10 });
    expect((calls[1]!.url.searchParams.get("signal.interests.entities") ?? "").split(",")).toHaveLength(6);
    expect(r.status).toBe("exact");
    expect(r.entity?.entityId).toBe(extra[4]!.entity_id);
    expect(r.reason).toContain("billed under a different name");
    expect(r.reason).toContain("2 other entries under this name weren't checked, so it may not be the only fit.");
  });

  it("is unresolved with a reason when nothing usable is left, and uses aliases before extensions", async () => {
    const { fetch } = world(S.searchWade, [S.ID.wadeSolo, S.ID.wadeBand]);
    const { client } = liveClient(fetch);
    const none = await client.resolveExact("Wade Corley", ["artist"], { checkSignalAt: RYMAN_LIKE });
    expect(none.status).toBe("unresolved");
    expect(none.entity).toBeUndefined();
    expect(none.reason).toMatch(/no taste data for it/);

    const viaAlias = await client.resolveExact("Wade Corley", ["artist"], { checkSignalAt: RYMAN_LIKE, aliases: ["Wade Corley Tribute Night"] });
    expect(viaAlias.status).toBe("exact");
    expect(viaAlias.entity?.entityId).toBe(S.ID.wadeTribute);
  });

  it("removes not_found entries from needs_input candidates", async () => {
    const { fetch } = world(S.searchSidecar, [S.ID.sidecarBand]);
    const { client } = liveClient(fetch);
    const r = await client.resolveExact("Sidecar", ["artist", "person"], { checkSignalAt: RYMAN_LIKE });
    expect(r.status).toBe("needs_input");
    expect(r.candidates?.map((c) => c.entityId)).toEqual([S.ID.sidecarPerson, S.ID.sidecarWeather]);
    expect(r.reason).toBe("Left out 1 match Qloo has no taste data for.");
  });

  it("never checks venues or runs a check without checkSignalAt", async () => {
    const { fetch, calls } = world(S.searchVenue, [S.ID.venue]);
    const { client } = liveClient(fetch);
    const v = await client.resolveExact("The Example Hall", ["place"], { nearPoint: RYMAN_LIKE, checkSignalAt: RYMAN_LIKE });
    expect(v.status).toBe("exact");
    expect(calls.every((c) => c.url.pathname === "/search")).toBe(true);

    const w = world(S.searchWade, [S.ID.wadeSolo]);
    const plain = await liveClient(w.fetch).client.resolveExact("Wade Corley", ["artist"]);
    // Without a check point the plain rule applies (one exact match), as before.
    expect(plain.status).toBe("exact");
    expect(plain.entity?.entityId).toBe(S.ID.wadeSolo);
    expect(w.calls.every((c) => c.url.pathname === "/search")).toBe(true);
  });
});

describe("decideFallback (pure)", () => {
  const ents = normalizeEntityList(S.searchWade).value;
  const solo = ents.find((e) => e.entityId === S.ID.wadeSolo)!;
  const band = ents.find((e) => e.entityId === S.ID.wadeBand)!;
  const tribute = ents.find((e) => e.entityId === S.ID.wadeTribute)!;
  const twin = { ...solo, entityId: "00000000-0000-4000-8000-000000000899" };

  it("uses a same-name entry with no note when its tier was fully checked", () => {
    const d = decideFallback("Wade Corley", [[twin]], new Set([solo.entityId, twin.entityId]), new Set([solo.entityId]));
    expect(d).toEqual({ kind: "use", entity: twin });
  });

  it("asks the operator when more than one usable entry fits", () => {
    const d = decideFallback("Wade Corley", [[], [], [band, tribute]], new Set([band.entityId, tribute.entityId]), new Set());
    expect(d.kind).toBe("ask");
    expect(d.candidates?.map((e) => e.entityId)).toEqual([band.entityId, tribute.entityId]);
  });

  it("notes unchecked entries in an earlier tier that had nothing usable", () => {
    const d = decideFallback("Wade Corley", [[twin], [], [band]], new Set([band.entityId]), new Set());
    expect(d.kind).toBe("use");
    expect(d.entity?.entityId).toBe(band.entityId);
    expect(d.note).toContain("One other entry under this name wasn't checked");
  });

  it("is none when no tier has a usable entry", () => {
    expect(decideFallback("Wade Corley", [[band]], new Set([band.entityId]), new Set([band.entityId]))).toEqual({ kind: "none" });
  });
});
