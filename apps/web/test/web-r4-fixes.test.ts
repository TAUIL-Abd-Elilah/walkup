/**
 * Plan page and print view fixes of Oct 29 (round 4 of the re-audit), checked on the four sample sheets and, when the
 * git-ignored deploy/vercel/plans.json is present, on every recorded plan the hosted site serves.
 *
 * - "The test" link after the partner-table banner and after the Fan-Bar limit stays off paper; the banner prints
 *   exactly PARTNER_RANK_LINE (browser-print-final-bp-1).
 * - A heading or a table's header row never ends a printed page alone, and the plan page leaves no padding to start a
 *   blank last page (browser-print-final-bp-2).
 * - The drawing of a bill with no lift map says "No lift map for this bill.", not that no area reached 1.3
 *   (text-integrity-g3-map-panel-says-no-lift-map-three-times, web part).
 * - The sweep: nothing on the printed plan page is a link or control with nothing to follow on paper. "How the top
 *   pick is chosen", the "Revised:" links, a change group's "N more", the street map's loading note and its
 *   "didn't load" line stay off paper; a partner's "Website" prints as where the website is, with the page's path
 *   on a shared site such as facebook.com (sweep-partner-website-host).
 * - A section's heading row (the h2 and its status word) never splits across printed pages (browser-print-final-bp-2,
 *   57cd1eda A4).
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SheetRevision, StreetSheet } from "@walkup/contracts";

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
const { NoDiscoveryNote, RevisionNote } = await import("../components/plan/SheetExtras");
const { ReceiptContext } = await import("../components/plan/receipts");
const { StaticLiftMap, SIMPLIFIED_NOTE, NO_LIFT_DESC } = await import("../components/StaticLiftMap");
const { LiftMap } = await import("../components/LiftMap");
const { default: SheetPage } = await import("../app/s/[id]/page");
const { FANBAR_NO_CLAIM, PARTNER_RANK_LINE } = await import("../lib/labels");
const { SHARED_HOSTS, webHost } = await import("../lib/format");
const { LISTING_HOSTS } = await import("@walkup/engine");
const { allTiles, topTiles } = await import("../lib/sheet-utils");
const { vettedSheet } = await import("../lib/vetted");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const PLANS_FILE = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const PLANS: { planId: string; sheet: StreetSheet }[] = existsSync(PLANS_FILE) ? JSON.parse(readFileSync(PLANS_FILE, "utf8")) : [];
const PAGES = [...["g1-a", "g1-b", "g2", "g3"].map((id) => ({ id, sheet: fixture(id) })), ...PLANS.map((p) => ({ id: p.planId, sheet: p.sheet }))];
const CSS = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");

const decode = (s: string) =>
  s
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&");
const flat = (html: string) => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, ""));

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
/** The markup that prints: `no-print`, `print:hidden` and a fold's Show/Hide line (print CSS) go; `hidden print:inline` stays. */
const paperHtml = (html: string) =>
  dropByClass(html, (c) => c.includes("no-print") || c.includes("print:hidden")).replace(/(<details[^>]*class="[^"]*\bfold\b[^"]*"[^>]*>)<summary>[\s\S]*?<\/summary>/g, "$1");
/** What prints, as text. The sr-only text and a drawing's title and description are never seen. */
const paper = (html: string) => flat(dropByClass(paperHtml(html), (c) => c.includes("sr-only")).replace(/<(title|desc)\b[^>]*>[\s\S]*?<\/\1>/g, ""));
/** What the screen shows: `hidden` goes (it is shown on paper only). */
const screen = (html: string) => flat(dropByClass(html, (c) => c.includes("hidden") || c.includes("sr-only")));

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
const inner = (html: string, testId: string) => new RegExp(`<p[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</p>`).exec(html)?.[1] ?? "";

describe('"The test" stays off paper (browser-print-final-bp-1)', () => {
  const html = renderPlan(fixture("g1-a"));

  it("prints the banner as exactly the sealed line, and keeps the link on screen", () => {
    const banner = inner(html, "p1-banner");
    expect(paper(banner)).toBe(PARTNER_RANK_LINE);
    expect(PARTNER_RANK_LINE).toBe("Ranked by Qloo affinity; our test did not show this beats popularity.");
    expect(screen(banner)).toBe(`${PARTNER_RANK_LINE} The test`);
    expect(banner).toMatch(/<span class="no-print"> <a href="\/eval#fanbar-title" class="link">The test<\/a><\/span>/);
  });

  it("ends the printed Fan-Bar limit at its last sentence", () => {
    const limit = inner(html, "fanbar-limit");
    expect(paper(limit).endsWith(FANBAR_NO_CLAIM)).toBe(true);
    expect(screen(limit).endsWith(`${FANBAR_NO_CLAIM} The test`)).toBe(true);
  });
});

