/**
 * End to end on the fixture world, all four presets: statuses and fallbacks
 * per card, citations traced to the ledger, zero guard drops, the call budget,
 * the age rule, denied tags kept out of copy, bill specificity (G1-A vs G1-B).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Envelope, StreetSheet } from "@walkup/contracts";
import { LIMITS_EVERY_SHEET } from "@walkup/contracts";
import { findAlcoholTerm, findDeniedTerm, isDeniedTag } from "@walkup/engine";
import { BUDGET_TARGET, CARD_ORDER, createMemoryChoiceStore, createMemoryPlanStore, type CallBudget, type CardKey, type PlanResult } from "../src/index";
import { MIN_BILL_PCT, SPLIT_HALF_NODE } from "../src/steps/heat";
import { HOUSE_TWIN_CHIP, HOUSE_TWIN_NODE, PARTNER_TILES, POPULARITY_TWIN_NODE } from "../src/steps/partners";
import { allEntities, citedRefs, deps, runPreset, sheetOf } from "./helpers";

/** Trust-check calls in a budget: split-half heatmaps (bill halves, house halves), partner house twins and popularity twins. */
function checks(b: CallBudget): { billHalves: number; houseHalves: number; twins: number; popular: number; bill: number; venue: number; total: number } {
  let billHalves = 0;
  let houseHalves = 0;
  let twins = 0;
  let popular = 0;
  for (const [node, n] of Object.entries(b.byNode)) {
    if (node.endsWith(SPLIT_HALF_NODE)) {
      if (node.startsWith("Q4 ")) billHalves += n;
      else if (node.startsWith("Q5 ")) houseHalves += n;
    }
    if (node.startsWith(HOUSE_TWIN_NODE)) twins += n;
    if (node.startsWith(POPULARITY_TWIN_NODE)) popular += n;
  }
  const bill = billHalves + twins + popular;
  return { billHalves, houseHalves, twins, popular, bill, venue: houseHalves, total: bill + houseHalves };
}

const runs: Record<string, { first: PlanResult; final: PlanResult; cards: CardKey[] }> = {};
const store = createMemoryPlanStore();
const choices = createMemoryChoiceStore();

beforeAll(async () => {
  const d = deps({ store, choices });
  for (const id of ["g1-a", "g1-b", "g2", "g3"]) {
    const cards: CardKey[] = [];
    const r = await runPreset(id, d, { onCard: (k) => cards.push(k) });
    runs[id] = { ...r, cards };
  }
}, 120_000);

const sheet = (id: string): StreetSheet => sheetOf(runs[id]!.final);

