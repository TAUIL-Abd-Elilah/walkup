/**
 * The Oct 21 review fixes on the web side: plain words for the run's own text, category labels, the landing's
 * "pick a popularity list would miss" and up-close area, the plan page order and folds, revision links, the
 * shared fan-facing rule, the uniform share column, and the recorded-mode day.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Partner, StreetSheet } from "@walkup/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
}));
vi.mock("../components/LiftMap", () => ({
  LiftMap: () => createElement("figure", { "data-testid": "map" }),
  MapCaption: () => null,
  squareSizeLine: () => "Each square is about 1.0 km by 0.6 km.",
}));
vi.mock("../components/LiftLegend", () => ({ LiftLegend: () => null }));
vi.mock("../components/TileList", () => ({ TileList: () => createElement("ol") }));

const { PlanView } = await import("../components/plan/PlanView");
const { HeroSplit } = await import("../components/HeroSplit");
const utils = await import("../lib/sheet-utils");
const { categoryLabel, ledgerNoteText } = await import("../lib/labels");
const { runtimeMode, recordedDetail } = await import("../lib/mode");

const ENGINE = fileURLToPath(new URL("../../../fixtures/synthetic/engine/", import.meta.url));
const fixture = (id: string): StreetSheet => (JSON.parse(readFileSync(`${ENGINE}${id}.sheet.json`, "utf8")) as { sheet: StreetSheet }).sheet;

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ");
}

function renderView(sheet: StreetSheet, extra: Partial<Parameters<typeof PlanView>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(PlanView, {
      payload: { sheet, note: null, source: "preset", presetId: sheet.planId },
      line: null,
      realShow: false,
      paired: { planId: "g1-b", headliner: "Neon Orchard" },
      runtimeLive: false,
      canRerun: false,
      ...extra,
    }),
  );
}

/** A copy of a sheet whose first partner area has every pick outside the popularity-only top. */
function withPopularity(sheet: StreetSheet): StreetSheet {
  const s = structuredClone(sheet);
  const g = s.cards.partners.results.find((p) => p.tileGeohash)!.tileGeohash!;
  const picks = s.cards.partners.results.filter((p) => p.tileGeohash === g);
  picks.forEach((p, i) => {
    p.qlooRank = i + 1;
    p.houseRank = i === 0 ? 9 : i + 1;
  });
  const q = s.ledger.find((e) => e.kind === "qloo")!.id;
  s.popularityCheck = {
    partners: picks.length,
    notInPopularTop: picks.length,
    perArea: [{ tileGeohash: g, partners: picks.length, notInPopularTop: picks.length, ledgerRef: q }],
    ledgerRefs: [q],
  };
  return s;
}

describe("plain words for the run's own text", () => {
  it("turns internal keys, metres and seeds into the words the sheet uses", () => {
    expect(utils.plainText("Skipped 1 type of place that have no Qloo tag set up yet (record_store).")).toBe(
      "Skipped 1 type of place that has no Qloo tag set up yet (record store).",
    );
    expect(utils.plainText("1 area search came back short and widened to 3,500 m.")).toBe("1 area search came back short and widened to 3.5 km.");
    expect(utils.plainText("the search widened to 2,000 m")).toBe("the search widened to 2 km");
    expect(utils.plainText("A spot 240 m away")).toBe("A spot 240 m away");
    expect(utils.plainText("This bill has one seed, so it could not be split in two to check the map.")).toBe(
      "This bill has one act, so it could not be split in two to check the map.",
    );
    expect(utils.plainText("8 of the 11 partners wouldn't make a list of the most popular places in their areas.")).toBe(
      "8 of the 11 partners aren't among the most popular places in their areas.",
    );
    expect(utils.plainText("1 kind of place skipped: no pinned tag yet.")).toBe("1 kind of place skipped: no Qloo tag set up for it yet.");
  });

  it("says the signal check's request in plain words, once", () => {
    const note =
      "node Q1 signal check; signal check: which ids Qloo has taste data for; Qloo ignored 1 signal id it has no taste data for (not_found): 56495BA4-DE08-4F4C-B5A0-D88099A3F5F7";
    const text = ledgerNoteText(note);
    expect(text).toBe("Taste-data check for the acts, Qloo has no taste data for 1 of the ids, so it left it out");
    expect(text).not.toMatch(/signal check|not_found|56495BA4/);
  });

  it("labels the engine's new place kinds in sentence case, and title-cases an unknown key", () => {
    const want: Record<string, string> = {
      lounge: "Lounge",
      pub: "Pub",
      brewery: "Brewery",
      wine_bar: "Wine bar",
      cocktail_bar: "Cocktail bar",
      night_club: "Night club",
      bakery: "Bakery",
      bowling_alley: "Bowling alley",
      bookstore: "Bookstore",
      book_store: "Bookstore",
      clothing_store: "Clothing store",
      barber: "Barber",
      salon: "Salon",
      sports_bar: "Sports bar",
      record_store: "Record store",
    };
    for (const [k, v] of Object.entries(want)) expect(categoryLabel(k)).toBe(v);
    expect(categoryLabel("ice_rink")).toBe("Ice Rink");
  });

  it("says the popularity check without 'make a list'", () => {
    const c = { partners: 11, notInPopularTop: 8, perArea: [{ tileGeohash: "a" }, { tileGeohash: "b" }] } as Parameters<typeof utils.popularityLine>[0];
    expect(utils.popularityLine(c)).toBe("8 of the 11 partners aren't among the most popular places in their areas, so a popularity list would miss them.");
    expect(utils.popularityLine({ ...c, notInPopularTop: 0 })).toBe("All 11 partners are also among the most popular places in their areas.");
  });
});

