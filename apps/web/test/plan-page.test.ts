/**
 * The plan page (/plan/[id]): the pure helpers behind the sheet extras, and the
 * page itself rendered to static HTML with the optional wave-3 fields present
 * and absent. Fixture-driven checks read the sheets, never fixed numbers.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry, Partner, SheetDiscovery, SheetRevision, StreetSheet, TraceStep } from "@walkup/contracts";

// The map pieces load MapLibre and use the "@/" alias; the page is checked without them.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("../components/LiftMap", () => ({
  LiftMap: () => createElement("figure", { "data-testid": "map" }),
  squareSizeLine: () => "Each square is about 1.0 km by 0.6 km.",
}));
vi.mock("../components/LiftLegend", () => ({ LiftLegend: () => null }));
vi.mock("../components/TileList", () => ({
  TileList: ({ tiles }: { tiles: { geohash: string; name?: string }[] }) =>
    createElement(
      "ol",
      null,
      tiles.map((t) => createElement("li", { key: t.geohash }, t.name ?? t.geohash)),
    ),
}));

const { PlanView } = await import("../components/plan/PlanView");
const { PlanLive } = await import("../components/plan/PlanLive");
const { DiscoveryNote, RevisionNote, StepList } = await import("../components/plan/SheetExtras");
const { PartnerWhy } = await import("../components/plan/PartnersCard");
const { ReceiptContext } = await import("../components/plan/receipts");
const model = await import("../components/plan/model");
const utils = await import("../lib/sheet-utils");
const { RecordedStrip } = await import("../components/RecordedStrip");
const { runtimeMode } = await import("../lib/mode");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): { sheet: StreetSheet } => JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8"));

/** Words and marks the design brief rules out of visible copy. */
const BANNED = /AI-powered|powered by AI|\bunlock|supercharge|seamless|effortless|(?<!\/v2\/)insights?\b|!\s|\bLet's\b|Tonight's program/i;

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
}

function withReceipts(node: ReactNode, entries: LedgerEntry[] = []): string {
  return renderToStaticMarkup(createElement(ReceiptContext.Provider, { value: { entries, open: () => undefined } }, node));
}

/** A copy of a preset sheet with every optional wave-3 field filled from its own ids. */
function extended(id: string): StreetSheet {
  const { sheet } = fixture(id);
  const s: StreetSheet = structuredClone(sheet);
  const p0 = s.cards.partners.results[0]!;
  const tile = s.cards.liftMap.results.tiles[0]!;
  const q = s.ledger.find((e) => e.kind === "qloo")!.id;
  s.discovery = {
    kind: "partner",
    headline: `${p0.entity.name}, out in ${p0.tileName ?? "its area"}`,
    detail: "Ranks high for this bill and is missing from the list without Qloo.",
    rule: "the highest-ranked partner that is not a bar, more than 2 km from the venue and not on the list without Qloo.",
    entityId: p0.entity.entityId,
    ledgerRefs: [q],
  };
  s.steps = [
    { id: "resolve", kind: "resolve", label: "Acts", decision: "Matched every act on the bill.", status: "ok", ledgerRefs: [q] },
    { id: "heat", kind: "heat", label: "Lift map", decision: `Kept ${tile.name ?? tile.geohash} as a top area.`, cause: "This room's usual crowd ranks it lower.", status: "partial", ledgerRefs: [q] },
  ];
  s.revision = {
    parentPlanId: "g1-b",
    instruction: "All ages, no bars",
    interpreter: "rules",
    toolCalls: [{ tool: "set_operator", input: { allAges: true, excludeCategories: ["bar"] }, summary: "Left out bar partners" }],
    changes: [
      { kind: "partner_removed", label: "Foxglove Crane Tavern", detail: "A bar.", ledgerRefs: [q] },
      { kind: "partner_added", label: "Quill & Kettle Coffee House", ledgerRefs: [q] },
      { kind: "setting_changed", label: "All ages", ledgerRefs: [] },
    ],
  };
  s.cards.partners.results[0] = {
    ...p0,
    houseRank: null,
    ubiquityPenalty: 0.25,
    explain: {
      tags: [{ id: "urn:tag:ambience:qloo:cozy", name: "Cozy" }],
      areaName: p0.tileName ?? "its area",
      distanceKm: 3.1,
      activation: "Ask to leave flyers at the counter.",
      confidence: "high",
      confidenceWhy: "Rank 1 of 24 in a top area, open on the street-team day.",
      limits: "Doesn't show that its customers buy tickets.",
      ledgerRefs: [q],
    },
  };
  s.cards.liftMap.results.liftDiagnostics = {
    splitHalfSpearman: 0.71,
    liftVsHeatSpearman: 0.42,
    billFloor: 0.7,
    method: "Bill percentile over house percentile, bill floor 0.7.",
    note: "The split-half check ran on 12 shared areas.",
  };
  return s;
}