describe("headings stay with what follows on paper (browser-print-final-bp-2)", () => {
  const print = (() => {
    const start = CSS.indexOf("@media print {");
    let depth = 0;
    for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
      if (CSS[i] === "{") depth++;
      else if (CSS[i] === "}" && --depth === 0) return CSS.slice(start, i);
    }
    return "";
  })();
  const rule = (selector: string) => {
    for (const m of print.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1]!.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim() === selector) return m[2]!;
    }
    return "";
  };

  it("keeps a heading, a section's heading row and a summary with the next line", () => {
    expect(rule("h2, h3, .section > :first-child, summary")).toMatch(/break-after:\s*avoid/);
  });

  it("keeps a section's source line with what follows, so a heading and its source line never end a page alone (browser-print-bp-r5-1)", () => {
    expect(rule('[data-testid="source-line"]')).toMatch(/break-after:\s*avoid/);
    // The rule's selector is the attribute PlanCard prints on the line, right under the heading row.
    const html = renderPlan(fixture("g1-a"));
    expect(html).toMatch(/<section id="lift"[^>]*><div class="print-avoid-break [^"]*">(?:(?!<\/div>)[\s\S])*<\/div><p [^>]*data-testid="source-line"/);
  });

  it("keeps a section's heading row in one piece, so a wrapped heading never ends a page without its status word", () => {
    // 57cd1eda A4: the lift card's long heading wrapped its row onto three lines and the page broke inside the row.
    expect(rule(".print-avoid-break, li, tr")).toMatch(/break-inside:\s*avoid/);
    const html = renderPlan(fixture("g1-a"));
    const rows = [...html.matchAll(/<section id="([^"]+)"[^>]*class="section[^"]*"[^>]*>(<div[^>]*>)/g)];
    expect(rows.map((m) => m[1])).toEqual(expect.arrayContaining(["lift", "partners", "resolution"]));
    for (const [, id, div] of rows) expect(div, id).toMatch(/^<div class="print-avoid-break flex flex-wrap /);
  });

  it("keeps a table's header row with its first row (Chrome ignores break-after on thead)", () => {
    expect(rule("tbody > tr:first-child")).toMatch(/break-before:\s*avoid/);
  });

  it("leaves no padding after the last request to start a blank page", () => {
    expect(rule("#ledger, .wrap-wide:has(> #ledger)")).toMatch(/padding-bottom:\s*0/);
    // The requests section is the last thing in the plan page's column, which the second selector relies on.
    const html = renderPlan(fixture("g2"));
    expect(html).toMatch(/<div class="wrap-wide[^"]*">/);
    expect(html).toMatch(/<section id="ledger"[^>]*>(?:(?!<\/section>)[\s\S])*<\/section><\/div>/);
  });
});

describe("the drawing of a bill with no lift map (text-integrity-g3-map-panel-says-no-lift-map-three-times)", () => {
  const g3 = fixture("g3");
  const venue = { lat: g3.bill.venue.lat, lon: g3.bill.venue.lon, name: g3.bill.venue.name };

  it("says there is no lift map, not that no area reached 1.3", () => {
    expect(g3.cards.liftMap.results.diagnostics.baseline).toBe("none");
    const html = renderToStaticMarkup(createElement(StaticLiftMap, { tiles: allTiles(g3), venue, ranked: [], idBase: "t", title: "t" }));
    expect(html).toContain(NO_LIFT_DESC);
    expect(NO_LIFT_DESC).toBe("No lift map for this bill.");
    expect(html).not.toContain("No area reached a lift of 1.3");
  });

  it("keeps the 1.3 line for a map with areas but none numbered", () => {
    const a = fixture("g1-a");
    const html = renderToStaticMarkup(
      createElement(StaticLiftMap, { tiles: allTiles(a), venue: { lat: a.bill.venue.lat, lon: a.bill.venue.lon, name: a.bill.venue.name }, ranked: [], idBase: "t", title: "t" }),
    );
    expect(html).toContain("No area reached a lift of 1.3.");
    expect(renderToStaticMarkup(createElement(StaticLiftMap, { tiles: allTiles(a), venue, ranked: [], idBase: "t", title: "t", noLift: true }))).toContain(NO_LIFT_DESC);
  });

  it("says it on the plan page's map, the print view and the landing drawing", async () => {
    const plan = renderPlan(g3);
    expect(plan).toContain(NO_LIFT_DESC);
    expect(plan).not.toContain("No area reached a lift of 1.3");
    const s = renderToStaticMarkup(await SheetPage({ params: Promise.resolve({ id: "g3" }) }));
    expect(s).toContain(NO_LIFT_DESC);
    expect(s).not.toContain("No area reached a lift of 1.3");
    // The status line already gives the reason, so the print view adds no empty baseline line under the panel.
    expect(s).not.toMatch(/<p class="[^"]*">\s*<\/p>/);
  });
});

