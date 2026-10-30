import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_DAILY_CAP } from "@walkup/send";
import SystemCardPage from "../app/system-card/page";
import { toolCallsLine } from "../components/plan/model";
import { RecordedStrip } from "../components/RecordedStrip";
import { recordedDetail, runtimeMode } from "../lib/mode";
import { REVISES_PER_HOUR } from "../lib/server/limits";
import { PREPARE_PER_HOUR } from "../lib/server/send";

describe("tool calls named on a revision", () => {
  it("lists each tool once, without the question tool", () => {
    expect(
      toolCallsLine([
        { tool: "set_all_ages" },
        { tool: "exclude_partner_categories" },
        { tool: "exclude_partner_categories" },
        { tool: "ask_operator" },
      ]),
    ).toBe("Tool calls: set_all_ages, exclude_partner_categories.");
  });

  it("says nothing when no tool was called", () => {
    expect(toolCallsLine([])).toBeNull();
    expect(toolCallsLine([{ tool: "ask_operator" }])).toBeNull();
  });
});

describe("the recorded strip names a later day for ready-made changes", () => {
  it("adds the changes day only when it is later than the recorded day", () => {
    expect(recordedDetail("2026-10-21", "2026-10-28")).toBe(
      "Recorded from live Qloo and Ticketmaster runs on Oct 21 2026; later changes recorded ahead on Oct 28 2026. Live runs are paused for judging; each recorded sheet comes from a live run, and any change since was made offline, with no API call.",
    );
    expect(recordedDetail("2026-10-21", "2026-10-21")).toBe(recordedDetail("2026-10-21"));
    expect(recordedDetail("2026-10-21", null)).toBe(recordedDetail("2026-10-21"));
    expect(recordedDetail(null, "2026-10-28")).toBe(recordedDetail(null));
  });

  it("reads the changes day from the options", () => {
    const env = { WALKUP_MODE: "recorded" };
    const mode = runtimeMode(env, { recordedOn: () => "2026-10-21", changesRecordedOn: () => "2026-10-28" });
    expect(mode.detail).toContain("; later changes recorded ahead on Oct 28 2026");
    expect(runtimeMode(env, { recordedOn: () => "2026-10-21" }).detail).toBe(recordedDetail("2026-10-21"));
  });

  it("bolds the whole first sentence, the changes day included, and says the sheets were re-checked offline", () => {
    const mode = runtimeMode({ WALKUP_MODE: "recorded" }, { recordedOn: () => "2026-10-21", changesRecordedOn: () => "2026-10-28" });
    const html = renderToStaticMarkup(createElement(RecordedStrip, { mode }));
    expect(html).toContain(
      '<strong class="font-semibold">Recorded from live Qloo and Ticketmaster runs on Oct 21 2026; later changes recorded ahead on Oct 28 2026.</strong> Live runs are paused for judging; each recorded sheet comes from a live run, and any change since was made offline, with no API call.</p>',
    );
    expect(mode.detail).not.toMatch(/what a live run produced/);
  });
});

/** Page text as a reader sees it: tags dropped, the entities React writes decoded, spaces collapsed. */
function pageText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const doc = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

/** The hosted sheets, and the copy kept from before the re-check pass that wrote them. */
const PLANS = join(ROOT, "deploy/vercel/plans.json");
const BEFORE_RECHECK = join(ROOT, ".cache/backup/plans.json.20261028-audit.before-recheck");
type StoredPlan = { planId: string; sheet: { guard?: { reasons?: string[] } } };
const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** Guard reasons for a Claude sentence swapped for template wording that a stored sheet has and its pre-pass copy lacked. */
function recheckTemplateSwaps(before: StoredPlan[], after: StoredPlan[]): string[] {
  const had = new Map(before.map((p) => [p.planId, new Set(p.sheet.guard?.reasons ?? [])]));
  return after.flatMap((p) =>
    (p.sheet.guard?.reasons ?? []).filter((r) => r.startsWith("replaced by the template:") && !had.get(p.planId)?.has(r)),
  );
}

