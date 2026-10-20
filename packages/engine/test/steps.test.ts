import { describe, expect, it } from "vitest";
import type { LiftTile, QlooEntity, TraceStep } from "@walkup/contracts";
import { TRACE_STEP_KINDS } from "@walkup/contracts";
import {
  baselineStep,
  checkStep,
  controlStep,
  countOf,
  dayName,
  declaredStep,
  guardStep,
  heatStep,
  joinAnd,
  liftInWords,
  mediaStep,
  narrateStep,
  ordinal,
  partnersStep,
  pauseStep,
  prePostStep,
  resolveStep,
  ubiquityDrops,
  usualCrowdStep,
  type PartnersStepInput,
} from "../src/steps";
import type { PartnerPool } from "../src/partners";
import { place } from "./helpers";

/** Plain-copy rules, checked on every step text. */
function expectPlain(step: TraceStep): void {
  const text = `${step.label} ${step.decision} ${step.cause ?? ""}`;
  expect(text).not.toMatch(/\d(?:\.\d+)?x\b/); // ratios belong in tables
  expect(text).not.toMatch(/[!—]/);
  expect(text).not.toMatch(/\b(unlock|supercharge|seamless|effortless|powerful|AI-powered|insights|Let's)\b/i);
  expect(step.decision).toMatch(/^[A-Z].*\.$/);
  if (step.cause) expect(step.cause).toMatch(/^[A-Z0-9].*\.$/);
  expect(TRACE_STEP_KINDS).toContain(step.kind);
  expect(new Set(step.ledgerRefs).size).toBe(step.ledgerRefs.length);
}

describe("wording helpers", () => {
  it("names the baseline with the fixed lift phrases", () => {
    expect(liftInWords(0.94)).toBe("below the room's usual crowd");
    expect(liftInWords(0.95)).toBe("about the same as the room's usual crowd");
    expect(liftInWords(1.049)).toBe("about the same as the room's usual crowd");
    expect(liftInWords(1.05)).toBe("a little above the room's usual crowd");
    expect(liftInWords(1.29)).toBe("a little above the room's usual crowd");
    expect(liftInWords(1.3)).toBe("about 1.3 times the room's usual crowd");
    expect(liftInWords(1.8374)).toBe("about 1.8 times the room's usual crowd");
    expect(liftInWords(1.5237, "tag")).toBe("about 1.5 times the genre baseline");
    expect(liftInWords(Number.NaN)).toBe("compared with the room's usual crowd");
  });
  it("writes ordinals, lists, counts and days", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
    expect(joinAnd([])).toBe("");
    expect(joinAnd(["a"])).toBe("a");
    expect(joinAnd(["a", "b"])).toBe("a and b");
    expect(joinAnd(["a", "b", "c"])).toBe("a, b and c");
    expect(countOf(1, "place")).toBe("1 place");
    expect(countOf(1200, "place")).toBe("1,200 places");
    expect(countOf(2, "search", "searches")).toBe("2 searches");
    expect(dayName("thursday")).toBe("Thursday");
  });
});

describe("resolve and pause", () => {
  it("states how many acts matched", () => {
    const s = resolveStep({ acts: [{ name: "A", matched: true }, { name: "B", matched: true }], venueMatched: true, status: "ok", ledgerRefs: ["Q1", "Q1", "Q2"] });
    expect(s.decision).toBe("Matched 2 acts to Qloo.");
    expect(s.cause).toBeUndefined();
    expect(s.ledgerRefs).toEqual(["Q1", "Q2"]);
    expectPlain(s);
  });
  it("says what was missed and why, and when the room is not in the catalog", () => {
    const s = resolveStep({
      acts: [{ name: "Ada Pell", matched: true }, { name: "Margo Vint", matched: false, reason: "not in Qloo's catalog" }],
      thin: ["Ada Pell"],
      viaTitles: ["Ada Pell"],
      venueMatched: false,
      status: "partial",
      ledgerRefs: ["Q1", "Q2"],
    });
    expect(s.decision).toBe("Matched 1 of 2 acts to Qloo.");
    expect(s.cause).toBe(
      "Margo Vint: not in Qloo's catalog, so the run went on without it. Ada Pell has a thin signal in Qloo. Film or TV titles stand in for Ada Pell. The room isn't in Qloo's catalog, so the run uses the Ticketmaster map point.",
    );
    expect(s.status).toBe("partial");
    expectPlain(s);
  });
  it("covers a pending pick and a bill with no match", () => {
    const pending = resolveStep({ acts: [{ name: "A", matched: true }, { name: "Sidecar", matched: false }], pending: ["Sidecar"], venueMatched: true, status: "needs_input", ledgerRefs: [] });
    expect(pending.decision).toBe("Matched 1 of 2 acts; Sidecar needs your pick.");
    expect(pending.cause).toBeUndefined();
    const none = resolveStep({ acts: [{ name: "A", matched: false, reason: "the search failed" }], venueMatched: true, status: "error", ledgerRefs: ["Q1"] });
    expect(none.decision).toBe("Couldn't match any of the 1 act on the bill to Qloo.");
    expect(none.cause).toBe("A: the search failed.");
  });
  it("records the pause honestly, before and after the pick", () => {
    const waiting = pauseStep({ name: "Sidecar", matches: 2, answered: false, ledgerRefs: ["Q2"] });
    expect(waiting).toMatchObject({ id: "pause-1", kind: "pause", status: "needs_input", decision: "Waiting for you to say which Sidecar is on the bill: the search found 2." });
    const done = pauseStep({ name: "Sidecar", matches: 2, answered: true, ledgerRefs: ["Q2"], index: 2 });
    expect(done).toMatchObject({ id: "pause-2", status: "ok", decision: "Stopped to ask which Sidecar you meant: the search found 2." });
    expect(done.cause).toBe("You picked one, and the run went on from there.");
    expect(pauseStep({ name: "X", matches: 1, answered: true, ledgerRefs: [] }).decision).toBe("Stopped to ask which X you meant.");
    expectPlain(waiting);
    expectPlain(done);
  });
});

describe("baseline, map and check", () => {
  it("builds the usual crowd from the roster, or says a genre tag stands in", () => {
    const house = baselineStep({ kind: "house", headliners: 12, shows: 15, minHeadliners: 5, status: "ok", ledgerRefs: ["T2", "Q4"] });
    expect(house.decision).toBe("Built the room's usual crowd from 12 headliners on its next 15 shows.");
    expect(house.status).toBe("ok");
    const fell = baselineStep({ kind: "house", headliners: 12, shows: 15, minHeadliners: 5, heatFallback: "came back empty", status: "ok", ledgerRefs: [] });
    expect(fell.status).toBe("degraded");
    expect(fell.cause).toBe("The room's own heatmap came back empty, so a genre tag stands in on the map.");
    const tag = baselineStep({ kind: "tag", headliners: 1, shows: 4, minHeadliners: 5, status: "ok", ledgerRefs: ["T2"] });
    expect(tag).toMatchObject({ status: "degraded", decision: "Used a genre tag for the room's usual crowd." });
    expect(tag.cause).toBe("Only 1 headliner on its next 4 shows matched Qloo, fewer than 5, so the map compares this bill with a genre, not with this room.");
    const none = baselineStep({ kind: "none", headliners: 0, shows: null, minHeadliners: 5, status: "ok", ledgerRefs: [] });
    expect(none.status).toBe("degraded");
    for (const s of [house, fell, tag, none]) expectPlain(s);
  });
  it("puts the first area first in words, never as a ratio", () => {
    const s = heatStep({
      status: "ok",
      baseline: "house",
      first: { name: "East Nashville", lift: 1.8374 },
      topCount: 50,
      minLift: 1.3,
      billFloor: 0.7,
      excludedAreas: 2,
      ledgerRefs: ["Q6", "Q7"],
    });
    expect(s.decision).toBe("Put East Nashville first: about 1.8 times the room's usual crowd.");
    expect(s.cause).toBe("50 areas pass both tests: at least 1.3 times the room's usual crowd, and percentile 70 or higher for this crowd. Left out 2 areas at your request.");
    expectPlain(s);
  });
  it("covers a widened map, no top area and no map at all", () => {
    const wide = heatStep({ status: "degraded", baseline: "tag", first: { name: "Carriage House", lift: 1.52 }, topCount: 1, minLift: 1.3, billFloor: 0.7, excludedAreas: 0, widened: { fromKm: 40, toKm: 60, minCells: 200 }, ledgerRefs: [] });
    expect(wide.decision).toBe("Put Carriage House first: about 1.5 times the genre baseline.");
    expect(wide.cause).toBe(
      "1 area passes both tests: at least 1.3 times the genre baseline, and percentile 70 or higher for this crowd. The search widened to 60 km: fewer than 200 map cells came back inside 40 km.",
    );
    const none = heatStep({ status: "partial", baseline: "house", first: null, topCount: 0, minLift: 1.3, billFloor: 0.7, excludedAreas: 0, thinCells: 120, ledgerRefs: [] });
    expect(none.decision).toBe("No area stood out against the room's usual crowd.");
    expect(none.cause).toContain("Only 120 map cells came back");
    expect(none.cause).toContain("No area passed both tests (at least 1.3 times the room's usual crowd, and percentile 70 or higher for this crowd), so partners are picked near the venue.");
    const fail = heatStep({ status: "empty", baseline: "house", first: null, topCount: 0, minLift: 1.3, billFloor: 0.7, excludedAreas: 0, failure: "No lift map: the bill heatmap came back empty", ledgerRefs: ["Q6"] });
    expect(fail).toMatchObject({ status: "empty", decision: "No lift map: the bill heatmap came back empty." });
    for (const s of [wide, none, fail]) expectPlain(s);
  });
  it("reports the split-half check in each of its states", () => {
    const ok = checkStep({ splitHalf: 0.706, threshold: 0.5, liftVsHeat: -0.21, followsTraffic: false, ledgerRefs: ["Q9", "Q10"] });
    expect(ok).toMatchObject({ id: "heat-check", status: "ok", decision: "Split the bill's acts in two and mapped each half: the two maps broadly agree." });
    expect(ok.cause).toBe("The two halves rank the areas alike: 0.71, where 1 means the same order.");
    const weak = checkStep({ splitHalf: 0.42, threshold: 0.5, liftVsHeat: 0.2, followsTraffic: false, ledgerRefs: [] });
    expect(weak).toMatchObject({ status: "partial", decision: "Ranked partners near the venue: the two halves of the bill put this crowd in different areas." });
    expect(weak.cause).toBe("The two halves rank the areas differently: 0.42, at or below the 0.5 the check needs (1 means the same order).");
    const traffic = checkStep({ splitHalf: 0.8, threshold: 0.5, liftVsHeat: 0.934, followsTraffic: true, ledgerRefs: [] });
    expect(traffic.decision).toBe("Ranked partners near the venue: the map mostly follows general popularity.");
    expect(traffic.cause).toBe("Lift follows general popularity: 0.93, where 1 means the same order.");
    const skipped = checkStep({ splitHalf: null, threshold: 0.5, note: "This bill has one seed, so it could not be split in two to check the map.", liftVsHeat: 0.1, followsTraffic: false, ledgerRefs: [] });
    expect(skipped).toMatchObject({ status: "partial", decision: "Couldn't check the map by splitting the bill in two.", cause: "This bill has one seed, so it could not be split in two to check the map." });
    for (const s of [ok, weak, traffic, skipped]) expectPlain(s);
  });
});

describe("partners and the usual crowd", () => {
  const base: PartnersStepInput = {
    status: "ok",
    kept: 24,
    inAreas: 24,
    areas: 3,
    nearVenue: 0,
    areasWanted: 3,
    areasUsed: 3,
    day: "thursday",
    hoursUnknown: 0,
    droppedClosed: 4,
    droppedCategory: 0,
    widenedRadius: 0,
    widenedRadiusM: 3500,
    widenedCategories: 0,
    belowMinimum: false,
    minTotal: 15,
    skippedCategories: 0,
    ledgerRefs: ["Q13", "Q15"],
  };
  it("states what was kept and why", () => {
    const s = partnersStep(base);
    expect(s.decision).toBe("Kept 24 places across 3 top areas, at most 2 of a kind in each.");
    expect(s.cause).toBe("Qloo ranked them for this crowd, and every one is open Thursday. Dropped 4 places marked closed.");
    expectPlain(s);
  });
  it("covers near-venue lists, unknown hours, exclusions, widening and a thin list", () => {
    const s = partnersStep({
      ...base,
      status: "partial",
      kept: 10,
      inAreas: 6,
      areas: 1,
      nearVenue: 4,
      areasUsed: 1,
      hoursUnknown: 2,
      droppedClosed: 0,
      droppedCategory: 3,
      categoryReason: "all-ages show",
      widenedRadius: 1,
      widenedCategories: 1,
      belowMinimum: true,
      skippedCategories: 2,
    });
    expect(s.decision).toBe("Kept 10 places: 6 in 1 top area and 4 near the venue.");
    expect(s.cause).toBe(
      "Qloo ranked them for this crowd. 2 places list no hours for Thursday, so call first; the rest are open. Left out 3 places by type (all-ages show). Only 1 area stood out, so the rest of the list comes from near the venue. 1 area search came back short and widened to 3,500 m. 1 search also took in more kinds of places. 2 kinds of place skipped: no pinned tag yet. That's short of the 15 the list aims for, so treat it as a starting list.",
    );
    expectPlain(s);
    expect(partnersStep({ ...base, inAreas: 0, nearVenue: 24, areas: 0 }).decision).toBe("Kept 24 places near the venue, at most 2 of a kind.");
    expect(partnersStep({ ...base, kept: 0, inAreas: 0, status: "empty" }).decision).toBe("No place passed the filters.");
    expect(partnersStep({ ...base, status: "error", failure: "The partner search failed" }).decision).toBe("The partner search failed.");
  });
  it("names the places the usual crowd ranks as high", () => {
    const dropped = usualCrowdStep({ baseline: "house", compared: 3, failed: [], dropped: ["Gable Hall", "The Larch"], penalized: 20, kept: 24, ledgerRefs: ["Q14", "Q16"] });
    expect(dropped.decision).toBe("Marked down the places the room's usual crowd ranks as high; 2 places fell off the list.");
    expect(dropped.cause).toBe(
      "Gable Hall and The Larch: the same search for the room's usual crowd ranks them about as high, so they'd suit any night here. They come back only if nothing better is open nearby.",
    );
    const one = usualCrowdStep({ baseline: "tag", compared: 1, failed: ["near venue"], dropped: ["The Larch"], penalized: 0, kept: 10, ledgerRefs: [] });
    expect(one.status).toBe("partial");
    expect(one.cause).toBe(
      "The Larch: the same search for the genre baseline ranks it about as high, so it says little about this bill. It comes back only if nothing better is open nearby. The same search for the genre baseline failed for near venue, so those places weren't compared.",
    );
    const marked = usualCrowdStep({ baseline: "house", compared: 3, failed: [], dropped: [], penalized: 7, kept: 24, ledgerRefs: [] });
    expect(marked.decision).toBe("Marked down 7 of the 24 places that the room's usual crowd ranks nearly as high; none fell off the list.");
    const clean = usualCrowdStep({ baseline: "house", compared: 3, failed: [], dropped: [], penalized: 0, kept: 24, ledgerRefs: [] });
    expect(clean.decision).toBe("None of the 24 places ranks as high for the room's usual crowd.");
    const failed = usualCrowdStep({ baseline: "house", compared: 0, failed: ["tile 1"], dropped: [], penalized: 0, kept: 5, ledgerRefs: ["Q14"] });
    expect(failed).toMatchObject({ status: "partial", decision: "Couldn't compare the list with the room's usual crowd." });
    for (const s of [dropped, one, marked, clean, failed]) expectPlain(s);
  });
  it("ranks the operator's own list", () => {
    const s = declaredStep({ status: "ok", declared: 8, ranked: 6, ledgerRefs: ["Q19"] });
    expect(s.decision).toBe("Ranked 6 of your 8 places for this bill.");
    expect(s.cause).toBe("2 aren't in Qloo's catalog, so they stay on your list in your order.");
    expect(declaredStep({ status: "ok", declared: 2, ranked: 1, ledgerRefs: [] }).cause).toBe("1 isn't in Qloo's catalog, so it stays on your list in your order.");
    expectPlain(s);
  });
});

describe("spots, media, summary, checks and the control list", () => {
  it("picks spots near the room and keeps bars off fan copy without an age rule", () => {
    const s = prePostStep({ status: "partial", spots: 8, unknownHours: 2, radiusM: 2500, widened: { fromM: 1500, minSpots: 6 }, barsOperatorOnly: 3, legalAgeEnforced: null, ledgerRefs: ["Q22"] });
    expect(s.decision).toBe("Picked 8 spots within 2.5 km of the room; 2 list no hours for show night, so call first.");
    expect(s.cause).toBe("Fewer than 6 came back inside 1.5 km, so the search widened to 2.5 km. Bars stay off fan copy: Ticketmaster doesn't list an age limit for the show.");
    expect(prePostStep({ status: "ok", spots: 8, unknownHours: 0, radiusM: 1500, barsOperatorOnly: 0, legalAgeEnforced: true, ledgerRefs: [] }).decision).toBe("Picked 8 spots within 1.5 km of the room, open on show night.");
    expect(prePostStep({ status: "empty", spots: 0, unknownHours: 0, radiusM: null, barsOperatorOnly: 0, legalAgeEnforced: true, ledgerRefs: [] }).decision).toBe("No spot near the room came back open on show night.");
    expectPlain(s);
  });
  it("labels podcasts and the sponsor national until the probe says otherwise", () => {
    const s = mediaStep({ status: "ok", podcasts: 4, sponsor: true, local: false, adultBrandsExcluded: true, legalAgeEnforced: false, ledgerRefs: ["Q24", "Q25"] });
    expect(s.decision).toBe("Added 4 podcasts and 1 sponsor brand.");
    expect(s.cause).toBe("All are labelled national: local ranking isn't verified yet. Alcohol, tobacco and gambling brands are left out: Ticketmaster lists the show as all ages.");
    expect(mediaStep({ status: "partial", podcasts: 2, sponsor: false, local: true, adultBrandsExcluded: false, legalAgeEnforced: true, ledgerRefs: [] }).decision).toBe("Added 2 podcasts; no sponsor brand came back.");
    expect(mediaStep({ status: "empty", podcasts: 0, sponsor: false, local: false, adultBrandsExcluded: false, legalAgeEnforced: true, ledgerRefs: [] }).decision).toBe("No podcasts or sponsor brand came back.");
    expectPlain(s);
  });
  it("says who wrote the summary", () => {
    expect(narrateStep({ templated: true, hooks: 3, hooksStatus: "ok", ledgerRefs: ["Q28"] }).decision).toBe("Wrote the summary and 3 fan copy lines from a fixed template; no model was called.");
    const model = narrateStep({ templated: false, hooks: 2, hooksStatus: "partial", ledgerRefs: ["L1"] });
    expect(model.decision).toBe("Claude wrote the summary and 2 fan copy lines from this run's results.");
    expect(model.cause).toBe("Only 2 copy lines passed the tag allowlist and the checks.");
    const none = narrateStep({ templated: true, hooks: 0, hooksStatus: "empty", ledgerRefs: [] });
    expect(none.status).toBe("partial");
    expectPlain(model);
  });
  it("reports guard drops and policy holds as counts only", () => {
    const s = guardStep({ dropped: 0, denied: 4, alcoholHeld: 2, ledgerRefs: [] });
    expect(s.decision).toBe("Checked every line against this run's requests; nothing had to go.");
    expect(s.cause).toBe("Held back 4 tags by policy: none of them appears in copy or on this sheet. Kept 2 alcohol tags out of fan copy: Ticketmaster doesn't list the show as 21+.");
    expect(guardStep({ dropped: 0, denied: 0, alcoholHeld: 2, allAgesByOperator: true, ledgerRefs: [] }).cause).toBe("Kept 2 alcohol tags out of fan copy: you set the show to all ages.");
    expect(guardStep({ dropped: 2, denied: 0, alcoholHeld: 0, ledgerRefs: [] })).toMatchObject({ decision: "Dropped 2 lines that cited something this run didn't return." });
    expect(guardStep({ dropped: 2, denied: 0, alcoholHeld: 0, ledgerRefs: [] }).cause).toBeUndefined();
    expectPlain(s);
  });
  it("describes the list without Qloo and how it ran", () => {
    const s = controlStep({ armStatus: "template", searches: 8, places: 40, overlap: 2, note: "No model configured: fixed category queries stood in.", ledgerRefs: ["P1", "P2"] });
    expect(s).toMatchObject({ kind: "other", status: "degraded", decision: "Built a list without Qloo from 8 Google Places searches: 2 of its 40 places are also on this sheet." });
    expect(s.cause).toBe("No model configured: fixed category queries stood in.");
    expect(controlStep({ armStatus: "model: ok", searches: 1, places: 5, overlap: 1, ledgerRefs: [] })).toMatchObject({ status: "ok", decision: "Built a list without Qloo from 1 Google Places search: 1 of its 5 places is also on this sheet." });
    expectPlain(s);
  });
});

describe("ubiquityDrops", () => {
  const tiles: LiftTile[] = [{ geohash: "dn6jv1", lat: 36.16, lon: -86.78, lift: 1.8, billPct: 0.9, housePct: 0.3, popularityPct: 0.5 }];
  const ents: QlooEntity[] = ["A", "B", "C", "D"].map((n, i) => place(n, { id: `E-${n}`, category: ["cafe", "record_store", "book_store", "clothing_store"][i] as string }));

  it("names the place the penalty pushed off the list", () => {
    const pools: PartnerPool[] = [{ tileGeohash: "dn6jv1", ledgerRef: "Q9", entities: ents, house: { ranks: new Map([["E-A", 1]]), size: 4, ledgerRef: "Q10" } }];
    const drops = ubiquityDrops(pools, tiles, { maxTotal: 1, minTotal: 0 });
    expect(drops.map((d) => d.entity.name)).toEqual(["A"]);
    expect(drops[0]).toMatchObject({ ledgerRef: "Q9", twinRef: "Q10", qlooRank: 1, houseRank: 1, penalty: 0.5 });
  });
  it("is empty without twins or when the penalty changes nothing", () => {
    expect(ubiquityDrops([{ tileGeohash: "dn6jv1", ledgerRef: "Q9", entities: ents }], tiles, { maxTotal: 1, minTotal: 0 })).toEqual([]);
    const pools: PartnerPool[] = [{ tileGeohash: "dn6jv1", ledgerRef: "Q9", entities: ents, house: { ranks: new Map([["E-D", 1]]), size: 4, ledgerRef: "Q10" } }];
    expect(ubiquityDrops(pools, tiles, { maxTotal: 1, minTotal: 0 })).toEqual([]);
  });
});