describe("the landing's story", () => {
  it("names one real pick the popularity list misses, from an area where none of the picks is in its top", () => {
    const s = withPopularity(fixture("g1-a"));
    const pick = utils.missedPick(s)!;
    expect(pick).not.toBeNull();
    // The first pick ranks 1st for this crowd and 9th for the usual crowd: the widest gap.
    expect(pick.billRank).toBe(1);
    expect(pick.houseRank).toBe(9);
    const line = utils.missedPickLine(pick);
    expect(line).toMatch(/: 1st for this crowd, 9th for the room's usual crowd, and not among the area's \d+ most popular places\.$/);
    expect(line).toContain(pick.area);
    expect(pick.refs).toContain(s.popularityCheck!.perArea[0]!.ledgerRef);
    // An area where some picks are in the popular top can't say which: no line.
    const partial = structuredClone(s);
    partial.popularityCheck!.perArea[0]!.notInPopularTop -= 1;
    expect(utils.missedPick(partial)).toBeNull();
    // No popularity check, no line.
    const none = structuredClone(s);
    delete none.popularityCheck;
    expect(utils.missedPick(none)).toBeNull();
    expect(utils.popularityAreas(none)).toEqual([]);
  });

  it("carries the popularity-only names when the sheet stores them, best first", () => {
    const s = withPopularity(fixture("g1-a"));
    expect(utils.popularityAreas(s)[0]!.popular).toBeNull();
    const area = s.popularityCheck!.perArea[0]!;
    area.popularTop = Array.from({ length: area.partners }, (_, i) => ({ entityId: `pop-${i}`, name: `Popular Place ${area.partners - i}`, rank: area.partners - i, onSheet: false }));
    const [a] = utils.popularityAreas(s);
    expect(a!.popular!.map((x) => x.rank)).toEqual(Array.from({ length: area.partners }, (_, i) => i + 1));
    expect(a!.popular![0]!.name).toBe("Popular Place 1");
    // A missing name falls back to the table without names.
    area.popularTop[0]!.name = "";
    expect(utils.popularityAreas(s)[0]!.popular).toBeNull();
  });

  it("never names a national chain as the pick a popularity list would miss", () => {
    const s = withPopularity(fixture("g1-a"));
    const first = utils.missedPick(s)!;
    s.cards.partners.results.find((p) => p.entity.entityId === first.entityId)!.chain = true;
    expect(utils.missedPick(s)?.entityId).not.toBe(first.entityId);
  });

  it("lists one area's picks with both ranks, best first", () => {
    const s = withPopularity(fixture("g1-a"));
    const [area] = utils.popularityAreas(s);
    expect(area!.picks.map((p) => p.billRank)).toEqual([...area!.picks.map((p) => p.billRank)].sort((a, b) => a - b));
    expect(area!.area).toMatch(/, [A-Z]{2}(, \d+ km \w+)?$/);
    expect(area!.area).not.toBe(area!.geohash);
  });

  it("shows the pick line and the revision link under each hero bill", () => {
    const s = withPopularity(fixture("g1-a"));
    const side = {
      planId: s.planId,
      headliner: "Hollis Creek String Band",
      support: [],
      label: "Country",
      place: "The Truth",
      date: "Fri Nov 20 2026",
      tiles: [],
      top: [],
      venue: { lat: 0, lon: 0, name: "The Truth" },
      partners: 24,
      missed: { line: "A pick a popularity list would miss: X in Y.", refs: ["Q14", "Q21"] },
      revisions: [{ planId: "rev-1", instruction: "All ages, no bars" }],
    };
    const html = renderToStaticMarkup(createElement(HeroSplit, { a: side, b: { ...side, planId: "b", missed: null, revisions: [] } }));
    expect(html).toContain('data-testid="hero-A-missed"');
    expect(html).not.toContain('data-testid="hero-B-missed"');
    expect(html).toContain(`href="/plan/${s.planId}#receipt-Q21"`);
    expect(html).toContain('href="/plan/rev-1"');
    expect(visibleText(html)).toContain("Revised: All ages, no bars");
  });
});