describe("the street map's notes are for the screen", () => {
  const a = fixture("g1-a");
  const venue = { lat: a.bill.venue.lat, lon: a.bill.venue.lon, name: a.bill.venue.name };
  const props = { tiles: allTiles(a), venue, ranked: topTiles(a).map((t) => t.geohash), idBase: "t", title: "t" };

  it("prints the drawing's own note while the street map loads", () => {
    const html = renderToStaticMarkup(createElement(StaticLiftMap, { ...props, note: "Simplified drawing while the street map loads." }));
    expect(screen(html)).toContain("Simplified drawing while the street map loads.");
    expect(screen(html)).not.toContain(SIMPLIFIED_NOTE);
    expect(paper(html)).toContain(SIMPLIFIED_NOTE);
    expect(paper(html)).not.toContain("while the street map loads");
    // The usual note is drawn once.
    expect(renderToStaticMarkup(createElement(StaticLiftMap, props)).split(SIMPLIFIED_NOTE).length - 1).toBe(2); // the note and the description
  });

  it("starts the plan page's drawing with the loading note, printed as the drawing's own", () => {
    const html = renderToStaticMarkup(createElement(LiftMap, props));
    expect(paper(html)).toContain(SIMPLIFIED_NOTE);
    expect(paper(html)).not.toContain("while the street map loads");
  });
});