describe("every preset", () => {
  for (const id of ["g1-a", "g1-b", "g2", "g3"]) {
    describe(id, () => {
      it("completes in fixture mode with every card and the five limits", () => {
        const r = runs[id]!.final;
        expect(r.status).toBe("complete");
        const s = sheet(id);
        expect(s.mode).toBe("fixture");
        expect(Object.keys(s.cards).sort()).toEqual([...CARD_ORDER].sort());
        for (const line of LIMITS_EVERY_SHEET) expect(s.limits).toContain(line);
        expect(s.limits.some((l) => /^Sample data/.test(l))).toBe(true);
        for (const [k, env] of Object.entries(s.cards) as [string, Envelope<unknown>][]) {
          if (env.status !== "ok") expect(env.reason, k).toBeTruthy();
        }
      });

      it("streams the cards in spec order", () => {
        const seen = runs[id]!.cards;
        const final = id === "g2" ? seen.slice(1) : seen; // g2 streamed the paused resolution card first
        expect(final).toEqual([...CARD_ORDER]);
      });

      it("traces every cited id to this run's ledger", () => {
        const s = sheet(id);
        const r = runs[id]!.final;
        const ids = new Set(s.ledger.map((e) => e.id));
        for (const ref of citedRefs(s)) expect(ids.has(ref), ref).toBe(true);
        const cited = [
          ...s.cards.partners.results.map((p) => p.entity.entityId),
          ...s.cards.prePost.results.map((x) => x.entity.entityId),
          ...s.cards.media.results.map((m) => m.entity.entityId),
          ...s.cards.declared.results.filter((d) => d.entity).map((d) => d.entity!.entityId),
          ...(s.narration?.partnerLines ?? []).map((l) => l.entityId),
        ];
        expect(cited.length).toBeGreaterThan(0);
        for (const eid of cited) {
          const ref = r.citations[eid];
          expect(ref, eid).toBeTruthy();
          const entry = s.ledger.find((e) => e.id === ref);
          expect(entry?.kind).toBe("qloo");
          expect(entry?.resultCount ?? 0).toBeGreaterThan(0);
        }
        const tiles = new Set(s.cards.liftMap.results.tiles.map((t) => t.geohash));
        for (const p of s.cards.partners.results) if (p.tileGeohash) expect(tiles.has(p.tileGeohash)).toBe(true);
        for (const b of s.budgetSplit ?? []) expect(tiles.has(b.geohash)).toBe(true);
      });

      it("has zero guard drops in citation fields", () => {
        const s = sheet(id);
        expect(s.guard.dropped).toBe(0);
        const tiles = new Set(s.cards.liftMap.results.tiles.map((t) => t.geohash));
        for (const t of s.narration?.tileWhy ?? []) expect(tiles.has(t.geohash)).toBe(true);
        const ents = new Set([...s.cards.partners.results, ...s.cards.prePost.results, ...s.cards.media.results].map((x) => x.entity.entityId));
        for (const l of s.narration?.partnerLines ?? []) expect(ents.has(l.entityId)).toBe(true);
        expect(s.narration?.templated).toBe(true);
      });

      it("keeps denied tags out of copy hooks, chips and stored entities", () => {
        const s = sheet(id);
        expect(s.cards.copyHooks.results.length).toBeGreaterThan(0);
        for (const h of s.cards.copyHooks.results) {
          expect(h.tagIds.length).toBeGreaterThan(0);
          for (const t of h.tagIds) expect(isDeniedTag(t)).toBe(false);
          expect(findDeniedTerm(h.text)).toBeNull();
        }
        for (const e of allEntities(s)) {
          for (const t of e.tags) expect(isDeniedTag(t), `${e.name}: ${t.id}`).toBe(false);
          if (e.subtype === "urn:entity:person") expect(e.tags).toEqual([]);
        }
        for (const side of ["shared", "a", "b"] as const) for (const t of s.cards.whatsDifferent.results[side]) expect(isDeniedTag(t)).toBe(false);
        expect(s.guard.deniedTagCount).toBeGreaterThan(0);
        expect(s.guard.reasons.some((r) => /tags? denied by policy \(/.test(r))).toBe(true);
        // Structured counts per policy class add up to the total and carry no tag names.
        const byNs = s.guard.deniedByNamespace ?? {};
        expect(Object.values(byNs).reduce((a, b) => a + b, 0)).toBe(s.guard.deniedTagCount);
        for (const k of Object.keys(byNs)) expect(k).toMatch(/^[a-z_]+$/);
      });

      it("takes alcohol rules from Ticketmaster only", () => {
        const s = sheet(id);
        const adult = s.bill.legalAgeEnforced === true;
        for (const spot of s.cards.prePost.results) {
          if (["bar", "pub", "sports_bar", "night_club"].includes(spot.category ?? "")) expect(spot.fanFacingAllowed).toBe(adult);
          else expect(spot.fanFacingAllowed).toBe(true);
        }
        if (!adult) {
          for (const h of s.cards.copyHooks.results) expect(findAlcoholTerm(h.text)).toBeNull();
          const sponsor = s.cards.media.results.find((m) => m.kind === "sponsor");
          if (sponsor) expect(sponsor.entity.tags.some((t) => /alcohol|tobacco|gambling/.test(t.id))).toBe(false);
          const q9 = s.ledger.filter((e) => (e.note ?? "").includes("node Q9"));
          expect(q9.length).toBeGreaterThan(0);
          for (const e of q9) expect(String(e.params["filter.exclude.tags"] ?? "")).toContain("night_club");
        }
      });

      it("records every call with a redacted copy-as-curl", () => {
        const s = sheet(id);
        for (const e of s.ledger) {
          if (e.kind === "action") continue;
          expect(e.curl.length).toBeGreaterThan(0);
          expect(e.curl).not.toContain("fixture-world-no-key");
          expect(JSON.stringify(e.params)).not.toContain("fixture-world-no-key");
          expect(e.note).toMatch(/node /);
        }
        expect(s.ledger.filter((e) => e.kind === "qloo").every((e) => /fixture world: synthetic response/.test(e.note ?? ""))).toBe(true);
      });
    });
  }
});

describe("G1: same room, two crowds", () => {
  it("resolves all acts exactly and never shows needs_input", () => {
    for (const id of ["g1-a", "g1-b"]) {
      expect(runs[id]!.first.status).toBe("complete");
      expect(sheet(id).cards.resolution.status).toBe("ok");
      expect(sheet(id).cards.liftMap.results.diagnostics.baseline).toBe("house");
    }
  });

  it("gives the two bills different lift tiles and partner lists (top-8 overlap <= 3)", () => {
    const a = sheet("g1-a");
    const b = sheet("g1-b");
    const topA = a.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3).slice(0, 5).map((t) => t.geohash);
    const topB = new Set(b.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3).slice(0, 5).map((t) => t.geohash));
    expect(topA.length).toBeGreaterThanOrEqual(3);
    expect(topB.size).toBeGreaterThanOrEqual(3);
    expect(topA.filter((g) => topB.has(g)).length).toBeLessThanOrEqual(1);
    const pA = a.cards.partners.results.slice(0, 8).map((p) => p.entity.entityId);
    const pB = new Set(b.cards.partners.results.slice(0, 8).map((p) => p.entity.entityId));
    expect(pA.filter((x) => pB.has(x)).length).toBeLessThanOrEqual(3);
    expect(a.pairedPlanId).toBe("g1-b");
    expect(b.pairedPlanId).toBe("g1-a");
  });

  it("checks the map by splitting the bill and the house in two, and records it on the lift card", () => {
    for (const id of ["g1-a", "g1-b"]) {
      const s = sheet(id);
      const d = s.cards.liftMap.results.liftDiagnostics;
      expect(d, id).toBeDefined();
      expect(d!.splitHalfSpearman as number, id).toBeGreaterThan(0.5);
      expect(d!.liftVsHeatSpearman).toBe(s.cards.liftMap.results.diagnostics.spearmanLiftVsHeat);
      expect(d!.billFloor).toBe(MIN_BILL_PCT);
      // Written on the 0-100 scale the sheet prints its percentiles in (smoothing 0.5 reads as 50).
      expect(d!.method).toMatch(/\(this crowd's percentile \+ 50\) \/ \(the usual crowd's percentile \+ 50\)/);
      // Every top tile clears the bill floor.
      for (const t of s.cards.liftMap.results.tiles.filter((x) => x.lift >= 1.3)) expect(t.billPct).toBeGreaterThanOrEqual(MIN_BILL_PCT);
      // Each split-half heatmap has its own ledger entry, cited by the lift card.
      const halves = s.ledger.filter((e) => (e.note ?? "").includes(SPLIT_HALF_NODE));
      expect(halves.map((e) => /node (Q\d) /.exec(e.note ?? "")?.[1]).sort(), id).toEqual(["Q4", "Q4", "Q5", "Q5"]);
      for (const e of halves) expect(s.cards.liftMap.provenance).toContain(e.id);
      // The halves are disjoint and together are the whole signal.
      const bill = s.ledger.find((e) => /node Q4 bill heat;/.test(e.note ?? ""));
      const [h1, h2] = halves.filter((e) => /node Q4 /.test(e.note ?? "")).map((e) => (e.params["signal.interests.entities"] as string[]) ?? []);
      expect(h1!.filter((x) => h2!.includes(x))).toEqual([]);
      expect([...h1!, ...h2!].sort()).toEqual([...((bill?.params["signal.interests.entities"] as string[]) ?? [])].sort());
    }
    // Bill B at the same room reads the house halves from cache.
    const warmHalves = sheet("g1-b").ledger.filter((e) => (e.note ?? "").includes(`house heat, half`));
    expect(warmHalves.every((e) => e.cacheHit)).toBe(true);
  });

  it("marks down places the room's usual crowd ranks as high (ubiquity penalty), with a cited house rank", () => {
    for (const id of ["g1-a", "g1-b", "g2"]) {
      const s = sheet(id);
      const ids = new Map(s.ledger.map((e) => [e.id, e]));
      const twins = s.ledger.filter((e) => (e.note ?? "").includes(`node ${HOUSE_TWIN_NODE}`));
      const pools = s.ledger.filter((e) => /node Q9 partners, (tile \d|near venue)(;| \()/.test(e.note ?? ""));
      expect(twins.length, id).toBeGreaterThan(0);
      expect(twins.length).toBeLessThanOrEqual(PARTNER_TILES);
      for (const p of s.cards.partners.results) {
        expect(p.houseRank === null || (typeof p.houseRank === "number" && p.houseRank >= 1), p.entity.name).toBe(true);
        expect(p.ubiquityPenalty).toBeGreaterThanOrEqual(0);
        expect(p.ubiquityPenalty).toBeLessThanOrEqual(0.5);
        const chip = p.chips.find((c) => c.label.startsWith(HOUSE_TWIN_CHIP));
        expect(chip, p.entity.name).toBeDefined();
        expect(ids.get(chip!.ledgerRef)?.note).toContain(`node ${HOUSE_TWIN_NODE}`);
      }
      // The twin swaps only the signal: the same tile point and filters as its pool.
      const twin = twins[0]!;
      const pool = pools.find((e) => e.params["filter.location"] === twin.params["filter.location"]);
      expect(pool, id).toBeDefined();
      expect(twin.params["filter.tags"]).toEqual(pool!.params["filter.tags"]);
      expect(twin.params["signal.interests.entities"]).not.toEqual(pool!.params["signal.interests.entities"]);
      expect(s.cards.partners.limits.some((l) => /^The usual-crowd rank/.test(l))).toBe(true);
    }
    expect(sheet("g1-a").cards.partners.results.some((p) => (p.ubiquityPenalty ?? 0) > 0)).toBe(true);
  });

  it("produces 15-25 partners, named tiles and a budget that sums to 1", () => {
    const a = sheet("g1-a");
    expect(a.cards.partners.results.length).toBeGreaterThanOrEqual(15);
    expect(a.cards.partners.results.length).toBeLessThanOrEqual(25);
    expect(a.cards.liftMap.results.tiles.slice(0, 5).every((t) => typeof t.name === "string" && t.name.length > 0)).toBe(true);
    const total = (a.budgetSplit ?? []).reduce((s, b) => s + b.share, 0);
    expect(total).toBeCloseTo(1, 2);
    expect(a.cards.declared.results.filter((d) => d.rank !== null).length).toBe(6);
    expect(a.cards.declared.results.filter((d) => d.rank === null).length).toBe(2);
  });

  it("21+ show (bill A) lets bars face fans; the all-ages show (bill B) does not", () => {
    expect(sheet("g1-a").bill.legalAgeEnforced).toBe(true);
    expect(sheet("g1-b").bill.legalAgeEnforced).toBe(false);
    const q9a = sheet("g1-a").ledger.filter((e) => (e.note ?? "").includes("node Q9"));
    for (const e of q9a) expect(e.params["filter.exclude.tags"]).toBeUndefined();
  });
});

