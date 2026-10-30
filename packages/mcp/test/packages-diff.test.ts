/**
 * Round 5: bill_vs_house gives "How this crowd differs" as the plan page shows it: no audience or identity tags, no
 * repeats, and a summary counted from those lists. Synthetic fixture sheet; the tags added below are synthetic.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CompareTag, StreetSheet } from "@walkup/contracts";
import { diffSummary, vetWhatsDifferent } from "@walkup/narrator/vet";
import { billVsHouseOf, envelopeText, type ToolEnvelope } from "../src/index";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/synthetic/engine/g1-b.sheet.json", import.meta.url)), "utf8")).sheet as StreetSheet;

const SUPPORTIVE: CompareTag = { id: "urn:tag:audience:qloo:test_supportive", name: "Supportive" } as CompareTag;
const HARMONIOUS: CompareTag = { id: "urn:tag:theme:qloo:test_harmonious", name: "Harmonious" } as CompareTag;
const SOULFUL: CompareTag = { id: "urn:tag:theme:qloo:test_soulful", name: "Soulful" } as CompareTag;

function sheetWithAudienceTag(): StreetSheet {
  const s = structuredClone(fixture);
  const wd = s.cards.whatsDifferent;
  // As on the recorded FLO sheet: an audience tag second in the bill's list, a repeat, and a summary counted before
  // the lists were checked.
  wd.results = { ...wd.results, a: [HARMONIOUS, SUPPORTIVE, SOULFUL, { ...HARMONIOUS }, ...wd.results.a], shared: [SOULFUL, ...wd.results.shared] };
  wd.summary = `${wd.results.a.length} tags rank higher for this bill, ${wd.results.b.length} for the room's usual crowd, and ${wd.results.shared.length} rank high for both.`;
  return s;
}

describe("bill_vs_house: How this crowd differs", () => {
  it("lists no audience tag or repeat, and counts its summary as the plan page does", () => {
    const s = sheetWithAudienceTag();
    const r = billVsHouseOf(s);
    expect(r.whatsDifferent.a.map((t) => t.id)).not.toContain(SUPPORTIVE.id);
    expect(r.whatsDifferent.a.filter((t) => t.id === HARMONIOUS.id)).toHaveLength(1);
    const stored = s.cards.whatsDifferent.results;
    const page = { ...stored, a: vetWhatsDifferent(stored.a), b: vetWhatsDifferent(stored.b), shared: vetWhatsDifferent(stored.shared) };
    expect(r.whatsDifferent).toEqual(page);
    expect(r.cards.whatsDifferent.summary).toBe(diffSummary(s.cards.whatsDifferent.summary, page));
    expect(r.cards.whatsDifferent.summary).not.toBe(s.cards.whatsDifferent.summary);
  });

  it("the text digest names the page's 'This bill leans toward' tags: no audience tag, none listed under both", () => {
    const r = billVsHouseOf(sheetWithAudienceTag());
    const env = { status: "ok", summary: "Done.", planId: r.planId, sheetUrl: null, mode: "fixture", results: r, resolution: [], provenance: [], limits: [] } as unknown as ToolEnvelope;
    const line = envelopeText("bill_vs_house", env).split("\n").find((l) => l.startsWith("Distinctive to this bill: "));
    expect(line).toBeDefined();
    expect(line).toMatch(/^Distinctive to this bill: Harmonious, /);
    expect(line).not.toMatch(/Supportive|Soulful/);
  });
});
