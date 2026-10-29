/**
 * Re-audit fixes (Oct 29) on fixture-world sheets changed by hand: at most 2 of a kind per area after a kind was read
 * again, partner websites by today's rule (dead sites out, a place's own shortened domain back), the Summary and Checks
 * steps when fixed wording replaced Claude's lines, chain lists counted in places, a ledger note that repeated its
 * node, and the partner and copy-line counts on a near-venue sample. Names and domains are synthetic or the fixture
 * world's, except the dead host, which is on the checked list.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Partner, StreetSheet } from "@walkup/contracts";
import { activationFor } from "@walkup/engine";
import { kindsOverCap, partnersCountLine, recheckSheet, refreshSheet, sampleOnlyKindsLine } from "../src/index";
import { EMPTY_PINS, loadTagPins } from "../src/tags";
import { deps, runPreset, sheetOf } from "./helpers";

let base: StreetSheet;
let g3: StreetSheet;

beforeAll(async () => {
  base = sheetOf((await runPreset("g1-a", deps())).final);
  g3 = sheetOf((await runPreset("g3", deps())).final);
});

const clone = (): StreetSheet => structuredClone(base);

/** An area holding 2 places of one kind and a third place of another kind: the case a re-read kind breaks. */
function crowdedArea(s: StreetSheet): { kind: string; third: Partner; thirdIndex: number } {
  const rows = s.cards.partners.results;
  for (const p of rows) {
    const same = rows.filter((x) => x.tileGeohash === p.tileGeohash && x.category === p.category);
    const thirdIndex = rows.findIndex((x) => x.tileGeohash === p.tileGeohash && x.category !== p.category);
    if (same.length === 2 && thirdIndex >= 0) return { kind: p.category, third: rows[thirdIndex]!, thirdIndex };
  }
  throw new Error("no area with 2 of a kind and another place");
}

describe("at most 2 of a kind per area", () => {
  it("gives a place read again into a third of a kind the kind another run recorded, with that kind's ask", () => {
    const s = clone();
    const { kind, third, thirdIndex } = crowdedArea(s);
    const picked = third.category;
    const adultsOnly = s.bill.legalAgeEnforced === true && s.operator.allAges !== true;
    // What a later re-read did: the third place relabelled as the area's full kind, its ask with it.
    s.cards.partners.results[thirdIndex] = { ...third, category: kind, explain: { ...third.explain!, activation: activationFor(kind, { adultsOnly }) } };
    expect(kindsOverCap(s)).toHaveLength(1);

    const alone = recheckSheet(s);
    expect(alone.report.overCap).toHaveLength(1);
    expect(alone.sheet.cards.partners.results[thirdIndex]!.category).toBe(kind);

    const recordedKinds = (id: string) => (id === third.entity.entityId ? [kind, picked] : []);
    const { sheet, report } = recheckSheet(s, { recordedKinds });
    const row = sheet.cards.partners.results[thirdIndex]!;
    expect(row.category).toBe(picked);
    expect(row.explain?.activation).toBe(activationFor(picked, { adultsOnly }));
    expect(report.kinds).toEqual([{ name: third.entity.name, from: kind, to: picked }]);
    expect(report.overCap).toEqual([]);
    expect(sheet.cards.partners.results.map((p) => p.entity.entityId)).toEqual(s.cards.partners.results.map((p) => p.entity.entityId));
    expect(recheckSheet(sheet, { recordedKinds }).sheet).toEqual(sheet);
  });

  it("a full refresh keeps the kind the run picked when the re-read kind would be a third in the area", () => {
    const s = clone();
    const { kind, third, thirdIndex } = crowdedArea(s);
    // Stored tags that now read as the area's full kind (as when the data policy removed the tag that set the kind).
    const kindTag = kind === "restaurant" ? "urn:tag:genre:place:restaurant" : `urn:tag:category:place:${kind}`;
    s.cards.partners.results[thirdIndex] = { ...third, entity: { ...third.entity, tags: [{ id: kindTag, name: kind }] } };
    const { sheet } = refreshSheet(s);
    const row = sheet.cards.partners.results.find((p) => p.entity.entityId === third.entity.entityId);
    expect(row?.category).toBe(third.category);
    expect(kindsOverCap(sheet)).toEqual([]);
  });
});

describe("partner websites by today's rule", () => {
  it("drops a site on the dead list and brings back a place's own shortened domain from its record", () => {
    const s = clone();
    const [a, b] = s.cards.partners.results as [Partner, Partner];
    const dead = "http://www.tortugadc.com/";
    s.cards.partners.results[0] = { ...a, website: dead, entity: { ...a.entity, properties: { ...a.entity.properties, website: dead } } };
    s.cards.partners.results[1] = {
      ...b,
      website: null,
      entity: { ...b.entity, name: "Harbor Oak Tavern", properties: { ...b.entity.properties, website: "http://haroaktavern.example/" } },
    };
    const { sheet, report } = recheckSheet(s);
    expect(sheet.cards.partners.results[0]!.website).toBeNull();
    expect(sheet.cards.partners.results[1]!.website).toBe("http://haroaktavern.example/");
    expect(report.websites).toEqual([`dropped: ${a.entity.name}`, "kept: Harbor Oak Tavern"]);
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });
});

