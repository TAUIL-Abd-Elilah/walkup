import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import type { SheetFixture } from "../lib/fixture-types";
import { pausedEnvelope, PLAN_ID_RE, sheetEnvelope, sheetStatus } from "../lib/api";
import { freshRunsDisabled } from "../lib/server/http";

const DIR = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const hand = (id: string) => (JSON.parse(readFileSync(`${DIR}${id}.sheet.json`, "utf8")) as SheetFixture).sheet;
const engine = (id: string) => (JSON.parse(readFileSync(`${DIR}engine/${id}.sheet.json`, "utf8")) as SheetFixture).sheet;

describe("JSON API envelope", () => {
  it("rolls card statuses up to one sheet status, reporting degraded as degraded", () => {
    expect(sheetStatus(engine("g1-a"))).toBe("ok");
    expect(sheetStatus(engine("g2"))).toBe("partial");
    expect(sheetStatus(engine("g3"))).toBe("degraded");
    expect(sheetStatus(hand("g1-a"))).toBe("ok");
    expect(sheetStatus(hand("g2"))).toBe("needs_input");
    expect(sheetStatus(hand("g3"))).toBe("degraded");
  });

  it("puts error above degraded and degraded above partial", () => {
    const s = structuredClone(engine("g1-a")) as StreetSheet;
    s.cards.media.status = "partial";
    expect(sheetStatus(s)).toBe("partial");
    s.cards.whatsDifferent.status = "degraded";
    expect(sheetStatus(s)).toBe("degraded");
    s.cards.declared.status = "error";
    expect(sheetStatus(s)).toBe("error");
    // An empty card (nothing declared) does not lower the status.
    const e = structuredClone(engine("g1-a")) as StreetSheet;
    e.cards.declared.status = "empty";
    expect(sheetStatus(e)).toBe("ok");
  });

  it("returns the skill's envelope shape, with the reason of a card at the rolled-up status", () => {
    const env = sheetEnvelope(engine("g3"), "https://example.com");
    expect(env.status).toBe("degraded");
    expect(env.planId).toBe("g3");
    expect(env.sheetUrl).toBe("https://example.com/s/g3");
    expect(env.mode).toBe("fixture");
    expect(env.reason).toMatch(/no comedy-wide map to compare with/);
    expect(env.cards.liftMap).toBe("degraded");
    expect(env.provenance).toContain("Q1");
    expect(env.limits.length).toBeGreaterThan(0);

    const g2 = sheetEnvelope(hand("g2"), "https://example.com");
    expect(g2.status).toBe("needs_input");
    expect(g2.resolution.some((r) => r.status === "needs_input")).toBe(true);
    expect(g2.reason).toMatch(/Sidecar/);
  });

  it("builds a needs_input envelope with candidates and no sheet", () => {
    const s = hand("g2");
    const row = s.cards.resolution.results.find((r) => r.status === "needs_input");
    const env = pausedEnvelope(
      { planId: "abc", mode: "fixture", resolution: s.cards.resolution, pending: [{ input: row!.input, candidates: row!.candidates ?? [] }] },
      "https://example.com",
    );
    expect(env.status).toBe("needs_input");
    expect(env.results).toBeNull();
    expect(env.resolveUrl).toBe("https://example.com/api/plan/abc/resolve");
    expect(env.pending[0]?.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses free-form runs in fixture mode with 503 and validates plan ids", async () => {
    const prev = process.env.QLOO_API_KEY;
    delete process.env.QLOO_API_KEY;
    const res = freshRunsDisabled();
    if (prev !== undefined) process.env.QLOO_API_KEY = prev;
    expect(res.status).toBe(503);
    const body = (await res.json()) as { mode: string; reason: string };
    expect(body.mode).toBe("fixture");
    expect(body.reason).toMatch(/presetId/);
    expect(PLAN_ID_RE.test("g1-a")).toBe(true);
    expect(PLAN_ID_RE.test("1f300eb0-24b6-4626-ae08-694b75045c00")).toBe(true);
    expect(PLAN_ID_RE.test("../etc")).toBe(false);
  });
});
