/**
 * The landing page's worked example ("Same room, two crowds"), the map colour scale and the recorded-mode copy.
 * The comparison is read from the preset sheets, so these tests check how the sentence
 * follows the sheets, never fixed numbers: regenerating fixtures never fights them.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { headlinerName } from "../lib/format";
import { LIFT_LEGEND, TOP_LIFT, liftAlpha, liftBand, liftColor } from "../lib/lift";
import { liftInWords } from "@walkup/engine";
import { dataSourcesLine } from "../lib/labels";
import { compareBills, comparisonSentence, compassDirection, distanceKm, formatKm, liftPhrase, normalizeName, recordedSheetsIntro, topTiles } from "../lib/sheet-utils";
import { OPENFREEMAP_STYLE } from "../lib/webgl";

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const sheet = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;

describe("compareBills on the paired preset sheets", () => {
  const a = sheet("g1-a");
  const b = sheet(a.pairedPlanId ?? "g1-b");
  const c = compareBills(a, b);

  it("reads every count from the sheets", () => {
    const topA = new Set(topTiles(a).map((t) => t.geohash));
    const shared = topTiles(b).filter((t) => topA.has(t.geohash)).length;
    const namesA = new Set(a.cards.partners.results.map((p) => normalizeName(p.entity.name)));
    expect(c.sameRoom).toBe(a.bill.venue.name === b.bill.venue.name);
    expect(c.topN).toBe(Math.min(topTiles(a).length, topTiles(b).length));
    expect(c.sharedTop).toBe(shared);
    expect(c.partnersA).toBe(a.cards.partners.results.length);
    expect(c.partnersB).toBe(b.cards.partners.results.length);
    expect(c.sharedPartners).toBe(b.cards.partners.results.filter((p) => namesA.has(normalizeName(p.entity.name))).length);
    expect(c.a?.geohash).toBe(topTiles(a, 1)[0]?.geohash);
    expect(c.b?.geohash).toBe(topTiles(b, 1)[0]?.geohash);
  });

  it("states it in one sentence with the sheets' own names and numbers", () => {
    const s = comparisonSentence(c, { a: headlinerName(a.bill), b: headlinerName(b.bill), venue: a.bill.venue.name });
    expect(s.endsWith(".")).toBe(true);
    expect(s).toContain(headlinerName(a.bill));
    expect(s).toContain(headlinerName(b.bill));
    expect(s).toContain(a.bill.venue.name);
    if (c.a && c.b) {
      expect(s).toContain(c.a.name);
      expect(s).toContain(c.b.name);
      expect(s).toContain(liftPhrase(c.a.lift, c.a.baseline));
      expect(s).toContain(`about ${(Math.round(c.b.lift * 10) / 10).toFixed(1)} times`);
      // Ratios like "1.84x" stay in tables, never in this sentence.
      expect(s).not.toMatch(/\d\.\d+x/);
    }
    expect(s).not.toMatch(/\bAI\b|powered|insight|!/);
  });
});

describe("recorded mode copy (Qloo unavailable)", () => {
  it("says on the landing page that new plans are off and the sheets are recordings, and names any sample among them", () => {
    expect(recordedSheetsIntro([{ mode: "live" }, { mode: "live" }])).toBe(
      "Qloo is no longer available, so new plans are off. These sheets were recorded from live runs on the dates shown.",
    );
    expect(recordedSheetsIntro([{ mode: "live" }, { mode: "fixture" }])).toMatch(/ A sheet marked sample uses made-up places and numbers\.$/);
  });

  it("credits the data in the footer without claiming sample data or a live call", () => {
    const recorded = dataSourcesLine("recorded");
    expect(recorded).toMatch(/^Affinity data from Qloo, .* as recorded on live runs; none of those services is called now\.$/);
    expect(recorded).not.toMatch(/\bsample\b|made-up/i);
    expect(dataSourcesLine("fixture")).toMatch(/^Sample data /);
    expect(dataSourcesLine("live")).not.toMatch(/recorded|sample/i);
    for (const m of ["live", "fixture", "recorded"] as const) expect(dataSourcesLine(m)).not.toMatch(/!|\bAI\b|powered/);
  });
});

describe("comparisonSentence wording", () => {
  const base = { sameRoom: true, topN: 5, sharedTop: 0, partnersA: 24, partnersB: 24, sharedPartners: 0 } as const;
  const area = { name: "Elm Park", geohash: "dn6q7t", lift: 1.5, km: 6.24, direction: "north" as const };
  const names = { a: "Act A", b: "Act B", venue: "The Room" };

  it("says none when nothing is shared, and counts otherwise", () => {
    expect(comparisonSentence({ ...base, a: null, b: null }, names)).toBe(
      "The two bills share none of their top 5 areas and none of their 24 suggested partners.",
    );
    expect(comparisonSentence({ ...base, sharedTop: 2, sharedPartners: 3, a: null, b: null }, names)).toBe(
      "The two bills share 2 of their top 5 areas and 3 of their 24 suggested partners.",
    );
  });

  it("names both partner counts when they differ", () => {
    expect(comparisonSentence({ ...base, partnersB: 20, sharedPartners: 1, a: null, b: null }, names)).toContain("1 suggested partner (of 24 and 20)");
  });

  it("adds each bill's top area with distance and direction from the venue", () => {
    const s = comparisonSentence({ ...base, a: area, b: { ...area, name: "Oak Hill", lift: 2.474, km: 19.4, direction: "east" } }, names);
    expect(s).toBe(
      "The two bills share none of their top 5 areas and none of their 24 suggested partners: Act A's crowd stands out most in Elm Park, " +
        "6.2 km north of The Room, about 1.5 times the room's usual crowd, and Act B's in Oak Hill, 19 km east, about 2.5 times.",
    );
  });
});

describe("liftPhrase", () => {
  it("matches the engine's fixed lift phrases", () => {
    for (const x of [0.5, 0.97, 1.0, 1.1, 1.29, 1.3, 1.84, 2.474, 3]) {
      expect(liftPhrase(x)).toBe(liftInWords(x, "house"));
      expect(liftPhrase(x, "tag")).toBe(liftInWords(x, "tag"));
    }
  });
});

describe("distance and direction helpers", () => {
  const venue = { lat: 36.16, lon: -86.77 };
  it("gives the eight compass points", () => {
    expect(compassDirection(venue, { lat: 36.3, lon: -86.77 })).toBe("north");
    expect(compassDirection(venue, { lat: 36.16, lon: -86.5 })).toBe("east");
    expect(compassDirection(venue, { lat: 36.0, lon: -86.77 })).toBe("south");
    expect(compassDirection(venue, { lat: 36.16, lon: -87.0 })).toBe("west");
    expect(compassDirection(venue, { lat: 36.26, lon: -86.646 })).toBe("northeast");
  });
  it("measures great-circle km and formats it", () => {
    expect(distanceKm(venue, { lat: 37.16, lon: -86.77 })).toBeCloseTo(111.2, 0);
    expect(formatKm(6.24)).toBe("6.2 km");
    expect(formatKm(19.4)).toBe("19 km");
  });
});

describe("lift colour scale", () => {
  it("is one hue whose opacity rises with lift", () => {
    expect(liftBand(TOP_LIFT)).toBe("top");
    const lifts = [0.5, 1.1, 1.3, 1.6, 2.2, 3];
    const alphas = lifts.map(liftAlpha);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]!).toBeGreaterThanOrEqual(alphas[i - 1]!);
    expect(alphas[0]!).toBeGreaterThan(0);
    expect(alphas.at(-1)!).toBeLessThanOrEqual(1);
  });
  it("blends the accent over white for solid swatches", () => {
    expect(liftColor(3)).toBe("#b42318");
    expect(LIFT_LEGEND.map((l) => liftColor(l.sample))).toEqual([...new Set(LIFT_LEGEND.map((l) => liftColor(l.sample)))]);
  });
  it("draws on OpenFreeMap's light positron style", () => {
    expect(OPENFREEMAP_STYLE).toBe("https://tiles.openfreemap.org/styles/positron");
  });
});
