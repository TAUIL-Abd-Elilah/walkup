import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../run_arms";
import { parseBars, selectQueries } from "../bars";
import { parseCsv, parseCsvRows, toCsv } from "../csv";
import {
  ARMS,
  canonicalArm,
  CLUB_BRAND_NAMES,
  CLUB_DISPLAY_NAMES,
  CLUBS,
  fPrompt,
  lPrompt,
  PLACES_SEARCH_TOOL,
  SYSTEM_PROMPT,
  TOOL_BUDGET_MESSAGE,
} from "../protocol";
import { BARS_CSV } from "./fake-world";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ARMS_MD = read("../../ARMS.md");
const PLAN_MD = read("../../../../docs/preregistration/p1-plan.md");

describe("protocol constants are the sealed text", () => {
  it("system prompt, prompts and tool are verbatim from ARMS.md", () => {
    expect(ARMS_MD).toContain(SYSTEM_PROMPT);
    expect(ARMS_MD).toContain(fPrompt("<metro display name>", "<state>", "<club display name>"));
    expect(ARMS_MD).toContain(lPrompt("<club display name>", "<metro display name>", "<state>"));
    expect(ARMS_MD).toContain(JSON.stringify(PLACES_SEARCH_TOOL.description));
    const props = PLACES_SEARCH_TOOL.input_schema.properties as { query: { description: string } };
    expect(ARMS_MD).toContain(JSON.stringify(props.query.description));
    expect(ARMS_MD).toContain(TOOL_BUDGET_MESSAGE);
    expect(PLACES_SEARCH_TOOL.strict).toBe(true);
  });

  it("club display names and brand names match the contract and the plan", () => {
    for (const club of CLUBS) {
      expect(ARMS_MD).toContain(`\`${club}\` = "${CLUB_DISPLAY_NAMES[club]}"`);
      for (const name of CLUB_BRAND_NAMES[club]) expect(PLAN_MD).toContain(`"${name}"`);
    }
  });

  it("canonicalArm accepts the analyze.py spellings", () => {
    expect(canonicalArm("q_signal")).toBe("Q-signal");
    expect(canonicalArm("QPOP")).toBe("Q-pop");
    expect(canonicalArm("f")).toBe("F");
    expect(canonicalArm("Q-derby")).toBe("Q-derby");
    expect(() => canonicalArm("Q-other")).toThrow(/unknown arm/);
  });
});

describe("CSV", () => {
  it("round-trips quotes, commas and newlines like Python's csv module", () => {
    const text = toCsv(["a", "b", "c"], [{ a: 'say "hi"', b: "x,y", c: 1 }, { a: "", b: null, c: "line\nbreak" }]);
    expect(text).toBe('a,b,c\n"say ""hi""","x,y",1\n,,"line\nbreak"\n');
    expect(parseCsvRows(text)).toEqual([
      ["a", "b", "c"],
      ['say "hi"', "x,y", "1"],
      ["", "", "line\nbreak"],
    ]);
  });

  it("reads CRLF and a BOM", () => {
    const { header, records } = parseCsv("﻿x,y\r\n1,2\r\n");
    expect(header).toEqual(["x", "y"]);
    expect(records).toEqual([{ x: "1", y: "2" }]);
  });
});

describe("bars table and queries", () => {
  it("parses the synthetic table and builds (club, metro) queries", () => {
    const bars = parseBars(BARS_CSV);
    expect(bars).toHaveLength(11);
    expect(bars.find((b) => b.barKey === "a00000000005")?.metroPoint).toBeNull();
    const sel = selectQueries(bars, {});
    expect(sel.mode).toBe("full");
    expect(sel.bars).toHaveLength(11);
    expect(sel.queries.map((q) => q.key)).toEqual([
      "american_outlaws|3719000",
      "american_outlaws|9900001",
      "american_outlaws|9900002",
      "arsenal_america|9900001",
      "arsenal_america|9900002",
      "lfc_olsc|9900001",
      "lfc_olsc|9900002",
    ]);
    expect(sel.queries[1]?.metroDisplay).toBe("Exampleton");
  });

  it("limit and viability selections", () => {
    const bars = parseBars(BARS_CSV);
    const lim = selectQueries(bars, { limit: 2 });
    expect(lim.queries).toHaveLength(2);
    expect(lim.bars.map((b) => b.barKey).sort()).toEqual(["a00000000001", "a00000000002", "a00000000006"]);
    const via = selectQueries(bars, { viability: true });
    expect(via.queries.map((q) => q.key)).toEqual(["american_outlaws|3719000"]);
  });

  it("rejects bad tables", () => {
    expect(() => parseBars("bar_key,club\nx,american_outlaws\n")).toThrow(/missing columns/);
    const header = BARS_CSV.split("\n")[0];
    const row = BARS_CSV.split("\n")[1];
    expect(() => parseBars(`${header}\n${row}\n${row}\n`)).toThrow(/duplicate/);
    expect(() => parseBars(`${header}\n${row!.replace("american_outlaws", "some_club")}\n`)).toThrow(/unknown club/);
  });
});

describe("CLI arguments", () => {
  it("defaults to every arm in plan order and the private paths", () => {
    const a = parseArgs([], "/repo");
    expect(a.arms).toEqual([...ARMS]);
    expect(a.maxQlooCalls).toBe(900);
    expect(a.bars.replace(/\\/g, "/")).toMatch(/data\/private\/p1\/bars_full\.csv$/);
    expect(a.out.replace(/\\/g, "/")).toMatch(/evals\/out\/private$/);
  });

  it("parses --arms, --limit and --dry-run in both value styles", () => {
    const a = parseArgs(["--dry-run", "--limit", "5", "--arms=Q-signal,q_pop", "--max-qloo-calls=100"], "/repo");
    expect(a.dryRun).toBe(true);
    expect(a.limit).toBe(5);
    expect(a.arms).toEqual(["Q-pop", "Q-signal"]);
    expect(a.maxQlooCalls).toBe(100);
  });

  it("rejects bad input", () => {
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive integer/);
    expect(() => parseArgs(["--arms", "X"])).toThrow(/unknown arm/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--viability", "--limit", "2"])).toThrow(/cannot be combined/);
    expect(() => parseArgs(["--limit"])).toThrow(/needs a value/);
  });
});
