import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CHAIN_MIN_LOCATIONS, liftBounds } from "@walkup/engine";
import { PRESET_IDS, PRESETS } from "@walkup/orchestrator";
import { excludeTagsFor } from "../../../packages/orchestrator/src/steps/partners";
import { HOUSE_MAX_SEARCHES } from "../../../packages/orchestrator/src/steps/resolve";
import SystemCardPage from "../app/system-card/page";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const doc = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

/** Page text as a reader sees it: tags dropped, the entities React writes decoded, spaces collapsed. */
function pageText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

describe("the docs give the call counts the code makes", () => {
  // One batched /entities call for the roster's Spotify ids, then a typed /search per headliner it missed.
  const usualActs = 1 + HOUSE_MAX_SEARCHES;

  it("the usual-crowd lookup is up to 1 + HOUSE_MAX_SEARCHES calls in the README, the system card and its page", () => {
    expect(usualActs).toBe(7);
    expect(doc("README.md")).toContain(`Up to ${usualActs} (1 \`/entities\`, then up to ${HOUSE_MAX_SEARCHES} \`/search\`; ${usualActs} on each live sheet), weekly per venue`);
    expect(doc("docs/system-card.md")).toContain(`Up to ${usualActs} (1 + up to ${HOUSE_MAX_SEARCHES} \`/search\`; ${usualActs} on each live sheet), weekly per venue`);
    const text = pageText(renderToStaticMarkup(createElement(SystemCardPage)));
    expect(text).toContain(`Up to ${usualActs} per venue a week (1 lookup, then up to ${HOUSE_MAX_SEARCHES} searches)`);
    for (const t of [doc("README.md"), doc("docs/system-card.md"), text]) expect(t).not.toMatch(/1-3, weekly per venue|1 to 3 per venue/);
  });

  it("the Agent Skill and its CLI give the same live call count as the README", () => {
    expect(doc("README.md")).toContain("A live hero run makes about 30 Qloo calls");
    expect(doc("skills/walkup/SKILL.md")).toContain("A fresh run makes about 30 Qloo calls");
    expect(doc("skills/walkup/scripts/walkup.mjs")).toContain("A fresh sheet makes about 30 Qloo calls");
    for (const path of ["skills/walkup/SKILL.md", "skills/walkup/scripts/walkup.mjs"]) expect(doc(path)).not.toContain("15 to 30");
  });
});

