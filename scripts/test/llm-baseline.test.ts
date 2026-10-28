/**
 * The Claude-alone baseline's pure parts (scripts/llm-baseline-lib.ts), on synthetic sheets and places only.
 */
import { describe, expect, it } from "vitest";
import type { LedgerEntry, QlooEntity, StreetSheet } from "@walkup/contracts";
import {
  addCounts,
  answerSchema,
  buildPrompt,
  chainFlags,
  chainPool,
  checkName,
  countChecks,
  extractBill,
  kmText,
  longDate,
  namesMatch,
  parseAnswer,
  partnerSearches,
  pickMatch,
  resultSentences,
  stripNote,
  topMiss,
  walkupCounts,
  type AreaAsk,
  type BillAsk,
  type Counts,
  type NameCheck,
  type ReturnedPlace,
} from "../llm-baseline-lib";

const OPEN_WEEK = {
  thursday: [{ opens: "T11:00:00", closes: "T22:00:00", closed: false }],
  saturday: [{ opens: "T11:00:00", closes: "T23:00:00", closed: false }],
};

function place(id: string, name: string, lat: number, lon: number, props: Record<string, unknown> = {}): QlooEntity {
  return { entityId: id, name, subtype: "urn:entity:place", popularity: 0.5, affinity: null, tags: [], properties: { hours: OPEN_WEEK, ...props }, location: { lat, lon } };
}

function ledger(note: string, point: string, radius: number): LedgerEntry {
  return {
    id: "Q1",
    kind: "qloo",
    method: "GET",
    endpoint: "/v2/insights",
    params: { "filter.location": point, "filter.location.radius": radius },
    httpStatus: 200,
    envelopeStatus: "ok",
    latencyMs: 1,
    bytes: 1,
    cacheHit: false,
    resultCount: 1,
    curl: "",
    startedAt: "2026-10-21T00:00:00Z",
    note,
  };
}

/** A two-area synthetic sheet: area 1 widened from 2,000 m to 3,500 m, area 2 at 2,000 m. */
function sheet(): StreetSheet {
  const partner = (id: string, name: string, tile: string, category: string, lat: number, lon: number, chain = false) => ({
    entity: place(id, name, lat, lon),
    tileGeohash: tile,
    category,
    chain,
    address: "1 Example St",
  });
  return {
    bill: {
      acts: [
        { name: "Test Headliner", role: "headliner" },
        { name: "Test Opener", role: "support" },
      ],
      venue: { name: "Sample Hall", city: "Exampleton", state: "EX", lat: 40, lon: -75 },
      date: "2027-02-28",
      weekday: "sunday",
    },
    operator: { streetTeamDays: ["thursday", "saturday"] },
    ledger: [
      ledger("node Q9 partners, tile 1", "POINT(-75.01 40.01)", 2000),
      ledger("node Q9 house twin, tile 1", "POINT(-75.01 40.01)", 2000),
      ledger("node Q9 partners, tile 2", "POINT(-75.05 40.05)", 2000),
      ledger("node Q9 partners, tile 1 (3,500 m)", "POINT(-75.01 40.01)", 3500),
    ],
    cards: {
      liftMap: {
        results: {
          tiles: [
            { geohash: "aaaaaa", lat: 40.01, lon: -75.01, lift: 2, billPct: 0.9, housePct: 0.2, popularityPct: 0.5, name: "North Example" },
            { geohash: "bbbbbb", lat: 40.05, lon: -75.05, lift: 1.8, billPct: 0.8, housePct: 0.2, popularityPct: 0.5, name: "West Example" },
          ],
        },
      },
      partners: {
        results: [
          partner("p1", "Corner Cafe", "aaaaaa", "cafe", 40.011, -75.011),
          partner("p2", "Blue Door Bar", "aaaaaa", "bar", 40.012, -75.01),
          partner("p3", "Second Cafe", "aaaaaa", "cafe", 40.01, -75.012),
          partner("p4", "Brand Coffee", "bbbbbb", "cafe", 40.05, -75.051, true),
        ],
      },
    },
  } as unknown as StreetSheet;
}

