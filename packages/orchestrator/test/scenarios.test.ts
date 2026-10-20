/**
 * Scenario knobs and run-level behaviour: determinism, the quota guard
 * serving cache, 429 retries, empty compare, thin heatmaps, closed places,
 * places without hours, free-form bills, request validation and mode.
 */
import { describe, expect, it } from "vitest";
import type { Bill } from "@walkup/contracts";
import { hoursOnDay } from "@walkup/engine";
import { WORLD_VENUES } from "@walkup/qloo-world";
import { CARD_ORDER, createMemoryPlanStore, planShow, resolveMode } from "../src/index";
import { deps, runPreset, sheetOf } from "./helpers";

describe("determinism", () => {
  it("gives the same sheet for the same inputs", async () => {
    const a = await runPreset("g1-a", deps(), { arms: ["F"] });
    const b = await runPreset("g1-a", deps(), { arms: ["F"] });
    expect(JSON.stringify(sheetOf(a.final))).toBe(JSON.stringify(sheetOf(b.final)));
    expect(a.final.budget).toEqual(b.final.budget);
  });
});

describe("quota guard", () => {
  it("serves cached answers and stored presets once the month guard trips", async () => {
    const store = createMemoryPlanStore();
    const d = deps({ store });
    const first = await planShow({ presetId: "g1-a" }, d);
    expect(first.status).toBe("complete");

    // The next answers report a month quota under the 1,500 floor.
    d.world.setScenario({ quotaRemaining: 1400 });
    const other = await planShow({ presetId: "g1-b" }, d);
    expect(d.qloo.guardTripped()).toBe(true);
    const s = sheetOf(other);
    const degraded = Object.values(s.cards).filter((c) => c.status === "degraded" && /quota/i.test(c.reason ?? ""));
    expect(degraded.length).toBeGreaterThan(0);
    expect(s.ledger.some((e) => /month guard/.test(e.note ?? ""))).toBe(true);

    // A preset is served from the last stored sheet, streamed in card order.
    const streamed: string[] = [];
    const again = await planShow({ presetId: "g1-a" }, d, { onCard: (k) => streamed.push(k) });
    expect(again.servedFromStore).toBe(true);
    expect(again.planId).toBe(first.planId);
    expect(streamed).toEqual([...CARD_ORDER]);

    // Rerunning without the stored sheet: every Qloo call is a cache hit.
    const cached = await planShow({ presetId: "g1-a" }, d, { serveFromStoreWhenGuarded: false, persist: false });
    const qloo = sheetOf(cached).ledger.filter((e) => e.kind === "qloo");
    expect(qloo.length).toBeGreaterThan(10);
    expect(qloo.every((e) => e.cacheHit)).toBe(true);
    expect(cached.budget.qlooFresh).toBe(0);
    const before = sheetOf(first).cards as unknown as Record<string, { status: string }>;
    for (const [k, card] of Object.entries(sheetOf(cached).cards)) expect(card.status, k).toBe(before[k]?.status);
  });
});

