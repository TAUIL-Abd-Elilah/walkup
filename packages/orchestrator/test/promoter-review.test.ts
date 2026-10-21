/**
 * Fixes from a promoter's read of a live sheet, at the orchestrator: budget shares follow the area order, revision
 * wording ("already all ages", each left-out type once), partner lines kept to their shared tags, "house" never
 * printed, area names a promoter uses (with the OSM name as an alias), live sheets never hypothetical, and the
 * offline refresh of a stored sheet. Fixture world only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { LiftTile, Partner, StreetSheet } from "@walkup/contracts";
import { diffSheets, disambiguateNames, isExcludedArea, nonIncreasing, partnerLinesWithinTags, planShow, refreshSheet, splitBudget } from "../src/index";
import { excludedInWords } from "../src/revise/diff";
import { tidyAreaPhrases, usualCrowdWording } from "../src/steps/copy";
import { deps, runPreset, sheetOf } from "./helpers";

function tile(geohash: string, lift: number, adults: number, name?: string): LiftTile {
  const t: LiftTile = { geohash, lat: 38.9, lon: -77, lift, billPct: 0.9, housePct: 0.2, popularityPct: 0.5, adultPopulation: adults };
  if (name) t.name = name;
  return t;
}

describe("budget split follows the area order", () => {
  it("levels any later area that would get more than an earlier one", () => {
    const lv = nonIncreasing([0.5, 0.1, 0.1, 0.2, 0.1]);
    expect(lv[0]).toBe(0.5);
    for (const i of [1, 2, 3]) expect(lv[i]).toBeCloseTo(0.4 / 3);
    expect(lv[4]).toBe(0.1);
    const v = nonIncreasing([0.3, 0.1, 0.4, 0.2]);
    for (let i = 1; i < v.length; i++) expect(v[i]!).toBeLessThanOrEqual(v[i - 1]! + 1e-12);
    expect(v.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it("never gives area 4 more than area 2, and still sums to 1 with the floor", () => {
    const shares = splitBudget([tile("a", 2.8, 120000), tile("b", 2.4, 20000), tile("c", 2.2, 20000), tile("d", 1.8, 70000), tile("e", 1.7, 50000)]).map((r) => r.share);
    for (let i = 1; i < shares.length; i++) expect(shares[i]!).toBeLessThanOrEqual(shares[i - 1]! + 0.001);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(0.1 - 0.001);
  });
});

describe("words on the sheet", () => {
  it("says each left-out type once, and most bar types as one group", () => {
    expect(excludedInWords(["bar", "pub", "sports_bar", "irish_pub", "wine_bar", "cocktail_bar", "beer_bar", "brewpub", "lounge", "night_club", "nightclub", "dive_bar"])).toBe(
      "bars and other drinking places",
    );
    expect(excludedInWords(["night_club", "nightclub"])).toBe("night clubs");
    expect(excludedInWords(["night_club", "nightclub", "clothing_store"])).toBe("night clubs and clothing stores");
  });
  it("never prints house for the room's usual crowd", () => {
    expect(usualCrowdWording("its share of the bill well above its share of the house")).toBe("its share of the bill well above its share of the room's usual crowd");
    expect(usualCrowdWording("far above the house share")).toBe("far above the room's usual crowd's share");
    expect(usualCrowdWording("leans more than the house crowd")).toBe("leans more than the room's usual crowd");
    expect(usualCrowdWording("the house twin call")).toBe("the house twin call");
  });
  it("tidies a line after an area name went in", () => {
    const names = ["U Street / Shaw", "Laurel", "H Street NE"];
    expect(tidyAreaPhrases("Restaurant on U Street in U Street / Shaw, open from 17:00.", names)).toBe("Restaurant on U Street / Shaw, open from 17:00.");
    expect(tidyAreaPhrases("Deli in Laurel in Laurel, open 07:00 to 16:00.", names)).toBe("Deli in Laurel, open 07:00 to 16:00.");
    expect(tidyAreaPhrases("Bar on Bladensburg Road in H Street NE.", names)).toBe("Bar on Bladensburg Road in H Street NE.");
  });
  it("keeps a partner line to the tags listed as that partner's shared tags", () => {
    const p = (id: string, tags: string[]) => ({ entity: { entityId: id } as Partner["entity"], explain: { tags: tags.map((name) => ({ id: name, name })), activation: "", confidence: "medium" as const, confidenceWhy: "", ledgerRefs: [] } });
    const lines = [
      { entityId: "A", text: "Restaurant on H Street, open Thursday 17:00 to 21:00 for a pre-show meal, sharing the bill's country tag." },
      { entityId: "B", text: "Cafe near the venue, a calm stop that shares the bill's Folk tag." },
      { entityId: "C", text: "Shares the bill's rhythm and blues tag." },
    ];
    const r = partnerLinesWithinTags(lines, [p("A", ["Cozy"]), p("B", ["Folk"]), p("C", [])]);
    expect(r.lines).toEqual([
      { entityId: "A", text: "Restaurant on H Street, open Thursday 17:00 to 21:00 for a pre-show meal." },
      { entityId: "B", text: "Cafe near the venue, a calm stop that shares the bill's Folk tag." },
    ]);
    expect(r).toMatchObject({ changed: 1, dropped: 1 });
  });
});

describe("area names", () => {
  it("brackets the OSM name when two areas share the name people use", () => {
    const tiles = [tile("a", 2, 1, "Alexandria"), tile("b", 1.9, 1, "Alexandria"), tile("c", 1.8, 1, "Laurel")];
    const alias = new Map([
      ["a", "Del Ray"],
      ["b", "Valley View"],
    ]);
    expect(disambiguateNames(tiles, { lat: 38.88, lon: -77.02 }, (g) => alias.get(g)).map((t) => t.name)).toEqual(["Alexandria (Del Ray)", "Alexandria (Valley View)", "Laurel"]);
    // Without aliases, distance and direction tell them apart.
    expect(disambiguateNames(tiles, { lat: 38.88, lon: -77.02 }).map((t) => t.name)[0]).toMatch(/^Alexandria, [\d.]+ km \w+$/);
  });
  it("an area the operator names by either name is skipped", () => {
    const t = { geohash: "dqcm29", name: "H Street NE" };
    expect(isExcludedArea(t, ["H Street NE, DC"])).toBe(true);
    expect(isExcludedArea(t, ["langston"], "Langston")).toBe(true);
    expect(isExcludedArea({ geohash: "x", name: "Alexandria (Del Ray)" }, ["Alexandria"])).toBe(true);
    expect(isExcludedArea({ geohash: "x", name: "Alexandria (Del Ray)" }, ["Alexandria (Valley View)"])).toBe(false);
    expect(isExcludedArea(t, ["Laurel"], "Langston")).toBe(false);
  });
});

describe("a live sheet is never hypothetical; a sample one says so", () => {
  let sample: StreetSheet;
  beforeAll(async () => {
    sample = sheetOf((await runPreset("g1-a", deps())).final);
  }, 60_000);
  it("sample", () => {
    expect(sample.mode).toBe("fixture");
    expect(sample.hypothetical).toBe(true);
  });
  it("live mode with the same what-if capacity", async () => {
    const d = { ...deps(), mode: "live" as const };
    const r = await planShow({ bill: sample.bill, operator: { capacity: 800, seatsLeft: 200 } }, d);
    const s = sheetOf(r);
    expect(s.mode).toBe("live");
    expect(s.hypothetical).toBe(false);
    expect(s.limits).toContain("Planning tool; no sales data for this show is known or shown.");
  }, 60_000);
});

describe("refreshSheet (offline post-processing of a stored sheet)", () => {
  let parent: StreetSheet;
  let child: StreetSheet;
  beforeAll(async () => {
    parent = sheetOf((await runPreset("g1-a", deps())).final);
    child = sheetOf((await runPreset("g1-b", deps())).final);
  }, 60_000);

  it("is a no-op on the words of a fresh sheet, and makes no call", () => {
    const before = parent.ledger.length;
    const { sheet, report } = refreshSheet(parent);
    expect(sheet.ledger.length).toBe(before);
    expect(report.renamedAreas).toEqual([]);
    expect(sheet.cards.liftMap.results.tiles.map((t) => t.name)).toEqual(parent.cards.liftMap.results.tiles.map((t) => t.name));
    expect(sheet.discovery?.headline).toBe(parent.discovery?.headline);
  });

  it("keeps one spot per chain brand and says the new count", () => {
    const old = structuredClone(parent);
    const first = old.cards.prePost.results[0]!;
    const a = { ...structuredClone(first), chain: true, entity: { ...first.entity, entityId: "chain-a", name: "Starbucks Coffee Company", tags: [] } };
    const b = { ...structuredClone(first), chain: true, entity: { ...first.entity, entityId: "chain-b", name: "Starbucks Coffee Company", tags: [] } };
    old.cards.prePost.results.push(a, b);
    const n = old.cards.prePost.results.length;
    old.cards.prePost.summary = `${n} spots within 1.5 km open on show night.`;
    old.narration = { ...old.narration!, summary: `It also lists ${n} spots for before and after the show.` };
    const { sheet, report } = refreshSheet(old);
    expect(sheet.cards.prePost.results.filter((s) => s.entity.name === "Starbucks Coffee Company")).toHaveLength(1);
    expect(report.droppedSpots.map((d) => d.why)).toContain("a second spot of the same chain");
    const m = sheet.cards.prePost.results.length;
    expect(sheet.cards.prePost.summary).toMatch(new RegExp(`^${m} spots`));
    expect(sheet.narration!.summary).toContain(`${m} spots for before and after the show`);
  });

  it("renames old area names everywhere, plain-words the chips, drops leaked bars and recomputes the discovery", () => {
    const old = structuredClone(child);
    const t0 = old.cards.liftMap.results.tiles[0]!;
    const newName = t0.name!;
    t0.name = "Old Subdivision";
    for (const p of old.cards.partners.results) {
      if (p.tileGeohash === t0.geohash) p.tileName = "Old Subdivision";
      p.chips = p.chips.map((c) => (/room's usual crowd/.test(c.label) ? { ...c, label: "tonight vs house +3 ranks" } : c));
    }
    old.narration!.summary = `Start in Old Subdivision. ${old.narration!.summary}`;
    old.operator = { ...old.operator, allAges: true };
    const leak = structuredClone(old.cards.partners.results[0]!);
    leak.entity = { ...leak.entity, entityId: "leak", name: "Live-K Karaoke Bar", tags: [] };
    leak.category = "restaurant";
    old.cards.partners.results.push(leak);
    old.hypothetical = true;
    old.mode = "live";
    delete old.discovery;

    const { sheet, report } = refreshSheet(old);
    expect(report.renamedAreas.some((r) => r.from === "Old Subdivision")).toBe(true);
    expect(sheet.cards.liftMap.results.tiles[0]!.name).toBe(newName);
    expect(sheet.narration!.summary).toContain(`Start in ${newName}.`);
    expect(sheet.cards.partners.results.some((p) => p.tileName === "Old Subdivision")).toBe(false);
    expect(sheet.cards.partners.results.some((p) => p.entity.name === "Live-K Karaoke Bar")).toBe(false);
    expect(report.droppedPartners.map((p) => p.name)).toContain("Live-K Karaoke Bar");
    for (const p of sheet.cards.partners.results) for (const c of p.chips) expect(c.label).not.toMatch(/house/);
    expect(sheet.hypothetical).toBe(false);
    expect(sheet.discovery?.kind).toBeDefined();
  });

  it("rebuilds a revision's change list against its parent", () => {
    const rev = structuredClone(parent);
    rev.operator = { ...rev.operator, allAges: true, excludeCategories: ["night_club", "nightclub"] };
    rev.bill = { ...rev.bill, legalAgeEnforced: false };
    const par = { ...structuredClone(parent), bill: { ...parent.bill, legalAgeEnforced: false } };
    rev.revision = { parentPlanId: par.planId, instruction: "All ages, no bars", interpreter: "rules", toolCalls: [], changes: [] };
    const { sheet } = refreshSheet(rev, { parent: par });
    const rows = sheet.revision!.changes.filter((c) => c.kind === "setting_changed");
    expect(rows.find((c) => c.label === "All ages")?.detail).toMatch(/^Already all ages/);
    expect(rows.find((c) => c.label === "Left out")?.detail).toBe("night clubs");
    expect(diffSheets(par, sheet).length).toBeGreaterThan(0);
  });
});