/** A copy of a preset sheet with every optional wave-3 field taken out, to check that absent fields render nothing. */
function bare(id: string): StreetSheet {
  const s: StreetSheet = structuredClone(fixture(id).sheet);
  delete s.steps;
  delete s.discovery;
  delete s.revision;
  delete s.cards.liftMap.results.liftDiagnostics;
  s.cards.partners.results = s.cards.partners.results.map(({ explain: _explain, ...p }) => p);
  return s;
}

function renderView(sheet: StreetSheet, extra: Partial<Parameters<typeof PlanView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PlanView, {
      payload: { sheet, note: null, source: "preset", presetId: sheet.planId },
      line: null,
      realShow: false,
      paired: { planId: "g1-b", headliner: "Neon Orchard" },
      runtimeLive: false,
      canRerun: true,
      ...extra,
    }),
  );
}

describe("plan page helpers", () => {
  const sheet = extended("g1-a");

  it("reads opening hours with or without seconds", () => {
    expect(utils.formatHours("16:00-02:00")).toBe("4 pm to 2 am");
    expect(utils.formatHours("06:00:00-11:00:00")).toBe("6 am to 11 am");
    expect(utils.formatHours("17:00:00-00:00:00")).toBe("5 pm to midnight");
    expect(utils.humanTimes("Pub on 18th St, open 17:00 to 02:00 Wednesday; 07:30 to 12:00 too.")).toBe("Pub on 18th St, open 5 pm to 2 am Wednesday; 7:30 am to noon too.");
    expect(utils.humanTimes("About 2.2 times the room's usual crowd, 58% of the budget.")).toBe("About 2.2 times the room's usual crowd, 58% of the budget.");
  });

  it("says a narration check's note in plain words", () => {
    expect(utils.guardNoteText("tileWhy[4]: number 1.7 is not in this run")).toBe("Claude's line for area 5 was left out: it had a number (1.7) that isn't from this run.");
    expect(utils.guardNoteText("summary: banned word \"amazing\"")).toBe("Claude's summary was left out: banned word \"amazing\".");
    expect(utils.guardNoteText("partnerLines[2]: entityId not in this run")).toBe("One of Claude's partner lines was left out: it named a place that isn't on this sheet.");
    expect(utils.guardNoteText("Something else entirely")).toBe("Something else entirely");
  });

  it("links the discovery callout to a row or tile on this sheet, and to nothing that is not there", () => {
    const d = sheet.discovery as SheetDiscovery;
    expect(model.discoveryTarget(sheet, d)?.href).toBe(`#${model.partnerAnchor(d.entityId!)}`);
    const tile = sheet.cards.liftMap.results.tiles[1]!;
    expect(model.discoveryTarget(sheet, { ...d, kind: "area", geohash: tile.geohash })).toMatchObject({ href: "#lift", geohash: tile.geohash });
    expect(model.discoveryTarget(sheet, { ...d, entityId: "not-on-this-sheet" })).toBeNull();
    expect(model.discoveryTarget(sheet, { ...d, kind: "area", geohash: "zzzzzz" })).toBeNull();
  });

  it("groups and counts a revision's changes", () => {
    const r = sheet.revision as SheetRevision;
    const g = model.groupChanges(r.changes);
    expect(g.added.map((c) => c.label)).toEqual(["Quill & Kettle Coffee House"]);
    expect(g.removed.map((c) => c.label)).toEqual(["Foxglove Crane Tavern"]);
    expect(g.changed.map((c) => c.label)).toEqual(["All ages"]);
    expect(model.changeCountLine(r.changes)).toBe("1 partner removed, 1 partner added, 1 setting changed.");
    expect(model.changeCountLine([])).toBe("Nothing on the sheet changed.");
    expect(model.changeCountLine([...r.changes, { kind: "partner_removed", label: "x", ledgerRefs: [] }])).toMatch(/^2 partners removed/);
  });

  it("reads streamed steps defensively and replaces a restated step", () => {
    const step: TraceStep = { id: "heat", kind: "heat", label: "Lift map", decision: "Kept 4 areas.", status: "ok", ledgerRefs: ["Q6"] };
    expect(model.parseStep({ step })).toEqual(step);
    expect(model.parseStep(step)).toEqual(step);
    expect(model.parseStep({ ...step, kind: "dance" })).toBeNull();
    expect(model.parseStep({ ...step, status: "great" })).toBeNull();
    expect(model.parseStep({ id: 1 })).toBeNull();
    expect(model.parseStep("nope")).toBeNull();
    expect(model.parseStep({ ...step, ledgerRefs: ["Q6", 7] })?.ledgerRefs).toEqual(["Q6"]);
    const merged = model.mergeStep([step], { ...step, decision: "Kept 5 areas." });
    expect(merged).toHaveLength(1);
    expect(merged[0]!.decision).toBe("Kept 5 areas.");
    expect(model.mergeStep([step], { ...step, id: "partners", kind: "partners" })).toHaveLength(2);
  });

  it("says chips and house ranks in plain words", () => {
    expect(model.chipText("tonight vs house +5 ranks")).toBe("ranks 5 places higher here than for the room's usual crowd");
    expect(model.chipText("tonight vs house -1 ranks")).toBe("ranks 1 place lower here than for the room's usual crowd");
    expect(model.chipText("tonight vs house 0 ranks")).toBe("ranks the same here as for the room's usual crowd");
    expect(model.chipText("tonight vs house: not in the house top 50")).toBe("not in the usual crowd's top 50");
    expect(model.chipText("in a 1.50x lift tile")).toBe("in an area with 1.50x lift");
    expect(model.chipText("over-indexes for this bill")).toBe("over-indexes for this bill");
    const p = sheet.cards.partners.results[0] as Partner;
    expect(model.houseLines(p)).toEqual(["It also ranks for the room's usual crowd, so its score was marked down."]);
    expect(model.houseLines({ ...p, houseRank: 7, ubiquityPenalty: 0 })).toEqual([]);
    const { houseRank: _h, ubiquityPenalty: _u, ...plain } = p;
    expect(model.houseLines(plain)).toEqual([]);
    // One plain sentence per partner row, the same on paper.
    expect(model.partnerWhy({ ...p, qlooRank: 8, houseRank: 20, explain: undefined }).text).toBe("Ranks 8th here for this crowd, 20th for the room's usual crowd.");
    expect(model.partnerWhy({ ...p, qlooRank: 2, houseRank: null, explain: undefined }).text).toBe("Ranks 2nd here for this crowd; not in the usual crowd's list.");
    expect(model.partnerWhy({ ...plain, chips: [], qlooRank: 3, explain: undefined }).text).toBe("Ranks 3rd here for this crowd.");
    // When the usual crowd ranks it as high or higher, the line says so in plain words, never "check first".
    expect(model.partnerWhy({ ...p, qlooRank: 6, houseRank: 1, explain: undefined }).text).toBe(
      "Ranks 6th here for this crowd, 1st for the room's usual crowd; a good place on any night, not just this bill.",
    );
    expect(model.partnerWhy({ ...p, qlooRank: 6, houseRank: 30 }).text).not.toMatch(/check first/);
    expect(model.streetDayShort(["thursday", "saturday"])).toBe("Thu");
    expect(model.streetDayShort([])).toBeNull();
  });

  it("checks a revise instruction before it is sent", () => {
    expect(model.checkInstruction("  All ages,   no bars ")).toEqual({ ok: true, text: "All ages, no bars" });
    expect(model.checkInstruction("x").ok).toBe(false);
    expect(model.checkInstruction("a".repeat(281)).ok).toBe(false);
  });
});

