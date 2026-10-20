import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createMemoryLedger,
  DENIED_TAG_KEYWORDS,
  DENIED_TAG_PREFIXES,
  LIMITS_EVERY_SHEET,
  REVISION_CHANGE_KINDS,
  TRACE_STEP_KINDS,
  type Envelope,
  type EnvelopeStatus,
  type LedgerEntry,
  type OperatorInputs,
  type Partner,
  type PartnerConfidence,
  type RevisionChangeKind,
  type SheetDiscovery,
  type SheetLiftDiagnostics,
  type SheetRevision,
  type StreetSheet,
  type StreetSheetCards,
  type TraceStep,
  type TraceStepKind,
} from "../src/index";

function env<T>(results: T, provenance: string[] = []): Envelope<T> {
  return { status: "ok", summary: "", results, provenance, limits: [] };
}

function entry(kind: LedgerEntry["kind"]): Omit<LedgerEntry, "id"> {
  return {
    kind,
    method: kind === "action" ? "ACTION" : "GET",
    endpoint: "/v2/insights",
    params: {},
    httpStatus: 200,
    envelopeStatus: "ok",
    latencyMs: 1,
    bytes: 1,
    cacheHit: false,
    resultCount: 0,
    curl: "",
    startedAt: "2026-10-14T00:00:00.000Z",
  };
}

const partner: Partner = {
  entity: { entityId: "p1", name: "Sample Records", subtype: "urn:entity:place", popularity: 0.4, affinity: 0.8, tags: [], properties: {} },
  tileGeohash: "dn6m9q",
  category: "record_store",
  score: 0.7,
  qlooRank: 2,
  chips: [{ label: "over-indexes for this bill", ledgerRef: "Q9" }],
};

/** A sheet shaped like one written before wave 3: none of the new fields. */
function oldSheet(): StreetSheet {
  const cards: StreetSheetCards = {
    resolution: env([]),
    liftMap: env({ tiles: [], diagnostics: { spearmanLiftVsHeat: null, baseline: "house" } }),
    partners: env([partner], ["Q9"]),
    declared: env([]),
    prePost: env([]),
    media: env([]),
    demographics: env({ bill: [], house: [] }),
    whatsDifferent: env({ shared: [], a: [], b: [], fromTagDiff: false }),
    copyHooks: env([]),
  };
  return {
    planId: "plan-1",
    createdAt: "2026-10-14T00:00:00.000Z",
    mode: "fixture",
    hypothetical: false,
    bill: {
      acts: [{ name: "Sample Act", role: "headliner" }],
      venue: { name: "Sample Room", lat: 36.16, lon: -86.78, city: "Nashville" },
      date: "2026-12-20",
      weekday: "sunday",
      legalAgeEnforced: null,
    },
    operator: { seatsLeft: null, capacity: null, mediaBudgetUsd: null, streetTeamDays: ["saturday"], radiusKm: 40, declaredPartners: [] },
    cards,
    ledger: [],
    guard: { dropped: 0, reasons: [], deniedTagCount: 0 },
    limits: [...LIMITS_EVERY_SHEET],
  };
}

describe("createMemoryLedger", () => {
  it("numbers ids per kind and returns a copy of the list", () => {
    const sink = createMemoryLedger();
    expect([sink.add(entry("qloo")), sink.add(entry("qloo")), sink.add(entry("tm")), sink.add(entry("action"))]).toEqual(["Q1", "Q2", "T1", "A1"]);
    const list = sink.entries();
    list.pop();
    expect(sink.entries().map((e) => e.id)).toEqual(["Q1", "Q2", "T1", "A1"]);
  });
});

describe("policy constants", () => {
  it("has no duplicates and every prefix is a tag URN", () => {
    expect(new Set(DENIED_TAG_PREFIXES).size).toBe(DENIED_TAG_PREFIXES.length);
    expect(new Set(DENIED_TAG_KEYWORDS).size).toBe(DENIED_TAG_KEYWORDS.length);
    for (const p of DENIED_TAG_PREFIXES) expect(p.startsWith("urn:tag:")).toBe(true);
    for (const k of DENIED_TAG_KEYWORDS) expect(k).toBe(k.toLowerCase());
  });
});