describe("G2: the honesty demo", () => {
  it("pauses on the one-word name with candidates, then resumes with the operator's pick", () => {
    const { first, final } = runs.g2!;
    expect(first.status).toBe("needs_input");
    const pending = first.pause!.pending;
    expect(pending.map((p) => p.input)).toEqual(["Sidecar"]);
    expect(pending[0]!.candidates.length).toBeGreaterThanOrEqual(2);
    expect(pending[0]!.candidates.map((c) => c.subtype)).toContain("urn:entity:person");
    expect(first.pause!.resolution.status).toBe("needs_input");
    expect(final.status).toBe("complete");
    expect(final.planId).toBe(first.planId);
  });

  it("swaps a film/TV proxy in for the thin act and shows the seed choice in the receipts", () => {
    const rows = sheet("g2").cards.resolution.results;
    const thin = rows.find((r) => r.input === "Reggie Collier");
    expect(thin?.status).toBe("proxy");
    expect(thin?.proxy?.entity.name).toBe("Late Shift Diner");
    expect(thin?.proxy?.entity.properties.release_year).toBe(1994);
    // The headliner has enough data, so he is his own seed: no stand-ins, no weighting (POST weights return 400).
    const head = rows.find((r) => r.input === "Dorian Pike");
    expect(head?.status).toBe("exact");
    expect(rows.some((r) => r.proxyFor === "Dorian Pike")).toBe(false);
    expect(sheet("g2").ledger.some((e) => (e.note ?? "").includes("Q1 proxy seed: movie"))).toBe(false);
    expect(sheet("g2").guard.reasons.some((r) => /left out of the crowd signal/.test(r))).toBe(false);
    expect(sheet("g2").cards.resolution.status).toBe("partial");
    expect(sheet("g2").guard.reasons.some((r) => /Person-entity tags stripped/.test(r))).toBe(true);
  });

  it("ranks the operator's barbershops and keeps community channels in your order, unranked", () => {
    const declared = sheet("g2").cards.declared.results;
    expect(declared.filter((d) => d.rank !== null).map((d) => d.declared.label).sort()).toEqual(["Crown & Clipper Barbershop", "Mercury Line Cuts", "Tidewater Fade Studio"]);
    const unscored = declared.filter((d) => d.rank === null).map((d) => d.declared.label);
    expect(unscored).toEqual(expect.arrayContaining(["HBCU alumni chapter, Peninsula (operator contact)", "Southside Social Hall"]));
    expect(sheet("g2").cards.partners.results.some((p) => p.entity.entityId === sheet("g2").bill.venue.qlooEntityId)).toBe(false);
  });

  it("remembers the operator's pick for the next run", async () => {
    const d = deps({ store, choices });
    const r = await import("../src/index").then((m) => m.planShow({ presetId: "g2" }, d));
    expect(r.status).toBe("complete");
  });
});

