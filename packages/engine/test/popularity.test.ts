import { describe, expect, it } from "vitest";
import type { Partner, QlooEntity } from "@walkup/contracts";
import { eligiblePartnerIds } from "../src/partners";
import { popularityCheck, popularitySentence, type PopularityTwin } from "../src/popularity";
import { popularityStep } from "../src/steps";
import { place } from "./helpers";

function partner(id: string, tileGeohash: string | null, tileName?: string): Partner {
  const p: Partner = { entity: place(id, { id, category: "cafe" }), tileGeohash, category: "cafe", score: 0.5, qlooRank: 1, chips: [] };
  if (tileName) p.tileName = tileName;
  return p;
}

function twin(tileGeohash: string | null, ids: string[], ledgerRef: string, extra: QlooEntity[] = []): PopularityTwin {
  return { tileGeohash, ledgerRef, entities: [...extra, ...ids.map((id) => place(id, { id, category: "cafe" }))] };
}

describe("popularity check", () => {
  it("counts, per area, the partners outside the first k places of the no-signal list (k = partners in the area)", () => {
    const partners = [partner("a1", "aaaaaa", "Shaw"), partner("a2", "aaaaaa", "Shaw"), partner("a3", "aaaaaa", "Shaw"), partner("n1", null)];
    // Area A: popularity order p1, a2, p2, a1, ... -> top 3 = {p1, a2, p2}: a1 and a3 are not in it.
    // Near venue: popularity order n1, ... -> top 1 = {n1}.
    const r = popularityCheck(partners, [twin("aaaaaa", ["p1", "a2", "p2", "a1", "a3"], "Q20"), twin(null, ["n1", "x"], "Q21")]);
    expect(r.missing).toEqual([]);
    expect(r.check).toEqual({
      partners: 4,
      notInPopularTop: 2,
      perArea: [
        { tileGeohash: "aaaaaa", tileName: "Shaw", partners: 3, notInPopularTop: 2, ledgerRef: "Q20" },
        { tileGeohash: null, partners: 1, notInPopularTop: 0, ledgerRef: "Q21" },
      ],
      ledgerRefs: ["Q20", "Q21"],
    });
  });

  it("applies the partner eligibility rules to the popularity list before cutting it", () => {
    const closed = place("closed", { id: "closed", category: "cafe", isClosed: true });
    const venue = place("venue", { id: "venue", category: "cafe" });
    const bar = place("bar", { id: "bar", category: "bar" });
    const opts = { excludeEntityIds: ["venue"], excludeCategories: ["bar"] };
    expect(eligiblePartnerIds([closed, venue, bar, place("a1", { id: "a1", category: "cafe" })], opts)).toEqual(["a1"]);
    const r = popularityCheck([partner("a1", "aaaaaa")], [twin("aaaaaa", ["a1", "p1"], "Q20", [closed, venue, bar])], opts);
    expect(r.check?.notInPopularTop).toBe(0);
  });

  it("gives no number when an area with partners has no list or nothing eligible, and names the area", () => {
    const partners = [partner("a1", "aaaaaa"), partner("b1", "bbbbbb")];
    expect(popularityCheck(partners, [twin("aaaaaa", ["a1"], "Q20")])).toEqual({ check: null, missing: [{ tileGeohash: "bbbbbb", why: "no search" }] });
    const closedOnly = twin("bbbbbb", [], "Q21", [place("c", { id: "c", isClosed: true })]);
    expect(popularityCheck(partners, [twin("aaaaaa", ["a1"], "Q20"), closedOnly]).missing).toEqual([{ tileGeohash: "bbbbbb", why: "nothing eligible came back" }]);
    expect(popularityCheck([], [])).toEqual({ check: null, missing: [] });
  });

  it("is deterministic and ignores twins of areas without partners", () => {
    const run = () => popularityCheck([partner("a1", "aaaaaa")], [twin("aaaaaa", ["p1", "a1"], "Q20"), twin("zzzzzz", ["z"], "Q22")]);
    expect(run()).toEqual(run());
    expect(run().check).toMatchObject({ partners: 1, notInPopularTop: 1, ledgerRefs: ["Q20"] });
  });

  it("says it in one plain sentence", () => {
    const areas = (n: number, nearVenue = false) => Array.from({ length: n }, (_, i) => ({ tileGeohash: nearVenue ? null : `t${i}`, partners: 1, notInPopularTop: 0, ledgerRef: "Q20" }));
    expect(popularitySentence({ partners: 11, notInPopularTop: 8, perArea: areas(3) })).toBe("8 of the 11 partners would not make a list of the most popular places in their areas.");
    expect(popularitySentence({ partners: 11, notInPopularTop: 11, perArea: areas(3) })).toBe("None of the 11 partners would make a list of the most popular places in their areas.");
    expect(popularitySentence({ partners: 11, notInPopularTop: 0, perArea: areas(3) })).toBe("All 11 partners would also make a list of the most popular places in their areas.");
    expect(popularitySentence({ partners: 6, notInPopularTop: 5, perArea: areas(1, true) })).toBe("5 of the 6 partners would not make a list of the most popular places near the venue.");
    expect(popularitySentence({ partners: 4, notInPopularTop: 1, perArea: areas(1) })).toBe("1 of the 4 partners would not make a list of the most popular places in their area.");
    expect(popularitySentence({ partners: 1, notInPopularTop: 1, perArea: areas(1) })).toBe("The one partner would not make a list of the most popular places in its area.");
  });

  it("the step says the number with the method, or why there is none", () => {
    const ok = popularityStep({ partners: 11, notInPopularTop: 8, areas: 3, failed: [], ledgerRefs: ["Q20", "Q21", "Q22"] });
    expect(ok).toMatchObject({ id: "partners-popular", kind: "partners", status: "ok", ledgerRefs: ["Q20", "Q21", "Q22"] });
    expect(ok.decision).toBe("Checked against popularity alone: 8 of the 11 partners wouldn't make a list of the most popular places in their areas.");
    expect(ok.cause).toMatch(/without the bill as the signal returns places in popularity order/);
    expect(ok.cause).toMatch(/It says nothing about ticket sales\.$/);
    const near = popularityStep({ partners: 6, notInPopularTop: 5, areas: 1, nearVenueOnly: true, failed: [], ledgerRefs: ["Q20"] });
    expect(near.decision).toMatch(/near the venue\.$/);
    const skipped = popularityStep({ partners: null, notInPopularTop: null, areas: 0, failed: ["area 2 (Qloo returned HTTP 500)"], ledgerRefs: ["Q21"] });
    expect(skipped).toMatchObject({ status: "partial", decision: "Skipped the popularity check." });
    expect(skipped.cause).toBe("The search without the bill failed or came back empty for area 2 (Qloo returned HTTP 500), so there is no number.");
    for (const s of [ok, near, skipped]) expect(`${s.decision} ${s.cause ?? ""}`).not.toMatch(/!|\d\.\d+x|—/);
  });
});
