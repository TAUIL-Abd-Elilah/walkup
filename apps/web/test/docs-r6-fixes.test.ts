/**
 * Round 6, docs: the offline re-check ran on Oct 28 to 30 2026, and every doc and page that dates it says so and tells
 * the fifth pass; the recheck's script doc names Claude's lines it rewrites and the copy lines it drops; the narrator
 * README says copy hooks name the act and only genre tags fill the template's slots; D1 names the test that checks
 * the reworded buyers line; the exports README says what the PDF map key shows on a sheet with no lift map.
 */
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EvalPage from "../app/eval/page";
import SystemCardPage from "../app/system-card/page";

const ROOT = new URL("../../../", import.meta.url);
const doc = (path: string) => readFileSync(new URL(path, ROOT), "utf8").replace(/\s+/g, " ");
const pageText = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");

describe("the offline re-check's dates", () => {
  const docs = ["README.md", "docs/system-card.md", "docs/deploy-vercel.md", "skills/walkup/SKILL.md"];

  it("say Oct 28 to 30 2026 in the docs, the system card page and /eval", () => {
    const card = pageText(renderToStaticMarkup(createElement(SystemCardPage)));
    const evalPage = pageText(renderToStaticMarkup(EvalPage()));
    for (const text of [...docs.map(doc), card, evalPage]) {
      expect(text).toContain("Oct 28 to 30 2026");
      expect(text).not.toMatch(/Oct 28 and 29 2026/);
    }
    expect(doc("README.md")).toContain("**Re-checked offline, Oct 28 to 30 2026.**");
    expect(doc("docs/deploy-vercel.md")).toContain(`the README's "Re-checked offline, Oct 28 to 30 2026" lists what changed`);
    expect(card).toContain("On Oct 28 to 30 2026 the recorded sheets were re-checked offline with the newer checks, with no API call.");
    expect(evalPage).toContain("each sheet recorded there comes from a live run and was re-checked offline on Oct 28 to 30 2026, with no API call");
  });

  it("tell the fifth pass after the fourth, before the line that says no answer or number changed", () => {
    const card = pageText(renderToStaticMarkup(createElement(SystemCardPage)));
    for (const text of [doc("README.md"), doc("docs/system-card.md"), card, doc("docs/deploy-vercel.md")]) {
      const fourth = text.indexOf("A fourth pass on Oct 29");
      const fifth = text.indexOf("A fifth pass on Oct 30 fixed wording that the rest of its sheet contradicts");
      expect(fourth).toBeGreaterThan(-1);
      expect(fifth).toBeGreaterThan(fourth);
      expect(text).toContain('says "national chains aside"');
    }
    // The fifth pass made the 15th template swap; judging-fixes.test.ts counts the 15 from the stored sheets.
    expect(doc("README.md")).toContain("15 Claude sentences that fail a check now read as template wording");
    expect(doc("README.md")).toContain("the ten the fourth pass below found and the one the fifth pass found.");
    expect(doc("docs/system-card.md")).toContain("ten more from the fourth pass below and one from the fifth).");
    expect(card).toContain("ten of the 15 come from it: six partner lines");
    expect(card).toContain("and one more of the 15 comes from it, an area line that called its area's percentile the top one");
    expect(doc("docs/deploy-vercel.md")).toContain("A fourth pass on Oct 29 held Claude's lines to newer checks (ten of the 15 template swaps above");
    expect(doc("docs/deploy-vercel.md")).toContain("became template wording, the last of the 15.");
    for (const text of [doc("README.md"), doc("docs/system-card.md"), card]) {
      expect(text.indexOf("No Qloo or Ticketmaster answer, ranking, partner list or ledger number changed.")).toBeGreaterThan(
        text.indexOf("A fifth pass on Oct 30"),
      );
    }
  });
});

// plans.json ships with a deploy and is git-ignored, so the fifth pass is checked against it only where it exists.
const PLANS = new URL("deploy/vercel/plans.json", ROOT);
interface Stored {
  planId: string;
  sheet: {
    cards: { liftMap: { summary: string } };
    discovery?: { why?: string };
    narration?: { summary?: string };
    steps?: { id: string; decision: string }[];
    guard?: { reasons?: string[] };
  };
}

