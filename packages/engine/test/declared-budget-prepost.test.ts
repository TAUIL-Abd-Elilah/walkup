import { describe, expect, it } from "vitest";
import type { DeclaredPartner, LiftTile } from "@walkup/contracts";
import { DECLARED_NOT_SCORED, rankDeclaredPartners } from "../src/declared";
import { BUDGET_LABEL, budgetSplit } from "../src/budget";
import { buildPrePostSpots, deltaRanks, fanFacingAllowed } from "../src/prepost";
import { place } from "./helpers";

describe("rankDeclaredPartners", () => {
  const declared: DeclaredPartner[] = [
    { label: "Typed only, no pick" },
    { label: "Alumni chapter", qlooEntityId: "E-3" },
    { label: "Record shop", qlooEntityId: "E-1" },
    { label: "Not returned", qlooEntityId: "E-9" },
    { label: "Barbershop", qlooEntityId: "E-2", contactEmail: "lead@example.test" },
  ];
  const scored = [place("one", { id: "E-1" }), place("stray", { id: "E-X" }), place("two", { id: "E-2" }), place("three", { id: "E-3" }), place("one again", { id: "E-1" })];

  it("ranks in Qloo order among declared ids; unscored keep operator order", () => {
    const r = rankDeclaredPartners(declared, scored, { ledgerRef: "Q11" });
    expect(r.map((x) => [x.declared.label, x.rank])).toEqual([
      ["Record shop", 1],
      ["Barbershop", 2],
      ["Alumni chapter", 3],
      ["Typed only, no pick", null],
      ["Not returned", null],
    ]);
    expect(r[0]!.entity?.entityId).toBe("E-1");
    expect(r[0]!.chips).toEqual([{ label: "ranked for this bill", ledgerRef: "Q11" }]);
    expect(r[1]!.declared.contactEmail).toBe("lead@example.test");
  });
  it("not in Qloo's catalog: chip only when the id was sent", () => {
    const r = rankDeclaredPartners(declared, scored, { ledgerRef: "Q11" });
    const typed = r.find((x) => x.declared.label === "Typed only, no pick")!;
    const missing = r.find((x) => x.declared.label === "Not returned")!;
    expect(typed.chips).toEqual([]);
    expect(typed.entity).toBeUndefined();
    expect(missing.chips).toEqual([{ label: DECLARED_NOT_SCORED, ledgerRef: "Q11" }]);
  });
  it("no ledger ref, no chips; empty inputs", () => {
    expect(rankDeclaredPartners(declared, scored).every((x) => x.chips.length === 0)).toBe(true);
    expect(rankDeclaredPartners([], scored)).toEqual([]);
    expect(rankDeclaredPartners(declared, []).every((x) => x.rank === null)).toBe(true);
  });
  it("duplicate declarations share the rank and keep input order", () => {
    const r = rankDeclaredPartners(
      [
        { label: "b", qlooEntityId: "E-2" },
        { label: "a", qlooEntityId: "E-2" },
      ],
      scored,
    );
    expect(r.map((x) => [x.declared.label, x.rank])).toEqual([
      ["b", 1],
      ["a", 1],
    ]);
  });
});

function lt(geohash: string, lift: number): LiftTile {
  return { geohash, lat: 0, lon: 0, lift, billPct: 0.5, housePct: 0.5, popularityPct: 0.5 };
}

