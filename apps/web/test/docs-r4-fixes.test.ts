/**
 * Round 4, docs: the product's own words, quoted in the docs and on /eval. The compare card is "How this crowd
 * differs", the old "Swap the bill" link is the line "The other bill at {venue}", partners with no hours say "call
 * first" (only spots near the venue say "call ahead"), and what-if counts belong to sample sheets only.
 */
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EvalPage from "../app/eval/page";

const ROOT = new URL("../../../", import.meta.url);
const doc = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const pageText = () =>
  renderToStaticMarkup(EvalPage())
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");

describe("/eval case titles use the product's words", () => {
  it("names the other bill and the partners' call-first mark", () => {
    const text = pageText();
    expect(text).toContain("The other bill in the same room: same room, different crowd");
    expect(text).toContain("A partner with no listed hours is kept and marked call first");
    expect(text).not.toMatch(/Swap the bill|marked call ahead/);
  });
});

describe("docs quote what the product writes", () => {
  it("calls the compare card by its name", () => {
    for (const path of ["docs/spec.md", "docs/definition-of-done.md", "README.md", "packages/narrator/README.md"]) {
      expect(doc(path)).not.toMatch(/"What's different"|what's different tonight/);
    }
    expect(doc("docs/spec.md")).toContain('"How this crowd differs" is `empty`');
    expect(doc("docs/definition-of-done.md")).toContain('an empty "How this crowd differs"');
  });

  it("has no Swap the bill action", () => {
    for (const path of ["apps/web/README.md", "docs/spec.md", "docs/definition-of-done.md", "evals/product/README.md"]) {
      expect(doc(path)).not.toMatch(/Swap the bill|swaps the bill|swap to the second bill/);
    }
    expect(doc("apps/web/README.md")).toContain('actions (send, PDF, print view, Run it again), the "The other bill at {venue}" link');
  });

  it("marks what-if counts on sample sheets only, with the PDF's own labels", () => {
    const spec = doc("docs/spec.md");
    expect(spec).not.toContain("What-if counts");
    expect(spec).toContain('Every count on a sample sheet is marked as a what-if ("(assumed)" after the count on the PDF, or "Counts are what-ifs" when none is printed)');
    expect(doc("docs/what-we-tried.md")).not.toContain("What-if counts");
    expect(doc("README.md")).not.toContain("marked as what-ifs wherever they appear");
    expect(doc("docs/system-card.md")).not.toContain("operator what-ifs and are marked as such");
    expect(doc("apps/web/app/system-card/page.tsx")).not.toContain("what-ifs the operator enters, marked as what-ifs");
  });

  it("says call first for a partner with no hours", () => {
    expect(doc("evals/product/README.md")).toContain('C12 keeps partners with unknown hours and marks them "call first".');
    expect(doc("docs/definition-of-done.md")).toContain('| C12 | Partners with unknown hours are kept and marked "call first" |');
    expect(doc("README.md")).toContain('marked "call first" (a partner) or "call ahead" (a spot near the venue)');
  });

  it("names the partner chip the run writes, not the old tonight-vs-house label", () => {
    expect(doc("packages/orchestrator/README.md")).not.toContain('"tonight vs house +N ranks"');
    expect(doc("apps/web/README.md")).not.toContain('"tonight vs house +N ranks"');
    expect(doc("packages/orchestrator/README.md")).toContain('"ranks 3 places higher here than for the room\'s usual crowd"');
  });
});