function bill(): BillAsk {
  return extractBill("test", "plan-1", sheet());
}

describe("extractBill", () => {
  it("reads areas, search points, widened radii and types from the sheet", () => {
    const b = bill();
    expect(b.checkDay).toBe("thursday");
    expect(b.streetTeamDays).toEqual(["thursday", "saturday"]);
    expect(b.acts).toEqual(["Test Headliner", "Test Opener"]);
    expect(b.areas.map((a) => [a.area, a.label, a.radiusM, a.asked])).toEqual([
      [1, "North Example", 3500, 3],
      [2, "West Example", 2000, 1],
    ]);
    expect(b.areas[0]!.types).toEqual([
      { key: "cafe", label: "cafe", count: 2 },
      { key: "bar", label: "bar", count: 1 },
    ]);
    const w = b.areas[1]!.walkup[0]!;
    expect(w).toMatchObject({ name: "Brand Coffee", chain: true, isClosed: false, dayStatus: "open" });
    expect(w.distanceM).toBeLessThan(150);
  });

  it("refuses a partner area with no partner search in the ledger", () => {
    const s = sheet();
    (s as unknown as { ledger: LedgerEntry[] }).ledger = [];
    expect(() => extractBill("test", "plan-1", s)).toThrow(/no partner search/);
  });

  it("keeps the last (widened) request per tile", () => {
    const m = partnerSearches(sheet().ledger);
    expect(m.get(1)).toEqual({ lat: 40.01, lon: -75.01, radiusM: 3500 });
    expect(m.get(2)?.radiusM).toBe(2000);
  });
});

describe("prompt", () => {
  it("is the protocol's template, filled in", () => {
    const b = bill();
    const p = buildPrompt(b, b.areas[0]!);
    expect(p.system).toContain("You have no tools and no web access.");
    expect(p.user).toBe(
      [
        "Show: Test Headliner and Test Opener at Sample Hall, Exampleton, EX, on Sunday, February 28, 2027.",
        "The street team goes out on Thursday and Saturday before the show.",
        "",
        "Area: North Example. Only places within 3.5 km of latitude 40.01, longitude -75.01.",
        "",
        "Name exactly 3 local businesses in this area where the team could ask to leave flyers: places this show's fans are likely to go, open on Thursday and Saturday. No national chains. Give exactly this many of each type:",
        "- cafe: 2",
        "- bar: 1",
        "",
        'Answer with JSON only, in this shape: {"places": [{"name": "...", "type": "...", "address": "... or null", "reason": "one short line"}]}.',
        '"type" is one of: cafe, bar. Real places only.',
      ].join("\n"),
    );
  });

  it("limits the type to the area's types in the schema", () => {
    const s = answerSchema(bill().areas[0]!) as { properties: { places: { items: { properties: { type: { enum: string[] } } } } } };
    expect(s.properties.places.items.properties.type.enum).toEqual(["cafe", "bar"]);
  });

  it("formats dates and radii", () => {
    expect(longDate("2026-12-30", "wednesday")).toBe("Wednesday, December 30, 2026");
    expect(kmText(2000)).toBe("2");
    expect(kmText(3500)).toBe("3.5");
  });
});

describe("parseAnswer", () => {
  it("keeps distinct non-empty names up to the number asked", () => {
    const text = JSON.stringify({
      places: [
        { name: " A Place ", type: "cafe", address: null, reason: "r" },
        { name: "", type: "cafe", address: null, reason: "blank" },
        { name: "a place", type: "cafe", address: null, reason: "repeat" },
        { name: "B Place", type: "bar", address: "1 Main St", reason: "r" },
        { name: "C Place", type: "bar", address: null, reason: "extra" },
      ],
    });
    const p = parseAnswer(text, 2)!;
    expect(p.places.map((x) => x.name)).toEqual(["A Place", "B Place"]);
    expect(p.places[1]!.address).toBe("1 Main St");
    expect(p).toMatchObject({ rawCount: 5, repeatsInAnswer: 1, extra: 1 });
  });

  it("reads a fenced answer and rejects anything that is not the shape", () => {
    expect(parseAnswer('```json\n{"places": []}\n```', 3)?.places).toEqual([]);
    expect(parseAnswer('{"places": [', 3)).toBeNull();
    expect(parseAnswer('{"items": []}', 3)).toBeNull();
  });
});

