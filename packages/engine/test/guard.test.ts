import { describe, expect, it } from "vitest";
import {
  collectFactNumbers,
  extractNumberTokens,
  findTextViolations,
  SALES_LABEL_PATTERNS,
  validateNarration,
  type NarrationFacts,
  type NarrationInput,
} from "../src/guard";

const E1 = "0a1b2c3d-1111-4222-8333-444455556666";
const E2 = "0A1B2C3D-AAAA-4BBB-8CCC-DDDDEEEEFFFF";
const E_UNKNOWN = "99999999-9999-4999-8999-999999999999";

const facts: NarrationFacts = {
  entityIds: [E1, E2],
  geohashes: ["dn6m9p", "dn6mdn"],
  numbers: [1850, 0.4127, 1.37, 12, -3, 21, 2026, 28, 10432],
  allowlistTagIds: ["urn:tag:genre:music:americana", "urn:tag:theme:qloo:road_trip"],
  allowlistTagNames: ["Americana", "90s R&B"],
  names: ["Club 21 Lounge", "The 5 Spot", "Christian's Tailgate", "East Nashville", "11:00-23:00"],
  deniedTagNames: ["Some Group"],
  deniedTagCount: 2,
  ledgerRefs: ["Q9", "Q10", "T1"],
};

function run(n: Partial<NarrationInput>, f: NarrationFacts = facts, opts = {}) {
  const narration: NarrationInput = { summary: "", tileWhy: [], partnerLines: [], templated: false, ...n };
  return validateNarration(narration, f, opts);
}

describe("extractNumberTokens", () => {
  it("normalises separators, percent, decimals, thousands", () => {
    const t = extractNumberTokens("1,850 seats, 41% and 0.41, 1.4x, 10k fans, 12 percent");
    expect(t.map((x) => [x.value, x.decimals, x.percent, x.thousands])).toEqual([
      [1850, 0, false, false],
      [41, 0, true, false],
      [0.41, 2, false, false],
      [1.4, 1, false, false],
      [10, 0, false, true],
      [12, 0, true, false],
    ]);
  });
  it("ignores digits glued to letters (ids, refs, codes)", () => {
    expect(extractNumberTokens("see Q9, B2B, I-95, dn6m9p, mp3").map((x) => x.value)).toEqual([]);
    expect(extractNumberTokens("4th and 90s and 7pm").map((x) => x.value)).toEqual([4, 90, 7]);
    expect(extractNumberTokens("-3 ranks").map((x) => x.value)).toEqual([3]);
  });
});

