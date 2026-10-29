/**
 * Plan page fixes of Oct 29 (re-audit): each checked on the page as rendered, for the four sample sheets and, when the
 * git-ignored deploy/vercel/plans.json is present, for every recorded plan the hosted site serves.
 *
 * - Checks name the area a replaced line is in by its geohash, never by its place in the list (N04).
 * - "How this crowd differs" counts the tags shown under it (N05); a sample ledger counts its cache hits (N07).
 * - Checks never say "removed 0 claims" next to replacements (N22); the spots card names the operator's all-ages
 *   setting (N28); the Downloads line says why contact_email is blank (N30).
 * - "All ages" opens the recorded "All ages, no bars" (N36); the stream says mode recorded (N41).
 * - Controls stay off paper (N50); the plan 404 has its own title (N56); every page has a link-preview card (N57).
 * - Wrong methods get a 405 with a reason and Allow (N58); budget shares have one decimal (N68); tag lists read
 *   "Hip-Hop" (N69).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { readInstruction } from "@walkup/orchestrator";

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

const { PlanView, checkNotes, checksLine, summaryNote } = await import("../components/plan/PlanView");
const { LedgerSection } = await import("../components/plan/LedgerSection");
const { PrePostCard } = await import("../components/plan/MoreCards");
const { ReceiptContext } = await import("../components/plan/receipts");
const utils = await import("../lib/sheet-utils");
const { diffSummary, vettedSheet } = await import("../lib/vetted");
const { findReadyMade } = await import("../lib/revise-match");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const SAMPLES = ["g1-a", "g1-b", "g2", "g3"] as const;

// The recorded plans the hosted site serves (git-ignored: shipped with the deploy only).
const PLANS_FILE = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const HAVE_PLANS = existsSync(PLANS_FILE);
const PLANS: { planId: string; sheet: StreetSheet }[] = HAVE_PLANS ? JSON.parse(readFileSync(PLANS_FILE, "utf8")) : [];

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** The page as /plan/<id> renders it on the recorded host: the sheet checked at view time, then PlanView. */
function renderPage(stored: StreetSheet): { html: string; text: string; shown: StreetSheet } {
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
  return { html, text: visibleText(html), shown: v.sheet };
}

/** The part of the page between two element ids. */
function between(html: string, from: string, to: string): string {
  return html.slice(html.indexOf(`id="${from}"`), html.indexOf(`id="${to}"`));
}

const PAGES = [...SAMPLES.map((id) => ({ id, sheet: fixture(id) })), ...PLANS.map((p) => ({ id: p.planId.slice(0, 8), sheet: p.sheet }))];