describe("nothing on the printed plan page points at what paper can't follow (sweep)", () => {
  const SCREEN_ONLY: [string, RegExp][] = [
    ["The test link", /The test\s*$|The test(?= )/m],
    ["How the top pick is chosen", /How the top pick is chosen/],
    ["a bare Website", /\bWebsite\b/],
    ["the Revised: links", /Revised: /],
    ["the earlier plan", /Open the earlier plan/],
    ["a download", /Download|to keep the full ledger/],
    ["select or open", /Select an area|Open “Why this place”|gives the reason|change a capacity/],
    ["the street map", /street map (?:loads|didn)/],
  ];

  it("on every sheet", () => {
    const found: string[] = [];
    for (const { id, sheet } of PAGES) {
      const html = renderPlan(sheet);
      const text = paper(html);
      for (const [what, re] of SCREEN_ONLY) {
        const m = re.exec(text);
        if (m) found.push(`${id}: ${what}: …${text.slice(Math.max(0, m.index - 60), m.index + 40)}…`);
      }
      // A disclosure's own label prints only where it names a section ("More about this crowd"), never "N more".
      for (const s of paperHtml(html).matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)) {
        const label = flat(s[1]!).trim();
        if (/^\d+ more$|^Show|^Hide/.test(label)) found.push(`${id}: summary "${label}"`);
      }
    }
    expect(found).toEqual([]);
  });

  it("prints the end of a sheet with no top pick at the reason", () => {
    const sheet = fixture("g1-a");
    const html = renderToStaticMarkup(createElement(NoDiscoveryNote, { sheet }));
    expect(screen(html)).toMatch(/How the top pick is chosen\.$/);
    expect(paper(html)).not.toContain("How the top pick");
    expect(paper(html).trim()).toMatch(/[.)]$/);
  });

  it("prints a change group's rest as part of the list", () => {
    const sheet = fixture("g1-a");
    const changes = Array.from({ length: 8 }, (_, i) => ({ kind: "partner_removed", label: `Place ${i + 1}`, ledgerRefs: [] }));
    const revision = { parentPlanId: "g1-b", instruction: "No bars", interpreter: "rules", toolCalls: [], changes } as unknown as SheetRevision;
    const html = renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries: sheet.ledger, open: () => undefined } }, createElement(RevisionNote, { revision })));
    expect(screen(html)).toContain("3 more");
    expect(paper(html)).not.toContain("3 more");
    for (let i = 1; i <= 8; i++) expect(paper(html)).toContain(`Place ${i}`);
  });

  it("prints where a partner's website is, in place of the word Website", () => {
    expect(webHost("https://www.example.com/menu?x=1")).toBe("example.com");
    expect(webHost("http://locations.cafe.com/")).toBe("locations.cafe.com");
    expect(webHost("not a url/path")).toBe("not a url");
    // A page on a shared site keeps its path: the host alone doesn't say which place (sweep-partner-website-host).
    expect(webHost("https://www.facebook.com/cafeaddis")).toBe("facebook.com/cafeaddis");
    expect(webHost("https://www.facebook.com/Olivers-Old-Towne-Tavern-1484808415120950/")).toBe("facebook.com/Olivers-Old-Towne-Tavern-1484808415120950");
    expect(webHost("https://www.grubhub.com/restaurant/taqueria-la-fogata-3930-w-montrose-ave-chicago/313993?utm=x")).toBe(
      "grubhub.com/restaurant/taqueria-la-fogata-3930-w-montrose-ave-chicago/313993",
    );
    expect(webHost("https://www.facebook.com/")).toBe("facebook.com");
    // A chain's store page names the chain, which is enough on paper.
    expect(webHost("https://www.starbucks.com/store-locator/store/14943/")).toBe("starbucks.com");
    // Every listing site the engine keeps a page on, subdomains included, prints with its path (or Google's place parameter).
    expect(webHost("https://order.toasttab.com/online/the-hideout-chicago")).toBe("order.toasttab.com/online/the-hideout-chicago");
    expect(webHost("https://g.page/the-hideout-chicago")).toBe("g.page/the-hideout-chicago");
    expect(webHost("https://goo.gl/maps/abc123")).toBe("goo.gl/maps/abc123");
    expect(webHost("https://resy.com/cities/chi/venues/the-hideout")).toBe("resy.com/cities/chi/venues/the-hideout");
    expect(webHost("https://business.facebook.com/thehideout/")).toBe("business.facebook.com/thehideout");
    expect(webHost("https://m.facebook.com/cafeaddis")).toBe("m.facebook.com/cafeaddis");
    expect(webHost("https://fb.com/thehideout")).toBe("fb.com/thehideout");
    expect(webHost("https://www.google.com/maps?cid=123&hl=en")).toBe("google.com/maps?cid=123");
    expect(webHost("https://maps.google.com/?q=The+Hideout")).toBe("maps.google.com?q=The Hideout");
    expect(webHost("https://www.yelp.com/biz/the-hideout-chicago?q=bar")).toBe("yelp.com/biz/the-hideout-chicago");
    expect([...SHARED_HOSTS].sort()).toEqual([...LISTING_HOSTS].sort());
    // The sample's own sites are .example, which print as plain text (no Website link), so it gets a real-looking one.
    const sample = structuredClone(fixture("g1-a"));
    sample.cards.partners.results[0]!.website = "https://www.cafeaddis.com/menu";
    const recorded = PLANS.find((p) => p.sheet.cards.partners.results.some((x) => x.website))?.sheet;
    for (const sheet of recorded ? [recorded, sample] : [sample]) {
      const p = sheet.cards.partners.results.find((x) => x.website)!;
      const html = renderPlan(sheet);
      expect(screen(html)).toContain("Website");
      expect(paper(html)).toContain(webHost(p.website!));
    }
  });

  it("prints a page on a shared site with its path, which wraps after a slash", () => {
    const sheet = structuredClone(fixture("g1-a"));
    sheet.cards.partners.results[0]!.website = "https://www.facebook.com/pages/category/Lebanese-Restaurant/Cedars-of-Lebanon-377627589048046/";
    const html = renderPlan(sheet);
    expect(paper(html)).toContain("facebook.com/pages/category/Lebanese-Restaurant/Cedars-of-Lebanon-377627589048046");
    expect(screen(html)).not.toContain("facebook.com/pages");
    expect(html).toContain("facebook.com/<wbr/>pages/<wbr/>category/<wbr/>Lebanese-Restaurant/<wbr/>Cedars-of-Lebanon-377627589048046");
  });
});