describe("Summary and Checks steps, chain counts and ledger notes", () => {
  it("says fixed wording replaced Claude's summary in both steps, and recounts a chain tail in places", () => {
    const s = clone();
    const hooks = s.cards.copyHooks.results.length;
    const lines = hooks > 0 ? ` and ${hooks} fan copy line${hooks === 1 ? "" : "s"}` : "";
    s.narration = { ...s.narration!, templated: false };
    s.guard = { ...s.guard, dropped: 0, reasons: [...s.guard.reasons.filter((r) => !/template/.test(r)), 'replaced by the template: summary: superlative "highest" not backed by the sheet'] };
    s.steps = s.steps!.map((st) =>
      st.id === "narrate"
        ? { ...st, decision: `Claude wrote the summary${lines} from this run's results.` }
        : st.id === "partners"
          ? { ...st, cause: "Left off 9 national chains: Big Bean (3), Tacoville, Burger Barn, Pie Place and 4 more." }
          : st,
    );
    const { sheet, report } = recheckSheet(s);
    const step = (id: string) => sheet.steps!.find((x) => x.id === id)!;
    expect(step("narrate").decision).toBe(`Claude wrote a draft summary${lines} from this run's results; fixed wording replaced the summary (see Checks).`);
    expect(step("guard").decision).toMatch(/^Checked every line against this run's requests; none was dropped, and fixed wording replaced Claude's summary\.$/);
    expect(step("partners").cause).toBe("Left off 9 national chains: Big Bean (3), Tacoville, Burger Barn, Pie Place and 3 more.");
    expect(report.rewritten).toEqual(expect.arrayContaining(["summary step", "guard step", "partners step chain count"]));
    expect(recheckSheet(sheet).sheet).toEqual(sheet);
  });

  it("says a ledger note's node once", () => {
    const s = clone();
    const label = "node Q3 house roster (Ticketmaster)";
    s.ledger = s.ledger.map((e, i) => (i === 0 ? { ...e, note: `${label}; ${label}; the parent sheet's answer (2026-10-21), reused` } : e));
    const { sheet, report } = recheckSheet(s);
    expect(sheet.ledger[0]!.note).toBe(`${label}; the parent sheet's answer (2026-10-21), reused`);
    expect(report.rewritten).toContain("ledger note (1)");
    expect(sheet.ledger.slice(1)).toEqual(s.ledger.slice(1));
  });
});

describe("near-venue and one-line counts on the samples", () => {
  it("never counts the near-venue list as an area", () => {
    const near = { tileGeohash: null };
    const inArea = (g: string) => ({ tileGeohash: g });
    expect(partnersCountLine([near, near])).toBe("2 partners near the venue, at most 2 of a kind.");
    expect(partnersCountLine([inArea("a"), inArea("b")])).toBe("2 partners in 2 areas, at most 2 of a kind per area.");
    expect(partnersCountLine([inArea("a"), inArea("a"), near])).toBe("3 partners: 2 in 1 area and 1 near the venue, at most 2 of a kind per area.");
  });

  it("the near-venue sample says its partners are near the venue and its one copy line isn't 'each'", () => {
    expect(g3.cards.partners.results.every((p) => p.tileGeohash === null)).toBe(true);
    expect(g3.cards.partners.summary).toMatch(/^6 partners near the venue, at most 2 of a kind\./);
    expect(g3.steps!.find((x) => x.id === "partners")!.decision).toMatch(/^Kept 6 places near the venue, at most 2 of a kind\.$/);
    expect(g3.cards.copyHooks.results).toHaveLength(1);
    expect(g3.cards.copyHooks.summary).toBe("1 line, built only from approved Qloo tags.");
    // A stored sheet with the older wording gets both lines fixed by the recheck.
    const old = structuredClone(g3);
    old.cards.partners.summary = old.cards.partners.summary.replace("6 partners near the venue, at most 2 of a kind.", "6 partners in 1 area, at most 2 of a kind per area.");
    old.cards.copyHooks.summary = "1 line, each built only from approved Qloo tags.";
    const { sheet } = recheckSheet(old);
    expect(sheet.cards.partners.summary).toBe(g3.cards.partners.summary);
    expect(sheet.cards.copyHooks.summary).toBe(g3.cards.copyHooks.summary);
  });

  it("a sample sheet says which kinds on its list live runs don't search", () => {
    const live = loadTagPins();
    expect(live.categories.record_store).toBeUndefined();
    expect(sampleOnlyKindsLine([{ category: "record_store" }, { category: "bar" }], live)).toBe("Record stores show up on sample sheets only: live runs don't search them yet.");
    expect(sampleOnlyKindsLine([{ category: "bar" }, { category: "cafe" }], live)).toBeNull();
    // A kind a live run only widens into has no pin, yet live sheets list bakeries from other kinds' searches.
    expect(live.categories.bakery).toBeUndefined();
    expect(sampleOnlyKindsLine([{ category: "bakery" }], live)).toBeNull();
    expect(sampleOnlyKindsLine([{ category: "bakery" }, { category: "record_store" }], live)).toBe("Record stores show up on sample sheets only: live runs don't search them yet.");
    // Without the live pins there is nothing to compare with, so nothing is said.
    expect(sampleOnlyKindsLine([{ category: "record_store" }], EMPTY_PINS)).toBeNull();
    const withRecordStores = [base, g3].filter((s) => s.cards.partners.results.some((p) => p.category === "record_store"));
    expect(withRecordStores.length).toBeGreaterThan(0);
    for (const s of withRecordStores) expect(s.cards.partners.reason).toContain("Record stores show up on sample sheets only: live runs don't search them yet.");
  });
});
