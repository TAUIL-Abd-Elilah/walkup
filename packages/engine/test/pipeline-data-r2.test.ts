/**
 * Second re-audit (Oct 29): a place's own site whose host splits a possessive with a hyphen, what a sheet says when
 * the record's link is not shown, partner chains said last in their own area, and the Checks step counting a summary
 * the guard dropped as replaced (the template's summary took its place). Names and domains are synthetic (.example),
 * except the dead host, which is on the checked list.
 */
import { describe, expect, it } from "vitest";
import {
  chainsCause,
  chainSummary,
  cleanWebsite,
  guardDropCounts,
  guardStep,
  hostMatchesName,
  partnersStep,
  replacedLines,
  WEBSITE_NOT_SHOWN_DEAD,
  WEBSITE_NOT_SHOWN_NOT_OWN,
  websiteNotShown,
  type PartnersStepInput,
} from "../src/index";

describe("a hyphen-split possessive in the host", () => {
  it("keeps the place's own site", () => {
    expect(cleanWebsite("https://hagan-s-tavern-willard-st.example", "Hagan's Tavern")).toBe("https://hagan-s-tavern-willard-st.example");
    expect(hostMatchesName("rinaldi-s-bar.example", "Rinaldi's Bar")).toBe(true);
    expect(hostMatchesName("yoder-s-cafe-main.example", "Yoder's Cafe")).toBe(true);
    // As before: the form without the hyphens.
    expect(cleanWebsite("https://hagans-tavern.example", "Hagan's Tavern")).toBe("https://hagans-tavern.example");
  });
  it("still drops a site that isn't the place's own", () => {
    expect(hostMatchesName("hagan-s-tavern.pixelagency.example", "Harbor Oak Tavern")).toBe(false);
    expect(cleanWebsite("http://haroaktavern.pixel-agency.example/", "Harbor Oak Tavern")).toBeNull();
    expect(cleanWebsite("https://www.hotel-chain.example/dining/rooftop", "KT Rooftop")).toBeNull();
    expect(cleanWebsite("https://kingston-house-boston.example/", "KT Rooftop")).toBeNull();
    expect(hostMatchesName("har-oak-avern.example", "Harbor Oak Tavern")).toBe(false);
    expect(hostMatchesName("vlvt-n-bar.example", "Velvetine")).toBe(false);
  });
});

describe("a record's link the sheet doesn't show", () => {
  it("says why, not 'not listed'", () => {
    expect(websiteNotShown("https://kingstonhouseboston.example/rooftop/?SEO_id=GMB", "KT Rooftop")).toBe(WEBSITE_NOT_SHOWN_NOT_OWN);
    expect(WEBSITE_NOT_SHOWN_NOT_OWN).toBe("Website not shown: the listed link doesn't match the place's name");
    expect(websiteNotShown("http://www.tortugadc.com/", "Tortuga Caribbean Bar & Grille")).toBe(WEBSITE_NOT_SHOWN_DEAD);
    expect(WEBSITE_NOT_SHOWN_DEAD).toBe("Website not shown: the listed link doesn't work");
  });
  it("says nothing when there is no web link or the rule keeps it", () => {
    expect(websiteNotShown(null, "Hagan's Tavern")).toBeNull();
    expect(websiteNotShown("  ", "Hagan's Tavern")).toBeNull();
    expect(websiteNotShown("mailto:hello@hagans.example", "Hagan's Tavern")).toBeNull();
    expect(websiteNotShown("https://hagan-s-tavern-willard-st.example", "Hagan's Tavern")).toBeNull();
  });
});

