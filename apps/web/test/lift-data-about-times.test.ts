/**
 * One "about N times" per numbered area (text-integrity-lift-about-N-times-rounding-disagrees), checked on the four
 * sample sheets and, when the git-ignored deploy/vercel/plans.json is present, on every recorded plan the hosted site
 * serves. Each surface is rendered through the app's own modules: the plan page (its area list, the summary, the
 * Steps panel and a revision's change list), the print view /s, the PDF (Letter and A4) and street-team.ics from GET /api/sheet/<id>/<file>.
 * Every figure an area gets is the sheet's 2-decimal lift rounded half up (`aboutTimes`), on every surface.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aboutTimes, type StreetSheet } from "@walkup/contracts";
import { summaryReplaced } from "@walkup/engine";
import { pdfPlainText } from "../../../packages/exports/test/pdf-text";

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

const { PlanView } = await import("../components/plan/PlanView");
const { default: SheetPage } = await import("../app/s/[id]/page");
const { GET: getFile } = await import("../app/api/sheet/[planId]/[file]/route");
const { resetEngineForTests, stores } = await import("../lib/server/engine");
const { resetRunsForTests } = await import("../lib/server/runs");
const { allTiles, topTiles } = await import("../lib/sheet-utils");
const { vettedSheet } = await import("../lib/vetted");
const { buildSheetModel } = await import("@walkup/exports/sheet-model");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;
const PLANS_FILE = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const HAVE_PLANS = existsSync(PLANS_FILE);
const PLANS: { planId: string; createdAt: string; sheet: StreetSheet }[] = HAVE_PLANS ? JSON.parse(readFileSync(PLANS_FILE, "utf8")) : [];
const PAGES = [...["g1-a", "g1-b", "g2", "g3"].map((id) => ({ id, sheet: fixture(id) })), ...PLANS.map((p) => ({ id: p.planId, sheet: p.sheet }))];

const KEYS = ["QLOO_API_KEY", "TICKETMASTER_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENROUTER_API_KEY", "WALKUP_MODE", "WALKUP_PLAN_SEED"];
const saved: Record<string, string | undefined> = {};
let dir = "";

beforeAll(async () => {
  for (const k of [...KEYS, "WALKUP_DATA_DIR", "WALKUP_PLAN_STORE"]) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "hl-lift-data-"));
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
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Every "about N times" figure in a text, a whole number too (a Claude line may say "about 2 times" for 2.0). */
const figures = (text: string) => [...text.matchAll(/\babout (\d+(?:\.\d)?) times\b/gi)].map((m) => m[1] as string);
/** The same figure: "2" and "2.0" agree, "2.1" and "2.2" do not. */
const same = (a: string, b: string | undefined) => b !== undefined && Number(a) === Number(b);

async function file(id: string, name: string, query = ""): Promise<Response> {
  const res = await getFile(new Request(`https://walkup.example/api/sheet/${id}/${name}${query}`), { params: Promise.resolve({ planId: id, file: name }) });
  expect(res.status, `${id} ${name}${query}`).toBe(200);
  return res;
}

/** street-team.ics's "Area k of n: ..." lines, unfolded and unescaped. */
function icsAreaLines(ics: string): { rank: number; of: number; line: string }[] {
  const out: { rank: number; of: number; line: string }[] = [];
  for (const raw of ics.replace(/\r\n[ \t]/g, "").split("\r\n")) {
    if (!raw.startsWith("DESCRIPTION:")) continue;
    const desc = raw.slice("DESCRIPTION:".length).replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
    for (const l of desc.split("\n")) {
      const m = /^Area (\d+) of (\d+): (.*)$/.exec(l);
      if (m) out.push({ rank: Number(m[1]), of: Number(m[2]), line: m[3] as string });
    }
  }
  return out;
}

