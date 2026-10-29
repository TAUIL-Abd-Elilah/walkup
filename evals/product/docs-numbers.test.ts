/**
 * The counts the docs give for the sample world, the chain list and the gazetteer, held to the score file,
 * the fixture sheets and the data they describe (so a regenerated score or a new brand shows up here).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUDGET_TARGET } from "@walkup/orchestrator";
import { sheetEnvelope } from "../../packages/mcp/src/envelope";
import { createFixtureServices } from "../../packages/mcp/src/services";
import { billVsHouseTool, rankPartnersTool } from "../../packages/mcp/src/tools";
import { DEFAULT_BOUNDS } from "./checks";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const raw = (path: string) => readFileSync(join(ROOT, path), "utf8");
const doc = (path: string) => raw(path).replace(/\s+/g, " ");
const json = <T>(path: string): T => JSON.parse(raw(path)) as T;

type Score = { cases: { id: string; metrics?: Record<string, number | string | boolean | null> }[] };
const score = json<Score>("evals/product/out/score.json");
const metric = (caseId: string, key: string): number => {
  const v = score.cases.find((c) => c.id === caseId)?.metrics?.[key];
  if (typeof v !== "number") throw new Error(`no ${key} in ${caseId}`);
  return v;
};
type Fixture = { budget: { qlooFresh: number }; sheet: Parameters<typeof sheetEnvelope>[0] };
const fixture = (id: string) => json<Fixture>(`fixtures/synthetic/engine/${id}.sheet.json`);

describe("the sample world's call counts", () => {
  const g1a = metric("C01", "g1-a.qlooFresh");
  const g2 = metric("C03", "g2.qlooFresh");
  const g3 = metric("C04", "g3.qlooFresh");
  const g2After = fixture("g2").budget.qlooFresh;

  it("G2 counts both runs across its pause, in the orchestrator README", () => {
    expect([g2, g2After]).toEqual([39, 31]);
    expect(doc("packages/orchestrator/README.md")).toContain(`G2 sends ${g2} fresh calls across the pause (${g2 - g2After} before the pick, ${g2After} after it).`);
    expect(doc("packages/orchestrator/README.md")).not.toContain("G2 sends 31 fresh calls across the pause.");
  });

  it("the README and the system card give the presets' range, G2 included", () => {
    const goldens = ["C01", "C02", "C03", "C04"].map((id) => score.cases.find((c) => c.id === id)?.metrics ?? {});
    const fresh = goldens.flatMap((m) => Object.entries(m).filter(([k]) => k.endsWith(".qlooFresh")).map(([, v]) => v as number));
    const [lo, hi] = [Math.min(...fresh), Math.max(...fresh)];
    expect([lo, hi, g1a, g3]).toEqual([16, 39, 32, 16]);
    const g2Line = `G2 makes ${g2} across its pause, ${g2 - g2After} before the pick and ${g2After} after`;
    expect(doc("README.md")).toContain(`on the sample world a preset makes ${lo} to ${hi} from a cold cache (G1-A makes ${g1a},`);
    expect(doc("docs/system-card.md")).toContain(`on the sample world a preset makes **${lo} to ${hi}** from a cold cache (G1-A makes ${g1a},`);
    for (const path of ["README.md", "docs/system-card.md"]) {
      expect(doc(path)).toContain(g2Line);
      expect(doc(path)).toContain(`G3, with no lift map, makes ${g3})`);
      expect(doc(path)).not.toMatch(/16 to 32\b|\*\*16 to 32\*\*/);
    }
    expect(doc("apps/web/app/system-card/page.tsx")).toContain(`About ${lo} to ${hi} calls per`);
  });

  it("the product eval README gives G3's core and fallback calls with their own caps", () => {
    const core = metric("C04", "g3.coreBillCalls");
    const fallback = metric("C04", "g3.fallbackCalls");
    expect([core, fallback]).toEqual([10, 2]);
    expect(doc("evals/product/README.md")).toContain(
      `G3 makes ${core} core bill-level calls (the cap is ${BUDGET_TARGET.billLevel.max}) and ${fallback} coded fallback calls (the 60 km heatmap and the 2,500 m spots; the cap is ${DEFAULT_BOUNDS.fallbackMax}).`,
    );
    expect(doc("evals/product/README.md")).not.toContain("G3 reaches 10 coded fallback calls");
  });

  it("the sample world's split-half numbers match the fixture sheets", () => {
    const half = (id: string) => (fixture(id).sheet.cards.liftMap.results.liftDiagnostics?.splitHalfSpearman ?? NaN).toFixed(2);
    expect(doc("packages/qloo-world/README.md")).toContain(`split-half Spearman of lift ${half("g1-a")} for G1-A, ${half("g1-b")} for G1-B, ${half("g2")} for G2)`);
  });
});

