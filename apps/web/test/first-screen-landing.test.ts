/**
 * The landing's first screen on a sample server (no keys): the three-line pitch, the one dark button, and no
 * screenshot of a recorded sheet beside sample sheets. (The recorded hosts' room order is checked in
 * first-screen.test.ts through `landingRooms`; recorded-pages.test.ts covers the recorded landing.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("../components/LiftMap", () => ({
  LiftMap: () => createElement("figure", { "data-testid": "map" }),
  MapCaption: () => null,
}));
vi.mock("../components/LiftLegend", () => ({ LiftLegend: () => null }));
vi.mock("../components/TileList", () => ({ TileList: () => null }));

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_QLOO_UNTIL", "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE", "WALKUP_PLAN_SEED"];
const saved: Record<string, string | undefined> = {};
let dir = "";

const { default: Home } = await import("../app/page");
const { resetEngineForTests } = await import("../lib/server/engine");
const { runtimeMode } = await import("../lib/mode");

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

beforeAll(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "walkup-first-screen-"));
  process.env.WALKUP_DATA_DIR = dir;
  process.env.WALKUP_PLAN_STORE = "memory";
  resetEngineForTests();
});

afterAll(() => {
  resetEngineForTests();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("the landing's first screen, sample mode", () => {
  it("opens with the pitch and one dark button to a sheet, with no recorded-sheet screenshot", async () => {
    expect(runtimeMode().kind).toBe("fixture");
    const html = renderToStaticMarkup(await Home());
    const pitch = /<section[^>]*data-testid="pitch"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    const t = text(pitch);
    expect(t).toContain("For promoters and venue marketers with a booked show and seats left to sell.");
    expect(t).toContain("Each area is compared with the room's usual crowd, not with everyone, and every area and partner links to the request behind it.");
    // One primary button on the page, and it opens a sheet; here a sample, said as one.
    expect(html.match(/btn-primary/g)?.length).toBe(1);
    expect(pitch).toMatch(/<a href="\/plan\/g1-a" class="btn btn-primary"[^>]*>Open a street sheet<\/a>/);
    expect(t).toContain("A sample sheet with made-up places and numbers.");
    expect(pitch).not.toContain("<img");
    // The worked example is the sample pair; lift is explained once, in plain words.
    expect(html).toContain('data-testid="hero-comparison"');
    expect(text(html).match(/where this show's fans stand out from the room's regulars/g)?.length).toBe(1);
    // No live recording here, so no with-and-without tables and no second room.
    expect(html).not.toContain('data-testid="hero-with-without"');
    expect(html).not.toContain('data-testid="second-example"');
  });
});