describe("budgetSplit", () => {
  it("proportional to lift x adults, labelled", () => {
    const tiles = [lt("a", 2), lt("b", 1)];
    const adults = new Map([
      ["a", 1000],
      ["b", 2000],
    ]);
    const s = budgetSplit(tiles, (t) => adults.get(t.geohash), 0);
    expect(s.map((x) => x.share)).toEqual([0.5, 0.5]);
    expect(s.every((x) => x.label === BUDGET_LABEL && x.label === "heuristic, not a forecast")).toBe(true);
  });
  it("enforces the minimum share and still sums to 1", () => {
    const tiles = [lt("a", 10), lt("b", 1), lt("c", 0.01)];
    const s = budgetSplit(tiles, () => 1000, 0.15);
    const m = new Map(s.map((x) => [x.geohash, x.share]));
    expect(m.get("c")).toBeCloseTo(0.15);
    expect(m.get("b")).toBeCloseTo(0.15);
    expect(m.get("a")).toBeCloseTo(0.7);
    expect(s.reduce((acc, x) => acc + x.share, 0)).toBeCloseTo(1, 12);
  });
  it("unknown adults use the mean of known ones; none known means lift only", () => {
    const tiles = [lt("a", 1), lt("b", 1), lt("c", 2)];
    const known = budgetSplit(tiles, (t) => (t.geohash === "a" ? 100 : t.geohash === "b" ? 300 : null), 0);
    // c gets the mean (200) x lift 2 = 400; a 100; b 300 -> 0.125, 0.375, 0.5
    expect(known.map((x) => x.share)).toEqual([0.125, 0.375, 0.5]);
    const none = budgetSplit(tiles, null, 0);
    expect(none.map((x) => x.share)).toEqual([0.25, 0.25, 0.5]);
    const throwing = budgetSplit(tiles, () => {
      throw new Error("x");
    }, 0);
    expect(throwing.map((x) => x.share)).toEqual([0.25, 0.25, 0.5]);
  });
  it("edge cases: empty, min share too large, zero weights, duplicates, NaN lift", () => {
    expect(budgetSplit([], () => 1)).toEqual([]);
    expect(budgetSplit([lt("a", 5), lt("b", 1)], () => 1, 0.6).map((x) => x.share)).toEqual([0.5, 0.5]);
    expect(budgetSplit([lt("a", 0), lt("b", 0)], () => 1, 0.1).map((x) => x.share)).toEqual([0.5, 0.5]);
    expect(budgetSplit([lt("a", 1), lt("a", 9)], () => 1, 0.1)).toHaveLength(1);
    const nan = budgetSplit([lt("a", Number.NaN), lt("b", 1)], () => 1, 0.1);
    expect(nan.map((x) => x.share)).toEqual([0.1, 0.9]);
  });
  it("property: shares are >= min, sum to 1, and order follows weight", () => {
    for (let s = 1; s <= 200; s++) {
      const n = 1 + (s % 9);
      const tiles = Array.from({ length: n }, (_, i) => lt(`t${i}`, ((s * (i + 3)) % 17) / 4 + 0.1));
      const min = (s % 4) * 0.05;
      const out = budgetSplit(tiles, () => 500, min);
      const total = out.reduce((acc, x) => acc + x.share, 0);
      expect(total).toBeCloseTo(1, 10);
      for (const x of out) expect(x.share).toBeGreaterThanOrEqual(Math.min(min, 1 / n) - 1e-12);
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          if ((tiles[i] as LiftTile).lift > (tiles[j] as LiftTile).lift) expect((out[i] as { share: number }).share).toBeGreaterThanOrEqual((out[j] as { share: number }).share - 1e-12);
    }
  });
});

