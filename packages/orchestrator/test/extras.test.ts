/**
 * Sheet extras on the fixture world: the step stream (`sheet.steps`, also
 * streamed through onStep), the discovery picked by its fixed rule, and
 * "why this place" on every partner. Every number those texts print must be
 * on the sheet, every receipt must be in the run's ledger, and none of it may
 * cost a Qloo call.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Envelope, Partner, StreetSheet, TraceStep } from "@walkup/contracts";
import { TRACE_STEP_KINDS } from "@walkup/contracts";
import {
  activationFor,
  collectFactNumbers,
  distanceFromVenueKm,
  findAlcoholTerm,
  findTextViolations,
  isDeniedTag,
  LIFT_DEFAULTS,
  mostCommonCategories,
  rankAreas,
  type NarrationFacts,
} from "@walkup/engine";
import { planShow, type PlanResult } from "../src/index";
import type { TraceOptions } from "../src/steps/trace";
import { allEntities, deps, sheetOf } from "./helpers";
import type { FixtureDeps } from "../src/deps";

interface Run {
  first: PlanResult;
  final: PlanResult;
  firstSteps: TraceStep[];
  finalSteps: TraceStep[];
  partnersCard: Envelope<unknown> | null;
}

async function run(id: string, d: FixtureDeps, operator?: Record<string, unknown>): Promise<Run> {
  const firstSteps: TraceStep[] = [];
  const finalSteps: TraceStep[] = [];
  let partnersCard: Envelope<unknown> | null = null;
  const opts = (sink: TraceStep[]): TraceOptions & { arms: ["F"]; onCard: (k: string, e: Envelope<unknown>) => void } => ({
    arms: ["F"],
    onStep: (s) => sink.push(s),
    onCard: (k, e) => {
      if (k === "partners") partnersCard = e;
    },
  });
  const first = await planShow({ presetId: id, ...(operator ? { operator } : {}) }, d, opts(firstSteps));
  if (first.status !== "needs_input" || !first.pause) return { first, final: first, firstSteps, finalSteps: firstSteps, partnersCard };
  const resolutions: Record<string, string> = {};
  for (const p of first.pause.pending) {
    const pick = p.candidates.find((c) => c.subtype === "urn:entity:person") ?? p.candidates[0];
    if (pick) resolutions[p.input] = pick.entityId;
  }
  const final = await planShow({ presetId: id, resolutions, planId: first.planId, ...(operator ? { operator } : {}) }, d, opts(finalSteps));
  return { first, final, firstSteps, finalSteps, partnersCard };
}

const IDS = ["g1-a", "g1-b", "g2", "g3"] as const;
const runs: Record<string, Run> = {};

beforeAll(async () => {
  const d = deps();
  for (const id of IDS) runs[id] = await run(id, d);
}, 180_000);

const sheet = (id: string): StreetSheet => sheetOf(runs[id]!.final);

/** Every number and name the sheet carries outside the extras themselves. */
function sheetFacts(s: StreetSheet): NarrationFacts {
  // Numeric fields only (explain.distanceKm counts: it is a field), plus the texts below; never the extras' own text.
  const base = { ...s, steps: undefined, discovery: undefined };
  const texts: string[] = [...s.limits, ...s.guard.reasons];
  for (const c of Object.values(s.cards) as Envelope<unknown>[]) texts.push(c.summary, c.reason ?? "", ...c.limits);
  texts.push(s.cards.liftMap.results.liftDiagnostics?.method ?? "", s.cards.liftMap.results.liftDiagnostics?.note ?? "");
  for (const p of s.cards.partners.results) texts.push(...p.chips.map((c) => c.label));
  const lengths: number[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      lengths.push(v.length);
      v.forEach(walk);
    } else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(base);
  const maxLen = Math.max(0, ...lengths);
  const floor = s.cards.liftMap.results.liftDiagnostics?.billFloor;
  const numbers = [
    ...collectFactNumbers([base]),
    ...collectFactNumbers(texts, { includeStrings: true }),
    ...lengths,
    ...Array.from({ length: maxLen }, (_, i) => i + 1),
    // The percentile floor is written on a 0-100 scale in prose ("percentile 70").
    ...(typeof floor === "number" ? [Math.round(floor * 100)] : []),
  ];
  const names = [
    ...s.bill.acts.map((a) => a.name),
    s.bill.venue.name,
    s.bill.venue.city,
    ...allEntities(s).map((e) => e.name),
    ...s.cards.liftMap.results.tiles.map((t) => t.name ?? ""),
    ...s.cards.partners.results.flatMap((p) => [p.tileName ?? "", p.explain?.areaName ?? "", p.hoursOnDay ?? ""]),
  ].filter((n) => n !== "");
  return { entityIds: [], geohashes: [], numbers, allowlistTagIds: [], allowlistTagNames: [], names, ledgerRefs: s.ledger.map((e) => e.id) };
}