describe("validateNarration: numbers", () => {
  it("accepts facts in several spellings and rounded forms", () => {
    const ok = [
      "About 1,850 people.",
      "About 1850 people.",
      "41% of the map.",
      "0.41 of the map.",
      "Lift of 1.4x here.",
      "Lift of 1.37 here.",
      "Twelve or 12 spots.",
      "Down 3 ranks.",
      "Show is 21+.",
      "Nov 28, 2026.",
      "Over 10k fans.",
      "Over 10.4k fans.",
      "Just 2 blocks away.",
    ];
    const r = run({ summary: ok.join(" ") });
    expect(r.report.reasons).toEqual([]);
    expect(r.narration.summary).toBe(ok.join(" "));
  });
  it("drops sentences with numbers that are not facts", () => {
    const r = run({ summary: "We found 1,850 fans. Expect 2,000 people. Lift is 1.5x. 42% over-index. It sells 5 tickets." });
    expect(r.narration.summary).toBe("We found 1,850 fans.");
    expect(r.report.dropped).toBe(4);
    expect(r.report.reasons[0]).toMatch(/^summary sentence 2: number 2,000 not in this run's results$/);
  });
  it("trivial numbers are configurable and never cover percent or k", () => {
    expect(run({ summary: "Grab 3 friends." }).report.dropped).toBe(0);
    expect(run({ summary: "Grab 2 friends." }, facts, { trivialNumbers: [] }).report.dropped).toBe(1);
    expect(run({ summary: "Up 2%." }).report.dropped).toBe(1);
    expect(run({ summary: "About 5k." }).report.dropped).toBe(1);
    expect(run({ summary: "About 2k." }).report.dropped).toBe(0); // 1,850 rounds to 2 thousand
    expect(run({ summary: "Grab 7 friends." }, facts, { trivialNumbers: [7] }).report.dropped).toBe(0);
  });
  it("numbers inside known names and allowlisted tag names are not citations", () => {
    const r = run({
      summary: "Start at Club 21 Lounge and The 5 Spot. Fans of 90s R&B and Americana. Open 11:00-23:00.",
    });
    expect(r.report.reasons).toEqual([]);
  });
  it("non-finite facts are ignored", () => {
    const f = { ...facts, numbers: [Number.NaN, Infinity, 7] };
    expect(run({ summary: "7 spots." }, f).report.dropped).toBe(0);
  });
});

describe("validateNarration: ids, geohashes, tags, refs", () => {
  it("partner lines must cite a known entity id; inline ids are checked too", () => {
    const r = run({
      partnerLines: [
        { entityId: E1, text: "Over-indexes for this bill [Q9]." },
        { entityId: E2.toLowerCase(), text: "Ids compare case-insensitively." },
        { entityId: E_UNKNOWN, text: "Unknown entity." },
        { entityId: E1, text: `Pairs well with ${E_UNKNOWN}.` },
        { entityId: E1, text: `Pairs well with ${E2}.` },
      ],
    });
    expect(r.narration.partnerLines.map((p) => p.text)).toEqual([
      "Over-indexes for this bill [Q9].",
      "Ids compare case-insensitively.",
      `Pairs well with ${E2}.`,
    ]);
    expect(r.report.dropped).toBe(2);
    expect(r.report.reasons[0]).toContain(`entity ${E_UNKNOWN} not in this run`);
  });
  it("tile lines must cite a known geohash; inline geohash-like tokens are checked", () => {
    const r = run({
      tileWhy: [
        { geohash: "dn6m9p", text: "Fans of Americana cluster in East Nashville." },
        { geohash: "DN6MDN", text: "Next to dn6m9p." },
        { geohash: "dn6zzz", text: "Unknown tile." },
        { geohash: "dn6m9p", text: "Spills into dn6q2x too." },
        { geohash: "dn6m9p", text: "Between the river and the tracks." },
      ],
    });
    expect(r.narration.tileWhy.map((t) => t.text)).toEqual([
      "Fans of Americana cluster in East Nashville.",
      "Next to dn6m9p.",
      "Between the river and the tracks.",
    ]);
    expect(r.report.reasons).toEqual(["tileWhy[2]: tile dn6zzz not in this run", "tileWhy[3]: geohash dn6q2x not in this run"]);
  });
  it("tag URNs must be allowlisted; ledger refs must exist when a list is given", () => {
    expect(run({ summary: "Built on urn:tag:genre:music:americana." }).report.dropped).toBe(0);
    expect(run({ summary: "Built on urn:tag:genre:music:polka." }).report.reasons[0]).toContain("tag urn:tag:genre:music:polka not on the allowlist");
    expect(run({ summary: "See [Q9] and [T1]." }).report.dropped).toBe(0);
    expect(run({ summary: "See [Q42]." }).report.reasons[0]).toContain("ledger ref Q42 not in this run");
    const noRefs = { ...facts };
    delete noRefs.ledgerRefs;
    expect(run({ summary: "See [Q42]." }, noRefs).report.dropped).toBe(0);
  });
});

describe("validateNarration: policy", () => {
  it("drops denied terms and denied tag names without echoing them", () => {
    const r = run({
      summary: "Great for religious groups. Popular with Some Group fans. Fans of Americana.",
      partnerLines: [{ entityId: E1, text: "A lesbian bar." }],
    });
    expect(r.narration.summary).toBe("Fans of Americana.");
    expect(r.narration.partnerLines).toEqual([]);
    expect(r.report.dropped).toBe(3);
    expect(r.report.deniedTagCount).toBe(2 + 3);
    for (const reason of r.report.reasons) {
      expect(reason).toMatch(/denied term$/);
      expect(reason.toLowerCase()).not.toContain("religious");
      expect(reason.toLowerCase()).not.toContain("some group");
    }
  });
  it("known names are masked before the denied-term scan", () => {
    const r = run({ partnerLines: [{ entityId: E1, text: "Christian's Tailgate has the big screens." }] });
    expect(r.report.dropped).toBe(0);
  });
  it("whole-word keywords do not trip on ordinary words", () => {
    expect(run({ summary: "A terrace with grace." }).report.dropped).toBe(0);
    expect(run({ summary: "Watch the race here." }).report.dropped).toBe(1);
  });
  it("sales labels are dropped", () => {
    for (const s of ["This is a soft show.", "Sales are tracking behind.", "Tickets are soft right now.", "A slow seller.", "The show is tracking."]) {
      expect(run({ summary: s }).report.reasons, s).toEqual(["summary sentence 1: sales label"]);
    }
    expect(run({ summary: "Soft lighting and a cozy room." }).report.dropped).toBe(0);
    expect(SALES_LABEL_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("validateNarration: copy hooks and shape", () => {
  it("drops alcohol in copy hooks unless the show is 21+", () => {
    const hooks = [
      { text: "Americana and a cold beer.", tagIds: ["urn:tag:genre:music:americana"] },
      { text: "Americana all night.", tagIds: ["urn:tag:genre:music:americana"] },
    ];
    expect(run({ copyHooks: hooks }, facts, { legalAgeEnforced: false }).narration.copyHooks).toHaveLength(1);
    expect(run({ copyHooks: hooks }, facts, { legalAgeEnforced: null }).report.reasons).toEqual([
      "copyHooks[0]: alcohol in fan-facing copy on a show that is not 21+",
    ]);
    expect(run({ copyHooks: hooks }, facts, { legalAgeEnforced: true }).narration.copyHooks).toHaveLength(2);
    expect(run({ copyHooks: hooks }).narration.copyHooks).toHaveLength(2);
    // operator-facing partner lines may mention a bar's drinks
    expect(run({ partnerLines: [{ entityId: E1, text: "Craft beer bar." }] }, facts, { legalAgeEnforced: false }).report.dropped).toBe(0);
  });
  it("copy hooks need allowlisted tag ids and clean text", () => {
    const r = run({
      copyHooks: [
        { text: "Americana night, one more round.", tagIds: ["urn:tag:genre:music:americana"] },
        { text: "No tags cited.", tagIds: [] },
        { text: "Polka forever.", tagIds: ["urn:tag:genre:music:polka"] },
        { text: "Road trip energy for 99 fans.", tagIds: ["urn:tag:theme:qloo:road_trip"] },
      ],
    });
    expect(r.narration.copyHooks?.map((h) => h.text)).toEqual(["Americana night, one more round."]);
    expect(r.report.dropped).toBe(3);
    expect(r.report.reasons).toEqual([
      "copyHooks[1]: copy hook cites no allowlisted tag",
      "copyHooks[2]: tag urn:tag:genre:music:polka not on the allowlist",
      "copyHooks[3]: number 99 not in this run's results",
    ]);
  });
  it("does not mutate input, keeps templated flag, omits copyHooks when absent", () => {
    const input: NarrationInput = {
      summary: "Expect 9,999 fans.",
      tileWhy: [{ geohash: "nope00", text: "x" }],
      partnerLines: [],
      templated: true,
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    const r = validateNarration(input, facts);
    expect(input).toEqual(snapshot);
    expect(r.narration.templated).toBe(true);
    expect(r.narration.summary).toBe("");
    expect("copyHooks" in r.narration).toBe(false);
  });
  it("empty narration and empty facts", () => {
    const empty: NarrationFacts = { entityIds: [], geohashes: [], numbers: [], allowlistTagIds: [], allowlistTagNames: [] };
    const r = run({}, empty);
    expect(r.report).toEqual({ dropped: 0, reasons: [], deniedTagCount: 0 });
    expect(run({ summary: "Plain words only." }, empty).report.dropped).toBe(0);
    expect(run({ summary: "Expect 40 people." }, empty).report.dropped).toBe(1);
  });
  it("splits the summary on sentence ends and newlines", () => {
    const r = run({ summary: "First 1,850.\nSecond 777! Third? Fourth." });
    expect(r.narration.summary).toBe("First 1,850. Third? Fourth.");
  });
  it("findTextViolations reuses the same rules", () => {
    expect(findTextViolations("Fine text.", facts)).toEqual([]);
    expect(findTextViolations("Expect 777.", facts)).toEqual(["number 777 not in this run's results"]);
  });
});

describe("collectFactNumbers", () => {
  it("walks nested values, optionally reading numbers from strings", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    const nums = collectFactNumbers([{ x: 1.5, y: [2, { z: 3 }], m: new Map([["k", 4]]), s: new Set([5]) }, cyc, Number.NaN, "7 seats"]);
    expect(nums).toEqual([1, 1.5, 2, 3, 4, 5]);
    expect(collectFactNumbers(["1,850 seats", "10k fans"], { includeStrings: true })).toEqual([1850, 10000]);
  });
});

describe("regressions", () => {
  it("hyphenated and verb forms of sales labels are dropped", () => {
    for (const s of ["A soft-ticket date.", "Tickets are selling soft.", "Slow ticket sales so far.", "Sales are softer this week."]) {
      expect(run({ summary: s }).report.reasons, s).toEqual(["summary sentence 1: sales label"]);
    }
    expect(run({ summary: "Soft-serve and records nearby." }).report.dropped).toBe(0);
  });
  it("collectFactNumbers skips coordinates so they cannot vouch for invented counts", () => {
    const nums = collectFactNumbers([{ location: { lat: 36.1627, lon: -86.7816 }, Latitude: 1, lift: 2.1, distanceM: 400 }]);
    expect(nums).toEqual([2.1, 400]);
    const f: NarrationFacts = { ...facts, numbers: nums };
    expect(run({ summary: "Expect 36 fans." }, f).report.dropped).toBe(1);
    expect(collectFactNumbers([{ lat: 36.1 }], { skipKeys: [] })).toEqual([36.1]);
  });
  it("drinking venues count as alcohol in copy hooks on shows that are not 21+", () => {
    const hooks = [{ text: "Americana and a dive bar after.", tagIds: ["urn:tag:genre:music:americana"] }];
    expect(run({ copyHooks: hooks }, facts, { legalAgeEnforced: false }).narration.copyHooks).toEqual([]);
    expect(run({ copyHooks: hooks }, facts, { legalAgeEnforced: true }).narration.copyHooks).toHaveLength(1);
  });
});
