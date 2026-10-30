/**
 * Round-7 fixes (final live audit):
 * - the sample sheets' made-up places show their ".example" website as text, not a link to a DNS error (pages-N1);
 * - GET /api/plan/<id>/ready-made answers 400 for a malformed id and 404 for an unknown one (mcp-api-N4);
 * - GET /api/plan/<id> answers 400 for a malformed id, as the stream and sheet routes do (mcp-api-N5);
 * - OPTIONS /mcp lists only POST and OPTIONS, as its 405s say (mcp-api-N6).
 * No keys, memory plan store, temp data dir, sample (fixture) mode.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Partner, StreetSheet } from "@walkup/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));

const { isUnreachableWebsite } = await import("../lib/format");
const { PartnersCard } = await import("../components/plan/PartnersCard");
const { ReceiptContext } = await import("../components/plan/receipts");
const { default: SheetPage } = await import("../app/s/[id]/page");
const mcp = await import("../app/mcp/route");
const readyMadeRoute = await import("../app/api/plan/[id]/ready-made/route");
const planRoute = await import("../app/api/plan/[id]/route");
const { resetEngineForTests } = await import("../lib/server/engine");
const { resetRunsForTests } = await import("../lib/server/runs");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const render = (node: ReactNode) => renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries: [], open: () => undefined } }, node));

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_PLAN_SEED"];
const ORIGIN = "https://walkup.example";
const PATTERN = "Plan ids match ^[A-Za-z0-9_-]{1,64}$.";
const saved: Record<string, string | undefined> = {};
let dir = "";

beforeAll(() => {
  for (const k of [...KEYS, "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"]) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "hl-web-r7-"));
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  process.env.WALKUP_MODE = "fixture";
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

describe("a sample sheet's made-up website (pages-N1)", () => {
  it("knows the reserved names that never resolve", () => {
    expect(isUnreachableWebsite("https://yoder-s-cafe-willard-st.example")).toBe(true);
    expect(isUnreachableWebsite("https://shop.EXAMPLE/menu")).toBe(true);
    expect(isUnreachableWebsite("https://example.com")).toBe(false);
    expect(isUnreachableWebsite("https://www.cafeaddis.com/")).toBe(false);
    expect(isUnreachableWebsite("not a url")).toBe(false);
  });

  it("shows the host as text on the sample sheets, and keeps a real website a link", () => {
    for (const id of ["g2", "g3"]) {
      const sheet = fixture(id);
      const html = render(createElement(PartnersCard, { sheet }));
      const fake = (sheet.cards.partners.results as Partner[]).filter((p) => p.website && isUnreachableWebsite(p.website));
      expect(fake.length, id).toBeGreaterThan(0);
      expect(html, id).not.toMatch(/href="https?:\/\/[^"]*\.example[/"]/);
      for (const p of fake) expect(html, `${id} ${p.entity.name}`).toContain(new URL(p.website!).hostname.replace(/^www\./, ""));
    }
    const sheet = fixture("g3");
    const [a, ...rest] = sheet.cards.partners.results as [Partner, ...Partner[]];
    const real: StreetSheet = { ...sheet, cards: { ...sheet.cards, partners: { ...sheet.cards.partners, results: [{ ...a, website: "https://www.cafeaddis.com/" }, ...rest] } } };
    expect(render(createElement(PartnersCard, { sheet: real }))).toContain('href="https://www.cafeaddis.com/"');
  });

  it("leaves the partner's name unlinked on the street-team page of a sample sheet", async () => {
    for (const id of ["g2", "g3"]) {
      const html = renderToStaticMarkup(await SheetPage({ params: Promise.resolve({ id }) }));
      const first = (fixture(id).cards.partners.results as Partner[])[0]!;
      expect(html.replace(/&#x27;/g, "'"), id).toContain(first.entity.name);
      expect(html, id).not.toMatch(/href="https?:\/\/[^"]*\.example[/"]/);
    }
  });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("plan id routes answer 400 for a malformed id and 404 for an unknown one (mcp-api-N4, N5)", () => {
  it("GET /api/plan/<id>/ready-made", async () => {
    for (const id of ["bad id", "a".repeat(70)]) {
      const res = await readyMadeRoute.GET(new Request(`${ORIGIN}/api/plan/x/ready-made`), params(id));
      expect(res.status, id).toBe(400);
      expect(await res.json()).toEqual({ reason: PATTERN });
    }
    const missing = await readyMadeRoute.GET(new Request(`${ORIGIN}/api/plan/nope/ready-made`), params("nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ reason: "No plan with id nope." });
    const known = await readyMadeRoute.GET(new Request(`${ORIGIN}/api/plan/g3/ready-made`), params("g3"));
    expect(known.status).toBe(200);
    expect(await known.json()).toMatchObject({ enabled: false, changes: [] });
  });

  it("GET /api/plan/<id>", async () => {
    for (const id of ["bad id", "a".repeat(70)]) {
      const res = await planRoute.GET(new Request(`${ORIGIN}/api/plan/x`), params(id));
      expect(res.status, id).toBe(400);
      expect(await res.json()).toEqual({ reason: PATTERN });
    }
    const missing = await planRoute.GET(new Request(`${ORIGIN}/api/plan/nope`), params("nope"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ reason: "No plan with id nope." });
  });
});

describe("OPTIONS /mcp (mcp-api-N6)", () => {
  it("lists only the methods the server takes", async () => {
    const res = mcp.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
  });
});
