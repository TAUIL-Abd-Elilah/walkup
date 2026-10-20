import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Partner } from "@walkup/contracts";
import {
  ACTIVATION_RULES,
  activationFor,
  categoryWord,
  DEFAULT_ACTIVATION,
  distanceFromVenueKm,
  explainPartner,
  explainTags,
  PARTNER_LIMITS,
  partnerConfidence,
  partnerTagCounts,
  type ConfidenceInput,
} from "../src/explain";
import { place, tag } from "./helpers";

const VENUE = { lat: 36.1612, lon: -86.7745 };

function partner(over: Partial<Partner> = {}, tags = [tag("urn:tag:category:place:record_store", "Record store"), tag("urn:tag:good_for:qloo:live_music", "Live music")]): Partner {
  const entity = place("Alder Mill Vinyl", { id: "E-1", tags });
  entity.location = { lat: 36.172, lon: -86.9739 };
  return { entity, tileGeohash: "dn6jv1", tileName: "Nashville-Davidson", category: "record_store", score: 0.5, qlooRank: 2, hoursOnDay: "11:00-19:00", chips: [{ label: "over-indexes for this bill", ledgerRef: "Q13" }], ...over };
}

describe("activationFor", () => {
  it("follows the category table", () => {
    expect(activationFor("book_store", { adultsOnly: false })).toBe("Ask for a poster in the window and a ticket drop at the counter.");
    expect(activationFor("clothing_store", { adultsOnly: false })).toBe("Ask for a poster in the window and a ticket drop at the counter.");
    // Record stores could not be pinned (Oct 15), so the table promises them nothing of their own.
    expect(activationFor("record_store", { adultsOnly: false })).toBe(DEFAULT_ACTIVATION);
    expect(activationFor("barber_shop", { adultsOnly: false })).toBe("Ask to leave flyers and a card at each chair.");
    expect(activationFor("beauty_salon", { adultsOnly: true })).toBe("Ask to leave flyers and a card at each chair.");
    expect(activationFor("cafe", { adultsOnly: false })).toBe("Ask to leave table cards.");
    expect(activationFor("restaurant", { adultsOnly: true })).toBe("Ask to leave flyers at the counter.");
    expect(activationFor("something_new", { adultsOnly: false })).toBe(DEFAULT_ACTIVATION);
  });
  it("names no category whose tag config/tags.json could not pin", () => {
    const cfg = JSON.parse(readFileSync(fileURLToPath(new URL("../../../config/tags.json", import.meta.url)), "utf8")) as { categories: { key: string; status: string }[] };
    const pinned = new Set(cfg.categories.filter((c) => c.status === "pinned").map((c) => c.key));
    expect(pinned.has("record_store")).toBe(false);
    expect(ACTIVATION_RULES.flatMap((r) => r.categories)).not.toContain("record_store");
    // Every rule is reachable through at least one pinned category (other keys are aliases).
    for (const rule of ACTIVATION_RULES) expect(rule.categories.some((c) => pinned.has(c)), rule.text).toBe(true);
  });
  it("offers a bar listening night only on adults-only shows", () => {
    expect(activationFor("bar", { adultsOnly: true })).toBe("Ask for a poster and a pre-show listening night.");
    expect(activationFor("bar", { adultsOnly: false })).toBe("Ask to put up a poster.");
    expect(activationFor("night_club", { adultsOnly: false })).toBe("Ask to put up a poster.");
    for (const c of ["bar", "pub", "brewery", "lounge"]) expect(activationFor(c, { adultsOnly: false })).not.toMatch(/listening night/);
  });
  it("words categories", () => {
    expect(categoryWord("record_store")).toBe("record store");
    expect(categoryWord("record_store", true)).toBe("record stores");
    expect(categoryWord("barber_shop", true)).toBe("barbershops");
    expect(categoryWord("tattoo_parlor", true)).toBe("tattoo parlors");
  });
});