describe("transport knobs", () => {
  it("429 then success: the run completes and the ledger shows the retries", async () => {
    const r = await runPreset("g1-a", deps({ scenario: { rateLimitOnce: true } }));
    const s = sheetOf(r.final);
    expect(r.final.status).toBe("complete");
    expect(s.ledger.filter((e) => /retry 1 after HTTP 429/.test(e.note ?? "")).length).toBeGreaterThan(5);
    const plain = sheetOf((await runPreset("g1-a", deps())).final);
    expect(s.cards.partners.results.map((p) => p.entity.entityId)).toEqual(plain.cards.partners.results.map((p) => p.entity.entityId));
  });

  it("empty compare falls back to two tag profiles diffed by rank (degraded: tag diff)", async () => {
    const r = await runPreset("g1-a", deps({ scenario: { emptyCompare: true } }));
    const s = sheetOf(r.final);
    expect(s.cards.whatsDifferent.status).toBe("degraded");
    expect(s.cards.whatsDifferent.reason).toMatch(/compares the two crowds' top tags by rank/);
    expect(s.cards.whatsDifferent.results.fromTagDiff).toBe(true);
    expect(s.cards.whatsDifferent.results.a.length).toBeGreaterThan(0);
    expect(r.final.budget.byNode["Q8 fallback: bill tags"]).toBe(1);
    expect(r.final.budget.byNode["Q8 fallback: house tags"]).toBe(1);
  });

  it("thin heatmap widens to 60 km and marks the map partial", async () => {
    const r = await runPreset("g1-a", deps({ scenario: { thinHeatmap: true } }));
    const s = sheetOf(r.final);
    expect(s.cards.liftMap.status).not.toBe("ok");
    expect(s.cards.liftMap.reason).toMatch(/widened to 60 km/);
    expect(r.final.budget.byNode["Q4 bill heat (widened to 60 km)"]).toBe(1);
    expect(s.limits).toContain("Thin signal: treat as a starting list.");
  });

  it("drops closed places and counts them", async () => {
    const r = await runPreset("g1-a", deps({ scenario: { closedRate: 0.35 } }));
    const s = sheetOf(r.final);
    expect(s.cards.partners.results.every((p) => p.entity.properties.is_closed !== true)).toBe(true);
    expect(s.cards.prePost.results.every((p) => p.entity.properties.is_closed !== true)).toBe(true);
    expect(s.cards.partners.summary).toMatch(/Dropped \d+ places? marked closed/);
  });

  it("keeps places with no hours, marked for a call ahead", async () => {
    const r = await runPreset("g1-a", deps({ scenario: { noHoursRate: 0.4 } }));
    const s = sheetOf(r.final);
    const unknown = s.cards.partners.results.filter((p) => p.hoursOnDay === null);
    expect(unknown.length).toBeGreaterThan(0);
    expect(s.cards.partners.summary).toMatch(/list no hours for \w+: call first/);
    // Pre/post spots without hours for show night are kept but never presented as open.
    const spots = s.cards.prePost.results;
    const noHours = spots.filter((sp) => hoursOnDay(sp.entity.properties?.hours, s.bill.weekday).status !== "open");
    expect(noHours.length).toBeGreaterThan(0);
    for (const sp of noHours) {
      expect(sp.chips.some((c) => /call ahead/.test(c.label))).toBe(true);
      expect(sp.chips.some((c) => /open on show night/.test(c.label))).toBe(false);
    }
    expect(s.cards.prePost.summary).toContain(`${noHours.length} with no hours listed (call ahead)`);
  });

  it("without denied tags in the world the receipt count is zero", async () => {
    const r = await runPreset("g1-a", deps({ scenario: { deniedTags: false } }));
    expect(sheetOf(r.final).guard.deniedTagCount).toBe(0);
  });

  it("empty brand call hides the sponsor and marks media partial", async () => {
    const r = await runPreset("g1-a", deps({ scenario: { emptyBrands: true } }));
    const media = sheetOf(r.final).cards.media;
    expect(media.status).toBe("partial");
    expect(media.results.some((m) => m.kind === "sponsor")).toBe(false);
    expect(media.reason).toMatch(/No sponsor brand came back/);
  });
});

describe("requests and mode", () => {
  it("plans a free-form bill the operator typed (no Ticketmaster event)", async () => {
    const v = WORLD_VENUES.truth;
    const bill: Bill = {
      acts: [{ name: "Neon Orchard", role: "headliner" }],
      venue: { name: v.name, lat: v.lat, lon: v.lon, city: v.city, state: v.state },
      date: "2026-12-05",
      weekday: "saturday",
      legalAgeEnforced: null,
      classification: "Music / Pop",
    };
    const r = await planShow({ bill, operator: { seatsLeft: 500, capacity: 4400, streetTeamDays: ["friday"] } }, deps());
    expect(r.status).toBe("complete");
    const s = sheetOf(r);
    // No Ticketmaster venue id: the house baseline is the pinned genre tag.
    expect(s.cards.liftMap.results.diagnostics.baseline).toBe("tag");
    expect(s.operator.streetTeamDays).toEqual(["friday"]);
    expect(s.operator.radiusKm).toBe(40);
    expect(s.hypothetical).toBe(true);
  });

  it("rejects ambiguous or unknown requests", async () => {
    const d = deps();
    expect((await planShow({}, d)).status).toBe("error");
    expect((await planShow({ presetId: "g9" }, d)).error).toMatch(/Unknown preset/);
    expect((await planShow({ presetId: "g1-a", tmEventId: "x" }, d)).status).toBe("error");
    expect((await planShow({ tmEventId: "syn-tm-ev-does-not-exist" }, d)).error).toMatch(/not found/);
  });

  it("says fixture unless real keys and live transports are declared", () => {
    const d = deps();
    expect(resolveMode(d)).toBe("fixture");
    expect(resolveMode({ ...d, mode: "live" })).toBe("live");
    expect(resolveMode({ ...d, mode: undefined })).toBe("fixture");
  });

  it("survives a failing card listener", async () => {
    const r = await planShow({ presetId: "g1-b" }, deps(), {
      onCard: () => {
        throw new Error("stream closed");
      },
    });
    expect(r.status).toBe("complete");
  });

  it("stores a paused plan and resumes it by plan id", async () => {
    const store = createMemoryPlanStore();
    const d = deps({ store });
    const paused = await planShow({ presetId: "g2" }, d);
    expect(paused.status).toBe("needs_input");
    const rec = await store.get(paused.planId);
    expect(rec?.status).toBe("needs_input");
    expect(rec?.pause?.pending[0]?.input).toBe("Sidecar");
    const pick = rec!.pause!.pending[0]!.candidates.find((c) => c.subtype === "urn:entity:person")!;
    const done = await planShow({ presetId: "g2", planId: paused.planId, resolutions: { Sidecar: pick.entityId } }, d);
    expect(done.status).toBe("complete");
    expect((await store.get(paused.planId))?.status).toBe("complete");
  });
});

describe("balance check and reached ZIPs", () => {
  const v = WORLD_VENUES.truth;
  // Two acts with little in common: one dominates the explainability of the places near the room. A bill this
  // lopsided also fails the split-half check (its halves put the crowd in different areas), so the partners are
  // ranked near the venue and the balance check runs on that list.
  const lopsided: Bill = {
    acts: [
      { name: "Paper Satellites", role: "headliner" },
      { name: "Orquesta Brisa", role: "co" },
    ],
    venue: { name: v.name, lat: v.lat, lon: v.lon, city: v.city, state: v.state, tmVenueId: v.id },
    date: "2026-12-05",
    weekday: "saturday",
    legalAgeEnforced: true,
    classification: "Music / Country",
  };

  it("rebalances when one seed dominates explainability, only when the probe allows it", async () => {
    const on = await planShow({ bill: lopsided }, deps({ probes: { explainabilityInformative: true } }));
    expect(sheetOf(on).cards.liftMap.reason).toMatch(/two halves of the bill put this crowd in different areas/);
    expect(sheetOf(on).cards.liftMap.results.liftDiagnostics?.splitHalfSpearman as number).toBeLessThanOrEqual(0.5);
    expect(sheetOf(on).cards.partners.reason).toMatch(/headliner was dominating the ranking, so the list was rebalanced/);
    expect(on.budget.byNode["Q9 partners, near venue (rebalanced)"]).toBe(1);
    const off = await planShow({ bill: lopsided }, deps());
    expect(off.budget.byNode["Q9 partners, near venue (rebalanced)"]).toBeUndefined();
  });

  it("down-weights tiles whose ZIPs the operator already reaches", async () => {
    const base = sheetOf((await runPreset("g1-a", deps())).final);
    const top = base.cards.liftMap.results.tiles[0]!;
    const zips = (top.zctas ?? []).map((zip) => ({ zip, count: 5000 }));
    expect(zips.length).toBeGreaterThan(0);
    const r = await planShow({ presetId: "g1-a", operator: { alreadyReachedZips: zips } }, deps());
    const s = sheetOf(r);
    expect(s.cards.liftMap.summary).toMatch(/weighted down because you already reach their ZIPs/);
    const after = s.cards.liftMap.results.tiles.find((t) => t.geohash === top.geohash);
    if (after) expect(after.lift).toBeLessThan(top.lift);
    // Aggregate ZIP counts are never sent to Qloo.
    expect(JSON.stringify(s.ledger.filter((e) => e.kind === "qloo").map((e) => e.params))).not.toContain(String(zips[0]!.zip));
  });
});

describe("operator contacts", () => {
  it("never sends, stores or prints an operator-typed contact email", async () => {
    const store = createMemoryPlanStore();
    const d = deps({ store });
    const email = "street-lead@example.invalid";
    const r = await planShow(
      { presetId: "g1-b", operator: { declaredPartners: [{ label: "Bellhop Records", contactEmail: email }, { label: "Riverside Spoke Bike Co.", contactEmail: email }] } },
      d,
    );
    const s = sheetOf(r);
    expect(JSON.stringify(s)).not.toContain(email);
    expect(JSON.stringify(await store.get(r.planId))).not.toContain(email);
    // The typed name went through the pick list and was ranked.
    expect(s.cards.declared.results.find((x) => x.declared.label === "Bellhop Records")?.rank).not.toBeNull();
  });
});