describe("G3: the hardest room first", () => {
  it("has no lift map, so it computes no split-half check and makes no split-half calls", () => {
    const s = sheet("g3");
    expect(s.cards.liftMap.results.liftDiagnostics).toBeUndefined();
    expect(s.ledger.some((e) => (e.note ?? "").includes(SPLIT_HALF_NODE))).toBe(false);
  });

  it("has no comedy genre baseline, so there is no lift map and the card says why (probes 6 and 19)", () => {
    const s = sheet("g3");
    expect(s.cards.liftMap.status).toBe("degraded");
    expect(s.cards.liftMap.reason).toMatch(
      /^Qloo has no comedy-wide map to compare with, and fewer than 5 of the room's usual acts matched, so there's no lift map for this bill\. Partners are picked near the venue\. The search widened to 60 km/,
    );
    expect(s.cards.liftMap.results.tiles).toEqual([]);
    // No genre-tag heatmap and no generic heatmap: nothing to compare the bill's map with.
    expect(s.ledger.some((e) => (e.note ?? "").includes("tag baseline"))).toBe(false);
    expect(s.ledger.some((e) => (e.note ?? "").includes("Q6 generic heat"))).toBe(false);
    expect(s.cards.whatsDifferent.status).toBe("empty");
    expect(JSON.stringify(s.narration)).not.toMatch(/comedy fans in general/);
    expect(s.cards.resolution.status).toBe("partial");
    expect(s.cards.resolution.results.find((r) => r.input === "Margo Vint")?.status).toBe("unresolved");
    expect(s.limits).toContain("Thin signal: treat as a starting list.");
    expect(s.cards.declared.status).toBe("empty");
  });
});

