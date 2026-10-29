/**
 * The revise interpreter: strict tool schemas built from the sheet, the call
 * checker, the rules reader, and the model loop against a mock client (no
 * network). Synthetic names only.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_BAR_CATEGORIES } from "@walkup/engine";
import {
  buildReviseTools,
  categoriesInWords,
  checkReviseCall,
  createMemorySpendStore,
  describeReviseCall,
  mergeReviseCalls,
  readRevision,
  readRevisionByRules,
  REVISE_TOOL_NAMES,
  SpendGuard,
  splitClauses,
  type ReviseSummary,
} from "../src/index";
import { fakeMessage, mockClient, textBlock, toolUseBlock } from "./helpers";
import { createMemoryLedger } from "@walkup/contracts";

function summary(over: Partial<ReviseSummary> = {}): ReviseSummary {
  const cats = ["bar", "restaurant", "cafe", "record_store", "book_store", "clothing_store", "barber_shop", "beauty_salon", ...DEFAULT_BAR_CATEGORIES];
  return {
    show: { acts: ["Test Headliner"], venue: "Sample Hall", city: "Exampleton", date: "2026-11-28", weekday: "saturday", agePolicy: "21+" },
    settings: { allAges: false, streetTeamDays: ["thursday", "saturday"], radiusKm: 40, excludeCategories: [], excludeAreas: [] },
    areas: [
      { name: "North Example", geohash: "dn6m9q", partners: 6 },
      { name: "West Example", geohash: "dn6m9r", partners: 5 },
      { name: "Example-Central", geohash: "dn6m9s", partners: 4 },
      { name: "Riverside", geohash: "dn6m9t", partners: 0 },
    ],
    categories: [...new Set(cats)].map((key) => ({ key, partners: key === "bar" ? 4 : key === "cafe" ? 3 : 0, spots: key === "bar" ? 5 : 0 })),
    partners: 15,
    spots: 8,
    ...over,
  };
}

describe("tool schemas", () => {
  it("six strict tools, closed objects, every property required", () => {
    const tools = buildReviseTools(summary());
    expect(tools.map((t) => t.name)).toEqual([...REVISE_TOOL_NAMES]);
    for (const t of tools) {
      expect(t.strict).toBe(true);
      const s = t.input_schema as unknown as { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
      expect(s.additionalProperties).toBe(false);
      expect(s.required.sort()).toEqual(Object.keys(s.properties).sort());
    }
  });

  it("area and category enums come from the sheet", () => {
    const tools = buildReviseTools(summary());
    const areas = tools.find((t) => t.name === "exclude_areas")!.input_schema as { properties: { areas: { items: { enum: string[] } } } };
    expect(areas.properties.areas.items.enum).toEqual(["North Example", "West Example", "Example-Central", "Riverside", "dn6m9q", "dn6m9r", "dn6m9s", "dn6m9t"]);
    const cats = tools.find((t) => t.name === "exclude_partner_categories")!.input_schema as { properties: { categories: { items: { enum: string[] } } } };
    expect(cats.properties.categories.items.enum).toContain("record_store");
    expect(cats.properties.categories.items.enum).toContain("night_club");
  });
});

describe("categoriesInWords", () => {
  it("says each place type once, whatever the keys", () => {
    expect(categoriesInWords(["night_club", "nightclub"])).toBe("night clubs");
    expect(categoriesInWords(["night_club", "nightclub", "lounge", "Lounge"])).toBe("night clubs and lounges");
    expect(categoriesInWords(["cafe", "night_club", "cafe", "nightclub"])).toBe("cafes and night clubs");
    expect(categoriesInWords(["cafe", "night_club", "nightclub"])).not.toMatch(/night clubs.*night clubs/);
  });

  it("still groups every bar key the sheet knows", () => {
    const s = summary();
    expect(categoriesInWords([...DEFAULT_BAR_CATEGORIES, "nightclub", "night_club"], s)).not.toMatch(/night clubs.*night clubs/);
  });
});

describe("checkReviseCall", () => {
  const s = summary();
  it("accepts sheet values in any case and returns the sheet's spelling", () => {
    expect(checkReviseCall("exclude_areas", { areas: ["north example", "DN6M9R"] }, s)).toEqual({ ok: true, call: { tool: "exclude_areas", input: { areas: ["North Example", "dn6m9r"] } } });
  });
  it("refuses values that are not on the sheet, out-of-range radii and unknown tools", () => {
    expect(checkReviseCall("exclude_areas", { areas: ["Atlantis"] }, s).ok).toBe(false);
    expect(checkReviseCall("exclude_partner_categories", { categories: ["casino"] }, s).ok).toBe(false);
    expect(checkReviseCall("set_radius", { km: 2 }, s).ok).toBe(false);
    expect(checkReviseCall("set_radius", { km: 61 }, s).ok).toBe(false);
    expect(checkReviseCall("send_email", {}, s).ok).toBe(false);
    expect(checkReviseCall("set_all_ages", { allAges: "yes" }, s).ok).toBe(false);
  });
  it("puts days in week order", () => {
    expect(checkReviseCall("set_street_team_days", { days: ["saturday", "friday"] }, s)).toEqual({ ok: true, call: { tool: "set_street_team_days", input: { days: ["friday", "saturday"] } } });
  });
  it("merges repeated calls", () => {
    const merged = mergeReviseCalls([
      { tool: "exclude_areas", input: { areas: ["Riverside"] } },
      { tool: "set_radius", input: { km: 10 } },
      { tool: "exclude_areas", input: { areas: ["West Example"] } },
      { tool: "set_radius", input: { km: 12 } },
    ]);
    expect(merged).toEqual([
      { tool: "exclude_areas", input: { areas: ["Riverside", "West Example"] } },
      { tool: "set_radius", input: { km: 12 } },
    ]);
  });
  it("describes calls in plain words", () => {
    const bars = DEFAULT_BAR_CATEGORIES.filter((k) => s.categories.some((c) => c.key === k));
    expect(describeReviseCall({ tool: "exclude_partner_categories", input: { categories: [...bars, "cafe"] } }, s)).toBe("Left out bars and other drinking places and cafes");
    expect(describeReviseCall({ tool: "set_street_team_days", input: { days: ["saturday"] } }, s)).toBe("Street team works Saturday only");
    expect(describeReviseCall({ tool: "exclude_areas", input: { areas: ["dn6m9q"] } }, s)).toBe("Skipped North Example (dn6m9q)");
    expect(describeReviseCall({ tool: "set_all_ages", input: { allAges: false } }, s)).toBe("Cleared the all-ages mark; Ticketmaster still lists the show as age-restricted");
  });
});

describe("rules interpreter", () => {
  const s = summary();
  const bars = DEFAULT_BAR_CATEGORIES.filter((k) => s.categories.some((c) => c.key === k));
  const read = (note: string) => readRevisionByRules(s, note);

  it("splits clauses on punctuation and on 'and' before a new instruction only", () => {
    expect(splitClauses("All ages: no bars")).toEqual(["all ages", "no bars"]);
    expect(splitClauses("only friday and saturday")).toEqual(["only friday and saturday"]);
    expect(splitClauses("no bars and skip riverside")).toEqual(["no bars", "skip riverside"]);
    expect(splitClauses("no cafes within 2.5 km")).toEqual(["no cafes", "within 2.5 km"]);
  });

  it("All ages: no bars", () => {
    expect(read("All ages: no bars")).toEqual({
      calls: [
        { tool: "set_all_ages", input: { allAges: true } },
        { tool: "exclude_partner_categories", input: { categories: bars } },
      ],
      question: null,
    });
    expect(read("all-ages show")).toEqual({ calls: [{ tool: "set_all_ages", input: { allAges: true } }], question: null });
    expect(read("it's 21+ after all").calls).toEqual([{ tool: "set_all_ages", input: { allAges: false } }]);
  });

  it("family and under-21 notes set all ages without recursing", () => {
    const yes = [{ tool: "set_all_ages", input: { allAges: true } }];
    expect(read("family show").calls).toEqual(yes);
    expect(read("under 21s welcome").calls).toEqual(yes);
    expect(read("kids welcome").calls).toEqual(yes);
    const no = [{ tool: "set_all_ages", input: { allAges: false } }];
    for (const note of ["no under 21s", "no under-21s", "not for under 18s", "no family", "not family friendly"]) {
      expect(read(note).calls, note).toEqual(no);
    }
  });

  it("a note that both sets and clears all ages asks instead of letting the last part win", () => {
    for (const note of ["It's all ages, not 21+", "all ages (not 21+)", "No 21+ venues"]) {
      const r = read(note);
      expect(r.calls, note).toEqual([]);
      expect(r.question, note).toMatch(/all ages/);
    }
    expect(read("remove bars for the all ages crowd")).toEqual({
      calls: [
        { tool: "set_all_ages", input: { allAges: true } },
        { tool: "exclude_partner_categories", input: { categories: bars } },
      ],
      question: null,
    });
    expect(read("not all ages").calls).toEqual([{ tool: "set_all_ages", input: { allAges: false } }]);
  });

  it("merging keeps the more restrictive all-ages value", () => {
    expect(
      mergeReviseCalls([
        { tool: "set_all_ages", input: { allAges: true } },
        { tool: "set_all_ages", input: { allAges: false } },
      ]),
    ).toEqual([{ tool: "set_all_ages", input: { allAges: true } }]);
  });

  it("no bars, no cafes or record stores", () => {
    expect(read("no bars").calls).toEqual([{ tool: "exclude_partner_categories", input: { categories: bars } }]);
    expect(read("skip cafes or record stores").calls).toEqual([{ tool: "exclude_partner_categories", input: { categories: ["cafe", "record_store"] } }]);
    expect(read("no coffee shops, bookstores").calls).toEqual([{ tool: "exclude_partner_categories", input: { categories: ["cafe", "book_store"] } }]);
  });

  it("skip an area by name or geohash; a name that fits several areas asks", () => {
    expect(read("skip Riverside").calls).toEqual([{ tool: "exclude_areas", input: { areas: ["Riverside"] } }]);
    expect(read("not in west example").calls).toEqual([{ tool: "exclude_areas", input: { areas: ["West Example"] } }]);
    expect(read("drop dn6m9s").calls).toEqual([{ tool: "exclude_areas", input: { areas: ["dn6m9s"] } }]);
    expect(read("skip central").calls).toEqual([{ tool: "exclude_areas", input: { areas: ["Example-Central"] } }]);
    const amb = read("skip example");
    expect(amb.calls).toEqual([]);
    expect(amb.question).toMatch(/more than one area: North Example, West Example, Example-Central/);
  });

  it("only Saturday, Friday and Saturday, no Thursday", () => {
    expect(read("only Saturday").calls).toEqual([{ tool: "set_street_team_days", input: { days: ["saturday"] } }]);
    expect(read("street team on Sat and Fri").calls).toEqual([{ tool: "set_street_team_days", input: { days: ["friday", "saturday"] } }]);
    expect(read("no thursday").calls).toEqual([{ tool: "set_street_team_days", input: { days: ["saturday"] } }]);
    expect(read("no thursday or saturday").question).toMatch(/no days/);
    for (const n of ["Saturday only for the street team", "only Saturday for the street team", "Saturdays only for the street team", "have the street team work Saturday only", "our street team only works Saturday"]) {
      expect(read(n).calls, n).toEqual([{ tool: "set_street_team_days", input: { days: ["saturday"] } }]);
    }
    // "instead of" names a day to drop, never one to add.
    expect(read("Saturday instead of Thursday").calls).not.toContainEqual({ tool: "set_street_team_days", input: { days: ["thursday", "saturday"] } });
    // A day that is out, or let go, is a day to drop: never read as "only that day". The rules ask instead.
    for (const n of [
      "Saturday is out for our crew",
      "Our crew is out Saturday",
      "our crew is out on Saturday",
      "Thursday is out for our crew",
      "Saturday is out",
      "Saturday is out for us",
      "Saturday is out for the street team",
      "Let Saturday go",
      "Thursday can go",
      "Saturday is going out",
      "Thursday goes out",
    ]) {
      expect(read(n).calls, n).toEqual([]);
      expect(read(n).question, n).not.toBeNull();
    }
    expect(read("only go out on Saturday").calls).toEqual([{ tool: "set_street_team_days", input: { days: ["saturday"] } }]);
    expect(read("street team goes Saturday").calls).toEqual([{ tool: "set_street_team_days", input: { days: ["saturday"] } }]);
    expect(read("we are going out on Saturday").calls).toEqual([{ tool: "set_street_team_days", input: { days: ["saturday"] } }]);
    expect(read("crew goes out Thursday").calls).toEqual([{ tool: "set_street_team_days", input: { days: ["thursday"] } }]);
  });

  it("within 10 km, 6 miles; out of range asks", () => {
    expect(read("within 10 km").calls).toEqual([{ tool: "set_radius", input: { km: 10 } }]);
    expect(read("keep it within 6 miles").calls).toEqual([{ tool: "set_radius", input: { km: 9.7 } }]);
    expect(read("radius 25km").calls).toEqual([{ tool: "set_radius", input: { km: 25 } }]);
    const far = read("within 100 km");
    expect(far.calls).toEqual([]);
    expect(far.question).toMatch(/5 to 60 km/);
  });

  it("combines clauses", () => {
    expect(read("All ages, skip Riverside, only Saturday, within 15 km").calls).toEqual([
      { tool: "set_all_ages", input: { allAges: true } },
      { tool: "exclude_areas", input: { areas: ["Riverside"] } },
      { tool: "set_street_team_days", input: { days: ["saturday"] } },
      { tool: "set_radius", input: { km: 15 } },
    ]);
  });

  it("unknown notes give a plain question and no change, never a guess", () => {
    for (const note of ["make it better", "more indie vibes", "skip Atlantis", "", "closer to the room"]) {
      const r = read(note);
      expect(r.calls, note).toEqual([]);
      expect(r.question, note).toMatch(/\?$/);
      expect(r.question!).not.toMatch(/!/);
    }
    // One unclear part blocks the rest.
    expect(read("no bars, and paint it blue").calls).toEqual([]);
  });
});

describe("readRevision (model)", () => {
  const s = summary();

  it("without a client the rules read the note", async () => {
    const r = await readRevision(s, "only Saturday");
    expect(r).toMatchObject({ interpreter: "rules", fallback: "llm_off", calls: [{ tool: "set_street_team_days", input: { days: ["saturday"] } }], question: null });
  });

  it("request shape: strict tools, tool_choice auto, effort medium, fallback beta, no thinking or prefill", async () => {
    const m = mockClient([fakeMessage({ content: [toolUseBlock("t1", "set_all_ages", { allAges: true })], stop_reason: "tool_use" })]);
    const ledger = createMemoryLedger();
    const r = await readRevision(s, "All ages", { client: m.client, ledger });
    expect(r).toMatchObject({ interpreter: "model", fallback: null, calls: [{ tool: "set_all_ages", input: { allAges: true } }], ledgerRefs: ["L1"] });
    const req = m.calls[0]!;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.output_config?.effort).toBe("medium");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.fallbacks).toBe("default");
    expect("thinking" in req).toBe(false);
    expect(req.tools?.every((t) => "strict" in t && t.strict === true)).toBe(true);
    expect(req.messages).toHaveLength(1);
    expect(JSON.stringify(req.messages[0])).toContain("<note>");
    expect(ledger.entries()[0]?.kind).toBe("anthropic");
    // Every call was valid, so one model turn was enough.
    expect(m.calls).toHaveLength(1);
  });

  it("several tools in one turn; an invalid call goes back with is_error and the model fixes it", async () => {
    const m = mockClient([
      fakeMessage({
        content: [toolUseBlock("t1", "exclude_partner_categories", { categories: ["bar"] }), toolUseBlock("t2", "exclude_areas", { areas: ["Atlantis"] })],
        stop_reason: "tool_use",
      }),
      fakeMessage({ content: [toolUseBlock("t3", "exclude_areas", { areas: ["Riverside"] })], stop_reason: "tool_use" }),
    ]);
    const r = await readRevision(s, "no bars, skip the river area", { client: m.client });
    expect(r.calls).toEqual([
      { tool: "exclude_partner_categories", input: { categories: ["bar"] } },
      { tool: "exclude_areas", input: { areas: ["Riverside"] } },
    ]);
    const second = m.calls[1]!;
    const last = second.messages[second.messages.length - 1]!;
    expect(last.role).toBe("user");
    const blocks = last.content as { type: string; tool_use_id: string; is_error?: boolean }[];
    expect(blocks.map((b) => [b.tool_use_id, b.is_error === true])).toEqual([
      ["t1", false],
      ["t2", true],
    ]);
  });

  it("ask_operator: a question and no change", async () => {
    const m = mockClient([
      fakeMessage({ content: [toolUseBlock("t1", "ask_operator", { question: "Which area do you mean?" }), toolUseBlock("t2", "set_radius", { km: 10 })], stop_reason: "tool_use" }),
    ]);
    const r = await readRevision(s, "the far one", { client: m.client });
    expect(r.question).toBe("Which area do you mean?");
    expect(r.calls).toEqual([]);
    expect(r.made.map((c) => c.tool)).toEqual(["ask_operator", "set_radius"]);
  });

  it("no tool call: one re-prompt, then a question", async () => {
    const m = mockClient([fakeMessage({ content: "Hmm." }), fakeMessage({ content: "Still thinking." })]);
    const r = await readRevision(s, "do the thing", { client: m.client });
    expect(m.calls).toHaveLength(2);
    expect(r.interpreter).toBe("model");
    expect(r.calls).toEqual([]);
    expect(r.question).toMatch(/\?$/);
  });

  it("refusal, API error and the spend cap fall back to the rules, labelled", async () => {
    const refused = await readRevision(s, "no bars", { client: mockClient([fakeMessage({ content: [textBlock("partial")], stop_reason: "refusal" })]).client });
    expect(refused).toMatchObject({ interpreter: "rules", fallback: "refusal" });
    expect(refused.calls[0]?.tool).toBe("exclude_partner_categories");
    const failed = await readRevision(s, "no bars", { client: mockClient([new Error("boom")]).client });
    expect(failed).toMatchObject({ interpreter: "rules", fallback: "api_error" });
    const spend = new SpendGuard({ store: createMemorySpendStore(), dailyCapUsd: 0 });
    const m = mockClient([fakeMessage({ content: "x" })]);
    const capped = await readRevision(s, "no bars", { client: m.client, spend });
    expect(capped).toMatchObject({ interpreter: "rules", fallback: "over_budget" });
    expect(m.calls).toHaveLength(0);
  });
});
