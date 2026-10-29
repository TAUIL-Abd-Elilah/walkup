/**
 * Round 4 of the re-audit, the plan page's helpers:
 *
 * - A partner line in 12-hour time with an upper-case suffix reads as the hours cell above it does ("11:30 AM to
 *   11 PM" reads "11:30 am to 11 pm"); the times themselves never change (text-integrity-partner-lines-uppercase-AM-PM-1e0da01d).
 * - The plan page's lift phrase is the one rule (`liftAgainst`): 2.1534 is "about 2.2 times", as the narrator, the
 *   Steps panel and the calendar say it (text-integrity-lift-about-N-times-rounding-disagrees).
 */
import { describe, expect, it } from "vitest";
import { liftAgainst } from "@walkup/contracts";
import { liftInWords } from "@walkup/engine";
import { templateTileWhy } from "@walkup/narrator";
import { humanTimes, liftPhrase } from "../lib/sheet-utils";

describe("partner lines in 12-hour time (text-integrity-partner-lines-uppercase-AM-PM-1e0da01d)", () => {
  it("lowers an upper-case am or pm and changes nothing else", () => {
    expect(humanTimes("is open Saturday from 11:30 AM to 11 PM.")).toBe("is open Saturday from 11:30 am to 11 pm.");
    expect(humanTimes("and is open Saturday from 3 PM.")).toBe("and is open Saturday from 3 pm.");
    expect(humanTimes("open 7:30 A.M. to 3 P.M.")).toBe("open 7:30 a.m. to 3 p.m.");
    expect(humanTimes("open 9:30PM to 4AM")).toBe("open 9:30pm to 4am");
    for (const s of ["Pub near South Shore, open Thursday 9:30 pm to 4 am.", "open 7:30 a.m. to 3 p.m.", "open Thursday 4:30 to 8 pm", "open 9:30:00 pm to 2 am"])
      expect(humanTimes(s)).toBe(s);
    // Words that start with am or pm, and an AM that is not after a time, keep their case.
    expect(humanTimes("open 5 PM to 2 AM, 2 AMPs on the stage, AM radio")).toBe("open 5 pm to 2 am, 2 AMPs on the stage, AM radio");
    // 24-hour times still read as the hours column writes them.
    expect(humanTimes("open Thursday 17:00 to 02:00")).toBe("open Thursday 5 pm to 2 am");
  });
});

describe("one lift phrase (text-integrity-lift-about-N-times-rounding-disagrees)", () => {
  it("gives the narrator's, the engine's and the plan page's figure from the sheet's 2-decimal lift", () => {
    for (const x of [0.5, 0.949, 1.0, 1.049, 1.1, 1.29, 1.2996, 1.3, 1.6468, 1.84, 2.1534, 2.2491, 2.4477, 3]) {
      expect(liftPhrase(x)).toBe(liftAgainst(x, "the room's usual crowd"));
      expect(liftPhrase(x)).toBe(liftInWords(x, "house"));
      if (x >= 1.3) expect(templateTileWhy({ lift: x, billPct: 0.8, housePct: 0.2 }).startsWith(`About ${liftPhrase(x).slice("about ".length)}.`)).toBe(true);
      expect(liftPhrase(x, "tag", "comedy fans in general")).toBe(liftAgainst(x, "comedy fans in general"));
    }
    expect([2.4477, 2.2491, 2.1534, 1.6468].map((x) => liftPhrase(x))).toEqual([
      "about 2.5 times the room's usual crowd",
      "about 2.3 times the room's usual crowd",
      "about 2.2 times the room's usual crowd",
      "about 1.7 times the room's usual crowd",
    ]);
  });
});
