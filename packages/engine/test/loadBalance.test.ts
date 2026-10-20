import { describe, expect, it } from "vitest";
import { loadBalance, type LoadSpot } from "../src/loadBalance";
import { shuffleInPlace } from "../src/rng";
import { rng } from "./helpers";

function byId(spots: ReturnType<typeof loadBalance>["allocations"]) {
  return new Map(spots.map((a) => [a.entityId, a]));
}

function randomSpots(seed: number): { spots: LoadSpot[]; attendance: number } {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 10);
  const spots: LoadSpot[] = [];
  for (let i = 0; i < n; i++) {
    spots.push({
      entityId: `S${String(Math.floor(r() * 1000)).padStart(3, "0")}-${i}`,
      weight: r() < 0.15 ? 0 : Math.round(r() * 100) / 10,
      assumedCapacity: r() < 0.1 ? 0 : Math.floor(r() * 300),
    });
  }
  return { spots, attendance: Math.floor(r() * 2500) };
}

describe("loadBalance: examples", () => {
  it("splits proportionally when nothing overflows", () => {
    const res = loadBalance(
      [
        { entityId: "a", weight: 3, assumedCapacity: 1000 },
        { entityId: "b", weight: 1, assumedCapacity: 1000 },
      ],
      400,
    );
    expect(byId(res.allocations).get("a")!.expectedCount).toBe(300);
    expect(byId(res.allocations).get("b")!.expectedCount).toBe(100);
    expect(byId(res.allocations).get("a")!.expectedShare).toBe(0.75);
    expect(res.placed).toBe(400);
    expect(res.unplaced).toBe(0);
  });
  it("water-fills overflow from a full spot to the others", () => {
    const res = loadBalance(
      [
        { entityId: "a", weight: 8, assumedCapacity: 50 },
        { entityId: "b", weight: 1, assumedCapacity: 1000 },
        { entityId: "c", weight: 1, assumedCapacity: 1000 },
      ],
      250,
    );
    const m = byId(res.allocations);
    expect(m.get("a")!.expectedCount).toBe(50);
    expect(m.get("a")!.saturated).toBe(true);
    expect(m.get("b")!.expectedCount).toBe(100);
    expect(m.get("c")!.expectedCount).toBe(100);
  });
  it("reports people who fit nowhere", () => {
    const res = loadBalance(
      [
        { entityId: "a", weight: 1, assumedCapacity: 10 },
        { entityId: "b", weight: 1, assumedCapacity: 20 },
      ],
      100,
    );
    expect(res.placed).toBe(30);
    expect(res.unplaced).toBe(70);
    expect(res.allocations.every((a) => a.saturated)).toBe(true);
  });
  it("breaks remainder ties by entityId", () => {
    const res = loadBalance(
      [
        { entityId: "b", weight: 1, assumedCapacity: 10 },
        { entityId: "a", weight: 1, assumedCapacity: 10 },
        { entityId: "c", weight: 1, assumedCapacity: 10 },
      ],
      10,
    );
    const m = byId(res.allocations);
    expect([m.get("a")!.expectedCount, m.get("b")!.expectedCount, m.get("c")!.expectedCount]).toEqual([4, 3, 3]);
    expect(res.allocations.map((a) => a.entityId)).toEqual(["b", "a", "c"]); // input order kept
  });
  it("outingRate scales the people placed; shares stay relative to attendance", () => {
    const res = loadBalance([{ entityId: "a", weight: 1, assumedCapacity: 1000 }], 1000, { outingRate: 0.3 });
    expect(res.people).toBe(300);
    expect(res.allocations[0]!.expectedShare).toBeCloseTo(0.3);
  });
  it("edge cases: no spots, zero attendance, NaN, zero weights, duplicates, Infinity capacity", () => {
    expect(loadBalance([], 100)).toEqual({ allocations: [], attendance: 100, people: 100, placed: 0, unplaced: 100 });
    expect(loadBalance([{ entityId: "a", weight: 1, assumedCapacity: 10 }], 0).allocations[0]!.expectedShare).toBe(0);
    expect(loadBalance([{ entityId: "a", weight: 1, assumedCapacity: 10 }], Number.NaN).people).toBe(0);
    const nan = loadBalance([{ entityId: "a", weight: Number.NaN, assumedCapacity: Number.NaN }], 10);
    expect(nan.allocations[0]!.expectedCount).toBe(0);
    expect(nan.unplaced).toBe(10);
    const zeroW = loadBalance(
      [
        { entityId: "a", weight: 0, assumedCapacity: 10 },
        { entityId: "b", weight: 0, assumedCapacity: 10 },
      ],
      10,
    );
    expect(zeroW.allocations.map((a) => a.expectedCount)).toEqual([5, 5]);
    const mixed = loadBalance(
      [
        { entityId: "a", weight: 0, assumedCapacity: 100 },
        { entityId: "b", weight: 1, assumedCapacity: 5 },
      ],
      10,
    );
    expect(byId(mixed.allocations).get("a")!.expectedCount).toBe(0);
    expect(mixed.unplaced).toBe(5);
    const dup = loadBalance(
      [
        { entityId: "a", weight: 1, assumedCapacity: 5 },
        { entityId: "a", weight: 9, assumedCapacity: 500 },
      ],
      10,
    );
    expect(dup.allocations).toHaveLength(1);
    expect(dup.allocations[0]!.capacity).toBe(5);
    const inf = loadBalance([{ entityId: "a", weight: 1, assumedCapacity: Number.POSITIVE_INFINITY }], 1234);
    expect(inf.allocations[0]!.expectedCount).toBe(1234);
    expect(inf.allocations[0]!.saturated).toBe(false);
    const frac = loadBalance([{ entityId: "a", weight: 1, assumedCapacity: 9.9 }], 100);
    expect(frac.allocations[0]!.capacity).toBe(9);
  });
});

