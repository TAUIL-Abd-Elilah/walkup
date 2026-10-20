import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ControlArmResult, StreetSheet } from "@walkup/contracts";
import { DENIED_TAG_PREFIXES } from "@walkup/contracts";
import type { SheetFixture } from "../lib/fixture-types";
import { isDeniedTag } from "../lib/policy";
import { CURL_SECRET_RE, validateFixture, validateSheet } from "../lib/validate";
import { buildAllFixtures, serializeFixture } from "../scripts/fixtures/index";
import { buildG1A } from "../scripts/fixtures/g1";

const DIR = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith(".sheet.json"));
const raw = Object.fromEntries(files.map((f) => [f, readFileSync(`${DIR}${f}`, "utf8")]));
const parsed = Object.fromEntries(files.map((f) => [f, JSON.parse(raw[f]!) as SheetFixture]));
const built = buildAllFixtures();

function walk(v: unknown, visit: (key: string, value: unknown, parent: unknown) => void, key = "", parent: unknown = null): void {
  visit(key, v, parent);
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, visit, String(i), v));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, visit, k, v);
}

describe("hand-built fixtures (the fallback)", () => {
  it("are the four expected sheets", () => {
    expect(files.sort()).toEqual(["g1-a.sheet.json", "g1-b.sheet.json", "g2.sheet.json", "g3.sheet.json"]);
  });

  it("type-check against the contracts (generator output is a SheetFixture of StreetSheet + ControlArmResult)", () => {
    expectTypeOf(buildG1A()).toEqualTypeOf<SheetFixture>();
    expectTypeOf<SheetFixture["sheet"]>().toEqualTypeOf<StreetSheet>();
    expectTypeOf<SheetFixture["control"]>().toEqualTypeOf<ControlArmResult>();
  });

  for (const f of files) {
    describe(f, () => {
      const fx = parsed[f]!;

      it('declares "synthetic": true as its first key', () => {
        expect(Object.keys(fx)[0]).toBe("synthetic");
        expect(fx.synthetic).toBe(true);
      });

      it("matches its typed builder in apps/web/scripts byte for byte (so the JSON is a valid StreetSheet)", () => {
        const fromCode = built[f];
        expect(fromCode, `no generator for ${f}`).toBeDefined();
        expect(raw[f]).toBe(serializeFixture(fromCode!));
      });

      it("passes runtime validation: shapes, enums, ledger refs, tiles, budget", () => {
        expect(validateFixture(fx)).toEqual([]);
      });

      it("uses only fictional contact details", () => {
        walk(fx, (key, value) => {
          if (key === "phone" && typeof value === "string") expect(value).toMatch(/^\(\d{3}\) 555-01\d{2}$/);
          if (key === "website" && typeof value === "string") expect(value.startsWith("https://example.com/")).toBe(true);
          if (key === "externalUrl" && typeof value === "string") expect(value.startsWith("https://example.com/")).toBe(true);
        });
      });

      it("never carries a denied tag and every curl keeps keys in env vars", () => {
        walk(fx, (key, value, parent) => {
          if ((key === "tags" || key === "shared" || key === "a" || key === "b") && Array.isArray(value)) {
            for (const t of value) {
              if (t && typeof t === "object" && "id" in t) expect(isDeniedTag(t as { id: string; name?: string }), String((t as { id: string }).id)).toBe(false);
            }
          }
          if (key === "tagIds" && Array.isArray(value)) for (const id of value) expect(isDeniedTag({ id: String(id) })).toBe(false);
          void parent;
        });
        for (const e of fx.sheet.ledger) {
          for (const m of e.curl.matchAll(CURL_SECRET_RE)) expect(m[1]?.startsWith("$"), `${e.id}: ${m[0]}`).toBe(true);
        }
        expect(raw[f]).not.toMatch(/hackathon\.api\.qloo\.com[^"]*"[^,]*"results"/);
      });

      it("is watermarked as a fixture, carries no seats-left count and has the standard limits", () => {
        expect(fx.sheet.mode).toBe("fixture");
        expect(fx.sheet.operator.seatsLeft).toBeNull();
        expect(fx.sheet.hypothetical).toBe(fx.sheet.operator.capacity !== null);
        expect(fx.sheet.limits).toContain("Whether this plan sells tickets: nothing here measures sales.");
        expect(fx.sheet.guard.dropped).toBe(0);
      });

      it("only marks overlap with partners that exist on the Qloo side", () => {
        const names = new Set(fx.sheet.cards.partners.results.map((p) => p.entity.name));
        for (const n of fx.control.overlapWithQloo) expect(names.has(n), n).toBe(true);
      });
    });
  }
});

describe("golden beats (hand-built)", () => {
  const g1a = parsed["g1-a.sheet.json"]!.sheet;
  const g1b = parsed["g1-b.sheet.json"]!.sheet;
  const g2 = parsed["g2.sheet.json"]!.sheet;
  const g3 = parsed["g3.sheet.json"]!.sheet;

  it("G1: same room, two crowds: same venue, different top tiles and partners", () => {
    expect(g1a.bill.venue).toEqual(g1b.bill.venue);
    const topA = g1a.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3).map((t) => t.geohash);
    const topB = g1b.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3).map((t) => t.geohash);
    expect(topA).toHaveLength(5);
    expect(topA[0]).not.toBe(topB[0]);
    expect(topA.filter((g) => topB.includes(g)).length).toBeLessThanOrEqual(1);
    expect(g1a.cards.partners.results).toHaveLength(20);
    expect(g1a.cards.resolution.status).toBe("ok");
    expect(parsed["g1-a.sheet.json"]!.pairedWith).toBe("g1-b");
  });

  it("G2: needs_input for Sidecar, a proxy for a thin act, 3 tags denied", () => {
    expect(g2.bill.date).toBe("2026-12-19");
    expect(g2.bill.weekday).toBe("saturday");
    const eq = g2.cards.resolution.results.find((r) => r.input === "Sidecar");
    expect(eq?.status).toBe("needs_input");
    expect(eq?.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(g2.cards.resolution.results.some((r) => r.status === "proxy" && r.input === "Reggie Collier")).toBe(true);
    expect(g2.guard.deniedTagCount).toBe(3);
    expect(g2.guard.reasons).toContain("3 tags denied by policy (ethnicity/inclusivity/credit_card)");
    expect(g2.limits).toContain("Planning tool; no sales data is known or shown.");
    expect(g2.operator.capacity).toBeNull();
    // Unknown age policy: no bar is fan-facing.
    expect(g2.cards.prePost.results.filter((s) => s.entity.tags[0]?.id.endsWith(":bar")).every((s) => !s.fanFacingAllowed)).toBe(true);
  });

  it("G3: degraded tag baseline, fewer partners, templated narration", () => {
    expect(g3.cards.liftMap.status).toBe("degraded");
    expect(g3.cards.liftMap.results.diagnostics.baseline).toBe("tag");
    expect(g3.cards.partners.results.length).toBeLessThan(15);
    expect(g3.cards.partners.results.length).toBeGreaterThanOrEqual(10);
    expect(g3.narration?.templated).toBe(true);
    expect(g3.cards.whatsDifferent.results.fromTagDiff).toBe(true);
  });
});

