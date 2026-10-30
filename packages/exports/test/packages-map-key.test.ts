/**
 * Round 5: the PDF's map key under a map with no lift squares (the g3 sample: no usual crowd to compare with) shows
 * the venue square only, as the plan page leaves its legend out. Synthetic sheets only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { LIFT_KEY } from "../src/format";
import { streetSheetDocument } from "../src/pdf";
import { buildSheetModel } from "../src/sheet-model";
import { makeSheet } from "./helpers";

function textOf(el: unknown): string {
  if (typeof el === "string" || typeof el === "number") return `${el} `;
  if (Array.isArray(el)) return el.map(textOf).join("");
  if (el && typeof el === "object" && "props" in el) return textOf((el as { props: { children?: unknown } }).props.children);
  return "";
}

const g3 = (JSON.parse(readFileSync(new URL("../../../fixtures/synthetic/engine/g3.sheet.json", import.meta.url), "utf8")) as { sheet: StreetSheet }).sheet;

describe("the PDF map key", () => {
  it("prints the four lift steps under a lift map", () => {
    const m = buildSheetModel(makeSheet());
    expect(m.panel1.noLift).toBe(false);
    const text = textOf(streetSheetDocument(makeSheet()));
    for (const k of LIFT_KEY) expect(text).toContain(k.label);
  });

  it("prints only the caption and the venue square when there is no usual crowd to compare with", () => {
    expect(g3.cards.liftMap.results.diagnostics.baseline).toBe("none");
    expect(buildSheetModel(g3).panel1.noLift).toBe(true);
    const text = textOf(streetSheetDocument(g3));
    expect(text).toContain("No usual crowd to compare with");
    expect(text).toContain("venue");
    for (const k of LIFT_KEY) expect(text).not.toContain(k.label);
  });

  it("prints only the venue square when the map has no squares at all", () => {
    const s = makeSheet();
    s.cards.liftMap.results.tiles = [];
    expect(buildSheetModel(s).panel1.noLift).toBe(true);
    for (const k of LIFT_KEY) expect(textOf(streetSheetDocument(s))).not.toContain(k.label);
  });
});