describe("loadBalance: properties (seeded)", () => {
  const TRIALS = 300;
  it("never exceeds capacity, places min(people, usable capacity), counts are integers", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const { spots, attendance } = randomSpots(s);
      const res = loadBalance(spots, attendance);
      const anyWeight = spots.some((x) => x.weight > 0 && x.assumedCapacity > 0);
      const usable = spots
        .filter((x, i) => spots.findIndex((y) => y.entityId === x.entityId) === i)
        .filter((x) => x.assumedCapacity > 0 && (!anyWeight || x.weight > 0))
        .reduce((acc, x) => acc + Math.floor(x.assumedCapacity), 0);
      let total = 0;
      for (const a of res.allocations) {
        expect(Number.isInteger(a.expectedCount)).toBe(true);
        expect(a.expectedCount).toBeGreaterThanOrEqual(0);
        expect(a.expectedCount).toBeLessThanOrEqual(a.capacity);
        expect(a.expectedShare).toBeGreaterThanOrEqual(0);
        expect(a.expectedShare).toBeLessThanOrEqual(1);
        total += a.expectedCount;
      }
      expect(total).toBe(res.placed);
      expect(res.placed).toBe(Math.min(res.people, usable));
      expect(res.placed + res.unplaced).toBe(res.people);
    }
  });
  it("is invariant to input order (per entity)", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const { spots, attendance } = randomSpots(s);
      const a = byId(loadBalance(spots, attendance).allocations);
      const b = byId(loadBalance(shuffleInPlace([...spots], rng(s * 31)), attendance).allocations);
      for (const [id, x] of a) {
        // duplicates keep the first occurrence, which a shuffle can change; skip those ids
        if (spots.filter((sp) => sp.entityId === id).length > 1) continue;
        expect(b.get(id)!.expectedCount).toBe(x.expectedCount);
      }
    }
  });
  it("is invariant to scaling all weights", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const { spots, attendance } = randomSpots(s);
      const a = loadBalance(spots, attendance).allocations.map((x) => x.expectedCount);
      const b = loadBalance(
        spots.map((x) => ({ ...x, weight: x.weight * 4 })),
        attendance,
      ).allocations.map((x) => x.expectedCount);
      expect(b).toEqual(a);
    }
  });
  it("a heavier spot with at least the same capacity never gets fewer people", () => {
    for (let s = 1; s <= TRIALS; s++) {
      const { spots, attendance } = randomSpots(s);
      const res = byId(loadBalance(spots, attendance).allocations);
      for (const x of spots) {
        for (const y of spots) {
          if (x.entityId === y.entityId) continue;
          const ax = res.get(x.entityId)!;
          const ay = res.get(y.entityId)!;
          if (ax.capacity !== Math.floor(x.assumedCapacity) || ay.capacity !== Math.floor(y.assumedCapacity)) continue;
          if (x.weight > y.weight && ax.capacity >= ay.capacity) expect(ax.expectedCount).toBeGreaterThanOrEqual(ay.expectedCount);
        }
      }
    }
  });
  it("more attendance never reduces any spot", () => {
    for (let s = 1; s <= 100; s++) {
      const { spots, attendance } = randomSpots(s);
      const a = byId(loadBalance(spots, attendance).allocations);
      const b = byId(loadBalance(spots, attendance + 137).allocations);
      for (const [id, x] of a) expect(b.get(id)!.expectedCount).toBeGreaterThanOrEqual(x.expectedCount - 1);
    }
  });
  it("is deterministic", () => {
    for (let s = 1; s <= 50; s++) {
      const { spots, attendance } = randomSpots(s);
      expect(loadBalance(spots, attendance)).toEqual(loadBalance(spots, attendance));
    }
  });
});
