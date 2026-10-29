/**
 * Round-2 docs checks: the call counts, mapping rows, limit count and CI wording the docs give, held to the
 * constants the code runs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LIMITS_EVERY_SHEET } from "@walkup/contracts";
import { chainSummary } from "@walkup/engine";
import { SPLIT_HALF_NODE, THIN_CELLS, WIDE_RADIUS_KM } from "../../../packages/orchestrator/src/steps/heat";
import { HOUSE_TWIN_NODE, MIN_POOL, TILE_RADIUS_WIDE_M } from "../../../packages/orchestrator/src/steps/partners";
import { MIN_SPOTS, PREPOST_RADIUS_M, PREPOST_RADIUS_WIDE_M } from "../../../packages/orchestrator/src/steps/prepost";
import { SIGNAL_CHECK_NODE } from "../../../packages/orchestrator/src/steps/resolve";
import EvalPage from "../app/eval/page";
import SystemCardPage from "../app/system-card/page";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const raw = (path: string) => readFileSync(join(ROOT, path), "utf8");
const doc = (path: string) => raw(path).replace(/\s+/g, " ");
const km = (m: number) => `${m / 1000} km`;

function pageText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("the bill heatmap and the spots near the venue count their widening call", () => {
  it("uses the thresholds the heat and pre/post steps run", () => {
    expect([THIN_CELLS, WIDE_RADIUS_KM]).toEqual([200, 60]);
    expect([MIN_SPOTS, km(PREPOST_RADIUS_M), km(PREPOST_RADIUS_WIDE_M)]).toEqual([6, "1.5 km", "2.5 km"]);
  });

  it("says so in the README, the system card and its page", () => {
    const heat = `1 (+1 when fewer than ${THIN_CELLS} map squares come back and the map is searched again at ${WIDE_RADIUS_KM} km; 2 on FLO's sheets)`;
    const spots = `1 (+1 when fewer than ${MIN_SPOTS} spots come back within ${km(PREPOST_RADIUS_M)} and the search widens to ${km(PREPOST_RADIUS_WIDE_M)}; +1 weekly house twin)`;
    for (const path of ["README.md", "docs/system-card.md"]) {
      expect(doc(path)).toContain(heat);
      expect(doc(path)).toContain(spots);
      expect(doc(path)).not.toMatch(/\| 1 \(\+1 weekly\) \||Bill heat per geohash \| 1 \||\(bill\) \| 1 \|/);
      expect(doc(path)).toContain("0-4 (none when the bill has one seed; 0 on the live sheets)");
    }
    const text = pageText(renderToStaticMarkup(createElement(SystemCardPage)));
    expect(text).toContain(`1, or 2 when fewer than ${THIN_CELLS} map squares come back and the map widens to ${WIDE_RADIUS_KM} km`);
    expect(text).toContain(`1, or 2 when fewer than ${MIN_SPOTS} spots come back and the search widens to ${km(PREPOST_RADIUS_WIDE_M)}, plus 1 a week`);
  });
});

describe("the README's partner counts", () => {
  it("does not say a skipped area lists fewer partners", () => {
    const readme = doc("README.md");
    expect(readme).toContain("(16 to 22 on the four recorded live sheets and 10 to 24 on their recorded changes; each recorded note that leaves out place types lists fewer)");
    expect(readme).not.toContain("place types or areas lists fewer");
  });
});

describe("the mapping table has a row for every Qloo call a run makes", () => {
  const table = raw("docs/mapping-table.md");

  it("names the signal check, the split-half heatmaps and the partner house twin", () => {
    expect(SIGNAL_CHECK_NODE).toBe("Q1 signal check");
    expect(HOUSE_TWIN_NODE).toBe("Q9 house twin");
    expect(SPLIT_HALF_NODE).toBe("(split-half check)");
    for (const call of [SIGNAL_CHECK_NODE, "Q4/Q5 split-half", HOUSE_TWIN_NODE]) {
      expect(table).toContain(`| **${call}** |`);
      expect(table).toContain(`| ${call} | | `);
    }
    expect(table).toContain("`liftMap.results.liftDiagnostics.splitHalfSpearman`");
    expect(table).toContain("`Partner.houseRank` (null when the place is not in it), `Partner.ubiquityPenalty`");
  });

  it("gives the partner pool's widening order: 3,500 m first, then more categories", () => {
    expect([MIN_POOL, TILE_RADIUS_WIDE_M]).toEqual([8, 3500]);
    expect(table).toContain(`a pool still short of ${MIN_POOL} places at 3,500 m (a tile pool is first asked again at 3,500 m) is asked again with the pinned`);
    expect(table).not.toContain("a pool that returns fewer than 8 places is asked again with");
  });
});

describe("the limit lines and the score file", () => {
  it("the definition of done and the eval detail count the limits every sheet prints", () => {
    expect(LIMITS_EVERY_SHEET).toHaveLength(4);
    expect(doc("docs/definition-of-done.md")).toContain('The four "what this does not establish" lines (`LIMITS_EVERY_SHEET`) are printed.');
    expect(doc("docs/definition-of-done.md")).not.toContain('The five "what this does not establish"');
    expect(raw("evals/product/checks.ts")).toContain("`${LIMITS_EVERY_SHEET.length} limits`");
    expect(raw("evals/product/checks.ts")).not.toContain('"5 limits"');
  });

  it("/eval and the README say CI commits the score when anything but its timestamp changes", () => {
    const text = pageText(renderToStaticMarkup(EvalPage()));
    expect(text).toMatch(/Score file last updated [A-Z][a-z]{2} \d{1,2} \d{4}; CI re-runs the cases on every push\./);
    expect(text).not.toContain("Score unchanged since");
    expect(text).not.toContain("when the result changes");
    expect(doc("README.md")).toContain("when anything in it other than its timestamp changes.");
    expect(doc("README.md")).not.toContain("when the result changes");
  });
});

describe("the web README's partner card row", () => {
  it("names the chain limit the card shows", () => {
    const readme = doc("apps/web/README.md");
    expect(readme).toContain("its notes the chain limit (`CHAIN_DETECT_LIMIT`, which names the four signals) when any eligible place is a chain");
    expect(readme).not.toContain("hand-kept-list limit");
  });

  it("quotes the chain sentence chainSummary writes, not the old moved-down line", () => {
    const line = chainSummary({ kept: 2, listed: 16, leftOut: 12, capped: 2, cap: 2 }, ["partner", "partners"], true);
    expect(line).toBe("2 of 16 partners are national chains, listed last in their area: no local place filled their slot. 12 more chains left off: 10 for local places, 2 by the limit of 2 per list.");
    expect(doc("README.md")).toContain(`("${line}")`);
    expect(doc("packages/orchestrator/README.md")).toContain(`(\`chainSummary\`: "${line}")`);
    expect(doc("apps/web/README.md")).toContain(`("${(line as string).split(" 12 more")[0]}")`);
    for (const path of ["README.md", "apps/web/README.md", "packages/orchestrator/README.md", "docs/system-card.md"]) {
      expect(doc(path)).not.toMatch(/moved down\)|how many moved/);
    }
  });
});
