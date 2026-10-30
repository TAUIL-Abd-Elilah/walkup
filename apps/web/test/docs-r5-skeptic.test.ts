/**
 * Round 5, docs (second pass): the definition of done says which other sheets skip grounding and the PDF check, and
 * that C19 uses 7 venue calls, as the score file shows; the trust checks are the partner twins; the recorded-plan
 * cases are named as the eval runs them; and the docs tell the re-check's fourth pass the same way.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CASES } from "../../../evals/product/cases";
import SystemCardPage from "../app/system-card/page";

const ROOT = new URL("../../../", import.meta.url);
const doc = (path: string) => readFileSync(new URL(path, ROOT), "utf8").replace(/\s+/g, " ");

interface ScoreFile {
  cases: { id: string; checks: { name: string }[]; metrics: Record<string, unknown> }[];
}
const score = () => JSON.parse(doc("evals/product/out/score.json")) as ScoreFile;
/** The sheets of each case, by the label the metrics carry. */
const sheets = (c: ScoreFile["cases"][number]) => [...new Set(Object.keys(c.metrics).filter((k) => k.endsWith(".partners")).map((k) => k.slice(0, -".partners".length)))];

describe("the definition of done says what runs on the other sheets", () => {
  it("names the sheets with grounding off and keeps the one-page PDF to the goldens", () => {
    const off = score().cases.flatMap((c) => sheets(c).filter((l) => c.metrics[`${l}.grounded`] === null).map((l) => `${c.id} ${l}`));
    expect(off.map((x) => x.slice(0, 3)).sort()).toEqual(["C17", "C17", "C17", "C18", "C20", "C20"]);
    const pdf = [...new Set(score().cases.filter((c) => c.checks.some((x) => x.name === "renders to a one-page PDF")).map((c) => c.id))];
    expect(pdf).toEqual(["C01", "C02", "C03", "C04"]);
    const dod = doc("docs/definition-of-done.md");
    expect(dod).toContain("except that grounding is off on a few repeat sheets (C17, the C18 warm run, two C20 variants) and only the goldens must fit one PDF page");
    expect(dod).not.toContain("on every other sheet the eval produces");
  });

  it("gives C19's 7 venue calls, the only case above a cold room's 6", () => {
    const over = score().cases.flatMap((c) => sheets(c).filter((l) => Number(c.metrics[`${l}.venueCalls`]) > 6).map((l) => `${c.id} ${l}: ${String(c.metrics[`${l}.venueCalls`])}`));
    expect(over).toEqual(["C19 g1-a, house heat fails: 7"]);
    expect(doc("docs/definition-of-done.md")).toContain("Venue calls stay at 6 or fewer on a cold room (7 in C19, where the failed house heatmap and its genre-tag stand-in both count)");
  });

  it("calls the trust checks the partner twins, as readBudget counts them", () => {
    expect(doc("evals/product/out/score.md")).toContain("core and venue calls both exclude the trust checks (split-half heatmaps, partner house and popularity twins)");
    expect(doc("docs/definition-of-done.md")).toContain("Trust checks (split-half heatmaps, partner house and popularity twins) stay at 10 or fewer.");
    expect(doc("evals/product/checks.ts")).toContain("/^Q9 house twin\\b/");
    expect(doc("evals/product/checks.ts")).not.toContain("/^Q10 house twin");
  });
});

describe("the recorded-plan cases", () => {
  it("are the goldens plus C17 and C18, and the docs say so", () => {
    expect(CASES.filter((c) => c.recorded).map((c) => c.id)).toEqual(["C01", "C02", "C03", "C04", "C17", "C18"]);
    expect(CASES.filter((c) => c.golden).map((c) => c.id)).toEqual(["C01", "C02", "C03", "C04"]);
    expect(doc("docs/definition-of-done.md")).toContain("only the golden cases (C01 to C04) and the two cases that re-check golden sheets (C17, C18) run");
    expect(doc("evals/product/README.md")).toContain("Six of the cases (the four goldens, C17 and C18) also run on recorded plans");
    expect(doc("evals/product/README.md")).not.toContain("The same checks also run on recorded plans");
  });
});

describe("the system card's product eval row", () => {
  it("says no drop in a citation field, since C09 and C10 drop policy lines on purpose", () => {
    expect(doc("docs/system-card.md")).toContain("zero guard drops in a citation field, call budget");
    const drops = score().cases.flatMap((c) => sheets(c).filter((l) => Number(c.metrics[`${l}.guardDropped`]) > 0).map(() => c.id));
    expect([...new Set(drops)]).toEqual(["C09", "C10"]);
  });
});

// judging-fixes.test.ts counts the 15 from the stored sheets (when plans.json is present); here the four docs that
// describe the re-check tell the fourth pass the same way.
describe("the re-check's fourth pass", () => {
  it("is told the same way in the README, the system card (both) and the hosting doc", () => {
    const readme = doc("README.md");
    expect(readme).toContain("15 Claude sentences that fail a check now read as template wording");
    expect(readme).toContain("A fourth pass on Oct 29 held Claude's lines to newer checks, and ten more now read as template wording: six partner lines");
    const md = doc("docs/system-card.md");
    expect(md).toContain("ten more from the fourth pass below and one from the fifth");
    expect(md).toContain("ten more now read as template wording: six partner lines");
    const card = renderToStaticMarkup(createElement(SystemCardPage)).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    expect(card).toContain("15 Claude sentences that fail a check now read as template wording");
    expect(card).toContain("ten of the 15 come from it: six partner lines");
    expect(card).toContain("“about 2.0 times” for “about 2 times”");
    expect(doc("docs/deploy-vercel.md")).toContain("A fourth pass on Oct 29 held Claude's lines to newer checks (ten of the 15 template swaps above");
    for (const text of [readme, md]) expect(text).toContain('"about 2.0 times" for "about 2 times"');
  });
});