describe("sheet extras render only from their own fields", () => {
  const sheet = extended("g1-a");

  it("discovery: headline, rule, receipts and a link to the row", () => {
    const d = sheet.discovery as SheetDiscovery;
    const html = withReceipts(createElement(DiscoveryNote, { discovery: d, target: model.discoveryTarget(sheet, d) }), sheet.ledger);
    expect(html).toContain(d.headline.replace(/'/g, "&#x27;"));
    expect(html).toContain("Why this one: ");
    expect(html).toContain(`href="#${model.partnerAnchor(d.entityId!)}"`);
    expect(html).toContain(`href="#receipt-${d.ledgerRefs[0]}"`);
  });

  it("steps: one list item per decision, with causes and status words", () => {
    const html = withReceipts(createElement(StepList, { steps: sheet.steps ?? [] }));
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain("This room&#x27;s usual crowd ranks it lower.");
    expect(html).toContain("Partial");
    expect(withReceipts(createElement(StepList, { steps: [], live: true }))).toContain("Waiting for the first step");
  });

  it("revision: the instruction, the earlier plan, grouped changes and the question when there is one", () => {
    const r = sheet.revision as SheetRevision;
    const html = withReceipts(createElement(RevisionNote, { revision: r }));
    expect(html).toContain("All ages, no bars");
    expect(html).toContain('href="/plan/g1-b"');
    for (const h of ["Added", "Removed", "Changed"]) expect(html).toContain(`>${h} <span`);
    expect(html).toContain("no model was called");
    expect(html).not.toContain("note-warn");
    expect(withReceipts(createElement(RevisionNote, { revision: { ...r, changes: [], question: "Which day is the street team out?" } }))).toContain(
      "Which day is the street team out?",
    );
  });

  it("partner explain: what to ask, confidence, tags and the house comparison", () => {
    const p = sheet.cards.partners.results[0] as Partner;
    const html = withReceipts(createElement(PartnerWhy, { p }));
    expect(html).toContain("Ask to leave flyers at the counter.");
    expect(html).toContain("High confidence");
    // Tag words read in lower case inside a sentence, and an area named with its own distance gets no second one.
    expect(html).toContain("cozy");
    expect(html).not.toMatch(/km west, [\d.]+ km from the venue/);
    expect(withReceipts(createElement(PartnerWhy, { p: bare("g1-a").cards.partners.results[0]! }))).toBe("");
  });
});

describe("the plan page as a document", () => {
  it("renders every section of a preset sheet with plain headings and footnote receipts", () => {
    const sheet = bare("g1-a");
    const html = renderView(sheet);
    for (const h of ["Acts and venue", "Where this crowd stands out, compared with the room&#x27;s usual crowd", "Your list", "Before and after the show", "Podcasts and a sponsor", "Copy lines", "More about this crowd", "What this sheet doesn&#x27;t show", "Downloads", "Requests behind this sheet"]) {
      expect(html).toContain(`>${h}</h2>`);
    }
    // The partner count sits after the heading in the muted colour.
    expect(html).toContain(`>Partners<span class="font-normal text-muted"> (${sheet.cards.partners.results.length})</span></h2>`);
    expect(html).toContain("Sample street sheet");
    expect(html).toContain('class="fn');
    expect(html).toContain("Send to street team");
    expect(html).not.toMatch(/Google|Without Qloo/);
    expect(html).toContain('href="/plan/g1-b"');
    expect(html).toContain(`/api/sheet/${sheet.planId}/pdf`);
    // One row per partner, with its hours on the first street-team day.
    expect(html.match(/id="partner-/g)?.length).toBe(sheet.cards.partners.results.length);
    expect(html).toContain(`Open ${model.streetDayShort(sheet.operator.streetTeamDays)}`);
    // Absent fields render nothing.
    for (const id of ['id="revision"', 'id="discovery-title"', 'id="steps"', 'id="revise"', "Why this place", "Split-half agreement"]) expect(html).not.toContain(id);
    expect(visibleText(html)).not.toMatch(BANNED);
  });

  it("uses no legacy theme class names", () => {
    const html = renderView(extended("g1-a"), { onRevise: async () => ({}) });
    const classes = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/));
    const legacy =
      /^(.*:)?((bg|text|border|decoration)-(house-\d+|ink-muted|ink-faint|amber(-deep|-ink)?|ember|slate-cool|ok|partial|needs|degraded|empty|error)(\/\d+)?|font-display|eyebrow|surface|receipt-chip|stamp)$/;
    expect(classes.filter((c) => legacy.test(c))).toEqual([]);
    expect(classes.filter((c) => /^(rounded-(xl|2xl|full)|shadow-2xl|backdrop-blur|uppercase|tracking-wide(r|st)?)$/.test(c))).toEqual([]);
  });

  it("adds the wave-3 parts when the sheet carries them", () => {
    const sheet = extended("g1-a");
    const html = renderView(sheet, { onRevise: async () => ({ planId: "next" }) });
    expect(html).toContain('id="revision"');
    expect(html).toContain("Start with this place");
    expect(html).toContain("What Walkup decided");
    expect(html).toContain("Change something");
    // The example sits in the hint, not in a placeholder that disappears while typing.
    expect(html).toContain("For example: all ages, no bars");
    expect(html).not.toContain('placeholder="All ages, no bars"');
    expect(html).toContain("Why this place");
    expect(html).toContain("Split-half agreement");
    expect(html).toContain("0.71");
    expect(visibleText(html)).not.toMatch(BANNED);
  });

  it("renders the extras the generated preset sheets carry", () => {
    const { sheet } = fixture("g1-b");
    const html = renderView(sheet);
    expect(sheet.steps?.length).toBeGreaterThan(0);
    expect(html).toContain('id="steps"');
    for (const st of sheet.steps ?? []) expect(html).toContain(st.label);
    if (sheet.discovery) expect(html).toContain('id="discovery-title"');
    expect(html.match(/Why this place/g)?.length).toBeGreaterThanOrEqual(sheet.cards.partners.results.filter((p) => p.explain).length);
    if (sheet.cards.liftMap.results.liftDiagnostics?.splitHalfSpearman != null) expect(html).toContain("Split-half agreement");
    expect(visibleText(html)).not.toMatch(BANNED);
  });

  it("shows no Google Places list, even for an older sheet that still carries one", () => {
    const old: StreetSheet = {
      ...bare("g1-a"),
      control: { arm: "F", places: [{ placeId: "gp-1", name: "Example Comparison Tavern", query: "bar" }], overlapWithQloo: [], ledgerRefs: [] },
    };
    const html = renderView(old);
    expect(html).not.toContain("Example Comparison Tavern");
    expect(html).not.toMatch(/Google|Without Qloo|without-qloo/);
  });

  it("offers the revise box when the page marks the sheet revisable", () => {
    expect(renderView(bare("g1-a"), { revisable: true })).toContain('id="revise"');
    expect(renderView(bare("g1-a"), { revisable: false })).not.toContain('id="revise"');
  });

  it("shows the sample strip on a fixture sheet only while the server is live", () => {
    const { sheet } = fixture("g3");
    expect(renderView(sheet, { runtimeLive: true })).toContain("Sample sheet.");
    expect(renderView(sheet, { runtimeLive: false })).not.toContain("Sample sheet.");
  });

  it("says when a live sheet was recorded once Qloo is unavailable, and keeps a sample sheet a sample", () => {
    const metaLine = (html: string) => visibleText(/data-testid="meta-line">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "").trim();
    // A live copy of a preset sheet, standing in for a run recorded mode serves from the plan store.
    const live: StreetSheet = { ...structuredClone(fixture("g1-a").sheet), mode: "live" };
    const html = renderView(live, { recorded: true, canRerun: false, revisable: false });
    expect(metaLine(html)).toMatch(/^Street sheet · Draft, not sent · Recorded Oct 30 2026, 15:00 UTC from \d+ requests in \d+ steps$/);
    expect(visibleText(html)).toContain("Recorded from a live run on Oct 30 2026, 15:00 UTC and not refreshed since.");
    for (const gone of ["Sample sheet.", "Sample street sheet", "A live run.", "Run it again", 'id="revise"']) expect(html).not.toContain(gone);
    // Live mode keeps saying when the sheet was planned.
    expect(metaLine(renderView(live, { runtimeLive: true, canRerun: false }))).toMatch(/· Planned Oct 30 2026, 15:00 UTC from/);
    // A preset with no recording shows its sample sheet, said as such.
    const sample = renderView(fixture("g3").sheet, { recorded: true, canRerun: false, revisable: false });
    expect(sample).toContain("Sample sheet.");
    expect(visibleText(sample)).toContain("This sheet uses made-up places and numbers. No live run of this show was recorded.");
    expect(metaLine(sample)).toMatch(/^Sample street sheet · /);
    expect(visibleText(html + sample)).not.toMatch(BANNED);
  });

  it("puts recorded mode in one plain strip at the top, with the date Qloo went away", () => {
    const mode = runtimeMode({ WALKUP_MODE: "recorded", WALKUP_QLOO_UNTIL: "2026-11-02" }, { now: Date.parse("2026-11-10T00:00:00Z") });
    const text = visibleText(renderToStaticMarkup(createElement(RecordedStrip, { mode })));
    expect(text.trim()).toBe(
      "Qloo has been unavailable since Nov 2 2026. New plans are off. Sheets recorded from live runs show the date of the run and are not refreshed.",
    );
    expect(text).not.toMatch(/\bsample\b|made-up|\bfresh\b|live data/i);
    // The first sentence is the strip's bold lead.
    expect(renderToStaticMarkup(createElement(RecordedStrip, { mode }))).toContain('<strong class="font-semibold">Qloo has been unavailable since Nov 2 2026.</strong> New plans');
  });
});

describe("narrated partner lines", () => {
  it("shows the model's line for a partner under its rank line, and nothing when the sheet has none or it was templated", () => {
    const sheet = bare("g1-a");
    const p = sheet.cards.partners.results[0]!;
    const line = "A test line the narration wrote for this partner.";
    const withLine: StreetSheet = {
      ...sheet,
      narration: sheet.narration ? { ...sheet.narration, templated: false, partnerLines: [{ entityId: p.entity.entityId, text: line }] } : sheet.narration,
    };
    expect(withLine.narration).toBeTruthy();
    expect(visibleText(renderView(withLine))).toContain(line);
    // A templated narration's partner lines only repeat the rank line, so they are not shown.
    const templated: StreetSheet = { ...withLine, narration: { ...withLine.narration!, templated: true } };
    expect(visibleText(renderView(templated))).not.toContain(line);
    const without: StreetSheet = { ...sheet, narration: sheet.narration ? { ...sheet.narration, partnerLines: [] } : sheet.narration };
    expect(visibleText(renderView(without))).not.toContain(line);
  });
});

describe("the live view", () => {
  it("lists the sections in stream order and says how many are in", () => {
    const { sheet } = fixture("g1-a");
    const html = renderToStaticMarkup(
      createElement(PlanLive, {
        planId: "run-1",
        mode: "fixture",
        title: "A run",
        status: "running",
        cards: [
          { key: "resolution", envelope: sheet.cards.resolution },
          { key: "liftMap", envelope: sheet.cards.liftMap },
        ],
        resolveId: "run-1",
        steps: sheet.steps ?? [{ id: "resolve", kind: "resolve", label: "Acts", decision: "Matched every act.", status: "ok", ledgerRefs: [] }],
      }),
    );
    expect(html).toContain("Planning: 2 of 9 sections in.");
    expect(html).toContain("What Walkup decided");
    expect(html.match(/>Waiting</g)).toHaveLength(7);
    expect(visibleText(html)).not.toMatch(BANNED);
  });

  it("pauses on an ambiguous name with the candidates and a way out", () => {
    const { sheet } = fixture("g1-a");
    const resolution = structuredClone(sheet.cards.resolution);
    const first = resolution.results[0]!;
    resolution.status = "needs_input";
    resolution.reason = "Ambiguous name: pick the right entity to continue.";
    resolution.results[0] = {
      ...first,
      status: "needs_input",
      candidates: [
        { entityId: "c1", name: first.input, subtype: "urn:entity:person", popularity: 0.6, shortDescription: "Stand-up comedian" },
        { entityId: "c2", name: first.input, subtype: "urn:entity:artist", popularity: 0.3, shortDescription: "Rock band" },
      ],
    };
    const { entity: _e, ...rest } = resolution.results[0]!;
    resolution.results[0] = rest;
    const html = renderToStaticMarkup(
      createElement(PlanLive, {
        planId: "run-2",
        mode: "fixture",
        title: "A run",
        status: "needs_input",
        cards: [{ key: "resolution", envelope: resolution }],
        pending: [{ input: first.input, candidates: resolution.results[0]!.candidates! }],
        resolution,
        bill: sheet.bill,
        resolveId: "g2",
        recordedHref: "/plan/g2?recorded=1",
        ledger: sheet.ledger,
      }),
    );
    expect(html).toContain(`Which “${first.input}” is on this bill?`);
    expect(html.match(/>Use this one</g)).toHaveLength(2);
    expect(html).toContain("None of these: use a film or TV title instead");
    expect(html).toContain('href="/plan/g2?recorded=1"');
    // The pick comes first; the acts table folds away below it, with no second yellow note.
    expect(html.indexOf("is on this bill?")).toBeLessThan(html.indexOf("How each act was matched"));
    expect(html).not.toContain("note-warn");
  });
});

describe("sheet page patterns from the design research", () => {
  const sendEntry = (id: string, note: string, at: string, recipients = ["delivered@resend.dev"]): LedgerEntry => ({
    id,
    kind: "action",
    method: "ACTION",
    endpoint: utils.SEND_ENDPOINT,
    params: { recipients, recipientCount: recipients.length },
    httpStatus: null,
    envelopeStatus: "ok",
    latencyMs: 0,
    bytes: 0,
    cacheHit: false,
    resultCount: recipients.length,
    curl: "",
    startedAt: at,
    note,
  });

  it("says each section's source in one muted line, and never lets sample data read as fetched", () => {
    const { sheet } = fixture("g1-a");
    const ids = sheet.cards.partners.provenance;
    const sample = utils.sourceLine(ids, sheet.ledger, true)!;
    expect(sample).toMatch(/^Sample data standing in for \d+ Qloo requests, Oct 30 2026, 15:00 UTC\.$/);
    expect(sample).not.toMatch(/fetched/);
    const live = utils.sourceLine(ids, sheet.ledger.map((e) => ({ ...e, cacheHit: e.id === ids[0] })), false)!;
    expect(live).toMatch(/^\d+ Qloo requests, fetched Oct 30 2026, 15:00 UTC, 1 from cache\.$/);
    expect(utils.sourceLine(["Q999"], sheet.ledger, false)).toBeNull();
    expect(utils.sourceLine(["T2", "Q4"], sheet.ledger, false)).toMatch(/^2 Ticketmaster and Qloo requests|^2 Qloo and Ticketmaster requests/);
  });

  it("says the usual-crowd markdown only when it pushed places off the list", () => {
    const a = fixture("g1-a").sheet;
    const text = utils.partnerSummary(a);
    expect(text).not.toMatch(/more when the two ranks are close/);
    expect(text).toMatch(/ Places the room's usual crowd ranks as high are marked down; \d+ of them didn't make the list and come back only if nothing better is open nearby\.$/);
    expect(text).toMatch(/^24 partners in 3 areas/);
    // G3: the markdown changed nothing, so nothing is said about it.
    const g3 = utils.partnerSummary(fixture("g3").sheet);
    expect(g3).not.toMatch(/marked down|didn't make the list/);
    // Without steps the sentence simply goes.
    const { steps: _s, ...noSteps } = structuredClone(a);
    expect(utils.partnerSummary(noSteps as StreetSheet)).not.toMatch(/marked down|Left off/);
  });

  it("puts the send status in words, in the title and as a last step", () => {
    const { sheet } = fixture("g1-a");
    expect(utils.sendStatus(sheet.ledger)).toEqual({ line: "Draft, not sent", title: "draft", sent: false });
    expect(utils.sheetTitle(sheet)).toBe("Sample: Hollis Creek String Band at The Truth, street sheet (draft)");
    const demo = sendEntry("A1", "demo: not sent. RESEND_API_KEY is not set on this server, so nothing is sent.", "2026-10-14T16:05:00.000Z");
    expect(utils.sendStatus([...sheet.ledger, demo]).line).toBe("Draft, not sent (demo send recorded Oct 14, 16:05 UTC)");
    const sent = sendEntry("A2", "sent: message id abc", "2026-10-14T16:20:00.000Z", ["a@example.com", "b@example.com"]);
    expect(utils.sendStatus([...sheet.ledger, demo, sent])).toEqual({ line: "Sent Oct 14, 16:20 UTC to 2 addresses", title: "sent Oct 14", sent: true });
    const steps = utils.sendSteps([demo, sent]);
    expect(steps.map((s) => s.decision)).toEqual([
      "Recorded a demo send for 1 address on Oct 14, 16:05 UTC; nothing left the server.",
      "Sent the sheet to 2 addresses on Oct 14, 16:20 UTC.",
    ]);
    expect(steps[1]!.ledgerRefs).toEqual(["A2"]);
    expect(utils.sendSteps([sendEntry("A3", "refused: daily cap reached. Nothing was sent.", "2026-10-14T17:00:00.000Z")])[0]!.status).toBe("error");
  });

  it("renders a sheet whose ledger already carries a send", () => {
    const sheet = structuredClone(fixture("g1-a").sheet);
    sheet.ledger.push(sendEntry("A1", "demo: not sent. RESEND_API_KEY and RESEND_FROM are not set on this server, so nothing is sent.", "2026-10-14T06:54:00.000Z"));
    const text = visibleText(renderView(sheet));
    expect(text).toContain("Draft, not sent (demo send recorded Oct 14, 06:54 UTC)");
    expect(text).toContain("Recorded a demo send for 1 address on Oct 14, 06:54 UTC; nothing left the server.");
  });

  it("says where the numbered areas sit", () => {
    const { sheet } = fixture("g1-a");
    const top = utils.topTiles(sheet);
    const line = utils.spreadSentence(top, sheet.bill.venue)!;
    expect(line).toMatch(/^The 4 top areas are \d+(\.\d)? km to \d+(\.\d)? km from the room, (most|all) of them to the (north|east|south|west)\.$|in different directions\.$/);
    expect(utils.spreadSentence(top.slice(0, 1), sheet.bill.venue)).toMatch(/^The one top area is [\d.]+ km \w+ of the room\.$/);
    expect(utils.spreadSentence([], sheet.bill.venue)).toBeNull();
  });

  it("reads back what a revision understood", () => {
    expect(
      model.readAsLine([
        { tool: "set_all_ages", summary: "Marked the show all ages, so no bar partners or drink-led spots" },
        { tool: "exclude_partner_categories", summary: "Left out bars and other drinking places." },
        { tool: "ask_operator", summary: "Asked: which day?" },
      ]),
    ).toBe("Read as: all ages; bars and drink-led spots left out.");
    expect(model.readAsLine([])).toBeNull();
    const html = withReceipts(createElement(RevisionNote, { revision: extended("g1-a").revision! }));
    expect(html).toContain("Read as: left out bar partners.");
    expect(html).toContain("<del");
  });

  it("renders the header, key facts, source lines and partner table the research asks for", () => {
    const { sheet } = fixture("g1-a");
    const html = renderView(sheet);
    const text = visibleText(html);
    // Identity: the headliner in 600, the rest of the bill in 400; status and provenance in one muted line.
    expect(html).toContain('<h1>Hollis Creek String Band<span class="font-normal"> with Marla Vane and The Ferry Lights</span></h1>');
    expect(text).toMatch(/Sample street sheet · Draft, not sent · Planned Oct 30 2026, 15:00 UTC from \d+ requests in \d+ steps/);
    expect(html).toContain('href="#ledger"');
    for (const k of ["Seats left", "Days to show", "Street-team days", "Partners found"]) expect(text).toContain(k);
    // Every section with receipts has a source line, and no penalty sentence survives.
    expect(html.match(/data-testid="source-line"/g)?.length).toBeGreaterThanOrEqual(6);
    expect(text).not.toMatch(/more when the two ranks are close/);
    // The lone "Name" header is hidden under 640px but still read out; areas start with their map number.
    expect(html).toContain('<span class="max-sm:sr-only">Name</span>');
    expect(html).toMatch(/<span class="sr-only">Area <\/span><span class="font-semibold tabular">1<\/span> /);
    // Status words before a decision, in 600, only when the step isn't ok.
    expect(html).not.toMatch(/Fell back: </);
    expect(renderView(fixture("g3").sheet)).toMatch(/<span class="font-semibold ">Fell back: <\/span>Couldn(&#x27;|')t build the room(&#x27;|')s usual crowd/);
    // The street team's part comes before how the plan was made.
    expect(html.indexOf('id="partners"')).toBeLessThan(html.indexOf('id="steps"'));
    expect(text).not.toMatch(BANNED);
  });

  it("says the popularity check in one sentence with its receipts, and nothing when the sheet has none", () => {
    const { sheet } = fixture("g1-a");
    const c = sheet.popularityCheck!;
    const html = renderView(sheet);
    expect(visibleText(html)).toContain(`${c.notInPopularTop} of the ${c.partners} partners would not make a list of the most popular places in their areas.`);
    const line = /<p[^>]*data-testid="popularity-check"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
    // Footnote receipts: consecutive ids collapse into one range ("Q20–Q22").
    expect(line).toContain(`#receipt-${c.ledgerRefs[0]}`);
    expect(line).toContain(`aria-label="Receipts ${c.ledgerRefs[0]} to ${c.ledgerRefs.at(-1)}"`);
    const without = structuredClone(sheet);
    delete without.popularityCheck;
    expect(renderView(without)).not.toContain('data-testid="popularity-check"');
  });

  it("marks a national chain in the type column and the spot line", () => {
    const a = structuredClone(fixture("g1-a").sheet);
    a.cards.partners.results[0]!.chain = true;
    a.cards.prePost.results[0]!.chain = true;
    const text = visibleText(renderView(a));
    expect(text).toMatch(/, national chain/);
    expect(text).toMatch(/· national chain/);
    expect(visibleText(renderView(fixture("g1-a").sheet))).not.toMatch(/national chain/);
  });

  it("marks thin-signal places with a dagger and new partners with the word new", () => {
    const g3 = fixture("g3").sheet;
    const html = renderView(g3);
    expect(html.match(/<span aria-hidden="true">†<\/span>/g)?.length).toBe(g3.cards.partners.results.filter((p) => p.explain && p.explain.confidence !== "high").length);
    expect(visibleText(html)).toContain("† Less certain:");
    const a = structuredClone(fixture("g1-a").sheet);
    const name = a.cards.partners.results[2]!.entity.name;
    a.revision = { ...extended("g1-a").revision!, changes: [{ kind: "partner_added", label: name, ledgerRefs: [] }] };
    expect(renderView(a)).toMatch(/<span class="text-muted"> new<\/span>/);
    expect(renderView(fixture("g1-a").sheet)).not.toMatch(/<span class="text-muted"> new<\/span>/);
  });

  it("keeps the pause note for the paused view and says what a live run is working on", () => {
    const { sheet } = fixture("g1-a");
    const paused = renderToStaticMarkup(
      createElement(PlanLive, {
        planId: "g2",
        mode: "fixture",
        title: "A run",
        status: "needs_input",
        cards: [],
        pending: [{ input: "Sidecar", candidates: [{ entityId: "c1", name: "Sidecar", subtype: "urn:entity:person", popularity: 0.6 }] }],
        bill: sheet.bill,
        resolveId: "g2",
        line: "One act's name matches more than one catalog entry, so Walkup asks you to pick before it plans.",
      }),
    );
    expect(paused).toContain("so Walkup asks you to pick before it plans");
    const running = renderToStaticMarkup(
      createElement(PlanLive, { planId: "run-3", mode: "fixture", title: "A run", status: "running", cards: [{ key: "resolution", envelope: sheet.cards.resolution }], resolveId: "run-3" }),
    );
    expect(running).toContain("Mapping where this crowd stands out…");
  });
});
