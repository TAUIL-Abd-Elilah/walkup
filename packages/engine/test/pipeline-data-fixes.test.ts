/**
 * Re-audit fixes (Oct 29): dead partner sites on a checked list, a place's own domain that shortens its name, chain
 * lists whose "and N more" counts places, and the Summary and Checks steps saying when fixed wording replaced Claude's
 * lines. Names and domains are synthetic (.example), except the dead hosts, which are the list itself.
 */
import { describe, expect, it } from "vitest";
import { chainsCause, chainTailInPlaces, cleanWebsite, DEAD_SITES, guardStep, hostMatchesName, isDeadSite, narrateStep, replacedLines, summaryReplaced } from "../src/index";

describe("dead partner sites", () => {
  it("drops a link to a host on the checked list, with or without www or a path", () => {
    expect(cleanWebsite("http://www.tortugadc.com/", "Tortuga Caribbean Bar & Grille")).toBeNull();
    expect(cleanWebsite("http://sweetlobby.com/", "The Sweet Lobby")).toBeNull();
    expect(cleanWebsite("https://mcgeesjukeboxlounge.com/menu", "McGee's Juke Box Lounge")).toBeNull();
    expect(isDeadSite("order.sweetlobby.com")).toBe(true);
  });
  it("leaves other hosts alone, including one the dead site redirects to", () => {
    expect(isDeadSite("thesweetlobby.com")).toBe(false);
    expect(isDeadSite("nottortugadc.com")).toBe(false);
    expect(cleanWebsite("https://sweetlobbybakes.example/", "Sweet Lobby Bakes")).toBe("https://sweetlobbybakes.example/");
  });
  it("drops one dead page on a host and keeps the host's other pages", () => {
    const page = "https://www.buffalowildwings.com/locations/us/il/chicago/2650-north-narragansett-avenue-c9/sports-bar-1422";
    expect(cleanWebsite(page, "Buffalo Wild Wings")).toBeNull();
    expect(cleanWebsite(`${page}/`, "Buffalo Wild Wings")).toBeNull();
    expect(isDeadSite("buffalowildwings.com")).toBe(false);
    const other = "https://www.buffalowildwings.com/locations/us/il/chicago/1450-north-example-avenue/sports-bar-9999";
    expect(cleanWebsite(other, "Buffalo Wild Wings")).toBe(other);
    expect(cleanWebsite("https://www.buffalowildwings.com/", "Buffalo Wild Wings")).toBe("https://www.buffalowildwings.com/");
  });
  it("dates every entry and says what was found", () => {
    for (const d of DEAD_SITES) {
      expect(d.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(d.found.length).toBeGreaterThan(0);
      expect(d.host).not.toMatch(/^www\./);
      if (d.path !== undefined) expect(d.path).toMatch(/^\/.*[^/]$/);
    }
  });
});

describe("a place's own domain that shortens its name", () => {
  it("keeps a site spelled from the start of every word, in order", () => {
    expect(cleanWebsite("http://haroaktavern.example/", "Harbor Oak Tavern")).toBe("http://haroaktavern.example/");
    // A possessive word cut before its "s": "marco" + "pizza" for "Marco's Pizza".
    expect(cleanWebsite("https://marcopizza.example/", "Marco's Pizza")).toBe("https://marcopizza.example/");
    // Initials then a whole word, "and" left out: q + t + w + bbq.
    expect(cleanWebsite("https://www.qtwbbq.example/", "QS TIPS AND WINGS BBQ")).toBe("https://www.qtwbbq.example/");
    expect(hostMatchesName("rlgdc.example", "Red Lounge Grill DC")).toBe(true);
  });
  it("keeps a site that starts with the short form the name gives in brackets", () => {
    expect(cleanWebsite("https://blkchicago.example/", "Blue Lantern Kitchen (BLK)")).toBe("https://blkchicago.example/");
  });
  it("still drops a site that skips a word, changes the order, adds letters or lives on someone else's server", () => {
    // "ale" left out.
    expect(hostMatchesName("haroavern.example", "Harbor Oak Tavern")).toBe(false);
    expect(hostMatchesName("oakhartavern.example", "Harbor Oak Tavern")).toBe(false);
    // Letters the name doesn't have ("dc").
    expect(hostMatchesName("rlbgdc.example", "Red Lounge Bar Grill")).toBe(false);
    // The short form, but not at the start of the site's name.
    expect(hostMatchesName("chicagoblk.example", "Blue Lantern Kitchen (BLK)")).toBe(false);
    // A bracketed word that is not the initials of the words before it is not the place's short form.
    expect(cleanWebsite("https://www.nycgo.com/restaurants/joes-pizza", "Joe's Pizza (NYC)")).toBeNull();
    expect(hostMatchesName("bbqjoints.example", "Smoke Shack (BBQ)")).toBe(false);
    expect(cleanWebsite("https://bbqguys.example/", "Drifters Tennessee Barbeque (BBQ) Joint")).toBeNull();
    // A client page on an agency's server: only the site's own name counts, not a sub-domain.
    expect(cleanWebsite("http://haroaktavern.pixelagency.example/", "Harbor Oak Tavern")).toBeNull();
    // A league's or a hotel chain's page for a bar inside it.
    expect(cleanWebsite("https://www.bigleague.example/sox/ballpark/sox-corner-bar", "Sox Corner Bar & Grill")).toBeNull();
    expect(cleanWebsite("https://www.hotelchain.example/dining/rooftop", "KT Rooftop")).toBeNull();
    expect(cleanWebsite("https://kingstonhouseboston.example/", "KT Rooftop")).toBeNull();
    // Too short to say anything, or a one-word name.
    expect(hostMatchesName("hot.example", "Harbor Oak Tavern")).toBe(false);
    expect(hostMatchesName("vlvtnbar.example", "Velvetine")).toBe(false);
  });
});

describe("chain lists count places", () => {
  it("'and N more' counts the places left after the names shown, so the numbers add up", () => {
    const off = ["A", "A", "B", "C", "D", "E", "E", "F"];
    expect(chainsCause(0, off, "places")).toBe("Left off 8 national chains: A (2), B, C, D and 3 more");
    expect(chainsCause(0, ["A", "B", "C", "D", "E", "F"], "places")).toBe("Left off 6 national chains: A, B, C, D and 2 more");
  });
  it("recounts a stored line whose tail counted brands, and leaves a right one as it is", () => {
    const old = "Qloo ranked them. Left off 14 national chains: Starbucks Coffee Company (2), Walker Bros. Original Pancake House, Rosati's Pizza, Buona and 7 more. That's short.";
    const fixed = chainTailInPlaces(old);
    expect(fixed).toBe("Qloo ranked them. Left off 14 national chains: Starbucks Coffee Company (2), Walker Bros. Original Pancake House, Rosati's Pizza, Buona and 9 more. That's short.");
    expect(chainTailInPlaces(fixed)).toBe(fixed);
    const capped = "Listed 2 national chains last, after the local places: no local place filled their slot; left off 40 national chains, at most 2 per list: Negril - DC, Smoothie King (2), Burger King, Nando's PERi-PERi and 28 more.";
    expect(chainTailInPlaces(capped)).toMatch(/Nando's PERi-PERi and 35 more\.$/);
  });
  it("touches no other text", () => {
    for (const t of ["Left off 3 national chains: A, B and C.", "Left off 1 more as a second spot of a brand already listed.", "Bars stay off fan copy: A, B, C, D and 2 more."]) {
      expect(chainTailInPlaces(t)).toBe(t);
    }
  });
});

describe("Summary and Checks steps say what fixed wording replaced", () => {
  const summaryOut = 'replaced by the template: summary: superlative "highest" not backed by the sheet';
  const lineOut = 'replaced by the template: partnerLines[4]: "house" instead of the room\'s usual crowd';
  it("Checks: nothing dropped but lines replaced is not 'nothing had to go'", () => {
    expect(guardStep({ dropped: 0, denied: 0, alcoholHeld: 0, reasons: [summaryOut, lineOut], ledgerRefs: [] }).decision).toBe(
      "Checked every line against this run's requests; none was dropped, and fixed wording replaced Claude's summary and 1 of its area and partner lines.",
    );
    expect(guardStep({ dropped: 0, denied: 0, alcoholHeld: 0, reasons: [lineOut, 'replaced by the template: tileWhy[1]: says six partners'], ledgerRefs: [] }).decision).toBe(
      "Checked every line against this run's requests; none was dropped, and fixed wording replaced 2 of Claude's area and partner lines.",
    );
    expect(guardStep({ dropped: 0, denied: 0, alcoholHeld: 0, reasons: [], ledgerRefs: [] }).decision).toBe("Checked every line against this run's requests; nothing had to go.");
  });
  it("Checks: dropped lines and replaced ones are both said", () => {
    expect(guardStep({ dropped: 1, denied: 0, alcoholHeld: 0, reasons: ["partnerLines[7]: not a partner", summaryOut], ledgerRefs: [] }).decision).toBe(
      "Dropped 1 line about a place that isn't a partner on this sheet; fixed wording replaced Claude's summary.",
    );
    expect(replacedLines(["partnerLines[7]: not a partner"])).toBeNull();
  });
  it("Summary: a replaced summary is called Claude's draft", () => {
    expect(summaryReplaced([summaryOut])).toBe(true);
    // A summary the guard dropped is replaced by the template's too.
    expect(summaryReplaced(["summary: number 1.8 is not in this run"])).toBe(true);
    expect(summaryReplaced([lineOut])).toBe(false);
    expect(narrateStep({ templated: false, hooks: 3, hooksStatus: "ok", summaryReplaced: true, ledgerRefs: [] }).decision).toBe(
      "Claude wrote a draft summary and 3 fan copy lines from this run's results; fixed wording replaced the summary (see Checks).",
    );
    expect(narrateStep({ templated: false, hooks: 3, hooksStatus: "ok", ledgerRefs: [] }).decision).toBe("Claude wrote the summary and 3 fan copy lines from this run's results.");
    expect(narrateStep({ templated: true, hooks: 3, hooksStatus: "ok", summaryReplaced: true, ledgerRefs: [] }).decision).toBe(
      "Wrote the summary and 3 fan copy lines from a fixed template; no model was called.",
    );
  });
});
