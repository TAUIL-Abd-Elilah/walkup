/**
 * A preset's two shows (presetFor): the fixture show unchanged, a live run
 * with no live show stopped before any call, a live block's ids, date and
 * inputs used end to end (the fixture world stands in for the live
 * transports), and the G1 rule with its working shown (explainG1Rule).
 */
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { createMemoryLedger } from "@walkup/contracts";
import type { TmEvent } from "@walkup/tm";
import { WORLD_EVENT_IDS, WORLD_VENUES } from "@walkup/qloo-world";
import {
  applyG1Rule,
  explainG1Rule,
  genreClass,
  DISTANCE_FROM_ROOTS,
  HERO_RULE,
  HERO_WINDOW,
  NO_LIVE_SHOW,
  parentRequest,
  planShow,
  presetFor,
  PRESETS,
  type LivePreset,
  type Preset,
} from "../src/index";
import { deps } from "./helpers";

/** A live block for tests only: fixture-world ids so the world can answer it. */
const TEST_LIVE: LivePreset = {
  tmEventId: WORLD_EVENT_IDS.g1b,
  tmVenueId: WORLD_VENUES.truth.id,
  asOf: "2026-11-02",
  title: "Test live show",
  venue: { name: WORLD_VENUES.truth.name, city: WORLD_VENUES.truth.city, state: WORLD_VENUES.truth.state },
  selection: { rule: HERO_RULE, result: "Bill A" },
  operator: {
    seatsLeft: null,
    capacity: 500,
    mediaBudgetUsd: 900,
    streetTeamDays: ["friday"],
    radiusKm: 30,
    declaredPartners: [{ label: "Test partner by label" }],
  },
  line: "A test line for the live show.",
};

/** Runs `fn` with g1-a's live block set to `live`, then puts the preset back. */
async function withLive<T>(live: LivePreset | null, fn: () => Promise<T>): Promise<T> {
  const before = PRESETS["g1-a"].live;
  PRESETS["g1-a"].live = live;
  try {
    return await fn();
  } finally {
    PRESETS["g1-a"].live = before;
  }
}