describe("call budget", () => {
  it("stays within about 14-18 plan calls with the venue baseline cached, plus 4-6 on a cold venue, plus at most 10 trust checks", () => {
    // Trust checks are counted apart: at most 4 split-half heatmaps (2 bill, 2 house), one house twin and one
    // popularity twin per partner pool.
    const coldA = runs["g1-a"]!.final.budget;
    const ca = checks(coldA);
    expect(ca).toMatchObject({ billHalves: 2, houseHalves: 2, twins: PARTNER_TILES, popular: PARTNER_TILES });
    expect(coldA.venueLevel - ca.venue).toBeGreaterThanOrEqual(BUDGET_TARGET.coldVenueExtra.min);
    expect(coldA.venueLevel - ca.venue).toBeLessThanOrEqual(BUDGET_TARGET.coldVenueExtra.max);
    expect(coldA.billLevel - ca.bill).toBeGreaterThanOrEqual(BUDGET_TARGET.billLevel.min);
    expect(coldA.billLevel - ca.bill).toBeLessThanOrEqual(BUDGET_TARGET.billLevel.max);
    // Bill B runs after bill A at the same room: the venue baseline and the house halves are cached.
    const warmB = runs["g1-b"]!.final.budget;
    const cb = checks(warmB);
    expect(cb.houseHalves).toBe(0);
    expect(warmB.venueLevel).toBeLessThanOrEqual(2);
    expect(warmB.billLevel + warmB.venueLevel - cb.total).toBeGreaterThanOrEqual(14);
    expect(warmB.billLevel + warmB.venueLevel - cb.total).toBeLessThanOrEqual(18);
    expect(warmB.qlooCached).toBeGreaterThanOrEqual(5);
    // G2: the cold venue calls are split across the pause (Q2/Q3 before it, Q5/Q6/twin after).
    const g2Checks = checks(runs.g2!.final.budget);
    const g2Venue = runs.g2!.first.budget.venueLevel + runs.g2!.final.budget.venueLevel - g2Checks.venue;
    expect(g2Venue).toBeGreaterThanOrEqual(BUDGET_TARGET.coldVenueExtra.min);
    expect(g2Venue).toBeLessThanOrEqual(BUDGET_TARGET.coldVenueExtra.max);
    expect(runs.g2!.final.budget.billLevel - g2Checks.bill).toBeLessThanOrEqual(BUDGET_TARGET.billLevel.max);
    for (const id of ["g1-a", "g1-b", "g2", "g3"]) {
      const b = runs[id]!.final.budget;
      const c = checks(b);
      expect(c.billHalves + c.houseHalves, id).toBeLessThanOrEqual(4);
      expect(c.twins, id).toBeLessThanOrEqual(PARTNER_TILES);
      expect(c.popular, id).toBeLessThanOrEqual(PARTNER_TILES);
      expect(c.total, id).toBeLessThanOrEqual(10);
      expect(b.qlooFresh).toBe(b.billLevel + b.venueLevel + b.arms);
      // No comparison arm runs, and nothing calls Google Places.
      expect(b.arms).toBe(0);
      expect(b.places).toBe(0);
      expect(Object.keys(b.byNode).some((n) => /^arm [PS] /.test(n))).toBe(false);
      expect(b.tm).toBe(2);
    }
  });
});

describe("no Google Places", () => {
  it("no sheet carries a comparison list or a Places call", () => {
    for (const id of ["g1-a", "g1-b", "g2", "g3"]) {
      const s = sheet(id);
      expect(s.control, id).toBeUndefined();
      expect(s.ledger.some((e) => e.kind === "places"), id).toBe(false);
    }
  });
});

describe("web sheet validator", () => {
  const validatePath = resolve(__dirname, "../../../apps/web/lib/validate.ts");
  it.skipIf(!existsSync(validatePath))("accepts every generated sheet and fixture wrapper", async () => {
    // Loaded by path so this package does not depend on the web app's types.
    const mod = (await import(pathToFileURL(validatePath).href)) as {
      validateSheet: (s: unknown) => string[];
      validateFixture: (f: unknown) => string[];
    };
    for (const id of ["g1-a", "g1-b", "g2", "g3"]) {
      const s = sheet(id);
      expect(mod.validateSheet(s), id).toEqual([]);
      expect(mod.validateFixture({ synthetic: true, fixtureId: id, title: id, note: "test", sheet: s }), id).toEqual([]);
    }
  });
});
