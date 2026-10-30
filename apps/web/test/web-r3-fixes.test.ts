/**
 * Plan page and print view fixes of Oct 29 (round 3 of the re-audit), checked on the four sample sheets and, when the
 * git-ignored deploy/vercel/plans.json is present, on every recorded plan the hosted site serves.
 *
 * - A partner line already in 12-hour time keeps its am or pm: "9:30 pm" never reads "9:30 am pm", and a line with a
 *   range that shares one suffix ("4:30 to 8 pm") or seconds ("9:30:00 pm") is left whole
 *   (outputs-humanTimes-double-meridiem).
 * - An area whose line the checks left out gets the percentile line the print view and the PDF print
 *   (outputs-18aa3a6e-area1-line-missing-on-plan-page); a partner with no phone, and a spot the usual crowd's list
 *   left out, say so, as on paper.
 * - The print view's table caption no longer calls the Notes column blank (outputs-s-notes-caption-says-blank).
 * - "Open the earlier plan." and "Download sheet.json to keep the full ledger." stay off paper (browser-print-final-bp-1).
 * - An unknown /s id is titled "Sheet not found" (browser-print-final-bp-2).
 * - The sweep: no view-time rewrite doubles or breaks a word on the plan page, the print view or the PDF's text, and
 *   every area, partner and spot the print view and the PDF give a line or value has one on the plan page. A tag name
 *   inside a sentence keeps a proper adjective's capital ("Mexican", as the partner line beside it writes it), and a
 *   check note that repeats is counted in one sentence, never "... ("coffee"). (9 times)".
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SheetRevision, StreetSheet } from "@walkup/contracts";
import { isUnreachableWebsite } from "../lib/format";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
  notFound: () => {
    throw new Error("not found");
  },
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
// The map loads MapLibre in the browser only; the numbered list (TileList) is rendered for real.
vi.mock("../components/LiftMap", () => ({
  LiftMap: () => createElement("figure", { "data-testid": "map" }),
  MapCaption: () => null,
  squareSizeLine: () => "Each square is about 1.0 km by 0.6 km.",
}));
vi.mock("../components/LiftLegend", () => ({ LiftLegend: () => null }));

const { PlanView, checkNotes } = await import("../components/plan/PlanView");
const { PartnersCard, PartnerWhy, fixedPartnerLine } = await import("../components/plan/PartnersCard");
const { LedgerSection } = await import("../components/plan/LedgerSection");
const { DifferentCard, PrePostCard } = await import("../components/plan/MoreCards");
const { RevisionNote } = await import("../components/plan/SheetExtras");
const { ReceiptContext } = await import("../components/plan/receipts");
const { default: SheetPage } = await import("../app/s/[id]/page");
const { default: SheetNotFound, metadata: notFoundMetadata } = await import("../app/s/[id]/not-found");
const { resetEngineForTests, stores } = await import("../lib/server/engine");
const { resetRunsForTests } = await import("../lib/server/runs");
const { humanTimes, tagInSentence, tileWhy, topTiles } = await import("../lib/sheet-utils");
const { vettedSheet } = await import("../lib/vetted");
const { buildSheetModel, sheetModelText, tileFallbackLine, tileWhyLine } = await import("@walkup/exports/sheet-model");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const PLANS_FILE = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const HAVE_PLANS = existsSync(PLANS_FILE);
const PLANS: { planId: string; createdAt: string; sheet: StreetSheet }[] = HAVE_PLANS ? JSON.parse(readFileSync(PLANS_FILE, "utf8")) : [];
const PAGES = [
  ...["g1-a", "g1-b", "g2", "g3"].map((id) => ({ id, sheet: fixture(id), createdAt: "" })),
  ...PLANS.map((p) => ({ id: p.planId, sheet: p.sheet, createdAt: p.createdAt })),
];
const plan = (prefix: string) => PLANS.find((p) => p.planId.startsWith(prefix));

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_PLAN_SEED"];
const saved: Record<string, string | undefined> = {};
let dir = "";

beforeAll(async () => {
  for (const k of [...KEYS, "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"]) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "hl-web-r3-"));
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
/** Each text node on its own, as the reader sees it before the browser joins them. */
const textNodes = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
    .split(/<[^>]+>/)
    .map(decode)
    .filter((t) => t.trim() !== "");