describe("Checks place a replaced area line by its geohash (N04)", () => {
  it("names areas 2 to 5 on a sheet whose first area line was left out, and never calls that line area 1's", () => {
    const s = structuredClone(fixture("g1-a"));
    s.mode = "live";
    const top = utils.topTiles(s);
    expect(top.length).toBeGreaterThanOrEqual(4);
    // Claude's draft line for area 1 was left out; the 3 lines kept are areas 2-4, and the checks replaced them all.
    s.narration = { ...s.narration!, templated: false, tileWhy: top.slice(1, 4).map((t) => ({ geohash: t.geohash, text: "Fixed wording." })) };
    s.guard = {
      ...s.guard,
      dropped: 1,
      reasons: ["tileWhy[0]: number 94 is not in this run", ...[0, 1, 2].map((i) => `replaced by the template: tileWhy[${i}]: "house" instead of the room's usual crowd`)],
    };
    expect(checkNotes(s.guard.reasons, s)).toEqual([
      "One of Claude's area lines was left out: it had a number (94) that isn't from this run.",
      ...[2, 3, 4].map((n) => `Claude's line for area ${n} was replaced with fixed wording: "house" instead of the room's usual crowd.`),
    ]);
    // A line the checks dropped outright is gone from the stored lines, so the next index shifts down by one.
    s.guard.reasons = ['replaced by the template: tileWhy[0]: says 9 partners (dropped)', "replaced by the template: tileWhy[1]: says 6 partners, the sheet has 8"];
    s.narration = { ...s.narration, tileWhy: [{ geohash: top[2]!.geohash, text: "Fixed." }] };
    expect(checkNotes(s.guard.reasons, s)).toEqual([
      "One of Claude's area lines was left out: says 9 partners.",
      "Claude's line for area 3 was replaced with fixed wording: says 6 partners, the sheet has 8.",
    ]);
  });

  it.skipIf(!HAVE_PLANS)("names the right area on every recorded plan", () => {
    for (const p of PLANS) {
      const { html, shown } = renderPage(p.sheet);
      const checks = visibleText(between(html, "checks", "ledger"));
      const top = utils.topTiles(shown);
      const named = [...checks.matchAll(/Claude's line for area (\d) was replaced/g)].map((m) => Number(m[1]));
      const expected = shown.guard.reasons.flatMap((r) => {
        const m = /^replaced by the template: tileWhy\[(\d+)\]/.exec(r);
        if (!m) return [];
        const k = top.findIndex((t) => t.geohash === shown.narration!.tileWhy[Number(m[1])]!.geohash);
        expect(k, p.planId).toBeGreaterThanOrEqual(0);
        return [k + 1];
      });
      expect(named.sort(), p.planId).toEqual(expected.sort());
    }
    const roots = PLANS.find((p) => p.planId.startsWith("18aa3a6e"));
    if (roots) {
      const checks = visibleText(between(renderPage(roots.sheet).html, "checks", "ledger"));
      expect(checks).toContain("One of Claude's area lines was left out: it had a number (94) that isn't from this run.");
      for (const n of [2, 3, 4, 5]) expect(checks).toContain(`Claude's line for area ${n} was replaced with fixed wording`);
      expect(checks).not.toMatch(/line for area 1 was/);
    }
  });
});

describe("How this crowd differs counts the tags shown (N05)", () => {
  it("keeps a summary in other words, and recounts the counted one", () => {
    expect(diffSummary("There is no usual crowd to compare this bill with.", { a: [], b: [], shared: [] })).toBe("There is no usual crowd to compare this bill with.");
    const r = { a: [{ id: "a" }, { id: "s" }], b: [{ id: "b" }], shared: [{ id: "s" }] };
    expect(diffSummary("21 tags rank higher for this bill, 14 for comedy fans in general, and 9 rank high for both.", r)).toBe(
      "1 tag ranks higher for this bill, 1 for comedy fans in general, and 1 ranks high for both.",
    );
  });

  it("matches the columns under it on every sheet", () => {
    for (const { id, sheet } of PAGES) {
      const { html, shown } = renderPage(sheet);
      const r = shown.cards.whatsDifferent.results;
      const section = between(html, "different", "limits");
      const m = /(\d+) tags? ranks? higher for this bill, (\d+) for .+?, and (\d+) ranks? high for both\./.exec(visibleText(section));
      if (!m) {
        expect(shown.cards.whatsDifferent.summary, id).not.toMatch(/^\d+ tags? rank/);
        continue;
      }
      // The two lean columns are the first two lists in the section, before the age table.
      const lists = [...section.split("Age mix")[0]!.matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/g)].map((x) => (x[1]!.match(/<li/g) ?? []).length);
      const cols = section.includes("Nothing stood out.") ? null : lists;
      if (cols) expect([Number(m[1]), Number(m[2])], id).toEqual(cols.slice(0, 2));
      expect(Number(m[3]), id).toBe(r.shared.length);
    }
  });
});

describe("the ledger on a sample sheet counts its cache hits (N07)", () => {
  it("says g2's 7 answers from cache, never that nothing was cached", () => {
    const s = fixture("g2");
    const cached = s.ledger.filter((e) => e.kind === "qloo" && e.cacheHit).length;
    expect(cached).toBe(7);
    const html = renderToStaticMarkup(
      createElement(ReceiptContext.Provider, { value: { entries: s.ledger, open: () => undefined, sample: true } }, createElement(LedgerSection, { entries: s.ledger, exportHref: "/x", sample: true })),
    );
    expect(visibleText(html)).toContain("of them in Qloo's format (7 from cache). Sample data: every answer came from Walkup's made-up stand-in, so nothing was timed.");
    expect(html).not.toContain("or cached");
  });
});

describe("Checks and the Summary note agree with the replacements (N22)", () => {
  it("says no line was left out instead of 'removed 0 claims' when lines were replaced", () => {
    const g = { dropped: 0, reasons: ['replaced by the template: summary: superlative "highest" not backed by the sheet'], deniedTagCount: 0 };
    expect(checksLine(g)).toBe("Checks left out no line. No tag was left out under the data policy.");
    expect(checksLine({ ...g, reasons: [] }, 1)).toBe("Checks left out no line. No tag was left out under the data policy.");
    expect(checksLine({ ...g, reasons: [] })).toBe("Checks removed 0 claims. No tag was left out under the data policy.");
    // A failed line with no fixed wording for its slot was left out, though `dropped` does not count it.
    expect(checksLine({ ...g, reasons: [...g.reasons, "replaced by the template: tileWhy[2]: number (94) not backed by the sheet (dropped)"] })).toBe(
      "Checks left out 1 line. No tag was left out under the data policy.",
    );
    const s = structuredClone(fixture("g1-a"));
    s.narration = { ...s.narration!, templated: false };
    s.guard = { ...s.guard, reasons: g.reasons };
    expect(summaryNote(s)).toMatch(/^Summary in fixed wording, in place of Claude's draft\./);
  });

  it("never says removed 0 claims beside a replacement on any page", () => {
    for (const { id, sheet } of PAGES) {
      const checks = visibleText(between(renderPage(sheet).html, "checks", "ledger"));
      if (/replaced/.test(checks)) expect(checks, id).not.toContain("Checks removed 0 claims");
    }
  });
});

describe("the spots card's age line (N28)", () => {
  const card = (s: StreetSheet) =>
    visibleText(renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries: s.ledger, open: () => undefined } }, createElement(PrePostCard, { sheet: s }))));

  it("names the operator's all-ages setting on a 21+ show, as the PDF does, and keeps the others as they were", () => {
    const s = structuredClone(fixture("g1-a"));
    expect(s.bill.legalAgeEnforced).toBe(true);
    expect(card(s)).toContain("Age policy: 21+ (Ticketmaster age policy). Show what fans see");
    s.operator = { ...s.operator, allAges: true };
    expect(card(s)).toContain("Age policy: 21+ (Ticketmaster age policy). The operator set this sheet to all ages: no bars.");
    expect(card(fixture("g2"))).toContain("Age policy: not on the listing, so treated as all ages.");
    expect(card(fixture("g1-b"))).toContain("Age policy: All ages (Ticketmaster age policy).");
  });

  it.skipIf(!HAVE_PLANS)("says it on the recorded 21+ sheet set to all ages", () => {
    const p = PLANS.find((x) => x.sheet.bill.legalAgeEnforced === true && x.sheet.operator.allAges === true);
    expect(p).toBeDefined();
    expect(visibleText(between(renderPage(p!.sheet).html, "prepost", "resolution"))).toContain(
      "Age policy: 21+ (Ticketmaster age policy). The operator set this sheet to all ages: no bars.",
    );
  });
});

