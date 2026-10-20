import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryLedger } from "@walkup/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildSearch } from "../src/builders";
import { canonicalKey } from "../src/canonical";
import { QlooClient } from "../src/client";
import { errorEnvelope, errorStatus } from "../src/envelope";
import { QlooFixtureMissingError } from "../src/errors";
import {
  createFileFixtureStore,
  createMemoryFixtureStore,
  fixtureFileName,
  fixtureHash,
  parseFixture,
  syntheticFixtureFor,
} from "../src/fixtures";
import { fixtureConfig, forbiddenFetch, liveClient, okFetch } from "./helpers";
import * as S from "./synthetic";

const searchReq = buildSearch("Sidecar", ["person", "artist"]);

function fixtureClient(store = createMemoryFixtureStore()) {
  const ledger = createMemoryLedger();
  const client = new QlooClient({ config: fixtureConfig(), fixtures: store, ledger, fetch: forbiddenFetch, cache: null });
  return { client, ledger, store };
}

describe("fixture mode (replayer)", () => {
  it("replays a synthetic fixture and never touches the network", async () => {
    const store = createMemoryFixtureStore({ synthetic: { [fixtureHash(searchReq)]: { synthetic: true, body: S.searchSidecar } } });
    const { client, ledger } = fixtureClient(store);
    expect(client.mode).toBe("fixture");
    const r = await client.search("Sidecar", ["person", "artist"]);
    expect(r.value).toHaveLength(3);
    expect(r).toMatchObject({ source: "fixture-synthetic", synthetic: true, cacheHit: false, status: "ok" });
    const e = ledger.entries()[0]!;
    expect(e).toMatchObject({ envelopeStatus: "ok", resultCount: 3, cacheHit: false, httpStatus: null });
    expect(e.note).toContain("fixture replay: synthetic");
  });

  it("prefers fixtures/raw over fixtures/synthetic", async () => {
    const h = fixtureHash(searchReq);
    const store = createMemoryFixtureStore({
      raw: { [h]: { key: canonicalKey(searchReq), status: 200, recordedAt: "2026-10-20T10:00:00Z", body: S.searchSidecarMovie } },
      synthetic: { [h]: { synthetic: true, body: S.searchSidecar } },
    });
    const { client, ledger } = fixtureClient(store);
    const r = await client.search("Sidecar", ["person", "artist"]);
    expect(r.source).toBe("fixture-raw");
    expect(r.synthetic).toBe(false);
    expect(r.value[0]!.entityId).toBe(S.ID.sidecarMovie);
    expect(ledger.entries()[0]!.note).toContain("fixture replay: recorded 2026-10-20");
  });

  it("missing fixture -> typed error with a degraded ledger entry", async () => {
    const { client, ledger } = fixtureClient();
    const err = await client.heatmap({ signalEntities: [S.ID.actA], point: { lat: 36.1, lon: -86.7 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooFixtureMissingError);
    expect((err as QlooFixtureMissingError).ledgerRef).toBe("Q1");
    expect(ledger.entries()[0]).toMatchObject({ envelopeStatus: "degraded", httpStatus: null, resultCount: 0 });
    expect(errorStatus(err)).toEqual({ status: "degraded", reason: "No recorded answer for this request (fixture mode)", ledgerRef: "Q1" });
    const env = errorEnvelope(err, [] as unknown[], "Lift map");
    expect(env).toMatchObject({ status: "degraded", results: [], provenance: ["Q1"] });
  });

  it("ignores synthetic files that do not declare synthetic: true", () => {
    expect(parseFixture({ body: { results: [] } }, "synthetic")).toBeNull();
    expect(parseFixture({ results: [] }, "raw")).toMatchObject({ body: { results: [] }, synthetic: false, key: null });
    expect(parseFixture({ synthetic: true, results: [1] }, "synthetic")).toMatchObject({ body: { synthetic: true, results: [1] }, synthetic: true });
    expect(parseFixture([1, 2], "raw")).toBeNull();
  });

  it("a synthetic fixture may simulate an HTTP error", async () => {
    const store = createMemoryFixtureStore({ synthetic: { [fixtureHash(searchReq)]: { synthetic: true, status: 500, body: {} } } });
    const { client } = fixtureClient(store);
    await expect(client.search("Sidecar", ["person", "artist"])).rejects.toMatchObject({ status: 500 });
  });
});

describe("recorder (live mode, WALKUP_RECORD=1)", () => {
  it("writes bodies to raw/ keyed by sha256 of the canonical request", async () => {
    const fixtures = createMemoryFixtureStore();
    const { fetch } = okFetch(S.searchSidecar);
    const base = liveClient(fetch, { fixtures });
    const client = new QlooClient({
      config: { ...base.client.config, record: true },
      fetch,
      fixtures,
      cache: base.cache,
      limiter: { acquire: () => Promise.resolve() },
    });
    await client.search("Sidecar", ["person", "artist"]);
    const rec = fixtures.written.get(fixtureHash(searchReq));
    expect(rec).toBeDefined();
    expect(rec!.key).toBe(canonicalKey(searchReq));
    expect(rec!.status).toBe(200);
    expect(rec!.body).toEqual(S.searchSidecar);
  });

  it("does not record when recording is off", async () => {
    const fixtures = createMemoryFixtureStore();
    const { client } = liveClient(okFetch(S.searchSidecar).fetch, { fixtures });
    await client.search("Sidecar", ["person", "artist"]);
    expect(fixtures.written.size).toBe(0);
  });
});

describe("file fixture store", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("writes raw/, reads raw/ then synthetic/", () => {
    dir = mkdtempSync(join(tmpdir(), "walkup-qloo-fx-"));
    const store = createFileFixtureStore(dir);
    const h = fixtureHash(searchReq);
    expect(store.read(h)).toBeNull();

    const syn = syntheticFixtureFor(searchReq, S.searchSidecar);
    expect(syn.fileName).toBe(fixtureFileName(searchReq));
    mkdirSync(join(dir, "synthetic"), { recursive: true });
    writeFileSync(join(dir, "synthetic", syn.fileName), syn.content);
    expect(JSON.parse(syn.content)).toMatchObject({ synthetic: true, key: canonicalKey(searchReq), status: 200 });
    expect(store.read(h)).toMatchObject({ origin: "synthetic", synthetic: true });

    store.write(h, { key: "k", status: 200, body: { results: [] }, recordedAt: "2026-10-20T00:00:00Z" });
    expect(JSON.parse(readFileSync(join(dir, "raw", `${h}.json`), "utf8"))).toMatchObject({ key: "k" });
    expect(store.read(h)).toMatchObject({ origin: "raw", synthetic: false, recordedAt: "2026-10-20T00:00:00Z" });
    expect(store.has(h)).toBe(true);
  });

  it("drives a fixture-mode client from files on disk", async () => {
    dir = mkdtempSync(join(tmpdir(), "walkup-qloo-fx-"));
    const syn = syntheticFixtureFor(searchReq, S.searchSidecar);
    mkdirSync(join(dir, "synthetic"), { recursive: true });
    writeFileSync(join(dir, "synthetic", syn.fileName), syn.content);
    const client = new QlooClient({ config: fixtureConfig({ fixturesDir: dir }), fetch: forbiddenFetch, cache: null });
    const r = await client.resolveExact("Sidecar", ["person", "artist"], { requireComedianTag: true });
    expect(r.status).toBe("exact");
    expect(r.entity!.entityId).toBe(S.ID.sidecarPerson);
  });
});
