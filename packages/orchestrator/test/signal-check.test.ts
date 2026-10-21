/**
 * Oct 15 2026 findings on hackathon.api.qloo.com, applied in the run:
 *  - Qloo can list an act under /search and still have no taste data for it; place insights warn
 *    (not_found) and heatmaps, tags and compare drop it silently. The resolve step checks every seed
 *    once (Q1 signal check) and moves a dropped act to the next usable entry of the same search.
 *  - POST weighted signals return 400 (probe 14): signals are plain GET ids, never weighted objects.
 * The fixture world scripts a test-only pair ("Wade Corley" has no taste data, "Wade Corley and The
 * Low Ten" does), so preset sheets do not change.
 */
import { describe, expect, it } from "vitest";
import type { Bill } from "@walkup/contracts";
import { catalogByKey, WORLD_VENUES } from "@walkup/qloo-world";
import { createMemoryChoiceStore, DEFAULT_PROBES, planShow } from "../src/index";
import { droppedFrom, droppedReason } from "../src/context";
import { SIGNAL_CHECK_NODE } from "../src/steps/resolve";
import { CLOCK_MS, deps, runPreset, sheetOf } from "./helpers";

const v = WORLD_VENUES.truth;
const solo = catalogByKey("wade_corley");
const band = catalogByKey("wade_corley_low_ten");

function bill(acts: Bill["acts"]): Bill {
  return {
    acts,
    venue: { name: v.name, lat: v.lat, lon: v.lon, city: v.city, state: v.state },
    date: "2026-12-05",
    weekday: "saturday",
    legalAgeEnforced: null,
    classification: "Music / Country",
  };
}

