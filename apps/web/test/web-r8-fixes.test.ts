/**
 * Round 8 (web leftovers):
 * - L1: the age table's caption says what the bill column is: one act, one stand-in title, or an average over acts;
 * - L4: on paper the requests and limits sections' lead lines stay whole and with what they introduce;
 * - L9: on a revision, GET /api/sheet/<id> carries the top-level revision and parentPlanId, as MCP get_sheet does,
 *   and the two envelopes have the same top-level keys (hosted sheets: deploy/vercel/plans.json, git-ignored).
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { PlanView } = await import("../components/plan/PlanView");
const { vettedSheet } = await import("../lib/vetted");
const { GET: getSheet } = await import("../app/api/sheet/[planId]/route");
const route = await import("../app/mcp/route");
const { resetEngineForTests } = await import("../lib/server/engine");
const { resetKeyStatusMemo } = await import("../lib/server/key-status");
const { FreshRunLimiter, setFreshRunsForTests } = await import("../lib/server/limits");
const { resetRunsForTests } = await import("../lib/server/runs");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const PLANS_FILE = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const PLANS: { planId: string; sheet?: StreetSheet }[] = existsSync(PLANS_FILE) ? JSON.parse(readFileSync(PLANS_FILE, "utf8")) : [];
const ORIGIN = "https://walkup.example";
const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_QLOO_UNTIL", "WALKUP_PLAN_SEED"];
const saved: Record<string, string | undefined> = {};
let dir = "";

beforeAll(() => {
  for (const k of [...KEYS, "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"]) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "hl-web-r8-"));
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  setFreshRunsForTests(new FreshRunLimiter({ file: null }));
});

afterAll(() => {
  resetEngineForTests();
  resetRunsForTests();
  resetKeyStatusMemo();
  setFreshRunsForTests(null);
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
    .replace(/&amp;/g, "&");

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
      today: "2026-10-30T12:00:00Z",
      narrationReplaced: v.replaced.length,
    }),
  );
}
/** The age table's caption, as text. */
const ageCaption = (html: string) => decode(/<caption class="sr-only">(Over or under index per age group[\s\S]*?)<\/caption>/.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();

describe("the age table's caption counts the bill's blocks (L1)", () => {
  it("averages only when there is more than one act block", () => {
    expect(fixture("g1-a").cards.demographics.results.bill).toHaveLength(3);
    expect(ageCaption(renderPlan(fixture("g1-a")))).toBe("Over or under index per age group, averaged across the bill's acts and the room's usual acts");
  });

  it("names the one stand-in title on g2", () => {
    const g2 = fixture("g2");
    expect(g2.cards.demographics.results.bill).toHaveLength(1);
    expect(ageCaption(renderPlan(g2))).toBe("Over or under index per age group for the bill's stand-in title and the room's usual acts");
  });

  it("names the one act on a one-act bill", () => {
    const one = structuredClone(fixture("g1-a"));
    one.cards.demographics.results.bill = one.cards.demographics.results.bill.slice(0, 1);
    expect(ageCaption(renderPlan(one))).toBe("Over or under index per age group for the bill's act and the room's usual acts");
  });

  it.skipIf(PLANS.length === 0)("never says averaged on a hosted sheet with one act block", () => {
    for (const p of PLANS.filter((x) => x.sheet)) {
      const sheet = p.sheet!;
      const caption = ageCaption(renderPlan(sheet));
      if (sheet.cards.demographics.results.bill.length === 1) expect(caption, p.planId).not.toContain("averaged");
    }
  });
});

describe("the requests and limits leads on paper (L4)", () => {
  const CSS = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

  it("keeps each lead whole and with its table or list, in print only", () => {
    const print = CSS.slice(CSS.indexOf("@media print {"));
    expect(print).toMatch(/#ledger > p,\n\s*#limits > p \{\n\s*break-inside: avoid;\n\s*\}/);
    // Only the limits lead (its last paragraph) holds on to the list; a break after the Fan-Bar paragraph stays free.
    expect(print).toMatch(/#ledger > p,\n\s*#limits > p:last-of-type \{\n\s*break-after: avoid;\n\s*\}/);
    expect(CSS.slice(0, CSS.indexOf("@media print {"))).not.toContain("#limits > p");
  });

  it("puts the leads straight under their sections, where the rule finds them", () => {
    const html = renderPlan(fixture("g1-a"));
    const inside = (id: string) => new RegExp(`<section id="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1] ?? "";
    // The ledger: heading, then the lead paragraph, then the fold with the table.
    expect(inside("ledger")).toMatch(/^<h2[^>]*>Requests behind this sheet<\/h2><p [^>]*>\d+ entries,/);
    // Limits: heading, the Fan-Bar paragraph, the lead (the last p, so p:last-of-type), then the fold with the list.
    expect(inside("limits")).toMatch(/^<h2[^>]*>What this sheet doesn(?:'|&#x27;)t show<\/h2><p [^>]*>[\s\S]*?<\/p><p [^>]*>Limits, the checks run on every line, and where this sheet came from\.<\/p><details/);
  });
});

describe.skipIf(PLANS.length === 0)("a revision's envelope on the web API and over MCP (L9)", () => {
  beforeAll(() => {
    process.env.WALKUP_MODE = "recorded";
    process.env.WALKUP_PLAN_SEED = PLANS_FILE;
    resetEngineForTests();
    resetRunsForTests();
    resetKeyStatusMemo();
  });

  async function mcpGetSheet(planId: string): Promise<Record<string, unknown>> {
    const res = await route.POST(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_sheet", arguments: { planId } } }),
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
  }

  async function webSheet(planId: string): Promise<Record<string, unknown>> {
    const res = await getSheet(new Request(`${ORIGIN}/api/sheet/${planId}`), { params: Promise.resolve({ planId }) });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * The web envelope's top-level keys, less `source` ("store" or "preset": where the web server found the sheet), the
   * one key the web API has always added and MCP never had.
   */
  const webKeys = (web: Record<string, unknown>) => {
    expect(web.source).toBe("store");
    return Object.keys(web)
      .filter((k) => k !== "source")
      .sort();
  };

  it("gives /api/sheet/<revision id> and get_sheet the same top-level keys, revision and parentPlanId included", async () => {
    const revisions = PLANS.filter((p) => p.sheet?.revision);
    expect(revisions.length).toBeGreaterThan(0);
    for (const p of revisions) {
      const web = await webSheet(p.planId);
      const mcp = await mcpGetSheet(p.planId);
      expect(webKeys(web), p.planId).toEqual(Object.keys(mcp).sort());
      expect(web.parentPlanId, p.planId).toBe(p.sheet!.revision!.parentPlanId);
      expect(web.revision, p.planId).toEqual(mcp.revision);
      expect(web.parentPlanId, p.planId).toBe(mcp.parentPlanId);
    }
    // A plan that is not a revision has neither, on either side.
    const first = PLANS.find((p) => p.sheet && !p.sheet.revision)!;
    const web = await webSheet(first.planId);
    const mcp = await mcpGetSheet(first.planId);
    expect(webKeys(web)).toEqual(Object.keys(mcp).sort());
    expect("revision" in web || "parentPlanId" in web).toBe(false);
  });
});