describe("page-wide lines on every sheet (N30, N50, N68, N69)", () => {
  it("renders each page with the Downloads note, controls off paper, one-decimal shares and plain tag names", () => {
    for (const { id, sheet } of PAGES) {
      const { html, text, shown } = renderPage(sheet);
      // N30
      expect(text, id).toContain("called, outcome and notes are blank for your street team to fill in, and contact_email is filled only from your own partner list");
      // N50: every "Why this place" button sits in a no-print wrapper; the area filter and the fans toggle are no-print.
      const why = (html.match(/>Why this place</g) ?? []).length;
      expect((html.match(/<span class="no-print mt-1 block"><button/g) ?? []).length, id).toBe(why);
      expect(html, id).not.toMatch(/<button type="button" class="text-button" aria-pressed/);
      expect(html, id).toMatch(/class="text-button text-sm no-print"[^>]*>Show what fans see/);
      // N68: the Share column has one decimal and adds up to 100.0%.
      const split = /<h3 class="text-base">Budget split<\/h3>[\s\S]*?<\/table>/.exec(html)?.[0];
      if ((shown.budgetSplit ?? []).length > 0) {
        const shares = [...split!.matchAll(/<td class="num">(\d+\.\d)%<\/td>/g)].map((m) => Number(m[1]));
        expect(shares.length, id).toBe(shown.budgetSplit!.length);
        expect(shares.reduce((a, b) => a + b, 0).toFixed(1), id).toBe("100.0");
      }
      // N69
      expect(text, id).not.toMatch(/Hip - Hop|Lo - Fi|hip - hop|lo - fi/);
    }
  });

  it("closes Qloo's spaced hyphen in tag names, never in a place name", () => {
    expect(utils.tagLabel("Hip - Hop")).toBe("Hip-Hop");
    expect(utils.tagLabel("Lo - Fi")).toBe("Lo-Fi");
    expect(utils.tagLabel("VERSATILE")).toBe("Versatile");
    expect(utils.tagName(new Map([["urn:tag:genre:music:hip_hop", "Hip - Hop"]]), "urn:tag:genre:music:hip_hop")).toBe("Hip-Hop");
  });

  it.skipIf(!HAVE_PLANS)("shows Hip-Hop in The Roots' copy lines", () => {
    const p = PLANS.find((x) => x.planId.startsWith("fe1ff2bc"));
    expect(visibleText(between(renderPage(p!.sheet).html, "hooks", "different"))).toMatch(/From the tags: Hip-Hop, /);
  });
});

