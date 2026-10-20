import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SpendGuard, createFileSpendStore, createMemorySpendStore, estimateCostUsd } from "../src/index";

describe("estimateCostUsd (claude-opus-5-5)", () => {
  it("prices input, output and cache reads per million tokens", () => {
    expect(estimateCostUsd({ input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(4, 10);
    expect(estimateCostUsd({ input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(20, 10);
    expect(estimateCostUsd({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2, 10);
    expect(estimateCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(5, 10);
  });

  it("prices fallback iterations at their own model's rates, unlisted models at the top tier", () => {
    const usage = {
      input_tokens: 2_000_000,
      output_tokens: 0,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0 },
        { type: "fallback_message", model: "some-other-model", input_tokens: 1_000_000, output_tokens: 0 },
      ],
    };
    expect(estimateCostUsd(usage)).toBeCloseTo(4 + 10, 10);
  });

  it("treats null cache fields as zero", () => {
    expect(
      estimateCostUsd({ input_tokens: 10, output_tokens: 10, cache_read_input_tokens: null, cache_creation_input_tokens: null }),
    ).toBeCloseTo((10 * 4 + 10 * 20) / 1e6, 12);
  });
});

describe("SpendGuard", () => {
  it("defaults to a $5 daily cap keyed by UTC day", async () => {
    let now = new Date("2026-10-13T23:30:00Z");
    const guard = new SpendGuard({ now: () => now });
    expect(guard.dailyCapUsd).toBe(5);
    await guard.recordUsd(4.99);
    expect(await guard.canSpend()).toBe(true);
    expect(await guard.canSpend(0.02)).toBe(false);
    await guard.record({ input_tokens: 0, output_tokens: 1000 }); // $0.02
    expect(await guard.canSpend()).toBe(false);
    now = new Date("2026-10-14T00:05:00Z");
    expect(await guard.canSpend()).toBe(true);
    expect(await guard.remainingUsd()).toBe(5);
  });

  it("uses an injected store", async () => {
    const store = createMemorySpendStore({ "2026-10-13": 1.5 });
    const guard = new SpendGuard({ store, dailyCapUsd: 2, now: () => new Date("2026-10-13T08:00:00Z") });
    expect(await guard.spentToday()).toBe(1.5);
    await guard.recordUsd(0.6);
    expect(await guard.canSpend()).toBe(false);
  });

  it("file store persists totals and fails closed on a corrupt file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "narrator-spend-"));
    try {
      const file = join(dir, "nested", "spend.json");
      const now = () => new Date("2026-10-13T08:00:00Z");
      await new SpendGuard({ store: createFileSpendStore(file), now }).recordUsd(1.25);
      expect(await new SpendGuard({ store: createFileSpendStore(file), now }).spentToday()).toBeCloseTo(1.25, 10);
      writeFileSync(file, "{not json");
      expect(await new SpendGuard({ store: createFileSpendStore(file), now }).canSpend()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("file store failure", () => {
  it("does not overwrite (reset) an unreadable file on add, and stays closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "narrator-spend-"));
    try {
      const file = join(dir, "spend.json");
      writeFileSync(file, "{not json");
      const guard = new SpendGuard({ store: createFileSpendStore(file), now: () => new Date("2026-10-13T08:00:00Z") });
      await expect(guard.recordUsd(0.01)).rejects.toThrow(/not overwritten/);
      expect(readFileSync(file, "utf8")).toBe("{not json");
      expect(await guard.canSpend()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
