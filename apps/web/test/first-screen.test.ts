/**
 * What a judge meets first (Oct 28): the summary opens with the show (the checks' fixes are said under Checks), the
 * Fan-Bar Test stated once per sheet with its scope and a short line on the partner table, the run's footprint
 * counted from the ledger, no placeholder rows for blank inputs, Ticketmaster's genre named as Ticketmaster's, the
 * landing's room order, and the home page image.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry, StreetSheet } from "@walkup/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("../components/LiftMap", () => ({
  LiftMap: () => createElement("figure", { "data-testid": "map" }),
  MapCaption: () => null,
  squareSizeLine: () => "Each square is about 1.0 km by 0.6 km.",
}));
vi.mock("../components/LiftLegend", () => ({ LiftLegend: () => null }));
vi.mock("../components/TileList", () => ({ TileList: () => createElement("ol") }));

const { PlanView, checksFixLine, summaryNote } = await import("../components/plan/PlanView");
const { footprintLine, landingRooms, runFootprint, guardNoteText } = await import("../lib/sheet-utils");
const { FANBAR_HREF, FANBAR_RESULT, PARTNER_RANK_LINE, genreLabel, lastSegment } = await import("../lib/labels");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

function renderView(sheet: StreetSheet, extra: Partial<Parameters<typeof PlanView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PlanView, {
      payload: { sheet, note: null, source: "preset", presetId: sheet.planId },
      line: null,
      realShow: false,
      paired: null,
      runtimeLive: false,
      canRerun: false,
      ...extra,
    }),
  );
}

/** A sample sheet re-labelled as a live run (as a recording reads), with Claude's narration. */
function liveSheet(): StreetSheet {
  const s = structuredClone(fixture("g1-a"));
  s.mode = "live";
  s.narration = { ...s.narration!, templated: false };
  return s;
}

/** The part of the page between two element ids. */
function between(html: string, from: string, to: string): string {
  return html.slice(html.indexOf(`id="${from}"`), html.indexOf(`id="${to}"`));
}

const SUMMARY_FIXED = [
  'replaced by the template: summary: superlative "the most" not backed by the sheet',
  "replaced by the template: tileWhy[1]: says three partners, the sheet has 4 in this area",
  "replaced by the template: partnerLines[2]: entityId not in this run",
];