function textsOf(s: StreetSheet): { where: string; text: string; extraNumbers?: number[] }[] {
  const out: { where: string; text: string; extraNumbers?: number[] }[] = [];
  for (const st of s.steps ?? []) {
    out.push({ where: `step ${st.id} decision`, text: st.decision });
    if (!st.cause) continue;
    if (st.id === "partners-usual" && /fell off the list\.$/.test(st.decision)) {
      // The cause starts with the dropped names (places off the list); the count is the number of names.
      const [names = "", ...rest] = st.cause.split(": ");
      const count = names.split(/, | and /).length;
      out.push({ where: `step ${st.id} cause`, text: rest.join(": ") });
      out[out.length - 2] = { where: `step ${st.id} decision`, text: st.decision, extraNumbers: [count] };
    } else out.push({ where: `step ${st.id} cause`, text: st.cause });
  }
  if (s.discovery) out.push({ where: "discovery headline", text: s.discovery.headline }, { where: "discovery detail", text: s.discovery.detail }, { where: "discovery rule", text: s.discovery.rule });
  for (const p of s.cards.partners.results) {
    if (!p.explain) continue;
    out.push({ where: `${p.entity.name} why`, text: p.explain.confidenceWhy }, { where: `${p.entity.name} ask`, text: p.explain.activation }, { where: `${p.entity.name} limits`, text: p.explain.limits ?? "" });
  }
  return out;
}