describe("explainTags", () => {
  const tags = [
    tag("urn:tag:category:place:bar", "Bar"),
    tag("urn:tag:ambience:qloo:trendy", "Trendy"),
    tag("urn:tag:good_for:qloo:craft_beer", "Craft beer"),
    tag("urn:tag:ethnicity:place:x", "Something"),
    tag("urn:tag:good_for:qloo:live_music", "Live music"),
    tag("urn:tag:genre:music:americana", "Americana"),
    tag("urn:tag:ambience:qloo:cozy", "Cozy"),
  ];
  it("drops category, denied and (unless adults only) alcohol tags", () => {
    const out = explainTags({ tags }, { adultsOnly: false, max: 10 }).map((t) => t.name);
    expect(out).toEqual(["Trendy", "Live music", "Americana", "Cozy"]);
    expect(explainTags({ tags }, { adultsOnly: true, max: 10 }).map((t) => t.name)).toContain("Craft beer");
  });
  it("puts the bill's own tags first, then tags shared by more places, at most 3", () => {
    const counts = new Map([
      ["urn:tag:ambience:qloo:cozy", 9],
      ["urn:tag:good_for:qloo:live_music", 4],
    ]);
    const out = explainTags({ tags }, { adultsOnly: false, billTagIds: new Set(["urn:tag:genre:music:americana"]), tagCounts: counts });
    expect(out).toEqual([
      { id: "urn:tag:genre:music:americana", name: "Americana" },
      { id: "urn:tag:ambience:qloo:cozy", name: "Cozy" },
      { id: "urn:tag:good_for:qloo:live_music", name: "Live music" },
    ]);
  });
  it("counts tags across partners once per place", () => {
    const a = partner();
    const b = partner({}, [tag("urn:tag:good_for:qloo:live_music", "Live music"), tag("urn:tag:good_for:qloo:live_music", "Live music")]);
    expect(partnerTagCounts([a, b]).get("urn:tag:good_for:qloo:live_music")).toBe(2);
  });
});

describe("partnerConfidence", () => {
  const base: ConfidenceInput = { qlooRank: 2, poolSize: 28, inTopArea: true, widenedRadiusM: null, widenedCategories: false, hoursKnown: true, day: "thursday", thinSignal: false };
  it("is high with no concerns", () => {
    expect(partnerConfidence(base)).toEqual({ confidence: "high", why: "Rank 2 of 28 in a top area, open Thursday." });
  });
  it("is medium with one concern", () => {
    expect(partnerConfidence({ ...base, hoursKnown: false })).toEqual({ confidence: "medium", why: "Rank 2 of 28 in a top area, but no hours are listed for Thursday." });
    expect(partnerConfidence({ ...base, inTopArea: false })).toEqual({ confidence: "medium", why: "Rank 2 of 28 near the venue, not in a top area, open Thursday." });
  });
  it("is low with two or more", () => {
    const r = partnerConfidence({ ...base, qlooRank: 7, poolSize: 9, widenedRadiusM: 3500 });
    expect(r.confidence).toBe("low");
    expect(r.why).toBe("Rank 7 of 9 in a top area, but the search widened to 3,500 m, the list was short and it ranked in the lower half.");
    expect(partnerConfidence({ ...base, widenedRadiusM: 3500, widenedCategories: true }).why).toBe(
      "Rank 2 of 28 in a top area, but the search widened to 3,500 m and to more kinds of places.",
    );
    expect(partnerConfidence({ ...base, thinSignal: true, widenedCategories: true }).why).toBe(
      "Rank 2 of 28 in a top area, but the search took in more kinds of places and this bill's signal is thin.",
    );
  });
});

describe("explainPartner", () => {
  it("builds every part from the partner and its pool", () => {
    const x = explainPartner(
      { partner: partner(), poolSize: 28, poolRef: "Q13", twinRef: "Q14" },
      { venue: VENUE, day: "thursday", adultsOnly: true, thinSignal: false, tagCounts: new Map() },
    );
    expect(x).toEqual({
      tags: [{ id: "urn:tag:good_for:qloo:live_music", name: "Live music" }],
      areaName: "Nashville-Davidson",
      distanceKm: 17.9,
      activation: "Ask to leave flyers at the counter.",
      confidence: "high",
      confidenceWhy: "Rank 2 of 28 in a top area, open Thursday.",
      limits: PARTNER_LIMITS,
      ledgerRefs: ["Q13", "Q14"],
    });
  });
  it("falls back to a given area name, notes missing hours and skips a missing location", () => {
    const p = partner({ tileGeohash: null, hoursOnDay: null, category: "bar" });
    delete p.tileName;
    delete p.entity.location;
    const x = explainPartner({ partner: p, poolSize: 30, poolRef: "Q20", areaName: "Germantown" }, { venue: VENUE, day: "saturday", adultsOnly: false, thinSignal: false });
    expect(x.areaName).toBe("Germantown");
    expect(x.distanceKm).toBeUndefined();
    expect(x.activation).toBe("Ask to put up a poster.");
    expect(x.confidence).toBe("low");
    expect(x.limits).toBe(`${PARTNER_LIMITS} No hours listed for Saturday: call first.`);
    expect(x.ledgerRefs).toEqual(["Q20"]);
  });
  it("measures straight-line distance in km with one decimal", () => {
    expect(distanceFromVenueKm({ location: { lat: 36.1612, lon: -86.7745 } }, VENUE)).toBe(0);
    expect(distanceFromVenueKm({}, VENUE)).toBeUndefined();
  });
});
