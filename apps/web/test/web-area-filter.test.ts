/**
 * The partner table's area filter on paper (re-audit N50 follow-up, Oct 29). The "Show: all · 1 ... · 2 ..." buttons
 * are no-print, so a list filtered to one area says so in print: one print-only line names the area and how many
 * partners are listed. Checked for the four sample sheets and, when the git-ignored deploy/vercel/plans.json is
 * present, every recorded plan the hosted site serves, with each area pressed.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StreetSheet } from "@walkup/contracts";

// A static render can't press a button, so the area filter's state (the card's only useState(null)) is set here.
const pressed: { geohash: string | null } = { geohash: null };
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((init: unknown) =>
    init === null && pressed.geohash !== null ? [pressed.geohash, () => undefined] : actual.useState(init)) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

const { PartnersCard } = await import("../components/plan/PartnersCard");
const { ReceiptContext } = await import("../components/plan/receipts");
const { partnerAnchor } = await import("../components/plan/model");
const { topTiles, areaName } = await import("../lib/sheet-utils");
const { vettedSheet } = await import("../lib/vetted");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const PLANS_FILE = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const PLANS: { planId: string; sheet: StreetSheet }[] = existsSync(PLANS_FILE) ? JSON.parse(readFileSync(PLANS_FILE, "utf8")) : [];
const PAGES = [...["g1-a", "g1-b", "g2", "g3"].map((id) => ({ id, sheet: fixture(id) })), ...PLANS.map((p) => ({ id: p.planId.slice(0, 8), sheet: p.sheet }))];

const NOTE = /<span class="hidden print:inline">([^<]*)<\/span>/;

function render(sheet: StreetSheet, geohash: string | null): string {
  pressed.geohash = geohash;
  try {
    const card = createElement(PartnersCard, { sheet });
    return renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries: sheet.ledger, open: () => undefined } }, card));
  } finally {
    pressed.geohash = null;
  }
}

describe("a filtered partner list says so on paper", () => {
  it("prints no note while every area is listed", () => {
    for (const { id, sheet } of PAGES) {
      const html = render(vettedSheet(sheet).sheet, null);
      expect(html, id).not.toMatch(/were hidden on screen/);
    }
  });

  it("names the pressed area and its partner count, in a line only print shows, on every sheet", () => {
    let checked = 0;
    for (const { id, sheet: stored } of PAGES) {
      const sheet = vettedSheet(stored).sheet;
      const results = sheet.cards.partners.results;
      const areas = [...new Set(results.map((p) => p.tileGeohash).filter((g): g is string => !!g))];
      // The filter shows only when partners come from more than one area.
      if (areas.length < 2) continue;
      const top = topTiles(sheet);
      for (const g of areas) {
        const html = render(sheet, g);
        const inArea = results.filter((p) => p.tileGeohash === g);
        const others = results.filter((p) => p.tileGeohash !== g);
        // The table lists only the pressed area.
        for (const p of inArea) expect(html, `${id} ${g}`).toContain(`id="${partnerAnchor(p.entity.entityId)}"`);
        for (const p of others) expect(html, `${id} ${g}`).not.toContain(`id="${partnerAnchor(p.entity.entityId)}"`);
        const note = NOTE.exec(html)?.[1]?.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
        const i = top.findIndex((t) => t.geohash === g);
        const where = i >= 0 ? `area ${i + 1} (${areaName(top[i])})` : undefined;
        const n = inArea.length;
        expect(note, `${id} ${g}`).toBeDefined();
        expect(note, `${id} ${g}`).toContain(`Only ${n === 1 ? "the 1 partner" : `the ${n} partners`} in `);
        if (where) expect(note, `${id} ${g}`).toContain(` in ${where} ${n === 1 ? "is" : "are"} listed here.`);
        expect(note, `${id} ${g}`).toMatch(/ The other areas were hidden on screen\.$/);
        expect(note, `${id} ${g}`).not.toMatch(/—/);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