describe("the docs state the rules the code runs", () => {
  it("give the bounded lift formula, with the bounds the engine uses", () => {
    const { min, max } = liftBounds();
    expect([min, max]).toEqual([1 / 3, 3]);
    expect(doc("README.md")).toContain("(bill percentile + 50) / (usual-crowd percentile + 50) per geohash-6, so lift stays between 1/3 and 3");
    expect(doc("docs/spec.md")).toContain("so lift stays between 1/3 and 3");
    for (const path of ["README.md", "docs/spec.md"]) expect(doc(path)).not.toMatch(/`pct_rank\(bill(\.affinity)?\) \/ pct_rank\(house/);
  });

  it("name all four chain signals wherever chains are explained", () => {
    const signals = `a store-locator website, or the same name or website at ${CHAIN_MIN_LOCATIONS} or more places`;
    expect(doc("README.md")).toContain(signals);
    expect(doc("README.md")).toContain("**Chains are spotted by four signals.**");
    expect(doc("docs/system-card.md")).toContain(signals);
    expect(doc("docs/mapping-table.md")).toContain(`the same name or website is at ${CHAIN_MIN_LOCATIONS} or more places the run saw`);
    for (const path of ["README.md", "docs/system-card.md", "docs/mapping-table.md"]) {
      expect(doc(path)).not.toMatch(/spotted by name|`results\.entities\[\]\.name` is on the list/);
    }
    // Hooters is marked adult on the list and is never listed, so it is no example of a chain listed last.
    expect(doc("README.md")).not.toMatch(/National chains \([^)]*Hooters/);
    // The orchestrator adds the chain limit when any candidate is a chain, by any signal, not only a list match.
    const orch = doc("packages/orchestrator/README.md");
    expect(orch).toContain(`the same name or website at ${CHAIN_MIN_LOCATIONS} or more places, \`chainSignals\``);
    expect(orch).not.toContain("hand-kept-list limit when the list matched a candidate");
  });

  it("give the night-club exclusion's condition as excludeTagsFor runs it", () => {
    const nightClub = "urn:tag:category:place:night_club";
    const ctx = (legalAgeEnforced: boolean, allAges: boolean) =>
      ({ pins: { categories: { night_club: nightClub } }, bill: { legalAgeEnforced }, operator: { allAges } }) as unknown as Parameters<typeof excludeTagsFor>[0];
    // A 21+ show drops the exclusion only while the operator has not marked it all ages, with or without a note.
    expect(excludeTagsFor(ctx(true, false))).toEqual([]);
    expect(excludeTagsFor(ctx(true, true))).toEqual([nightClub]);
    expect(excludeTagsFor(ctx(false, false))).toEqual([nightClub]);
    const readme = doc("README.md");
    expect(readme).toContain("&filter.exclude.tags=<pinned night club URN, unless Ticketmaster lists the show as 21+ and the operator has not marked it all ages>");
    expect(readme).not.toContain("no note marked it all ages");
    expect(doc("config/README.md")).toContain("on shows that are not 21+ or that the operator marked all ages");
  });

  it("the mapping table's sponsor exclusion names the operator's all-ages setting and says nothing is pinned", () => {
    const tags = JSON.parse(readFileSync(join(ROOT, "config/tags.json"), "utf8")) as { sponsorExclusions: { urn: string | null }[] };
    expect(tags.sponsorExclusions.every((s) => s.urn === null)).toBe(true);
    expect(doc("docs/mapping-table.md")).toContain(
      "| Q13 | `Bill.legalAgeEnforced` not true, or `OperatorInputs.allAges` | `filter.exclude.tags=<sponsorExclusions URNs>` (none is pinned yet, so the parameter is not sent) |",
    );
  });

  it("the mapping table sends no group-sales segment and marks record stores as skipped", () => {
    const tags = JSON.parse(readFileSync(join(ROOT, "config/tags.json"), "utf8")) as { categories: { key: string; status: string }[] };
    expect(tags.categories.find((c) => c.key === "record_store")?.status).toBe("dropped");
    const table = doc("docs/mapping-table.md");
    expect(table).not.toContain("group-sales segment");
    expect(table).toContain("so `record_store` (dropped Oct 15) is skipped and the card says so");
    expect(table).not.toMatch(/`barber_shop`, `beauty_salon` if pinned/);
  });
});

