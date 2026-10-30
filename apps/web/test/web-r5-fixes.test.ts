/**
 * Plan page and print view fixes of Oct 29 (round 5 of the re-audit), checked on the four sample sheets and, when the
 * git-ignored deploy/vercel/plans.json is present, on every recorded plan the hosted site serves.
 *
 * - The lift card's heading is the sheet model's (/s and the PDF): on g3, which has no usual crowd, it names no
 *   comparison (numbers-agree-FNA-6, browser-print-final-bp-r4-1).
 * - /s prints only the venue in the map key when there is no lift map (browser-print-final-bp-r4-2).
 * - The sweep: nothing on the plan page, /s or their print layouts names a comparison, a map or a count the sheet
 *   does not have. On g3: no "leans toward" columns and no age table of dashes, no "Usual crowd" column, no "areas to
 *   scale" on a drawing with no areas, no "Areas" link or map title, no "not enough areas" for a map that was never
 *   built, and a "Where buyers live" limit that says there is no lift map.
 * - Round 5's skeptic: the trust hint on g3 points to the reason, not to checks and a method it lacks; the street
 *   map's "didn't load" line points to what the sheet has; the age table and lean columns name the crowd their data
 *   came from (the room's usual acts on a run whose room heatmap failed); a split-half check that couldn't run on a
 *   bill of two or more acts doesn't blame too few acts; g3's popularity limit says it searched near the venue.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LIMITS_EVERY_SHEET, type StreetSheet } from "@walkup/contracts";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  notFound: () => {
    throw new Error("not found");
  },
}));
// The interactive layer loads MapLibre in the browser only; the drawing under it is rendered for real.
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { PlanView } = await import("../components/plan/PlanView");
const { StaticLiftMap, SIMPLIFIED_NOTE, NO_LIFT_NOTE } = await import("../components/StaticLiftMap");
const { default: SheetPage } = await import("../app/s/[id]/page");
const { NO_LIFT_BUYERS_LIMIT, NO_LIFT_PARTNERS, buyersLimit, nearVenueLine, nearVenueOnly, vettedSheet } = await import("../lib/vetted");
const { allTiles, crowdBaseline, crowdName } = await import("../lib/sheet-utils");
const { mapFallbackLine } = await import("../components/LiftMap");
const { NO_LIFT_TRUST, trustSentence } = await import("../components/plan/LiftCard");
const { resetEngineForTests, stores } = await import("../lib/server/engine");
const { resetRunsForTests } = await import("../lib/server/runs");
const { buildSheetModel } = await import("@walkup/exports/sheet-model");
const { LIFT_KEY, liftBaselineWords } = await import("@walkup/exports/format");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const PLANS_FILE = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const PLANS: { planId: string; createdAt: string; sheet: StreetSheet }[] = existsSync(PLANS_FILE) ? JSON.parse(readFileSync(PLANS_FILE, "utf8")) : [];
const PAGES = [...["g1-a", "g1-b", "g2", "g3"].map((id) => ({ id, sheet: fixture(id) })), ...PLANS.map((p) => ({ id: p.planId, sheet: p.sheet }))];
const BUYERS = LIMITS_EVERY_SHEET.find((l) => l.startsWith("Where buyers live:"))!;

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_PLAN_SEED"];
const saved: Record<string, string | undefined> = {};
let dir = "";

beforeAll(async () => {
  for (const k of [...KEYS, "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"]) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "hl-web-r5-"));
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  resetEngineForTests();
  resetRunsForTests();
  for (const p of PLANS) await stores().plans.put({ planId: p.planId, createdAt: p.createdAt, mode: "fixture", status: "complete", request: { planId: p.planId }, sheet: p.sheet });
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

const decode = (s: string) =>
  s
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&");
const flat = (html: string) => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

/** Drops every element whose class list passes `drop`, with all it holds (elements of one tag nest, so they are counted). */
function dropByClass(html: string, drop: (classes: string[]) => boolean): string {
  const open = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bclass="([^"]*)"[^>]*>/g;
  let out = html;
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const m = open.exec(out);
    if (!m) return out;
    if (!drop(m[2]!.split(/\s+/))) {
      from = m.index + m[0].length;
      continue;
    }
    let end = out.length;
    if (!m[0].endsWith("/>")) {
      const tags = new RegExp(`<(/?)${m[1]}\\b[^>]*>`, "g");
      tags.lastIndex = m.index + m[0].length;
      let depth = 1;
      for (let t = tags.exec(out); t; t = tags.exec(out)) {
        if (t[0].endsWith("/>")) continue;
        depth += t[1] ? -1 : 1;
        if (depth === 0) {
          end = t.index + t[0].length;
          break;
        }
      }
    } else end = m.index + m[0].length;
    out = out.slice(0, m.index) + out.slice(end);
    from = m.index;
  }
}
/** What prints, as text: `no-print`, `print:hidden`, sr-only text and a drawing's title and description go. */
const paper = (html: string) =>
  flat(dropByClass(dropByClass(html, (c) => c.includes("no-print") || c.includes("print:hidden")), (c) => c.includes("sr-only")).replace(/<(title|desc)\b[^>]*>[\s\S]*?<\/\1>/g, ""));