describe("presetFor", () => {
  it("gives the fixture fields unchanged in fixture mode, with or without a live block", () => {
    for (const p of Object.values(PRESETS)) {
      const fixture = { tmEventId: p.tmEventId, asOf: p.asOf, title: p.title, venue: p.venue, selection: p.selection, operator: p.operator, line: p.line, realShow: p.realShow };
      expect(presetFor(p, "fixture"), p.id).toEqual(fixture);
      expect(presetFor({ ...p, live: TEST_LIVE }, "fixture"), p.id).toEqual(fixture);
    }
  });

  it("gives the live block in live mode as a real show, and null without one", () => {
    const p: Preset = { ...PRESETS["g1-a"], live: TEST_LIVE };
    expect(presetFor(p, "live")).toEqual({
      tmEventId: TEST_LIVE.tmEventId,
      asOf: "2026-11-02",
      title: "Test live show",
      venue: { ...TEST_LIVE.venue, tmVenueId: TEST_LIVE.tmVenueId },
      selection: TEST_LIVE.selection,
      operator: TEST_LIVE.operator,
      line: TEST_LIVE.line,
      realShow: true,
    });
    expect(presetFor({ ...p, live: null }, "live")).toBeNull();
  });

  it("every live block holds real-only inputs picked by the hero rule", () => {
    for (const p of Object.values(PRESETS)) {
      const live = p.live;
      if (!live) continue;
      expect(live.tmEventId.startsWith("syn-tm-"), p.id).toBe(false);
      expect(live.tmVenueId.startsWith("syn-tm-"), p.id).toBe(false);
      expect(live.asOf, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(live.selection.rule, p.id).toBe(HERO_RULE);
      expect(live.operator.seatsLeft, p.id).toBeNull();
      expect(live.line, p.id).not.toMatch(/\{seats_left\}/);
      for (const d of live.operator.declaredPartners) {
        // Fixture-world entity ids all start with "0000".
        expect(d.qlooEntityId?.startsWith("0000") ?? false, `${p.id} ${d.label}`).toBe(false);
        expect(d.contactEmail, `${p.id} ${d.label}`).toBeUndefined();
      }
    }
  });

  it("states the hero rule for its own window", () => {
    expect(HERO_WINDOW).toEqual({ from: "2026-12-20", to: "2027-02-28" });
    expect(HERO_RULE).toMatch(/one independent room, Dec 20 2026 to Feb 28 2027/i);
    expect(HERO_RULE).toMatch(/first Americana, country or folk headliner/);
  });
});

describe("planShow with a preset in live mode", () => {
  it("stops with the plain reason before any Ticketmaster or Qloo call when the preset has no live show", async () => {
    await withLive(null, async () => {
      const d = deps();
      d.world.resetStats();
      const r = await planShow({ presetId: "g1-a" }, { ...d, mode: "live" });
      expect(r.mode).toBe("live");
      expect(r.status).toBe("error");
      expect(r.error).toBe(NO_LIVE_SHOW);
      expect(r.budget.qlooTotal).toBe(0);
      expect(r.budget.tm).toBe(0);
      expect(d.world.stats()).toMatchObject({ qloo: 0, tm: 0, places: 0 });
    });
  });

  it("plans the live block's event, date and inputs, and a fixture run still plans the fixture show", async () => {
    await withLive(TEST_LIVE, async () => {
      const d = deps();
      const live = await planShow({ presetId: "g1-a" }, { ...d, mode: "live" }, { persist: false });
      expect(live.status).toBe("complete");
      const sheet = live.sheet as StreetSheet;
      expect(sheet.mode).toBe("live");
      expect(sheet.bill.tmEventId).toBe(TEST_LIVE.tmEventId);
      expect(sheet.operator).toMatchObject({ capacity: 500, mediaBudgetUsd: 900, streetTeamDays: ["friday"], radiusKm: 30 });
      expect(sheet.operator.declaredPartners.map((p) => p.label)).toEqual(["Test partner by label"]);
      // The house roster window starts on the live block's date.
      const roster = sheet.ledger.find((e) => e.kind === "tm" && e.params.venueId === WORLD_VENUES.truth.id);
      expect(roster?.params.startDateTime).toBe("2026-11-02T00:00:00Z");
      // A revision of the live sheet re-runs the live show by its event.
      expect(parentRequest(sheet, { presetId: "g1-a" })).toMatchObject({ tmEventId: TEST_LIVE.tmEventId, asOf: "2026-11-02", operator: { capacity: 500 } });

      const fixture = await planShow({ presetId: "g1-a" }, d, { persist: false });
      expect(fixture.sheet?.mode).toBe("fixture");
      expect(fixture.sheet?.bill.tmEventId).toBe(WORLD_EVENT_IDS.g1a);
      expect(fixture.sheet?.operator.capacity).toBe(PRESETS["g1-a"].operator.capacity);
    });
  });

  it("does not rebuild a live sheet's preset request while the preset has no live show", async () => {
    await withLive(null, async () => {
      const sheet = { mode: "live", steps: [], bill: { acts: [] } } as unknown as StreetSheet;
      expect(parentRequest(sheet, { presetId: "g1-a" })).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// explainG1Rule
// ---------------------------------------------------------------------------

/** applyG1Rule as it was before explainG1Rule existed: the reference for identical picks. */
function originalG1Rule(events: readonly TmEvent[], window = { from: "2026-11-20", to: "2026-12-20" }): { billA: string | null; billB: string | null } {
  const inWindow = events
    .filter((e) => {
      const d = e.dates?.start?.localDate ?? "";
      const code = e.dates?.status?.code?.toLowerCase();
      return d >= window.from && d <= window.to && code !== "canceled" && code !== "cancelled";
    })
    .sort((a, b) => ((a.dates?.start?.localDate ?? "") < (b.dates?.start?.localDate ?? "") ? -1 : 1));
  const a = inWindow.find((e) => genreClass(e) === "roots") ?? null;
  if (!a) return { billA: null, billB: null };
  let best: { id: string; d: number; date: string } | null = null;
  for (const e of inWindow) {
    if (e.id === a.id) continue;
    const d = DISTANCE_FROM_ROOTS[genreClass(e)];
    const date = e.dates?.start?.localDate ?? "";
    if (d > 0 && (!best || d > best.d || (d === best.d && date < best.date))) best = { id: e.id, d, date };
  }
  return { billA: a.id, billB: best?.id ?? null };
}

function ev(id: string, localDate: string, genre: string, subGenre?: string, status?: string): TmEvent {
  return {
    id,
    name: `Test bill ${id}`,
    dates: { start: { localDate }, ...(status ? { status: { code: status } } : {}) },
    classifications: [{ segment: { name: "Music" }, genre: { name: genre }, ...(subGenre ? { subGenre: { name: subGenre } } : {}) }],
  };
}

describe("explainG1Rule", () => {
  it("shows every event dated in the window and picks the same bills as applyG1Rule on the fixture room", async () => {
    const tm = deps().tm!(createMemoryLedger());
    const roster = (await tm.eventsByVenue(WORLD_VENUES.truth.id, { startDateTime: "2026-10-30", size: 60 })).data;
    const ex = explainG1Rule(roster);
    expect([ex.billA.id, ex.billB.id]).toEqual([WORLD_EVENT_IDS.g1a, WORLD_EVENT_IDS.g1b]);
    expect(applyG1Rule(roster)).toEqual({ billA: ex.billA.id, billB: ex.billB.id });
    expect(ex.window).toEqual({ from: "2026-11-20", to: "2026-12-20" });
    const dates = ex.candidates.map((c) => c.localDate);
    expect(dates).toEqual([...dates].sort());
    expect(dates.every((d) => d >= "2026-11-20" && d <= "2026-12-20")).toBe(true);
    expect(ex.candidates.length).toBe(roster.filter((e) => (e.dates?.start?.localDate ?? "") >= "2026-11-20" && (e.dates?.start?.localDate ?? "") <= "2026-12-20").length);
    const canceled = ex.candidates.find((c) => c.status === "canceled");
    expect(canceled?.eligible).toBe(false);
    const a = ex.candidates.find((c) => c.id === WORLD_EVENT_IDS.g1a);
    expect(a).toMatchObject({ genre: "Country", subGenre: "Americana", genreClass: "roots", distance: 0, eligible: true });
    const b = ex.candidates.find((c) => c.id === WORLD_EVENT_IDS.g1b);
    expect(b).toMatchObject({ genreClass: "indie_pop", distance: DISTANCE_FROM_ROOTS.indie_pop });
    expect(ex.billA.reason).toMatch(/^First Americana, country or folk bill from 2026-11-20 to 2026-12-20: Hollis Creek String Band .* on 2026-11-20 \(Country \/ Americana\)\.$/);
    expect(ex.billB.reason).toMatch(/^Genre most distant from bill A \(indie pop, distance 0\.8\): Neon Orchard .* on 2026-12-05 \(Pop \/ Indie Pop\)\.$/);
  });

  it("skips canceled bills and events outside the window, and takes the earliest of tied distances", () => {
    const events = [
      ev("outside-early", "2026-12-19", "Country"),
      ev("canceled-roots", "2026-12-21", "Folk", undefined, "canceled"),
      ev("rock", "2026-12-22", "Rock", "Undefined"),
      ev("roots", "2027-01-05", "Country", "Americana"),
      ev("rap-late", "2027-02-20", "Hip-Hop/Rap"),
      ev("rap-early", "2027-01-10", "Hip-Hop/Rap"),
      ev("latin", "2027-01-02", "Latin"),
      ev("outside-late", "2027-03-01", "Hip-Hop/Rap"),
    ];
    const ex = explainG1Rule(events, HERO_WINDOW);
    expect(ex.candidates.map((c) => c.id)).toEqual(["canceled-roots", "rock", "latin", "roots", "rap-early", "rap-late"]);
    expect(ex.candidates.find((c) => c.id === "rock")).toMatchObject({ subGenre: null, genreClass: "other", distance: 0 });
    expect(ex.billA).toEqual({ id: "roots", reason: "First Americana, country or folk bill from 2026-12-20 to 2027-02-28: Test bill roots on 2027-01-05 (Country / Americana)." });
    expect(ex.billB).toEqual({
      id: "rap-early",
      reason: "Genre most distant from bill A (hip-hop, distance 1, the earliest of 2 at that distance): Test bill rap-early on 2027-01-10 (Hip-Hop/Rap).",
    });
    expect(applyG1Rule(events, HERO_WINDOW)).toEqual({ billA: "roots", billB: "rap-early" });
  });

  it("says why there is no pick", () => {
    const noRoots = explainG1Rule([ev("rap", "2027-01-10", "Hip-Hop/Rap")], HERO_WINDOW);
    expect(noRoots.billA).toEqual({ id: null, reason: "No Americana, country or folk bill from 2026-12-20 to 2027-02-28." });
    expect(noRoots.billB).toEqual({ id: null, reason: "No bill A, so no bill B." });
    const noDistant = explainG1Rule([ev("roots", "2027-01-05", "Folk"), ev("rock", "2027-01-06", "Rock")], HERO_WINDOW);
    expect(noDistant.billA.id).toBe("roots");
    expect(noDistant.billB).toEqual({ id: null, reason: "No hip-hop, R&B, Latin, comedy or indie-pop bill from 2026-12-20 to 2027-02-28 besides bill A." });
  });

  it("picks exactly what the original rule picked, on long shuffled calendars with shared dates", () => {
    const genres = ["Country", "Folk", "Rock", "Hip-Hop/Rap", "R&B", "Latin", "Comedy", "Pop", "Jazz"];
    let seed = 7;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    for (let round = 0; round < 40; round++) {
      const n = 20 + (next() % 140);
      const events = Array.from({ length: n }, (_, i) => {
        const day = 1 + (next() % 28);
        const month = ["2026-12", "2027-01", "2027-02"][next() % 3];
        const status = next() % 9 === 0 ? "canceled" : "onsale";
        return ev(`e${round}-${i}`, `${month}-${String(day).padStart(2, "0")}`, genres[next() % genres.length] as string, undefined, status);
      });
      for (const window of [HERO_WINDOW, { from: "2027-01-01", to: "2027-01-31" }]) {
        expect(applyG1Rule(events, window), `round ${round}`).toEqual(originalG1Rule(events, window));
      }
    }
  });
});
