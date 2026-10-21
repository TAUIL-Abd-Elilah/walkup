/**
 * The text block beside structuredContent: a live sheet is never read as a what-if, whatever an older stored
 * sheet's `hypothetical` flag says. Synthetic fixture sheet only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { envelopeText } from "../src/text";
import type { ToolEnvelope } from "../src/envelope";

const sheet = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/synthetic/engine/g1-a.sheet.json", import.meta.url)), "utf8")).sheet as StreetSheet;

function env(s: StreetSheet, mode: ToolEnvelope["mode"]): ToolEnvelope {
  return { status: "ok", summary: "Done.", planId: s.planId, sheetUrl: null, mode, results: s, resolution: [], provenance: [], limits: [] } as ToolEnvelope;
}

describe("envelopeText what-if line", () => {
  it("says the counts are what-ifs on a sample sheet", () => {
    const s = { ...structuredClone(sheet), mode: "fixture" as const, hypothetical: true };
    expect(envelopeText("get_sheet", env(s, "fixture"))).toMatch(/what-ifs \(HYPOTHETICAL\)/);
  });

  it("never says so on a live sheet, even one stored with hypothetical: true", () => {
    const s = { ...structuredClone(sheet), mode: "live" as const, hypothetical: true };
    expect(envelopeText("get_sheet", env(s, "recorded"))).not.toMatch(/what-if|HYPOTHETICAL/i);
  });
});