describe("sizes and counts the READMEs give", () => {
  it("the chain list's brand count", () => {
    const n = json<{ chains: unknown[] }>("config/chains.json").chains.length;
    expect(doc("config/README.md")).toContain(`barbers and salons (${n} brands, reviewed`);
  });

  it("a sample sheet's MCP structuredContent is up to about 160 KB (G3 about 45 KB), its ledger a quarter to a third of it", () => {
    const kb = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8") / 1000;
    const sizes = Object.fromEntries(
      ["g1-a", "g1-b", "g3"].map((id) => {
        const sheet = fixture(id).sheet;
        const env = kb(sheetEnvelope(sheet, null));
        return [id, { env, ledger: kb(sheet.ledger) / env }];
      }),
    );
    for (const id of ["g1-a", "g1-b"]) {
      expect(sizes[id]?.env, id).toBeGreaterThan(145);
      expect(sizes[id]?.env, id).toBeLessThan(175);
    }
    expect(sizes.g3?.env).toBeGreaterThan(35);
    expect(sizes.g3?.env).toBeLessThan(55);
    for (const [id, s] of Object.entries(sizes)) {
      expect(s.ledger, id).toBeGreaterThan(0.24);
      expect(s.ledger, id).toBeLessThan(0.35);
    }
    const readme = doc("packages/mcp/README.md");
    expect(readme).toContain("A sample sheet is up to about 160 KB (G3, with no lift map, about 45 KB); its ledger is a quarter to a third of it.");
    expect(readme).not.toContain("about 110 KB");
    expect(readme).not.toContain("A sample sheet is about 160 KB");
  });

  it("bill_vs_house on a sample sheet is about 12 KB (G3 about 3 KB), and rank_partners about 13 KB for G1-A's own list", async () => {
    const kb = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8") / 1000;
    const services = createFixtureServices();
    const caller = { ip: "127.0.0.1", origin: null, transport: "memory" as const };
    const bvh = kb((await billVsHouseTool(services, caller, { planId: "g1-a" })).envelope);
    expect(bvh).toBeGreaterThan(10);
    expect(bvh).toBeLessThan(14);
    const bvhG3 = kb((await billVsHouseTool(services, caller, { planId: "g3" })).envelope);
    expect(bvhG3).toBeGreaterThan(2);
    expect(bvhG3).toBeLessThan(4);
    // Names that exist in the sample world, so they rank: the partners G1-A itself declares.
    const names = (fixture("g1-a").sheet.cards.declared.results as { declared: { label: string } }[]).map((r) => r.declared.label);
    expect(names).toHaveLength(8);
    const rank = (await rankPartnersTool(services, caller, { presetId: "g1-a", partnerNames: names })).envelope;
    expect(rank.status).toBe("ok");
    expect((rank.results as unknown as { rank: number | null }[]).some((r) => r.rank !== null)).toBe(true);
    expect(kb(rank)).toBeGreaterThan(11);
    expect(kb(rank)).toBeLessThan(15);
    expect(doc("packages/mcp/README.md")).toContain(
      "about 20 to 27 KB for a recorded live sheet and about 12 KB for a sample bill with a lift map (G3, with none, about 3 KB). `rank_partners` returns about 5 to 15 KB on the sample world (about 13 KB for the 8 partners G1-A declares);",
    );
    expect(doc("packages/mcp/README.md")).not.toContain("4 to 8 KB");
  });

  it("the pinned category tags: how many are pinned and the places each validation call returned", () => {
    type Tag = { key: string; status: string; validatedRows: number | null };
    const cats = json<{ categories: Tag[] }>("config/tags.json").categories;
    const pinned = cats.filter((c) => c.status === "pinned");
    const rows = pinned.map((c) => c.validatedRows as number);
    const line = `${pinned.length} of ${cats.length} categories pinned (${Math.min(...rows)} to ${Math.max(...rows)} places within 25 km`;
    expect(line).toBe("11 of 14 categories pinned (6 to 10 places within 25 km");
    expect(doc("README.md")).toContain(line);
    expect(doc("docs/system-card.md")).toContain(line);
    expect(doc("apps/web/app/system-card/page.tsx")).toContain(line.replace(" categories pinned", " pinned"));
    for (const path of ["README.md", "docs/system-card.md", "apps/web/app/system-card/page.tsx"]) expect(doc(path)).not.toContain("5 to 10 places within 25 km");
  });

  it("the gazetteer package README names every metro the build ships", () => {
    const metros = Object.keys(json<{ metros: Record<string, unknown> }>("data/gazetteer/out/manifest.json").metros);
    const shipped = doc("packages/gazetteer/README.md").match(/Metros shipped today: ([^.]+)\./)?.[1] ?? "";
    expect([...shipped.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort()).toEqual(metros.sort());
  });

  it("the gazetteer's last-build table has a row per metro in the manifest, with its counts", () => {
    type Metro = { generatedAt: string; counts: { neighbourhoods: number; places: number; zctas: number }; adults21Total: number; errors: unknown[] };
    const manifest = json<{ metros: Record<string, Metro> }>("data/gazetteer/out/manifest.json");
    const readme = raw("data/gazetteer/README.md");
    const n = (v: number) => v.toLocaleString("en-US");
    expect(Object.keys(manifest.metros).sort()).toEqual(["chicago", "dc", "hampton_roads", "nashville", "tacoma"]);
    for (const [metro, m] of Object.entries(manifest.metros)) {
      const row = readme.split("\n").find((l) => l.startsWith(`| \`${metro}\` `) && l.includes("housing dropped"));
      expect(row, metro).toBeDefined();
      const cells = (row as string).split("|").map((c) => c.trim());
      expect(cells[2]?.startsWith(`${n(m.counts.neighbourhoods)} (`), `${metro} neighbourhoods`).toBe(true);
      expect(cells.slice(3, 6), metro).toEqual([n(m.counts.places), n(m.counts.zctas), n(m.adults21Total)]);
      expect(m.errors, metro).toEqual([]);
    }
  });
});