describe("validator catches broken sheets", () => {
  const clone = (): SheetFixture => JSON.parse(raw["g1-a.sheet.json"]!) as SheetFixture;

  it("flags unknown ledger refs, denied tags, wrong weekdays and plaintext keys", () => {
    const fx = clone();
    fx.sheet.cards.partners.results[0]!.chips[0]!.ledgerRef = "Q999";
    fx.sheet.cards.partners.results[1]!.entity.tags.push({ id: `${DENIED_TAG_PREFIXES[0]}x`, name: "x" });
    fx.sheet.bill.weekday = "monday";
    fx.sheet.ledger[2]!.curl = "curl -H 'X-Api-Key: abc123' https://example.com";
    const errors = validateSheet(fx.sheet);
    expect(errors.some((e) => e.includes("Q999"))).toBe(true);
    expect(errors.some((e) => e.includes("denied tag"))).toBe(true);
    expect(errors.some((e) => e.includes("weekday"))).toBe(true);
    expect(errors.some((e) => e.includes("env var"))).toBe(true);
  });

  it("flags a plaintext key in any copy-as-curl form (Census key=, api_key=, header)", () => {
    const leaks = [
      "curl -sG 'https://api.census.gov/data/2024/acs/acs5' --data-urlencode \"key=abc123\"",
      "curl -s 'https://example.com/x?api_key=abc123'",
      "curl -s 'https://places.googleapis.com/v1/places:searchText' -H \"X-Goog-Api-Key: AIzaabc123\"",
    ];
    for (const curl of leaks) {
      const fx = clone();
      fx.sheet.ledger[0]!.curl = curl;
      expect(validateSheet(fx.sheet).some((e) => e.includes("env var")), curl).toBe(true);
    }
    // Env-var references and look-alike words pass.
    const ok = clone();
    ok.sheet.ledger[0]!.curl = "curl -sG 'https://app.ticketmaster.com/discovery/v2/venues.json' --data-urlencode 'keyword=Super Funny' --data-urlencode \"apikey=$TICKETMASTER_API_KEY\"";
    expect(validateSheet(ok.sheet).filter((e) => e.includes("env var"))).toEqual([]);
  });

  it("requires synthetic: true and a reason on non-ok cards", () => {
    const fx = clone() as unknown as Record<string, unknown>;
    fx.synthetic = false;
    const sheet = fx.sheet as StreetSheet;
    sheet.cards.liftMap.status = "partial";
    delete sheet.cards.liftMap.reason;
    const errors = validateFixture(fx);
    expect(errors.some((e) => e.includes("synthetic"))).toBe(true);
    expect(errors.some((e) => e.includes("liftMap.reason"))).toBe(true);
  });
});
