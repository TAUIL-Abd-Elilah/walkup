/**
 * The downloads of every recorded plan (deploy/vercel/plans.json, git-ignored: skipped when absent) and of the four
 * sample sheets: a street-team calendar one team can follow, the budget split the plan page shows, an area in every
 * area cell, and national chains listed last.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LiftTile, StreetSheet } from "@walkup/contracts";
import { haversineM } from "@walkup/engine";
import { formatUsd, hoursWeekday, isYmd, sheetSpots, topTiles, ymdOf } from "../src/format";
import { partnerHoursOn } from "../src/hours";
import { isStreetTeamBlackout, NO_TIME_ON_ROUTE, planStreetTeam, planStreetTeamVisits, streetTeamPasses, type StreetTeamVisit } from "../src/ics";
import { renderStreetSheetPdf } from "../src/pdf";
import { buildSheetModel, partnerHoursColumn } from "../src/sheet-model";
import { offerCodeRows, partnersCsv } from "../src/tables";
import { parseCsvObjects } from "./csv-parse";
import { pdfPlainText } from "./pdf-text";

const PLANS = fileURLToPath(new URL("../../../deploy/vercel/plans.json", import.meta.url));
const SAMPLES = ["g1-a", "g1-b", "g2", "g3"].map((id) => ({
  id,
  sheet: (JSON.parse(readFileSync(new URL(`../../../fixtures/synthetic/engine/${id}.sheet.json`, import.meta.url), "utf8")) as { sheet: StreetSheet }).sheet,
}));
const recorded = (): { id: string; sheet: StreetSheet }[] =>
  (JSON.parse(readFileSync(PLANS, "utf8")) as { planId: string; sheet: StreetSheet }[]).map((p) => ({ id: p.planId.slice(0, 8), sheet: p.sheet }));

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** The calendar's own travel rule: 2 minutes per km, rounded up to 5 minutes, at least 15. */
function travel(a: { lat: number; lon: number } | null, b: { lat: number; lon: number } | null): number {
  if (!a || !b) return 15;
  return Math.max(15, Math.ceil(((haversineM(a, b) / 1000) * 2) / 5) * 5);
}

