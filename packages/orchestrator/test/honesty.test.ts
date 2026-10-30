/**
 * The sheet says what actually happened: no comparison arm runs and no
 * Google Places call is made, the narration names a genre baseline when no house crowd stands behind the lift, a failed house
 * heatmap falls back to the genre tag, age-policy wording follows what
 * Ticketmaster said, and a failed act search is not reported as "no match".
 */
import { describe, expect, it } from "vitest";
import type { Bill } from "@walkup/contracts";
import { catalogByKey, createWorld, WORLD_VENUES, type World } from "@walkup/qloo-world";
import { createMemoryChoiceStore, planShow } from "../src/index";
import { CLOCK_MS, deps, runPreset, sheetOf } from "./helpers";

/** A world whose house-set heatmap (any entity heatmap after the bill's) answers HTTP 500. */
function failingHouseHeat(): World {
  const world = createWorld();
  let billHeat: string | null = null;
  const qlooFetch: World["qlooFetch"] = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/v2/insights" && u.searchParams.get("filter.type") === "urn:heatmap" && u.searchParams.has("signal.interests.entities")) {
      billHeat ??= u.search;
      if (u.search !== billHeat) {
        return new Response(JSON.stringify({ synthetic: true, error: { message: "synthetic failure" } }), { status: 500, headers: { "content-type": "application/json" } });
      }
    }
    return world.qlooFetch(url, init);
  };
  return { ...world, qlooFetch };
}

describe("no comparison arm", () => {
  it("runs no arm and calls no Google Places: the sheet has no control list", async () => {
    const d = deps();
    const r = await runPreset("g1-a", d);
    expect(r.final.budget.arms).toBe(0);
    expect(r.final.budget.places).toBe(0);
    expect(d.world.stats().places).toBe(0);
    const s = sheetOf(r.final);
    expect(s.control).toBeUndefined();
    expect(s.ledger.some((e) => e.kind === "places" || /node arm /.test(e.note ?? ""))).toBe(false);
    expect(s.limits.some((l) => /Google Places/.test(l))).toBe(false);
    expect((s.steps ?? []).some((x) => x.id === "control")).toBe(false);
  });
});

describe("baseline wording", () => {
  it("claims no usual crowd and no comedy-wide crowd when a comedy room has neither (G3)", async () => {
    const s = sheetOf((await runPreset("g3", deps())).final);
    expect(s.cards.liftMap.results.tiles).toEqual([]);
    const text = [s.narration?.summary ?? "", ...(s.narration?.tileWhy ?? []).map((t) => t.text)].join(" ");
    expect(text).not.toMatch(/house crowd|house percentile|versus the house\b|usual crowd|comedy fans in general/);
    // With no lift map there was no area to stand out: the summary, the partner card and the popularity check say so.
    expect(text).toMatch(/There is no lift map on this run, so partners are picked near the venue\./);
    expect(text).not.toMatch(/No area stands out/);
    expect(s.cards.partners.reason).toMatch(/^There is no lift map on this run, so partners are picked near the venue\./);
    expect(s.cards.partners.limits.join(" ")).toContain("runs the same Qloo search near the venue without the bill");
    expect(s.steps?.find((x) => x.id === "partners-popular")?.cause).toMatch(/^The same search near the venue without the bill/);
  });

  it("keeps the room's-usual-crowd wording when the roster baseline ran", async () => {
    const s = sheetOf((await runPreset("g1-a", deps())).final);
    expect(s.narration?.summary).toMatch(/the room's usual crowd/);
    // Lift in prose is said in words; ratios like "1.84x" stay in tables.
    expect(s.narration?.summary).not.toMatch(/\d\.\d+x/);
    for (const t of s.narration?.tileWhy ?? []) expect(t.text).not.toMatch(/\d\.\d+x/);
  });

  it("calls the sponsor local only when the signal.location probe verified it", async () => {
    const national = sheetOf((await runPreset("g1-a", deps())).final);
    expect(national.cards.media.results.find((m) => m.kind === "sponsor")?.scope).toBe("national");
    expect(national.narration?.summary).toMatch(/1 sponsor brand/);
    expect(national.narration?.summary).not.toMatch(/local sponsor/);
    const local = sheetOf((await runPreset("g1-a", deps({ probes: { brandLocationMoves: true } }))).final);
    expect(local.cards.media.results.find((m) => m.kind === "sponsor")?.scope).toBe("local");
    expect(local.narration?.summary).toMatch(/1 local sponsor/);
  });

  it("falls back to the genre tag when the house heatmap fails, and says why", async () => {
    const r = await runPreset("g1-a", deps({ world: failingHouseHeat() }));
    const s = sheetOf(r.final);
    expect(s.cards.liftMap.status).toBe("degraded");
    expect(s.cards.liftMap.reason).toMatch(/house heat failed \(Qloo returned HTTP 500\)\), so the map compares this bill with/);
    expect(s.cards.liftMap.results.diagnostics.baseline).toBe("tag");
    expect(s.cards.liftMap.results.tiles.length).toBeGreaterThan(0);
    expect(r.final.budget.byNode["Q5 house heat (tag baseline)"]).toBe(1);
    expect(s.narration?.summary).not.toMatch(/house crowd|usual crowd/);
  });
});