describe("the step stream", () => {
  const order: Record<string, string[]> = {
    "g1-a": ["resolve", "baseline", "heat", "heat-check", "partners", "partners-usual", "declared", "prepost", "media", "narrate", "guard", "control"],
    "g1-b": ["resolve", "baseline", "heat", "heat-check", "partners", "partners-usual", "declared", "prepost", "media", "narrate", "guard", "control"],
    g2: ["pause-1", "resolve", "baseline", "heat", "heat-check", "partners", "partners-usual", "declared", "prepost", "media", "narrate", "guard", "control"],
    g3: ["resolve", "baseline", "heat", "partners", "prepost", "media", "narrate", "guard", "control"],
  };
  for (const id of IDS) {
    it(`${id}: one step per decision, in run order, with receipts from this run`, () => {
      const s = sheet(id);
      const steps = s.steps ?? [];
      expect(steps.map((x) => x.id)).toEqual(order[id]);
      const ledger = new Set(s.ledger.map((e) => e.id));
      for (const st of steps) {
        expect(TRACE_STEP_KINDS).toContain(st.kind);
        expect(st.decision).toMatch(/^[A-Z].*\.$/);
        for (const r of st.ledgerRefs) expect(ledger.has(r), `${st.id} cites ${r}`).toBe(true);
      }
      const byId = new Map(steps.map((x) => [x.id, x]));
      expect(byId.get("resolve")?.status).toBe(s.cards.resolution.status);
      expect(byId.get("partners")?.status).toBe(s.cards.partners.status);
      expect(byId.get("prepost")?.status).toBe(s.cards.prePost.status);
      expect(byId.get("media")?.status).toBe(s.cards.media.status);
      expect(byId.get("heat")?.status).toBe(s.cards.liftMap.status);
    });
    it(`${id}: streams the same steps through onStep`, () => {
      expect(runs[id]!.finalSteps).toEqual(sheet(id).steps);
    });
  }
  it("records the pause on G2, while waiting and after the pick", () => {
    const r = runs.g2!;
    expect(r.first.status).toBe("needs_input");
    expect(r.first.sheet).toBeUndefined();
    const waiting = r.firstSteps.find((x) => x.kind === "pause");
    expect(waiting).toMatchObject({ status: "needs_input" });
    expect(waiting?.decision).toMatch(/^Waiting for you to say which Sidecar is on the bill: the search found \d+\.$/);
    expect(r.firstSteps.find((x) => x.id === "resolve")?.status).toBe("needs_input");
    const answered = sheet("g2").steps?.[0];
    expect(answered).toMatchObject({ kind: "pause", status: "ok" });
    expect(answered?.decision).toMatch(/^Stopped to ask which Sidecar you meant/);
  });
  it("says so when a step fell back (G3: no usual crowd, no comedy baseline, no map, thin list)", () => {
    const by = new Map((sheet("g3").steps ?? []).map((x) => [x.id, x]));
    expect(by.get("baseline")).toMatchObject({ status: "degraded", decision: "Couldn't build the room's usual crowd." });
    expect(by.get("baseline")?.cause).toMatch(/comedy has no genre-wide crowd to stand in\.$/);
    expect(by.get("heat")?.decision).toBe("No lift map: there is no usual crowd to compare this bill with.");
    expect(by.has("heat-check")).toBe(false);
    expect(by.get("partners")?.cause).toMatch(/treat it as a starting list\.$/);
    expect(by.get("control")?.status).toBe("degraded");
  });
  it("names the places the room's usual crowd ranks as high (G1-A)", () => {
    const st = (sheet("g1-a").steps ?? []).find((x) => x.id === "partners-usual");
    expect(st?.decision).toMatch(/^Marked down the places the room's usual crowd ranks as high; \d+ places? fell off the list\.$/);
    const listed = new Set(sheet("g1-a").cards.partners.results.map((p) => p.entity.name));
    const names = (st?.cause ?? "").split(": ")[0]!.split(/, | and /);
    for (const n of names) expect(listed.has(n), `${n} is off the list`).toBe(false);
  });
});

describe("the discovery", () => {
  /** The numbered areas (1-5), in number order: the budget split lists the spread areas in that order. */
  const numbered = (s: StreetSheet) => (s.budgetSplit ?? []).slice(0, 5).map((b) => b.geohash);

  it("picks a numbered area by its rule when one qualifies, and names it by its number (G1-B)", () => {
    const s = sheet("g1-b");
    const d = s.discovery;
    expect(d?.kind).toBe("area");
    const ranks = rankAreas(s.cards.liftMap.results.tiles);
    const nums = numbered(s);
    const top = nums.map((g) => ranks.find((r) => r.tile.geohash === g)!).filter((r) => r.tile.lift >= LIFT_DEFAULTS.minLift && r.tile.billPct >= LIFT_DEFAULTS.billFloor);
    const expected = top.find((r) => r.heatRank - r.liftRank >= 5);
    expect(d?.geohash).toBe(expected?.tile.geohash);
    expect(d?.headline).toMatch(new RegExp(`^Area ${nums.indexOf(d!.geohash!) + 1}, `));
    expect(d?.headline).toContain(`of the ${ranks.length} squares on the map for this crowd on its own`);
    expect(s.cards.liftMap.results.liftDiagnostics?.splitHalfSpearman).toBeGreaterThan(0.5);
  });
  it("never points at an area without a number: G2 falls through to the partner rule", () => {
    const s = sheet("g2");
    const ranks = rankAreas(s.cards.liftMap.results.tiles);
    const nums = new Set(numbered(s));
    expect(ranks.filter((r) => nums.has(r.tile.geohash)).some((r) => r.tile.lift >= 1.3 && r.tile.billPct >= 0.7 && r.heatRank - r.liftRank >= 5)).toBe(false);
    expect(s.discovery?.kind).toBe("partner");
  });
  it("falls back to the partner rule (G1-A)", () => {
    const s = sheet("g1-a");
    const d = s.discovery;
    expect(d?.kind).toBe("partner");
    const ranks = rankAreas(s.cards.liftMap.results.tiles);
    expect(ranks.some((r) => r.tile.lift >= 1.3 && r.tile.billPct >= 0.7 && r.heatRank - r.liftRank >= 5)).toBe(false);
    const list = s.cards.partners.results;
    const common = new Set(mostCommonCategories(list));
    const eligible = (p: Partner) => p.tileGeohash !== null && !common.has(p.category) && p.houseRank !== undefined && (p.houseRank === null || p.houseRank - p.qlooRank >= 5);
    const best = [...list].filter(eligible).sort((a, b) => b.score - a.score)[0];
    expect(d?.entityId).toBe(best?.entity.entityId);
    expect(d?.headline).toContain(best!.entity.name);
  });
  it("finds none when there is no usual crowd to compare with (G3: no house set, no genre tag)", () => {
    expect(sheet("g3").cards.liftMap.results.diagnostics.baseline).toBe("none");
    expect(sheet("g3").discovery).toBeUndefined();
  });
  it("cites only this run's ledger and points at something on the sheet", () => {
    for (const id of ["g1-a", "g1-b", "g2"]) {
      const s = sheet(id);
      const d = s.discovery!;
      const ledger = new Set(s.ledger.map((e) => e.id));
      expect(d.ledgerRefs.length).toBeGreaterThan(0);
      for (const r of d.ledgerRefs) expect(ledger.has(r)).toBe(true);
      if (d.kind === "area") expect(s.cards.liftMap.results.tiles.some((t) => t.geohash === d.geohash)).toBe(true);
      else expect(s.cards.partners.results.some((p) => p.entity.entityId === d.entityId)).toBe(true);
    }
  });
});

describe("why this place", () => {
  for (const id of IDS) {
    it(`${id}: every partner has its parts, from this run`, () => {
      const s = sheet(id);
      const ledger = new Set(s.ledger.map((e) => e.id));
      const adults = s.bill.legalAgeEnforced === true && s.operator.allAges !== true;
      for (const p of s.cards.partners.results) {
        const x = p.explain;
        expect(x, p.entity.name).toBeDefined();
        if (!x) continue;
        expect(x.activation).toBe(activationFor(p.category, { adultsOnly: adults }));
        if (!adults) expect(x.activation).not.toMatch(/listening night/);
        const ownTags = new Set(p.entity.tags.map((t) => t.id));
        for (const t of x.tags) {
          expect(ownTags.has(t.id)).toBe(true);
          expect(t.id.startsWith("urn:tag:category:")).toBe(false);
          expect(isDeniedTag(t)).toBe(false);
          if (!adults) expect(findAlcoholTerm(t.name)).toBeNull();
        }
        expect(x.tags.length).toBeLessThanOrEqual(3);
        expect(x.distanceKm).toBe(distanceFromVenueKm(p.entity, s.bill.venue));
        expect(["high", "medium", "low"]).toContain(x.confidence);
        expect(x.confidenceWhy).toMatch(/^Rank \d+ of \d+ /);
        expect(x.limits).toMatch(/^Suggested, not affiliated: no partner has agreed to anything\./);
        expect(x.ledgerRefs[0]).toBe(p.chips[0]?.ledgerRef);
        for (const r of x.ledgerRefs) expect(ledger.has(r)).toBe(true);
        if (p.tileName) expect(x.areaName).toBe(p.tileName);
      }
    });
  }
  it("is on the partners card as it streams", () => {
    const card = runs["g1-a"]!.partnersCard as Envelope<Partner[]> | null;
    expect(card?.results.length).toBeGreaterThan(0);
    expect(card?.results.every((p) => p.explain !== undefined)).toBe(true);
  });
  it("lowers confidence on the thin, widened G3 list", () => {
    expect(sheet("g3").cards.partners.results.every((p) => p.explain?.confidence === "low")).toBe(true);
    expect(sheet("g1-a").cards.partners.results.filter((p) => p.explain?.confidence === "high").length).toBeGreaterThan(10);
  });
});

describe("plain and traceable", () => {
  it("the number check catches an invented number", () => {
    const facts = sheetFacts(sheet("g1-a"));
    expect(findTextViolations("Kept 9,731 places across 47.3 km.", facts).length).toBe(2);
    expect(findTextViolations("Kept 24 places.", facts)).toEqual([]);
  });
  for (const id of IDS) {
    it(`${id}: every number in the extras is on the sheet, with no denied term or ratio in prose`, () => {
      const s = sheet(id);
      const facts = sheetFacts(s);
      for (const t of textsOf(s)) {
        const f: NarrationFacts = t.extraNumbers ? { ...facts, numbers: [...facts.numbers, ...t.extraNumbers] } : facts;
        expect(findTextViolations(t.text, f), `${t.where}: ${t.text}`).toEqual([]);
        expect(t.text, t.where).not.toMatch(/\d(?:\.\d+)?x\b|[!—]|\b(AI-powered|unlock|seamless|powerful|insights)\b/i);
      }
    });
  }
  it("costs no extra Qloo call", () => {
    for (const id of IDS) {
      const s = sheet(id);
      const notes = s.ledger.map((e) => e.note ?? "").join("\n");
      expect(notes).not.toMatch(/discovery|explain|trace/i);
    }
    // 28 plan calls plus the one Q1 signal check (Oct 15: Qloo can list an act it has no taste data for).
    expect(runs["g1-a"]!.final.budget.qlooFresh).toBe(29);
  });
});

describe("operator inputs", () => {
  it("all ages: no bars, no listening nights, no alcohol tags, and the step says why", async () => {
    const r = await run("g1-a", deps(), { allAges: true });
    const s = sheetOf(r.final);
    expect(s.cards.partners.results.some((p) => /bar|pub|lounge|brewery/.test(p.category))).toBe(false);
    for (const p of s.cards.partners.results) {
      expect(p.explain?.activation).not.toMatch(/listening night/);
      for (const t of p.explain?.tags ?? []) expect(findAlcoholTerm(t.name)).toBeNull();
    }
    expect((s.steps ?? []).find((x) => x.id === "partners")?.cause).toMatch(/Left out \d+ places? by type \(all-ages show\)/);
  });
  it("excluded areas: the step says so and the discovery skips them", async () => {
    const r = await run("g1-b", deps(), { excludeAreas: ["beech grove farms"] });
    const s = sheetOf(r.final);
    expect((s.steps ?? []).find((x) => x.id === "heat")?.cause).toMatch(/Left out \d+ areas? at your request\./);
    expect(s.cards.liftMap.results.tiles.some((t) => t.name === "Beech Grove Farms")).toBe(false);
    if (s.discovery?.kind === "area") expect(s.discovery.headline).not.toMatch(/^Beech Grove Farms/);
  });
  it("is deterministic", async () => {
    const a = sheetOf((await run("g1-a", deps())).final);
    const extras = (s: StreetSheet) => JSON.stringify({ steps: s.steps, discovery: s.discovery, explain: s.cards.partners.results.map((p) => p.explain) });
    expect(extras(a)).toBe(extras(sheet("g1-a")));
  });
});
