/**
 * The 20 cases of the product eval. Each case runs @walkup/orchestrator
 * on the fixture world (@walkup/qloo-world), adds its own checks and
 * hands one or more sheets ("subjects") to the universal checks in checks.ts.
 *
 * Golden cases (the presets and the bill swap) also run on recorded plans
 * (live or replayed runs stored by the orchestrator): there they keep only the
 * checks the spec states, not the ones that depend on the fixture world's
 * invented numbers.
 */
import { DENIED_TAG_KEYWORDS, type EnvelopeStatus, type StreetSheet } from "@walkup/contracts";
import { haversineM, isBarCategory, isDeniedTag, meanPairwiseJaccard, topKOverlap } from "@walkup/engine";
import {
  CARD_ORDER,
  createMemoryChoiceStore,
  createMemoryPlanStore,
  planShow,
  templateLine,
  type CardKey,
  type PlanResult,
} from "@walkup/orchestrator";
import { catalogByKey, DENIED_EXAMPLE_TAGS } from "@walkup/qloo-world";
import { Checks, readBudget, topPartnerIds, type CheckResult, type ClauseId, type Subject, type SubjectExpect } from "./checks";
import {
  failingHouseHeatVariant,
  failingModel,
  liftWeakVariant,
  mockModel,
  newRig,
  runWithPick,
  type EvalRig,
  type MockDraft,
  type PresetRun,
  type RunFacts,
} from "./harness";

export type GoldenId = "g1-a" | "g1-b" | "g2" | "g3";

/** A plan read back from storage (a recorded live run, or a replay). */
export interface RecordedRun {
  presetId: string;
  result: PlanResult;
  source: string;
}

export interface CaseEnv {
  source: "fixture" | "recorded";
  /** Recorded runs by preset id (recorded source only). */
  recorded?: Map<string, RecordedRun>;
}

export interface CaseOutput {
  subjects: Subject[];
  checks: CheckResult[];
  metrics?: Record<string, number | string | boolean | null>;
}