describe("partner chains are last in their own area", () => {
  it("card: in their area for a list grouped by area; spots keep 'listed last'", () => {
    expect(chainSummary({ kept: 2, listed: 11, leftOut: 0, capped: 0, cap: 2 }, ["partner", "partners"], true)).toBe(
      "2 of 11 partners are national chains, listed last in their area: no local place filled their slot.",
    );
    expect(chainSummary({ kept: 1, listed: 19, leftOut: 3, capped: 0, cap: 2 }, ["partner", "partners"], true)).toBe(
      "1 of 19 partners is a national chain, listed last in its area: no local place filled its slot. 3 more chains left off for local places.",
    );
    expect(chainSummary({ kept: 1, listed: 8, leftOut: 0, capped: 0, cap: 2 }, ["spot", "spots"])).toBe("1 of 8 spots is a national chain, listed last: no local place filled its slot.");
  });
  it("step: in their area when the partners are in areas, after the local places near the venue", () => {
    expect(chainsCause(2, [], "places", 2, 0, true)).toBe("Listed 2 national chains last in their area: no local place filled their slot");
    expect(chainsCause(1, ["A"], "places", 2, 0, true)).toBe("Listed 1 national chain last in its area: no local place filled its slot; left off 1 national chain: A");
    expect(chainsCause(1, [], "spots")).toBe("Listed 1 national chain last, after the local spots: no local spot filled its slot");
    const base: PartnersStepInput = {
      status: "ok",
      kept: 11,
      inAreas: 11,
      areas: 3,
      nearVenue: 0,
      areasWanted: 3,
      areasUsed: 3,
      day: "thursday",
      hoursUnknown: 0,
      droppedClosed: 0,
      droppedCategory: 0,
      widenedRadius: 0,
      widenedRadiusM: 3500,
      widenedCategories: 0,
      belowMinimum: false,
      minTotal: 15,
      skippedCategories: 0,
      chainsKept: 2,
      chainsOffList: [],
      chainsCap: 2,
      chainsCapped: 0,
      ledgerRefs: [],
    };
    expect(partnersStep(base).cause).toContain("Listed 2 national chains last in their area: no local place filled their slot");
    expect(partnersStep({ ...base, inAreas: 0, areas: 0, nearVenue: 11 }).cause).toContain("Listed 2 national chains last, after the local places: no local place filled their slot");
  });
});

describe("Checks step: a summary the guard dropped is replaced, not left out", () => {
  const reasons = [
    "58 tags denied by policy (ethnicity/inclusivity)",
    "summary: number 1.8 is not in this run",
    'partnerLines[6]: alcohol word "Cocktail" on a show that is not 21+',
    'replaced by the template: tileWhy[0]: superlative "the most" not backed by the sheet',
    "replaced by the template: tileWhy[1]: says three partners, the sheet has 4 in this area",
  ];
  it("counts the one line left out and says the summary was replaced", () => {
    expect(guardStep({ dropped: 2, denied: 58, alcoholHeld: 0, reasons, ledgerRefs: [] }).decision).toBe(
      "Dropped 1 line with an alcohol word on a show that isn't 21+; fixed wording replaced Claude's summary and 2 of its area and partner lines.",
    );
    expect(replacedLines(["summary: number 1.8 is not in this run"])).toBe("fixed wording replaced Claude's summary");
  });
  it("says none was dropped when the summary was the only one", () => {
    expect(guardStep({ dropped: 1, denied: 0, alcoholHeld: 0, reasons: ["summary: number 1.8 is not in this run"], ledgerRefs: [] }).decision).toBe(
      "Checked every line against this run's requests; none was dropped, and fixed wording replaced Claude's summary.",
    );
  });
  it("reads a partner-line count in either form", () => {
    expect(guardDropCounts(["2 partner lines dropped: cited entity not traced to this run's ledger."]).citation).toBe(2);
    expect(guardDropCounts(["1 partner line dropped: cited entity not traced to this run's ledger."]).citation).toBe(1);
    expect(guardDropCounts(["2 partner line(s) dropped: cited entity not traced to this run's ledger."]).citation).toBe(2);
    expect(guardDropCounts(["15 partner lines trimmed: a tag the place doesn't list as shared was cut."])).toEqual({ citation: 0, unbacked: 0, notPartner: 0, alcohol: 0, other: 0 });
  });
});