/** What is wrong with a sheet's street-team calendar, as lines (none when one team can follow it). */
function calendarProblems(sheet: StreetSheet): string[] {
  const out: string[] = [];
  const { visits, notes } = planStreetTeam(sheet);
  const tiles = new Map<string, LiftTile>(sheet.cards.liftMap.results.tiles.map((t) => [t.geohash, t]));
  const pos = (v: StreetTeamVisit) => {
    const own = v.partner?.entity.location;
    if (own && typeof own.lat === "number" && typeof own.lon === "number") return { lat: own.lat, lon: own.lon };
    const t = (v.partner?.tileGeohash ? tiles.get(v.partner.tileGeohash) : undefined) ?? v.tile;
    return t ? { lat: t.lat, lon: t.lon } : null;
  };
  const twoPasses = visits.some((v) => v.pass === "first") && visits.some((v) => v.pass === "final");
  const listed = hoursWeekday(sheet);
  const dates = [...new Set(visits.map((v) => v.date))];
  for (const date of dates) {
    if (isStreetTeamBlackout(date)) out.push(`${date}: a holiday`);
    const day = visits.filter((v) => v.date === date).sort((a, b) => toMin(a.start) - toMin(b.start));
    day.forEach((v, i) => {
      const name = v.partner?.entity.name ?? `area ${v.tileRank} flyer drop`;
      const len = toMin(v.end) - toMin(v.start);
      const hours = v.partner ? partnerHoursOn(v.partner, v.weekday, listed) : null;
      const ranges = hours && hours.status === "open" ? hours.ranges : [];
      // A whole stop, never cut at 23:59 (a stop is shorter only when the place itself closes sooner).
      const whole = v.partner ? (twoPasses && v.pass === "final" ? 10 : 20) : 90;
      if (len < whole && !ranges.some(([, b]) => b === toMin(v.end) && b < 23 * 60 + 59)) out.push(`${date} ${v.start}-${v.end} ${name}: cut short`);
      if (v.end === "23:59") out.push(`${date} ${v.start}-${v.end} ${name}: ends at 23:59`);
      if (ranges.length > 0 && !v.callFirst && !ranges.some(([a, b]) => toMin(v.start) >= a && toMin(v.end) <= b)) out.push(`${date} ${v.start} ${name}: outside its hours`);
      const prev = day[i - 1];
      if (!prev) return;
      const gap = toMin(v.start) - toMin(prev.end);
      if (gap < 0) out.push(`${date} ${prev.start}-${prev.end} and ${v.start}: overlap`);
      else if (gap < travel(pos(prev), pos(v))) out.push(`${date} ${prev.end} -> ${v.start} ${name}: ${gap} min, travel needs ${travel(pos(prev), pos(v))}`);
    });
  }
  // Every street-team day of each pass, as the calendar plans them.
  const created = new Date(sheet.createdAt);
  const passDays = streetTeamPasses(sheet.bill.date, sheet.operator.streetTeamDays ?? [], Number.isNaN(created.getTime()) ? {} : { notBefore: ymdOf(created) });
  for (const pass of ["first", "final"] as const) {
    const passDates = passDays.filter((d) => d.pass === pass).map((d) => d.date);
    if (passDates.length === 0) continue;
    const pv = visits.filter((v) => v.pass === pass);
    const pn = notes.filter((n) => n.pass === pass);
    if (pv.some((v) => !passDates.includes(v.date)) || pn.some((n) => !passDates.includes(n.date))) out.push(`${pass}: an event off the pass's days`);
    // Every partner is timed, said closed on every day, or listed as having no time left: none just disappears, even
    // in a pass that times nothing.
    const timed = new Set(pv.flatMap((v) => (v.partner ? [v.partner.entity.entityId] : [])));
    const said = new Set(
      [...pv, ...pn].flatMap((v) => [...v.closedAllDays, ...v.notTimed.flatMap((x) => (x.partner ? [x.partner] : []))].map((p) => p.entity.entityId)),
    );
    for (const p of sheet.cards.partners.results) if (!timed.has(p.entity.entityId) && !said.has(p.entity.entityId)) out.push(`${pass}: ${p.entity.name} dropped`);
    // A stop with no time left is said on its day's earliest event, or in that day's all-day note when nothing is timed then.
    for (const v of pv) for (const x of v.notTimed) if (pv.find((o) => o.date === x.date) !== v) out.push(`${pass}: no-time note for ${x.date} not on its first event`);
    for (const n of pn) {
      if (pv.some((v) => v.date === n.date)) out.push(`${pass} ${n.date}: an all-day note on a day with timed stops`);
      if (n.notTimed.some((x) => x.date !== n.date)) out.push(`${pass} ${n.date}: a note for another day`);
    }
    // Each day holds between half and one and a half times its share of the pass's stops.
    if (passDates.length < 2) continue;
    const notTimed = [...pv, ...pn].flatMap((v) => v.notTimed);
    const count = (d: string) => pv.filter((v) => v.date === d).length + notTimed.filter((x) => x.date === d).length;
    const share = passDates.reduce((a, d) => a + count(d), 0) / passDates.length;
    for (const d of passDates) if (count(d) < share * 0.5 || count(d) > share * 1.5) out.push(`${pass} ${d}: ${count(d)} stops, share ${share}`);
  }
  return out;
}

/** What the files and the paper get wrong against the stored sheet: budget, area cells, chains. */
function fileProblems(sheet: StreetSheet): string[] {
  const out: string[] = [];
  const m = buildSheetModel(sheet);
  const split = new Map((sheet.budgetSplit ?? []).map((b) => [b.geohash, b.share]));
  const top = topTiles(sheet, { maxTiles: 5 });
  const budget = sheet.operator.mediaBudgetUsd;
  // The budget split by area: each area's own stored share and dollars, as the plan page shows them.
  m.footer.budget.forEach((row, i) => {
    const share = split.get(top[i]!.geohash);
    if (share === undefined) return;
    if (row.share !== `${(share * 100).toFixed(1)}%`) out.push(`budget area ${i + 1}: ${row.share}, stored ${share}`);
    if (budget !== null && row.usd !== formatUsd(budget * share)) out.push(`budget area ${i + 1}: ${row.usd}, stored ${formatUsd(budget * share)}`);
  });
  // An area in every area cell: the paper, partners.csv, offer-codes.csv.
  for (const r of m.panel2.rows) if (r.tile.trim() === "") out.push(`paper: no area for ${r.name}`);
  for (const r of parseCsvObjects(partnersCsv(sheet))) if (r.list === "suggested" && r.tile!.trim() === "") out.push(`partners.csv: no area for ${r.name}`);
  for (const r of offerCodeRows(sheet)) if (r.channel !== "your list" && r.tile.trim() === "") out.push(`offer-codes.csv: no area for ${r.assignedTo}`);
  // A partner street-team.ics or partners.csv has no time left for says so after its hours, on the paper's row and in
  // the cell the plan page and the email use; no other row does.
  const { visits, notes } = planStreetTeam(sheet);
  const inIcs = new Set([...visits, ...notes].flatMap((v) => v.notTimed.flatMap((x) => (x.partner ? [x.partner.entity.entityId] : []))));
  const inCsv = new Set(parseCsvObjects(partnersCsv(sheet)).flatMap((r) => (r.visit_dates!.includes(`(${NO_TIME_ON_ROUTE})`) ? [r.qloo_entity_id!] : [])));
  const col = partnerHoursColumn(sheet);
  for (const r of m.panel2.rows) {
    const untimed = inIcs.has(r.entityId) || inCsv.has(r.entityId);
    const cell = col.cell(sheet.cards.partners.results.find((p) => p.entity.entityId === r.entityId)!);
    const said = r.routeNote !== "" && r.hours === `${r.dayHours}; ${r.routeNote}` && cell.hours === r.hours && cell.withDay.endsWith(`; ${r.routeNote}`);
    if (untimed !== said) out.push(`paper: ${r.name} ${said ? "says" : "does not say"} the route has no time left for it`);
    if (!untimed && r.hours !== r.dayHours) out.push(`paper: ${r.name} has more than its hours`);
  }
  // National chains last, as the spots card says, on the paper and in the stored order.
  for (const [where, list] of [
    ["paper", sheetSpots(sheet.cards.prePost.results)],
    ["sheet.json", sheet.cards.prePost.results],
  ] as const) {
    const first = list.findIndex((s) => s.chain === true);
    if (first >= 0 && list.slice(first).some((s) => s.chain !== true)) out.push(`${where}: a local spot after a chain`);
  }
  return out;
}

