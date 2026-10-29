/**
 * Plan-page fixes from the October audit: the Checks line and list say why lines went (not "removed 15 claims" and
 * one note 13 times), the header says when the map widened past the radius, the top pick carries its dagger, a
 * sheet with no top pick says so, phones read as on paper, and a partner row with no line from Claude gets a fixed
 * one. Every sheet is a generated fixture changed by hand.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { GuardReport, LiftTile, Partner, StreetSheet } from "@walkup/contracts";
import { partnerAreaText } from "@walkup/exports/format";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { checkNotes, checksLine, discoveryLessSure, mapReachKm } = await import("../components/plan/PlanView");
const { DiscoveryNote, NoDiscoveryNote } = await import("../components/plan/SheetExtras");
const { fixedPartnerLine, lineDayNote, otherState, PartnersCard } = await import("../components/plan/PartnersCard");
const { ReceiptContext } = await import("../components/plan/receipts");

const render = (node: ReactNode) => renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries: [], open: () => undefined } }, node));

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;

const guard = (dropped: number, reasons: string[]): GuardReport => ({ dropped, reasons, deniedTagCount: 0 });

describe("Checks", () => {
  const roots = [
    'partnerLines[0]: alcohol word "Wine" on a show that is not 21+',
    'partnerLines[16]: alcohol word "Cocktail" on a show that is not 21+',
    ...Array.from({ length: 13 }, (_, i) => `partnerLines[${22 + i}]: not a partner`),
  ];

  it("counts only lines that cited something the run didn't return as claims", () => {
    expect(checksLine(guard(15, roots))).toBe("Checks left out 15 lines, none for a claim the run didn't back. No tag was left out under the data policy.");
    expect(checksLine(guard(2, ["summary: number 1.8 is not in this run", 'partnerLines[6]: alcohol word "Cocktail" on a show that is not 21+']))).toBe(
      "Checks left out 2 lines: 1 for a claim the run didn't back, 1 for a wording or policy rule. No tag was left out under the data policy.",
    );
    expect(checksLine(guard(0, []))).toBe("Checks removed 0 claims. No tag was left out under the data policy.");
  });

  it("lists one note once with its count, in plain words", () => {
    const notes = checkNotes(roots);
    expect(notes).toHaveLength(3);
    expect(notes[2]).toBe("13 of Claude's partner lines were left out: each was about a place that isn't a partner on this sheet.");
    expect(checkNotes(["partnerLines[3]: not a partner"])).toEqual(["One of Claude's partner lines was left out: it was about a place that isn't a partner on this sheet."]);
  });
});

describe("the header and the top pick", () => {
  it("says when the map search widened past the radius", () => {
    const s = fixture("g1-a");
    expect(mapReachKm(s)).toBeNull();
    const wide = { ...s, operator: { ...s.operator, radiusKm: 10 }, cards: { ...s.cards, liftMap: { ...s.cards.liftMap, reason: "The search widened to 60 km (fewer than 200 map squares came back within 10 km)." } } };
    expect(mapReachKm(wide)).toBe(60);
  });

  it("marks a less certain pick with the table's dagger and note", () => {
    const s = fixture("g1-a");
    const partners = s.cards.partners.results;
    const pick = partners[0]!;
    const sheet: StreetSheet = {
      ...s,
      cards: {
        ...s.cards,
        partners: {
          ...s.cards.partners,
          results: partners.map((p, i) => (p.explain ? { ...p, explain: { ...p.explain, confidence: i === 0 ? ("medium" as const) : ("high" as const) } } : p)),
        },
      },
      discovery: { kind: "partner", headline: `${pick.entity.name}, a place in area 1`, detail: "Synthetic.", rule: "Synthetic.", entityId: pick.entity.entityId, ledgerRefs: [] },
    };
    expect(discoveryLessSure(sheet)).toBe(true);
    const html = render(createElement(DiscoveryNote, { discovery: sheet.discovery!, target: null, lessSure: true }));
    expect(html).toContain("(less certain)");
    expect(html).toContain("Less certain: the search widened");
  });

  it("says so where the callout would be when no pick met the rule", () => {
    const html = renderToStaticMarkup(createElement(NoDiscoveryNote, { revised: true }));
    expect(html).toContain("No top pick after this change");
    expect(html).not.toContain('id="discovery-title"');
  });
});

describe("partner rows", () => {
  it("shows phones as on the print sheet, keeps tel: links, and fills a row Claude wrote no line for", () => {
    const s = fixture("g1-a");
    const [a, b] = s.cards.partners.results as [Partner, Partner];
    const sheet: StreetSheet = {
      ...s,
      cards: { ...s.cards, partners: { ...s.cards.partners, results: [{ ...a, phone: "+17088482801" }, b] } },
      narration: { ...s.narration!, templated: false, partnerLines: [{ entityId: a.entity.entityId, text: "A line from Claude." }] },
    };
    const html = render(createElement(PartnersCard, { sheet }));
    expect(html).toContain('href="tel:+17088482801"');
    expect(html).toContain("(708) 848-2801");
    expect(html).not.toContain(">+17088482801<");
    expect(html).toContain(fixedPartnerLine(b).replace(/'/g, "&#x27;"));
  });

  it("builds the fixed line from the row and says 'near' the area", () => {
    const p = { category: "wine_bar", tileName: "Bronzeville", explain: { tags: [{ id: "t1", name: "Cozy" }, { id: "t2", name: "Upscale" }] } } as unknown as Partner;
    expect(fixedPartnerLine(p)).toMatch(/ near Bronzeville, shares the cozy and upscale tags with this crowd\.$/);
    // An area with no name is still an area; only a place with no area came from the search around the venue.
    expect(fixedPartnerLine({ ...p, tileName: null, tileGeohash: "dqcjr0" } as unknown as Partner)).toMatch(/ near an unnamed area, shares/);
    expect(fixedPartnerLine({ ...p, tileName: null, tileGeohash: null } as unknown as Partner)).toMatch(/ near the venue, shares/);
  });

  it("names the place's own state when its address is over a state line from its area", () => {
    expect(otherState({ address: "5723 Tuxedo Rd Hyattsville, MD 20781" }, "Kenilworth, DC")).toBe("MD");
    expect(otherState({ address: "1339 H St NE Washington, DC 20002" }, "H Street NE, DC")).toBeNull();
    // The print view, the PDF, partners.csv and the calendar say it in the area cell.
    const tile = { geohash: "dqcjr0", name: "Kenilworth", zctas: ["20019"], state: "DC" } as unknown as LiftTile;
    const tiles = new Map([[tile.geohash, tile]]);
    const oasiz = { tileGeohash: "dqcjr0", tileName: "Kenilworth", address: "5723 Tuxedo Rd Hyattsville, MD 20781" };
    expect(partnerAreaText(oasiz, tiles)).toBe("Kenilworth, DC (place in MD)");
    expect(partnerAreaText({ ...oasiz, address: "4400 Kenilworth Ave NE Washington, DC 20019" }, tiles)).toBe("Kenilworth, DC");
  });

  it("says which day Claude's line is about when the street team visits the place on another day", () => {
    expect(lineDayNote("Pub near South Shore, open Thursday 21:30 to 04:00.", "Sat")).toBe("This line is about Thursday; the street team visits on Saturday.");
    expect(lineDayNote("Pub near South Shore, open Thursday 21:30 to 04:00.", "Thu")).toBeNull();
    expect(lineDayNote("Cafe near the venue, a stop before the Saturday show.", "Thu")).toBeNull();
    expect(lineDayNote("Cafe near the venue, shares the cozy tag.", "Sat")).toBeNull();
    // A holiday's stops can move to another day of its week, so a row is visited on two days: one of them is the line's.
    expect(lineDayNote("open Thursday 21:30 to 04:00", "Sat; Thu")).toBeNull();
    expect(lineDayNote("open Thursday 21:30 to 04:00", "Sat; Fri")).toBe("This line is about Thursday; the street team visits on Saturday and Friday.");
    // g1-a has two street-team days; its first partner is visited on Saturday, the second has no line from Claude.
    const s = fixture("g1-a");
    const [a] = s.cards.partners.results as [Partner];
    const sheet: StreetSheet = { ...s, narration: { ...s.narration!, templated: false, partnerLines: [{ entityId: a.entity.entityId, text: "Bar near Hilltop, open Thursday 16:00 to 02:00." }] } };
    const html = render(createElement(PartnersCard, { sheet }));
    // Once in the phone layout and once in the Why column, for that row only.
    expect(html.split("This line is about Thursday; the street team visits on Saturday.").length - 1).toBe(2);
  });
});
