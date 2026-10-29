/**
 * The print view (/s/<id>) rendered to static HTML on the synthetic fixture world (memory plan store, temp data
 * dir, no keys): the spots table never prints an empty "Vs usual crowd" cell, and the page describes its own sheet.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StreetSheet } from "@walkup/contracts";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { default: SheetPage, generateMetadata } = await import("../app/s/[id]/page");
const { resetEngineForTests, stores } = await import("../lib/server/engine");
const { resetRunsForTests } = await import("../lib/server/runs");
const { loadPlan } = await import("../lib/server/service");
const { vettedSheet } = await import("../lib/vetted");
const { NoDiscoveryNote } = await import("../components/plan/SheetExtras");
const { buildSheetModel, noTopPickText } = await import("@walkup/exports/sheet-model");

/** The hosted sheets (git-ignored, shipped with a deploy): the tests that read them run only where the file is. */
const PLANS = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_PLAN_SEED"];
const saved: Record<string, string | undefined> = {};
let dir = "";

beforeAll(() => {
  for (const k of [...KEYS, "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"]) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "hl-print-test-"));
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  resetEngineForTests();
  resetRunsForTests();
});

afterAll(() => {
  resetEngineForTests();
  resetRunsForTests();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** The desktop table under "Before and after the show": its header cells and each row's cells, as text. */
function spotsTable(html: string): { head: string[]; rows: string[][] } {
  const section = /<section[^>]*aria-labelledby="sec-prepost"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
  const table = /<table[\s\S]*?<\/table>/.exec(section)?.[0] ?? "";
  const cells = (row: string, tag: "th" | "td") => [...row.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());
  const head = cells(/<thead[\s\S]*?<\/thead>/.exec(table)?.[0] ?? "", "th");
  const rows = [...((/<tbody[\s\S]*?<\/tbody>/.exec(table)?.[0] ?? "").matchAll(/<tr[\s\S]*?<\/tr>/g))].map((m) => cells(m[0], "td"));
  return { head, rows };
}

describe("print view", () => {
  it("fills every Vs usual crowd cell, or leaves the column out when there is no usual crowd to compare with", async () => {
    for (const id of ["g1-a", "g3"]) {
      const v = await loadPlan(id, { view: "api" });
      if (v?.kind !== "sheet") throw new Error(id);
      const ranked = v.sheet.cards.prePost.results.some((s) => s.deltaRank !== null);
      const { head, rows } = spotsTable(renderToStaticMarkup(await SheetPage(params(id))));
      expect(rows.length, id).toBeGreaterThan(0);
      for (const r of rows) expect(r).toHaveLength(head.length);
      for (const r of rows) for (const cell of r) expect(cell, `${id}: ${r.join(" | ")}`).not.toBe("");
      expect(head.includes("Vs usual crowd"), id).toBe(ranked);
    }
  });

  it("gives the true reason when a sheet has no top pick, in the plan page's words, and the dagger note once", async () => {
    // g3 has no usual crowd at all (baseline "none"), so neither rule could run.
    const v = await loadPlan("g3", { view: "api" });
    if (v?.kind !== "sheet") throw new Error("g3");
    expect(v.sheet.discovery).toBeUndefined();
    const html = renderToStaticMarkup(await SheetPage(params("g3")));
    const text = html.replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'");
    const reason = "No top pick on this sheet: both rules compare this crowd with the room's usual crowd, and this run has no usual crowd to compare with.";
    expect(text).toContain(reason);
    expect(text).not.toContain("ranks no partner");
    // The plan page's note says the same sentence (`noTopPickText`), under a heading that doesn't promise a place.
    const note = renderToStaticMarkup(createElement(NoDiscoveryNote, { sheet: vettedSheet(v.sheet).sheet })).replace(/&#x27;|&apos;/g, "'");
    expect(note).toContain(reason);
    expect(note).toContain(">Top pick</h2>");
    expect(note).not.toContain("Start with this place");
    // A sheet with a pick: the less-certain note is said once, under the table, when any row or the pick has the dagger.
    for (const id of ["g1-a", "g1-b", "g2"]) {
      const p = await loadPlan(id, { view: "api" });
      if (p?.kind !== "sheet") throw new Error(id);
      const m = buildSheetModel(vettedSheet(p.sheet).sheet);
      const dagger = m.panel2.rows.some((r) => r.lessSure) || !!m.discovery?.lessSureNote;
      const page = renderToStaticMarkup(await SheetPage(params(id)));
      expect(page.split("Less certain: the search widened").length - 1, id).toBe(dagger ? 1 : 0);
    }
  });

  it.skipIf(!existsSync(PLANS))("gives each hosted sheet with no top pick its own reason, not the fallback line", () => {
    const plans = JSON.parse(readFileSync(PLANS, "utf8")) as { sheet: StreetSheet }[];
    const none = plans.map((p) => p.sheet).filter((s) => !s.discovery && (s.steps ?? []).length > 0);
    // f81d3edd and 090902c0: revisions of one-act bills, where neither rule could pick.
    expect(none.map((s) => s.planId.slice(0, 8)).sort()).toEqual(["090902c0", "f81d3edd"]);
    for (const s of none) {
      const sheet = vettedSheet(s).sheet;
      const note = renderToStaticMarkup(createElement(NoDiscoveryNote, { sheet })).replace(/&#x27;|&apos;/g, "'");
      expect(note, s.planId).toContain(noTopPickText(sheet));
      expect(note, s.planId).toContain("No top pick after this change: the room's usual crowd ranks no partner here at least 5 places lower");
      expect(note, s.planId).toContain("split-half check, which can't run on a one-act bill.");
      expect(note, s.planId).not.toContain("no place or area met the fixed rule");
    }
  });

  it("prints every cell in full and keeps each partner row and the footer whole on paper", async () => {
    for (const id of ["g1-a", "g2", "g3"]) {
      const html = renderToStaticMarkup(await SheetPage(params(id)));
      const sheet = /<article[\s\S]*<\/article>/.exec(html)?.[0] ?? "";
      expect(sheet, id).not.toBe("");
      // Paper has no tooltip to show the rest, so nothing on the sheet is cut with "…" or clamped to two lines.
      expect(sheet, id).not.toMatch(/class="[^"]*\b(truncate|line-clamp-\d)\b/);
      // No extra lift on the tables' receipts: with it they sat over the line above.
      expect(sheet, id).not.toContain("_.fn]:align");
      // A row never splits across the page break, which left a phone number alone at the top of page 2.
      const partners = /<section[^>]*aria-labelledby="sec-partners"[\s\S]*?<\/section>/.exec(sheet)?.[0] ?? "";
      const rows = [...((/<tbody>[\s\S]*?<\/tbody>/.exec(partners)?.[0] ?? "").matchAll(/<tr [^>]*>/g))].map((m) => m[0]);
      expect(rows.length, id).toBeGreaterThan(0);
      for (const r of rows) expect(r, id).toContain("print:break-inside-avoid");
      expect(sheet, id).toMatch(/<footer class="print-avoid-break /);
      // On paper the Q numbers open nothing, so the paper says they point to the request.
      const text = (s: string) => s.replace(/<[^>]+>/g, "");
      const paper = text(sheet.replace(/<span class="print:hidden">[^<]*<\/span>/g, ""));
      const screen = text(sheet.replace(/<span class="hidden print:inline">[^<]*<\/span>/g, ""));
      expect(paper, id).toContain("The small Q numbers after each line point to the request behind it.");
      expect(screen, id).toContain("The small Q numbers after each line open the request behind it.");
    }
  });

  it("offers the one-page PDF in US Letter and A4, and does not promise one page for this view", async () => {
    const html = renderToStaticMarkup(await SheetPage(params("g2")));
    const text = html.replace(/<[^>]+>/g, "");
    expect(html).toContain('href="/api/sheet/g2/pdf"');
    expect(html).toContain('href="/api/sheet/g2/pdf?size=a4"');
    expect(text).toContain("Download PDF: US Letter · A4");
    expect(text).toContain("The PDF is one page. Printing this view can take two.");
    expect(text).not.toContain("US Letter or A4");
    // The page's own description does not call this view one page either.
    for (const id of ["g1-a", "g2", "g3"]) expect(String((await generateMetadata(params(id))).description), id).not.toMatch(/one-page/i);
  });

  it("describes its own sheet, not the home page", async () => {
    const v = await loadPlan("g1-a", { view: "api" });
    if (v?.kind !== "sheet") throw new Error("g1-a");
    const meta = await generateMetadata(params("g1-a"));
    expect(meta.title).toMatch(/street sheet \(sample\)$/);
    // The checked sheet's summary, the same one the plan page uses; else a line naming the sheet.
    const summary = vettedSheet(v.sheet).sheet.narration?.summary?.trim();
    expect(meta.description).toBe(summary ? summary : expect.stringContaining(v.sheet.bill.venue.name));
    expect(String(meta.description)).not.toMatch(/^For one booked show/);
    expect((await generateMetadata(params("no-such-plan"))).title).toBe("Sheet not found");
  });

  it("counts the podcasts past its list of 4, as the PDF does past its 3, and says nothing when all fit", async () => {
    const v = await loadPlan("g1-a", { view: "api" });
    if (v?.kind !== "sheet") throw new Error("g1-a");
    const pods = v.sheet.cards.media.results.filter((m) => m.kind === "podcast");
    expect(pods).toHaveLength(4);
    const planId = "00000000-0000-4000-8000-00000000f1ve";
    const extra = { ...pods[0]!, entity: { ...pods[0]!.entity, entityId: "fifth-podcast", name: "The Fifth Podcast" } };
    const sheet: StreetSheet = { ...structuredClone(v.sheet), planId };
    sheet.cards.media.results = [...sheet.cards.media.results, extra];
    await stores().plans.put({ planId, createdAt: sheet.createdAt, mode: "fixture", status: "complete", request: { planId }, sheet });
    const text = (html: string) => html.replace(/<[^>]+>/g, "");
    expect(text(renderToStaticMarkup(await SheetPage(params(planId))))).toContain("+1 more podcast on the plan page and in sheet.json.");
    expect(text(renderToStaticMarkup(await SheetPage(params("g1-a"))))).not.toContain("more podcast");
  });
});