/** Everything a person or a screen reader meets: all text, titles and descriptions included. */
const everything = (html: string) => flat(html);

function renderPlan(stored: StreetSheet): string {
  const v = vettedSheet(stored);
  return renderToStaticMarkup(
    createElement(PlanView, {
      payload: { sheet: v.sheet, note: null, source: "store" },
      line: null,
      realShow: false,
      paired: null,
      runtimeLive: false,
      recorded: true,
      canRerun: false,
      revisable: false,
      today: "2026-10-29T12:00:00Z",
      narrationReplaced: v.replaced.length,
    }),
  );
}
const renderS = async (id: string) => renderToStaticMarkup(await SheetPage({ params: Promise.resolve({ id }) }));
const liftHeading = (html: string) => flat(/<section id="lift"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/.exec(html)?.[1] ?? "").trim();
const mapKey = (html: string) => [...(/<ul[^>]*aria-label="Map key"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => flat(m[1]!).trim());
const noBaseline = (s: StreetSheet) => s.cards.liftMap.results.diagnostics.baseline === "none";

/**
 * A sample sheet re-labelled as compared with the genre's fans (no hosted sheet has that baseline). Its age blocks
 * are still the room's usual acts, as on a run whose room heatmap failed (the product eval's C19).
 */
function tagSheet(): StreetSheet {
  const s = structuredClone(fixture("g1-a"));
  s.cards.liftMap.results.diagnostics.baseline = "tag";
  return s;
}
/** The same, with the genre as the room's crowd everywhere: one age block, the genre tag's. */
function genreSheet(): StreetSheet {
  const s = tagSheet();
  const one = s.cards.demographics.results.house[0]!;
  s.cards.demographics.results.house = [{ ...one, entityId: "urn:tag:genre:music:country" }];
  return s;
}
const different = (html: string) => everything(/<section id="different"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "");

describe("the lift card's heading is the sheet model's (numbers-agree-FNA-6, browser-print-final-bp-r4-1)", () => {
  it("names no comparison on g3, which has no usual crowd", () => {
    const g3 = fixture("g3");
    expect(noBaseline(g3)).toBe(true);
    expect(liftHeading(renderPlan(g3))).toBe("Where this crowd stands out");
  });

  it("matches /s and the PDF on every sheet", () => {
    const off: string[] = [];
    for (const { id, sheet } of PAGES) {
      const want = buildSheetModel(vettedSheet(sheet).sheet).panel1.title;
      const got = liftHeading(renderPlan(sheet));
      if (got !== want) off.push(`${id}: plan "${got}", sheet "${want}"`);
    }
    expect(off).toEqual([]);
    expect(liftHeading(renderPlan(tagSheet()))).toBe(buildSheetModel(tagSheet()).panel1.title);
  });
});

describe("the print view's map key (browser-print-final-bp-r4-2)", () => {
  it("has only the venue when there is no lift map", async () => {
    const html = await renderS("g3");
    expect(mapKey(html)).toEqual(["venue"]);
    expect(paper(html)).toContain("No usual crowd to compare with venue");
    for (const k of LIFT_KEY) expect(paper(html)).not.toContain(k.label);
  });

  it("keeps the four lift steps and the venue on a sheet with a lift map", async () => {
    for (const { id } of PAGES.filter((p) => !noBaseline(p.sheet))) {
      expect(mapKey(await renderS(id)), id).toEqual([...LIFT_KEY.map((k) => k.label), "venue"]);
    }
  });
});

describe("nothing names a comparison, a map or a count the sheet doesn't have (sweep)", () => {
  // Each of these names a usual crowd, areas or a lift map; none may appear on a sheet with no lift map.
  const NOT_ON_G3: [string, RegExp][] = [
    ["a comparison in the lift heading", /Where this crowd stands out, compared with/],
    ["lean columns", /leans? toward/],
    ["the usual crowd's age column", /Age mix, this bill and|Usual crowd \d|This bill Usual crowd/],
    ["an age table with no ages", /Above 0 means the age group/],
    ["too few areas", /not enough areas to check/],
    ["areas drawn to scale", /areas to scale/],
    ["the lift map's title", /Areas around .* by lift|Areas where this crowd stands out, around/],
    ["the stored buyers line", /the areas show where this bill's fans stand out/],
    ["the lift key", /1\.3 to 2\.2x|2\.2x and up/],
    // Round 5 skeptic: the trust hint promised checks and a method g3's trust table doesn't have (sweep-g3-trust-hint).
    ["checks g3 doesn't have", /has the checks in full/],
    // The popularity check searched near the venue: g3 has no areas.
    ["a search in each area", /search in each area without the bill/],
    // No area could stand out with no map to stand out on.
    ["an area that didn't stand out", /No area stood out/],
    // The summary said the same never-run comparison (sweep-g3-summary-no-area).
    ["an area that doesn't stand out", /No area stands out/],
  ];

  it("on g3's plan page and its print view, on screen and on paper", async () => {
    const found: string[] = [];
    for (const [where, html] of [
      ["plan", renderPlan(fixture("g3"))],
      ["/s", await renderS("g3")],
    ] as const) {
      for (const [view, text] of [
        ["all", everything(html)],
        ["paper", paper(html)],
      ] as const) {
        for (const [what, re] of NOT_ON_G3) {
          const m = re.exec(text);
          if (m) found.push(`${where} ${view}: ${what}: …${text.slice(Math.max(0, m.index - 50), m.index + 60)}…`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("says what g3 has instead", async () => {
    const plan = renderPlan(fixture("g3"));
    expect(paper(plan)).toContain(`${NO_LIFT_NOTE}`);
    expect(paper(plan)).toContain(NO_LIFT_BUYERS_LIMIT);
    expect(paper(plan)).toContain("No lift map, so nothing to check");
    expect(paper(plan)).toMatch(/Age mix Nothing found No age or gender blocks came back\./);
    // The trust hint points to the reason, on screen and on paper (sweep-g3-trust-hint).
    expect(everything(plan)).toContain(`${NO_LIFT_TRUST} More about this crowd says why there is no lift map.`);
    expect(paper(plan)).toContain(`${NO_LIFT_TRUST} More about this crowd says why there is no lift map.`);
    // A run with a baseline whose map came back empty: that section says what the map was compared with, not why.
    const empty = structuredClone(fixture("g1-a"));
    empty.cards.liftMap.results.tiles = [];
    delete empty.cards.liftMap.results.liftDiagnostics;
    const emptyText = everything(renderPlan(empty));
    expect(emptyText).toContain(`${NO_LIFT_TRUST} More about this crowd says what the map was compared with.`);
    expect(emptyText).toContain("Compared with The room's own upcoming shows");
    // The summary says there is no lift map, as the partner card does (sweep-g3-summary-no-area).
    expect(vettedSheet(fixture("g3")).sheet.narration!.summary).toContain(NO_LIFT_PARTNERS);
    expect(paper(plan)).toContain("The popularity check runs the same Qloo search near the venue without the bill as the signal");
    expect(paper(plan)).toContain(`Why: ${NO_LIFT_PARTNERS} Found 6 partners`);
    expect(everything(plan)).toContain("On this sheet: Map · Partners");
    expect(everything(plan)).toContain("The area around Super Funny Comedy Club");
    const s = await renderS("g3");
    expect(paper(s)).toContain(NO_LIFT_BUYERS_LIMIT);
    expect(paper(s)).toContain(`Partial: ${NO_LIFT_PARTNERS} Found 6 partners`);
    expect(everything(s)).toContain("The area around Super Funny Comedy Club");
    // The PDF prints the same limits as /s: both read the sheet model of the checked sheet.
    expect(buildSheetModel(vettedSheet(fixture("g3")).sheet).footer.limits).toContain(NO_LIFT_BUYERS_LIMIT);
  });

  it("leaves every sheet with a lift map as it was", async () => {
    for (const { id, sheet } of PAGES.filter((p) => !noBaseline(p.sheet))) {
      const plan = renderPlan(sheet);
      const text = everything(plan);
      expect(text, id).toContain("More about this crowd has the checks in full and the method.");
      expect(text, id).toContain("The popularity check runs the same Qloo search in each area without the bill");
      expect(text, id).toContain("On this sheet: Areas · Partners");
      expect(text, id).toContain("This bill leans toward");
      expect(text, id).toContain("The room's usual crowd leans toward");
      expect(text, id).toContain("Age mix, this bill and the usual crowd");
      expect(text, id).toContain("Above 0 means the age group");
      expect(text, id).toMatch(/Areas around .* by lift/);
      expect(text, id).not.toContain(NO_LIFT_NOTE);
      expect(paper(plan), id).toContain(BUYERS);
      expect(paper(plan), id).not.toContain(NO_LIFT_BUYERS_LIMIT);
      expect(paper(await renderS(id)), id).toContain(BUYERS);
    }
  });

  it("words the buyers limit for the map the sheet has", () => {
    const a = fixture("g1-a");
    expect(buyersLimit(BUYERS, a)).toBe(BUYERS);
    expect(buyersLimit(BUYERS, fixture("g3"))).toBe(NO_LIFT_BUYERS_LIMIT);
    expect(buyersLimit("Thin signal: treat as a starting list.", fixture("g3"))).toBe("Thin signal: treat as a starting list.");
    // No areas at all, whatever the baseline: no lift map either.
    const empty = structuredClone(a);
    empty.cards.liftMap.results.tiles = [];
    expect(buyersLimit(BUYERS, empty)).toBe(NO_LIFT_BUYERS_LIMIT);
    // A genre baseline names the genre's fans, as the lift card does.
    const tag = tagSheet();
    expect(buyersLimit(BUYERS, tag)).toBe(`Where buyers live: the areas show where this bill's fans stand out from ${liftBaselineWords(tag)}.`);
    expect(liftBaselineWords(tag)).toBe("country fans in general");
    // A run now stores the line said of its own map (g3 has no lift map).
    expect(fixture("g3").limits).toContain(NO_LIFT_BUYERS_LIMIT);
  });

  it("labels the age table and the lean columns by the crowd they came from, not by the map's baseline", () => {
    // tagSheet() has the shape of the product eval's C19: the room's heatmap failed, so the genre stood in for the map
    // only; the age blocks and the comparison still came from the room's usual acts.
    const c19 = different(renderPlan(tagSheet()));
    expect(c19).toContain("Age mix, this bill and the usual crowd");
    expect(c19).toContain("Age This bill Usual crowd");
    expect(c19).toContain("averaged across the bill's acts and the room's usual acts");
    expect(c19).toContain("The room's usual crowd leans toward");
    expect(c19).not.toMatch(/Country fans in general lean|and country fans in general/);
    // The trust table gives the real reason the genre stood in.
    expect(c19).toContain("Country fans in general: the room's own crowd couldn't be mapped");
    // With no age block, the map's own reason tells the two cases apart.
    const noBlocks = tagSheet();
    noBlocks.cards.demographics.results.house = [];
    noBlocks.cards.liftMap.reason = "The room's own crowd couldn't be mapped (house heat failed (HTTP 500)), so the map compares this bill with country fans in general.";
    expect(crowdBaseline(noBlocks)).toBe("house");
    noBlocks.cards.liftMap.reason = "Only 3 of the room's headliners matched Qloo (5 needed), so the map compares this bill with country fans in general.";
    expect(crowdBaseline(noBlocks)).toBe("tag");
    expect(crowdBaseline(fixture("g1-a"))).toBe("house");
    expect(crowdBaseline(fixture("g3"))).toBe("none");
  });

  it("names the genre's fans where the age block is the genre's", () => {
    // Too few headliners matched: the genre tag is the room's crowd for every card, and its one age block says so.
    const html = different(renderPlan(genreSheet()));
    expect(crowdName(genreSheet())).toBe("country fans in general");
    expect(html).toContain("Age mix, this bill and country fans in general");
    expect(html).toContain("Age This bill Country fans in general");
    expect(html).toContain("averaged across the bill's acts and country fans in general");
    expect(html).toContain("Country fans in general lean toward");
    expect(html).toContain("Country fans in general: too few of the room's headliners matched Qloo");
    expect(html).not.toContain("Usual crowd");
  });

  it("says the genre's fans rank an area, in the lift card's hint", () => {
    const html = everything(renderPlan(genreSheet()));
    expect(html).toContain("where country fans in general rank it;");
    expect(everything(renderPlan(fixture("g1-a")))).toContain("where the room's usual crowd ranks it;");
  });

  it("points the street map's 'didn't load' line at what the sheet has (sweep-g3-map-fallback)", () => {
    const why = "This browser can't draw the street map.";
    expect(mapFallbackLine(why, { noLift: true, numbered: false })).toBe(`The street map didn't load. ${why} The drawing shows the venue.`);
    expect(mapFallbackLine(why, { numbered: true })).toBe(`The street map didn't load. ${why} The list has the same areas.`);
    // A lift map with no numbered area has no list to point to.
    expect(mapFallbackLine(why, { numbered: false })).toBe(`The street map didn't load. ${why} The drawing has the same areas.`);
    expect(mapFallbackLine("", { noLift: true, numbered: false })).toBe("The street map didn't load. The drawing shows the venue.");
  });

  it("says a split-half check that didn't run on a bill with two acts couldn't run, not that there were too few acts", () => {
    // One act: the run's note under the sentence says why there was no check, so the sentence doesn't say it again.
    expect(trustSentence(null, false, true)).toBe("The map isn't just where people go anyway.");
    expect(trustSentence(null, true, true)).toBe("The map mostly follows where people go anyway.");
    expect(trustSentence(null, false, false)).toBe("The map couldn't be checked by splitting the bill in two this time; it isn't just where people go anyway.");
    expect(trustSentence(null, false)).toBe(trustSentence(null, false, false));
    // Every hosted sheet has one act: the table names that, and says what the check does rather than that it ran.
    for (const { id, sheet } of PAGES.filter((p) => p.sheet.cards.liftMap.results.liftDiagnostics?.splitHalfSpearman === null)) {
      const html = different(renderPlan(sheet));
      expect(html, id).toContain("Split-half agreement Too few acts to split in two The check splits the bill in two and maps each half apart.");
      expect(html, id).not.toContain("The bill split in two halves and mapped apart");
      // The lift card says the one-act reason once, in the run's note (browser-print-bp-r5-2).
      const card = everything(/<section id="lift"[\s\S]*?<\/section>/.exec(renderPlan(sheet))?.[0] ?? "");
      expect(card, id).toContain("This bill has one act, so there was no second half to check the map against.");
      expect(card, id).not.toMatch(/Too few acts to check the map|couldn't be checked by splitting/);
    }
    const failed = structuredClone(fixture("g1-a"));
    failed.cards.liftMap.results.liftDiagnostics!.splitHalfSpearman = null;
    failed.cards.liftMap.results.liftDiagnostics!.note = "A split-half heatmap failed (HTTP 500), so the map could not be checked.";
    const html = everything(renderPlan(failed));
    expect(html).toContain("The map couldn't be checked by splitting the bill in two this time");
    // The check ran but gave no number: "no result", not "couldn't run".
    expect(html).toContain("Split-half agreement No result this time");
    expect(html).not.toContain("Too few acts");
  });

  it("says the popularity check searched near the venue when no partner came from an area", () => {
    const line = "The popularity check runs the same Qloo search in each area without the bill as the signal, which returns places in popularity order.";
    expect(nearVenueLine(line)).toBe("The popularity check runs the same Qloo search near the venue without the bill as the signal, which returns places in popularity order.");
    expect(nearVenueLine("Call before you go.")).toBe("Call before you go.");
    expect(nearVenueOnly(fixture("g3"))).toBe(true);
    for (const { id, sheet } of PAGES.filter((p) => !noBaseline(p.sheet))) expect(nearVenueOnly(sheet), id).toBe(false);
    // g3's popularity step, as the plan page shows it; a run now stores the same words (the view-time rewrite is for
    // sheets stored before Oct 30 2026).
    const step = (s: StreetSheet) => s.steps?.find((x) => x.id === "partners-popular")?.cause ?? "";
    expect(step(vettedSheet(fixture("g3")).sheet)).toBe(
      "The same search near the venue without the bill as the signal returns places in popularity order; the list is cut to as many places as there are partners. It says nothing about ticket sales.",
    );
    expect(step(fixture("g3"))).toBe(step(vettedSheet(fixture("g3")).sheet));
    const older = structuredClone(fixture("g3"));
    older.steps = older.steps!.map((x) => (x.id === "partners-popular" ? { ...x, cause: x.cause!.replace("The same search near the venue without the bill as the signal returns places in popularity order; the list is cut to as many places as there are partners.", "The same search in each area without the bill as the signal returns places in popularity order; each area's list is cut to as many places as it has partners.") } : x));
    expect(step(older)).toMatch(/^The same search in each area/);
    expect(step(vettedSheet(older).sheet)).toBe(step(fixture("g3")));
  });

  it("draws the note that fits: areas to scale, or the venue only", () => {
    const a = fixture("g1-a");
    const venue = { lat: a.bill.venue.lat, lon: a.bill.venue.lon, name: a.bill.venue.name };
    const props = { tiles: allTiles(a), venue, ranked: [], idBase: "t", title: "t" };
    expect(renderToStaticMarkup(createElement(StaticLiftMap, props))).toContain(SIMPLIFIED_NOTE);
    const none = renderToStaticMarkup(createElement(StaticLiftMap, { ...props, noLift: true }));
    expect(none).toContain(NO_LIFT_NOTE);
    expect(none).not.toContain(SIMPLIFIED_NOTE);
    // While the street map loads, paper gets the no-lift note too.
    const loading = renderToStaticMarkup(createElement(StaticLiftMap, { ...props, noLift: true, note: "Simplified drawing while the street map loads." }));
    expect(paper(loading)).toContain(NO_LIFT_NOTE);
    expect(loading).not.toContain(SIMPLIFIED_NOTE);
  });
});