describe("All ages opens the recorded All ages, no bars (N36)", () => {
  it.skipIf(!HAVE_PLANS)("for all ages, family show and kids welcome on every parent, and matches nothing else differently", async () => {
    const revisions = PLANS.filter((p) => p.sheet.revision);
    const parents = PLANS.filter((p) => !p.sheet.revision);
    expect(parents.length).toBe(4);
    for (const parent of parents) {
      const ages = revisions.find((r) => r.sheet.revision!.parentPlanId === parent.planId && r.sheet.revision!.instruction === "All ages, no bars");
      expect(ages, parent.planId).toBeDefined();
      for (const note of ["All ages", "family show", "kids welcome", "All ages, no bars"]) {
        const reading = await readInstruction(parent.sheet, note, { narrator: { client: null } });
        expect(findReadyMade(parent.sheet, reading.overrides, revisions)?.planId, `${parent.planId} ${note}`).toBe(ages!.planId);
      }
      // Each stored change still opens itself, and bars alone (without all ages) is not the all-ages version.
      for (const r of revisions.filter((x) => x.sheet.revision!.parentPlanId === parent.planId)) {
        const reading = await readInstruction(parent.sheet, r.sheet.revision!.instruction, { narrator: { client: null } });
        expect(findReadyMade(parent.sheet, reading.overrides, revisions)?.planId, r.sheet.revision!.instruction).toBe(r.planId);
      }
      const bars = await readInstruction(parent.sheet, "No bars", { narrator: { client: null } });
      expect(findReadyMade(parent.sheet, bars.overrides, revisions)).toBeNull();
    }
  });
});

