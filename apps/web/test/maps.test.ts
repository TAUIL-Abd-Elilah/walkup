/**
 * The maps and the area list: the static locator drawing (no grid, venue square, scale, one note), the lift rules
 * under area rows, the legend caption, the landing pair, and the marker look shared by the maps and the `.marker`
 * class in both themes. Fixture-driven checks read the sheets, never fixed numbers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LiftTile, StreetSheet } from "@walkup/contracts";

// The interactive layer loads MapLibre in the browser only; the static render is what is checked here.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { StaticLiftMap, SIMPLIFIED_NOTE, niceKm } = await import("../components/StaticLiftMap");
const { LiftMap, MapCaption, squareSizeLine } = await import("../components/LiftMap");
const { TileList, AREA_ROWS_SHOWN } = await import("../components/TileList");
const { LiftLegend } = await import("../components/LiftLegend");
const { HeroSplit, andList } = await import("../components/HeroSplit");
const { MARKER, MAP_PAD, groupMarkers } = await import("../lib/markers");
const { LIFT_LEGEND, liftRuleShare } = await import("../lib/lift");
const { allTiles, topTiles } = await import("../lib/sheet-utils");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const sheet = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const CSS = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");

const a = sheet("g1-a");
const venueOf = (s: StreetSheet) => ({ lat: s.bill.venue.lat, lon: s.bill.venue.lon, name: s.bill.venue.name });
const tile = (geohash: string, lift: number, name: string): LiftTile => ({ ...topTiles(a)[0]!, geohash, lift, name });

describe("static locator drawing", () => {
  const top = topTiles(a);
  const props = { tiles: allTiles(a), venue: venueOf(a), ranked: top.map((t) => t.geohash), idBase: "t", title: "Areas" };

  it("draws tiles, numbered ink markers, the venue square and label, a scale bar and one note, with no grid", () => {
    const html = renderToStaticMarkup(createElement(StaticLiftMap, { ...props, width: 528, height: 396 }));
    expect(html).toContain('viewBox="0 0 528 396"');
    expect(html).not.toContain("<line x1=\"0\""); // no full-width grid lines
    expect(html).not.toMatch(/#efefef/i);
    expect(html).toContain(SIMPLIFIED_NOTE);
    expect(html).toMatch(/>\d+(\.\d+)? km</);
    expect(html).toContain(`>${a.bill.venue.name}<`);
    expect(html).toContain('width="10" height="10"'); // the venue square
    // One ink circle (or merged pill) per marker group, white numerals.
    const numbers = [...html.matchAll(/font-weight="600" fill="#ffffff">([^<]+)</g)].map((m) => m[1]);
    expect(numbers.join(", ").split(", ").map(Number).sort()).toEqual(top.map((_, i) => i + 1));
    expect(html).toContain(`fill="${MARKER.fill}" stroke="${MARKER.text}"`);
  });

  it("keeps the print sheet's drawing white and without the note", () => {
    const html = renderToStaticMarkup(createElement(StaticLiftMap, { ...props, theme: "paper", width: 420, height: 320 }));
    expect(html).not.toContain(SIMPLIFIED_NOTE);
    expect(html).toContain('fill="#ffffff"');
  });

  it("can hide or change the note", () => {
    expect(renderToStaticMarkup(createElement(StaticLiftMap, { ...props, note: null }))).not.toContain(SIMPLIFIED_NOTE);
    expect(renderToStaticMarkup(createElement(StaticLiftMap, { ...props, note: "Loading" }))).toContain(">Loading<");
  });

  it("picks round scale lengths", () => {
    expect(niceKm(9)).toBe(10);
    expect(niceKm(1.2)).toBe(1);
    expect(niceKm(3.4)).toBe(2);
    expect(niceKm(0.4)).toBe(0.5);
  });

  it("shares its frame padding with the street map, with room for a marker drawn up and to the right", () => {
    expect(MAP_PAD.top).toBeGreaterThan(MAP_PAD.bottom);
    expect(MAP_PAD.right).toBeGreaterThan(MAP_PAD.left);
  });
});

describe("lift map frame", () => {
  it("says the drawing is a stand-in while the street map loads, and credits the basemap", () => {
    const top = topTiles(a);
    const html = renderToStaticMarkup(
      createElement(LiftMap, { tiles: allTiles(a), venue: venueOf(a), ranked: top.map((t) => t.geohash), idBase: "m", title: "Areas" }),
    );
    expect(html).toContain("Simplified drawing while the street map loads.");
    expect(html).toContain("aspect-[4/3]"); // 4:3 on a phone, short enough to scroll past
    expect(html).toContain("OpenStreetMap contributors");
    expect(html).not.toContain("Each square is about"); // the plan page prints its own square line
  });

  it("measures a square from the tiles and names what shading is not", () => {
    expect(squareSizeLine(allTiles(a))).toMatch(/^Each square is about 1\.0 km by 0\.6 km\.$/);
    expect(squareSizeLine([])).toBeNull();
    const html = renderToStaticMarkup(createElement(MapCaption, { tiles: allTiles(a), whose: "each bill's", source: "Data: sample." }));
    expect(html).toContain("not where buyers live");
    expect(html).toContain("Data: sample. Map:");
  });
});

describe("area list", () => {
  const tiles = [tile("dn6jv1", 2, "One"), tile("dn6qn8", 1.5, "Two"), tile("dn6jub", 0.8, "Three")];

  it("draws a 2px rule per row, as wide as its lift over the top lift, grey under 1.0x", () => {
    const html = renderToStaticMarkup(createElement(TileList, { tiles, id: "areas" }));
    expect(html).toContain('id="areas"');
    expect(html).toContain('data-geohash="dn6qn8"');
    expect(html).toContain("width:100%");
    expect(html).toContain("width:75%");
    expect(html).toMatch(/class="area-rule" data-under="" style="width:40%"/);
    expect(liftRuleShare(1.5, 2)).toBe(0.75);
    expect(liftRuleShare(3, 2)).toBe(1);
    expect(liftRuleShare(1, 0)).toBe(0);
  });

  it("folds rows past the fifth behind a '+ N more areas' button", () => {
    const many = Array.from({ length: AREA_ROWS_SHOWN + 2 }, (_, i) => tile(`dn6jv${i}`, 2 - i * 0.1, `Area ${i + 1}`));
    const html = renderToStaticMarkup(createElement(TileList, { tiles: many }));
    expect(html.match(/<li /g)?.length).toBe(AREA_ROWS_SHOWN);
    expect(html).toContain("+ 2 more areas");
    // A row picked on the map is never folded away.
    const open = renderToStaticMarkup(createElement(TileList, { tiles: many, selected: many.at(-1)!.geohash }));
    expect(open.match(/<li /g)?.length).toBe(many.length);
  });

  it("says why there is nothing to number", () => {
    expect(renderToStaticMarkup(createElement(TileList, { tiles: [] }))).toContain("No area reached a lift of 1.3");
  });
});

describe("legend and landing pair", () => {
  it("prints the stepped swatches on one line, led by the baseline", () => {
    const html = renderToStaticMarkup(createElement(LiftLegend, { caption: "Fans compared with the room's usual crowd" }));
    expect(html).toContain("Fans compared with the room&#x27;s usual crowd:");
    for (const l of LIFT_LEGEND) expect(html).toContain(l.label);
    expect(html).not.toMatch(/gradient/i);
  });

  it("puts the headliners over two maps on one frame, with one legend and one caption", () => {
    const b = sheet(a.pairedPlanId ?? "g1-b");
    const side = (s: StreetSheet) => ({
      planId: s.planId,
      headliner: s.bill.acts[0]!.name,
      support: s.bill.acts.slice(1).map((x) => x.name),
      label: "Country",
      place: s.bill.venue.name,
      date: s.bill.date,
      tiles: allTiles(s),
      top: topTiles(s),
      venue: venueOf(s),
      partners: s.cards.partners.results.length,
      sample: true,
    });
    const html = renderToStaticMarkup(createElement(HeroSplit, { a: side(a), b: side(b), legendCaption: "Fans compared with the room's usual crowd", source: "Data: sample." }));
    expect(html.match(/<h3 /g)?.length).toBe(2);
    expect(html).toContain(a.bill.acts[0]!.name);
    expect(html.match(/Lift colour key/g)?.length).toBe(1);
    expect(html).toContain("Both maps use the same frame and scale.");
    expect(html).toContain('id="hero-A-areas"');
    expect(html).toContain("grid-rows-subgrid");
    expect(andList(["A", "B", "C"])).toBe("A, B and C");
    expect(andList(["A"])).toBe("A");
  });
});

describe("one marker look in both themes", () => {
  it("is a 20px ink circle with a white 12px numeral and a white ring, in the CSS too", () => {
    const rule = /\.marker \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(rule).toContain(`background: ${MARKER.fill}`);
    expect(rule).toContain(`color: ${MARKER.text}`);
    expect(rule).toContain(`box-shadow: 0 0 0 ${MARKER.ring}px ${MARKER.text}`);
    expect(rule).toContain("width: 1.25rem"); // 2 x MARKER.radius
    expect(rule).toContain("font-size: 0.75rem"); // MARKER.fontSize
    expect(MARKER.radius * 2).toBe(20);
    expect(MARKER.fontSize).toBe(12);
  });

  it("merges numbers that sit too close to tell apart", () => {
    const g = groupMarkers([
      { rank: 2, x: 10, y: 10 },
      { rank: 1, x: 100, y: 100 },
      { rank: 3, x: 20, y: 14 },
    ]);
    expect(g.map((x) => x.label)).toEqual(["1", "2, 3"]);
  });
});