/** The text with the tags dropped and nothing put in their place. */
const flat = (html: string) => decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, ""));

function renderPlan(stored: StreetSheet): { html: string; shown: StreetSheet } {
  const v = vettedSheet(stored);
  const html = renderToStaticMarkup(
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
  return { html, shown: v.sheet };
}

const withReceipts = (sheet: StreetSheet, el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries: sheet.ledger, open: () => undefined } }, el));

/** Every clock time in a line, as minutes after midnight, read as 12-hour time when it says am or pm, else 24-hour. */
function clockTimes(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(/\b(\d{1,2})(?::(\d\d))?(?::\d\d)?(?:\s*([AaPp])\.?[Mm]\b)?|\b(noon|midnight)\b/gi)) {
    if (m[4]) out.push(m[4].toLowerCase() === "noon" ? 720 : 0);
    else if (m[3]) out.push(((Number(m[1]) % 12) + (m[3].toLowerCase() === "p" ? 12 : 0)) * 60 + Number(m[2] ?? 0));
    else if (m[2] !== undefined) out.push((Number(m[1]) % 24) * 60 + Number(m[2]));
  }
  return out;
}

describe("partner lines keep their own am and pm (outputs-humanTimes-double-meridiem)", () => {
  it("leaves 12-hour times as written and still turns 24-hour times into the hours column's words", () => {
    for (const s of [
      "Pub near South Shore, open Thursday 9:30 pm to 4 am, sharing nightlife and burgers tags with this crowd.",
      "open Thursday 7:30 am to 3 pm",
      "open 7:30 a.m. to 3 p.m.",
      "open 9:30pm to 4am",
      // A range that shares one suffix: "4:30" is 4:30 pm, not 24-hour time.
      "open Thursday 4:30 to 8 pm",
      "open Thursday 4 to 8 pm",
      // Seconds before the suffix.
      "open 9:30:00 pm to 2 am",
      // A line in 12-hour time is left whole, even where one time lacks a suffix.
      "open 07:30 to noon and 9:30 pm",
    ])
      expect(humanTimes(s)).toBe(s);
    // Round 4: an upper-case suffix reads as the hours column writes it; the times stay (text-integrity-partner-lines-uppercase-AM-PM-1e0da01d).
    expect(humanTimes("is open Saturday from 11:30 AM to 11 PM.")).toBe("is open Saturday from 11:30 am to 11 pm.");
    expect(humanTimes("17:00-23:00")).toBe("5 pm-11 pm");
    expect(humanTimes("open Thursday 17:00 to 02:00")).toBe("open Thursday 5 pm to 2 am");
    expect(humanTimes("open Thursday 17:00 to midnight")).toBe("open Thursday 5 pm to midnight");
    expect(humanTimes("open 07:30:00 to 12:00")).toBe("open 7:30 am to noon");
    // A word that starts with "am" or "pm" is not a suffix.
    expect(humanTimes("open 17:00 to 02:00, 2 amps on the stage")).toBe("open 5 pm to 2 am, 2 amps on the stage");
  });

  it("shows every partner line on every plan page with the stored line's times, never two am/pm in a row", () => {
    for (const { id, sheet } of PAGES) {
      const { html, shown } = renderPlan(sheet);
      expect(flat(html), id).not.toMatch(/\d\s*[ap]\.?m\.?\s+[ap]\.?m\b/i);
      const narr = shown.narration;
      if (!narr || narr.templated) continue;
      const text = flat(html);
      for (const pl of narr.partnerLines) {
        const line = humanTimes(pl.text);
        expect(text.includes(line), `${id}: ${line}`).toBe(true);
        expect(clockTimes(line), `${id}: ${pl.text}`).toEqual(clockTimes(pl.text));
      }
    }
  });

  it.skipIf(!HAVE_PLANS || !plan("18aa3a6e") || !plan("1e0da01d"))("18aa3a6e and 1e0da01d: the lines keep their stored times", () => {
    const a = flat(renderPlan(plan("18aa3a6e")!.sheet).html);
    expect(a).toContain("Pub near South Shore, open Thursday 9:30 pm to 4 am, sharing nightlife and burgers tags with this crowd.");
    // Round 5: the coffeehouse line ("7:30 am to 3 pm ... a before-show stop") is replaced at view time (the place is
    // not on the spots list), so a range that shares one suffix stands in for it.
    expect(a).toContain("open Thursday 4 to 8 pm");
    expect(a).toContain("open Thursday 4:30 am to 5 pm");
    expect(flat(renderPlan(plan("1e0da01d")!.sheet).html)).toContain("is open Saturday from 11:30 am to 11 pm.");
  });
});