describe("the summary opens with the show, and the checks' fixes are said under Checks", () => {
  it("puts the summary first and says who wrote it after, with no failure notice above it", () => {
    const s = liveSheet();
    s.guard = { ...s.guard, reasons: SUMMARY_FIXED };
    const html = renderView(s);
    const summary = between(html, "summary", "lift");
    // Tags become spaces here; the link "Checks" sits right before the full stop.
    const text = visibleText(summary).replace(/ \./g, ".");
    expect(text).not.toMatch(/Fixed wording:|made a claim/);
    // The summary text comes before the note on who wrote it.
    expect(summary.indexOf(s.narration!.summary.slice(0, 30).replace(/'/g, "&#x27;"))).toBeLessThan(summary.indexOf('data-testid="summary-note"'));
    expect(text).toContain(
      "Summary in fixed wording, in place of Claude's draft. Claude wrote the area and partner lines under checks that let it cite only names and numbers from this run; what the checks changed is under Checks.",
    );
    expect(summary).toContain('href="#checks"');
  });

  it("states the fix plainly in the Checks part of the limits section", () => {
    const s = liveSheet();
    s.guard = { ...s.guard, reasons: SUMMARY_FIXED };
    const limits = between(renderView(s), "limits", "ledger");
    expect(limits).toContain('id="checks"');
    expect(visibleText(limits)).toContain(
      "Claude's draft summary made a claim the sheet doesn't back, so fixed wording replaced it. 2 of Claude's area and partner lines were replaced the same way.",
    );
    // Each reason is still listed, in words.
    expect(visibleText(limits)).toContain("Claude's summary was replaced with fixed wording: superlative \"the most\" not backed by the sheet.");
  });

  it("counts the lines replaced when the summary stood, and says nothing when nothing was replaced", () => {
    const s = liveSheet();
    s.guard = { ...s.guard, reasons: SUMMARY_FIXED.slice(1) };
    expect(summaryNote(s)).toBe("Written by Claude under checks that let it cite only names and numbers from this run. 2 lines were replaced with fixed wording; see Checks.");
    expect(checksFixLine(s)).toBe("2 of Claude's area and partner lines made a claim the sheet doesn't back, so fixed wording replaced them.");
    // A line replaced at view time carries no reason here, so the line doesn't call it a claim.
    expect(checksFixLine(s, 1)).toBe("3 of Claude's area and partner lines didn't pass the checks, so fixed wording replaced them.");
    s.guard = { ...s.guard, reasons: [] };
    expect(summaryNote(s)).toBe("Written by Claude under checks that let it cite only names and numbers from this run.");
    expect(checksFixLine(s)).toBeNull();
    s.narration = { ...s.narration!, templated: true };
    expect(summaryNote(s)).toBe("Written from a fixed template; no model was called.");
    expect(checksFixLine(s)).toBeNull();
  });

  it("calls a fix a claim the sheet doesn't back only when the reason on record is one", () => {
    const s = liveSheet();
    // A banned word or an alcohol word is a wording or policy rule, not a claim.
    s.guard = { ...s.guard, reasons: ['summary: banned word "amazing"'] };
    expect(checksFixLine(s)).toBe("Claude's draft summary didn't pass the checks, so fixed wording replaced it.");
    s.guard = { ...s.guard, reasons: ["summary: number 1.8 is not in this run"] };
    expect(checksFixLine(s)).toBe("Claude's draft summary made a claim the sheet doesn't back, so fixed wording replaced it.");
    s.guard = { ...s.guard, reasons: ['replaced by the template: partnerLines[10]: "house" instead of the room\'s usual crowd'] };
    expect(checksFixLine(s)).toBe("1 of Claude's area and partner lines didn't pass the checks, so fixed wording replaced it.");
    s.guard = { ...s.guard, reasons: ["replaced by the template: tileWhy[0]: says 16 partners, the sheet has 8 in this area"] };
    expect(checksFixLine(s)).toBe("1 of Claude's area and partner lines made a claim the sheet doesn't back, so fixed wording replaced it.");
  });

  it("says a summary the checks set aside was replaced, never left out (the template always stands in)", () => {
    expect(guardNoteText("summary: number 1.8 is not in this run")).toBe("Claude's summary was replaced with fixed wording: it had a number (1.8) that isn't from this run.");
  });
});

describe("the Fan-Bar Test, once per sheet", () => {
  it("states the test with its scope and numbers in the limits section, in view, linked to the eval page", () => {
    const html = renderView(fixture("g1-a"));
    const line = /<p[^>]*data-testid="fanbar-limit"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
    expect(visibleText(line)).toContain("Whether these picks beat popularity.");
    expect(visibleText(line)).toContain("325 US club-and-city pairs");
    expect(visibleText(line)).toMatch(/25% of pairs, popularity alone for 27%/);
    expect(visibleText(line)).toContain("We don't claim these picks beat popularity.");
    expect(line).toContain(`href="${FANBAR_HREF}"`);
    // In view: before the fold, not inside it.
    const limits = between(html, "limits", "ledger");
    expect(limits.indexOf('data-testid="fanbar-limit"')).toBeLessThan(limits.indexOf("<details"));
  });

  it("matches the numbers in evals/p1/results.md", () => {
    const results = readFileSync(fileURLToPath(new URL("../../../evals/p1/results.md", import.meta.url)), "utf8");
    expect(results).toMatch(/\| Q-signal \(club as signal\) \| 325 \|[^\n]*\| 25\.2% /);
    expect(results).toMatch(/\| Q-pop \(popularity only\) \| 325 \|[^\n]*\| 27\.0% /);
    expect(FANBAR_RESULT).toContain("25% of pairs, popularity alone for 27%");
  });

  it("keeps the sealed plan's banner on the partner table and the full statement only once", () => {
    const html = renderView(fixture("g1-a"));
    const banner = /<p[^>]*data-testid="p1-banner"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
    // docs/preregistration/p1-plan.md §13: a null result means partner cards carry this exact banner.
    expect(PARTNER_RANK_LINE).toBe("Ranked by Qloo affinity; our test did not show this beats popularity.");
    expect(visibleText(banner)).toContain(PARTNER_RANK_LINE);
    expect(banner).toContain(`href="${FANBAR_HREF}"`);
    expect(visibleText(html).split("325 US club-and-city pairs").length - 1).toBe(1);
  });
});

describe("the run's footprint, counted from the ledger", () => {
  const entry = (id: string, kind: LedgerEntry["kind"], endpoint: string, params: LedgerEntry["params"], cacheHit: boolean): LedgerEntry =>
    ({ id, kind, method: "GET", endpoint, params, httpStatus: 200, envelopeStatus: "ok", latencyMs: 1, bytes: 1, cacheHit, resultCount: 1, startedAt: "2026-10-21T00:00:00Z" }) as LedgerEntry;
  const ledger: LedgerEntry[] = [
    entry("T1", "tm", "/discovery/v2/events/x.json", {}, false),
    entry("Q1", "qloo", "/search", { query: "a" }, true),
    entry("Q2", "qloo", "/search", { query: "b" }, false),
    entry("Q3", "qloo", "/v2/insights", { "filter.type": "urn:heatmap" }, false),
    entry("Q4", "qloo", "/v2/insights", { "filter.type": "urn:entity:place" }, true),
    entry("Q5", "qloo", "/v2/insights", { "filter.type": "urn:entity:place" }, false),
    entry("L1", "anthropic", "/api/v1/chat/completions", {}, false),
    entry("A1", "action", "resend.emails.send", {}, false),
  ];

  it("counts requests, kinds, cache hits and the other sources", () => {
    expect(runFootprint(ledger)).toEqual({ qloo: 5, kinds: 3, cached: 2, tm: 1, model: 1 });
    expect(footprintLine(runFootprint(ledger))).toBe(
      "Made with 5 Qloo requests of 3 kinds (2 answered from Walkup's cache of earlier live calls), 1 Ticketmaster request and 1 Claude call. Keys stay on the server.",
    );
  });

  it("words all and none from cache, and says nothing for a run with no Qloo request", () => {
    expect(footprintLine({ qloo: 30, kinds: 9, cached: 30, tm: 2, model: 1 })).toBe(
      "Made with 30 Qloo requests of 9 kinds (all 30 answered from Walkup's cache of earlier live calls), 2 Ticketmaster requests and 1 Claude call. Keys stay on the server.",
    );
    expect(footprintLine({ qloo: 34, kinds: 9, cached: 0, tm: 0, model: 0 })).toBe("Made with 34 Qloo requests of 9 kinds (none answered from cache). Keys stay on the server.");
    expect(footprintLine({ qloo: 0, kinds: 0, cached: 0, tm: 1, model: 0 })).toBeNull();
  });

  it("shows the line near the top of a live sheet, from that sheet's own ledger, and not on a sample sheet", () => {
    const s = liveSheet();
    const html = renderView(s);
    const line = /<p[^>]*data-testid="footprint"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
    expect(visibleText(line).trim()).toBe(footprintLine(runFootprint(s.ledger)));
    expect(html.indexOf('data-testid="footprint"')).toBeLessThan(html.indexOf('id="summary"'));
    expect(renderView(fixture("g1-a"))).not.toContain('data-testid="footprint"');
  });
});

describe("blank inputs and the listed genre", () => {
  it("leaves out a blank seats-left count instead of a placeholder, and labels one the operator typed", () => {
    const s = liveSheet();
    s.operator = { ...s.operator, seatsLeft: null };
    const blank = visibleText(renderView(s));
    expect(blank).not.toMatch(/Seats left|Not entered/);
    expect(renderView(s)).toContain("sm:grid-cols-3");
    s.operator = { ...s.operator, seatsLeft: 412 };
    expect(visibleText(renderView(s))).toContain("Seats left, your number 412");
    s.operator = { ...s.operator, seatsLeft: null, streetTeamDays: [] };
    expect(visibleText(renderView(s))).not.toMatch(/None set|Street-team day/);
  });

  it("names Ticketmaster's genre as Ticketmaster's on a live sheet, whole", () => {
    expect(lastSegment("Music / Hip-Hop/Rap")).toBe("Hip-Hop/Rap");
    expect(lastSegment("Music/Country")).toBe("Country");
    expect(genreLabel("Music / Hip-Hop/Rap", "Bill B")).toBe("Hip-Hop/Rap");
    expect(genreLabel("Music / Country (Americana)", "Bill A")).toBe("Americana");
    const s = liveSheet();
    s.bill = { ...s.bill, classification: "Music / Hip-Hop/Rap" };
    expect(visibleText(renderView(s))).toContain("Listed as Hip-Hop/Rap on Ticketmaster.");
    const sample = structuredClone(fixture("g1-a"));
    expect(visibleText(renderView(sample))).not.toContain("on Ticketmaster.");
  });

  it("says the budget in the budget split is assumed", () => {
    const s = fixture("g1-a");
    if ((s.budgetSplit ?? []).length > 0 && s.operator.mediaBudgetUsd !== null) {
      expect(visibleText(renderView(s))).toMatch(/The \$[\d,]+ is an assumed budget\./);
    }
  });
});

describe("the landing's rooms", () => {
  const sheet = (mode: "live" | "fixture") => ({ mode });
  it("opens on the first room served and shows the next live one second", () => {
    const salt = { a: sheet("live"), b: sheet("live") };
    const anthem = { a: sheet("live"), b: sheet("live") };
    expect(landingRooms([salt, anthem])).toEqual({ hero: salt, second: anthem });
    // A sample server has no Salt Shed sheets: the sample pair is the worked example and there is no second room.
    const samples = { a: sheet("fixture"), b: sheet("fixture") };
    expect(landingRooms([null, samples])).toEqual({ hero: samples, second: null });
    // A second room is never a sample.
    expect(landingRooms([salt, samples])).toEqual({ hero: salt, second: null });
    expect(landingRooms([null, null])).toEqual({ hero: null, second: null });
  });

  it("ships the home page screenshot at the size the page declares", () => {
    const page = readFileSync(fileURLToPath(new URL("../app/page.tsx", import.meta.url)), "utf8");
    const src = /src: "(\/[^"]+\.png)"/.exec(page)?.[1];
    const w = Number(/width: (\d+),/.exec(page)?.[1]);
    const h = Number(/height: (\d+),/.exec(page)?.[1]);
    expect(src).toBeDefined();
    const file = fileURLToPath(new URL(`../public${src}`, import.meta.url));
    expect(existsSync(file)).toBe(true);
    const png = readFileSync(file);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([w, h]);
  });

  it("describes the screenshot's partner rows by the day the street team visits, as the sheet shows them", () => {
    const page = readFileSync(fileURLToPath(new URL("../app/page.tsx", import.meta.url)), "utf8");
    const alt = /alt: "([^"]+)"/.exec(page)?.[1] ?? "";
    expect(alt).toContain("the day the street team visits it and its hours that day");
    expect(alt).not.toContain("hours on the street-team day");
  });
});
