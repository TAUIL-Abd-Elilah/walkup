/**
 * Vitest wrapper for the product eval, so CI runs it:
 *  - the 20 cases on the fixture world (every failure must be a listed known gap,
 *    and every listed gap must still reproduce);
 *  - the checks have teeth: each universal check fails on a sheet broken on purpose;
 *  - units: guard classification, budget reading, arguments, recorded-plan loading;
 *  - the recorded path, on plans stored by the orchestrator (JSON files and SQLite).
 *
 * The score is written to evals/product/out when CI or PRODUCT_EVAL_WRITE is set
 * (PRODUCT_EVAL_OUT overrides the directory), otherwise to a temporary directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryPlanStore, type PlanResult, type PlanStore } from "@walkup/orchestrator";
import { createSqliteStores } from "@walkup/orchestrator/sqlite";
import { DEFAULT_WORLD_SEED, placeById } from "@walkup/qloo-world";
import { WEEKDAYS, type Weekday } from "@walkup/contracts";
import { CASES } from "./cases";
import { checkSubject, classifyGuardReasons, CLAUSES, readBudget, type CheckResult, type Subject } from "./checks";
import { newRig, runWithPick, worldPlacesClient, type EvalRig } from "./harness";
import { KNOWN_GAPS, knownGapFor } from "./known-gaps";
import { DEFAULT_OUT_DIR, parseArgs, recordedFromJson, runProductEval, scoreMarkdown, writeScore, type Score } from "./run";

const OUT_DIR = process.env.PRODUCT_EVAL_OUT ?? (process.env.CI || process.env.PRODUCT_EVAL_WRITE ? DEFAULT_OUT_DIR : join(tmpdir(), "walkup-product-eval"));

function failures(score: Score, id: string): CheckResult[] {
  return score.cases.find((c) => c.id === id)?.checks.filter((x) => x.status === "fail") ?? [];
}

describe("product eval on the fixture world", () => {
  let score: Score;

  beforeAll(async () => {
    score = await runProductEval({ source: "fixture" });
    writeScore(score, OUT_DIR);
  }, 600_000);

  it("has 20 named cases with unique ids and slugs", () => {
    expect(CASES).toHaveLength(20);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(20);
    expect(new Set(CASES.map((c) => c.slug)).size).toBe(20);
    for (const c of CASES) expect(c.clauses.length).toBeGreaterThan(0);
  });

  for (const c of CASES) {
    it(`${c.id} ${c.slug}: fails only on known, reported gaps`, () => {
      const r = score.cases.find((x) => x.id === c.id);
      expect(r, c.id).toBeDefined();
      expect(r!.status).not.toBe("skipped");
      expect(r!.counts.pass).toBeGreaterThan(0);
      const unexpected = r!.checks.filter((x) => x.status === "fail" && !x.knownGap);
      expect(unexpected.map((x) => `[${x.subject ?? ""}] ${x.name}: ${x.detail}`)).toEqual([]);
      expect(r!.checks.filter((x) => x.status === "skip")).toEqual([]);
    });
  }

  it("every known gap still reproduces (delete the entry once it is fixed)", () => {
    for (const gap of KNOWN_GAPS) {
      for (const id of gap.cases) expect(failures(score, id).some((x) => x.name === gap.check), `${id}: ${gap.check}`).toBe(true);
    }
    expect(score.unexpectedFailures).toBe(0);
  });

  it("verifies every clause this eval owns, and no golden fails", () => {
    for (const cl of score.clauses) {
      if (cl.checkedBy === "ci") expect(cl.status).toBe("ci");
      else expect(cl.status, cl.id).toBe("verified");
    }
    for (const id of ["C01", "C02", "C03", "C04", "C18"]) expect(score.cases.find((c) => c.id === id)?.status, id).toBe("passed");
    expect(CLAUSES.map((c) => c.id)).toEqual(score.clauses.map((c) => c.id));
  });

  it("writes score.json ({passed, failed, cases, generatedAt}) and score.md", () => {
    const json = JSON.parse(readFileSync(join(OUT_DIR, "score.json"), "utf8")) as Score;
    expect(json.passed + json.failed + json.skipped).toBe(20);
    expect(json.cases).toHaveLength(20);
    expect(Number.isNaN(Date.parse(json.generatedAt))).toBe(false);
    expect(json.source).toBe("fixture-world");
    expect(json.recordedPlans).toBeNull();
    const md = readFileSync(join(OUT_DIR, "score.md"), "utf8");
    expect(md).toContain("# Product eval score");
    expect(md).toContain("No live API was called.");
  });

  it("is deterministic apart from the timestamp", async () => {
    const again = await runProductEval({ source: "fixture", only: ["C01", "C18"], now: () => new Date(score.generatedAt) });
    for (const id of ["C01", "C18"]) {
      expect(JSON.stringify(again.cases.find((c) => c.id === id))).toBe(JSON.stringify(score.cases.find((c) => c.id === id)));
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The checks have teeth
// ---------------------------------------------------------------------------

describe("universal checks catch a broken sheet", () => {
  let rig: EvalRig;
  let base: PlanResult;

  beforeAll(async () => {
    rig = newRig({ idPrefix: "teeth" });
    base = (await runWithPick({ presetId: "g1-a" }, rig.deps)).final;
  }, 120_000);

  const subject = (r: PlanResult): Subject => ({ label: "mutant", result: r, tap: rig.tap, places: worldPlacesClient(rig.world), expect: { budget: { venueMin: 4 } } });
  const mutate = (fn: (r: PlanResult) => void): PlanResult => {
    const r = structuredClone(base);
    fn(r);
    return r;
  };
  const statusOf = async (r: PlanResult, name: string): Promise<string | undefined> => (await checkSubject(subject(r))).checks.find((x) => x.name === name)?.status;

  it("passes the unbroken sheet", async () => {
    const { checks } = await checkSubject(subject(base));
    expect(checks.filter((x) => x.status !== "pass").map((x) => `${x.name}: ${x.detail}`)).toEqual([]);
  });

  it("a partner closed on the street-team day per Google Places", async () => {
    const p = base.sheet!.cards.partners.results.find((x) => {
      if (x.hoursOnDay === null) return false;
      const place = placeById(x.entity.entityId, DEFAULT_WORLD_SEED);
      return !!place && Object.values(place.hours).some((slots) => slots.length === 0);
    });
    expect(p).toBeDefined();
    const place = placeById(p!.entity.entityId, DEFAULT_WORLD_SEED)!;
    const closedDay = Object.entries(place.hours).find(([, slots]) => slots.length === 0)![0].toLowerCase() as Weekday;
    expect(WEEKDAYS).toContain(closedDay);
    const r = mutate((x) => {
      x.sheet!.operator.streetTeamDays = [closedDay];
    });
    expect(await statusOf(r, "every partner open on the street-team day per Google Places")).toBe("fail");
  });

  it("a partner Google Places does not know", async () => {
    const r = mutate((x) => {
      x.sheet!.cards.partners.results[0]!.entity.name = "Nowhere Example Lounge";
    });
    expect(await statusOf(r, "every partner open on the street-team day per Google Places")).toBe("fail");
  });

  it("a pre/post spot Google Places does not know, which the known gap never masks", async () => {
    const r = mutate((x) => {
      x.sheet!.cards.prePost.results[0]!.entity.name = "Nowhere Example Supper Club";
    });
    const check = (await checkSubject(subject(r))).checks.find((x) => x.name === "every pre/post spot open on show night per Google Places");
    expect(check?.status).toBe("fail");
    for (const gap of KNOWN_GAPS) for (const id of gap.cases) expect(knownGapFor(id, check!)).toBeUndefined();
  });

  it("a chip citing a ledger entry this run does not have", async () => {
    const r = mutate((x) => {
      x.sheet!.cards.partners.results[0]!.chips[0]!.ledgerRef = "Q999";
    });
    expect(await statusOf(r, "every cited ledger ref is in this run's ledger")).toBe("fail");
  });

  it("an entity id no Qloo response returned", async () => {
    const r = mutate((x) => {
      x.sheet!.cards.partners.results[0]!.entity.entityId = "0000beef-0000-4000-8000-000000000000";
    });
    expect(await statusOf(r, "ID validator: every entity and tag id on the sheet came back in a Qloo response")).toBe("fail");
    expect(await statusOf(r, "every cited entity traces to a Qloo call of this run that returned results")).toBe("fail");
  });

  it("a guard drop in a citation field", async () => {
    const r = mutate((x) => {
      x.sheet!.guard.dropped = 1;
      x.sheet!.guard.reasons.push("partnerLines[0]: entityId not in this run");
    });
    expect(await statusOf(r, "guard drops in citation fields")).toBe("fail");
  });

  it("a denied tag on a partner", async () => {
    const r = mutate((x) => {
      x.sheet!.cards.partners.results[0]!.entity.tags.push({ id: "urn:tag:ethnicity:qloo:synthetic_example", name: "Synthetic ethnicity example" });
    });
    expect(await statusOf(r, "no denied tag on the sheet")).toBe("fail");
    expect(await statusOf(r, "ID validator: every entity and tag id on the sheet came back in a Qloo response")).toBe("pass");
  });

  it("a fallback call the card does not show, and a budget overrun", async () => {
    const hidden = mutate((x) => {
      x.budget.byNode["Q9 partners, tile 1 (3,500 m)"] = 1;
    });
    expect(await statusOf(hidden, "every coded fallback call shows on its card")).toBe("fail");
    const over = mutate((x) => {
      x.budget.billLevel += 10;
      x.budget.qlooFresh += 10;
    });
    expect(await statusOf(over, "call budget")).toBe("fail");
  });

  it("bars facing fans on a show Ticketmaster does not mark 21+", async () => {
    const r = mutate((x) => {
      x.sheet!.bill.legalAgeEnforced = false;
    });
    expect(base.sheet!.cards.prePost.results.some((s) => s.category === "bar" && s.fanFacingAllowed)).toBe(true);
    expect(await statusOf(r, "alcohol rules follow Ticketmaster's age policy")).toBe("fail");
  });

  it("show-status words and a mode label that is not honest", async () => {
    const soft = mutate((x) => {
      x.sheet!.narration!.summary += " Sales look soft.";
    });
    expect(await statusOf(soft, "no show-status words (soft, tracking)")).toBe("fail");
    const live = mutate((x) => {
      x.sheet!.mode = "live";
    });
    expect(await statusOf(live, "mode is labelled honestly")).toBe("fail");
  });

  it("strict hours fails a partner Google Places lists without hours", async () => {
    const strict = await checkSubject(subject(base), { strictHours: true });
    const unknown = base.sheet!.cards.partners.results.filter((p) => p.hoursOnDay === null).length;
    expect(unknown).toBeGreaterThan(0);
    expect(strict.checks.find((x) => x.name === "every partner open on the street-team day per Google Places")?.status).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

describe("guard classification", () => {
  it("separates citation drops, policy drops and report lines", () => {
    const g = classifyGuardReasons([
      "4 tags denied by policy (ethnicity/inclusivity/credit_card)",
      "Narration by the deterministic template (llm_off).",
      "tileWhy[0]: geohash not in this run",
      "summary: number 7.77 is not in this run",
      "partnerLines[1]: denied keyword",
      "fan-facing guard: copyHooks[0]: alcohol term on a show that is not 21+",
      "fan-facing guard: copyHooks[1]: number 12 not in this run's results",
      "copyHooks[2]: tag not on the allowlist",
      "fan-facing guard: copyHooks[0]: copy hook cites no allowlisted tag",
      "2 partner line(s) dropped: cited entity not traced to this run's ledger.",
    ]);
    expect(g.citation).toBe(7);
    expect(g.policy).toBe(2);
    expect(g.info).toBe(2);
  });
});

describe("budget reading", () => {
  it("splits fallbacks and typed lookups out of the bill-level count", () => {
    const b = readBudget({
      qlooFresh: 30,
      qlooCached: 2,
      qlooTotal: 32,
      billLevel: 24,
      venueLevel: 6,
      arms: 0,
      tm: 2,
      places: 0,
      anthropic: 0,
      byNode: {
        "Q4 bill heat": 1,
        "Q4 bill heat (widened to 60 km)": 1,
        "Q9 partners, tile 2 (3,500 m)": 1,
        "Q8 fallback: bill tags": 1,
        "Q11 declared pick list": 3,
        "Q5 house heat (tag baseline)": 1,
      },
    });
    expect([b.core, b.fallback, b.typed, b.venue]).toEqual([18, 3, 3, 6]);
  });
  it("splits the trust checks (split-half heatmaps, partner house twins) out of the bill and venue counts", () => {
    const b = readBudget({
      qlooFresh: 28,
      qlooCached: 0,
      qlooTotal: 28,
      billLevel: 20,
      venueLevel: 8,
      arms: 0,
      tm: 2,
      places: 0,
      anthropic: 0,
      byNode: {
        "Q4 bill heat": 1,
        "Q4 bill heat, half 1 (split-half check)": 1,
        "Q4 bill heat, half 2 (split-half check)": 1,
        "Q5 house heat, half 1 (split-half check)": 1,
        "Q5 house heat, half 2 (split-half check)": 1,
        "Q9 house twin, tile 1": 1,
        "Q9 house twin, tile 2": 1,
        "Q9 house twin, tile 3": 1,
      },
    });
    expect([b.core, b.venue, b.checks]).toEqual([15, 6, 7]);
  });
});

describe("arguments", () => {
  it("parses the CLI and refuses what it cannot do", () => {
    expect(parseArgs([]).source).toBe("fixture");
    expect(parseArgs(["--only", "C01,c05", "--quiet", "--strict-hours"])).toMatchObject({ only: ["C01", "c05"], quiet: true, strictHours: true });
    expect(() => parseArgs(["--source", "recorded"])).toThrow(/--plans/);
    expect(() => parseArgs(["--ground-live"])).toThrow(/recorded runs only/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("reads a stored plan or a fixture wrapper, and nothing else", () => {
    expect(recordedFromJson({ hello: 1 }, "x")).toBeNull();
    expect(recordedFromJson({ sheet: { cards: {} } }, "x")).toBeNull();
    const rec = recordedFromJson({ synthetic: true, fixtureId: "g3", sheet: { planId: "p", mode: "fixture", cards: {} } }, "file.json");
    expect(rec?.presetId).toBe("g3");
    expect(rec?.result.budget.qlooFresh).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recorded path
// ---------------------------------------------------------------------------

describe("recorded plans", () => {
  const dir = mkdtempSync(join(tmpdir(), "hl-recorded-"));
  const dbFile = join(dir, "plans.sqlite");

  async function storeGoldens(store: PlanStore, prefix: string): Promise<void> {
    const rig = newRig({ store, idPrefix: prefix });
    for (const id of ["g1-a", "g1-b", "g2", "g3"]) {
      const r = await runWithPick({ presetId: id }, rig.deps, { arms: ["F"] });
      expect(r.final.status).toBe("complete");
    }
  }

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-checks stored plans from JSON files: goldens only, tap and grounding skipped", async () => {
    const store = createMemoryPlanStore();
    await storeGoldens(store, "rec");
    for (const p of await store.list(10)) writeFileSync(join(dir, `${p.planId}.json`), JSON.stringify(p), "utf8");
    const score = await runProductEval({ source: "recorded", plans: dir });
    expect(score.source).toBe("recorded");
    expect(score.cases.filter((c) => c.status === "passed").map((c) => c.id)).toEqual(["C01", "C02", "C03", "C04", "C17", "C18"]);
    expect(score.unexpectedFailures).toBe(0);
    expect(score.skipped).toBe(14);
    const c01 = score.cases.find((c) => c.id === "C01")!;
    expect(c01.checks.filter((x) => x.status === "skip").map((x) => x.clause).sort()).toEqual(["D3", "D4"]);
    expect(score.clauses.find((c) => c.id === "D3")?.status).toBe("not verified");
    expect(scoreMarkdown(score)).toContain("recorded plans");
    // A fixture sheet read as a recorded plan says so: it never reads as a live run.
    expect(score.recordedPlans?.map((p) => p.mode)).toEqual(["fixture", "fixture", "fixture", "fixture"]);
    expect(scoreMarkdown(score)).toContain("g1-a: fixture sheet from");

    // The orchestrator's fixture wrappers carry no citation map: the chips' ledger refs stand in.
    const wrappers = join(dir, "wrappers");
    mkdirSync(wrappers);
    for (const p of await store.list(10)) {
      writeFileSync(join(wrappers, `${p.presetId}.sheet.json`), JSON.stringify({ synthetic: true, fixtureId: p.presetId, sheet: p.sheet, budget: p.budget }), "utf8");
    }
    const fromWrappers = await runProductEval({ source: "recorded", plans: wrappers, only: ["C01", "C02", "C03", "C04"] });
    expect(fromWrappers.cases.filter((c) => c.status === "passed").map((c) => c.id)).toEqual(["C01", "C02", "C03", "C04"]);
  }, 300_000);

  it("re-checks stored plans from the orchestrator's SQLite store", async () => {
    const stores = createSqliteStores(dbFile);
    try {
      await storeGoldens(stores.plans, "sql");
    } finally {
      stores.close();
    }
    expect(existsSync(dbFile)).toBe(true);
    const score = await runProductEval({ source: "recorded", plans: dbFile, only: ["C01", "C18"] });
    expect(score.cases.filter((c) => c.status === "passed").map((c) => c.id)).toEqual(["C01", "C18"]);
  }, 300_000);

  it("refuses a missing plans path", async () => {
    await expect(runProductEval({ source: "recorded", plans: join(dir, "missing") })).rejects.toThrow(/No recorded plans/);
  });
});
