/**
 * Round 3's hand-offs between groups (Oct 29), each a wording a future run or a view could get wrong:
 *
 * - The narrator's template writes a proper adjective in a tag name with its capital ("leans toward Mexican"), from
 *   the same list the plan page's "Tags it shares" uses, and "Middle Eastern" whole.
 * - A genre with two capitals keeps its case in "R&B fans in general", in the run's steps, on the plan page and in
 *   the PDF alike.
 * - The partners card's popularity line says "1 of the 12 partners isn't among ..." for one.
 * - The landing's comparison drops a repeated baseline only from "about 2.5 times", never from "a little above".
 */
import { describe, expect, it } from "vitest";
import { tagInProse } from "@walkup/narrator";
import { tagNamesInSentenceCase } from "../../../packages/narrator/src/narrate";
import { genreBaselinePhrase } from "@walkup/orchestrator";
import { genreFans } from "@walkup/exports/sheet-model";
import type { StreetSheet } from "@walkup/contracts";
import { baselineName, comparisonSentence, popularityLine, tagInSentence, type BillComparison } from "../lib/sheet-utils";

describe("tag names inside a sentence", () => {
  it("the narrator's template keeps proper adjectives and acronyms, and lower-cases the rest", () => {
    expect(tagInProse("Mexican")).toBe("Mexican");
    expect(tagInProse("Casual Dining")).toBe("casual dining");
    expect(tagInProse("Middle eastern")).toBe("Middle Eastern");
    expect(tagInProse("Afro-cuban Jazz")).toBe("Afro-Cuban jazz");
    expect(tagInProse("R&B")).toBe("R&B");
    expect(tagInProse("Comedy fans")).toBe("comedy");
  });

  it("the narrator's guard writes Middle Eastern whole", () => {
    expect(tagNamesInSentenceCase("Cafe near Adams Morgan, shares Middle Eastern and cozy tags.", ["Middle eastern", "Cozy"])).toBe(
      "Cafe near Adams Morgan, shares Middle Eastern and cozy tags.",
    );
    expect(tagNamesInSentenceCase("A night of greek and Lebanese food.", ["Greek", "Lebanese"])).toBe("A night of Greek and Lebanese food.");
  });

  it("the plan page and the narrator agree on every word's case", () => {
    const words = [
      "Mexican", "Italian", "Greek", "Lebanese", "Mediterranean", "Persian", "Middle eastern", "Irish pub", "American history",
      "Casual dining", "Traditional", "Cozy", "R&B", "Hip-Hop", "Latin", "Southern rock", "Afro-cuban",
    ];
    for (const w of words) expect(tagInSentence(w), w).toBe(tagInProse(w));
  });
});

describe("a genre with two capitals keeps its case", () => {
  const sheet = (classification: string) =>
    ({ bill: { classification }, cards: { liftMap: { results: { diagnostics: { baseline: "tag" } } } } }) as unknown as StreetSheet;

  it("R&B, in the steps, on the plan page and in the PDF", () => {
    for (const c of ["Music / R&B", "Music / Soul (R&B)"]) {
      expect(genreBaselinePhrase(c)).toBe("R&B fans in general");
      expect(baselineName(sheet(c))).toBe("R&B fans in general");
      expect(genreFans(c)).toBe("R&B fans in general");
    }
  });

  it("one capital still reads lower case", () => {
    for (const c of ["Comedy", "Music / Country (Americana)"]) {
      const want = c === "Comedy" ? "comedy fans in general" : "americana fans in general";
      expect(genreBaselinePhrase(c)).toBe(want);
      expect(baselineName(sheet(c))).toBe(want);
      expect(genreFans(c)).toBe(want);
    }
  });
});

describe("the popularity line counts one", () => {
  it("1 of the 12 partners isn't among ...", () => {
    const perArea = [{ tileGeohash: "dn6m9a" }, { tileGeohash: "dn6m9b" }] as never;
    expect(popularityLine({ partners: 12, notInPopularTop: 1, perArea })).toBe(
      "1 of the 12 partners isn't among the most popular places in their areas, so a popularity list would miss it.",
    );
    expect(popularityLine({ partners: 12, notInPopularTop: 2, perArea })).toBe(
      "2 of the 12 partners aren't among the most popular places in their areas, so a popularity list would miss them.",
    );
  });
});

describe("the landing's comparison", () => {
  const area = { name: "Riverbend", geohash: "dn6q7t", lift: 2.474, km: 6.2, direction: "north", baseline: "house" as const };
  const base = { sameRoom: true, topN: 5, sharedTop: 0, partnersA: 24, partnersB: 24, sharedPartners: 2 } as unknown as BillComparison;
  const names = { a: "Act A", b: "Act B", venue: "The Truth" };

  it("drops the repeated baseline from 'about N times' only", () => {
    expect(comparisonSentence({ ...base, a: area, b: { ...area, name: "Oak Hill" } } as BillComparison, names)).toMatch(/Oak Hill, 6\.2 km north, about 2\.5 times\.$/);
    expect(comparisonSentence({ ...base, a: area, b: { ...area, name: "Oak Hill", lift: 1.1 } } as BillComparison, names)).toMatch(
      /Oak Hill, 6\.2 km north, a little above the room's usual crowd\.$/,
    );
  });
});
