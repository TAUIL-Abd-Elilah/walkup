/**
 * Third re-audit (Oct 29): counts and their words agree. "1 of 1 act resolved" on the acts card (and the recheck
 * that rewrites stored sheets), "Found 1 partner" on a thin list, "1 lists no hours", and the lift card's "the
 * room's roster resolved 1 headliner". Also "1 of 12 picks also ranks ..., so its score was marked down", "skipped
 * 1 kind of place that has no Qloo tag" and "Your 1 partner ranked for this bill". Fixture world only; the heat step
 * runs on a stub client.
 */
import { describe, expect, it } from "vitest";
import type { Bill, HeatCell, StreetSheet } from "@walkup/contracts";
import { WORLD_VENUES } from "@walkup/qloo-world";
import type { HouseSet, RunContext } from "../src/context";
import { planShow, recheckSheet, usualCrowdMarkdownLine } from "../src/index";
import { runHeat } from "../src/steps/heat";
import { deps, runPreset, sheetOf } from "./helpers";

const v = WORLD_VENUES.truth;
const ONE_ACT: Bill = {
  acts: [{ name: "Neon Orchard", role: "headliner" }],
  venue: { name: v.name, lat: v.lat, lon: v.lon, city: v.city, state: v.state },
  date: "2026-12-05",
  weekday: "saturday",
  legalAgeEnforced: null,
  classification: "Music / Pop",
};

describe("the acts card counts one act as one", () => {
  it("says '1 of 1 act resolved' on a one-act bill", async () => {
    const s = sheetOf(await planShow({ bill: ONE_ACT }, deps()));
    expect(s.cards.resolution.summary).toMatch(/^1 of 1 act resolved\./);
  });

  it("keeps 'acts' for a bill of several", async () => {
    const s = sheetOf((await runPreset("g1-a", deps())).final);
    expect(s.cards.resolution.summary).toMatch(/^3 of 3 acts resolved\b/);
    expect(recheckSheet(s).report.rewritten).not.toContain("acts count");
  });

  it("rewrites a stored '1 of 1 acts resolved' and nothing else", async () => {
    const fresh = sheetOf(await planShow({ bill: ONE_ACT }, deps()));
    const stored: StreetSheet = structuredClone(fresh);
    stored.cards.resolution.summary = stored.cards.resolution.summary.replace(/^1 of 1 act resolved/, "1 of 1 acts resolved");
    const { sheet, report } = recheckSheet(stored);
    expect(report.rewritten).toContain("acts count");
    expect(sheet.cards.resolution.summary).toBe(fresh.cards.resolution.summary);
    expect(recheckSheet(sheet).report.rewritten).not.toContain("acts count");
  });
});

describe("partner counts", () => {
  it("says 'Found 1 partner' when the list is one place long", async () => {
    const s = sheetOf((await runPreset("g3", deps({ scenario: { closedRate: 0.8 } }))).final);
    expect(s.cards.partners.results).toHaveLength(1);
    expect(s.cards.partners.reason).toContain("Found 1 partner; the list aims for 15.");
  });

  it("says '1 lists no hours' for one place with no hours", async () => {
    const s = sheetOf((await runPreset("g1-a", deps({ scenario: { closedRate: 0.8 } }))).final);
    expect(s.cards.partners.summary).toMatch(/ 1 lists no hours for \w+: call first\./);
    expect(s.cards.partners.summary).not.toMatch(/ 1 list no hours/);
  });
});

describe("the lift card's reason with no baseline", () => {
  it("counts one resolved headliner as one", async () => {
    const cells: HeatCell[] = Array.from({ length: 220 }, (_, i) => ({
      geohash: `dqcj${i.toString(36).padStart(2, "0")}`,
      lat: v.lat + (i % 20) * 0.01,
      lon: v.lon + Math.floor(i / 20) * 0.01,
      affinity: 1 - i / 220,
      affinityRank: i + 1,
      popularity: 0.5,
    }));
    const ctx = {
      bill: ONE_ACT,
      operator: { radiusKm: 40 },
      pins: { baselineTags: {} },
      ledger: { node: () => undefined },
      qloo: {
        heatmap: async (q: { signalEntities?: string[] }) => {
          if (q.signalEntities) return { value: cells, ledgerRef: "Q4" };
          throw new Error("not called in this test");
        },
      },
    } as unknown as RunContext;
    const house: HouseSet = { ids: [], weights: [], baseline: "none", tag: null, rosterHeadliners: 4, resolved: 1, ledgerRefs: [], roster: [] };
    const seeds = [{ entity: { entityId: "E-1", name: "Neon Orchard", subtype: "urn:entity:artist", tags: [], properties: {} }, act: "Neon Orchard", weight: 1, kind: "act" }];
    const r = await runHeat(ctx, seeds as never, house);
    expect(r.card.reason).toContain("the room's roster resolved 1 headliner;");
    expect(r.card.reason).not.toContain("1 headliners");
  });
});

describe("one of several, said as one", () => {
  it("the partners card's markdown sentence says 'ranks' and 'its score' for one pick", () => {
    expect(usualCrowdMarkdownLine(1, 12)).toBe(
      "1 of 12 picks also ranks for the room's usual crowd, so its score was marked down (more when the two ranks are close).",
    );
    expect(usualCrowdMarkdownLine(24, 24)).toBe(
      "24 of 24 picks also rank for the room's usual crowd, so their scores were marked down (more when the two ranks are close).",
    );
  });

  it("the spots card says '1 kind of place that has no Qloo tag'", async () => {
    const d = deps();
    const { cafe: _cafe, ...categories } = d.tags!.categories;
    d.tags = { ...d.tags!, categories };
    const s = sheetOf((await runPreset("g1-a", d)).final);
    expect(s.cards.prePost.reason).toMatch(/skipped 1 kind of place that has no Qloo tag set up yet \(cafe\)/i);
    expect(s.cards.prePost.reason).not.toMatch(/that have no Qloo tag/);
  });

  it("a list of one partner of your own is said as one", async () => {
    const g1 = sheetOf((await runPreset("g1-a", deps())).final);
    const known = g1.operator.declaredPartners.find((p) => p.qlooEntityId);
    expect(known).toBeDefined();
    const ranked = sheetOf(await planShow({ presetId: "g1-a", operator: { declaredPartners: [known!] } }, deps()));
    expect(ranked.cards.declared.results).toHaveLength(1);
    expect(ranked.cards.declared.summary).toBe("Your 1 partner ranked for this bill.");
    const missing = sheetOf(await planShow({ presetId: "g1-a", operator: { declaredPartners: [{ label: "Nowhere Hall", qlooEntityId: "00000000-0000-4000-8000-000000000000" }] } }, deps()));
    expect(missing.cards.declared.summary).toBe("Your 1 partner didn't rank for this bill; it is not in Qloo's catalog, kept in your order.");
  });
});