describe("name match", () => {
  it("follows the protocol's rule", () => {
    expect(namesMatch("FitzGerald's", "FitzGerald's Nightclub")).toBe(true);
    expect(namesMatch("Busboys & Poets", "Busboys and Poets")).toBe(true);
    expect(namesMatch("The Pub", "Irish Pub")).toBe(false);
    expect(namesMatch("Coffee Shop", "Busy Coffee Shop")).toBe(false);
    expect(namesMatch("Laurel Tap House (unverified)", "Laurel Tap House")).toBe(true);
    expect(namesMatch("Maketto", "Ben's Chili Bowl")).toBe(false);
  });

  it("picks the nearest matching result", () => {
    const far = place("f", "Corner Cafe", 40.2, -75.2);
    const near = place("n", "Corner Cafe", 40.011, -75.011);
    const other = place("o", "Other Place", 40.01, -75.01);
    const m = pickMatch("Corner Cafe", [far, other, near], { lat: 40.01, lon: -75.01 })!;
    expect(m.entity.entityId).toBe("n");
    expect(pickMatch("Nowhere", [far, near], { lat: 40, lon: -75 })).toBeNull();
  });

  it("strips a trailing note for the exploratory search only", () => {
    expect(stripNote("Laurel Tap House (unverified)")).toBe("Laurel Tap House");
    expect(stripNote("Pho (Tysons) Corner")).toBe("Pho (Tysons) Corner");
    expect(stripNote("(unverified)")).toBe("(unverified)");
  });
});

describe("checkName", () => {
  const area = (): AreaAsk => bill().areas[0]!;
  const ret = (name: string): ReturnedPlace => ({ name, type: "cafe", address: null, reason: "r" });
  const run = (e: QlooEntity | null, chains = new Map<string, { reason: string }>(), seen = new Set<string>(), name = e?.name ?? "Ghost Cafe"): NameCheck => {
    const a = area();
    return checkName(
      { area: a, place: ret(name), match: e ? pickMatch(name, [e], a) : null, checkDay: "thursday", otherDays: ["saturday"] },
      chains,
      new Set(["p1"]),
      seen,
    );
  };

  it("marks each first failing check in the protocol's order", () => {
    expect(run(null).outcome).toBe("not_found");
    expect(run(place("x", "Far Cafe", 40.2, -75.2)).outcome).toBe("outside_area");
    expect(run(place("x", "Shut Cafe", 40.01, -75.01, { is_closed: true })).outcome).toBe("closed");
    const thuClosed = place("x", "Weekend Cafe", 40.01, -75.01, { hours: { thursday: [{ closed: true }], saturday: OPEN_WEEK.saturday } });
    const c = run(thuClosed);
    expect(c.outcome).toBe("not_open");
    expect(c.otherDays).toEqual({ saturday: "open" });
    const brand = place("b", "Brand Coffee", 40.01, -75.01);
    expect(run(brand, new Map([["b", { reason: "list" }]])).outcome).toBe("chain");
    const seen = new Set(["r"]);
    expect(run(place("r", "Repeat Cafe", 40.01, -75.01), new Map(), seen).outcome).toBe("repeat");
    expect(run(place("u", "Fine Cafe", 40.01, -75.01)).outcome).toBe("usable");
  });

  it("counts a place with no hours listed as usable, with its hours unknown", () => {
    const c = run(place("u", "Quiet Cafe", 40.01, -75.01, { hours: undefined }));
    expect(c.outcome).toBe("usable");
    expect(c.dayStatus).toBe("unknown");
  });

  it("finds Walkup's picks by Qloo place or by name in the same area", () => {
    expect(run(place("p1", "Corner Cafe", 40.011, -75.011)).onWalkupList).toBe(true);
    expect(run(null, new Map(), new Set(), "Blue Door Bar").onWalkupList).toBe(true);
    expect(run(null, new Map(), new Set(), "Red Door").onWalkupList).toBe(false);
  });
});