describe("one 'about N times' per numbered area on every surface", () => {
  it("has the recorded plans when plans.json is present", () => {
    if (HAVE_PLANS) expect(PLANS.length).toBeGreaterThan(0);
    expect(PAGES.length).toBeGreaterThanOrEqual(4);
  });

  for (const { id, sheet: stored } of PAGES) {
    it(`${id.slice(0, 8)}: the plan page, the Steps panel, the summary, /s, the PDF (Letter, A4) and the .ics agree`, async () => {
      const shown = vettedSheet(stored).sheet;
      const areas = topTiles(shown);
      const want = areas.map((t) => aboutTimes(t.lift));
      /** Figures seen for each area, by where they were seen. */
      const seen: Record<number, { where: string; figure: string }[]> = Object.fromEntries(areas.map((_, i) => [i, []]));
      const add = (i: number, where: string, text: string) => {
        for (const figure of figures(text)) seen[i]!.push({ where, figure });
      };

      // The plan page: each area's row in the numbered list, the Steps panel's "Put X first", the summary.
      // As the hosted page shows a stored or sample sheet: PlanView over the sheet as checked at view time.
      const plan = renderToStaticMarkup(
        createElement(PlanView, {
          payload: { sheet: shown, note: null, source: "store" },
          line: null,
          realShow: false,
          paired: null,
          runtimeLive: false,
          recorded: true,
          canRerun: false,
          revisable: false,
          today: "2026-10-29T12:00:00Z",
          narrationReplaced: vettedSheet(stored).replaced.length,
        }),
      );
      const planText = flat(plan);
      areas.forEach((t, i) => {
        const rows = [...plan.matchAll(new RegExp(`<li[^>]*data-geohash="${escapeRe(t.geohash)}"[^>]*>([\\s\\S]*?)</li>`, "g"))];
        expect(rows.length, `${id} area ${i + 1} row`).toBeGreaterThan(0);
        for (const r of rows) add(i, "plan page area list", flat(r[1] ?? ""));
      });
      const heat = /Put (.+?) first: about (\d+\.\d) times/.exec(planText);
      if (areas.length > 0 && (shown.steps ?? []).some((s) => s.id === "heat")) {
        expect(heat, `${id} Steps panel`).not.toBeNull();
        expect(areas[0]!.name?.startsWith(heat![1]!), `${id} Steps panel names area 1`).toBe(true);
        seen[0]!.push({ where: "Steps panel", figure: heat![2]! });
      }
      const summary = shown.narration?.summary ?? "";
      if (summary) expect(planText, `${id} summary on the page`).toContain(summary.replace(/\s+/g, " "));
      const top = /the strongest(?:, .+?,)? is about (\d+\.\d) times|stands out from .+? in 1 area: .+?, about (\d+\.\d) times/.exec(summary);
      if (areas.length > 0 && top && (shown.narration?.templated || summaryReplaced(shown.guard.reasons))) seen[0]!.push({ where: "template summary", figure: (top[1] ?? top[2])! });
      // Any figure a summary gives is one of the areas' own.
      for (const f of figures(summary)) expect(want.some((w) => same(f, w)), `${id} summary figure ${f}`).toBe(true);
      // A revision's change list: "now area 5, about 1.7 times ... (map square dqcjz5)", tied to its area by map square.
      const added = (shown.revision?.changes ?? []).filter((c) => /\babout \d+(?:\.\d)? times\b/.test(c.detail ?? "")).length;
      const changes = [...planText.matchAll(/now area (\d+), about (\d+(?:\.\d)?) times .*?\(map square ([0-9a-z]+)\)/g)];
      expect(changes.length, `${id} change list figures on the page`).toBeGreaterThanOrEqual(added);
      for (const m of changes) {
        const k = areas.findIndex((t) => t.geohash === m[3]);
        if (k >= 0) seen[k]!.push({ where: "plan page change list", figure: m[2]! });
        else {
          const tile = allTiles(shown).find((t) => t.geohash === m[3]);
          expect(tile, `${id} change list map square ${m[3]}`).toBeDefined();
          expect(same(m[2]!, aboutTimes(tile!.lift)), `${id} change list ${m[3]} says ${m[2]}, the tile's figure is ${aboutTimes(tile!.lift)}`).toBe(true);
        }
      }

      // The print view: the numbered list in the map section, in order.
      const s = renderToStaticMarkup(await SheetPage({ params: Promise.resolve({ id }) }));
      const mapSection = /aria-labelledby="sec-map"[\s\S]*?<\/section>/.exec(s)?.[0] ?? "";
      // The numbered list (the map key is a list too).
      const list = [...mapSection.matchAll(/<ol[^>]*>([\s\S]*?)<\/ol>/g)].map((m) => m[1] ?? "").find((ol) => /<span class="sr-only">1\. <\/span>/.test(ol)) ?? "";
      const items = [...list.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => flat(m[1] ?? ""));
      expect(items.length, `${id} /s areas`).toBe(areas.length);
      items.forEach((text, i) => add(i, "/s", text));

      // The PDF, Letter and A4: each area's entry runs from its "Name 2.45x" to the next one's.
      const model = buildSheetModel(shown);
      for (const query of ["", "?size=a4"]) {
        const text = pdfPlainText(Buffer.from(await (await file(id, "pdf", query)).arrayBuffer()));
        expect(text, `${id} PDF${query} text`).not.toBe("");
        const from = Math.max(0, text.indexOf(model.panel1.title));
        const starts = model.panel1.tiles.map((t) => text.indexOf(`${t.name} ${t.lift}`, from));
        starts.forEach((start, i) => {
          expect(start, `${id} PDF${query} area ${i + 1}`).toBeGreaterThanOrEqual(0);
          const next = starts[i + 1];
          const end = next !== undefined && next > start ? next : Math.min(text.length, start + 600);
          add(i, `PDF${query || " Letter"}`, text.slice(start, end));
        });
      }

      // street-team.ics: "Area k of n: Name, ZIP .... About N times ...".
      const lines = icsAreaLines(await (await file(id, "ics")).text());
      for (const l of lines) {
        expect(l.of, `${id} .ics area count`).toBe(areas.length);
        add(l.rank - 1, ".ics", l.line);
      }
      if (areas.length > 0) expect(lines.length, `${id} .ics area lines`).toBeGreaterThan(0);

      const wrong = areas.flatMap((t, i) => seen[i]!.filter((x) => !same(x.figure, want[i])).map((x) => `${id} area ${i + 1} ${t.name} (${t.lift}): ${x.where} says ${x.figure}, the sheet's figure is ${want[i]}`));
      expect(wrong).toEqual([]);
    }, 180_000);
  }
});