describe("one line per area on the plan page, the print view and the PDF (outputs-18aa3a6e-area1-line-missing-on-plan-page)", () => {
  it("falls back to the area's percentiles when the narration has no line for it, by the PDF's own rule", () => {
    const s = structuredClone(fixture("g1-a"));
    const top = topTiles(s);
    const first = top[0]!;
    s.narration = { ...s.narration!, tileWhy: s.narration!.tileWhy.filter((w) => w.geohash !== first.geohash) };
    const raw = s.cards.liftMap.results.tiles.find((t) => t.geohash === first.geohash)!;
    const line = tileFallbackLine(s, raw);
    expect(line).toMatch(/^\d+(st|nd|rd|th) percentile for this crowd, \d+(st|nd|rd|th) for the room's usual crowd\.$/);
    expect(tileWhy(s, first.geohash)).toBe(line);
    expect(tileWhyLine(s, raw)).toBe(line);
    expect(buildSheetModel(s).panel1.tiles[0]!.why).toBe(line);
    expect(flat(renderPlan(s).html)).toContain(line);
    // An area that has a line keeps it.
    const second = s.narration.tileWhy.find((w) => w.geohash === top[1]!.geohash)!;
    expect(tileWhy(s, top[1]!.geohash)).toBe(second.text);
  });

  it("names a genre-wide baseline in the fallback, as the PDF does", () => {
    const s = structuredClone(fixture("g1-a"));
    s.cards.liftMap.results.diagnostics.baseline = "tag";
    s.bill.classification = "Comedy";
    const t = { billPct: 0.912, housePct: 0.27 };
    expect(tileFallbackLine(s, t)).toBe("91st percentile for this crowd, 27th for comedy fans in general.");
  });

  it.skipIf(!HAVE_PLANS || !plan("18aa3a6e"))("18aa3a6e: area 1 (Bronzeville) has the line the print view and the PDF print", async () => {
    const stored = plan("18aa3a6e")!;
    const { html, shown } = renderPlan(stored.sheet);
    const line = "89th percentile for this crowd, 7th for the room's usual crowd.";
    expect(buildSheetModel(shown).panel1.tiles[0]!.why).toBe(line);
    const list = /<ol id="lift-[^"]*-areas"[\s\S]*?<\/ol>/.exec(html)?.[0] ?? "";
    const first = /<li[\s\S]*?<\/li>/.exec(list)?.[0] ?? "";
    expect(flat(first)).toContain("Bronzeville, IL");
    expect(flat(first)).toContain(line);
    expect(flat(renderToStaticMarkup(await SheetPage({ params: Promise.resolve({ id: stored.planId }) })))).toContain(line);
  });
});

describe("the print view's partner table caption (outputs-s-notes-caption-says-blank)", () => {
  it("says the table has a column for notes, not a blank one", async () => {
    const html = renderToStaticMarkup(await SheetPage({ params: Promise.resolve({ id: "g1-a" }) }));
    expect(html).toContain("Partners, one row each, with a box to tick and a column for notes.");
    expect(html).not.toContain("blank column");
  });
});

