/**
 * Round 7, orchestrator: "No restaurants" also leaves out a place whose name says restaurant, in a run, in the change
 * list and in the offline recheck (whose counts follow the list); a department-store tag alone is not a clothing
 * store; the fixed-wording summary says its areas are the sheet's top ones; a comedy bill's fan copy uses no music
 * genre. Synthetic data.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Partner, StreetSheet } from "@walkup/contracts";
import { activationFor } from "@walkup/engine";
import { diffSheets, recheckSheet } from "../src/index";
import { deps, runPreset, sheetOf } from "./helpers";

let g1a: StreetSheet;
let g2: StreetSheet;
let g3: StreetSheet;

beforeAll(async () => {
  g1a = sheetOf((await runPreset("g1-a", deps())).final);
  g2 = sheetOf((await runPreset("g2", deps())).final);
  g3 = sheetOf((await runPreset("g3", deps())).final);
});

/** A copy of g1-a with restaurants left out and one partner (not the discovery) renamed "... Restaurant & Bar". */
function noRestaurants(): { sheet: StreetSheet; renamed: Partner } {
  const sheet = structuredClone(g1a);
  sheet.operator = { ...sheet.operator, excludeCategories: ["restaurant"] };
  const i = sheet.cards.partners.results.findIndex((p) => p.tileGeohash && p.entity.entityId !== sheet.discovery?.entityId);
  const p = sheet.cards.partners.results[i]!;
  const renamed: Partner = { ...p, entity: { ...p.entity, name: "La Parra Restaurant & Bar" } };
  sheet.cards.partners.results[i] = renamed;
  return { sheet, renamed };
}

describe('"No restaurants" and a place whose name says restaurant', () => {
  it("the recheck drops it and the counts the sheet states follow the list, once", () => {
    const { sheet: s, renamed } = noRestaurants();
    const n = s.cards.partners.results.length;
    const { sheet, report } = recheckSheet(s);
    expect(report.droppedPartners).toEqual([{ name: "La Parra Restaurant & Bar", why: "a restaurant by its name (your exclusions)" }]);
    expect(sheet.cards.partners.results.map((p) => p.entity.entityId)).not.toContain(renamed.entity.entityId);
    expect(sheet.cards.partners.results).toHaveLength(n - 1);
    expect(sheet.narration?.partnerLines.some((l) => l.entityId === renamed.entity.entityId)).toBe(false);
    expect(sheet.cards.partners.summary).toMatch(new RegExp(`^${n - 1} partners`));
    expect(sheet.cards.partners.summary.endsWith("Left out 1 place that is a restaurant by its name (your exclusions).")).toBe(true);
    expect(sheet.cards.partners.summary).not.toMatch(new RegExp(`\\bof ${n} picks\\b`));
    const step = sheet.steps?.find((x) => x.id === "partners");
    expect(step?.decision).toMatch(new RegExp(`^Kept ${n - 1} places`));
    expect(step?.cause?.endsWith("Left out 1 place that is a restaurant by its name (your exclusions).")).toBe(true);
    if (sheet.popularityCheck) {
      expect(sheet.popularityCheck.partners).toBe(n - 1);
      expect(sheet.steps?.find((x) => x.id === "partners-popular")?.decision).toMatch(new RegExp(`of the ${n - 1} partners|${n - 1} partners are also`));
    }
    if (sheet.narration?.templated) expect(sheet.narration.summary).toMatch(new RegExp(`The sheet suggests ${n - 1} partners of \\d+ kinds?;`));
    // Run again: nothing left to drop, nothing changes.
    const again = recheckSheet(sheet);
    expect(again.report.droppedPartners).toEqual([]);
    expect(again.sheet).toEqual(sheet);
  });

  it("the change list says why a kept place went", () => {
    const { sheet: child, renamed } = noRestaurants();
    const parent = structuredClone(child);
    parent.operator = { ...parent.operator, excludeCategories: [] };
    child.cards.partners.results = child.cards.partners.results.filter((p) => p.entity.entityId !== renamed.entity.entityId);
    const row = diffSheets(parent, child).find((c) => c.kind === "partner_removed" && c.label === "La Parra Restaurant & Bar");
    expect(row?.detail).toMatch(/: left out: a restaurant by its name \(your exclusions\)$/);
  });

  it("leaves a sheet that keeps restaurants as it is", () => {
    const { sheet: s } = noRestaurants();
    s.operator = { ...s.operator, excludeCategories: [] };
    expect(recheckSheet(s).report.droppedPartners).toEqual([]);
  });
});

