/**
 * check-no-raw: heuristics on synthetic shapes, and an end-to-end run against a
 * throwaway git repository in the OS temp dir (skipped when git is missing).
 * Every body here is a small synthetic stand-in written for this test.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { checkRepo, contentReason, forbiddenPathReason, rawBodyReason } from "../check-no-raw.mjs";

const SCRIPT = fileURLToPath(new URL("../check-no-raw.mjs", import.meta.url));

const insightsLike = { results: { entities: [{ entity_id: "x1", name: "n", query: { affinity: 0.5 } }] } };
const heatmapLike = { results: { heatmap: [{ location: { geohash: "dn6m9a" }, query: { affinity: 1 } }] } };
const searchLike = { results: [{ entity_id: "x2", name: "n", types: ["urn:entity:place"] }] };
const compareLike = { results: { tags: [], a: [], b: [] } };

describe("path rules", () => {
  it("blocks private and raw directories and SQLite caches", () => {
    expect(forbiddenPathReason("fixtures/raw/q1.json")).toMatch(/private path/);
    expect(forbiddenPathReason("data/private/p1/bars.csv")).toMatch(/private path/);
    expect(forbiddenPathReason("probe_out/2026/SUMMARY.md")).toMatch(/private path/);
    expect(forbiddenPathReason("packages/qloo/.cache/a.bin")).toMatch(/private path/);
    expect(forbiddenPathReason("cache.sqlite")).toMatch(/SQLite/);
    expect(forbiddenPathReason("cache.sqlite-wal")).toMatch(/SQLite/);
  });
  it("allows normal files and .gitkeep placeholders", () => {
    expect(forbiddenPathReason("fixtures/raw/.gitkeep")).toBeNull();
    expect(forbiddenPathReason("fixtures/synthetic/g1.json")).toBeNull();
    expect(forbiddenPathReason("data/gazetteer/nashville.json")).toBeNull();
  });
});

describe("raw body heuristics", () => {
  it("flags entity bodies, heatmaps, flat search results and compare bodies", () => {
    expect(rawBodyReason(insightsLike)).toMatch(/entity_id/);
    expect(rawBodyReason(heatmapLike)).toMatch(/heatmap/);
    expect(rawBodyReason(searchLike)).toMatch(/flat "results"/);
    expect(rawBodyReason(compareLike)).toMatch(/compare/);
  });
  it("finds bodies stored as JSON strings (HAR-style)", () => {
    const har = { log: { entries: [{ response: { content: { text: JSON.stringify(heatmapLike) } } }] } };
    expect(rawBodyReason(har)).toMatch(/heatmap/);
  });
  it("leaves normalized and unrelated JSON alone", () => {
    expect(rawBodyReason({ entities: [{ entityId: "x", affinity: 0.4 }] })).toBeNull();
    expect(rawBodyReason({ name: "walkup", scripts: { probe: "tsx scripts/probe.ts" } })).toBeNull();
    expect(rawBodyReason({ params: { "filter.results.entities": "a,b", query: "Ryman" } })).toBeNull();
  });
  it("checks JSON text by path: JSON lines, non-JSON and the synthetic folder", () => {
    expect(contentReason("logs/a.ndjson", `${JSON.stringify({ ok: 1 })}\n${JSON.stringify(searchLike)}\n`)).toMatch(/raw API body/);
    expect(contentReason("src/a.ts", 'const x = { "entity_id": "a", "query": { "affinity": 1 } };')).toBeNull();
    expect(contentReason("fixtures/synthetic/a.json", JSON.stringify({ synthetic: true, ...insightsLike }))).toBeNull();
    expect(contentReason("fixtures/synthetic/b.json", JSON.stringify(insightsLike))).toMatch(/lacks "synthetic": true/);
    expect(contentReason("packages/qloo/test/fx.json", JSON.stringify({ synthetic: true, ...insightsLike }))).toMatch(/raw API body/);
  });
});

const hasGit = spawnSync("git", ["--version"]).status === 0;
const repos: string[] = [];
afterAll(() => {
  for (const d of repos) rmSync(d, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "no-raw-"));
  repos.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [p, text] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  execFileSync("git", ["add", "-f", "-A"], { cwd: dir });
  return dir;
}

describe.skipIf(!hasGit)("end to end in a temp git repo", () => {
  it("exits 1 and names each offending staged file", () => {
    const dir = repoWith({
      "package.json": JSON.stringify({ name: "x" }),
      "fixtures/raw/q1.json": "{}",
      "data/private/p1/bars.json": "[]",
      "packages/qloo/test/fixture.json": JSON.stringify(insightsLike),
      "fixtures/synthetic/ok.json": JSON.stringify({ synthetic: true, ...heatmapLike }),
      "fixtures/synthetic/unmarked.json": JSON.stringify(heatmapLike),
      "docs/notes.md": "query.affinity is per-response; entity_id is normalized to entityId",
    });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(1);
    for (const p of ["fixtures/raw/q1.json", "data/private/p1/bars.json", "packages/qloo/test/fixture.json", "fixtures/synthetic/unmarked.json"]) {
      expect(r.stderr).toContain(p);
    }
    expect(r.stderr).not.toContain("fixtures/synthetic/ok.json");
    expect(r.stderr).not.toContain("docs/notes.md");
    const res = checkRepo({ cwd: dir });
    expect(res.violations.map((v) => v.path).sort()).toEqual(
      ["data/private/p1/bars.json", "fixtures/raw/q1.json", "fixtures/synthetic/unmarked.json", "packages/qloo/test/fixture.json"].sort(),
    );
  });

  it("checks the index, so a cleaned working copy does not hide a staged body", () => {
    const dir = repoWith({ "notes/body.json": JSON.stringify(searchLike) });
    writeFileSync(join(dir, "notes/body.json"), "{}"); // working tree differs; the index still holds the body
    expect(checkRepo({ cwd: dir }).violations.map((v) => v.path)).toEqual(["notes/body.json"]);
    expect(checkRepo({ cwd: dir, stagedOnly: true }).violations.map((v) => v.path)).toEqual(["notes/body.json"]);
  });

  it("exits 0 on a clean repo", () => {
    const dir = repoWith({ "package.json": JSON.stringify({ name: "x" }), "fixtures/raw/.gitkeep": "" });
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
    expect(r.stdout).toMatch(/ok \(2 files checked\)/);
    expect(r.status).toBe(0);
  });
});