describe("server answers (N41, N58)", () => {
  const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "WALKUP_MODE", "WALKUP_QLOO_UNTIL", "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"];
  const saved: Record<string, string | undefined> = {};
  let dir = "";
  beforeAll(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    dir = mkdtempSync(join(tmpdir(), "hl-web-fixes-"));
    process.env.WALKUP_DATA_DIR = dir;
    process.env.WALKUP_PLAN_STORE = "memory";
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a stored live sheet's stream with mode recorded on a recorded server, as GET /api/plan/<id> does", async () => {
    const { staticFrames } = await import("../lib/server/stream");
    const sheet = { ...structuredClone(fixture("g1-a")), mode: "live" as const };
    const v = { kind: "sheet" as const, planId: sheet.planId, title: "t", sheet, source: "store" as const } as unknown as Parameters<typeof staticFrames>[0];
    const start = () => JSON.parse(staticFrames(v)[0]!.split("data: ")[1]!) as { mode: string };
    process.env.WALKUP_MODE = "recorded";
    expect(start().mode).toBe("recorded");
    process.env.WALKUP_MODE = "fixture";
    expect(start().mode).toBe("live");
    delete process.env.WALKUP_MODE;
  });

  it("answers a wrong method on every API route with 405, a reason and Allow", async () => {
    const routes: [string, Promise<Record<string, unknown>>, "GET" | "POST"][] = [
      ["/api/plan", import("../app/api/plan/route"), "POST"],
      ["/api/plan/<id>", import("../app/api/plan/[id]/route"), "GET"],
      ["/api/plan/<id>/revise", import("../app/api/plan/[id]/revise/route"), "POST"],
      ["/api/plan/<id>/resolve", import("../app/api/plan/[id]/resolve/route"), "POST"],
      ["/api/plan/<id>/ready-made", import("../app/api/plan/[id]/ready-made/route"), "GET"],
      ["/api/plan/<id>/stream", import("../app/api/plan/[id]/stream/route"), "GET"],
      ["/api/rank-partners", import("../app/api/rank-partners/route"), "POST"],
      ["/api/send/prepare", import("../app/api/send/prepare/route"), "POST"],
      ["/api/send/confirm", import("../app/api/send/confirm/route"), "POST"],
      ["/api/sheet/<id>", import("../app/api/sheet/[planId]/route"), "GET"],
      ["/api/sheet/<id>/<file>", import("../app/api/sheet/[planId]/[file]/route"), "GET"],
      ["/api/limits", import("../app/api/limits/route"), "GET"],
      ["/api/events/search", import("../app/api/events/search/route"), "GET"],
      ["/api/proxy-search", import("../app/api/proxy-search/route"), "GET"],
      ["/healthz", import("../app/healthz/route"), "GET"],
    ];
    for (const [path, load, takes] of routes) {
      const mod = (await load) as Record<string, (() => Response) | undefined>;
      const allow = takes === "GET" ? "GET, HEAD, OPTIONS" : "POST, OPTIONS";
      expect(typeof mod[takes], path).toBe("function");
      for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((x) => x !== takes)) {
        const res = mod[m]!();
        expect([path, m, res.status, res.headers.get("allow")]).toEqual([path, m, 405, allow]);
        expect(((await res.json()) as { reason: string }).reason).toBe(`This route takes ${takes} requests only; apps/web/README.md lists each route and the method it takes.`);
      }
      const opts = mod.OPTIONS!();
      expect([path, opts.status, opts.headers.get("allow")]).toEqual([path, 204, allow]);
    }
  });
});

describe("head tags (N56, N57)", () => {
  it("titles the plan 404 as one", async () => {
    const nf = await import("../app/plan/[id]/not-found");
    expect(nf.metadata.title).toBe("Plan not found");
  });

  it("gives every page an Open Graph and Twitter card with a 1200x630 image, titled by the page itself", async () => {
    const { metadata } = await import("../app/layout");
    expect(String(metadata.metadataBase)).toBe("https://walkup-eight.vercel.app/");
    expect(metadata.openGraph).toEqual({ type: "website", siteName: "Walkup" });
    expect(metadata.twitter).toEqual({ card: "summary_large_image" });
    for (const f of ["opengraph-image.png", "twitter-image.png"]) {
      const png = readFileSync(fileURLToPath(new URL(`../app/${f}`, import.meta.url)));
      expect(png.subarray(1, 4).toString("ascii"), f).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], f).toEqual([1200, 630]);
      expect(readFileSync(fileURLToPath(new URL(`../app/${f.replace(".png", ".alt.txt")}`, import.meta.url)), "utf8")).toMatch(/^Walkup: /);
    }
  });
});
