/**
 * /eval's "Claude alone, same areas" section, the "why lift" rows and the Fan-Bar title. The numbers come from
 * evals/llm-baseline/out/ and evals/p1/results.md, so these tests check that the page follows those files and the
 * protocol's fixed words, never fixed numbers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import EvalPage from "../app/eval/page";
import {
  BASELINE,
  BASELINE_EXPLORATORY,
  BASELINE_PREREGISTERED,
  baselineRows,
  exploratoryLine,
  missRows,
  modelName,
  preregisteredLine,
  WHY_LIFT,
  whyLiftRows,
  whyLiftSentences,
  type WhyLiftRoom,
} from "../lib/eval-data/llm-baseline";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function unescape(html: string): string {
  return html.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

describe("the baseline numbers", () => {
  it("adds up per bill and in total", () => {
    const rows = baselineRows();
    const bills = rows.slice(0, -1);
    const total = rows[rows.length - 1]!;
    expect(bills).toHaveLength(4);
    expect(total.bill).toBe("All four");
    for (const k of ["asked", "usable", "walkupUsable", "sameAsWalkup"] as const) {
      expect(bills.reduce((n, r) => n + r[k], 0)).toBe(total[k]);
    }
    const c = BASELINE.total.claude;
    expect(missRows(c).reduce((n, m) => n + m.count, 0) + c.usable).toBe(c.returned);
    expect(BASELINE.total.walkup.usable).toBe(BASELINE.total.walkup.listed - BASELINE.total.walkup.chains);
  });

  it("asks for as many places as Walkup lists", () => {
    for (const b of BASELINE.bills) expect(b.claude.asked).toBe(b.walkup.listed);
  });

  it("publishes the protocol's sentences with the summary's numbers", () => {
    const c = BASELINE.total.claude;
    const w = BASELINE.total.walkup;
    expect(BASELINE.sentences[0]).toBe(
      `Asked for the same ${c.asked} places in the same areas, Claude alone named ${c.usable} that Qloo finds in the area, not marked closed, not closed on Thursday and not a national chain. Walkup's list has ${w.usable} of ${w.listed}.`,
    );
    const cmp = c.usable > w.usable ? "better than" : c.usable === w.usable ? "as well as" : "worse than";
    expect(BASELINE.sentences[1]).toBe(`On this check, Claude alone did ${cmp} Walkup.`);
    expect(BASELINE.sentences.join(" ")).not.toMatch(/does not exist\b(?!\.)|made up|hallucinat/);
  });

  it("states the planned run and the exploratory checks from their own files", () => {
    const pre = BASELINE_PREREGISTERED;
    const unanswered = pre.bills.flatMap((b) => b.areas).filter((a) => !a.answered).length;
    const line = preregisteredLine();
    if (unanswered > 0) {
      expect(line).toContain(`${unanswered} of the ${pre.bills.flatMap((b) => b.areas).length} areas got no answer`);
      expect(line).toContain(`${pre.total.claude.usable} usable places in the ${pre.total.claude.returned} names`);
    }
    // Sentences built from parts keep their spaces ("cut off. Counted", never "cut off.Counted").
    expect(line).not.toMatch(/[.:;,][A-Za-z]/);
    expect(exploratoryLine()).not.toMatch(/[.;][A-Za-z]/);
    expect(exploratoryLine()).toMatch(/^Not in the plan, checked afterwards/);
    expect(exploratoryLine()).toContain(`${BASELINE_EXPLORATORY.areasOneAndAHalfTimesAsWide.usable} of Claude's names are usable`);
  });

  it("names the model plainly", () => {
    expect(modelName("anthropic/claude-haiku-5.5")).toBe("Claude Haiku 5.5");
    expect(modelName(null)).toBe("Claude");
  });
});

describe("why lift", () => {
  const room = (raw: number, lift: number): WhyLiftRoom => ({
    room: "x",
    venue: "Sample Hall, Exampleton",
    bills: [
      { bill: "a", radiusKm: 40, joinedTiles: 10, rawVsUsualCrowd: { rho: 0.456, n: 10 } },
      { bill: "b", radiusKm: 40, joinedTiles: 10, rawVsUsualCrowd: { rho: null, n: 2 } },
    ],
    top5: { raw: { sameTile: raw, samePlace: raw, of: 5 }, lift: { sameTile: lift, samePlace: lift, of: 5 } },
  });

  it("uses the protocol's words for each outcome", () => {
    expect(whyLiftSentences(room(2, 0))).toEqual([
      "At Sample Hall, the two bills share 2 of their top 5 raw-heat areas and 0 of their top 5 lift areas.",
      "Lift separates the two bills more than raw heat does here.",
      "Raw heat against the room's usual crowd, over the same areas: Spearman 0.46 (a) and not computed (b).",
    ]);
    expect(whyLiftSentences(room(0, 0))[1]).toBe("Raw heat alone separates the two bills as much as lift does here.");
  });

  it("has both live rooms, from the recorded maps", () => {
    expect(WHY_LIFT.map((r) => r.room)).toEqual(["anthem", "saltshed"]);
    expect(whyLiftRows().map((r) => r.room)).toEqual(["The Anthem", "The Salt Shed"]);
  });
});

describe("the /eval page", () => {
  const html = unescape(renderToStaticMarkup(EvalPage()));

  it("has the Claude-alone section with its sentence and both sides of the comparison", () => {
    expect(html).toContain('id="claude-alone-title"');
    expect(html).toContain("Claude alone, same areas");
    expect(html).toContain(BASELINE.sentences[0]!);
    expect(html).toContain("by construction");
    expect(html).toContain("Does not show:");
  });

  it("says the plan was committed after the run and names the doubtful matches", () => {
    expect(html).toContain("committed only after the run");
    expect(html).toContain("3 doubtful matches, all in Claude's favor");
    // The hours check passes a place whose hours are not listed, so the page never says the names were checked as open.
    expect(html).not.toContain("open on Thursday");
  });

  it("adds the two live rooms to the lift section", () => {
    expect(html).toContain("The two live rooms");
    for (const r of WHY_LIFT) expect(html).toContain(whyLiftSentences(r)[0]!);
  });

  it("titles the Fan-Bar Test with its result and the numbers in evals/p1/results.md", () => {
    const results = readFileSync(`${ROOT}evals/p1/results.md`, "utf8");
    const signal = /Q-signal \(club as signal\) \| 325 \| [^|]+\| [^|]+\| ([\d.]+)%/.exec(results)?.[1];
    const pop = /Q-pop \(popularity only\) \| 325 \| [^|]+\| [^|]+\| ([\d.]+)%/.exec(results)?.[1];
    const p = /p = \*\*([\d.]+)\*\*/.exec(results)?.[1];
    expect([signal, pop, p]).toEqual(["25.2", "27.0", "0.89"]);
    const title = /<h2 id="fanbar-title">([^<]*)<\/h2>/.exec(html)?.[1] ?? "";
    expect(title).toBe(`The Fan-Bar Test: no edge over popularity, ${Math.round(Number(signal))}% vs ${Math.round(Number(pop))}% in the top 50 (one-sided p = ${p})`);
  });

  it("no longer quotes a partner-table banner", () => {
    expect(html).not.toContain("every partner table says");
  });
});
