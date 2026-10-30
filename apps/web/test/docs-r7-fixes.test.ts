/**
 * Round 7, docs: FLO's partial map gives the cause in order (131 squares at 40 km, so 60 km, 159 there) in the README,
 * on /eval and on the system card; the non-bar rule holds only when the area has an eligible non-bar; Q10 is
 * documented with take=25 and no price cap; the spec's all-ages rule keeps bakeries; deploy.md lists every variable
 * in .env.example; the scripts row and scripts/README.md name the recorded-mode and baseline scripts.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EvalPage from "../app/eval/page";
import SystemCardPage from "../app/system-card/page";

const ROOT = new URL("../../../", import.meta.url);
const raw = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const doc = (path: string) => raw(path).replace(/\s+/g, " ");
const pageText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

describe("FLO's partial map", () => {
  it("says 131 squares at 40 km caused the widening and 159 came back at 60 km", () => {
    const card = pageText(renderToStaticMarkup(createElement(SystemCardPage)));
    const evalPage = pageText(renderToStaticMarkup(EvalPage()));
    for (const text of [doc("README.md"), card, evalPage]) {
      expect(text).toMatch(/only 131 map squares came back within 40 km.{0,40}so the search widened to 60 km.{0,30}159/);
      expect(text).not.toMatch(/only 159 areas came back, so the search widened/);
    }
  });
});

describe("partner and spot rules", () => {
  it("states the non-bar rule with its exception", () => {
    for (const path of ["README.md", "docs/spec.md"]) {
      expect(doc(path)).toContain("at least 1 non-bar per tile when the area has an eligible one");
    }
    expect(doc("packages/engine/README.md")).toContain("a tile with no eligible non-bar keeps its bars");
  });

  it("documents Q10 with take=25 and no price cap", () => {
    expect(doc("README.md")).toContain("| Q10 | Place search at the venue, 1.5 km, restaurant/bar/cafe, show weekday, `take=25`, no price cap;");
    for (const path of ["README.md", "docs/system-card.md"]) {
      expect(doc(path)).toContain("spots near the venue (Q10) use the same filters without `filter.price_level.max` and with `take=25`");
    }
    expect(doc("docs/system-card.md")).not.toContain("same shape as Q9");
    expect(doc("docs/mapping-table.md")).toContain("`take=25`; no `filter.price_level.max`");
  });

  it("keeps bakeries on the all-ages fan-facing list in the spec", () => {
    const spec = doc("docs/spec.md");
    expect(spec).not.toContain("restaurants and cafes only");
    expect(spec).toContain("keeps the restaurants, cafes and bakeries");
  });

  it("names every pinned partner category in the skill's coverage map", () => {
    const row = raw("skills/walkup/SKILL.md").split("\n").find((l) => l.startsWith("| Partner categories |")) ?? "";
    for (const word of ["Bars", "pubs", "sports bars", "soul food", "night clubs"]) expect(row).toContain(word);
  });
});

describe("deploy.md and the scripts docs", () => {
  it("lists every variable in .env.example", () => {
    const deploy = raw("docs/deploy.md");
    const names = [...raw(".env.example").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1] as string);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(deploy, name).toContain("`" + name + "`");
  });

  it("names the recorded-mode and baseline scripts", () => {
    const row = raw("README.md").split("\n").find((l) => l.startsWith("| [`scripts/`]")) ?? "";
    expect(row).toContain("refresh-recorded-plans.ts");
    const scripts = raw("scripts/README.md");
    for (const file of ["export-plans.mjs", "precompute-revisions.ts", "llm-baseline.ts", "why-lift.ts", "refresh-recorded-plans.ts"]) {
      expect(scripts).toContain("`" + file + "`");
    }
  });
});
