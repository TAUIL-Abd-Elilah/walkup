/**
 * Round 5, docs: the score file's CI notes match ci.yml and vitest.config.ts, case titles say each thing once, /eval
 * says what the cases run, and the READMEs quote what the plan page and the partner chips print.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { usualCrowdChipLabel } from "@walkup/engine";
import EvalPage from "../app/eval/page";

const ROOT = new URL("../../../", import.meta.url);
const doc = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

interface ScoreFile {
  clauses: { id: string; note?: string }[];
  cases: { id: string; title: string }[];
}
const score = () => JSON.parse(doc("evals/product/out/score.json")) as ScoreFile;
const note = (id: string) => score().clauses.find((c) => c.id === id)?.note ?? "";

describe("the score file's CI notes", () => {
  it("D5: npm test runs the eval in the CI node job, through the root vitest include", () => {
    expect(note("D5")).toContain("npm test runs evals/product/product.eval.test.ts in the CI node job");
    expect(doc(".github/workflows/ci.yml")).toMatch(/run: npm test\b/);
    expect(doc("vitest.config.ts")).toContain('"evals/product/*.test.ts"');
    expect(note("D5")).not.toMatch(/once the root vitest include/);
  });

  it("D7: names the CI job that commits score.json and score.md", () => {
    const ci = doc(".github/workflows/ci.yml");
    expect(note("D7")).toContain("The CI job product-score");
    expect(ci).toMatch(/^ {2}product-score:/m);
    expect(ci).toContain("contents: write");
    expect(ci).toContain("git add evals/product/out/score.json evals/product/out/score.md");
    expect(note("D7")).not.toMatch(/needs a CI step/);
  });

  it("says the trust checks are left out of the core and venue counts", () => {
    expect(doc("evals/product/out/score.md")).toContain("core and venue calls both exclude the trust checks");
    expect(doc("docs/definition-of-done.md")).toContain("not counting coded fallbacks, typed-partner lookups and trust checks");
  });
});

describe("case titles", () => {
  it("say \"same room\" once at most", () => {
    for (const c of score().cases) expect((c.title.match(/same room/g) ?? []).length, c.id).toBeLessThanOrEqual(1);
    expect(score().cases.find((c) => c.id === "C18")?.title).toBe("The other bill in the same room: a different crowd (top-8 overlap at most 5 of 8)");
  });

  it("/eval shows the C18 title and says a case can run more than one plan", () => {
    const text = renderToStaticMarkup(EvalPage())
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ");
    expect(text).toContain("The other bill in the same room: a different crowd");
    expect(text).toContain("Each case runs one or more plans end to end");
    expect(text).toContain("The four sample sheets must also fit one page as a PDF.");
    expect(text).not.toContain("the sheet fits one page");
  });
});

describe("READMEs quote what the product prints", () => {
  it("quotes the plan page's assumed-numbers line and the seats-left label", () => {
    const readme = doc("README.md");
    expect(readme).toContain('("Capacity 6,000 and budget $6,000 are assumed numbers."; a typed seats-left count is labelled "Seats left, your number")');
    expect(readme).not.toContain('capacity "is an assumed number"');
    const view = doc("apps/web/components/plan/PlanView.tsx");
    expect(view).toContain("} are assumed numbers.`");
    expect(view).toContain('"Seats left, your number"');
  });

  it("calls the partner rank chip the usual-crowd chip, in its own words", () => {
    const readme = doc("packages/orchestrator/README.md");
    expect(readme).not.toContain("tonight-vs-house chip");
    expect(readme).toContain(`the usual-crowd chip from the pool's twin ("${usualCrowdChipLabel(3)}")`);
  });
});
