/** Unit tests: storage, presets and the selection rule, tag pins, receipts, helpers. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { LiftTile, StreetSheet } from "@walkup/contracts";
import { createMemoryLedger } from "@walkup/contracts";
import type { RankedTag } from "@walkup/qloo";
import { WORLD_EVENT_IDS, WORLD_TAG_PINS, WORLD_VENUES } from "@walkup/qloo-world";
import { createSqlitePlanStore, createSqliteStores } from "../src/store-sqlite";
import { spreadTiles } from "../src/steps/heat";
import {
  createDepsFromEnv,
  liveKeysPresent,
  applyG1Rule,
  applyReachedZips,
  baselineTagFor,
  callBudget,
  createMemoryChoiceStore,
  createMemoryPlanStore,
  createRunLedger,
  deniedReceipt,
  genreClass,
  getPlan,
  loadTagPins,
  defaultTagsFile,
  PRESETS,
  PRESET_IDS,
  presetVenueName,
  tagDiff,
  type StoredPlan,
} from "../src/index";
import { CLOCK_MS, deps } from "./helpers";

function tile(geohash: string, lat: number, lon: number, lift: number, extra: Partial<LiftTile> = {}): LiftTile {
  return { geohash, lat, lon, lift, billPct: 0.8, housePct: 0.4, popularityPct: 0.7, ...extra };
}

describe("plan store (SQLite)", () => {
  it("stores, reads, finds the latest plan for a preset and lists complete plans by preset and mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "walkup-orch-"));
    try {
      const store = createSqlitePlanStore(join(dir, "plans.sqlite"));
      const base = { mode: "fixture" as const, request: { presetId: "g1-a" }, presetId: "g1-a", sheet: { planId: "x" } as unknown as StreetSheet };
      const older: StoredPlan = { ...base, planId: "p1", createdAt: "2026-10-30T10:00:00.000Z", status: "complete" };
      const newer: StoredPlan = { ...base, planId: "p2", createdAt: "2026-10-30T11:00:00.000Z", status: "complete" };
      const paused: StoredPlan = { ...base, planId: "p3", createdAt: "2026-10-30T12:00:00.000Z", status: "needs_input" };
      store.put(older);
      store.put(newer);
      store.put(paused);
      expect((store.get("p1") as StoredPlan).createdAt).toBe(older.createdAt);
      expect(store.get("nope")).toBeNull();
      expect((store.latestForPreset("g1-a") as StoredPlan).planId).toBe("p2");
      expect((store.list(10) as StoredPlan[]).map((p) => p.planId)).toEqual(["p3", "p2", "p1"]);
      const live: StoredPlan = { ...base, planId: "p4", createdAt: "2026-10-30T09:00:00.000Z", status: "complete", mode: "live" };
      const other: StoredPlan = { ...base, planId: "p5", createdAt: "2026-10-30T13:00:00.000Z", status: "complete", mode: "live", presetId: "g2" };
      store.put(live);
      store.put(other);
      const ids = (filter: Parameters<typeof store.listComplete>[0], limit = 10) => (store.listComplete(filter, limit) as StoredPlan[]).map((p) => p.planId);
      expect(ids({ presetId: "g1-a" })).toEqual(["p2", "p1", "p4"]);
      expect(ids({ presetId: "g1-a", mode: "live" })).toEqual(["p4"]);
      expect(ids({ mode: "live" }, 1)).toEqual(["p5"]);
      expect(ids({})).toEqual(["p5", "p2", "p1", "p4"]);
      const memory = createMemoryPlanStore();
      for (const p of [older, newer, paused, live, other]) memory.put(p);
      expect((memory.listComplete({ presetId: "g1-a" }, 10) as StoredPlan[]).map((p) => p.planId)).toEqual(["p2", "p1", "p4"]);
      expect((memory.listComplete({ mode: "live" }, 1) as StoredPlan[]).map((p) => p.planId)).toEqual(["p5"]);
      store.close();
      const reopened = createSqlitePlanStore(join(dir, "plans.sqlite"));
      expect((reopened.get("p2") as StoredPlan).status).toBe("complete");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caches operator picks per (query, types) for 30 days", () => {
    const s = createSqliteStores(":memory:");
    s.choices.set("Sidecar", ["person", "artist"], "id-1", CLOCK_MS);
    expect(s.choices.get("sidecar", ["artist", "person"], CLOCK_MS + 1000)).toBe("id-1");
    expect(s.choices.get("Sidecar", ["artist", "person"], CLOCK_MS + 31 * 86_400_000)).toBeNull();
    s.close();
    const m = createMemoryChoiceStore();
    m.set("Sidecar", ["person"], "id-2", CLOCK_MS);
    expect(m.get("Sidecar", ["person"], CLOCK_MS)).toBe("id-2");
  });

  it("works end to end with planShow and getPlan", async () => {
    const stores = createSqliteStores(":memory:");
    const d = deps({ store: stores.plans, choices: stores.choices });
    const { planShow } = await import("../src/index");
    const r = await planShow({ presetId: "g1-b" }, d);
    const rec = await getPlan(stores.plans, r.planId);
    expect(rec?.sheet?.planId).toBe(r.planId);
    expect(rec?.mode).toBe("fixture");
    stores.close();
  });
});

describe("presets", () => {
  it("defines the goldens in one place", () => {
    expect(PRESET_IDS).toEqual(["g1-a", "g1-b", "g2", "g3", "g4-a", "g4-b"]);
    // The second live room: real Ticketmaster events at The Salt Shed, Chicago, paired; no sample of its own.
    expect(PRESETS["g4-a"].live?.tmEventId).toBe("vvG18Z_CM8zcsl");
    expect(PRESETS["g4-b"].live?.tmEventId).toBe("vv1kvZvPodGA5phKX");
    expect(PRESETS["g4-a"].live?.venue).toEqual({ name: "The Salt Shed", city: "Chicago", state: "IL" });
    expect(PRESETS["g4-a"].live?.tmVenueId).toBe("KovZ917AI5F");
    expect(PRESETS["g4-a"].live?.operator.capacity).toBe(3600);
    expect(PRESETS["g4-a"].pairedWith).toBe("g4-b");
    expect(PRESETS["g4-b"].pairedWith).toBe("g4-a");
    expect(PRESETS["g4-a"].fixtureSameAs).toBe("g1-a");
    expect(PRESETS["g4-b"].fixtureSameAs).toBe("g1-b");
    expect(PRESETS["g4-a"].live?.selection.result).toMatch(/two-night pass/);
    // Ticketmaster names the room "The Salt Shed Indoors (Shed)"; every run there keeps the preset's name.
    expect(presetVenueName("live", "KovZ917AI5F")).toBe("The Salt Shed");
    expect(presetVenueName("live", "no-such-venue")).toBeNull();
    expect(PRESETS["g1-a"].operator.seatsLeft).toBeNull();
    expect(PRESETS["g1-a"].operator.capacity).toBe(4400);
    expect(PRESETS["g1-a"].operator.mediaBudgetUsd).toBe(6000);
    expect(PRESETS["g1-a"].operator.streetTeamDays).toEqual(["thursday", "saturday"]);
    expect(PRESETS["g1-a"].operator.declaredPartners).toHaveLength(8);
    expect(PRESETS.g2.operator.capacity).toBeNull();
    // Stand-ins only for the thin act (Oct 15, probes 6 and 7); the headliner is his own seed.
    expect(PRESETS.g2.seeds?.map((s) => s.act)).toEqual(["Reggie Collier"]);
    expect(PRESETS.g3.venue.name).toBe("Super Funny Comedy Club");
    // Every bill is invented and no preset carries a seats-left count.
    for (const p of Object.values(PRESETS)) {
      expect(p.realShow).toBe(false);
      expect(p.operator.seatsLeft).toBeNull();
      expect(p.line).not.toMatch(/\{seats_left\}/);
    }
    for (const p of Object.values(PRESETS)) expect(p.operator.declaredPartners.every((d) => d.contactEmail === undefined)).toBe(true);
  });

  it("applies the G1 selection rule to the room's calendar", async () => {
    const d = deps();
    const tm = d.tm!(createMemoryLedger());
    const roster = await tm.eventsByVenue(WORLD_VENUES.truth.id, { startDateTime: "2026-10-30", size: 60 });
    const pick = applyG1Rule(roster.data);
    expect(pick).toEqual({ billA: WORLD_EVENT_IDS.g1a, billB: WORLD_EVENT_IDS.g1b });
    expect(PRESETS["g1-a"].tmEventId).toBe(pick.billA);
    expect(PRESETS["g1-b"].tmEventId).toBe(pick.billB);
    expect(applyG1Rule(roster.data, { from: "2027-03-01", to: "2027-03-31" })).toEqual({ billA: null, billB: null });
    expect(genreClass({ id: "x", classifications: [{ genre: { name: "Hip-Hop/Rap" } }] })).toBe("hiphop");
  });
});

describe("tag pins", () => {
  it("reads config/tags.json and skips every unpinned entry", () => {
    const pins = loadTagPins();
    expect(pins.source).toBe("config/tags.json");
    for (const urn of Object.values(pins.categories)) expect(urn.startsWith("urn:tag:")).toBe(true);
    expect(loadTagPins("/nonexistent/tags.json").categories).toEqual({});
  });

  it("finds the pins file from WALKUP_TAGS_FILE, else the nearest config/tags.json", () => {
    expect(defaultTagsFile({ WALKUP_TAGS_FILE: "/srv/app/config/tags.json" })).toBe(resolve("/srv/app/config/tags.json"));
    const found = defaultTagsFile({});
    expect(found.split("\\").join("/")).toMatch(/\/config\/tags\.json$/);
    expect(existsSync(found)).toBe(true);
  });

  it("picks the tag baseline by Ticketmaster genre", () => {
    // Comedy never gets a genre baseline, even when one is pinned (Oct 15, probe 19: the comedy tag map was empty).
    expect(baselineTagFor(WORLD_TAG_PINS, "Arts & Theatre / Comedy")).toBeNull();
    expect(baselineTagFor({ ...WORLD_TAG_PINS, baselineTags: { default: "urn:tag:genre:music:country" } }, "Arts & Theatre / Comedy")).toBeNull();
    expect(baselineTagFor(WORLD_TAG_PINS, "Music / Country")).toBe(WORLD_TAG_PINS.baselineTags.country);
    expect(baselineTagFor(WORLD_TAG_PINS, undefined)).toBe(WORLD_TAG_PINS.baselineTags.default);
  });
});

describe("denied-tag receipt", () => {
  it("counts distinct denied tags by reason without repeating names", () => {
    const r = deniedReceipt([
      { id: "urn:tag:ethnicity:qloo:x", name: "x" },
      { id: "urn:tag:ethnicity:qloo:x", name: "x" },
      { id: "urn:tag:inclusivity:qloo:y", name: "y" },
      { id: "urn:tag:credit_card:qloo:visa", name: "Visa" },
      { id: "urn:tag:genre:music:americana", name: "Americana" },
    ]);
    expect(r.count).toBe(3);
    expect(r.line).toBe("3 tags denied by policy (ethnicity/inclusivity/credit_card)");
    expect(deniedReceipt([{ id: "urn:tag:genre:music:americana", name: "Americana" }]).line).toBeNull();
  });
});

describe("helpers", () => {
  it("down-weights tiles whose ZIPs the operator already reaches", () => {
    const tiles = [tile("dn6mcc", 36.17, -86.75, 2, { zctas: ["37206"], adultPopulation: 10_000 }), tile("dn6mfq", 36.2, -86.7, 1.8, { zctas: ["37216"], adultPopulation: 10_000 })];
    const none = applyReachedZips(tiles, undefined);
    expect(none.adjusted).toBe(0);
    const r = applyReachedZips(tiles, [{ zip: "37206", count: 400 }]);
    expect(r.adjusted).toBe(1);
    expect(r.tiles[0]?.geohash).toBe("dn6mfq");
    expect(r.tiles.find((t) => t.geohash === "dn6mcc")?.lift).toBeCloseTo(1.2, 5);
  });

  it("spreads partner tiles at least 3 km apart", () => {
    const t = [tile("a", 36.1, -86.7, 3), tile("b", 36.101, -86.701, 2.9), tile("c", 36.2, -86.7, 2.5)];
    expect(spreadTiles(t).map((x) => x.geohash)).toEqual(["a", "c"]);
  });

  it("diffs two ranked tag lists for the compare fallback", () => {
    const rt = (id: string, rank: number): RankedTag => ({ id, name: id, rank, affinity: 1 - rank / 100, popularity: null });
    const bill = ["t1", "t2", "t3", "t4", "t5", "t6"].map((id, i) => rt(id, i + 1));
    const house = ["t6", "t5", "t4", "t9", "t8", "t7", "t1"].map((id, i) => rt(id, i + 1));
    const d = tagDiff(bill, house, 3);
    expect(d.fromTagDiff).toBe(true);
    expect(d.a.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(d.b.map((t) => t.id)).toEqual(["t6", "t5", "t9", "t8", "t7"]);
    expect(d.shared.map((t) => t.id)).toEqual(["t4"]);
  });

  it("counts fresh, cached and per-level calls from the ledger", () => {
    const base = createMemoryLedger();
    const ledger = createRunLedger(base, { fixture: true });
    const entry = { kind: "qloo" as const, method: "GET" as const, endpoint: "/v2/insights", params: {}, httpStatus: 200, envelopeStatus: "ok" as const, latencyMs: 0, bytes: 10, resultCount: 1, curl: "curl", startedAt: new Date(CLOCK_MS).toISOString() };
    ledger.node("Q4 bill heat", "bill");
    ledger.add({ ...entry, cacheHit: false });
    ledger.node("Q5 house heat", "venue");
    ledger.add({ ...entry, cacheHit: true });
    ledger.add({ ...entry, cacheHit: false });
    ledger.node("Q9", "bill");
    ledger.add({ ...entry, cacheHit: false, httpStatus: null, envelopeStatus: "degraded" });
    const b = callBudget(ledger.entries(), ledger);
    expect(b).toMatchObject({ qlooTotal: 4, qlooFresh: 2, qlooCached: 1, billLevel: 1, venueLevel: 1 });
    expect(ledger.entries()[0]?.note).toBe("node Q4 bill heat; fixture world: synthetic response");
  });
});

describe("deps from the environment", () => {
  it("falls back to the fixture world without keys, and never claims live", () => {
    expect(liveKeysPresent({})).toBe(false);
    expect(liveKeysPresent({ QLOO_API_KEY: "x", TICKETMASTER_API_KEY: "y", WALKUP_MODE: "fixture" })).toBe(false);
    expect(liveKeysPresent({ QLOO_API_KEY: "x", TICKETMASTER_API_KEY: "y" })).toBe(true);
    // Read like @walkup/qloo's config: an inline comment and case don't matter; recorded never runs live.
    expect(liveKeysPresent({ QLOO_API_KEY: "x", TICKETMASTER_API_KEY: "y", WALKUP_MODE: "Fixture   # auto | live | fixture" })).toBe(false);
    expect(liveKeysPresent({ QLOO_API_KEY: "x", TICKETMASTER_API_KEY: "y", WALKUP_MODE: "recorded" })).toBe(false);
    const d = createDepsFromEnv({ WALKUP_DATA_DIR: join(tmpdir(), "walkup-orch-env") });
    expect(d.mode).toBe("fixture");
    expect(d.world).toBeDefined();
    expect(d.narrator?.client).toBeNull();
  });
});