describe("the docs list the presets the code has", () => {
  const live = PRESET_IDS.filter((id) => PRESETS[id].live !== null);

  it("the orchestrator README names every preset and the live runs", () => {
    expect(live).toEqual(["g1-a", "g1-b", "g4-a", "g4-b"]);
    const readme = doc("packages/orchestrator/README.md");
    expect(readme).toContain(`${PRESET_IDS.map((id) => id.toUpperCase()).join(", ")}: venue, the bill`);
    expect(readme).toContain("it is null for g2 and g3");
    expect(readme).toContain("Live mode ran on Oct 21 2026: four real Ticketmaster bills");
    expect(readme).not.toMatch(/no full live run|null for all four|until key day fills/);
  });

  it("the orchestrator README says which presets its tests run, and that G4-A and G4-B plan G1's fixture bills", () => {
    const fixtureShared = PRESET_IDS.filter((id) => PRESETS[id].fixtureSameAs !== undefined);
    expect(fixtureShared).toEqual(["g4-a", "g4-b"]);
    expect(fixtureShared.map((id) => PRESETS[id].fixtureSameAs)).toEqual(["g1-a", "g1-b"]);
    const ownShow = PRESET_IDS.filter((id) => PRESETS[id].fixtureSameAs === undefined);
    const extras = readFileSync(join(ROOT, "packages/orchestrator/test/extras.test.ts"), "utf8");
    expect(extras).toContain(`const IDS = [${ownShow.map((id) => `"${id}"`).join(", ")}] as const;`);
    const readme = doc("packages/orchestrator/README.md");
    expect(readme).toContain(
      `Tests run the four presets with a fixture show of their own (${ownShow.map((id) => id.toUpperCase()).join(", ")}; G4-A and G4-B plan G1-A's and G1-B's bills there) on the fixture world`,
    );
    expect(readme).toContain("`test/extras.test.ts` covers the sheet extras on those four presets");
    expect(readme).not.toMatch(/all four presets/);
  });

  it("the recorded-mode runbook lists the presets with a live show and says when \"Change something\" shows", () => {
    const deploy = doc("docs/deploy.md");
    expect(deploy).toContain(`Each preset with a live show (${live.map((id) => `\`${id}\``).join(", ")})`);
    expect(deploy).toContain("(its `live` block: g1-a, g1-b, g4-a and g4-b)");
    expect(deploy).toContain('"Change something" only on a sheet with revisions recorded for it');
    expect(deploy).not.toMatch(/no "Run it again" or "Change something"|for p in g1-a g1-b g2;/);
  });

  it("the spec and the definition of done describe the G3 sample as it is", () => {
    const spec = doc("docs/spec.md");
    expect(spec).not.toMatch(/`degraded: tag baseline`|10-12 partners|Three preset chips/);
    expect(spec).toContain("so there is no lift map (`degraded`, baseline `none`)");
    expect(doc("docs/definition-of-done.md")).toContain("| C04 | G3: no comedy baseline, so no lift map");
    expect(doc("docs/definition-of-done.md")).not.toMatch(/last committed when the result changed, on Oct 21 2026/);
  });
});

describe("the README's checks are the ones CI runs", () => {
  it("lists every CI command and needs no package the requirements file leaves out", () => {
    const readme = doc("README.md");
    const ci = doc(".github/workflows/ci.yml");
    for (const cmd of ["npx next build", "python data/gazetteer/test_build.py", 'node --test "skills/test/*.test.mjs" "config/test/*.test.mjs"', "node scripts/check-no-raw.mjs"]) {
      expect(ci).toContain(cmd);
      expect(readme).toContain(cmd);
    }
    expect(readme).toContain("python evals/p1/test_analyze.py && python evals/p1/test_collect.py");
    // pytest stays optional: the requirements file does not install it, so the README never runs it unconditionally.
    expect(readFileSync(join(ROOT, "evals/requirements.txt"), "utf8")).not.toMatch(/^pytest/m);
    expect(readme).not.toContain("python -m pip install -r evals/requirements.txt && python -m pytest evals");
  });
});

describe("the README's fresh-clone skip count (N15)", () => {
  // Every test that needs the git-ignored hosted sheets file: an `it.skipIf` whose condition names it, or each `it`
  // inside a `describe.skipIf` that does. Nine more are the qloo replay tests (fixtures/raw is git-ignored too).
  const dirs = ["apps/web/test", "packages/exports/test", "packages/mcp/test", "packages/orchestrator/test", "packages/engine/test", "scripts/test", "evals/product"];
  const files = dirs.flatMap((d) =>
    readdirSync(join(ROOT, d))
      .filter((f) => /\.test\.tsx?$/.test(f))
      .map((f) => `${d}/${f}`),
  );
  const PLANS_COND = /!existsSync\(PLANS(?:_FILE)?\)|!HAVE_PLANS\b/;
  const counted = files.flatMap((path) => {
    const src = readFileSync(join(ROOT, path), "utf8");
    if (!src.includes("deploy/vercel/plans.json")) return [];
    let n = 0;
    for (const m of src.matchAll(/\bit\.skipIf(\([^\n]*?\))\(/g)) if (PLANS_COND.test(m[1] as string)) n++;
    for (const m of src.matchAll(/^describe\.skipIf(\([^\n]*?\))\(/gm)) {
      if (!PLANS_COND.test(m[1] as string)) continue;
      const rest = src.slice((m.index ?? 0) + m[0].length);
      const end = rest.search(/^describe/m);
      n += [...(end < 0 ? rest : rest.slice(0, end)).matchAll(/^\s+it\(/gm)].length;
    }
    return n > 0 ? [{ path, n }] : [];
  });

  it("counts every test that skips without deploy/vercel/plans.json and names its file", () => {
    const readme = doc("README.md");
    const n = counted.reduce((a, c) => a + c.n, 0);
    expect(n).toBeGreaterThan(0);
    expect(readme).toContain(`In a fresh clone \`npm test\` reports ${9 + n} skipped. Nine are in \`packages/qloo/test/recorded.test.ts\``);
    expect(readme).toContain(`which makes ${10 + n}.`);
    for (const { path } of counted) expect(readme).toContain(`\`${path}\``);
  });
});
