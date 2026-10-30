/**
 * Round 7, integrator: a sample place's ".example" website never resolves, so the paper keeps its domain as text and
 * links only a real website. Synthetic data.
 */
import { describe, expect, it } from "vitest";
import { buildSheetModel } from "../src/index";
import { makeSheet } from "./helpers";

describe("partner website links on paper", () => {
  it("drop the link for a reserved host and keep a real one", () => {
    const s = makeSheet();
    const [a, b] = s.cards.partners.results;
    a!.website = "https://yoder-s-cafe.example/";
    b!.website = "https://www.example.org/";
    const rows = buildSheetModel(s).panel2.rows;
    const ra = rows.find((r) => r.name === a!.entity.name)!;
    const rb = rows.find((r) => r.name === b!.entity.name)!;
    expect(ra.webUrl).toBeNull();
    expect(ra.web).toContain("yoder-s-cafe.example");
    expect(rb.webUrl).toBe("https://www.example.org/");
  });
});