describe("pre/post block", () => {
  it("deltaRanks: houseRank - billRank, null when absent or no twin", () => {
    const d = deltaRanks(["a", "b", "c"], ["c", "a"]);
    expect(d.get("a")).toBe(1);
    expect(d.get("b")).toBeNull();
    expect(d.get("c")).toBe(-2);
    expect(deltaRanks(["a"], null).get("a")).toBeNull();
  });
  it("fan-facing: bars only when TM enforces a legal age", () => {
    expect(fanFacingAllowed("bar", true)).toBe(true);
    expect(fanFacingAllowed("bar", false)).toBe(false);
    expect(fanFacingAllowed("bar", null)).toBe(false);
    expect(fanFacingAllowed("cafe", false)).toBe(true);
  });
  const entities = [
    place("Bar One", { id: "B1", category: "bar" }),
    place("Closed Cafe", { id: "CC", category: "cafe", isClosed: true }),
    place("Diner", { id: "D1", category: "restaurant", hours: { Saturday: "Closed", Friday: "7-3" } }),
    place("Cafe", { id: "C1", category: "cafe" }),
    place("Venue", { id: "VEN", category: "restaurant" }),
    place("Taco", { id: "T1", category: "restaurant" }),
  ];
  it("filters, load-balances with assumed capacities and adds chips", () => {
    const { spots, report } = buildPrePostSpots(entities, {
      attendance: 1000,
      outingRate: 0.2,
      defaultCapacity: 60,
      capacityOverrides: { C1: 20 },
      legalAgeEnforced: false,
      houseTwinIds: ["T1", "B1", "C1"],
      ledgerRef: "Q10",
      houseLedgerRef: "Q10b",
      weekday: "saturday",
      excludeEntityIds: ["VEN"],
    });
    expect(spots.map((s) => s.entity.entityId)).toEqual(["B1", "C1", "T1"]);
    expect(report).toMatchObject({ droppedClosed: 1, droppedHoursClosed: 1, droppedExcluded: 1, capacityApplied: true });
    const m = new Map(spots.map((s) => [s.entity.entityId, s]));
    expect(m.get("C1")!.assumedCapacity).toBe(20);
    expect(m.get("C1")!.expectedShare * 1000).toBeLessThanOrEqual(20);
    expect(spots.reduce((acc, s) => acc + s.expectedShare, 0)).toBeCloseTo(0.14); // 60 + 20 + 60 = 140 of 200 fit
    expect(report.unplaced).toBe(60);
    expect(m.get("B1")!.fanFacingAllowed).toBe(false);
    expect(m.get("T1")!.fanFacingAllowed).toBe(true);
    expect(m.get("B1")!.category).toBe("bar");
    expect(m.get("C1")!.category).toBe("cafe");
    expect(m.get("B1")!.deltaRank).toBe(1);
    expect(m.get("T1")!.deltaRank).toBe(-5);
    expect(m.get("T1")!.chips).toEqual([
      { label: "near the room, ranked for this bill", ledgerRef: "Q10" },
      { label: "ranks 5 places lower here than for the room's usual crowd", ledgerRef: "Q10b" },
    ]);
    expect(m.get("B1")!.chips[1]!.label).toBe("ranks 1 place higher here than for the room's usual crowd");
  });
  it("without attendance, shares follow weights and no capacity is applied", () => {
    const { spots, report } = buildPrePostSpots(entities.slice(0, 1).concat(entities.slice(3, 4)), {
      attendance: null,
      legalAgeEnforced: true,
      ledgerRef: "Q10",
    });
    expect(report.capacityApplied).toBe(false);
    // weights 1 and 0.5 -> 2/3 and 1/3
    expect(spots.map((s) => s.expectedShare)).toEqual([2 / 3, 1 / 3]);
    expect(spots[0]!.fanFacingAllowed).toBe(true);
    expect(spots[0]!.deltaRank).toBeNull();
    expect(spots[0]!.chips).toHaveLength(1);
  });
  it("caps at maxSpots and handles empty input", () => {
    const many = Array.from({ length: 12 }, (_, i) => place(`p${i}`, { id: `P${i}`, category: "cafe" }));
    expect(buildPrePostSpots(many, { attendance: 100, legalAgeEnforced: null, ledgerRef: "Q10" }).spots).toHaveLength(8);
    expect(buildPrePostSpots(many, { attendance: 100, legalAgeEnforced: null, ledgerRef: "Q10", maxSpots: 6 }).spots).toHaveLength(6);
    expect(buildPrePostSpots([], { attendance: 100, legalAgeEnforced: null, ledgerRef: "Q10" }).spots).toEqual([]);
  });
});
