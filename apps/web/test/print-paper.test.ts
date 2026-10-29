/**
 * What the browser prints (Print, or save as PDF from the print dialog), checked at the CSS and component level:
 * the key's fills print with "Background graphics" off, receipts print smaller than the text and inside their
 * line, a lift map is never split by a page break, and folded sections print open without their "Show" line, with
 * every column of the requests table and without the copy lines' Copy buttons.
 * The page-level checks (cells that wrap, rows that stay whole) are in print-view.test.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { FoldBody, FoldContext, openForPrint } from "../components/plan/fold";
import { LiftMap } from "../components/LiftMap";
import { LedgerSection } from "../components/plan/LedgerSection";
import { CopyHooksCard } from "../components/plan/MoreCards";
import { ReceiptContext } from "../components/plan/receipts";

// The interactive layer loads MapLibre in the browser only; the static render is what is checked here.
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const CSS = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");

/** The body of the top-level `@media print { ... }` block. */
function printBlock(css: string): string {
  const start = css.indexOf("@media print {");
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error("unclosed @media print");
}

/** The declarations of the rule whose selector list is exactly `selector` (whitespace-insensitive). */
function rule(block: string, selector: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (flat(m[1]!.replace(/\/\*[\s\S]*?\*\//g, "")) === flat(selector)) return m[2]!;
  }
  return "";
}

const PRINT = printBlock(CSS);

describe("print CSS", () => {
  it("prints the key swatches, the venue square and the markers with background graphics off", () => {
    const r = rule(PRINT, "html, body");
    expect(r).toMatch(/(^|[^-])print-color-adjust:\s*exact/);
    expect(r).toMatch(/-webkit-print-color-adjust:\s*exact/);
  });

  it("sets the sheet's receipts smaller than its text, inside their own line, on screen and on paper", () => {
    // The plan page's `.fn-flat` has a 12px floor; on the sheet (6.3pt on paper) that printed refs at 9pt over the
    // line above. The sheet's own rule is relative to its text, with no floor and a smaller raise.
    const r = rule(CSS, ".paper .fn-flat");
    const size = /font-size:\s*([\d.]+)em/.exec(r);
    expect(size, r).not.toBeNull();
    expect(Number(size![1])).toBeLessThan(1);
    expect(r).not.toMatch(/px/);
    const top = /top:\s*-([\d.]+)em/.exec(r);
    expect(Number(top?.[1] ?? 9)).toBeLessThanOrEqual(0.35);
    expect(rule(CSS, ".fn-flat")).toMatch(/vertical-align:\s*baseline/);
    // Nothing on paper puts the floor or a lift back.
    expect(PRINT).not.toMatch(/fn/);
  });

  it("keeps a lift map whole, with its caption and the key above it", () => {
    expect(rule(PRINT, ".lift-figure, div:has(> .lift-figure)")).toMatch(/break-inside:\s*avoid/);
    const venue = { lat: 38.9, lon: -77.0, name: "The Anthem" };
    const html = renderToStaticMarkup(createElement(LiftMap, { tiles: [], venue, ranked: [], idBase: "m", title: "Areas", interactive: false }));
    expect(html).toMatch(/^<figure class="lift-figure /);
  });

  it("prints every disclosure open and leaves off a fold's Show line", () => {
    expect(rule(PRINT, "details::details-content")).toMatch(/content-visibility:\s*visible/);
    expect(rule(PRINT, ".fold > summary")).toMatch(/display:\s*none/);
  });
});

describe("the requests table and the copy lines on paper", () => {
  const sheet = (JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/synthetic/engine/g2.sheet.json", import.meta.url)), "utf8")) as { sheet: StreetSheet }).sheet;
  const withReceipts = (child: ReturnType<typeof createElement>) =>
    renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries: sheet.ledger, open: () => undefined, sample: true } }, createElement(FoldContext.Provider, { value: true }, child)));
  /** Paper is 748px wide on Letter and 726px on A4 (9mm margins), so only `sm:` (640px) columns show there by themselves. */
  const PAPER_SHOWS = new Set(["sm:table-cell"]);

  it("prints every column of the requests table, Source and Results too", () => {
    // Source and Results show from md (768px) on screen. No other line on the row repeats them, so paper gets them.
    expect(rule(PRINT, "#ledger th.md\\:table-cell, #ledger td.md\\:table-cell")).toMatch(/display:\s*table-cell/);
    const html = withReceipts(createElement(LedgerSection, { entries: sheet.ledger, exportHref: "/x", sample: true }));
    expect(html).toMatch(/^<section id="ledger"/);
    const hidden = [...html.matchAll(/<t[hd][^>]*class="([^"]*)"/g)].map((m) => m[1]!.split(/\s+/)).filter((c) => c.includes("hidden"));
    expect(hidden.length).toBeGreaterThan(0);
    for (const c of hidden) {
      const shownAt = c.find((x) => /^(sm|md|lg|xl):table-cell$/.test(x));
      expect(shownAt === "md:table-cell" || PAPER_SHOWS.has(shownAt ?? ""), c.join(" ")).toBe(true);
    }
    // Each row's Source and Results cells carry the class the print rule names.
    const md = hidden.filter((c) => c.includes("md:table-cell") && !c.includes("num")).length;
    expect(md).toBe(sheet.ledger.length + 1);
    expect(hidden.filter((c) => c.includes("md:table-cell") && c.includes("num")).length).toBe(sheet.ledger.length + 1);
  });

  it("leaves a copy line's Copy button off paper, and keeps the line", () => {
    expect(rule(PRINT, "#hooks li > button")).toMatch(/display:\s*none/);
    const html = withReceipts(createElement(CopyHooksCard, { sheet }));
    expect(html).toMatch(/^<section id="hooks"/);
    const items = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]!);
    expect(items.length).toBe(sheet.cards.copyHooks.results.length);
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) {
      // The button is the li's own child (what `#hooks li > button` hides), and the line itself is not a button.
      expect(li).toMatch(/<\/div><button type="button"[^>]*>Copy<\/button>$/);
      expect(li).toMatch(/^<div[^>]*><p[^>]*>“/);
    }
  });
});

describe("folded sections on paper", () => {
  it("opens a closed fold for printing and closes it again after, and leaves an open one open", () => {
    const closed = { open: false };
    const restore = openForPrint(closed);
    expect(closed.open).toBe(true);
    restore();
    expect(closed.open).toBe(false);

    const open = { open: true };
    openForPrint(open)();
    expect(open.open).toBe(true);
  });

  it("still renders the fold as a plain Show disclosure on screen", () => {
    const html = renderToStaticMarkup(createElement(FoldContext.Provider, { value: true }, createElement(FoldBody, { title: "the requests", children: "Q1" })));
    expect(html).toContain('<details class="plain-details fold mt-2"><summary><span class="fold-show">Show</span>');
    expect(html).toContain("Q1");
    expect(renderToStaticMarkup(createElement(FoldBody, { title: "x", children: "open" }))).toBe("open");
  });
});