describe("age-policy wording on the media card", () => {
  it("says all-ages only when Ticketmaster says so", async () => {
    const b = sheetOf((await runPreset("g1-b", deps())).final);
    expect(b.bill.legalAgeEnforced).toBe(false);
    expect(b.cards.media.summary).toMatch(/all-ages show per Ticketmaster/);
    const g2 = sheetOf((await runPreset("g2", deps())).final);
    expect(g2.bill.legalAgeEnforced).toBeNull();
    expect(g2.cards.media.summary).toMatch(/Ticketmaster lists no age policy/);
    expect(g2.cards.media.summary).not.toMatch(/not 21\+ per Ticketmaster/);
  });
});

describe("resolution failures", () => {
  it("reports a failed act search as a failure, not as no match", async () => {
    const d = deps();
    d.world.setScenario({ quotaRemaining: 1400 });
    await d.qloo.search("Warm the guard", ["artist"]);
    expect(d.qloo.guardTripped()).toBe(true);
    const v = WORLD_VENUES.truth;
    const bill: Bill = {
      acts: [{ name: "Neon Orchard", role: "headliner" }],
      venue: { name: v.name, lat: v.lat, lon: v.lon, city: v.city, state: v.state },
      date: "2026-12-05",
      weekday: "saturday",
      legalAgeEnforced: null,
      classification: "Music / Pop",
    };
    const r = await planShow({ bill }, d);
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/Neon Orchard: the search call failed \(Monthly Qloo quota is low/);
    expect(r.error).not.toMatch(/no exact match/);
  });

  it("says no match in the catalog when the search came back empty", async () => {
    const s = sheetOf((await runPreset("g3", deps())).final);
    expect(s.cards.resolution.reason).toMatch(/Margo Vint: no match in Qloo's catalog/);
  });
});

describe("remembered picks", () => {
  it("remembers only a pick that was among the candidates shown", async () => {
    const choices = createMemoryChoiceStore();
    const d = deps({ choices });
    const offList = await planShow({ presetId: "g2", resolutions: { Sidecar: catalogByKey("late_shift_diner").id } }, d);
    expect(offList.status).toBe("complete");
    expect(await choices.get("Sidecar", ["artist", "person"], CLOCK_MS)).toBeNull();
    const person = catalogByKey("sidecar_person").id;
    await planShow({ presetId: "g2", resolutions: { Sidecar: person } }, d);
    expect(await choices.get("Sidecar", ["artist", "person"], CLOCK_MS)).toBe(person);
  });
});