describe("screen-only links stay off paper (browser-print-final-bp-1)", () => {
  const paper = (html: string) => flat(html.replace(/<span class="no-print">[\s\S]*?<\/span>/g, ""));

  it("prints what was asked on a revised sheet, without the link to the earlier plan", () => {
    const sheet = fixture("g1-a");
    const revision: SheetRevision = { parentPlanId: "g1-b", instruction: "No restaurants", interpreter: "rules", toolCalls: [], changes: [] };
    const html = withReceipts(sheet, createElement(RevisionNote, { revision }));
    expect(flat(html)).toContain("This version: “No restaurants”. Open the earlier plan.");
    expect(paper(html)).toContain("This version: “No restaurants”.");
    expect(paper(html)).not.toContain("Open the earlier plan");
  });

  it("prints the ledger's count and keys line, without the download", () => {
    const sheet = fixture("g1-a");
    const html = withReceipts(sheet, createElement(LedgerSection, { entries: sheet.ledger, exportHref: "/api/sheet/g1-a/sheet.json" }));
    expect(flat(html)).toContain("Keys show only as environment variable names. Download sheet.json to keep the full ledger.");
    expect(paper(html)).toContain("Keys show only as environment variable names.");
    expect(paper(html)).not.toMatch(/Download sheet\.json|to keep the full ledger/);
  });
});

describe("an unknown sheet id (browser-print-final-bp-2)", () => {
  it("has its own 404 boundary, titled Sheet not found", () => {
    expect(notFoundMetadata.title).toBe("Sheet not found");
    const html = renderToStaticMarkup(createElement(SheetNotFound));
    expect(html).toContain("No sheet at this address");
    expect(html).toContain('href="/#sheets"');
  });
});