describe("a department-store tag alone is not a clothing store", () => {
  it("the recheck gives the place the kind its own tags say, with that kind's ask and opener", () => {
    const s = structuredClone(g1a);
    const adultsOnly = s.bill.legalAgeEnforced === true && s.operator.allAges !== true;
    const i = s.cards.partners.results.findIndex((p) => p.explain);
    const p = s.cards.partners.results[i]!;
    const tag = (key: string, name: string) => ({ id: `urn:tag:category:place:${key}`, name, type: "urn:tag:category:place" });
    s.cards.partners.results[i] = {
      ...p,
      category: "clothing_store",
      entity: { ...p.entity, name: "Walmart Neighborhood Market", tags: [tag("discount_supermarket", "Discount supermarket"), tag("grocery_store", "Grocery store"), tag("department_store", "Department store"), tag("bakery", "Bakery"), tag("cake_shop", "Cake shop")] },
      explain: { ...p.explain!, activation: activationFor("clothing_store", { adultsOnly }) },
    };
    s.narration!.partnerLines = s.narration!.partnerLines.map((l) => (l.entityId === p.entity.entityId ? { ...l, text: "Clothing store near Auburn Gresham, open Thursday 07:00 to 22:00." } : l));
    const { sheet, report } = recheckSheet(s);
    const row = sheet.cards.partners.results[i]!;
    expect(row.category).toBe("bakery");
    expect(row.explain?.activation).toBe(activationFor("bakery", { adultsOnly }));
    expect(sheet.narration?.partnerLines.find((l) => l.entityId === p.entity.entityId)?.text).toBe("Bakery near Auburn Gresham, open Thursday 07:00 to 22:00.");
    expect(report.rewritten).toContain("kind: Walmart Neighborhood Market clothing_store -> bakery (a department-store tag alone is not clothes)");
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });
});

describe("the fixed-wording summary counts the sheet's top areas", () => {
  it("a run writes it so, and the recheck rewrites the old wording to match", () => {
    expect(g1a.narration?.templated).toBe(true);
    expect(g1a.narration?.summary).toMatch(/This crowd stands out from the room's usual crowd in the sheet's top \d+ areas; the strongest, .+?, is about /);
    const s = structuredClone(g1a);
    s.narration!.summary = s.narration!.summary.replace("in the sheet's top ", "in ");
    const { sheet, report } = recheckSheet(s);
    expect(sheet.narration?.summary).toBe(g1a.narration?.summary);
    expect(report.rewritten).toContain("summary top areas");
    expect(recheckSheet(g1a).report.rewritten).not.toContain("summary top areas");
  });
});

describe("fan copy on a comedy bill", () => {
  it("uses no music genre when every act is a comedian (G2, G3)", () => {
    for (const s of [g2, g3]) {
      expect(s.bill.acts.every((a) => a.isComedian === true)).toBe(true);
      const hooks = s.cards.copyHooks.results;
      expect(hooks.length).toBeGreaterThan(0);
      for (const h of hooks) for (const id of h.tagIds) expect(id.startsWith("urn:tag:genre:music")).toBe(false);
    }
    expect(g2.cards.copyHooks.results[0]?.text).toBe("Dorian Pike: Stand-up comedy and sitcom at Hampton Coliseum, Saturday, Dec 19.");
  });

  it("keeps music genres on a music bill (G1-A)", () => {
    expect(g1a.cards.copyHooks.results.some((h) => h.tagIds.some((id) => id.startsWith("urn:tag:genre:music")))).toBe(true);
  });
});