export interface ProductCase {
  id: string;
  slug: string;
  title: string;
  /** Spec sections the case covers (plain words). */
  covers: string;
  clauses: ClauseId[];
  /** One of the golden sheets: the definition-of-done clauses are scored on these. */
  golden?: boolean;
  /** Presets this case can check on recorded runs; absent = fixture world only. */
  recorded?: readonly GoldenId[];
  /** "all" (default): every listed preset must be recorded; "any": runs on those present. */
  recordedNeeds?: "all" | "any";
  run(env: CaseEnv): Promise<CaseOutput>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_OK: Partial<Record<CardKey, EnvelopeStatus>> = Object.fromEntries(CARD_ORDER.map((k) => [k, "ok"]));

function sheetOf(r: PlanResult): StreetSheet {
  if (!r.sheet) throw new Error(`no sheet: ${r.status} ${r.error ?? ""}`.trim());
  return r.sheet;
}

/** A fixture subject: ids tapped on the world the run used. */
function fixtureSubject(label: string, rig: EvalRig, run: PresetRun | PlanResult, expect: SubjectExpect): Subject {
  const r = "final" in run ? run : { first: run, final: run };
  return { label, result: r.final, first: r.first, tap: rig.tap, expect };
}

function recordedRun(env: CaseEnv, id: GoldenId): RecordedRun {
  const r = env.recorded?.get(id);
  if (!r) throw new Error(`no recorded plan for preset ${id}`);
  return r;
}

/** A recorded subject: no tap; statuses stated by the spec only. */
function recordedSubject(env: CaseEnv, id: GoldenId, expect: SubjectExpect): Subject {
  const r = recordedRun(env, id);
  return { label: `${id} (recorded: ${r.source})`, result: r.result, expect: { ...expect, pdf: true } };
}

/** Golden run on the fixture world. */
async function goldenFixture(id: GoldenId): Promise<{ rig: EvalRig; run: PresetRun }> {
  const rig = newRig({ idPrefix: id });
  const run = await runWithPick({ presetId: id }, rig.deps);
  return { rig, run };
}

function cardLine(sheet: StreetSheet, k: CardKey): string {
  return `${sheet.cards[k].status}${sheet.cards[k].reason ? `: ${sheet.cards[k].reason}` : ""}`;
}

/** Checks the spec states for every golden sheet (fixture or recorded). */
function goldenSpecChecks(c: Checks, s: StreetSheet): void {
  c.ok("partners card lists 1 to 25 places", s.cards.partners.results.length <= 25 && s.cards.partners.results.length > 0, `${s.cards.partners.results.length} partners`, "D1");
  c.ok("at most 8 pre/post spots", s.cards.prePost.results.length <= 8, `${s.cards.prePost.results.length} spots`, "D1");
  c.ok("at most one sponsor", s.cards.media.results.filter((m) => m.kind === "sponsor").length <= 1, cardLine(s, "media"), "D1");
  c.ok("at most three copy hooks", s.cards.copyHooks.results.length <= 3, `${s.cards.copyHooks.results.length} hooks`, "D1");
  c.ok("no Google Places comparison list on the sheet", !s.control, s.control ? `${s.control.places.length} control places` : "none", "D1");
}

const GOLDEN_EXPECT_FIXTURE: Record<GoldenId, SubjectExpect> = {
  "g1-a": { cards: ALL_OK, pdf: true, budget: { venueMin: 4, venueMax: 6 } },
  "g1-b": { cards: ALL_OK, pdf: true, budget: { venueMin: 4, venueMax: 6 } },
  g2: {
    cards: {
      resolution: "partial",
      liftMap: "ok",
      partners: "partial",
      declared: "ok",
      prePost: "ok",
      media: "ok",
      demographics: "partial",
      whatsDifferent: "ok",
      copyHooks: "ok",
    },
    pdf: true,
    budget: { venueMin: 4, venueMax: 6 },
  },
  // Oct 15 2026: a comedy room with a short roster has no baseline at all (the comedy tag map came back
  // empty live, probe 19), so there is no lift map, no compare and no usual-crowd age block, and fewer
  // venue-level calls.
  g3: {
    cards: {
      resolution: "partial",
      liftMap: "degraded",
      partners: "partial",
      declared: "empty",
      prePost: "partial",
      media: "partial",
      demographics: "empty",
      whatsDifferent: "empty",
      copyHooks: "partial",
    },
    pdf: true,
    budget: { venueMin: 2, venueMax: 6 },
  },
};

/** On recorded runs only the spec's own statements about statuses are pinned. */
const GOLDEN_EXPECT_RECORDED: Record<GoldenId, SubjectExpect> = {
  "g1-a": { cards: { resolution: "ok" } },
  "g1-b": { cards: { resolution: "ok" } },
  g2: {},
  g3: {},
};

// ---------------------------------------------------------------------------
// Mock drafts for the model paths
// ---------------------------------------------------------------------------

function baseDraft(f: RunFacts): MockDraft {
  return {
    summary: "This bill's crowd over-indexes in a few named areas, listed below.",
    tileWhy: f.tiles.slice(0, 2).map((t) => ({ geohash: t.geohash, text: `${t.name ?? "This area"} leans toward this bill more than the house crowd.` })),
    partnerLines: f.partners.slice(0, 3).map((p) => ({ entityId: p.entityId, text: `${p.name} sits in one of the top tiles.` })),
    copyHooks: [],
  };
}

/** One hook sends the crowd to a bar (fan-facing alcohol), one is clean. */
function barHookDraft(f: RunFacts): MockDraft {
  const [t1, t2] = f.allowlistedTags;
  return {
    ...baseDraft(f),
    copyHooks: [
      { text: `${t1?.name ?? "Live"} night out, then a bar nearby.`, tagIds: t1 ? [t1.id] : [] },
      { text: `${t2?.name ?? "Live"}, one night only.`, tagIds: t2 ? [t2.id] : [] },
    ],
  };
}

/** Tries denied words in a copy hook and a partner line; the rest is clean. */
function deniedWordsDraft(f: RunFacts): MockDraft {
  const [t1, t2] = f.allowlistedTags;
  const base = baseDraft(f);
  const [p0, p1] = f.partners;
  return {
    ...base,
    partnerLines: [
      ...(p0 ? [{ entityId: p0.entityId, text: `${p0.name} sits in one of the top tiles.` }] : []),
      ...(p1 ? [{ entityId: p1.entityId, text: `${p1.name} is a favourite of religious groups nearby.` }] : []),
    ],
    copyHooks: [
      { text: `${t1?.name ?? "Live"}, one night only.`, tagIds: t1 ? [t1.id] : [] },
      { text: `${t2?.name ?? "Live"} for the ethnic crowd.`, tagIds: t2 ? [t2.id] : [] },
    ],
  };
}

/** Cites an entity id this run never returned: off the per-run schema, so the template takes over. */
function offSchemaDraft(f: RunFacts): MockDraft {
  return {
    ...baseDraft(f),
    partnerLines: [{ entityId: "00000000-0000-4000-8000-00000000dead", text: "A place that was never returned." }],
  };
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

export const CASES: readonly ProductCase[] = [
  // C01 ----------------------------------------------------------------------
  {
    id: "C01",
    slug: "golden-g1-a",
    title: "Golden G1, bill A: The Truth, Nashville (hero sheet)",
    covers: "Golden scenario G1; definition of done; agent loop steps 1-7",
    clauses: ["D1", "D2", "D3", "D4", "S1", "S2", "S3"],
    golden: true,
    recorded: ["g1-a"],
    async run(env) {
      const c = new Checks("g1-a");
      if (env.source === "recorded") {
        const subject = recordedSubject(env, "g1-a", GOLDEN_EXPECT_RECORDED["g1-a"]);
        goldenSpecChecks(c, sheetOf(subject.result));
        return { subjects: [subject], checks: c.list };
      }
      const { rig, run } = await goldenFixture("g1-a");
      const s = sheetOf(run.final);
      goldenSpecChecks(c, s);
      c.eq("first answer is a sheet, never needs_input", run.first.status, "complete", "D1");
      const actRows = s.cards.resolution.results.filter((r) => r.role === "headliner" || r.role === "co" || r.role === "support");
      c.eq("acts resolved exactly", actRows.map((r) => r.status), ["exact", "exact", "exact"], "S2");
      c.between("partners", s.cards.partners.results.length, 15, 25, "D1");
      c.between("pre/post spots", s.cards.prePost.results.length, 6, 8, "D1");
      c.eq("one sponsor", s.cards.media.results.filter((m) => m.kind === "sponsor").length, 1, "D1");
      c.eq("three copy hooks", s.cards.copyHooks.results.length, 3, "D1");
      c.eq("lift baseline is the room's roster", s.cards.liftMap.results.diagnostics.baseline, "house", "S2");
      const top5 = s.cards.liftMap.results.tiles.slice(0, 5);
      c.ok("top five tiles carry gazetteer names", top5.every((t) => !!t.name), top5.map((t) => t.name ?? t.geohash).join(", "), "D1");
      c.eq("paired with bill B for the swap", s.pairedPlanId, "g1-b", "S4");
      return { subjects: [fixtureSubject("g1-a", rig, run, GOLDEN_EXPECT_FIXTURE["g1-a"])], checks: c.list };
    },
  },
  // C02 ----------------------------------------------------------------------
  {
    id: "C02",
    slug: "golden-g1-b",
    title: "Golden G1, bill B: same room, all-ages bill of a distant genre",
    covers: "Golden scenario G1 (bill B); definition of done",
    clauses: ["D1", "D2", "D3", "D4", "S1", "S2", "S3"],
    golden: true,
    recorded: ["g1-b"],
    async run(env) {
      const c = new Checks("g1-b");
      if (env.source === "recorded") {
        const subject = recordedSubject(env, "g1-b", GOLDEN_EXPECT_RECORDED["g1-b"]);
        goldenSpecChecks(c, sheetOf(subject.result));
        return { subjects: [subject], checks: c.list };
      }
      const { rig, run } = await goldenFixture("g1-b");
      const s = sheetOf(run.final);
      goldenSpecChecks(c, s);
      c.eq("first answer is a sheet, never needs_input", run.first.status, "complete", "D1");
      c.eq("Ticketmaster says all-ages", s.bill.legalAgeEnforced, false, "S3");
      c.between("partners", s.cards.partners.results.length, 15, 25, "D1");
      c.between("pre/post spots", s.cards.prePost.results.length, 6, 8, "D1");
      c.match("media card states the age policy source", s.cards.media.summary, /all-ages show per Ticketmaster/, "S3");
      c.eq("paired with bill A for the swap", s.pairedPlanId, "g1-a", "S4");
      return { subjects: [fixtureSubject("g1-b", rig, run, GOLDEN_EXPECT_FIXTURE["g1-b"])], checks: c.list };
    },
  },
  // C03 ----------------------------------------------------------------------
  {
    id: "C03",
    slug: "golden-g2",
    title: "Golden G2: Hampton Coliseum comedy bill (honesty demo)",
    covers: "Golden scenario G2; needs_input; proxy seeds; declared channels; policy receipt",
    clauses: ["D1", "D2", "D3", "D4", "S1", "S2", "S3"],
    golden: true,
    recorded: ["g2"],
    async run(env) {
      const c = new Checks("g2");
      const communityLabel = /HBCU|Divine Nine|congregation/i;
      if (env.source === "recorded") {
        const subject = recordedSubject(env, "g2", GOLDEN_EXPECT_RECORDED.g2);
        const s = sheetOf(subject.result);
        goldenSpecChecks(c, s);
        const community = s.cards.declared.results.filter((d) => communityLabel.test(d.declared.label));
        c.ok("community channels stay declared, not scored", community.every((d) => d.rank === null), `${community.length} channel(s)`, "S3");
        return { subjects: [subject], checks: c.list };
      }
      const { rig, run } = await goldenFixture("g2");
      const s = sheetOf(run.final);
      goldenSpecChecks(c, s);
      c.eq("the one-word name pauses the run first", run.first.status, "needs_input", "S2");
      c.eq("resumes on the same plan id", run.final.planId, run.first.planId, "S2");
      const rows = s.cards.resolution.results;
      const thinAct = rows.find((r) => r.input === "Reggie Collier");
      c.eq("thin act gets its TV proxy (release year checked)", [thinAct?.status, thinAct?.proxy?.entity.name, thinAct?.proxy?.entity.properties.release_year], ["proxy", "Late Shift Diner", 1994], "S2");
      // Stand-ins only for a thin act (Oct 15, probes 6 and 7): the headliner is his own seed.
      const headliner = rows.find((r) => r.input === "Dorian Pike");
      c.eq(
        "headliner with enough data is his own seed, no stand-ins",
        [headliner?.status, rows.filter((r) => r.proxyFor === "Dorian Pike").length],
        ["exact", 0],
        "S2",
      );
      const declared = s.cards.declared.results;
      c.eq(
        "operator's barbershops ranked",
        declared.filter((d) => d.rank !== null).map((d) => d.declared.label).sort(),
        ["Crown & Clipper Barbershop", "Mercury Line Cuts", "Tidewater Fade Studio"],
        "S2",
      );
      const community = declared.filter((d) => communityLabel.test(d.declared.label));
      c.ok("community channels stay declared, not scored", community.length === 3 && community.every((d) => d.rank === null), `${community.length} channel(s)`, "S3");
      c.ok("receipt counts the denied tags by class", s.guard.reasons.some((r) => /^\d+ tags? denied by policy \(ethnicity/.test(r)), s.guard.reasons[0] ?? "", "S3");
      c.ok("person tags stripped before storage", s.guard.reasons.includes("Person-entity tags stripped before storage."), "", "S3");
      const venueId = s.bill.venue.qlooEntityId;
      c.ok("the venue is never a partner", !!venueId && !s.cards.partners.results.some((p) => p.entity.entityId === venueId), venueId ?? "venue not resolved", "S2");
      c.eq("no age policy from Ticketmaster, so not treated as 21+", s.bill.legalAgeEnforced, null, "S3");
      return { subjects: [fixtureSubject("g2", rig, run, GOLDEN_EXPECT_FIXTURE.g2)], checks: c.list };
    },
  },
  // C04 ----------------------------------------------------------------------
  {
    id: "C04",
    slug: "golden-g3",
    title: "Golden G3: Super Funny, Tacoma (thin signal: each fallback is labelled)",
    covers: "Golden scenario G3; no comedy baseline, so no lift map; 60 km widen; thin-signal banner",
    clauses: ["D1", "D2", "D3", "D4", "S1", "S2", "S3"],
    golden: true,
    recorded: ["g3"],
    async run(env) {
      const c = new Checks("g3");
      if (env.source === "recorded") {
        const subject = recordedSubject(env, "g3", GOLDEN_EXPECT_RECORDED.g3);
        goldenSpecChecks(c, sheetOf(subject.result));
        return { subjects: [subject], checks: c.list };
      }
      const { rig, run } = await goldenFixture("g3");
      const s = sheetOf(run.final);
      goldenSpecChecks(c, s);
      c.eq("no lift map without a usual crowd or a comedy-wide map", s.cards.liftMap.results.tiles.length, 0, "S2");
      c.match("lift map says why there is no map, and the 60 km widen", s.cards.liftMap.reason, /no comedy-wide map to compare with[\s\S]*60 km/, "S2");
      c.ok("never compares a comedy bill with a genre", !JSON.stringify([s.narration, s.cards.whatsDifferent]).includes("comedy fans in general"), "", "S2");
      c.ok("thin-signal banner on the sheet", s.limits.includes("Thin signal: treat as a starting list."), "", "S2");
      c.eq("what's different says there is nothing to compare with", s.cards.whatsDifferent.status, "empty", "S2");
      c.ok(
        "partners near the venue on a room with no map",
        s.cards.partners.results.length >= 5 && s.cards.partners.results.every((p) => p.tileGeohash === null),
        `${s.cards.partners.results.length} partners`,
        "D1",
      );
      c.eq("the unknown support act is reported, not guessed", s.cards.resolution.results.find((r) => r.input === "Margo Vint")?.status, "unresolved", "S2");
      return { subjects: [fixtureSubject("g3", rig, run, GOLDEN_EXPECT_FIXTURE.g3)], checks: c.list };
    },
  },
  // C05 ----------------------------------------------------------------------
  {
    id: "C05",
    slug: "needs-input-pause-resume",
    title: "needs_input: pause on an ambiguous name, resume with the operator's pick",
    covers: "Resolve, confirm, then ask; needs_input UX; picks cached 30 days",
    clauses: ["D4", "S2"],
    async run() {
      const c = new Checks("g2 pause");
      const store = createMemoryPlanStore();
      const choices = createMemoryChoiceStore();
      const rig = newRig({ store, choices, idPrefix: "pause" });
      const streamed: CardKey[] = [];
      const first = await planShow({ presetId: "g2" }, rig.deps, { onCard: (k) => streamed.push(k) });
      c.eq("run pauses with needs_input", first.status, "needs_input", "S2");
      const pending = first.pause?.pending ?? [];
      c.eq("asks only about the one-word name", pending.map((p) => p.input), ["Sidecar"], "S2");
      const cands = pending[0]?.candidates ?? [];
      c.ok("shows several candidates with type and popularity", cands.length >= 2 && cands.every((x) => !!x.subtype && x.popularity !== undefined), `${cands.length} candidates`, "S2");
      const person = cands.find((x) => x.subtype === "urn:entity:person");
      c.ok("the comedian is among the candidates", !!person, cands.map((x) => x.subtype).join(", "), "S2");
      c.eq("only the resolution card streams before the pause", streamed, ["resolution"], "S2");
      const nodes = Object.keys(first.budget.byNode);
      c.ok("no plan-graph call before the pause", nodes.every((n) => /^Q[123] /.test(n)), nodes.join(", "), "S1");
      c.eq("the paused plan is stored", (await store.get(first.planId))?.status, "needs_input", "S2");

      // A pick that was not among the candidates is used once and not remembered.
      const headliner = first.pause?.resolution.results.find((r) => r.status === "exact")?.entity?.entityId ?? "";
      const foreign = await planShow({ presetId: "g2", planId: first.planId, resolutions: { Sidecar: headliner } }, rig.deps);
      c.eq("a pick outside the candidates still completes that run", foreign.status, "complete", "S2");
      const again = await planShow({ presetId: "g2" }, rig.deps);
      c.eq("a pick outside the candidates is not remembered", again.status, "needs_input", "S2");

      const resumed = await planShow({ presetId: "g2", planId: again.planId, resolutions: { Sidecar: person?.entityId ?? "" } }, rig.deps);
      c.eq("resume with the operator's pick completes", resumed.status, "complete", "S2");
      c.eq("resume keeps the plan id", resumed.planId, again.planId, "S2");
      c.eq("the stored plan is now complete", (await store.get(again.planId))?.status, "complete", "S2");
      const rows = resumed.sheet?.cards.resolution.results ?? [];
      c.eq("the picked entity stands for the name", rows.find((r) => r.input === "Sidecar")?.entity?.entityId, person?.entityId, "D4");
      const later = await planShow({ presetId: "g2" }, rig.deps);
      c.eq("the pick is remembered for the next run", later.status, "complete", "S2");
      c.match("the sheet says a pick came from the operator", later.sheet?.cards.resolution.summary, /pick by the operator/, "S2");
      return {
        // The venue baseline is cached by the earlier runs of this case, so no venue calls are expected here.
        subjects: [{ label: "g2 resumed", result: resumed, first: again, tap: rig.tap, expect: { ...GOLDEN_EXPECT_FIXTURE.g2, pdf: false, budget: { venueMax: 6 } } }],
        checks: c.list,
        metrics: { candidates: cands.length },
      };
    },
  },
  // C06 ----------------------------------------------------------------------
  {
    id: "C06",
    slug: "empty-compare-tag-diff",
    title: "Empty compare falls back to a tag diff (degraded: tag diff)",
    covers: "Call graph Q8 fallback",
    clauses: ["S1", "S2"],
    async run() {
      const c = new Checks("g1-a, empty compare");
      const rig = newRig({ scenario: { emptyCompare: true }, idPrefix: "cmp" });
      const run = await runWithPick({ presetId: "g1-a" }, rig.deps);
      const s = sheetOf(run.final);
      const cmp = s.cards.whatsDifferent;
      c.match("card reason says the top tags were compared by rank", cmp.reason, /compares the two crowds' top tags by rank/, "S2");
      c.eq("result is marked as a tag diff", cmp.results.fromTagDiff, true, "S2");
      c.ok("bill-side tags still come back", cmp.results.a.length > 0, `${cmp.results.a.length} tags`, "S2");
      c.eq("two tag-profile calls, one per side", [run.final.budget.byNode["Q8 fallback: bill tags"], run.final.budget.byNode["Q8 fallback: house tags"]], [1, 1], "S1");
      return {
        subjects: [fixtureSubject("g1-a, empty compare", rig, run, { cards: { ...ALL_OK, whatsDifferent: "degraded" } })],
        checks: c.list,
      };
    },
  },
  // C07 ----------------------------------------------------------------------
  {
    id: "C07",
    slug: "thin-heatmap-widen",
    title: "Thin heatmap widens the radius to 60 km (partial: thin)",
    covers: "Call graph Q4 fallback; thin-signal banner",
    clauses: ["S1", "S2"],
    async run() {
      const c = new Checks("g1-a, thin heatmap");
      const rig = newRig({ scenario: { thinHeatmap: true }, idPrefix: "thin" });
      const run = await runWithPick({ presetId: "g1-a" }, rig.deps);
      const s = sheetOf(run.final);
      c.match("lift map says it widened to 60 km", s.cards.liftMap.reason, /widened to 60 km/, "S2");
      c.eq("one widened bill-heat call", run.final.budget.byNode["Q4 bill heat (widened to 60 km)"], 1, "S1");
      const widened = s.ledger.find((e) => /node Q4 bill heat \(widened to 60 km\)/.test(e.note ?? ""));
      c.eq("the widened call asks for 60,000 m", widened ? Number(widened.params["filter.location.radius"]) : null, 60000, "D4");
      c.eq("the operator's radius is unchanged", s.operator.radiusKm, 40, "S2");
      c.ok("thin-signal banner on the sheet", s.limits.includes("Thin signal: treat as a starting list."), "", "S2");
      return {
        subjects: [fixtureSubject("g1-a, thin heatmap", rig, run, { cards: { liftMap: "partial", resolution: "ok" } })],
        checks: c.list,
      };
    },
  },
  // C08 ----------------------------------------------------------------------
  {
    id: "C08",
    slug: "lift-weak-fallback",
    title: "Lift follows general popularity: partners are picked near the venue",
    covers: "Lift computation fallback (Spearman > 0.9)",
    clauses: ["S1", "S2"],
    async run() {
      const c = new Checks("g1-a, lift weak");
      const rig = newRig({ variant: liftWeakVariant, idPrefix: "weak" });
      const run = await runWithPick({ presetId: "g1-a" }, rig.deps);
      const s = sheetOf(run.final);
      const rho = s.cards.liftMap.results.diagnostics.spearmanLiftVsHeat;
      c.ok("Spearman(lift, raw heat) above 0.9", rho !== null && rho > 0.9, `rho ${rho}`, "S2");
      c.match("lift map says lift follows general popularity", s.cards.liftMap.reason, /follows general popularity/, "S2");
      c.ok("partners are ranked near the venue, not per tile", s.cards.partners.results.length > 0 && s.cards.partners.results.every((p) => p.tileGeohash === null), `${s.cards.partners.results.length} partners`, "S2");
      c.match("partners card says why", s.cards.partners.reason, /near the venue/, "S2");
      const q9 = Object.keys(run.final.budget.byNode).filter((n) => n.startsWith("Q9 partners"));
      c.eq("one near-venue partner pool instead of three tile pools", q9, ["Q9 partners, near venue"], "S1");
      return {
        subjects: [fixtureSubject("g1-a, lift weak", rig, run, { cards: { liftMap: "partial", partners: "partial" } })],
        checks: c.list,
        metrics: { spearmanLiftVsHeat: rho },
      };
    },
  },
  // C09 ----------------------------------------------------------------------
  {
    id: "C09",
    slug: "all-ages-alcohol-rule",
    title: "All-ages alcohol rule: from Ticketmaster only, enforced on fan-facing copy",
    covers: "Policy (no proxy inference; alcohol from ageRestrictions); two guards",
    clauses: ["D2", "S3"],
    async run() {
      const c = new Checks("alcohol rule");
      const allAgesRig = newRig({ narratorClient: mockModel(barHookDraft).client, idPrefix: "allages" });
      const allAges = await runWithPick({ presetId: "g1-b" }, allAgesRig.deps);
      const a = sheetOf(allAges.final);
      const adultRig = newRig({ narratorClient: mockModel(barHookDraft).client, idPrefix: "adult" });
      const adult = await runWithPick({ presetId: "g1-a" }, adultRig.deps);
      const b = sheetOf(adult.final);
      c.eq("Ticketmaster age policy on the two bills", [a.bill.legalAgeEnforced, b.bill.legalAgeEnforced], [false, true], "S3");
      c.eq("model narration ran on both", [a.narration?.templated, b.narration?.templated], [false, false], "S3");
      c.ok(
        "all-ages: the bar hook is dropped by the fan-facing guard",
        a.guard.reasons.some((r) => r.startsWith("fan-facing guard: copyHooks[0]") && /not 21\+/.test(r)) && a.cards.copyHooks.results.length === 1,
        `${a.cards.copyHooks.results.length} hook(s) kept`,
        "S3",
      );
      c.eq("21+: the same hook is kept", b.cards.copyHooks.results.length, 2, "S3");
      const q9a = a.ledger.filter((e) => (e.note ?? "").includes("node Q9"));
      c.ok("all-ages: partner pools exclude night clubs", q9a.length > 0 && q9a.every((e) => String(e.params["filter.exclude.tags"] ?? "").includes("night_club")), `${q9a.length} pool call(s)`, "S3");
      const q9b = b.ledger.filter((e) => (e.note ?? "").includes("node Q9"));
      c.ok("21+: no exclusion", q9b.length > 0 && q9b.every((e) => e.params["filter.exclude.tags"] === undefined), `${q9b.length} pool call(s)`, "S3");
      const barsA = a.cards.prePost.results.filter((x) => isBarCategory(x.category ?? ""));
      const barsB = b.cards.prePost.results.filter((x) => isBarCategory(x.category ?? ""));
      c.ok("all-ages: bars near the room are operator-only", barsA.every((x) => !x.fanFacingAllowed), `${barsA.length} bar(s)`, "S3");
      c.ok("21+: bars near the room may face fans", barsB.length > 0 && barsB.every((x) => x.fanFacingAllowed), `${barsB.length} bar(s)`, "S3");
      c.ok("all-ages: alcohol tags held back from copy", a.guard.reasons.some((r) => /held back from copy on a show that is not 21\+ \(alcohol\)/.test(r)), "", "S3");
      return {
        subjects: [
          fixtureSubject("g1-b all-ages, model", allAgesRig, allAges, { guardDrops: 1, citationDrops: 0, cards: { copyHooks: "partial" } }),
          fixtureSubject("g1-a 21+, model", adultRig, adult, { guardDrops: 0, cards: { copyHooks: "partial" } }),
        ],
        checks: c.list,
      };
    },
  },
  // C10 ----------------------------------------------------------------------
  {
    id: "C10",
    slug: "denied-tags-never-in-copy",
    title: "Denied tags and words never reach copy or stored data",
    covers: "Copy denylist (CI-tested, comedy bill as the regression case); person tags stripped",
    clauses: ["D2", "S3"],
    async run() {
      const c = new Checks("g2, denied tags");
      const seen: RunFacts[] = [];
      const model = mockModel((f) => {
        seen.push(f);
        return deniedWordsDraft(f);
      });
      const store = createMemoryPlanStore();
      const rig = newRig({ narratorClient: model.client, store, idPrefix: "denied" });
      const run = await runWithPick({ presetId: "g2" }, rig.deps);
      const s = sheetOf(run.final);
      c.ok("the world served denied example tags", s.guard.deniedTagCount > 0, `${s.guard.deniedTagCount} counted`, "S3");
      c.ok("the model saw no denied tag", seen.length > 0 && seen.every((f) => f.allowlistedTags.every((t) => !isDeniedTag(t))), `${seen.length} call(s)`, "S3");
      c.ok(
        "a hook with a denied word is dropped",
        s.cards.copyHooks.results.every((h) => !/ethnic/i.test(h.text)) && s.guard.reasons.some((r) => /^copyHooks\[1\]: denied keyword/.test(r)),
        s.guard.reasons.filter((r) => r.startsWith("copyHooks")).join(" | "),
        "S3",
      );
      c.ok(
        "a partner line with a denied word is dropped",
        (s.narration?.partnerLines ?? []).every((l) => !/religio/i.test(l.text)) && s.guard.reasons.some((r) => /^partnerLines\[1\]: denied keyword/.test(r)),
        s.guard.reasons.filter((r) => r.startsWith("partnerLines")).join(" | "),
        "S3",
      );
      const stored = JSON.stringify(await store.get(run.final.planId));
      const sheetJson = JSON.stringify(s);
      const leaked = DENIED_EXAMPLE_TAGS.filter((t) => sheetJson.includes(t.id) || stored.includes(t.id) || sheetJson.includes(t.name) || stored.includes(t.name));
      c.ok("no denied tag id or name anywhere in the sheet or the stored plan", leaked.length === 0, leaked.map((t) => t.id).join(", ") || `${DENIED_EXAMPLE_TAGS.length} denied ids checked`, "S3");
      const keywords = DENIED_TAG_KEYWORDS.filter((k) => s.cards.copyHooks.results.some((h) => h.text.toLowerCase().includes(k)));
      c.ok("no denied keyword in any copy hook", keywords.length === 0, keywords.join(", ") || "none", "S3");
      return {
        subjects: [fixtureSubject("g2, model tries denied words", rig, run, { guardDrops: 2, citationDrops: 0 })],
        checks: c.list,
        metrics: { deniedTagCount: s.guard.deniedTagCount },
      };
    },
  },
  // C11 ----------------------------------------------------------------------
  {
    id: "C11",
    slug: "closed-place-dropped",
    title: "Places marked closed are dropped and counted",
    covers: "Partner scoring (is_closed=false required); grounding",
    clauses: ["D3", "S2"],
    async run() {
      const c = new Checks("g1-a, closed places");
      const rig = newRig({ scenario: { closedRate: 0.35 }, idPrefix: "closed" });
      const run = await runWithPick({ presetId: "g1-a" }, rig.deps);
      const s = sheetOf(run.final);
      const closed = [...s.cards.partners.results, ...s.cards.prePost.results].filter((x) => x.entity.properties.is_closed === true);
      c.eq("no closed place on the sheet", closed.length, 0, "D3");
      const m = /Dropped (\d+) places? marked closed/.exec(s.cards.partners.summary);
      c.ok("the partners card counts the dropped places", !!m && Number(m[1]) > 0, s.cards.partners.summary, "S2");
      return {
        subjects: [fixtureSubject("g1-a, closed places", rig, run, { cards: { partners: ["ok", "partial"] } })],
        checks: c.list,
        metrics: { droppedClosed: m ? Number(m[1]) : 0 },
      };
    },
  },
  // C12 ----------------------------------------------------------------------
  {
    id: "C12",
    slug: "unknown-hours",
    title: "A place with unknown hours is kept and marked call ahead",
    covers: "Hours double-check against properties.hours; grounding",
    clauses: ["D3", "S2"],
    async run() {
      const c = new Checks("g1-a, unknown hours");
      const rig = newRig({ scenario: { noHoursRate: 0.4 }, idPrefix: "hours" });
      const run = await runWithPick({ presetId: "g1-a" }, rig.deps);
      const s = sheetOf(run.final);
      const unknown = s.cards.partners.results.filter((p) => p.hoursOnDay === null);
      c.ok("some partners have unknown hours", unknown.length > 0, `${unknown.length} of ${s.cards.partners.results.length}`, "S2");
      c.match("the partners card says call ahead", s.cards.partners.summary, /list no hours for \w+: call first/, "S2");
      const known = s.cards.partners.results.filter((p) => p.hoursOnDay !== null);
      c.ok("every other partner shows its hours for the street-team day", known.every((p) => typeof p.hoursOnDay === "string" && p.hoursOnDay.length > 0), `${known.length} with hours`, "D3");
      return {
        subjects: [fixtureSubject("g1-a, unknown hours", rig, run, { cards: { partners: ["ok", "partial"] } })],
        checks: c.list,
        metrics: { unknownHours: unknown.length },
      };
    },
  },
  // C13 ----------------------------------------------------------------------
  {
    id: "C13",
    slug: "quota-guard-cache",
    title: "Month quota guard: fresh calls stop, presets come from the store or cache",
    covers: "Global rules (month guard below 1,500); cost caps",
    clauses: ["S1", "S2"],
    async run() {
      const c = new Checks("quota guard");
      const store = createMemoryPlanStore();
      const rig = newRig({ store, idPrefix: "quota" });
      const first = await planShow({ presetId: "g1-a" }, rig.deps);
      c.eq("a normal run first", first.status, "complete", "S2");
      rig.world.setScenario({ quotaRemaining: 1400 });
      const guarded = await planShow({ presetId: "g1-b" }, rig.deps);
      c.ok("the guard trips under the 1,500 floor", rig.deps.qloo.guardTripped(), "", "S1");
      const gs = sheetOf(guarded);
      const degraded = Object.entries(gs.cards).filter(([, card]) => card.status === "degraded" && /quota/i.test(card.reason ?? ""));
      c.ok("refused nodes show degraded with the quota reason", degraded.length > 0, degraded.map(([k]) => k).join(", "), "S2");
      c.ok("the ledger records the refusals", gs.ledger.some((e) => /month guard/.test(e.note ?? "")), "", "S1");
      c.ok("at most one fresh call once the quota is low", guarded.budget.qlooFresh <= 1, `${guarded.budget.qlooFresh} fresh`, "S1");
      const streamed: CardKey[] = [];
      const served = await planShow({ presetId: "g1-a" }, rig.deps, { onCard: (k) => streamed.push(k) });
      c.eq("the preset is served from the stored sheet", [served.servedFromStore, served.planId], [true, first.planId], "S1");
      c.eq("stored cards stream in order", streamed, [...CARD_ORDER], "S2");
      const cached = await planShow({ presetId: "g1-a" }, rig.deps, { serveFromStoreWhenGuarded: false, persist: false });
      const cs = sheetOf(cached);
      const qloo = cs.ledger.filter((e) => e.kind === "qloo");
      c.ok("every Qloo call is a cache hit", qloo.length > 10 && qloo.every((e) => e.cacheHit), `${qloo.length} calls`, "S1");
      const before = sheetOf(first).cards as unknown as Record<string, { status: string }>;
      const changed = Object.entries(cs.cards).filter(([k, card]) => card.status !== before[k]?.status).map(([k]) => k);
      c.ok("the cached sheet has the same card statuses", changed.length === 0, changed.join(", ") || "same", "S2");
      return {
        subjects: [
          fixtureSubject("g1-a from cache under the guard", rig, cached, { cards: ALL_OK, budget: { freshExact: 0, venueMax: 0 } }),
          // A fresh bill under the guard: degraded cards, but still a sheet whose every claim traces to the ledger.
          fixtureSubject("g1-b under the guard", rig, guarded, { budget: false }),
        ],
        checks: c.list,
      };
    },
  },
  // C14 ----------------------------------------------------------------------
  {
    id: "C14",
    slug: "rate-limit-429-retry",
    title: "HTTP 429 then success: retried, logged, same sheet",
    covers: "Global rules (at most 2 retries on 429/5xx)",
    clauses: ["S1", "S2"],
    async run() {
      const c = new Checks("g1-a, 429 once");
      const rig = newRig({ scenario: { rateLimitOnce: true }, idPrefix: "rl" });
      const run = await runWithPick({ presetId: "g1-a" }, rig.deps);
      const s = sheetOf(run.final);
      const fresh = s.ledger.filter((e) => e.kind === "qloo" && !e.cacheHit);
      const retried = fresh.filter((e) => /retry 1 after HTTP 429/.test(e.note ?? ""));
      c.ok("every fresh Qloo call shows its retry in the ledger", fresh.length > 0 && retried.length === fresh.length, `${retried.length} of ${fresh.length}`, "S1");
      const plainRig = newRig({ idPrefix: "plain" });
      const plain = sheetOf((await runWithPick({ presetId: "g1-a" }, plainRig.deps)).final);
      c.eq("same partners as a run without 429s", topPartnerIds(s, 25), topPartnerIds(plain, 25), "S2");
      c.eq("a retry is not a second ledger entry", s.ledger.filter((e) => e.kind === "qloo").length, plain.ledger.filter((e) => e.kind === "qloo").length, "S1");
      return { subjects: [fixtureSubject("g1-a, 429 once", rig, run, { cards: ALL_OK, budget: { venueMin: 4 } })], checks: c.list };
    },
  },
  // C15 ----------------------------------------------------------------------
  {
    id: "C15",
    slug: "declared-not-in-catalog",
    title: "Declared partners: catalog places ranked, the rest kept in your order",
    covers: "Call graph Q11 (pick list, cap 20, filter.results.entities); contacts never stored",
    clauses: ["S1", "S2", "S3"],
    async run() {
      const c = new Checks("g1-b, declared list");
      const email = "street-lead@example.invalid";
      const invented = Array.from({ length: 20 }, (_, i) => ({ label: `Example Print Shop No. ${i + 1}` }));
      const declared = [
        { label: "Bellhop Records", contactEmail: email },
        { label: "Tin Heron Tavern" },
        { label: "Larkspur Cup Coffee", qlooEntityId: catalogByKey("larkspur_cup").id },
        ...invented,
      ];
      const store = createMemoryPlanStore();
      const rig = newRig({ store, idPrefix: "declared" });
      const run = await runWithPick({ presetId: "g1-b", operator: { declaredPartners: declared } }, rig.deps);
      const s = sheetOf(run.final);
      const rows = s.cards.declared.results;
      c.eq("every declared partner stays on the list", rows.length, declared.length, "S2");
      c.eq(
        "catalog places are ranked",
        rows.filter((r) => r.rank !== null).map((r) => r.declared.label).sort(),
        ["Bellhop Records", "Larkspur Cup Coffee", "Tin Heron Tavern"],
        "S2",
      );
      c.eq("the rest are declared, not scored", rows.filter((r) => r.rank === null).length, 20, "S2");
      c.match("the card says so", s.cards.declared.summary, /not in Qloo's catalog, kept in your order/, "S2");
      c.eq("typed-name lookups stop at the cap of 20", run.final.budget.byNode["Q11 declared pick list"], 20, "S1");
      const q11 = s.ledger.find((e) => /node Q11 declared partners/.test(e.note ?? ""));
      const shortlist = String(q11?.params["filter.results.entities"] ?? "");
      c.eq("one shortlist call scores the resolved ids", shortlist.split(",").filter(Boolean).length, 3, "D4");
      const stored = JSON.stringify(await store.get(run.final.planId));
      c.ok("the typed contact email is never stored or printed", !JSON.stringify(s).includes(email) && !stored.includes(email), "", "S3");
      c.ok("the typed contact email never reaches Qloo", !JSON.stringify(s.ledger).includes(email), "", "S3");
      return {
        subjects: [fixtureSubject("g1-b, 23 declared partners", rig, run, { budget: { venueMin: 4 }, cards: { declared: "ok" } })],
        checks: c.list,
      };
    },
  },
  // C16 ----------------------------------------------------------------------
  {
    id: "C16",
    slug: "partner-diversity-caps",
    title: "Partner diversity caps hold, even on a bar-heavy category set",
    covers: "Deterministic scoring (2 per category per tile, 1 non-bar per tile, 8 per tile, 25 total)",
    clauses: ["S2", "S3"],
    async run() {
      const c = new Checks("diversity caps");
      const plainRig = newRig({ idPrefix: "caps" });
      const plain = await runWithPick({ presetId: "g1-a" }, plainRig.deps);
      const barRig = newRig({ idPrefix: "bars" });
      const bars = await runWithPick({ presetId: "g1-a", categories: ["bar", "pub", "sports_bar", "restaurant"] }, barRig.deps);
      for (const [label, r] of [["default categories", plain], ["bar-heavy categories", bars]] as const) {
        const s = sheetOf(r.final);
        const partners = s.cards.partners.results;
        const byTile = new Map<string, typeof partners>();
        for (const p of partners) {
          const k = p.tileGeohash ?? "near-venue";
          byTile.set(k, [...(byTile.get(k) ?? []), p]);
        }
        const overCategory: string[] = [];
        const overTile: string[] = [];
        const allBars: string[] = [];
        for (const [tile, list] of byTile) {
          const perCat = new Map<string, number>();
          for (const p of list) perCat.set(p.category, (perCat.get(p.category) ?? 0) + 1);
          for (const [cat, n] of perCat) if (n > 2) overCategory.push(`${tile}/${cat}: ${n}`);
          if (list.length > 8) overTile.push(`${tile}: ${list.length}`);
          if (list.every((p) => isBarCategory(p.category))) allBars.push(tile);
        }
        c.ok(`${label}: at most 2 per category per tile`, overCategory.length === 0, overCategory.join(", ") || `${byTile.size} tiles`, "S2");
        c.ok(`${label}: at most 8 per tile`, overTile.length === 0, overTile.join(", ") || "ok", "S2");
        c.ok(`${label}: at least one non-bar per tile`, allBars.length === 0, allBars.join(", ") || "ok", "S2");
        c.ok(`${label}: at most 25 partners`, partners.length <= 25, `${partners.length}`, "S2");
        c.eq(`${label}: no partner listed twice`, new Set(partners.map((p) => p.entity.entityId)).size, partners.length, "S2");
      }
      const barShare = sheetOf(bars.final).cards.partners.results.filter((p) => isBarCategory(p.category)).length;
      return {
        subjects: [fixtureSubject("g1-a, bar-heavy categories", barRig, bars, { budget: { venueMin: 4 } })],
        checks: c.list,
        metrics: { barHeavyBars: barShare, barHeavyPartners: sheetOf(bars.final).cards.partners.results.length },
      };
    },
  },
  // C17 ----------------------------------------------------------------------
  {
    id: "C17",
    slug: "budget-split-sums-to-one",
    title: "Budget split: shares sum to 1 over spread top tiles, labelled a heuristic",
    covers: "Budget split (lift x adults 21+, minimum per tile, heuristic not a forecast)",
    clauses: ["S2", "S3"],
    recorded: ["g1-a", "g1-b", "g2", "g3"],
    recordedNeeds: "any",
    async run(env) {
      const c = new Checks("budget split");
      const sheets: { label: string; s: StreetSheet }[] = [];
      const subjects: Subject[] = [];
      if (env.source === "recorded") {
        for (const id of ["g1-a", "g1-b", "g2", "g3"] as const) {
          const r = env.recorded?.get(id);
          if (r?.result.sheet) sheets.push({ label: id, s: r.result.sheet });
        }
      } else {
        for (const id of ["g1-a", "g2", "g3"] as const) {
          const rig = newRig({ idPrefix: `split-${id}` });
          const run = await runWithPick({ presetId: id }, rig.deps);
          sheets.push({ label: id, s: sheetOf(run.final) });
          subjects.push(fixtureSubject(`${id}, budget split`, rig, run, { budget: false, grounding: false }));
        }
      }
      c.ok("sheets to check", sheets.length > 0, `${sheets.length}`, "S2");
      for (const { label, s } of sheets) {
        const split = s.budgetSplit ?? [];
        if (s.cards.liftMap.results.tiles.length === 0) {
          // No lift map (G3: no usual crowd and no comedy-wide map), so there is nothing to split.
          c.ok(`${label}: no lift map, so no budget split`, split.length === 0, `${split.length} tiles`, "S2");
          continue;
        }
        const sum = split.reduce((t, b) => t + b.share, 0);
        c.ok(`${label}: shares sum to 1`, split.length > 0 && Math.abs(sum - 1) < 0.0005, `${split.length} tiles, sum ${sum.toFixed(4)}`, "S2");
        c.ok(`${label}: at most 5 tiles, each at least the 0.1 minimum`, split.length <= 5 && split.every((b) => b.share >= 0.1 - 0.0005), split.map((b) => b.share).join(", "), "S2");
        c.ok(`${label}: labelled a heuristic`, split.every((b) => b.label === "heuristic, not a forecast"), "", "S3");
        const tiles = new Map(s.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
        const pts = split.map((b) => tiles.get(b.geohash)).filter((t) => !!t);
        let tooClose = 0;
        for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) if (haversineM(pts[i]!, pts[j]!) < 3000) tooClose++;
        c.ok(`${label}: split tiles at least 3 km apart`, pts.length === split.length && tooClose === 0, `${tooClose} close pair(s)`, "S2");
      }
      return { subjects, checks: c.list };
    },
  },
  // C18 ----------------------------------------------------------------------
  {
    id: "C18",
    slug: "bill-swap-specificity",
    title: "Swap the bill: same room, different crowd (top-8 overlap at most 5 of 8)",
    covers: "Proof plan P2 specificity; Swap the bill; venue baseline cached",
    clauses: ["S4", "S1"],
    recorded: ["g1-a", "g1-b"],
    async run(env) {
      const c = new Checks("swap");
      let a: StreetSheet;
      let b: StreetSheet;
      const subjects: Subject[] = [];
      if (env.source === "recorded") {
        a = sheetOf(recordedRun(env, "g1-a").result);
        b = sheetOf(recordedRun(env, "g1-b").result);
      } else {
        const rig = newRig({ idPrefix: "swap" });
        const runA = await runWithPick({ presetId: "g1-a" }, rig.deps);
        const runB = await runWithPick({ presetId: "g1-b" }, rig.deps);
        a = sheetOf(runA.final);
        b = sheetOf(runB.final);
        const warm = runB.final.budget;
        c.ok("bill B reuses the cached venue baseline", warm.venueLevel <= 2 && warm.qlooCached >= 3, `${warm.venueLevel} venue call(s), ${warm.qlooCached} cached`, "S1");
        // The plan's own calls; the trust checks (split-half heatmaps, partner house and popularity twins) are counted apart, at most 10.
        const read = readBudget(warm);
        c.between("bill B fresh calls with the venue cached (about 14-18, not counting trust checks)", warm.billLevel + warm.venueLevel - read.checks, 12, 18, "S1");
        c.between("bill B trust-check calls (split-half heatmaps, house and popularity twins)", read.checks, 0, 10, "S1");
        subjects.push(fixtureSubject("g1-b after g1-a (warm venue)", rig, runB, { cards: ALL_OK, budget: { venueMax: 2 }, grounding: false }));
      }
      const topA = topPartnerIds(a);
      const topB = topPartnerIds(b);
      const overlap = topKOverlap(topA, topB, 8);
      c.ok("top-8 partner overlap at most 5 of 8", topA.length === 8 && topB.length === 8 && overlap <= 5, `${overlap} of 8`, "S4");
      const jac = meanPairwiseJaccard([topA, topB], 8);
      c.ok("P2 specificity: Jaccard of the top-8 lists at most 5/11", jac !== null && jac <= 5 / 11 + 1e-9, `Jaccard ${jac?.toFixed(3)}`, "S4");
      const tilesA = a.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3).slice(0, 5).map((t) => t.geohash);
      const tilesB = new Set(b.cards.liftMap.results.tiles.filter((t) => t.lift >= 1.3).slice(0, 5).map((t) => t.geohash));
      const sharedTiles = tilesA.filter((g) => tilesB.has(g)).length;
      c.ok("top-5 lift tiles differ", tilesA.length > 0 && sharedTiles < tilesA.length, `${sharedTiles} of ${tilesA.length} shared`, "S4");
      c.eq("same room", [a.bill.venue.name, a.bill.venue.lat, a.bill.venue.lon], [b.bill.venue.name, b.bill.venue.lat, b.bill.venue.lon], "S4");
      c.eq("each sheet points at the other", [a.pairedPlanId, b.pairedPlanId], ["g1-b", "g1-a"], "S4");
      const prePostOverlap = topKOverlap(
        a.cards.prePost.results.map((x) => x.entity.entityId),
        b.cards.prePost.results.map((x) => x.entity.entityId),
        8,
      );
      return { subjects, checks: c.list, metrics: { top8Overlap: overlap, top8Jaccard: jac === null ? null : Number(jac.toFixed(4)), sharedTopTiles: sharedTiles, prePostOverlap } };
    },
  },
  // C19 ----------------------------------------------------------------------
  {
    id: "C19",
    slug: "house-baseline-degraded",
    title: "House heatmap fails: the genre tag baseline stands in (degraded: tag baseline)",
    covers: "Call graph Q5 fallback; honest baseline wording",
    clauses: ["S1", "S2", "S3"],
    async run() {
      const c = new Checks("g1-a, house heat fails");
      const rig = newRig({ variant: failingHouseHeatVariant, idPrefix: "house" });
      const run = await runWithPick({ presetId: "g1-a" }, rig.deps);
      const s = sheetOf(run.final);
      c.match("lift map says why", s.cards.liftMap.reason, /house heat failed/, "S2");
      c.eq("lift baseline is the genre tag", s.cards.liftMap.results.diagnostics.baseline, "tag", "S2");
      c.ok("the map still has tiles", s.cards.liftMap.results.tiles.length > 0, `${s.cards.liftMap.results.tiles.length} tiles`, "S2");
      c.eq("one tag-baseline heat call", run.final.budget.byNode["Q5 house heat (tag baseline)"], 1, "S1");
      c.ok("the failed call is in the ledger", s.ledger.some((e) => e.kind === "qloo" && e.httpStatus === 500), "", "D4");
      const text = [s.narration?.summary ?? "", ...(s.narration?.tileWhy ?? []).map((t) => t.text)].join(" ");
      c.ok("narration names the genre, not the room's usual crowd", !/house crowd|room's usual crowd/.test(text) && /fans in general/.test(text), "", "S3");
      return {
        subjects: [
          // The failed Q5 call and its tag-baseline replacement are both venue-level: one more than a cold venue's 6.
          fixtureSubject("g1-a, house heat fails", rig, run, { cards: { liftMap: "degraded", resolution: "ok" }, budget: { venueMin: 4, venueMax: 7 } }),
        ],
        checks: c.list,
      };
    },
  },
  // C20 ----------------------------------------------------------------------
  {
    id: "C20",
    slug: "narration-template-path",
    title: "Narration falls back to the deterministic template (no model, model error, off-schema draft)",
    covers: "Agent loop step 6 (schema per run) and step 7 (guard); template fallback",
    clauses: ["D2", "D4", "S2"],
    async run() {
      const c = new Checks("template");
      const variants = [
        { label: "no model", why: "llm_off", model: null },
        { label: "model error", why: "api_error", model: failingModel() },
        { label: "off-schema draft", why: "parse_failed", model: mockModel(offSchemaDraft) },
      ] as const;
      const subjects: Subject[] = [];
      const outputs: { label: string; s: StreetSheet }[] = [];
      for (const v of variants) {
        const rig = newRig({ narratorClient: v.model?.client ?? null, idPrefix: `tpl-${v.why}` });
        const run = await runWithPick({ presetId: "g1-a" }, rig.deps);
        const s = sheetOf(run.final);
        outputs.push({ label: v.label, s });
        c.eq(`${v.label}: narration is templated`, s.narration?.templated, true, "S2");
        c.ok(`${v.label}: the sheet says why`, s.guard.reasons.includes(templateLine(v.why)), s.guard.reasons.find((r) => r.startsWith("The summary came from")) ?? "no line", "S2");
        if (v.model) c.ok(`${v.label}: the model was asked once`, v.model.calls() === 1, `${v.model.calls()} call(s)`, "S2");
        else c.eq(`${v.label}: no model call in the ledger`, s.ledger.filter((e) => e.kind === "anthropic").length, 0, "S2");
        c.ok(`${v.label}: the invented id never reaches the sheet`, !JSON.stringify(s).includes("00000000-0000-4000-8000-00000000dead"), "", "D4");
        subjects.push(fixtureSubject(`g1-a, ${v.label}`, rig, run, { cards: ALL_OK, grounding: v.why === "llm_off" }));
      }
      const [first, ...rest] = outputs;
      for (const o of rest) {
        c.eq(
          `${o.label}: same template text as with no model`,
          [o.s.narration?.summary, o.s.narration?.partnerLines, o.s.cards.copyHooks.results],
          [first!.s.narration?.summary, first!.s.narration?.partnerLines, first!.s.cards.copyHooks.results],
          "S2",
        );
      }
      return { subjects, checks: c.list };
    },
  },
];
