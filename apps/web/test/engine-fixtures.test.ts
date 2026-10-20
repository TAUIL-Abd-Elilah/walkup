/**
 * The preset sheets the pages serve: written by the orchestrator itself
 * (packages/orchestrator/scripts/generate-fixture-sheets.ts) on the synthetic
 * fixture world. These tests check what the sheets must say and hold, never
 * their bytes, so regenerating them never fights a test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SheetFixture } from "../lib/fixture-types";
import { choosePreset, getPlan, handBuiltPlan, listPlans, PRESET_PLAN_IDS } from "../lib/plans";
import { isDeniedTag } from "../lib/policy";
import { CURL_SECRET_RE, validateFixture } from "../lib/validate";

const DIR = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith(".sheet.json"));
const raw = Object.fromEntries(files.map((f) => [f, readFileSync(`${DIR}${f}`, "utf8")]));
const fx = (id: string) => JSON.parse(raw[`${id}.sheet.json`] as string) as SheetFixture;

function walk(v: unknown, visit: (key: string, value: unknown) => void, key = ""): void {
  visit(key, v);
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, visit, String(i)));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, visit, k);
}

describe("generated preset sheets", () => {
  it("exist for the four presets", () => {
    expect(files.sort()).toEqual(["g1-a.sheet.json", "g1-b.sheet.json", "g2.sheet.json", "g3.sheet.json"]);
  });

  for (const id of PRESET_PLAN_IDS) {
    describe(id, () => {
      it('declares "synthetic": true first, and the orchestrator as its source', () => {
        const f = fx(id);
        expect(Object.keys(f)[0]).toBe("synthetic");
        expect(f.synthetic).toBe(true);
        expect(f.generatedBy).toMatch(/orchestrator/);
        expect(f.sheet.planId).toBe(id);
      });

      it("passes the web validator (shapes, enums, ledger refs, tiles, budget, keys)", () => {
        expect(validateFixture(fx(id))).toEqual([]);
      });

      it("is a fixture with no seats-left count, zero guard drops and the standard limits", () => {
        const s = fx(id).sheet;
        expect(s.mode).toBe("fixture");
        expect(s.operator.seatsLeft).toBeNull();
        expect(s.hypothetical).toBe(s.operator.capacity !== null);
        expect(s.guard.dropped).toBe(0);
        expect(s.limits).toContain("Whether this plan sells tickets: nothing here measures sales.");
        expect(s.limits.some((l) => /^Sample data: made-up places and numbers/.test(l))).toBe(true);
        expect(s.ledger.filter((e) => e.kind !== "action").every((e) => (e.note ?? "").includes("fixture world"))).toBe(true);
      });

      it("uses fictional contact details and no denied tags; keys stay env references", () => {
        walk(fx(id), (key, value) => {
          if (key === "phone" && typeof value === "string") expect(value).toMatch(/555-01\d{2}$/);
          if (key === "website" && typeof value === "string") expect(new URL(value).hostname.endsWith(".example")).toBe(true);
          if ((key === "tags" || key === "shared" || key === "a" || key === "b") && Array.isArray(value)) {
            for (const t of value) if (t && typeof t === "object" && "id" in t) expect(isDeniedTag(t as { id: string; name?: string })).toBe(false);
          }
        });
        for (const e of fx(id).sheet.ledger) for (const m of e.curl.matchAll(CURL_SECRET_RE)) expect(m[1]?.startsWith("$"), e.id).toBe(true);
      });

      it("carries the Without Qloo control (arm F) on the sheet and in the wrapper", () => {
        const f = fx(id);
        expect(f.control.arm).toBe("F");
        expect(f.sheet.control?.arm).toBe("F");
        const names = new Set(f.control.places.map((p) => p.name));
        for (const n of f.control.overlapWithQloo) expect(names.has(n)).toBe(true);
      });
    });
  }
});

describe("golden beats (generated)", () => {
  it("G1: same room, two crowds: same venue, different top tiles and partners", () => {
    const a = fx("g1-a").sheet;
    const b = fx("g1-b").sheet;
    expect(a.bill.venue.name).toBe(b.bill.venue.name);
    const top = (s: typeof a) => s.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3).map((t) => t.geohash);
    expect(top(a)[0]).not.toBe(top(b)[0]);
    const aTop8 = new Set(a.cards.partners.results.slice(0, 8).map((p) => p.entity.entityId));
    expect(b.cards.partners.results.slice(0, 8).filter((p) => aTop8.has(p.entity.entityId)).length).toBeLessThanOrEqual(5);
    expect(a.cards.partners.results.length).toBeGreaterThanOrEqual(15);
    expect(a.cards.resolution.status).toBe("ok");
    expect(fx("g1-a").pairedWith).toBe("g1-b");
    expect(a.pairedPlanId).toBe("g1-b");
  });

  it("G2: the Sidecar pick was made by the generator and says so; proxies seed the thin act", () => {
    const f = fx("g2");
    const s = f.sheet;
    expect(f.note).toMatch(/sample run picked Sidecar the way an operator would/);
    expect(s.bill.date).toBe("2026-12-19");
    expect(s.cards.resolution.summary).toMatch(/pick by the operator/);
    expect(s.cards.resolution.results.some((r) => r.input === "Reggie Collier" && r.status === "proxy")).toBe(true);
    expect(s.guard.reasons.some((r) => /denied by policy \(ethnicity/.test(r))).toBe(true);
    expect(s.operator.capacity).toBeNull();
    expect(s.bill.legalAgeEnforced).toBeNull();
    // Unknown age policy: bars are never fan-facing.
    expect(s.cards.prePost.results.filter((p) => p.category === "bar").every((p) => !p.fanFacingAllowed)).toBe(true);
  });

  it("G3: no usual crowd and no comedy-wide map, so no lift map, a widened heatmap and fewer partners", () => {
    const s = fx("g3").sheet;
    expect(s.cards.liftMap.status).toBe("degraded");
    expect(s.cards.liftMap.results.tiles).toEqual([]);
    expect(s.cards.liftMap.reason).toMatch(/no comedy-wide map to compare with[\s\S]*60 km/);
    expect(s.cards.whatsDifferent.status).toBe("empty");
    expect(s.cards.partners.results.length).toBeLessThan(20);
    expect(s.limits).toContain("Thin signal: treat as a starting list.");
  });
});

describe("preset loader", () => {
  it("serves the generated sheets and keeps the hand-built ones as the fallback", () => {
    for (const p of listPlans()) expect(p.source).toBe("engine");
    expect(getPlan("g1-a")?.generatedBy).toMatch(/orchestrator/);
    expect(handBuiltPlan("g1-a")?.generatedBy).toBeUndefined();
    expect(getPlan("nope")).toBeNull();
  });

  it("falls back to the hand-built sheet when a generated one is broken or for another plan", () => {
    const hand = handBuiltPlan("g3");
    const broken = structuredClone(fx("g3")) as unknown as Record<string, unknown>;
    broken.synthetic = false;
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(choosePreset("g3", broken, hand).source).toBe("hand-built");
      expect(choosePreset("g3", fx("g1-a"), hand).source).toBe("hand-built");
      expect(choosePreset("g3", fx("g3"), hand).source).toBe("engine");
    } finally {
      console.warn = warn;
    }
  });
});
