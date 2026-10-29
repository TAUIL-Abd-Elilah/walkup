/**
 * Third re-audit (Oct 29): the popularity check counts one missed partner as one, on the step and on the card's
 * sentence ("1 of the 12 partners isn't among ...: ... would miss it").
 */
import { describe, expect, it } from "vitest";
import { popularitySentence } from "../src/popularity";
import { popularityStep } from "../src/steps";

const areas = (n: number) => Array.from({ length: n }, (_, i) => ({ tileGeohash: `t${i}`, partners: 4, notInPopularTop: 0, ledgerRef: "Q20" }));

describe("one missed partner of several", () => {
  it("the step says 'it isn't among'", () => {
    const s = popularityStep({ partners: 12, notInPopularTop: 1, areas: 3, failed: [], ledgerRefs: ["Q20"] });
    expect(s.decision).toBe("Popularity alone would miss 1 of the 12 partners: it isn't among the most popular places in their areas.");
    const two = popularityStep({ partners: 12, notInPopularTop: 2, areas: 3, failed: [], ledgerRefs: ["Q20"] });
    expect(two.decision).toBe("Popularity alone would miss 2 of the 12 partners: they aren't among the most popular places in their areas.");
  });

  it("the card's sentence says 'isn't among' and 'miss it'", () => {
    expect(popularitySentence({ partners: 12, notInPopularTop: 1, perArea: areas(3) })).toBe(
      "1 of the 12 partners isn't among the most popular places in their areas: a list by popularity alone would miss it.",
    );
    expect(popularitySentence({ partners: 12, notInPopularTop: 2, perArea: areas(3) })).toBe(
      "2 of the 12 partners aren't among the most popular places in their areas: a list by popularity alone would miss them.",
    );
  });
});