describe("the fifth pass as the docs tell it", () => {
  it.skipIf(!existsSync(PLANS))("matches the stored sheets", () => {
    const plans = JSON.parse(readFileSync(PLANS, "utf8")) as Stored[];
    const plan = (id: string) => plans.find((p) => p.planId.startsWith(id))!.sheet;
    for (const p of plans) {
      expect(p.sheet.cards.liftMap.summary).toMatch(/^\d+ areas pass both tests \(lift 1\.3 or more against the room's usual crowd, percentile 70 or higher for this crowd\)\./);
    }
    // FLO's "Skip U Street / Shaw": the chain in Laurel, and Ticketmaster's label.
    expect(plan("c1357cb5").discovery?.why).toContain("in area 1, national chains aside, that");
    expect(plan("c1357cb5").narration?.summary).toContain("FLO's crowd for this R&B show");
    // The two Rhiannon Giddens revisions that lost a copy line.
    for (const id of ["2cf1cf3c", "95e3c9b6"]) {
      expect(plan(id).steps?.find((s) => s.id === "narrate")?.decision).toMatch(/^Claude wrote a draft summary and fan copy lines/);
    }
    // Greensky Bluegrass's "Skip Schaumburg": the 15th template swap.
    expect(plan("8c832f27").guard?.reasons).toContain(
      'replaced by the template: tileWhy[3]: superlative "the area with the 96th percentile among" not backed by the sheet\'s numbers',
    );
  });
});

describe("the recheck's script doc", () => {
  it("names the two text-only fixes to Claude's lines and the copy lines it drops", () => {
    const scripts = doc("scripts/README.md");
    expect(scripts).toContain(
      `Claude's own lines are left to the guard, apart from "an 82nd" for "a 82nd", "about 2.0 times" for "about 2 times" where 2.0 is the area's figure, and "this R&B show" for "this Music / R&B show")`,
    );
    expect(scripts).toContain('"Why this one" saying "national chains aside" when a chain the rule skipped would have qualified ahead of the pick');
    expect(scripts).toContain("Claude's fan copy held to narrate()'s copy checks (a line that calls the room small from a taste tag");
    expect(scripts).not.toMatch(/Claude's own lines are left to the guard\)/);
  });
});

describe("the narrator README", () => {
  const narrator = doc("packages/narrator/README.md");

  it("says copy hooks name the act, as the guard and the template make them", () => {
    expect(narrator).not.toMatch(/no act name/);
    expect(narrator).toContain("and name the act (the headliner goes in front of a line that names none); at most 3 hooks.");
    // The guard's code agrees: a line that names no act gets the headliner in front.
    const guard = readFileSync(new URL("packages/narrator/src/narrate.ts", ROOT), "utf8");
    expect(guard).toContain("namesAct || !headliner ? text : `${headliner}: ${text}`");
  });

  it("says only genre tags fill the template's copy slots", () => {
    expect(narrator).toContain('Only genre tags fill the copy slots (never audience tags, adjectives or themes such as "Cozy" or "Friendship")');
    expect(narrator).not.toMatch(/genre and audience tags fill/);
    const template = readFileSync(new URL("packages/narrator/src/template.ts", ROOT), "utf8");
    expect(template).toContain("isSlotTag(x) && !isAudienceTag(x)");
  });
});

describe("D1 in the definition of done", () => {
  it("names the test that checks the reworded buyers line, since the eval does not", () => {
    const dod = doc("docs/definition-of-done.md");
    expect(dod).toContain("On a sheet with no lift map the plan page and the PDF reword the buyers line.");
    expect(dod).toContain("| `checkSubject` render checks; the `pdf` expectation on C01 to C04; the reworded buyers line: `apps/web/test/web-r5-fixes.test.ts` |");
    expect(readFileSync(new URL("apps/web/test/web-r5-fixes.test.ts", ROOT), "utf8")).toContain('it("says what g3 has instead"');
  });

  it("checks the buyers line as the run stores it, through buyersLimit", () => {
    expect(doc("docs/definition-of-done.md")).toContain(
      "The run stores the buyers line as `buyersLimit` says it of the sheet's map, and the check looks for that wording.",
    );
    const checks = readFileSync(new URL("evals/product/checks.ts", ROOT), "utf8");
    expect(checks).toContain("LIMITS_EVERY_SHEET.map((l) => buyersLimit(l, sheet)).filter((l) => !sheet.limits.includes(l))");
  });
});

describe("the contracts README's public API", () => {
  it("lists the buyers-line exports", () => {
    const contracts = doc("packages/contracts/README.md");
    expect(contracts).toContain("`LIMITS_EVERY_SHEET`, `BUYERS_LIMIT`, `NO_LIFT_BUYERS_LIMIT`.");
    expect(contracts).toContain("- `buyersLimit(line, sheet)`: the \"Where buyers live\" limit said of the map this sheet has: `NO_LIFT_BUYERS_LIMIT`");
    expect(contracts).toContain("`genreFans(classification)`");
    const src = readFileSync(new URL("packages/contracts/src/index.ts", ROOT), "utf8");
    for (const name of ["const BUYERS_LIMIT", "const NO_LIFT_BUYERS_LIMIT", "function genreFans", "function buyersLimit"]) {
      expect(src).toContain(`export ${name}`);
    }
  });
});

describe("the exports README's PDF map key", () => {
  it("says a sheet with no usual crowd has the plain heading and a sheet with no lift map keys the venue only", () => {
    const exportsDoc = doc("packages/exports/README.md");
    expect(exportsDoc).toContain(
      'with no usual crowd to compare with, the heading is "Where this crowd stands out", and on a sheet with no lift map (`noLift`) the key shows the venue square only.',
    );
    const model = readFileSync(new URL("packages/exports/src/sheet-model.ts", ROOT), "utf8");
    expect(model).toContain('title: noBaseline ? "Where this crowd stands out" :');
    expect(readFileSync(new URL("packages/exports/src/pdf.ts", ROOT), "utf8")).toContain("m.panel1.noLift ? [] : LIFT_KEY");
  });
});
