/**
 * The popularity check on the fixture world: one no-signal twin per partner
 * pool (same request otherwise), the number on the sheet with its receipts, the
 * cache, and the typed fallback (a failed or empty twin: no number, the step
 * says why, the list is unchanged).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { LedgerEntry, StreetSheet } from "@walkup/contracts";
import { popularitySentence } from "@walkup/engine";
import { createWorld, type World } from "@walkup/qloo-world";
import { POPULARITY_LIMIT, POPULARITY_TWIN_NODE } from "../src/steps/partners";
import { deps, runPreset, sheetOf } from "./helpers";

const isTwin = (e: LedgerEntry) => (e.note ?? "").includes(`node ${POPULARITY_TWIN_NODE}`);
const isPool = (e: LedgerEntry) => /node Q9 partners, (tile \d|near venue)(;| \()/.test(e.note ?? "") && !/rebalanced/.test(e.note ?? "");
const noSignalPlace = (u: URL) =>
  u.pathname === "/v2/insights" && u.searchParams.get("filter.type") === "urn:entity:place" && !u.searchParams.has("signal.interests.entities") && !u.searchParams.has("signal.interests.tags");

function wrap(world: World, answer: (u: URL) => Response | null): World {
  const qlooFetch: World["qlooFetch"] = async (url, init) => answer(new URL(url)) ?? world.qlooFetch(url, init);
  return { ...world, qlooFetch };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let a: StreetSheet;
let g3: StreetSheet;

beforeAll(async () => {
  const d = deps();
  a = sheetOf((await runPreset("g1-a", d)).final);
  g3 = sheetOf((await runPreset("g3", d)).final);
}, 60_000);

describe("popularity twin", () => {
  it("replays each pool's last request with no signal and no explainability, nothing else changed", () => {
    const twins = a.ledger.filter(isTwin);
    const areas = new Set(a.cards.partners.results.map((p) => p.tileGeohash ?? "near-venue"));
    expect(twins.length).toBe(areas.size);
    for (const t of twins) {
      const where = /node Q9 popularity twin, (tile \d|near venue)/.exec(t.note ?? "")?.[1];
      // The pool the twin replays: the last Q9 call for the same place (after any widening).
      const pool = a.ledger.filter((e) => isPool(e) && (e.note ?? "").includes(`partners, ${where}`)).at(-1)!;
      const { "signal.interests.entities": sig, "feature.explainability": explain, ...rest } = pool.params;
      expect(sig).toBeDefined();
      expect(explain).toBe(true);
      expect(t.params).toEqual(rest);
      expect(t.method).toBe("GET");
    }
  });

  it("puts the number on the sheet, cited and consistent with the partner list", () => {
    const c = a.popularityCheck!;
    expect(c).toBeDefined();
    expect(c.partners).toBe(a.cards.partners.results.length);
    expect(c.notInPopularTop).toBe(c.perArea.reduce((s, r) => s + r.notInPopularTop, 0));
    expect(c.notInPopularTop).toBeGreaterThan(0);
    expect(c.notInPopularTop).toBeLessThanOrEqual(c.partners);
    for (const r of c.perArea) {
      expect(r.partners).toBe(a.cards.partners.results.filter((p) => p.tileGeohash === r.tileGeohash).length);
      expect(isTwin(a.ledger.find((e) => e.id === r.ledgerRef)!)).toBe(true);
    }
    expect(c.ledgerRefs).toEqual(c.perArea.map((r) => r.ledgerRef));
    for (const ref of c.ledgerRefs) expect(a.cards.partners.provenance).toContain(ref);
    expect(a.cards.partners.limits).toContain(POPULARITY_LIMIT);
    const step = a.steps?.find((s) => s.id === "partners-popular");
    expect(step?.status).toBe("ok");
    expect(step?.decision).toContain(`${c.notInPopularTop} of the ${c.partners} partners wouldn't make a list of the most popular places in their areas`);
    expect(step?.ledgerRefs).toEqual(c.ledgerRefs);
    expect(popularitySentence(c)).toBe(`${c.notInPopularTop} of the ${c.partners} partners would not make a list of the most popular places in their areas.`);
  });

  it("works for a near-venue list too (G3: no lift map)", () => {
    const c = g3.popularityCheck!;
    expect(c.perArea).toHaveLength(1);
    expect(c.perArea[0]!.tileGeohash).toBeNull();
    expect(popularitySentence(c)).toMatch(/near the venue\.$/);
  });

  it("comes from the cache on a re-run", async () => {
    const d = deps();
    await runPreset("g1-a", d);
    const again = (await runPreset("g1-a", d)).final;
    expect(Object.keys(again.budget.byNode).some((n) => n.startsWith(POPULARITY_TWIN_NODE))).toBe(false);
    expect(sheetOf(again).popularityCheck).toEqual(a.popularityCheck);
  });
});

describe("popularity twin fallbacks", () => {
  it("a failed twin: no number, no limit line, the step says why, and the partner list is unchanged", async () => {
    const s = sheetOf((await runPreset("g1-a", deps({ world: wrap(createWorld(), (u) => (noSignalPlace(u) ? json(500, { synthetic: true, error: { message: "synthetic failure" } }) : null)) }))).final);
    expect(s.popularityCheck).toBeUndefined();
    expect(s.cards.partners.limits).not.toContain(POPULARITY_LIMIT);
    expect(s.cards.partners.results.map((p) => p.entity.entityId)).toEqual(a.cards.partners.results.map((p) => p.entity.entityId));
    expect(s.cards.partners.status).toBe(a.cards.partners.status);
    expect(s.cards.partners.summary).toBe(a.cards.partners.summary);
    const step = s.steps?.find((x) => x.id === "partners-popular");
    expect(step).toMatchObject({ status: "partial", decision: "Skipped the popularity check." });
    expect(step?.cause).toMatch(/failed or came back empty for area 1 \(Qloo returned HTTP 500\)/);
    expect(s.ledger.filter(isTwin).every((e) => e.httpStatus === 500)).toBe(true);
  });

  it("the month guard: a refused twin sends nothing, counts as no fresh call, and leaves no number", async () => {
    // The third house twin is the last call before the popularity twins; its answer reports a quota under the floor.
    const world = createWorld();
    let houseTwins = 0;
    const guarded = wrap(world, (u) => {
      const houseTwin = u.searchParams.get("filter.type") === "urn:entity:place" && u.searchParams.has("filter.price_level.max") && !u.searchParams.has("feature.explainability") && !noSignalPlace(u);
      if (houseTwin && ++houseTwins === 3) world.setScenario({ quotaRemaining: 1400 });
      return null;
    });
    const r = (await runPreset("g1-a", deps({ world: guarded }))).final;
    const s = sheetOf(r);
    expect(s.popularityCheck).toBeUndefined();
    const twins = s.ledger.filter(isTwin);
    expect(twins.length).toBeGreaterThan(0);
    for (const t of twins) expect(t).toMatchObject({ httpStatus: null, cacheHit: false });
    expect(twins.every((t) => /month guard/.test(t.note ?? ""))).toBe(true);
    expect(Object.keys(r.budget.byNode).some((n) => n.startsWith(POPULARITY_TWIN_NODE))).toBe(false);
    expect(s.steps?.find((x) => x.id === "partners-popular")).toMatchObject({ status: "partial", decision: "Skipped the popularity check." });
    expect(s.cards.partners.results.map((p) => p.entity.entityId)).toEqual(a.cards.partners.results.map((p) => p.entity.entityId));
  });

  it("an empty twin: no number, and the step says nothing came back", async () => {
    const s = sheetOf((await runPreset("g1-a", deps({ world: wrap(createWorld(), (u) => (noSignalPlace(u) ? json(200, { synthetic: true, success: true, results: { entities: [] } }) : null)) }))).final);
    expect(s.popularityCheck).toBeUndefined();
    expect(s.steps?.find((x) => x.id === "partners-popular")?.cause).toMatch(/area 1 \(no places came back\)/);
    expect(s.cards.partners.results.map((p) => p.entity.entityId)).toEqual(a.cards.partners.results.map((p) => p.entity.entityId));
  });
});