describe("no view-time rewrite doubles or breaks a word (sweep)", () => {
  const BROKEN: [string, RegExp][] = [
    ["two am/pm in a row", /\b(?:am|pm|a\.m\.|p\.m\.)\s+(?:am|pm)\b/i],
    ["a word twice", /\b(\w+) \1\b/i],
    ["(s)", /\(s\)/],
    ["..", /(?<!\.)\.\.(?!\.)/],
    [" ,", / ,/],
    ["two spaces", / {2}/],
  ];

  it("on the plan page, the partner panels, the print view and the PDF's text of every sheet", async () => {
    const found: string[] = [];
    for (const { id, sheet } of PAGES) {
      const { html, shown } = renderPlan(sheet);
      const why = shown.cards.partners.results.map((p) => withReceipts(shown, createElement(PartnerWhy, { p }))).join("\n");
      const s = renderToStaticMarkup(await SheetPage({ params: Promise.resolve({ id }) }));
      const pdf = sheetModelText(buildSheetModel(shown)).map((t) => `<p>${t}</p>`).join("");
      for (const [where, page] of [["plan", html], ["why", why], ["s", s], ["pdf", pdf]] as const) {
        for (const node of textNodes(page)) for (const [name, re] of BROKEN) if (re.test(node)) found.push(`${id} ${where} ${name}: ${node.trim().slice(0, 160)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("gives every area, partner and spot the print view and the PDF list a line or value on the plan page", () => {
    const missing: string[] = [];
    for (const { id, sheet } of PAGES) {
      const { html, shown } = renderPlan(sheet);
      const text = flat(html);
      const has = (what: string, x: string | null | undefined) => {
        if (x && x.trim() !== "" && !text.includes(x.trim())) missing.push(`${id} ${what}: ${x}`);
      };
      const m = buildSheetModel(shown);
      for (const t of m.panel1.tiles) {
        has("area", t.name);
        has("area line", t.why);
      }
      for (const r of m.panel2.rows) {
        has("partner", r.name);
        has("address", r.address);
        has("hours", r.dayHours);
        has("phone", r.phone ? null : "Phone not listed");
        has("why", r.why);
        // A made-up place's ".example" website is said as text: it never resolves, so it is no link (r7 pages-N1).
        if (r.webUrl && isUnreachableWebsite(r.webUrl)) has("website", new URL(r.webUrl).hostname);
        else if (r.webUrl && !html.includes(`href="${r.webUrl.replace(/&/g, "&amp;")}"`)) missing.push(`${id} website: ${r.webUrl}`);
      }
      const rows = [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((r) => flat(r[0]));
      for (const r of m.panel4.rows) {
        has("spot", r.name);
        has("spot share", r.share);
        // The PDF's "Vs usual crowd" cell, in the plan page's words.
        const row = rows.find((x) => x.startsWith(r.name)) ?? "";
        if (r.vsUsual === "not in its list" && !row.includes("not in the room's usual crowd's list")) missing.push(`${id} spot vs usual crowd: ${r.name}`);
        if (/places? (higher|lower)$/.test(r.vsUsual) && !row.includes(`ranks ${r.vsUsual} here than for`)) missing.push(`${id} spot vs usual crowd: ${r.name} ${r.vsUsual}`);
      }
      for (const r of m.panel3.rows) has("declared", r.label);
      for (const r of m.panel5.podcasts) has("podcast", r.name);
      has("sponsor", m.panel5.sponsor?.name);
      for (const h of m.panel6.hooks) has("copy line", h);
      for (const b of m.footer.budget) {
        has("budget area", b.name);
        has("budget share", b.share);
      }
    }
    expect(missing).toEqual([]);
  });

  it("says a spot the usual crowd's list left out, with that list's receipt, as the PDF's Vs usual crowd column does", () => {
    const s = fixture("g1-a");
    const spotRow = (sheet: StreetSheet, name: string) =>
      [...withReceipts(sheet, createElement(PrePostCard, { sheet })).matchAll(/<tr>[\s\S]*?<\/tr>/g)].map((r) => r[0]).find((r) => flat(r).startsWith(name)) ?? "";
    const darby = spotRow(s, "Darby's Bar");
    expect(flat(darby)).toContain("Near the room, open on show night and not in the room's usual crowd's list.Q26–Q27");
    expect(buildSheetModel(s).panel4.rows.find((r) => r.name === "Darby's Bar")?.vsUsual).toBe("not in its list");
    // A spot with a rank keeps its own words, and with no usual-crowd list at all nothing is added.
    expect(flat(spotRow(s, "Dorsey's"))).toContain("ranks 3 places lower here than for the room's usual crowd");
    const none = structuredClone(s);
    for (const sp of none.cards.prePost.results) {
      sp.deltaRank = null;
      sp.chips = sp.chips.filter((c) => !/usual crowd/.test(c.label));
    }
    expect(flat(spotRow(none, "Darby's Bar"))).not.toContain("usual crowd");
  });

  it.skipIf(!HAVE_PLANS || !plan("8439cb36"))("8439cb36: Lan's Chicago says it is not in the usual crowd's list", () => {
    expect(flat(renderPlan(plan("8439cb36")!.sheet).html)).toContain("Lan's ChicagoRestaurant · 1.3 km awayNear the room, open on show night and not in the room's usual crowd's list.");
  });

  it("says a partner has no phone, as the print view and the PDF do", () => {
    const s = structuredClone(fixture("g1-a"));
    const p = s.cards.partners.results[0]!;
    delete (p as { phone?: string | null }).phone;
    const html = withReceipts(s, createElement(PartnersCard, { sheet: s }));
    const row = [...html.matchAll(/<tr id="[^"]*"[\s\S]*?<\/tr>/g)].map((r) => flat(r[0])).find((r) => r.includes(p.entity.name)) ?? "";
    expect(row).toContain("Phone not listed");
    expect(buildSheetModel(s).panel2.rows[0]!.phoneText).toMatch(/^Phone not listed/);
  });
});

describe("a tag name inside a sentence keeps a proper adjective's capital (sweep)", () => {
  it("lower-cases a tag name but keeps acronyms and proper adjectives, as the narrator's partner lines do", () => {
    expect(tagInSentence("Casual dining")).toBe("casual dining");
    expect(tagInSentence("Work Songs")).toBe("work songs");
    expect(tagInSentence("VERSATILE")).toBe("versatile");
    expect(tagInSentence("Mexican")).toBe("Mexican");
    expect(tagInSentence("Italian")).toBe("Italian");
    expect(tagInSentence("Middle eastern")).toBe("Middle Eastern");
    expect(tagInSentence("irish pub")).toBe("Irish pub");
    expect(tagInSentence("Afro-cuban")).toBe("Afro-Cuban");
    expect(tagInSentence("R&B")).toBe("R&B");
    expect(tagInSentence("Hip - Hop")).toBe("Hip-Hop");
  });

  it("says them so under Tags it shares, in the fixed partner line and under Both rank high", () => {
    const s = structuredClone(fixture("g1-a"));
    const p = s.cards.partners.results.find((x) => x.explain && x.explain.tags.length > 0)!;
    p.explain!.tags = [
      { id: "urn:tag:style:qloo:traditional", name: "Traditional" },
      { id: "urn:tag:genre:place:restaurant:mexican", name: "Mexican" },
      { id: "urn:tag:genre:place:restaurant:middle_eastern", name: "Middle eastern" },
    ];
    expect(flat(withReceipts(s, createElement(PartnerWhy, { p })))).toContain("Tags it sharestraditional, Mexican, Middle Eastern");
    expect(fixedPartnerLine(p)).toMatch(/, shares the traditional, Mexican and Middle Eastern tags with this crowd\.$/);
    s.cards.whatsDifferent.results.shared = [
      { id: "urn:tag:genre:music:country", name: "Country" },
      { id: "urn:tag:genre:place:restaurant:italian", name: "Italian" },
    ];
    expect(flat(withReceipts(s, createElement(DifferentCard, { sheet: s })))).toContain("Both rank high: country, Italian.");
  });

  it("on every sheet, a proper adjective in a shared tag reads as the partner lines write it", () => {
    const found: string[] = [];
    for (const { id, sheet } of PAGES) {
      const shown = vettedSheet(sheet).sheet;
      for (const p of shown.cards.partners.results) {
        const why = flat(withReceipts(shown, createElement(PartnerWhy, { p })));
        const m = /Tags it shares(.*?)(?:Where|Usual crowd|$)/.exec(why);
        if (m && /\b(mexican|italian|middle eastern|irish|french|thai|indian|caribbean)\b/.test(m[1]!)) found.push(`${id} ${p.entity.name}: ${m[1]}`);
      }
    }
    expect(found).toEqual([]);
    // 7dddeb74 (recorded): the line says "shares Mexican and casual dining tags", and its panel now says so too.
    const rec = plan("7dddeb74");
    if (rec) {
      const shown = vettedSheet(rec.sheet).sheet;
      const p = shown.cards.partners.results.find((x) => x.explain?.tags.some((t) => t.name === "Mexican") && x.explain.tags.some((t) => t.name === "Casual dining"));
      expect(p, "7dddeb74 Mexican partner").toBeDefined();
      expect(flat(withReceipts(shown, createElement(PartnerWhy, { p: p! })))).toContain("Mexican");
    }
  });
});

describe("a check note that repeats is counted in one sentence (sweep)", () => {
  it("counts replaced partner lines as it counts left-out ones", () => {
    const note = 'replaced by the template: partnerLines[2]: names tags the place does not share ("coffee")';
    expect(checkNotes(Array.from({ length: 9 }, (_, i) => note.replace("[2]", `[${2 * i}]`)))).toEqual([
      `9 of Claude's partner lines were replaced with fixed wording: each names tags the place does not share ("coffee").`,
    ]);
    expect(checkNotes(['replaced by the template: partnerLines[1]: "house" instead of the room\'s usual crowd', 'replaced by the template: partnerLines[3]: "house" instead of the room\'s usual crowd'])).toEqual([
      `2 of Claude's partner lines were replaced with fixed wording: "house" instead of the room's usual crowd.`,
    ]);
  });

  it("puts any other count inside the sentence", () => {
    expect(checkNotes(["Person-entity tags stripped before storage.", "Person-entity tags stripped before storage."])).toEqual(["Person-entity tags stripped before storage (2 times)."]);
    expect(checkNotes(["no stop", "no stop"])).toEqual(["no stop (2 times)"]);
  });

  it("never prints a count after a sentence's full stop on any sheet's Checks list", () => {
    for (const { id, sheet } of PAGES) {
      for (const n of checkNotes(sheet.guard?.reasons ?? [], sheet)) expect(n, id).not.toMatch(/[.!?] \(\d+ times\)$/);
    }
  });
});
