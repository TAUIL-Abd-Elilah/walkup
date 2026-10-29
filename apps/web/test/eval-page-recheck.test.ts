/**
 * /eval's opening paragraph: the recorded sheets come from live runs and were re-checked offline on Oct 28 and 29 2026
 * (deploy/vercel/plans.json, `scripts/refresh-recorded-plans.ts --recheck`; the pass that wrote the shipped file ran
 * at 07:49 UTC on Oct 29), so the page never says a sheet is exactly what a live run produced, and it links to the
 * system card's paragraph on what the re-check changed.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EvalPage from "../app/eval/page";

function intro(): { html: string; text: string } {
  const page = renderToStaticMarkup(EvalPage());
  const html = /<h1>Evaluation<\/h1>\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(page)?.[1] ?? "";
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
  return { html, text };
}

describe("/eval says how the recorded sheets were made", () => {
  it("says each comes from a live run and was re-checked offline, and points to what changed", () => {
    const { html, text } = intro();
    expect(text).toContain(
      "Live runs on the hosted site are paused for judging; each sheet recorded there comes from a live run and was re-checked offline on Oct 28 and 29 2026, with no API call (the system card says what changed).",
    );
    expect(html).toContain('href="/system-card#recheck"');
    expect(text).not.toMatch(/what a live run produced/);
  });
});
