/**
 * Plan page and print view fixes of Oct 29 (round 2 of the re-audit), checked on the four sample sheets and, when the
 * git-ignored deploy/vercel/plans.json is present, on every recorded plan the hosted site serves.
 *
 * - The partner card's "for flyering only" names only areas no partner search covered; a searched area that kept no
 *   partner says so (outputs-F1, read from the search receipts).
 * - Checks count a summary fixed wording replaced as replaced, not left out (outputs-F7), and say "no line" rather
 *   than "removed 0 claims" (outputs-F8).
 * - The sponsor line is said once (outputs-F9); the Type cell uses the files' label (outputs-F10); the sheet.json line
 *   says it is the sheet as recorded (outputs-F11).
 * - The print view says "+1 more partner" (outputs-F5) and ends the no-top-pick line with a full stop (outputs-F12).
 * - "Select an area" stays off paper (browser-print-F4); the static map's squares get the same attributes on the
 *   server and in the browser (browser-print-F3).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Partner, StreetSheet } from "@walkup/contracts";
import { categoryLabel as fileLabel } from "@walkup/exports/format";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }), notFound: () => undefined }));
// The interactive layer loads MapLibre in the browser only; the static render is what is checked here.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { PartnersCard, partnerSearchLine } = await import("../components/plan/PartnersCard");
const { MediaCard } = await import("../components/plan/MoreCards");
const { LiftCard } = await import("../components/plan/LiftCard");
const { checksLine } = await import("../components/plan/PlanView");
const { ReceiptContext } = await import("../components/plan/receipts");
const { StaticLiftMap } = await import("../components/StaticLiftMap");
const { EXPORT_LINKS } = await import("../lib/server/exports");
const { partnerSearchAreas, topTiles } = await import("../lib/sheet-utils");
const { vettedSheet } = await import("../lib/vetted");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const PLANS_FILE = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const PLANS: { planId: string; sheet: StreetSheet }[] = existsSync(PLANS_FILE) ? JSON.parse(readFileSync(PLANS_FILE, "utf8")) : [];
const PAGES = [...["g1-a", "g1-b", "g2", "g3"].map((id) => ({ id, sheet: fixture(id) })), ...PLANS.map((p) => ({ id: p.planId.slice(0, 8), sheet: p.sheet }))];

const wrap = (sheet: StreetSheet, el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries: sheet.ledger, open: () => undefined } }, el));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const searchSentence = (html: string) => /Walkup searches [^.]*\./.exec(text(html))?.[0] ?? null;

describe("which areas a partner search covered (outputs-F1)", () => {
  it("says an area was searched when none of its places stayed, and flyering only for the rest", () => {
    const kept = new Set([1, 2]);
    expect(partnerSearchLine(5, [1, 2, 3], kept)).toBe("Walkup searches the top 3 areas for partners; no place in area 3 made the list, and areas 4 and 5 are for flyering only.");
    expect(partnerSearchLine(5, [1, 2, 3], new Set([1, 2, 3]))).toBe("Walkup searches the top 3 areas for partners; areas 4 and 5 are for flyering only.");
    expect(partnerSearchLine(3, [1, 2, 3], kept)).toBe("Walkup searches the top 3 areas for partners; no place in area 3 made the list.");
    expect(partnerSearchLine(4, [1, 3], new Set([1, 3]))).toBe("Walkup searches areas 1 and 3 for partners; areas 2 and 4 are for flyering only.");
    expect(partnerSearchLine(2, [1], new Set([1]))).toBe("Walkup searches the top area for partners; area 2 is for flyering only.");
    expect(partnerSearchLine(3, [1, 2, 3], new Set([1, 2, 3]))).toBe("");
    // No area searched: the partners come from near the venue, and the section's reason says so.
    expect(partnerSearchLine(5, [], new Set())).toBe("");
  });

  it("reads the searched areas from the search receipts, so an area whose places all left still counts", () => {
    const s = structuredClone(fixture("g1-a"));
    const top = topTiles(s);
    const third = top[2]!.geohash;
    expect(partnerSearchAreas(s).has(third)).toBe(true);
    s.cards.partners.results = s.cards.partners.results.filter((p) => p.tileGeohash !== third);
    expect(partnerSearchAreas(s).has(third)).toBe(true);
    // The sample's numbered areas past the third are for flyering only, however many there are.
    expect(searchSentence(wrap(s, createElement(PartnersCard, { sheet: s })))).toBe(partnerSearchLine(top.length, [1, 2, 3], new Set([1, 2])));
    expect(searchSentence(wrap(s, createElement(PartnersCard, { sheet: s })))).toMatch(/^Walkup searches the top 3 areas for partners; no place in area 3 made the list/);
  });

  it("never calls a searched area flyering only, on any sheet", () => {
    for (const { id, sheet: stored } of PAGES) {
      const sheet = vettedSheet(stored).sheet;
      const sentence = searchSentence(wrap(sheet, createElement(PartnersCard, { sheet })));
      const searched = partnerSearchAreas(sheet);
      const flyer = /;\s*(?:.*, and )?areas? ([\d, and]+?) (?:is|are) for flyering only/.exec(sentence ?? "")?.[1];
      const numbers = (flyer ?? "").split(/,\s*|\s+and\s+/).filter(Boolean).map(Number);
      const top = topTiles(sheet);
      for (const n of numbers) expect(searched.has(top[n - 1]!.geohash), `${id}: area ${n}`).toBe(false);
    }
  });

  it.skipIf(!existsSync(PLANS_FILE) || !PLANS.some((p) => p.planId.startsWith("d27fbf4f")))("says area 3 kept no partner on the FLO 'No restaurants' sheet", () => {
    const sheet = vettedSheet(PLANS.find((p) => p.planId.startsWith("d27fbf4f"))!.sheet).sheet;
    expect(searchSentence(wrap(sheet, createElement(PartnersCard, { sheet })))).toBe(
      "Walkup searches the top 3 areas for partners; no place in area 3 made the list, and areas 4 and 5 are for flyering only.",
    );
  });
});

describe("the Checks line (outputs-F7, outputs-F8)", () => {
  const g = (dropped: number, reasons: string[]) => ({ dropped, reasons, deniedTagCount: 0 });
  it("counts a summary fixed wording replaced as replaced, not left out", () => {
    expect(checksLine(g(2, ["summary: number 1.8 is not in this run", 'partnerLines[6]: alcohol word "Cocktail" on a show that is not 21+']))).toBe(
      "Checks left out 1 line, for a wording or policy rule. No tag was left out under the data policy.",
    );
    expect(checksLine(g(1, ["summary: number 1.8 is not in this run"]))).toBe("Checks left out no line. No tag was left out under the data policy.");
    expect(checksLine(g(3, ["summary: number 1.8 is not in this run", "partnerLines[1]: number 9 is not in this run", "partnerLines[2]: number 7 is not in this run"]))).toBe(
      "Checks removed 2 claims. No tag was left out under the data policy.",
    );
  });

  it("counts the run's partner lines dropped at once, in the new wording and the old", () => {
    for (const r of ["2 partner lines dropped: cited entity not traced to this run's ledger.", "2 partner line(s) dropped: cited entity not traced to this run's ledger."]) {
      expect(checksLine(g(2, [r]))).toBe("Checks removed 2 claims. No tag was left out under the data policy.");
    }
    expect(checksLine(g(1, ["1 partner line dropped: cited entity not traced to this run's ledger."]))).toBe("Checks removed 1 claim. No tag was left out under the data policy.");
  });

  it("says no line was left out on a sheet with nothing dropped or replaced", () => {
    expect(checksLine({ ...g(0, []), deniedTagCount: 4, deniedByNamespace: { ethnicity: 1, inclusivity: 2, credit_card: 1 } })).toBe(
      "Checks left out no line. 4 tags were left out under the data policy (ethnicity, inclusivity, credit card).",
    );
    for (const { id, sheet } of PAGES) expect(checksLine(sheet.guard), id).not.toMatch(/removed 0 claims/);
  });
});

describe("one sponsor line, one type label, an honest sheet.json line (outputs-F9, F10, F11)", () => {
  it("says no sponsor came back once on g3", () => {
    const s = fixture("g3");
    expect(s.cards.media.reason).toContain("No sponsor brand came back.");
    const html = text(wrap(s, createElement(MediaCard, { sheet: s })));
    expect(html.match(/No sponsor brand came back/g)).toHaveLength(1);
    expect(html).not.toContain("One sponsor to approach");
    // A sheet with a sponsor keeps its heading.
    const g2 = fixture("g2");
    expect(text(wrap(g2, createElement(MediaCard, { sheet: g2 })))).toContain("One sponsor to approach");
  });

  it("labels a clothing store as the print view, the PDF and partners.csv do", () => {
    const s = structuredClone(fixture("g1-a"));
    const p = s.cards.partners.results[0] as Partner;
    p.category = "clothing_store";
    p.chain = true;
    const html = text(wrap(s, createElement(PartnersCard, { sheet: s })));
    expect(html).toContain(`${fileLabel("clothing_store")}, national chain`);
    expect(html).not.toContain("Clothing store, national chain");
  });

  it("says sheet.json is the sheet as recorded, before the view-time checks", () => {
    expect(EXPORT_LINKS.find((l) => l.file === "sheet.json")?.hint).toBe("the whole sheet as recorded, before the view-time checks, with the ledger");
    const src = readFileSync(fileURLToPath(new URL("../components/plan/PlanView.tsx", import.meta.url)), "utf8");
    expect(src).toContain('what: "the whole sheet as recorded, before the view-time checks, with its ledger"');
  });
});

describe("the print view's wording (outputs-F5, outputs-F12)", () => {
  const src = readFileSync(fileURLToPath(new URL("../app/s/[id]/page.tsx", import.meta.url)), "utf8");
  it("says partner for one more partner", () => {
    expect(src).toContain('+{m.panel2.omitted} more {m.panel2.omitted === 1 ? "partner" : "partners"} in partners.csv.');
  });
  it("ends the no-top-pick line with a full stop inside the screen-only link", () => {
    expect(src).toMatch(/className="link no-print">\s*How the top pick is chosen\.\s*<\/a>/);
  });
});

describe("paper and hydration (browser-print-F3, F4)", () => {
  it("keeps 'Select an area' off paper", () => {
    const s = fixture("g1-a");
    const html = wrap(s, createElement(LiftCard, { sheet: s, selected: null, onSelect: () => undefined }));
    expect(html).toContain('<span class="no-print"> Select an area to find it on the map.</span>');
  });

  it("writes the squares' positions with two decimals at most, so server and browser agree", () => {
    const s = fixture("g1-a");
    const venue = { ...s.bill.venue, name: s.bill.venue.name };
    const html = renderToStaticMarkup(
      createElement(StaticLiftMap, { tiles: s.cards.liftMap.results.tiles, venue, ranked: topTiles(s).map((t) => t.geohash), idBase: "t", title: "t" }),
    );
    // The area squares (the ones with a lift shade); the venue square and the markers sit on whole-pixel offsets of these.
    const rects = [...html.matchAll(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="[^"]+" fill-opacity=/g)];
    expect(rects.length).toBeGreaterThan(5);
    for (const r of rects) for (const v of r.slice(1)) expect(v).toMatch(/^-?\d+(?:\.\d{1,2})?$/);
  });
});