describe("the sample sheets' downloads", () => {
  for (const { id, sheet } of SAMPLES) {
    it(`${id}: a calendar one street team can follow, and files that match the plan page`, () => {
      expect(isYmd(sheet.bill.date)).toBe(true);
      expect(calendarProblems(sheet)).toEqual([]);
      expect(fileProblems(sheet)).toEqual([]);
    });
  }

  it("g2 uses both of its street-team days, Thursday and Friday, in each pass", () => {
    const g2 = SAMPLES.find((x) => x.id === "g2")!.sheet;
    const visits = planStreetTeamVisits(g2);
    for (const pass of ["first", "final"] as const) expect(new Set(visits.filter((v) => v.pass === pass).map((v) => v.weekday)), pass).toEqual(new Set(["thursday", "friday"]));
  });
});

describe("the recorded plans' downloads", () => {
  it.skipIf(!existsSync(PLANS))("every recorded plan: a calendar one street team can follow, and files that match the plan page", () => {
    const plans = recorded();
    expect(plans.length).toBeGreaterThan(0);
    for (const { id, sheet } of plans) {
      expect(calendarProblems(sheet), id).toEqual([]);
      expect(fileProblems(sheet), id).toEqual([]);
    }
  });

  // A one-day sheet (Saturday only) whose Saturday route has no time for two partners: the calendar and partners.csv
  // say to call and arrange, and so do the plan page, the print view and the PDF.
  const oneDay = existsSync(PLANS) ? recorded().find((p) => p.id === "1e0da01d") : undefined;
  it.skipIf(!existsSync(PLANS) || !oneDay)(
    "1e0da01d: the rows say which partners the Saturday route has no time for, and the PDF keeps one page",
    async () => {
      const sheet = oneDay!.sheet;
      const rows = buildSheetModel(sheet).panel2.rows;
      const row = (name: string) => rows.find((r) => r.name === name)!;
      // No time on either pass's route, then on the first pass only.
      expect(row("Pixca Seasonal American Bistro")).toMatchObject({ hours: "10 am to 2 pm; no time left on the route: call to arrange", dayHours: "10 am to 2 pm", routeNote: NO_TIME_ON_ROUTE });
      expect(row("La Parra Restaurant & Bar")).toMatchObject({ hours: "11:30 am to 11 pm; no time left on the first pass: call to arrange", dayHours: "11:30 am to 11 pm" });
      expect(rows.filter((r) => r.routeNote !== "")).toHaveLength(2);
      const pixca = sheet.cards.partners.results.find((p) => p.entity.name === "Pixca Seasonal American Bistro")!;
      expect(partnerHoursColumn(sheet).cell(pixca).withDay).toBe("Sat 10 am to 2 pm; no time left on the route: call to arrange");
      // The PDF says it in the row's Notes column (its hours cell keeps the hours), on one page, Letter and A4.
      for (const pageSize of ["LETTER", "A4"] as const) {
        const res = await renderStreetSheetPdf(sheet, { pageSize });
        expect(res.pages, pageSize).toBe(1);
        const text = pdfPlainText(res.buffer);
        expect(text, pageSize).not.toContain("2 pm; no time left");
        expect(text, pageSize).toContain("No time left on the route: call to arrange");
      }
    },
    60_000,
  );
});
