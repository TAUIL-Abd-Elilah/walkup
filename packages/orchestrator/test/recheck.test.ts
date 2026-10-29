/**
 * Fixes from the October audit, on a fixture-world sheet changed by hand: the revision banner diffs the numbered
 * areas by name, a partner dropped for the new street-team day says so and cites its own area's search, a radius that
 * widened back to the same map says so, and `recheckSheet` holds a stored sheet to the current checks without
 * changing what the run found. Every name, tag and line below is synthetic or from the fixture world.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { LiftTile, Partner, PrePostSpot, QlooEntity, StreetSheet } from "@walkup/contracts";
import { diffSheets, numberedTiles, partnerLinesNearArea, radiusNoOp, recheckSheet, reviseStep, RULES_CHOSEN_READER, skippedCategoriesReason } from "../src/index";
import { deniedEntity } from "../src/steps/media";
import { deps, runPreset, sheetOf } from "./helpers";

let base: StreetSheet;

beforeAll(async () => {
  base = sheetOf((await runPreset("g1-a", deps())).final);
});

const clone = (): StreetSheet => structuredClone(base);

function tile(geohash: string, name: string, lat: number, lift: number, zip: string): LiftTile {
  return { geohash, name, lat, lon: -86.0, lift, billPct: 0.9, housePct: 0.4, popularityPct: 0.5, zctas: [zip] };
}

// Six areas at least 3 km apart: five are numbered, the sixth is a map square no list shows.
const SIX = [
  tile("aaaaa1", "H Street NE", 36.0, 2.5, "90001"),
  tile("aaaaa2", "Kenilworth", 36.1, 2.2, "90002"),
  tile("aaaaa3", "Anacostia", 36.2, 2.0, "90003"),
  tile("aaaaa4", "Langdon", 36.3, 1.8, "90004"),
  tile("aaaaa5", "Bowie", 36.4, 1.6, "90005"),
  tile("aaaaa6", "Northwest", 36.5, 1.4, "90006"),
];

describe("the partners card's skipped kinds", () => {
  it("says the plural words with a plural verb, joined with 'and'", () => {
    expect(skippedCategoriesReason(["record_store"])).toBe("Record stores aren't searched yet: Qloo has no tag to find them by.");
    expect(skippedCategoriesReason(["record_store", "barber_shop"])).toMatch(/^Record stores and barbershops aren't searched yet/);
  });
});

describe("revision banner: areas", () => {
  it("diffs the numbered areas 1-5 by name, so its rows match the list a reader sees", () => {
    const parent = clone();
    parent.cards.liftMap.results.tiles = SIX.map((t) => ({ ...t }));
    const child = clone();
    // Kenilworth is gone; Northwest moves up into the numbered five; H Street NE comes back on a nearby square.
    child.cards.liftMap.results.tiles = [{ ...SIX[0]!, geohash: "aaaab1", lat: 36.005, lift: 2.6 }, ...SIX.filter((t) => t.name !== "Kenilworth" && t.name !== "H Street NE")];
    expect(numberedTiles(child.cards.liftMap.results.tiles).map((t) => t.name)).toEqual(["H Street NE", "Anacostia", "Langdon", "Bowie", "Northwest"]);
    const rows = diffSheets(parent, child).filter((c) => c.kind === "tile_added" || c.kind === "tile_removed");
    expect(rows.map((c) => [c.kind, c.label])).toEqual([
      ["tile_removed", "Kenilworth"],
      ["tile_added", "Northwest"],
    ]);
    expect(rows[0]!.detail).toBe("no longer among the numbered areas (was area 2, map square aaaaa2)");
    expect(rows[1]!.detail).toMatch(/^now area 5, about 1\.4 times .+ \(map square aaaaa6\)$/);
  });

  it("a radius that widened back to the parent's map says so, and the areas stay", () => {
    const parent = clone();
    parent.operator = { ...parent.operator, radiusKm: 40 };
    parent.cards.liftMap.reason = "The search widened to 60 km (fewer than 200 map squares came back within 40 km).";
    const child = structuredClone(parent);
    child.operator = { ...child.operator, radiusKm: 10 };
    child.cards.liftMap.reason = "The search widened to 60 km (fewer than 200 map squares came back within 10 km).";
    expect(radiusNoOp(parent, child)).toBe(true);
    const row = diffSheets(parent, child).find((c) => c.label === "Search radius");
    expect(row?.detail).toBe("10 km (was 40 km); the map search still widened to 60 km (fewer than 200 map squares came back within 10 km), so the areas are the same as before");
    const narrow = structuredClone(child);
    delete narrow.cards.liftMap.reason;
    expect(radiusNoOp(parent, narrow)).toBe(false);
    expect(diffSheets(parent, narrow).find((c) => c.label === "Search radius")?.detail).toBe("10 km (was 40 km)");
  });
});

describe("revision banner: partners", () => {
  const SAT_CLOSED = {
    thursday: [{ opens: "T16:00:00", closed: false, closes: "T23:00:00" }],
    saturday: [{ opens: null, closed: true, closes: null }],
  };

  it("a partner closed on the new street-team day says so and cites its own area's search, not every area's", () => {
    const parent = clone();
    parent.operator = { ...parent.operator, streetTeamDays: ["thursday"] };
    const [first] = parent.cards.partners.results.filter((p) => p.tileGeohash && (p.explain?.ledgerRefs ?? []).length > 0);
    if (!first) throw new Error("fixture has no area partner");
    const gone: Partner = { ...first, entity: { ...first.entity, entityId: "E-GONE", name: "Kettle Tavern", properties: { ...first.entity.properties, hours: SAT_CLOSED } }, category: "bar" };
    parent.cards.partners.results = [gone, ...parent.cards.partners.results];
    const child = clone();
    child.operator = { ...child.operator, streetTeamDays: ["saturday"] };
    const own = new Set(child.cards.partners.results.filter((p) => p.tileGeohash === gone.tileGeohash).flatMap((p) => p.explain?.ledgerRefs ?? []));
    const row = diffSheets(parent, child).find((c) => c.kind === "partner_removed" && c.label === "Kettle Tavern");
    expect(row?.detail).toBe(`bar near ${gone.tileName}: closed Saturday, the new street-team day`);
    expect(own.size).toBeGreaterThan(0);
    expect(new Set(row?.ledgerRefs)).toEqual(own);
    // Same day as before: the place was open then, so the list was rebuilt.
    const sameDayChild = clone();
    sameDayChild.operator = { ...sameDayChild.operator, streetTeamDays: ["thursday"] };
    expect(diffSheets(parent, sameDayChild).find((c) => c.label === "Kettle Tavern")?.detail).toMatch(/dropped when the list was rebuilt/);
    // Thursday and Saturday -> Saturday: Saturday was a street-team day already, so it is not "new".
    const bothDays = { ...parent, operator: { ...parent.operator, streetTeamDays: ["thursday", "saturday"] as StreetSheet["operator"]["streetTeamDays"] } };
    expect(diffSheets(bothDays, child).find((c) => c.label === "Kettle Tavern")?.detail).toBe(`bar near ${gone.tileName}: closed Saturday, now the only street-team day`);
  });
});

describe("partner lines say 'near' the area", () => {
  it("rewrites 'in' and 'on' the area, unless the place's own address is on that street", () => {
    const p = (id: string, area: string, address: string) => ({ entity: { entityId: id } as QlooEntity, tileName: area, address });
    const out = partnerLinesNearArea(
      [
        { entityId: "a", text: "Sports bar on H Street NE, open Thursday." },
        { entityId: "b", text: "Pie shop on H Street NE, open Thursday." },
        { entityId: "c", text: "Bar and grill in Kenilworth." },
      ],
      [p("a", "H Street NE", "1007 8th St SE Washington, DC 20003"), p("b", "H Street NE", "1339 H St NE Washington, DC 20002"), p("c", "Kenilworth", "5723 Tuxedo Rd Hyattsville, MD 20781")],
    );
    expect(out.lines.map((l) => l.text)).toEqual(["Sports bar near H Street NE, open Thursday.", "Pie shop on H Street NE, open Thursday.", "Bar and grill near Kenilworth."]);
    expect(out.changed).toBe(2);
  });

  it("reads 'on H Street' as the area 'H Street NE', and keeps it for a place on that street", () => {
    const p = (id: string, area: string, address: string) => ({ entity: { entityId: id } as QlooEntity, tileName: area, address });
    const out = partnerLinesNearArea(
      [
        { entityId: "d", text: "Bar on H Street, shares the intimate tag." },
        { entityId: "e", text: "Bar on H Street, shares the cozy tag." },
        { entityId: "f", text: "Cafe on U Street, open Saturday." },
      ],
      [
        p("d", "H Street NE", "1103 Bladensburg Rd NE Washington, DC 20002"),
        p("e", "H Street NE", "1337 H St NE Washington, DC 20002"),
        p("f", "U Street / Shaw", "1500 9th St NW Washington, DC 20001"),
      ],
    );
    expect(out.lines.map((l) => l.text)).toEqual(["Bar near H Street NE, shares the intimate tag.", "Bar on H Street, shares the cozy tag.", "Cafe near U Street / Shaw, open Saturday."]);
    expect(out.changed).toBe(2);
    // A second pass changes nothing.
    expect(partnerLinesNearArea(out.lines, [p("d", "H Street NE", "1103 Bladensburg Rd NE Washington, DC 20002")]).changed).toBe(0);
  });
});

describe("recheckSheet", () => {
  it("fixes the skipped-kinds grammar, words the Checks step by reason, and changes no partner, area or spot", () => {
    const s = clone();
    s.cards.partners.reason = "Record stores isn't searched yet: Qloo has no tag to find them by.";
    s.guard = {
      ...s.guard,
      dropped: 3,
      reasons: [...s.guard.reasons, 'partnerLines[0]: alcohol word "Wine" on a show that is not 21+', "partnerLines[7]: not a partner", "partnerLines[8]: not a partner"],
    };
    const { sheet, report } = recheckSheet(s);
    expect(sheet.cards.partners.reason).toBe("Record stores aren't searched yet: Qloo has no tag to find them by.");
    expect(sheet.steps?.find((x) => x.id === "guard")?.decision).toBe(
      "Dropped 3 lines: 2 about places that aren't partners on this sheet and 1 with an alcohol word on a show that isn't 21+.",
    );
    expect(report.rewritten).toEqual(expect.arrayContaining(["partners reason", "guard step"]));
    expect(sheet.cards.partners.results.map((p) => p.entity.entityId)).toEqual(s.cards.partners.results.map((p) => p.entity.entityId));
    expect(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t.name, t.lift])).toEqual(s.cards.liftMap.results.tiles.map((t) => [t.geohash, t.name, t.lift]));
    // Run twice, nothing more changes.
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("swaps a partner line that calls a far place close to the room for the template's, and records why", () => {
    const s = clone();
    const p = s.cards.partners.results[0]!;
    p.explain = { ...p.explain!, distanceKm: 35.1 };
    s.narration = { ...s.narration!, templated: false, partnerLines: [{ entityId: p.entity.entityId, text: "A place that is close to the room." }] };
    const { sheet, report } = recheckSheet(s);
    expect(report.replaced).toEqual(["partnerLines[0]: says the place is near the room; the sheet puts it 35.1 km away"]);
    expect(sheet.narration!.partnerLines[0]!.text).not.toMatch(/close to the room/);
    expect(sheet.guard.reasons).toContain("replaced by the template: partnerLines[0]: says the place is near the room; the sheet puts it 35.1 km away");
  });

  it("on a no-bars sheet drops a bar and grill from the spots, and the counts follow", () => {
    const s = clone();
    s.operator = { ...s.operator, allAges: true };
    const first = s.cards.prePost.results[0]!;
    const bar: PrePostSpot = {
      ...first,
      entity: { ...first.entity, entityId: "E-SWIG", name: "Swig", tags: [{ id: "urn:tag:category:place:bar_grill", name: "Bar grill", type: "urn:tag:category:place" }] },
      category: "restaurant",
    };
    s.cards.prePost.results = [...s.cards.prePost.results.filter((x) => !/bar|pub|tavern|lounge/i.test(x.entity.name)), bar];
    const n = s.cards.prePost.results.length;
    s.cards.prePost.summary = `${n} spots within 1.5 km open on show night.`;
    s.narration = { ...s.narration!, summary: `It also lists ${n} spots for before and after the show.` };
    const { sheet, report } = recheckSheet(s);
    expect(report.droppedSpots.map((d) => d.name)).toContain("Swig");
    expect(sheet.cards.prePost.results.some((x) => x.entity.entityId === "E-SWIG")).toBe(false);
    const left = sheet.cards.prePost.results.length;
    expect(sheet.cards.prePost.summary).toMatch(new RegExp(`^${left} spots? within 1\\.5 km`));
    expect(sheet.cards.prePost.summary).toMatch(/Left out \d+ places? that (is a bar|are bars) by (its|their) name or tags \(all-ages show\)\.$/);
    expect(sheet.narration!.summary).toContain(`${left} ${left === 1 ? "spot" : "spots"} for before and after the show`);
  });

  it("brings the spots step's counts in line with the list after a second spot of a brand was dropped", () => {
    const s = clone();
    const first = s.cards.prePost.results[0]!;
    const local = s.cards.prePost.results.filter((x) => x.chain !== true);
    s.cards.prePost.results = [...local, { ...first, entity: { ...first.entity, entityId: "E-CHAIN", name: "Example Coffee Chain" }, chain: true }];
    const n = s.cards.prePost.results.length;
    s.cards.prePost.summary = `${n} spots within 1.5 km open on show night. 1 of ${n} spots is a national chain, listed last: no local place filled its slot. 3 more chains left off: 2 for local places, 1 as a second spot of a brand already listed.`;
    s.steps = (s.steps ?? []).map((x) =>
      x.id === "prepost"
        ? {
            ...x,
            decision: `Picked ${n + 1} spots within 1.5 km of the room, open on show night.`,
            cause: "Listed 2 national chains last, after the local spots: no local spot filled their slot; left off 2 national chains: Example Burger and Example Pizza.",
          }
        : x,
    );
    const { sheet, report } = recheckSheet(s);
    const step = sheet.steps!.find((x) => x.id === "prepost")!;
    expect(step.decision).toBe(`Picked ${n} spots within 1.5 km of the room, open on show night.`);
    expect(step.cause).toBe(
      "Listed 1 national chain last, after the local spots: no local spot filled its slot; left off 2 national chains: Example Burger and Example Pizza. Left off 1 more as a second spot of a brand already listed.",
    );
    expect(report.rewritten).toContain("spots step");
    expect(sheet.cards.prePost.results).toEqual(s.cards.prePost.results);
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("says the rules read the note by choice when the sheet's own ledger shows a model was set up", () => {
    const s = clone();
    s.revision = { parentPlanId: "p", instruction: "All ages", interpreter: "rules", toolCalls: [], changes: [] };
    s.steps = [{ id: "revise", kind: "revise", label: "Your change", decision: "Changed 1 setting.", cause: "Fixed rules read it (no model is set up here) and changed the age setting.", status: "ok", ledgerRefs: [] }, ...(s.steps ?? [])];
    s.ledger = [...s.ledger, { ...s.ledger[0]!, id: "L1", kind: "anthropic" }];
    const { sheet } = recheckSheet(s);
    expect(sheet.steps![0]!.cause).toBe("Fixed rules read it (as on the hosted site) and changed the age setting.");
    expect(sheet.steps![0]!.cause).toBe(`${RULES_CHOSEN_READER} and changed the age setting.`);
    expect(reviseStep({ instruction: "All ages", interpreter: "rules", fallback: "llm_off", calls: [], ledgerRefs: [], rulesChosen: true }).cause).toBe(
      "Fixed rules read it (as on the hosted site) and changed nothing.",
    );
    // The earlier wording, whose aside was never closed, is repaired too; a second pass changes nothing.
    s.steps[0] = { ...s.steps[0]!, cause: "Fixed rules read it, as they do on the hosted site and changed the age setting." };
    const again = recheckSheet(s).sheet;
    expect(again.steps![0]!.cause).toBe("Fixed rules read it (as on the hosted site) and changed the age setting.");
    expect(recheckSheet(again).sheet.steps![0]!.cause).toBe(again.steps![0]!.cause);
  });
});

describe("media picks", () => {
  it("never rules out a brand for a commercial tag (a Wikipedia category), only for a sensitive one", () => {
    const brand = (tags: QlooEntity["tags"]): QlooEntity => ({ entityId: "B", name: "Sample Brand", subtype: "urn:entity:brand", popularity: 0.5, affinity: 0.5, tags, properties: {} });
    expect(deniedEntity(brand([{ id: "urn:tag:wikipedia_category:wikidata:companies_based_in_anaheim", name: "Companies based in Anaheim", type: "urn:tag:wikipedia_category:wikidata" }]))).toBe(false);
    expect(deniedEntity(brand([{ id: "urn:tag:religion:qloo:test", name: "Test", type: "urn:tag:religion:qloo" }]))).toBe(true);
  });
});