describe("the plan page", () => {
  it("puts the summary, map, partners and downloads first and folds the lower sections behind Show", () => {
    const html = renderView(fixture("g1-a"));
    const at = (id: string) => html.indexOf(`id="${id}"`);
    expect(at("summary")).toBeLessThan(at("lift"));
    expect(at("lift")).toBeLessThan(at("partners"));
    expect(at("partners")).toBeLessThan(at("downloads"));
    for (const id of ["resolution", "declared", "media", "hooks", "limits", "ledger"]) expect(at("downloads")).toBeLessThan(at(id));
    // Each folded section keeps its heading and has a plain "Show" disclosure.
    const folds = html.match(/<details class="plain-details fold mt-2">/g)?.length ?? 0;
    expect(folds).toBeGreaterThanOrEqual(6);
    expect(visibleText(html)).toMatch(/Show Hide Copy lines/);
    // The street team's sections are never folded.
    const partners = html.slice(at("partners"), at("downloads"));
    expect(partners).not.toContain("fold");
  });

  it("links the other bill once and drops the Swap the bill link", () => {
    const html = renderView(fixture("g1-a"));
    expect(html).not.toMatch(/Swap the bill/);
    expect(html.match(/href="\/plan\/g1-b"/g)?.length).toBe(1);
  });

  it("links the stored revisions from the header", () => {
    const html = renderView(fixture("g1-a"), { revisions: [{ planId: "rev-1", instruction: "All ages, no bars" }] });
    expect(html).toContain('data-testid="revision-links"');
    expect(html).toContain('href="/plan/rev-1"');
    expect(visibleText(html)).toContain("Revised: All ages, no bars");
    expect(renderView(fixture("g1-a"))).not.toContain('data-testid="revision-links"');
  });

  it("counts days to the show from the day the page is viewed, and says when a recording was made", () => {
    const s = { ...structuredClone(fixture("g1-a")), mode: "live" as const };
    const show = Date.parse(`${s.bill.date}T00:00:00Z`);
    const today = new Date(show - 10 * 86_400_000).toISOString();
    const text = visibleText(renderView(s, { recorded: true, today }));
    expect(text).toMatch(/Days to show 10 Recorded \w{3} \d{1,2} /);
    expect(text).not.toMatch(/of 15 wanted/);
  });

  it("says when the run's own checks set Claude's summary aside", () => {
    const s = structuredClone(fixture("g1-a"));
    s.narration = { ...s.narration!, templated: false };
    s.guard = { ...s.guard, reasons: ["replaced by the template: summary: superlative \"the most\" not backed by the sheet", "replaced by the template: tileWhy[1]: says three partners"] };
    const html = renderView(s);
    const text = visibleText(html);
    // Said once, plainly, under Checks in the limits section; the Summary opens with the summary itself.
    expect(text).toMatch(/Claude.s draft summary made a claim the sheet doesn.t back, so fixed wording replaced it\. 1 of Claude.s area and partner lines was replaced the same way\./);
    expect(html.indexOf('data-testid="checks-fix"')).toBeGreaterThan(html.indexOf('id="limits"'));
    expect(visibleText(html.slice(html.indexOf('id="summary"'), html.indexOf('id="lift"')))).not.toMatch(/Fixed wording:|made a claim/);
  });

  it("drops the share column when every spot has the same share, and says the share once", () => {
    const s = structuredClone(fixture("g1-a"));
    for (const x of s.cards.prePost.results) x.expectedShare = 0.02;
    const html = renderView(s);
    const prepost = html.slice(html.indexOf('id="prepost"'), html.indexOf('id="resolution"'));
    expect(prepost).not.toMatch(/>\s*Share\s*</);
    expect(visibleText(prepost)).toContain("Each spot gets the same share of the crowd, 2.0%.");
    // Equal shares mean equal guests too: no Guests column either.
    expect(prepost).not.toMatch(/>\s*Guests\s*</);
    const mixed = renderView(fixture("g1-a"));
    const shares = new Set(fixture("g1-a").cards.prePost.results.map((x) => x.expectedShare));
    if (shares.size > 1) expect(mixed.slice(mixed.indexOf('id="prepost"'), mixed.indexOf('id="resolution"'))).toMatch(/>\s*Share\s*</);
  });

  it("marks spots for fans with the same rule as the PDF (age policy and all-ages setting)", () => {
    const s = structuredClone(fixture("g1-a"));
    s.bill.legalAgeEnforced = false;
    s.operator.allAges = true;
    // A name with no character the markup escapes, so it can be found in the HTML.
    const plain = s.cards.prePost.results.filter((x) => /^[\w .-]+$/.test(x.entity.name));
    const bar = plain.find((x) => x.category === "bar") ?? plain[0] ?? s.cards.prePost.results[0]!;
    bar.category = "bar";
    // The stored flag says fan-facing, but an all-ages show keeps bars off fan copy.
    bar.fanFacingAllowed = true;
    const html = renderView(s);
    const row = html.slice(html.indexOf(bar.entity.name), html.indexOf(bar.entity.name) + 600);
    expect(row).toContain("not shown to fans");
  });

  it("names partner areas with their state, from the area or the partner's address", () => {
    const s = structuredClone(fixture("g1-a"));
    const p = s.cards.partners.results[0] as Partner;
    const tiles = new Map(s.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
    const tile = p.tileGeohash ? tiles.get(p.tileGeohash) : undefined;
    const html = visibleText(renderView(s));
    if (tile?.name && tile.zctas?.length) expect(html).toContain(utils.areaName(tile));
  });
});

describe("recorded mode words", () => {
  it("dates the recording from the stored sheets and never says the product is gone", () => {
    expect(recordedDetail("2026-10-21")).toBe(
      "Recorded from live Qloo and Ticketmaster runs on Oct 21 2026. Live runs are paused for judging; these sheets are what a live run produced.",
    );
    const m = runtimeMode({ WALKUP_MODE: "recorded" }, { recordedOn: () => "2026-10-21" });
    expect(m.kind).toBe("recorded");
    expect(`${m.label} ${m.detail}`).not.toMatch(/no longer|unavailable|are off|went away/i);
  });
});

describe("what the pages show of the narration and copy", () => {
  it("checks the narration, copy lines and tag lists again at view time, leaving the stored sheet alone", async () => {
    const { vettedSheet } = await import("../lib/vetted");
    const s = structuredClone(fixture("g1-a"));
    const head = s.bill.acts[0]!.name;
    s.narration = {
      ...(s.narration ?? { tileWhy: [], partnerLines: [] }),
      templated: false,
      summary: "This bill draws a crowd concentrated in the western suburbs, where about 1.8 times the room's usual crowd is expected.",
    } as NonNullable<StreetSheet["narration"]>;
    const tag = s.cards.copyHooks.results[0]!.tagIds[0]!;
    s.cards.copyHooks.results = [
      { text: "Country and soul at The Truth, Friday, Nov 20.", tagIds: [tag] },
      { text: "A supportive, diverse crowd at The Truth.", tagIds: ["urn:tag:audience:qloo:supportive", "urn:tag:audience:qloo:diverse"] },
    ];
    const t = { id: "urn:tag:region:qloo:united_states", name: "United States", type: "urn:tag:region:qloo" };
    s.cards.whatsDifferent.results.shared = [t, t, { id: "urn:tag:audience:qloo:diverse", name: "Diverse", type: "urn:tag:audience:qloo" }] as typeof s.cards.whatsDifferent.results.shared;
    const before = JSON.stringify(s);
    const v = vettedSheet(s);
    expect(JSON.stringify(s)).toBe(before);
    expect(v.replaced.length).toBeGreaterThan(0);
    expect(v.sheet.narration!.summary).not.toMatch(/western suburbs|expected|concentrated/);
    expect(v.sheet.cards.copyHooks.results.map((h) => h.text)).toEqual([`${head}: Country and soul at The Truth, Friday, Nov 20.`]);
    expect(v.sheet.cards.copyHooks.summary).toMatch(/^1 line\b/);
    expect(v.sheet.cards.whatsDifferent.results.shared.map((x) => x.name)).toEqual(["United States"]);
  });
});

describe("check notes", () => {
  it("says a line swapped for fixed wording was replaced, not left out", () => {
    expect(utils.guardNoteText("replaced by the template: tileWhy[1]: direction claim not backed by the map")).toBe(
      "Claude's line for area 2 was replaced with fixed wording: direction claim not backed by the map.",
    );
    expect(utils.guardNoteText("tileWhy[4]: number 1.7 is not in this run")).toBe("Claude's line for area 5 was left out: it had a number (1.7) that isn't from this run.");
  });
});

describe("with Qloo and without", () => {
  /** A live copy of a sheet whose first partner area stores its popularity-only names; `also` of them are picks. */
  function withNames(also: number): StreetSheet {
    const s = withPopularity(fixture("g1-a"));
    s.mode = "live";
    const area = s.popularityCheck!.perArea[0]!;
    const picks = s.cards.partners.results.filter((p) => p.tileGeohash === area.tileGeohash);
    area.popularTop = Array.from({ length: area.partners }, (_, i) =>
      i < also ? { entityId: picks[i]!.entity.entityId, name: picks[i]!.entity.name, rank: i + 1, onSheet: true } : { entityId: `pop-${i}`, name: `Popular Place ${i + 1}`, rank: i + 1, onSheet: false },
    );
    area.notInPopularTop = area.partners - also;
    return s;
  }

  it("states the measured fact as the headline", () => {
    expect(utils.withWithoutHeadline("Laurel, MD", 8, 0)).toBe("None of the 8 most popular places in Laurel, MD made Walkup's list");
    expect(utils.withWithoutHeadline("Downtown Nashville, TN", 8, 1)).toBe("Only 1 of the 8 most popular places in Downtown Nashville, TN made Walkup's list");
    expect(utils.withWithoutHeadline("H Street NE, DC", 7, 5)).toBe("5 of the 7 most popular places in H Street NE, DC made Walkup's list");
    expect(utils.withWithoutHeadline("near the room", 8, 2)).toBe("Only 2 of the 8 most popular places near the room made Walkup's list");
    expect(utils.withWithoutHeadline("X", 3, 3)).toBe("All 3 of the most popular places in X are also on Walkup's list");
    expect(utils.withWithoutHeadline("X", 1, 0)).toBe("The most popular place in X didn't make Walkup's list");
  });

  it("reads both lists from the sheet: names and ranks, the overlap counted from onSheet", () => {
    const s = withNames(1);
    const w = utils.withWithout(s)!;
    const area = s.popularityCheck!.perArea[0]!;
    expect(w.k).toBe(area.partners);
    expect(w.overlap).toBe(1);
    expect(w.popular.map((p) => p.rank)).toEqual(Array.from({ length: area.partners }, (_, i) => i + 1));
    expect(w.picks.map((p) => p.billRank)).toEqual([...w.picks.map((p) => p.billRank)].sort((a, b) => a - b));
    expect(w.popularRef).toBe(area.ledgerRef);
    expect(w.pickRefs).not.toContain(area.ledgerRef);
    expect(w.headline).toBe(utils.withWithoutHeadline(w.area, w.k, 1));
    expect(utils.pickRanksLine({ billRank: 3, houseRank: 25 })).toBe("3rd for this crowd · 25th for the room's usual crowd");
    expect(utils.pickRanksLine({ billRank: 2, houseRank: null })).toBe("2nd for this crowd · not ranked for the room's usual crowd");
  });

  it("is absent without stored names or without the check", () => {
    const s = withPopularity(fixture("g1-a"));
    expect(utils.withWithout(s)).toBeNull();
    const none = withNames(0);
    delete none.popularityCheck;
    expect(utils.withWithout(none)).toBeNull();
  });

  it("shows on a live sheet's partner card with plain labels, and not on a sample", () => {
    const html = renderView(withNames(0));
    expect(html).toContain('data-testid="with-without"');
    expect(html).toContain("Most popular here, any crowd");
    expect(html).toContain("Picked for this show&#x27;s fans");
    expect(visibleText(html)).toMatch(/None of the \d+ most popular places in .+ made Walkup.s list/);
    const sample = withNames(0);
    sample.mode = "fixture";
    expect(renderView(sample)).not.toContain('data-testid="with-without"');
  });
});
