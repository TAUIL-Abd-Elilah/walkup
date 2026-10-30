/**
 * Round 6, MCP: the digests cite the heat request the lift tiles came from (the widened map, as partners.csv and the
 * calendar do), and "Where buyers live" is said of the map the sheet has, as the page says it: an older stored sheet
 * with no lift map gets the reworded line in get_sheet, bill_vs_house and rank_partners alike. Synthetic fixture
 * sheets; the ledger notes and the stored line below are set as older runs wrote them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUYERS_LIMIT, NO_LIFT_BUYERS_LIMIT, type StreetSheet } from "@walkup/contracts";
import { billVsHouseOf, billVsHouseTool, envelopeText, getSheetTool, sheetEnvelope, type ToolEnvelope } from "../src/index";
import { caller, services } from "./helpers";

const fixture = (id: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/synthetic/engine/${id}.sheet.json`, import.meta.url)), "utf8")).sheet as StreetSheet;

/** The g1-a sheet as a run whose bill heatmap widened to 60 km writes it: two heat requests, the second one used. */
function widened(): { sheet: StreetSheet; first: string; used: string } {
  const s = structuredClone(fixture("g1-a"));
  const [first, used] = s.cards.liftMap.provenance as [string, string];
  s.ledger = s.ledger.map((e) =>
    e.id === first ? { ...e, note: "node Q4 bill heat; cache hit" } : e.id === used ? { ...e, note: "node Q4 bill heat (widened to 60 km); cache hit" } : e,
  );
  return { sheet: s, first, used };
}

const areaRefs = (text: string) => [...text.matchAll(/^ {2}\d+\. .+ \(lift \d+\.\d\d\) \[(Q\d+)\]$/gm)].map((m) => m[1]);

describe("area receipts on a map that widened", () => {
  it("cite the widened heat request in get_sheet and bill_vs_house, never the one set aside", () => {
    const { sheet, first, used } = widened();
    const env = (results: unknown): ToolEnvelope =>
      ({ status: "ok", summary: "Done.", planId: sheet.planId, sheetUrl: null, mode: "fixture", results, resolution: [], provenance: [first, used], limits: [] }) as ToolEnvelope;
    const r = billVsHouseOf(sheet);
    expect(r.heatRef).toBe(used);
    for (const text of [envelopeText("get_sheet", sheetEnvelope(sheet, null)), envelopeText("bill_vs_house", env(r))]) {
      const refs = areaRefs(text);
      expect(refs.length).toBeGreaterThan(0);
      expect(new Set(refs)).toEqual(new Set([used]));
    }
  });

  it("cite the first heat request when the map did not widen", () => {
    const s = fixture("g1-a");
    expect(billVsHouseOf(s).heatRef).toBe(s.cards.liftMap.provenance[0]);
    expect(new Set(areaRefs(envelopeText("get_sheet", sheetEnvelope(s, null))))).toEqual(new Set([s.cards.liftMap.provenance[0]]));
  });
});

describe("Where buyers live on a sheet with no lift map", () => {
  // g3 as a run stored it before the run said it of its own map.
  const older = structuredClone(fixture("g3"));
  older.limits = older.limits.map((l) => (l === NO_LIFT_BUYERS_LIMIT ? BUYERS_LIMIT : l));

  it("is said of the map the sheet has in get_sheet and bill_vs_house, structuredContent and text", async () => {
    expect(older.limits).toContain(BUYERS_LIMIT);
    const s = services();
    await s.store.put({ planId: "older-g3", createdAt: older.createdAt, mode: "fixture", status: "complete", request: { planId: "older-g3" }, sheet: { ...older, planId: "older-g3" } });
    for (const tool of [getSheetTool, billVsHouseTool]) {
      const { envelope } = await tool(s, caller(), { planId: "older-g3" });
      expect(envelope.limits).toContain(NO_LIFT_BUYERS_LIMIT);
      expect(envelope.limits).not.toContain(BUYERS_LIMIT);
      const text = envelopeText("get_sheet", envelope);
      expect(text).toContain(`  - ${NO_LIFT_BUYERS_LIMIT}`);
      expect(text).not.toContain("the areas show where this bill's fans stand out");
    }
  });

  it("keeps the stored line on a sheet with a lift map", () => {
    const g1 = fixture("g1-a");
    expect(sheetEnvelope(g1, null).limits).toContain(BUYERS_LIMIT);
  });
});
