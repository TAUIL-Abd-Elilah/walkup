/**
 * Round 8, street-team.ics: a stop with no free stretch on its day is timed when moving the later stops makes one and
 * each moved stop still fits its hours (La Parra on 1e0da01d's Sat Dec 5 first pass). Every recorded plan
 * (deploy/vercel/plans.json, git-ignored: skipped when absent) and every sample sheet keeps a calendar one team can
 * follow: no overlap, every stop inside its hours, travel time between stops, nothing dropped unsaid.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LiftTile, StreetSheet } from "@walkup/contracts";
import { haversineM } from "@walkup/engine";
import { hoursWeekday } from "../src/format";
import { partnerHoursOn } from "../src/hours";
import { planStreetTeam, type StreetTeamVisit } from "../src/ics";

const PLANS = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const read = (path: string): StreetSheet => (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { sheet: StreetSheet }).sheet;
const SAMPLES = ["g1-a", "g1-b", "g2", "g3"].flatMap((id) => [
  { id: `${id} (engine)`, sheet: read(`../../../fixtures/synthetic/engine/${id}.sheet.json`) },
  { id: `${id} (hand-built)`, sheet: read(`../../../fixtures/synthetic/${id}.sheet.json`) },
]);
const recorded = (): { id: string; sheet: StreetSheet }[] =>
  (JSON.parse(readFileSync(PLANS, "utf8")) as { planId: string; sheet: StreetSheet }[]).map((p) => ({ id: p.planId.slice(0, 8), sheet: p.sheet }));

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const nameOf = (v: { partner: StreetTeamVisit["partner"]; tileRank: number | null }) => v.partner?.entity.name ?? `area ${v.tileRank} flyer drop`;

/** What breaks the calendar: an overlap, a stop outside its hours, a hop shorter than its travel, a partner dropped. */
function problems(sheet: StreetSheet): string[] {
  const out: string[] = [];
  const { visits, notes } = planStreetTeam(sheet);
  const tiles = new Map<string, LiftTile>(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  const pos = (v: StreetTeamVisit) => {
    const own = v.partner?.entity.location;
    if (own && typeof own.lat === "number" && typeof own.lon === "number") return { lat: own.lat, lon: own.lon };
    const t = (v.partner?.tileGeohash ? tiles.get(v.partner.tileGeohash) : undefined) ?? v.tile;
    return t ? { lat: t.lat, lon: t.lon } : null;
  };
  const travel = (a: { lat: number; lon: number } | null, b: { lat: number; lon: number } | null) =>
    !a || !b ? 15 : Math.max(15, Math.ceil(((haversineM(a, b) / 1000) * 2) / 5) * 5);
  const listed = hoursWeekday(sheet);
  for (const date of new Set(visits.map((v) => v.date))) {
    const day = visits.filter((v) => v.date === date).sort((a, b) => toMin(a.start) - toMin(b.start));
    day.forEach((v, i) => {
      const hours = v.partner ? partnerHoursOn(v.partner, v.weekday, listed) : null;
      const ranges = hours && hours.status === "open" ? hours.ranges : [];
      if (ranges.length > 0 && !v.callFirst && !ranges.some(([a, b]) => toMin(v.start) >= a && toMin(v.end) <= b)) out.push(`${date} ${v.start} ${nameOf(v)}: outside its hours`);
      if (toMin(v.end) > 23 * 60 + 59) out.push(`${date} ${nameOf(v)}: past 23:59`);
      const prev = day[i - 1];
      if (!prev) return;
      const gap = toMin(v.start) - toMin(prev.end);
      if (gap < 0) out.push(`${date} ${prev.start} and ${v.start}: overlap`);
      else if (gap < travel(pos(prev), pos(v))) out.push(`${date} ${prev.end} -> ${v.start} ${nameOf(v)}: ${gap} min, travel needs ${travel(pos(prev), pos(v))}`);
    });
  }
  for (const pass of ["first", "final"] as const) {
    const pv = visits.filter((v) => v.pass === pass);
    const pn = notes.filter((n) => n.pass === pass);
    if (pv.length === 0 && pn.length === 0) continue;
    const timed = new Set(pv.flatMap((v) => (v.partner ? [v.partner.entity.entityId] : [])));
    const said = new Set([...pv, ...pn].flatMap((v) => [...v.closedAllDays, ...v.notTimed.flatMap((x) => (x.partner ? [x.partner] : []))].map((p) => p.entity.entityId)));
    for (const p of sheet.cards.partners.results) if (!timed.has(p.entity.entityId) && !said.has(p.entity.entityId)) out.push(`${pass}: ${p.entity.name} dropped`);
  }
  return out;
}

/** The stops a sheet's calendar has no time for, as "date name". */
function notTimed(sheet: StreetSheet): string[] {
  const { visits, notes } = planStreetTeam(sheet);
  return [...visits, ...notes].flatMap((v) => v.notTimed.map((x) => `${x.date} ${nameOf(x)}`));
}

describe("street-team.ics moves later stops to make room", () => {
  it("every sample sheet keeps a calendar one team can follow", () => {
    for (const { id, sheet } of SAMPLES) expect(problems(sheet), id).toEqual([]);
  });

  it("times a stop on the g1-b hand-built Thursday by moving the stops after it, each inside its hours", () => {
    const sheet = SAMPLES.find((s) => s.id === "g1-b (hand-built)")!.sheet;
    const day = planStreetTeam(sheet).visits.filter((v) => v.date === "2026-11-19");
    const at = (name: string) => day.find((v) => v.partner?.entity.name === name);
    expect(at("Second Skin Vintage")).toMatchObject({ start: "10:35", end: "10:55" });
    expect(at("Paperlight Ramen")).toMatchObject({ start: "11:10" });
    expect(at("Margin Notes Books")).toMatchObject({ start: "15:15", end: "15:35" });
    // The stops after the last one moved keep their times.
    expect(at("Warehouse Nine Listening Bar")).toMatchObject({ start: "16:00" });
    expect(notTimed(sheet)).toEqual([]);
  });

  it("keeps the day as it was when a moved stop would leave its hours, and says the stop has no time", () => {
    const sheet = structuredClone(SAMPLES.find((s) => s.id === "g1-b (hand-built)")!.sheet);
    const margin = sheet.cards.partners.results.find((p) => p.entity.name === "Margin Notes Books")!;
    (margin.entity.properties as unknown as { hours: Record<string, string> }).hours = { Thu: "10:00-15:30" };
    const day = planStreetTeam(sheet).visits.filter((v) => v.date === "2026-11-19");
    const at = (name: string) => day.find((v) => v.partner?.entity.name === name);
    expect(at("Second Skin Vintage")).toBeUndefined();
    expect(at("Paperlight Ramen")).toMatchObject({ start: "11:00" });
    expect(at("Margin Notes Books")).toMatchObject({ start: "15:05", end: "15:25" });
    expect(notTimed(sheet)).toEqual(["2026-11-19 Second Skin Vintage"]);
    expect(problems(sheet)).toEqual([]);
  });

  it.skipIf(!existsSync(PLANS))("every recorded plan keeps a calendar one team can follow, and only these stops have no time", () => {
    // Before round 8 the same plans also had no time for La Parra (1e0da01d, Sat Dec 5) and area 5's flyer drop
    // (e9f33884, Sat Jan 23); no other stop changed between timed and not timed.
    const expected: Record<string, string[]> = {
      "95e3c9b6": ["2027-02-06 area 5 flyer drop"],
      e9f33884: ["2027-01-23 Harrar Coffee & Roastery"],
      "1e0da01d": [
        "2026-12-05 Pixca Seasonal American Bistro",
        "2026-12-05 area 4 flyer drop",
        "2026-12-05 area 5 flyer drop",
        "2026-12-26 Pixca Seasonal American Bistro",
        "2026-12-26 area 5 flyer drop",
      ],
      "2d8201da": [
        "2026-12-19 QS TIPS AND WINGS BBQ",
        "2026-12-19 Jeffery Pub",
        "2026-12-19 area 4 flyer drop",
        "2026-12-19 area 5 flyer drop",
        "2027-01-09 QS TIPS AND WINGS BBQ",
      ],
    };
    for (const { id, sheet } of recorded()) {
      expect(problems(sheet), id).toEqual([]);
      expect(notTimed(sheet), id).toEqual(expected[id] ?? []);
    }
  });

  it.skipIf(!existsSync(PLANS) || !recorded().some((p) => p.id === "1e0da01d"))(
    "1e0da01d: La Parra fits the Sat Dec 5 first pass after BABYGOLD, and the stops after it move 10 minutes",
    () => {
      const sheet = recorded().find((p) => p.id === "1e0da01d")!.sheet;
      const day = planStreetTeam(sheet).visits.filter((v) => v.date === "2026-12-05");
      const start = (name: string) => day.find((v) => v.partner?.entity.name === name)?.start;
      expect(day.find((v) => v.partner?.entity.name === "La Parra Restaurant & Bar")).toMatchObject({ start: "11:35", end: "11:55" });
      expect(["BABYGOLD BARBECUE", "FitzGerald's", "Addis Cafe In Oak Park", "Oak Park Bakery Inc", "White Crane Creative Thai and Sushi", "Once Upon A Bagel", "Madame Zuzu’s", "Alex's Washington Gardens"].map(start)).toEqual(
        ["11:00", "12:10", "12:45", "13:20", "13:55", "15:30", "16:05", "17:00"],
      );
    },
  );

  it.skipIf(!existsSync(PLANS) || !recorded().some((p) => p.id === "1e0da01d"))(
    "1e0da01d on Monday and Tuesday: moving stops never leaves out a stop the plan without it times (BABYGOLD on Dec 29)",
    () => {
      // Moving stops would time Maria's Cafe on the first pass's Tuesday, so the final pass would keep it on Tuesday and
      // crowd out BABYGOLD BARBECUE; the plan without moving stops times both, so it is the one used.
      const sheet = recorded().find((p) => p.id === "1e0da01d")!.sheet;
      const plan = planStreetTeam(sheet, { streetTeamDays: ["monday", "tuesday"] });
      expect(plan.visits.some((v) => v.date === "2026-12-29" && v.pass === "final" && v.partner?.entity.name === "BABYGOLD BARBECUE")).toBe(true);
      // The same two stops as before round 8 have no time, both on the first pass.
      expect([...plan.visits, ...plan.notes].flatMap((v) => v.notTimed.map((x) => `${x.date} ${nameOf(x)}`))).toEqual([
        "2026-12-08 BABYGOLD BARBECUE",
        "2026-12-08 FitzGerald's",
      ]);
      const days = [...new Set(plan.visits.map((v) => v.date))];
      for (const date of days) {
        const day = plan.visits.filter((v) => v.date === date).sort((a, b) => toMin(a.start) - toMin(b.start));
        day.slice(1).forEach((v, i) => expect(toMin(v.start), `${date} ${v.start}`).toBeGreaterThanOrEqual(toMin(day[i]!.end)));
      }
    },
  );
});
