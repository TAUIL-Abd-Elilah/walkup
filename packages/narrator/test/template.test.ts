import { describe, expect, it } from "vitest";
import { guardNarration, isAllowedNumber, policyProblem, prepareRun, templateNarrate } from "../src/index";
import { makeInput } from "./helpers";

describe("templateNarrate", () => {
  it("is deterministic", () => {
    expect(templateNarrate(makeInput())).toEqual(templateNarrate(makeInput()));
  });

  it("cites only this run's ids and allowlisted tags", () => {
    const input = makeInput();
    const prepared = prepareRun(input);
    const res = templateNarrate(input);
    expect(res.templated).toBe(true);
    expect(res.tileWhy.map((t) => t.geohash)).toEqual(["dn6m9q", "dn6m9r"]);
    expect(res.partnerLines.map((l) => l.entityId)).toEqual(["E-P1", "E-P2"]);
    expect(res.copyHooks.length).toBeGreaterThan(0);
    expect(res.copyHooks.length).toBeLessThanOrEqual(3);
    for (const h of res.copyHooks) for (const id of h.tagIds) expect(prepared.ids.tagIds).toContain(id);
    expect(JSON.stringify(res)).not.toContain("test faith");
  });

  it("passes its own guard (no unlisted numbers, no policy words, no act names in hooks)", () => {
    const input = makeInput();
    const prepared = prepareRun(input);
    const res = templateNarrate(input);
    const guarded = guardNarration(
      { summary: res.summary, tileWhy: res.tileWhy, partnerLines: res.partnerLines, copyHooks: res.copyHooks },
      prepared,
    );
    expect(guarded.reasons).toEqual([]);
  });

  it("writes plain facts from the run", () => {
    const res = templateNarrate(makeInput());
    expect(res.summary).toContain("Test Headliner and Test Support at Sample Hall, Saturday, Nov 28.");
    expect(res.summary).toContain("about 1.8 times the room's usual crowd");
    expect(res.summary).not.toMatch(/\d\.\d+x/);
    expect(res.tileWhy[0]!.text).toContain("91st percentile for this crowd, 49th for the room's usual crowd.");
    expect(res.summary).not.toMatch(/\b(soft|tracking)\b/i);
  });

  it("handles an empty run", () => {
    const input = { ...makeInput(), tiles: [], partners: [], prePost: [], media: [], allowlistTags: [], compareTags: null };
    const res = templateNarrate(input);
    expect(res.summary).toContain("No area stands out on this run");
    expect(res.copyHooks).toEqual([]);
  });
});

describe("policy helpers", () => {
  it("allows rounded run numbers and percent forms, rejects others", () => {
    const allowed = { values: [1.8423, 0.12], literals: new Set(["1801"]) };
    expect(isAllowedNumber("1.84", allowed)).toBe(true);
    expect(isAllowedNumber("2", allowed)).toBe(true); // 1.8423 rounded to 0 decimals
    expect(isAllowedNumber("12", allowed)).toBe(true); // 0.12 as a percent
    expect(isAllowedNumber("1801", allowed)).toBe(true);
    expect(isAllowedNumber("37", allowed)).toBe(false);
  });

  it("ignores policy words inside protected names", () => {
    expect(policyProblem("Soft Spot Lounge is close.", ["Soft Spot Lounge"])).toBeNull();
    expect(policyProblem("Sales look soft.", [])).toMatch(/soft/);
    expect(policyProblem("Great night!", [])).toBe("exclamation mark");
  });
});

describe("age policy and identity tags", () => {
  const cocktails = { id: "urn:tag:menu_highlight:qloo:craft_cocktails", name: "craft cocktails" };
  const identity = { id: "urn:tag:customer_identity:qloo:test_identity", name: "test identity" };

  function withTags(legalAgeEnforced: boolean | null) {
    const input = makeInput();
    input.bill.legalAgeEnforced = legalAgeEnforced;
    input.compareTags!.a = [cocktails, identity, ...input.compareTags!.a];
    input.allowlistTags = [cocktails, identity, ...input.allowlistTags];
    return input;
  }

  it("keeps alcohol tags out of copy unless the ticketing age policy says 21+", () => {
    for (const age of [false, null]) {
      const input = withTags(age);
      const prepared = prepareRun(input);
      expect(prepared.ids.tagIds).not.toContain(cocktails.id);
      expect(prepared.deniedTagCount).toBe(3); // religion + identity + alcohol
      expect(JSON.stringify(templateNarrate(input))).not.toMatch(/cocktail/i);
    }
    const adult = prepareRun(withTags(true));
    expect(adult.ids.tagIds).toContain(cocktails.id);
    expect(adult.deniedTagCount).toBe(2);
  });

  it("never lets customer-identity tags into the allowlist", () => {
    const prepared = prepareRun(withTags(true));
    expect(prepared.ids.tagIds).not.toContain(identity.id);
    expect(JSON.stringify(templateNarrate(withTags(true)))).not.toContain("test identity");
  });

  it("guard drops alcohol words on a show that is not 21+, and allows them on a 21+ show", () => {
    const draft = {
      summary: "Plain summary.",
      tileWhy: [],
      partnerLines: [{ entityId: "E-P1", text: "Record store near a bar with happy hour." }],
      copyHooks: [{ text: "Test folk and cold beer at Sample Hall.", tagIds: ["urn:tag:genre:music:test_folk"] }],
    };
    const allAges = guardNarration(draft, prepareRun(withTags(false)));
    expect(allAges.partnerLines).toEqual([]);
    expect(allAges.copyHooks).toEqual([]);
    expect(allAges.reasons.join("\n")).toMatch(/alcohol word/);
    const adult = guardNarration(draft, prepareRun(withTags(true)));
    expect(adult.partnerLines).toHaveLength(1);
    expect(adult.copyHooks).toHaveLength(1);
  });
});

describe("denylist shared with the engine", () => {
  it("denies identity, religion and health keyword tags that sit outside the denied namespaces", async () => {
    const { isDeniedTag, cleanAllowlist } = await import("../src/index");
    const media = [
      { id: "urn:tag:keyword:media:test_heritage", name: "African American" },
      { id: "urn:tag:keyword:media:test_denomination", name: "Baptist church" },
      { id: "urn:tag:keyword:media:test_health", name: "Mental illness" },
    ];
    for (const t of media) expect(isDeniedTag(t)).toBe(true);
    const ok = { id: "urn:tag:genre:music:americana", name: "Americana" };
    const res = cleanAllowlist([...media, ok]);
    expect(res.allowed).toEqual([ok]);
    expect(res.deniedCount).toBe(3);
  });

  it("drops narration lines that use an engine-denied term, without repeating it", () => {
    const p = policyProblem("Popular with the Hispanic crowd near the river.", []);
    expect(p).not.toBeNull();
    expect(p!.toLowerCase()).not.toContain("hispanic");
    expect(policyProblem("Americana fans cluster near the river.", [])).toBeNull();
  });
});