describe("the offline re-check (Oct 28 to 30), said the same way on the site and in the docs", () => {
  // SWIG is listed as a restaurant; its name says nothing about drink. Qloo's tags (a bar and grill, dive-bar decor
  // and feel) are what left it out of the "All ages, no bars" revisions.
  const SWIG = "One spot listed as a restaurant, SWIG, is a bar by its Qloo tags (a bar and grill, with dive-bar tags)";

  it("the served system card says SWIG left for its Qloo tags and that recorded sheets were re-checked", () => {
    const html = renderToStaticMarkup(createElement(SystemCardPage));
    const text = pageText(html);
    expect(text).toContain(`${SWIG}, so it left the two “All ages, no bars” revisions at The Salt Shed, which now list 7 spots.`);
    expect(text).toContain("each recorded sheet comes from a live run and was re-checked offline afterwards, as the next paragraph says.");
    expect(html).toContain('id="recheck"');
    expect(text).not.toMatch(/by its name \(SWIG\)|what a live run produced/);
  });

  it("the README and docs agree with it and with the stored data's story", () => {
    const readme = doc("README.md");
    const card = doc("docs/system-card.md");
    const vercel = doc("docs/deploy-vercel.md");
    const skill = doc("skills/walkup/SKILL.md");
    expect(readme).toContain(SWIG.replace("One spot", "one spot"));
    expect(card).toContain(SWIG);
    for (const text of [readme, card, vercel, skill]) {
      expect(text).not.toMatch(/what a live run produced|by its name or tags \(SWIG\)|were not touched/);
    }
    expect(readme).toContain("each recorded sheet comes from a live run, with every receipt and download, and was re-checked offline on Oct 28 to 30 2026 with no API call");
    expect(readme).toContain("**Re-checked offline, Oct 28 to 30 2026.**");
    expect(vercel).toContain(`the README's "Re-checked offline, Oct 28 to 30 2026" lists what changed`);
    expect(card).toContain("each recorded sheet comes from a live run and was re-checked offline afterwards");
    // The hosting doc no longer says the parents were left alone: the re-check rewrote them too.
    expect(vercel).toContain("Recording them did not change the parents.");
    expect(vercel).toContain("all 23 sheets in `plans.json`, the four parents included, were re-checked offline with no API call");
  });

  // plans.json ships with a deploy and is git-ignored, and its pre-pass copy lives in .cache, so this runs only on a
  // machine that has both.
  it.skipIf(!existsSync(PLANS) || !existsSync(BEFORE_RECHECK))("counts the template swaps it made from the stored sheets", () => {
    const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as StoredPlan[];
    const after = read(PLANS);
    const swaps = recheckTemplateSwaps(read(BEFORE_RECHECK), after);
    expect(after).toHaveLength(23);
    const n = NUMBER_WORDS[swaps.length] ?? String(swaps.length);
    const N = n.charAt(0).toUpperCase() + n.slice(1);
    const said = `${N} Claude sentences that fail a check now read as template wording, with the reason in the sheet's checks`;
    expect(doc("README.md")).toContain(said);
    expect(doc("docs/system-card.md")).toContain(said);
    expect(pageText(renderToStaticMarkup(createElement(SystemCardPage)))).toContain(said);
    expect(doc("docs/deploy-vercel.md")).toContain(`${n} Claude sentences became template wording`);
    // f81d3edd's unbacked "largest" summary was swapped by its own run, so the re-check's list names one only if it made one.
    const largest = swaps.some((r) => /largest/.test(r));
    for (const path of ["README.md", "docs/system-card.md"]) expect(/unbacked "largest"/.test(doc(path))).toBe(largest);
  });
});

describe("the caps the web README lists in recorded mode", () => {
  it("names the change-note and send-preview windows that still apply there, with the code's numbers", () => {
    const caps = doc("apps/web/README.md");
    expect(caps).not.toMatch(/its only cap is/);
    expect(caps).toContain(`Nothing runs in recorded mode, so no run cap applies there; change notes (${REVISES_PER_HOUR.recorded} per network per hour), send previews and sends are still capped`);
    expect(caps).toContain(`Send previews: ${PREPARE_PER_HOUR} per network per hour in every mode`);
    expect(caps).toContain(`(${DEFAULT_DAILY_CAP} per network per UTC day by default, \`WALKUP_SEND_DAILY_CAP\`)`);
  });
});

describe("change notes on the recorded site", () => {
  it("allow more notes per network than live runs, since they call no API", () => {
    expect(REVISES_PER_HOUR.recorded).toBeGreaterThan(REVISES_PER_HOUR.live);
  });
});