describe("wave 3 shapes", () => {
  it("lists every step kind and change kind once", () => {
    expect([...TRACE_STEP_KINDS]).toEqual([
      "resolve",
      "pause",
      "baseline",
      "heat",
      "partners",
      "prepost",
      "media",
      "guard",
      "narrate",
      "revise",
      "send",
      "other",
    ]);
    expect([...REVISION_CHANGE_KINDS]).toEqual([
      "partner_added",
      "partner_removed",
      "tile_added",
      "tile_removed",
      "spot_added",
      "spot_removed",
      "setting_changed",
    ]);
    expectTypeOf<TraceStepKind>().toEqualTypeOf<(typeof TRACE_STEP_KINDS)[number]>();
    expectTypeOf<RevisionChangeKind>().toEqualTypeOf<(typeof REVISION_CHANGE_KINDS)[number]>();
  });

  it("keeps every new field optional", () => {
    const sheet = oldSheet();
    expect(sheet.discovery).toBeUndefined();
    expect(sheet.steps).toBeUndefined();
    expect(sheet.revision).toBeUndefined();
    expectTypeOf<OperatorInputs["allAges"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<OperatorInputs["excludeCategories"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<OperatorInputs["excludeAreas"]>().toEqualTypeOf<string[] | undefined>();
    expectTypeOf<Partner["houseRank"]>().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<Partner["ubiquityPenalty"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<StreetSheet["discovery"]>().toEqualTypeOf<SheetDiscovery | undefined>();
    expectTypeOf<StreetSheet["steps"]>().toEqualTypeOf<TraceStep[] | undefined>();
    expectTypeOf<StreetSheet["revision"]>().toEqualTypeOf<SheetRevision | undefined>();
    expectTypeOf<StreetSheetCards["liftMap"]["results"]["liftDiagnostics"]>().toEqualTypeOf<SheetLiftDiagnostics | undefined>();
    expectTypeOf<TraceStep["status"]>().toEqualTypeOf<EnvelopeStatus>();
    expectTypeOf<PartnerConfidence>().toEqualTypeOf<"high" | "medium" | "low">();
  });

  it("holds a revised sheet with every extra filled in", () => {
    const base = oldSheet();
    const liftDiagnostics: SheetLiftDiagnostics = {
      splitHalfSpearman: 0.62,
      liftVsHeatSpearman: 0.41,
      billFloor: 0.7,
      method: "bill percentile minus house percentile, bill floor 0.7",
    };
    const sheet: StreetSheet = {
      ...base,
      operator: { ...base.operator, allAges: true, excludeCategories: ["bar"], excludeAreas: ["dn6m9q", "Sample Area"] },
      cards: {
        ...base.cards,
        liftMap: env({ ...base.cards.liftMap.results, liftDiagnostics }, ["Q4", "Q5"]),
        partners: env(
          [
            {
              ...partner,
              houseRank: null,
              ubiquityPenalty: 0.1,
              explain: {
                tags: [{ id: "urn:tag:genre:music:americana", name: "Americana" }],
                areaName: "Sample Area",
                distanceKm: 3.1,
                activation: "Ask to leave flyers at the counter.",
                confidence: "medium",
                confidenceWhy: "Rank 2 of 40 in a top tile, open on the street-team day.",
                ledgerRefs: ["Q9"],
              },
            },
          ],
          ["Q9"],
        ),
      },
      discovery: {
        kind: "partner",
        headline: "Sample Records, 3.1 km out in Sample Area",
        detail: "Not a bar, and the list without Qloo does not have it.",
        rule: "Highest-ranked partner that is not a bar, more than 2 km from the venue, missing from the list without Qloo.",
        entityId: "p1",
        ledgerRefs: ["Q9"],
      },
      steps: [
        { id: "heat", kind: "heat", label: "Lift map", decision: "Kept 5 tiles.", status: "ok", ledgerRefs: ["Q4", "Q5"] },
        { id: "revise", kind: "revise", label: "Revise", decision: "Left out bar partners.", cause: "Operator set all ages.", status: "ok", ledgerRefs: [] },
      ],
      revision: {
        parentPlanId: "plan-0",
        instruction: "All ages: no bars",
        interpreter: "rules",
        toolCalls: [{ tool: "set_all_ages", input: { allAges: true }, summary: "Left out bar partners" }],
        changes: [
          { kind: "setting_changed", label: "All ages", ledgerRefs: [] },
          { kind: "partner_removed", label: "Sample Bar", detail: "bar", ledgerRefs: ["Q9"] },
        ],
      },
    };
    expect(sheet.steps?.map((s) => s.kind).every((k) => (TRACE_STEP_KINDS as readonly string[]).includes(k))).toBe(true);
    expect(sheet.revision?.changes.every((c) => (REVISION_CHANGE_KINDS as readonly string[]).includes(c.kind))).toBe(true);
    expect(JSON.parse(JSON.stringify(sheet))).toEqual(sheet);
  });
});