describe("Q1 signal check", () => {
  it("swaps an act Qloo has no taste data for to the billing-name entry, says so, and never sends the dropped id again", async () => {
    const r = await planShow({ bill: bill([{ name: "Wade Corley", role: "headliner" }, { name: "Marla Vane", role: "support" }]) }, deps());
    const s = sheetOf(r);
    const row = s.cards.resolution.results.find((x) => x.input === "Wade Corley");
    expect(row?.status).toBe("exact");
    expect(row?.entity?.entityId).toBe(band.id);
    expect(row?.replaced).toMatchObject({ entityId: solo.id, reason: "not_found" });
    expect(s.cards.resolution.summary).toContain(`Wade Corley: Qloo's entry under this name has no taste data, so the run uses "Wade Corley and The Low Ten".`);
    // A different billing name is never settled silently: the row, the summary and the card status say so.
    expect(row?.reason).toBe(`"Wade Corley and The Low Ten" is billed under a different name, so check it's the same act.`);
    expect(s.cards.resolution.summary).toContain("is billed under a different name");
    expect(s.cards.resolution.status).toBe("partial");
    expect(s.cards.resolution.reason).toContain("check the swapped act (Wade Corley)");
    const step = (s.steps ?? []).find((x) => x.id === "resolve");
    expect(step?.cause).toContain("Swapped Wade Corley's Qloo entry: the first match had no taste data (Q1)");
    // One check call, then the dropped id is never part of a signal.
    const checks = s.ledger.filter((e) => (e.note ?? "").includes(SIGNAL_CHECK_NODE));
    expect(checks).toHaveLength(1);
    // The swap cites the check call that dropped the pick.
    expect(row?.replaced?.ledgerRef).toBe(checks[0]!.id);
    expect(checks[0]!.note).toContain(solo.id);
    const after = s.ledger.slice(s.ledger.indexOf(checks[0]!) + 1);
    for (const e of after) expect(JSON.stringify(e.params ?? {})).not.toContain(solo.id);
    expect(s.cards.partners.status === "ok" || s.cards.partners.status === "partial").toBe(true);
    expect(s.cards.partners.reason ?? "").not.toMatch(/no taste data/);
  });

  it("words a card whose call Qloo answered without part or all of the bill's signal", () => {
    const check = droppedFrom({ droppedSignals: [solo.id] }, [solo.id]);
    expect(check.share).toBe("all");
    expect(droppedReason(check, "Q9")).toBe("Qloo has no taste data for this bill's acts (Q9), so this list would only show general popularity.");
    expect(droppedReason(droppedFrom({ droppedSignals: [solo.id] }, [solo.id, band.id]), "Q9")).toBe(
      "Qloo has no taste data for 1 of the names behind this bill (Q9), so this list rests on the others.",
    );
    expect(droppedFrom({ droppedSignals: [] }, [band.id]).share).toBe("none");
    expect(droppedFrom(undefined, [band.id]).share).toBe("none");
  });

  it("forgets an operator pick Qloo has no taste data for and asks again without it", async () => {
    const choices = createMemoryChoiceStore();
    const d = deps({ choices });
    await choices.set("Wade Corley", ["artist", "person"], solo.id, CLOCK_MS);
    const r = await planShow({ bill: bill([{ name: "Wade Corley", role: "headliner" }]) }, d);
    expect(r.status).toBe("needs_input");
    const row = r.pause?.resolution.results.find((x) => x.input === "Wade Corley");
    expect(row?.reason).toBe(`Qloo has no taste data for the entry picked for "Wade Corley". Pick the entry that matches this act.`);
    expect(row?.candidates?.map((c) => c.entityId)).not.toContain(solo.id);
    expect(await choices.get("Wade Corley", ["artist", "person"], CLOCK_MS)).toBeNull();
  });

  it("remembers a pick only after the check accepts it", async () => {
    const choices = createMemoryChoiceStore();
    const d = deps({ choices });
    const person = catalogByKey("sidecar_person").id;
    const r = await planShow({ presetId: "g2", resolutions: { Sidecar: person } }, d);
    expect(r.status).toBe("complete");
    expect(await choices.get("Sidecar", ["artist", "person"], CLOCK_MS)).toBe(person);
  });

  it("costs one check call on the preset bill (under 25 ids), served from cache on its re-run", async () => {
    const d = deps();
    const first = await runPreset("g1-a", d);
    const again = await runPreset("g1-a", d);
    const count = (r: typeof first) => sheetOf(r.final).ledger.filter((e) => (e.note ?? "").includes(SIGNAL_CHECK_NODE));
    expect(count(first)).toHaveLength(1);
    expect(count(first)[0]?.cacheHit).toBe(false);
    expect(count(again)[0]?.cacheHit).toBe(true);
  });
});

describe("dead request shapes are gone", () => {
  it("has no POST weights flag, and every Qloo call is a GET", async () => {
    expect(Object.keys(DEFAULT_PROBES).sort()).toEqual(["brandLocationMoves", "explainabilityInformative", "podcastLocationMoves"]);
    for (const id of ["g1-a", "g2"]) {
      const s = sheetOf((await runPreset(id, deps())).final);
      for (const e of s.ledger.filter((x) => x.id.startsWith("Q"))) {
        expect(e.method).toBe("GET");
        expect(e.endpoint).not.toBe("/v2/audiences");
        expect(Object.keys(e.params ?? {})).not.toContain("filter.results.entities.query");
        expect(Object.keys(e.params ?? {})).not.toContain("signal.demographics.age");
        expect(Object.keys(e.params ?? {})).not.toContain("signal.demographics.audiences");
      }
    }
  });
});

describe("map honesty (probes 6 and 19)", () => {
  it("says a map that ranks areas like the bill's own heat shows where the crowd is, not where it stands out", async () => {
    const { ownHeatLine } = await import("../src/steps/heat");
    expect(ownHeatLine("the room's usual crowd", 0.983)).toBe(
      "This map shows where this bill's crowd is, not where it stands out from the room's usual crowd: on this bill the two rank areas almost the same way (0.98). Partners are picked near the venue.",
    );
  });
});