describe("chain pool", () => {
  it("keeps results inside their searched area, once each, and flags chains by the existing rule", () => {
    const a = bill().areas[1]!; // 2,000 m around 40.05, -75.05
    const inside = [1, 2, 3].map((i) => place(`s${i}`, "Shop Brand", 40.05 + i * 0.001, -75.05));
    const outside = place("far", "Shop Brand", 40.3, -75.3);
    const pool = chainPool([
      { area: a, results: [...inside, outside] },
      { area: a, results: [inside[0]!] },
    ]);
    expect(pool.map((e) => e.entityId).sort()).toEqual(["s1", "s2", "s3"]);
    const flags = chainFlags(pool, { chains: [] });
    expect(flags.get("s1")?.reason).toBe("locations");
    const listed = chainFlags([place("sb", "Starbucks Coffee Company", 40.05, -75.05)], { chains: [{ name: "Starbucks" }] });
    expect(listed.get("sb")?.reason).toBe("list");
  });
});

describe("counts and sentences", () => {
  function counts(over: Partial<Counts>): Counts {
    const c = countChecks(10, []);
    return { ...c, ...over, byOutcome: { ...c.byOutcome, ...(over.byOutcome ?? {}) } };
  }

  it("counts checks and adds bills", () => {
    const b = bill();
    const a = b.areas[0]!;
    const mk = (name: string, e: QlooEntity | null) =>
      checkName({ area: a, place: { name, type: "cafe", address: null, reason: "" }, match: e ? pickMatch(name, [e], a) : null, checkDay: "thursday", otherDays: [] }, new Map(), new Set(), new Set());
    const c = countChecks(3, [mk("Ghost", null), mk("Far Cafe", place("f", "Far Cafe", 41, -76)), mk("Fine Cafe", place("u", "Fine Cafe", 40.01, -75.01))]);
    expect(c).toMatchObject({ asked: 3, returned: 3, foundInQloo: 2, foundInArea: 1, notFound: 1, outsideArea: 1, usable: 1 });
    expect(addCounts(c, c)).toMatchObject({ asked: 6, usable: 2, byOutcome: { not_found: 2, outside_area: 2, usable: 2 } });
  });

  it("uses the protocol's words for each outcome", () => {
    const walkup = walkupCounts(bill(), { found: 4, inArea: 3 });
    expect(walkup).toEqual({ listed: 4, chains: 1, usable: 3, calibrationFound: 4, calibrationInArea: 3 });
    const worse = resultSentences(counts({ asked: 4, returned: 4, usable: 1, onWalkupList: 1, byOutcome: { usable: 1, not_found: 2, outside_area: 1, closed: 0, not_open: 0, chain: 0, repeat: 0 } }), walkup, "Thursday");
    expect(worse).toEqual([
      "Asked for the same 4 places in the same areas, Claude alone named 1 that Qloo finds in the area, not marked closed, not closed on Thursday and not a national chain. Walkup's list has 3 of 4.",
      "On this check, Claude alone did worse than Walkup.",
      "The most common miss: not found in Qloo (2 names of 4).",
      "1 of Claude's 4 names are also on Walkup's list.",
      "The same name search found 3 of Walkup's 4 picks in their areas, so a name it misses is not proof that the place does not exist.",
    ]);
    expect(resultSentences(counts({ usable: 3 }), walkup, "Thursday")[1]).toBe("On this check, Claude alone did as well as Walkup.");
    expect(resultSentences(counts({ usable: 4 }), walkup, "Thursday")[1]).toBe("On this check, Claude alone did better than Walkup.");
    expect(resultSentences(counts({ usable: 4 }), walkup, "Thursday")[2]).toBe("Every name passed.");
  });

  it("breaks a tie between miss reasons toward the earlier check", () => {
    expect(topMiss(counts({ byOutcome: { usable: 0, not_found: 2, outside_area: 2, closed: 0, not_open: 0, chain: 0, repeat: 0 } }))).toEqual({ outcome: "not_found", count: 2 });
    expect(topMiss(counts({}))).toBeNull();
  });
});
