/**
 * Parity with the sealed Python helpers. Expected values were produced by running
 * evals/p1/matching.py, evals/p1/centroids.py and CPython 3.11's random module on these
 * (invented) inputs.
 */
import { describe, expect, it } from "vitest";
import { metroDisplayName } from "../protocol";
import { PyRandom } from "../pyrandom";
import { extractZip, hasStreetNumber, haversineM, nameSimilarity, normalizeName, sequenceRatio } from "../similarity";

const PY_NORMALIZE: [string, string][] = [
  ["The Example Tavern", "example tavern"],
  ["Example Tavern & Grill", "example tavern and grill"],
  ["O'Malley's Pub", "omalleys pub"],
  ["Café Ñandú", "cafe nandu"],
  ["Kneipe Straße", "kneipe strasse"],
  ["The Pub", "pub"],
  ["", ""],
  ["Mc Example's", "mc examples"],
  ["Half-Time Lounge", "half time lounge"],
  ["Corner Kick Bar & Kitchen", "corner kick bar and kitchen"],
];

const PY_SIMILARITY: [string, string, number][] = [
  ["The Example Tavern", "Example Tavern", 1.0],
  ["Example Tavern & Grill", "Example Tavern and Grill", 1.0],
  ["O'Malley's Pub", "OMalleys Pub", 1.0],
  ["Boot Room", "Boot Room and Beer Study Durham", 1.0],
  ["Café Ñandú", "Cafe Nandu", 1.0],
  ["Sample Sports Bar", "Sample Sport Bar", 0.969697],
  ["Fictional Arms", "Arms Fictional", 1.0],
  ["Kneipe Straße", "Kneipe Strasse", 1.0],
  ["The Pub", "Pub at the Mill", 0.333333],
  ["Lantern House", "Lantern Hall", 0.72],
  ["", "", 1.0],
  ["A", "", 0.0],
  ["Riverside Taproom", "Riverbend Taproom", 0.823529],
  ["Mc Example's", "McExamples", 0.952381],
  ["Goal Line Saloon", "The Goal Line", 1.0],
  ["Twelfth Man Tavern", "12th Man Tavern", 0.787879],
  ["Half-Time Lounge", "Halftime Lounge", 0.967742],
  ["Corner Kick Bar & Kitchen", "Corner Kick", 1.0],
  ["The Penalty Box", "Penalty Box Pub", 1.0],
  ["abcabcabc xyz", "xyz abcabc", 0.869565],
];

describe("name matching (port of evals/p1/matching.py)", () => {
  it.each(PY_NORMALIZE)("normalizeName(%j) = %j", (input, want) => {
    expect(normalizeName(input)).toBe(want);
  });

  it.each(PY_SIMILARITY)("nameSimilarity(%j, %j) = %d", (a, b, want) => {
    expect(nameSimilarity(a, b)).toBe(want);
  });

  it("is symmetric and bounded", () => {
    for (const [a, b] of PY_SIMILARITY) {
      expect(nameSimilarity(b, a)).toBe(nameSimilarity(a, b));
      expect(nameSimilarity(a, b)).toBeGreaterThanOrEqual(0);
      expect(nameSimilarity(a, b)).toBeLessThanOrEqual(1);
    }
  });

  it("sequenceRatio follows difflib (no junk heuristic)", () => {
    expect(sequenceRatio("abcd", "bcde")).toBeCloseTo(0.75, 12);
    expect(sequenceRatio("", "")).toBe(1);
    // autojunk would drop popular characters in strings of 200+; autojunk=False keeps them.
    const long = "a".repeat(250);
    expect(sequenceRatio(long, long)).toBe(1);
  });

  it("haversineM matches matching.haversine_m", () => {
    expect(haversineM(36.16, -86.78, 36.17, -86.79)).toBeCloseTo(1429.0913091977804, 6);
    expect(haversineM(29.76, -95.37, 29.98, -95.1)).toBeCloseTo(35724.246451968414, 6);
  });

  it("hasStreetNumber is publish_sample.py's ^\\s*\\d test", () => {
    expect(hasStreetNumber("101 Example St")).toBe(true);
    expect(hasStreetNumber("  9 Example St")).toBe(true);
    expect(hasStreetNumber("Example Plaza, Exampleton")).toBe(false);
    expect(hasStreetNumber("")).toBe(false);
  });

  it("extractZip reads only a trailing ZIP, never a street number", () => {
    expect(extractZip("101 Example St, Exampleton, TX, 75001")).toBe("75001");
    expect(extractZip("101 Example St, Exampleton, TX 75001-1234")).toBe("75001");
    expect(extractZip("Exampleton, TX 75009")).toBe("75009");
    expect(extractZip("101 Example St, Exampleton, TX 75001, USA")).toBe("75001");
    expect(extractZip("340 N. 6th Ave., Tucson AZ 85705")).toBe("85705");
    expect(extractZip("12345 Example St, Exampleton, TX")).toBeNull();
    expect(extractZip("Example Plaza")).toBeNull();
    expect(extractZip(null)).toBeNull();
  });
});

describe("metroDisplayName (port of centroids.metro_display_name)", () => {
  it.each([
    ["Nashville-Davidson metropolitan government (balance)", "Nashville"],
    ["Durham city", "Durham"],
    ["Brick township", "Brick"],
    ["Louisville/Jefferson County metro government (balance)", "Louisville"],
    ["Exampleton CDP", "Exampleton"],
    ["Sample village", "Sample"],
    ["Houston city", "Houston"],
    ["Lexington-Fayette urban county", "Lexington"],
    ["Anchorage municipality", "Anchorage"],
  ])("%s -> %s", (input, want) => {
    expect(metroDisplayName(input)).toBe(want);
  });
});

describe("PyRandom (CPython random.Random(20261013))", () => {
  it("getrandbits(32) stream", () => {
    const r = new PyRandom(20261013);
    expect([0, 1, 2, 3, 4].map(() => r.getrandbits(32))).toEqual([2621356976, 1963387146, 830507039, 2469115270, 3775655191]);
  });

  const pop = (n: number): string[] => Array.from({ length: n }, (_, i) => `q${String(i).padStart(3, "0")}`);

  it("sample, pool branch", () => {
    expect(new PyRandom(20261013).sample(pop(40), 7)).toEqual(["q039", "q029", "q012", "q036", "q020", "q030", "q006"]);
    expect(new PyRandom(20261013).sample(pop(50), 3)).toEqual(["q039", "q029", "q012"]);
    expect(new PyRandom(20261013).sample(pop(10), 10)).toEqual(["q009", "q007", "q003", "q004", "q005", "q002", "q008", "q000", "q001", "q006"]);
    expect(new PyRandom(20261013).sample(pop(400), 300).slice(0, 10)).toEqual([
      "q312", "q234", "q099", "q294", "q361", "q167", "q242", "q049", "q212", "q318",
    ]);
  });

  it("sample, set branch", () => {
    expect(new PyRandom(20261013).sample(pop(393), 5)).toEqual(["q312", "q234", "q099", "q294", "q361"]);
    const ints = Array.from({ length: 1000 }, (_, i) => i);
    expect(new PyRandom(20261013).sample(ints, 25).slice(0, 8)).toEqual([624, 468, 198, 588, 900, 981, 933, 722]);
  });

  it("rejects an impossible sample", () => {
    expect(() => new PyRandom(1).sample(pop(3), 4)).toThrow();
  });
});
