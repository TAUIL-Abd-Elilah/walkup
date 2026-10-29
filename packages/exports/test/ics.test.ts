import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import {
  escapeIcsText,
  foldLine,
  icsUtc,
  isStreetTeamBlackout,
  planStreetTeam,
  planStreetTeamVisits,
  streetTeamBlackout,
  streetTeamDates,
  streetTeamHolidays,
  streetTeamPasses,
  toIcs,
  type StreetTeamPass,
  type StreetTeamVisit,
} from "../src/ics";
import { formatHours, hoursWeekday, topTiles, weekdayShort } from "../src/format";
import { partnerHoursOn } from "../src/hours";
import { partnerHoursColumn } from "../src/sheet-model";
import { partnersCsv } from "../src/tables";
import { parseCsvObjects } from "./csv-parse";
import { haversineM } from "@walkup/engine";
import { makeHoursSheet, makeMultiStateSheet, makeSheet, partner, place, qlooHours, tile, TILES } from "./helpers";

/** The show week only (the tests of one day's plan). */
const ONE_PASS = { firstPassWeeksOut: 0 } as const;

const enc = new TextEncoder();

/** RFC 5545 unfolding: remove every CRLF followed by one space or tab. */
function unfold(text: string): string[] {
  return text
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter((l) => l !== "");
}

function events(text: string): string[][] {
  const lines = unfold(text);
  const out: string[][] = [];
  let cur: string[] | null = null;
  for (const l of lines) {
    if (l === "BEGIN:VEVENT") cur = [];
    else if (l === "END:VEVENT") {
      if (cur) out.push(cur);
      cur = null;
    } else if (cur) cur.push(l);
  }
  return out;
}

function prop(ev: string[], name: string): string | undefined {
  const line = ev.find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  return line?.slice(line.indexOf(":") + 1);
}

function toMin(hm: string): number {
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\([\\;,])/g, "$1");
}

describe("ICS text helpers", () => {
  it("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    expect(escapeIcsText("x\r\ny\rz")).toBe("x\\ny\\nz");
    expect(escapeIcsText("bell\u0007tab\there")).toBe("belltabhere");
  });

  it("folds at 75 octets with a leading space on continuation lines", () => {
    const exact = "X".repeat(75);
    expect(foldLine(exact)).toBe(exact);
    const long = `DESCRIPTION:${"a".repeat(200)}`;
    const folded = foldLine(long);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(2);
    expect(physical[0]).toHaveLength(75);
    for (const p of physical.slice(1)) expect(p.startsWith(" ")).toBe(true);
    for (const p of physical) expect(enc.encode(p).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("never splits a multi-octet UTF-8 character", () => {
    const long = `SUMMARY:${"é".repeat(60)}${"🎸".repeat(10)}`;
    const physical = foldLine(long).split("\r\n");
    for (const p of physical) {
      expect(enc.encode(p).length).toBeLessThanOrEqual(75);
      expect(p).not.toContain("�");
      expect(Buffer.from(enc.encode(p)).toString("utf8")).toBe(p);
    }
    expect(foldLine(long).replace(/\r\n /g, "")).toBe(long);
  });

  it("formats DTSTAMP in UTC", () => {
    expect(icsUtc("2026-10-09T15:00:00.000Z")).toBe("20261009T150000Z");
  });
});

describe("street-team dates and visits", () => {
  it("takes the last occurrence of each street-team day before the show", () => {
    // Show: Friday 2026-11-20.
    expect(streetTeamDates("2026-11-20", ["thursday", "saturday"])).toEqual([
      { date: "2026-11-14", weekday: "saturday", week: 0 },
      { date: "2026-11-19", weekday: "thursday", week: 0 },
    ]);
    expect(streetTeamDates("2026-11-20", ["friday"])).toEqual([{ date: "2026-11-13", weekday: "friday", week: 0 }]);
  });

  it("repeats for more weeks and skips dates before the plan existed", () => {
    expect(streetTeamDates("2026-11-20", ["thursday"], { weeks: 3 }).map((d) => d.date)).toEqual(["2026-11-05", "2026-11-12", "2026-11-19"]);
    expect(streetTeamDates("2026-11-20", ["thursday"], { weeks: 3, notBefore: "2026-11-10" }).map((d) => d.date)).toEqual(["2026-11-12", "2026-11-19"]);
    expect(streetTeamDates("not-a-date", ["thursday"])).toEqual([]);
  });

  it("puts each partner on a day it is open, and walks the day nearest-first from the venue", () => {
    // Every test partner lists hours for Thursday only ("Thu 10:00-19:00"), so every area moves to Thursday, where
    // its partners are open; the day starts with the area nearest the venue (area 2) and keeps each area together.
    const visits = planStreetTeamVisits(makeSheet(), ONE_PASS);
    expect(visits.map((v) => [v.date, v.start, v.end, v.tileRank, v.partner?.entity.name ?? "flyers"])).toEqual([
      ["2026-11-19", "10:00", "10:20", 2, "Corner Fade Barbers"],
      ["2026-11-19", "10:35", "10:55", 2, "Paper Lantern Books"],
      ["2026-11-19", "11:10", "11:30", 3, "Night Owl Taproom"],
      ["2026-11-19", "11:45", "12:05", 1, "Low Hum Records"],
      ["2026-11-19", "12:20", "12:40", 1, 'Spins, "Wax" & Co.'],
      ["2026-11-19", "12:55", "14:25", 5, "flyers"],
      ["2026-11-19", "14:50", "15:10", 4, "Field Day Cafe"],
    ]);
    expect(visits.every((v) => !v.callFirst && v.pass === "final")).toBe(true);
    expect(visits[0]?.hours).toBe("10:00-19:00");
  });

  it("schedules every stop inside that partner's own hours on that day, on a day it is open", () => {
    const sheet = makeHoursSheet();
    // Both passes are checked here; the exact times below are the show week's.
    for (const v of planStreetTeamVisits(sheet).filter((x) => x.partner && !x.callFirst)) {
      const h = partnerHoursOn(v.partner!, v.weekday, hoursWeekday(sheet));
      expect(h.ranges.some(([a, b]) => toMin(v.start) >= a && toMin(v.end) <= b), `${v.pass} ${v.partner!.entity.name}`).toBe(true);
    }
    const visits = planStreetTeamVisits(sheet, ONE_PASS);
    const listed = hoursWeekday(sheet);
    for (const v of visits.filter((x) => x.partner && !x.callFirst)) {
      const h = partnerHoursOn(v.partner!, v.weekday, listed);
      expect(h.status, v.partner!.entity.name).toBe("open");
      const [s, e] = [toMin(v.start), toMin(v.end)];
      expect(h.ranges.some(([a, b]) => s >= a && e <= b), `${v.partner!.entity.name} ${v.weekday} ${v.start}-${v.end}`).toBe(true);
    }
    const at = (name: string) => visits.filter((v) => v.partner?.entity.name === name).map((v) => [v.weekday, v.start, v.end]);
    // Open Thursday evening only (closed Saturday): an evening stop on Thursday, not 10:00.
    expect(at("Evening Records")).toEqual([["thursday", "17:00", "17:20"]]);
    // Closed Thursday, open Saturday 20:00-02:00: moved to Saturday night.
    expect(at("Late Bar Books")).toEqual([["saturday", "20:00", "20:20"]]);
    // Open Thursday 07:30-09:00 only: still visited while open, before the 10:00 day start.
    expect(at("Early Bakery")).toEqual([["thursday", "07:30", "07:50"]]);
    // A two-part day (10:00-14:00, 17:00-21:30): inside one of the parts.
    expect(at("Split Shift Diner")).toHaveLength(1);
  });

  it("marks unknown hours 'call first' and leaves out, with a note, a partner closed every street-team day", () => {
    const sheet = makeHoursSheet();
    const visits = planStreetTeamVisits(sheet, ONE_PASS);
    const unknown = visits.find((v) => v.partner?.entity.name === "No Hours Cafe")!;
    expect(unknown.callFirst).toBe(true);
    expect(unknown.hours).toBeNull();
    expect(visits.some((v) => v.partner?.entity.name === "Always Shut Shop")).toBe(false);
    const noted = visits.filter((v) => v.closedAllDays.length > 0);
    expect(noted).toHaveLength(1);
    expect(noted[0]!.closedAllDays.map((p) => p.entity.name)).toEqual(["Always Shut Shop"]);
    const text = toIcs(sheet, ONE_PASS);
    const evs = events(text);
    const summaries = evs.map((e) => unescapeText(prop(e, "SUMMARY") ?? ""));
    expect(summaries).toContain("Street team: No Hours Cafe (area 1, East Bank, TN), call first");
    expect(summaries.some((x) => x.includes("Always Shut Shop"))).toBe(false);
    const all = evs.map((e) => unescapeText(prop(e, "DESCRIPTION") ?? "")).join("\n");
    expect(all).toContain("Hours for Thu not listed: call first.");
    expect(all).toContain("Not scheduled, closed on Thu and Sat: Always Shut Shop.");
    // The description gives the hours of the day of the stop, not of the first street-team day.
    const late = evs.find((e) => (prop(e, "SUMMARY") ?? "").includes("Late Bar Books"))!;
    expect(unescapeText(prop(late, "DESCRIPTION") ?? "")).toContain("Open Sat 8 pm to 2 am.");
  });

  it("gives an area whose partners are all closed on the street-team days a flyer drop that says so", () => {
    const sheet = makeHoursSheet();
    sheet.cards.partners.results = sheet.cards.partners.results.filter((p) => p.entity.name === "Always Shut Shop");
    const visits = planStreetTeamVisits(sheet, ONE_PASS);
    const area1 = visits.filter((v) => v.tileRank === 1);
    expect(area1).toHaveLength(1);
    expect(area1[0]).toMatchObject({ partner: null, callFirst: false });
    expect(area1[0]!.closedAllDays.map((p) => p.entity.name)).toEqual(["Always Shut Shop"]);
    // Once per pass: the first pass's flyer drop says it too.
    expect(planStreetTeamVisits(sheet).filter((v) => v.closedAllDays.length > 0).map((v) => v.pass)).toEqual(["first", "final"]);
    const desc = unescapeText(prop(events(toIcs(sheet, ONE_PASS)).find((e) => (prop(e, "SUMMARY") ?? "").includes("area 1"))!, "DESCRIPTION") ?? "");
    expect(desc).toContain("Every partner listed here is closed on Thu and Sat: flyer drop only.");
  });

  it("uses the streetTeamDays option over the sheet's days", () => {
    const visits = planStreetTeamVisits(makeSheet(), { streetTeamDays: ["wednesday"], ...ONE_PASS });
    expect(new Set(visits.map((v) => v.date))).toEqual(new Set(["2026-11-18"]));
    // Six partners (hours not listed for Wednesday: call first) and the flyer drop for the area without partners.
    expect(visits).toHaveLength(7);
    expect(visits.filter((v) => v.partner).every((v) => v.callFirst)).toBe(true);
  });

  it("keeps a crowded day before midnight: no stop on top of another, and the stops with no time left listed", () => {
    // From 20:00, six 20-minute stops and a 90-minute flyer drop don't fit before midnight.
    const visits = planStreetTeamVisits(makeSheet(), { streetTeamDays: ["monday"], startTime: "20:00", ...ONE_PASS });
    const notTimed = visits.flatMap((v) => v.notTimed);
    expect(visits.length + notTimed.length).toBe(7);
    expect(notTimed.length).toBeGreaterThan(0);
    for (const v of visits) expect(v.end <= "23:59" && v.start < v.end, `${v.start}-${v.end}`).toBe(true);
    expect(overlaps(visits)).toEqual([]);
    // Said once, on the day's earliest event, with what to do.
    expect(visits.filter((v) => v.notTimed.length > 0)).toEqual([visits[0]]);
    const desc = (startTime: string) => unescapeText(prop(events(toIcs(makeSheet(), { streetTeamDays: ["monday"], startTime, ...ONE_PASS }))[0]!, "DESCRIPTION") ?? "");
    expect(desc("20:00")).toContain("No time left on the Mon Nov 16 2026 route for: the flyer drop in area 5, Inglewood, MA. Do the flyer drop another day.");
    // A partner is named with what the street team needs to call it: its area, address and that day's hours.
    expect(desc("21:00")).toContain(
      "No time left on the Mon Nov 16 2026 route for: Field Day Cafe (area 4, Woodbine), 106 Example St, Nashville, TN, hours for Mon not listed; the flyer drop in area 5, Inglewood, MA. Call the partners to arrange a drop-off, and do the flyer drop, another day.",
    );
    // The call list keeps the partner's day and says the route had no time for it.
    const csv = parseCsvObjects(partnersCsv(makeSheet(), { visits: { streetTeamDays: ["monday"], startTime: "21:00", ...ONE_PASS } }));
    expect(csv.find((r) => r.name === "Field Day Cafe")).toMatchObject({ day: "Mon", visit_dates: "2026-11-16 (no time left on the route: call to arrange)" });
  });

  it("says a stop with no time left on a day with nothing timed, in an all-day event of that day", () => {
    // One street-team day (Saturday), no numbered area, and one partner open only Saturday 23:45 to 2 am: a 10-minute
    // final-pass stop fits before midnight, a 20-minute first-pass stop does not, so the first pass times nothing.
    const s = makeSheet();
    s.operator = { ...s.operator, streetTeamDays: ["saturday"] };
    s.cards.liftMap.results.tiles = s.cards.liftMap.results.tiles.map((t) => ({ ...t, lift: 1.1 }));
    const p = partner(1, "Low Hum Records", null, { entity: place("syn-place-1", "Low Hum Records", { properties: { hours: qlooHours({ saturday: [["23:45", "02:00"]] }) } }) });
    s.cards.partners.results = [p];
    const plan = planStreetTeam(s);
    expect(plan.visits.map((v) => `${v.pass} ${v.date} ${v.start}-${v.end}`)).toEqual(["final 2026-11-14 23:45-23:55"]);
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toMatchObject({ pass: "first", date: "2026-10-24", weekday: "saturday", closedAllDays: [] });
    expect(plan.notes[0]!.notTimed.map((x) => `${x.date} ${x.partner?.entity.name}`)).toEqual(["2026-10-24 Low Hum Records"]);
    const ev = events(toIcs(s)).find((e) => prop(e, "DTSTART;VALUE=DATE") === "20261024")!;
    expect(unescapeText(prop(ev, "SUMMARY") ?? "")).toBe("Street team, first pass: no time left for 1 stop");
    expect(prop(ev, "TRANSP")).toBe("TRANSPARENT");
    expect(unescapeText(prop(ev, "DESCRIPTION") ?? "")).toContain(
      "No time left on the Sat Oct 24 2026 route for: Low Hum Records (near Example Hall), 101 Example St, Nashville, TN, (615) 555-0101, open Sat 11:45 pm to 2 am. Call to arrange a drop-off another day.",
    );
    // The call list marks that date too.
    const row = parseCsvObjects(partnersCsv(s)).find((r) => r.name === "Low Hum Records")!;
    expect(row.visit_dates).toBe("2026-10-24 (no time left on the route: call to arrange); 2026-11-14");
    // With the show week only, nothing is timed at all: the note and the show are the whole calendar.
    const only = planStreetTeam(s, ONE_PASS);
    expect(only.visits).toEqual([]);
    expect(only.notes.map((n) => n.date)).toEqual(["2026-11-14"]);
    expect(events(toIcs(s, ONE_PASS)).map((e) => unescapeText(prop(e, "SUMMARY") ?? ""))).toEqual([
      "Street team: no time left for 1 stop",
      "Show: Juniper Wire, The Lantern Choir, Mesa Static at Example Hall",
    ]);
  });

  it("says a partner outside the numbered areas closed on every street-team day, in each pass", () => {
    const sheet = makeSheet();
    const p0 = sheet.cards.partners.results[0]!;
    const far = { ...p0, entity: { ...p0.entity, entityId: "syn-place-9", name: "Far Field Records", properties: { hours: qlooHours({ monday: [["09:00", "17:00"]] }) } }, tileGeohash: TILES[7]!.geohash, tileName: "Far South" };
    sheet.cards.partners.results = [...sheet.cards.partners.results, far];
    const visits = planStreetTeamVisits(sheet);
    expect(visits.some((v) => v.partner?.entity.name === "Far Field Records")).toBe(false);
    expect(visits.flatMap((v) => v.closedAllDays.map((c) => `${v.pass} ${c.entity.name}`))).toEqual(["first Far Field Records", "final Far Field Records"]);
    const all = events(toIcs(sheet)).map((e) => unescapeText(prop(e, "DESCRIPTION") ?? "")).join("\n");
    expect(all).toContain("Not scheduled, closed on Thu and Sat: Far Field Records.");
  });

  it("never runs a stop past midnight, even from a late start", () => {
    const late = planStreetTeamVisits(makeSheet(), { streetTeamDays: ["monday"], startTime: "23:50", maxTiles: 8, minLift: 0 });
    expect(late.length + late.flatMap((v) => v.notTimed).length).toBeGreaterThan(6);
    for (const v of late) {
      expect(v.start < "24:00" && v.end <= "23:59" && v.start < v.end, `${v.start}-${v.end}`).toBe(true);
    }
    expect(overlaps(late)).toEqual([]);
    const text = toIcs(makeSheet(), { streetTeamDays: ["monday"], startTime: "23:30" });
    const times = unfold(text).filter((l) => /^DT(START|END):\d{8}T/.test(l)).map((l) => l.slice(l.indexOf("T", 8) + 1));
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(Number(t.slice(0, 2))).toBeLessThan(24);
  });

  it("visits the partners near the venue when no tile reaches the lift floor, spread over the days", () => {
    const visits = planStreetTeamVisits(makeSheet(), { minLift: 9, ...ONE_PASS });
    expect(visits).toHaveLength(6);
    expect(visits.every((v) => v.tileRank === null && v.partners.length === 1)).toBe(true);
    // Thursday is the only day with listed hours, so every stop lands there.
    expect(new Set(visits.map((v) => v.weekday))).toEqual(new Set(["thursday"]));
  });

  it("puts partners outside the numbered areas on the calendar too", () => {
    const sheet = makeSheet();
    sheet.cards.partners.results = [...sheet.cards.partners.results, { ...sheet.cards.partners.results[0]!, entity: { ...sheet.cards.partners.results[0]!.entity, entityId: "syn-place-9", name: "Far Field Records" }, tileGeohash: TILES[7]!.geohash, tileName: "Far South" }];
    const v = planStreetTeamVisits(sheet).find((x) => x.partner?.entity.name === "Far Field Records")!;
    expect(v).toMatchObject({ tileRank: null, weekday: "thursday" });
    const ev = events(toIcs(sheet, ONE_PASS)).find((e) => (prop(e, "SUMMARY") ?? "").includes("Far Field Records"))!;
    expect(unescapeText(prop(ev, "SUMMARY") ?? "")).toBe("Street team: Far Field Records (Far South, TN)");
  });
});

describe("street-team calendar area labels", () => {
  it("names each area with its own place and state, never the venue's city (DC room, MD and VA areas)", () => {
    const text = toIcs(makeMultiStateSheet(), ONE_PASS);
    const evs = events(text).filter((e) => (prop(e, "CATEGORIES") ?? "") === "Street team");
    const summaries = evs.map((e) => unescapeText(prop(e, "SUMMARY") ?? ""));
    expect(summaries).toEqual(
      expect.arrayContaining([
        "Street team: Corner Press Books (area 1, Silver Spring, MD)",
        "Street team: Lantern Coffee (area 2, Arlington, VA)",
        "Street team: Eastern Market Records (area 3, Capitol Hill, DC)",
        "Street team: Riverside Barbers (Takoma Park, MD)",
      ]),
    );
    const descs = evs.map((e) => unescapeText(prop(e, "DESCRIPTION") ?? ""));
    expect(descs.some((d) => d.includes("Area 1 of 3: Silver Spring, MD, ZIP 20910, 20012."))).toBe(true);
    expect(descs.some((d) => d.includes("Area 2 of 3: Arlington, VA, ZIP 22201, 22209."))).toBe(true);
    for (const e of evs) expect(unescapeText(`${prop(e, "SUMMARY")} ${prop(e, "LOCATION")}`)).not.toMatch(/Washington/);
    // The show itself is at the venue, in the venue's city.
    expect(unescapeText(prop(events(text).at(-1)!, "LOCATION") ?? "")).toBe("Example Hall, Washington, DC");
  });
});

describe("toIcs", () => {
  const sheet = makeSheet();
  // The show week only, so the event list stays short; the two passes have their own tests.
  const text = toIcs(sheet, ONE_PASS);

  it("uses CRLF line endings throughout and ends with CRLF", () => {
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("keeps every physical line within 75 octets", () => {
    for (const line of text.split("\r\n")) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
    expect(text).toMatch(/\r\n /); // descriptions are long enough to fold
  });

  it("has the required calendar and event properties, balanced", () => {
    const lines = unfold(text);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines.some((l) => l.startsWith("PRODID:"))).toBe(true);
    expect(lines.filter((l) => l === "BEGIN:VEVENT").length).toBe(lines.filter((l) => l === "END:VEVENT").length);
    const evs = events(text);
    expect(evs).toHaveLength(8); // 6 partner stops, 1 flyer drop (area 5 has no partners) + the show
    for (const ev of evs) {
      for (const p of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY"]) expect(prop(ev, p), p).toBeTruthy();
      expect(prop(ev, "DTSTAMP")).toBe("20261009T150000Z");
    }
  });

  it("writes floating local times by default (no TZID, no Z)", () => {
    const first = events(text)[0]!;
    expect(first).toContain("DTSTART:20261119T100000");
    expect(first).toContain("DTEND:20261119T102000");
    expect(text).not.toContain("TZID");
    expect(text).not.toContain("VTIMEZONE");
  });

  it("pins times to a supported zone with a VTIMEZONE", () => {
    const tz = toIcs(sheet, { timeZone: "America/Chicago", ...ONE_PASS });
    const lines = unfold(tz);
    expect(lines).toContain("BEGIN:VTIMEZONE");
    expect(lines).toContain("TZID:America/Chicago");
    expect(lines).toContain("TZOFFSETTO:-0500");
    expect(lines).toContain("TZOFFSETTO:-0600");
    expect(events(tz)[0]).toContain("DTSTART;TZID=America/Chicago:20261119T100000");
    // Unknown zones fall back to floating times rather than inventing rules.
    expect(toIcs(sheet, { timeZone: "Mars/Olympus" })).not.toContain("TZID");
  });

  it("uses the venue's own time zone from the sheet when no zone is passed", () => {
    const zoned = { ...sheet, bill: { ...sheet.bill, venue: { ...sheet.bill.venue, timeZone: "America/Chicago" } } };
    expect(events(toIcs(zoned, ONE_PASS))[0]).toContain("DTSTART;TZID=America/Chicago:20261119T100000");
    // The caller's zone still wins.
    expect(events(toIcs(zoned, { timeZone: "America/New_York", ...ONE_PASS }))[0]).toContain("DTSTART;TZID=America/New_York:20261119T100000");
  });

  it("gives stable, unique UIDs", () => {
    const uids = events(text).map((e) => prop(e, "UID"));
    expect(new Set(uids).size).toBe(uids.length);
    expect(events(toIcs(sheet, ONE_PASS)).map((e) => prop(e, "UID"))).toEqual(uids);
    expect(uids[0]).toBe(`hl-test-plan-1-20261119-${TILES[1]!.geohash}-syn-place-3@walkup`);
    expect(uids).toContain(`hl-test-plan-1-20261119-${TILES[4]!.geohash}-flyers@walkup`);
    expect(uids).toContain(`hl-test-plan-1-20261119-${TILES[0]!.geohash}-syn-place-1@walkup`);
    // Two passes: the same stop on two dates, two UIDs.
    const both = events(toIcs(sheet)).map((e) => prop(e, "UID")!);
    expect(new Set(both).size).toBe(both.length);
    expect(both.filter((u) => u.endsWith(`-${TILES[0]!.geohash}-syn-place-1@walkup`))).toHaveLength(2);
  });

  it("escapes text and describes each stop: the area, the partner, its hours that day", () => {
    const evs = events(text);
    expect(evs.map((e) => prop(e, "SUMMARY"))).toContain("Street team: area 5\\, Inglewood\\, MA\\, flyer drop");
    const stop = evs.find((e) => (prop(e, "SUMMARY") ?? "").includes("Low Hum Records"))!;
    expect(prop(stop, "SUMMARY")).toBe("Street team: Low Hum Records (area 1\\, East Bank\\, TN)");
    // The partner's own address, not the venue's city.
    expect(prop(stop, "LOCATION")).toBe("Low Hum Records\\, 101 Example St\\, Nashville\\, TN");
    expect(prop(stop, "GEO")).toBe("36.175000;-86.750000");
    const desc = unescapeText(prop(stop, "DESCRIPTION") ?? "");
    expect(desc).toContain("Area 1 of 5: East Bank, TN, ZIP 37206. About 2.1 times the room's usual crowd.");
    expect(desc).not.toMatch(/geohash|over-index|\dx\b/);
    expect(desc).toContain("Suggested, not affiliated: no partner has agreed to anything.");
    expect(desc).toContain("Low Hum Records (Record store)");
    expect(desc).toContain("Open Thu 10 am to 7 pm.");
    expect(desc).toContain("(615) 555-0101");
    const spins = evs.find((e) => (prop(e, "SUMMARY") ?? "").includes("Spins"))!;
    expect(prop(spins, "SUMMARY")).toBe('Street team: Spins\\, "Wax" & Co. (area 1\\, East Bank\\, TN)');
  });

  it("adds the show as an all-day event, or a timed one with showStartTime", () => {
    const show = events(text).at(-1)!;
    expect(show).toContain("DTSTART;VALUE=DATE:20261120");
    expect(show).toContain("DTEND;VALUE=DATE:20261121");
    const timed = events(toIcs(sheet, { showStartTime: "22:30", showMinutes: 120, ...ONE_PASS })).at(-1)!;
    expect(timed).toContain("DTSTART:20261120T223000");
    expect(timed).toContain("DTEND:20261121T003000");
    // Ticketmaster's localTime carries seconds.
    expect(events(toIcs(sheet, { showStartTime: "22:30:00", showMinutes: 120, ...ONE_PASS })).at(-1)!).toContain("DTSTART:20261120T223000");
    expect(events(toIcs(sheet, { includeShow: false, ...ONE_PASS }))).toHaveLength(7);
  });

  it("still produces a valid calendar with no street-team days", () => {
    const evs = events(toIcs(makeSheet({ operator: { ...sheet.operator, streetTeamDays: [] } }), { includeShow: false }));
    expect(evs).toHaveLength(1);
    expect(prop(evs[0]!, "SUMMARY")).toContain("Show:");
  });

  it("marks fixture sheets in every summary", () => {
    const fx = toIcs(makeSheet({ mode: "fixture" }));
    for (const ev of events(fx)) expect(prop(ev, "SUMMARY")?.startsWith("[Sample] ")).toBe(true);
    expect(unescapeText(prop(events(fx)[0]!, "DESCRIPTION") ?? "")).toContain("Sample data: made-up places and numbers, not a live run.");
  });
});

/** Minutes after midnight of "HH:MM". */
function overlaps(visits: readonly StreetTeamVisit[]): string[] {
  const out: string[] = [];
  const byDate = new Map<string, StreetTeamVisit[]>();
  for (const v of visits) byDate.set(v.date, [...(byDate.get(v.date) ?? []), v]);
  for (const [date, vs] of byDate) {
    const sorted = [...vs].sort((a, b) => toMin(a.start) - toMin(b.start));
    for (let i = 1; i < sorted.length; i++) if (toMin(sorted[i]!.start) < toMin(sorted[i - 1]!.end)) out.push(`${date} ${sorted[i - 1]!.start} ${sorted[i]!.start}`);
  }
  return out;
}

/**
 * A room with five areas in two parts of town (three to the north, two to the south) and two partners in each,
 * every partner placed in its area and open Thursday and Saturday. With `oddHours`, one partner in area 3 keeps
 * different hours on each day.
 * Every name, place and number is invented.
 */
function makeTownSheet(oddHours = true) {
  const s = makeSheet();
  const venue = { lat: 36.16, lon: -86.78 };
  const tiles = [
    tile(36.3, -86.78, 2.4, { name: "North One", zctas: ["37201"] }),
    tile(36.02, -86.78, 2.2, { name: "South One", zctas: ["37202"] }),
    tile(36.34, -86.7, 2.0, { name: "North Two", zctas: ["37204"] }),
    tile(35.98, -86.7, 1.8, { name: "South Two", zctas: ["37205"] }),
    tile(36.38, -86.62, 1.6, { name: "North Three", zctas: ["37207"] }),
  ];
  const both = qlooHours({ thursday: [["09:00", "21:00"]], saturday: [["09:00", "21:00"]] });
  const ps = tiles.flatMap((t, i) =>
    [0, 1].map((k) => {
      const p = partner(10 + i * 2 + k, `Place ${i + 1}${k === 0 ? "a" : "b"}`, null, { hoursOnDay: "09:00-21:00" });
      const hours = oddHours && i === 2 && k === 1 ? qlooHours({ thursday: [["10:00", "12:00"]], saturday: [["15:00", "19:00"]] }) : both;
      return { ...p, tileGeohash: t.geohash, tileName: t.name, entity: { ...p.entity, location: { lat: t.lat + 0.004 * (k + 1), lon: t.lon + 0.003 * k }, properties: { hours } } };
    }),
  );
  return {
    ...s,
    bill: { ...s.bill, venue: { ...s.bill.venue, ...venue } },
    cards: {
      ...s.cards,
      liftMap: { ...s.cards.liftMap, results: { ...s.cards.liftMap.results, tiles } },
      partners: { ...s.cards.partners, results: ps },
    },
    budgetSplit: tiles.map((t, i) => ({ geohash: t.geohash, share: [0.3, 0.25, 0.2, 0.15, 0.1][i]!, label: "heuristic, not a forecast" as const })),
  };
}

describe("street-team passes", () => {
  it("runs a first pass 22-28 days out and a final pass in the show week", () => {
    // Show: Friday 2026-11-20.
    expect(streetTeamPasses("2026-11-20", ["thursday", "saturday"])).toEqual([
      { date: "2026-10-24", weekday: "saturday", pass: "first" },
      { date: "2026-10-29", weekday: "thursday", pass: "first" },
      { date: "2026-11-14", weekday: "saturday", pass: "final" },
      { date: "2026-11-19", weekday: "thursday", pass: "final" },
    ]);
    expect(streetTeamPasses("2026-11-20", ["thursday"], { firstPassWeeksOut: 3 }).map((d) => d.date)).toEqual(["2026-11-05", "2026-11-19"]);
    expect(streetTeamPasses("2026-11-20", ["thursday"], { firstPassWeeksOut: 0 }).map((d) => d.date)).toEqual(["2026-11-19"]);
    expect(streetTeamPasses("2026-11-20", [])).toEqual([]);
    expect(streetTeamPasses("not-a-date", ["thursday"])).toEqual([]);
  });

  it("never schedules before the plan existed: the first pass moves closer, or there is only the final pass", () => {
    // Made Nov 1: 22-28 days out (Oct 24, 29) and 15-21 days out (Oct 31, Nov 5) are not whole, so 8-14 days out.
    expect(streetTeamPasses("2026-11-20", ["thursday", "saturday"], { notBefore: "2026-11-01" }).map((d) => `${d.pass} ${d.date}`)).toEqual([
      "first 2026-11-07",
      "first 2026-11-12",
      "final 2026-11-14",
      "final 2026-11-19",
    ]);
    // Made Nov 16: only the show week's Thursday is left.
    expect(streetTeamPasses("2026-11-20", ["thursday", "saturday"], { notBefore: "2026-11-16" }).map((d) => `${d.pass} ${d.date}`)).toEqual(["final 2026-11-19"]);
    const late = makeSheet({ createdAt: "2026-11-16T09:00:00.000Z" });
    const visits = planStreetTeamVisits(late);
    expect(visits.length).toBeGreaterThan(0);
    expect(visits.every((v) => v.date >= "2026-11-16" && v.pass === "final")).toBe(true);
    // One pass: the summaries don't name a pass.
    expect(events(toIcs(late)).every((e) => !(prop(e, "SUMMARY") ?? "").includes("pass"))).toBe(true);
  });

  it("sends no one out on a holiday: Christmas Eve, New Year's Eve and Day, Thanksgiving", () => {
    expect(streetTeamBlackout("2026-12-24")).toBe("Christmas Eve");
    expect(streetTeamBlackout("2026-11-26")).toBe("Thanksgiving");
    expect(streetTeamBlackout("2026-11-19")).toBeNull();
    expect(streetTeamBlackout("2026-12-26")).toBeNull();
    // A Wednesday Dec 30 show: the final pass's Thursday (Christmas Eve) moves to the Thursday before, Dec 17.
    const dec30 = streetTeamPasses("2026-12-30", ["thursday", "saturday"], { notBefore: "2026-10-28" });
    expect(dec30.map((d) => `${d.pass} ${d.date}`)).toEqual(["first 2026-12-03", "first 2026-12-05", "final 2026-12-17", "final 2026-12-26"]);
    expect(dec30[2]!.insteadOf).toEqual({ date: "2026-12-24", holiday: "Christmas Eve" });
    // A Friday Jan 15 show: the first pass's Christmas Eve moves to Dec 17 too; both passes keep Thursday and Saturday.
    const jan15 = streetTeamPasses("2027-01-15", ["thursday", "saturday"], { notBefore: "2026-10-28" });
    expect(jan15.map((d) => d.date)).not.toContain("2026-12-24");
    expect(jan15.map((d) => `${d.pass} ${d.date} ${d.weekday}`)).toEqual([
      "first 2026-12-17 thursday",
      "first 2026-12-19 saturday",
      "final 2027-01-09 saturday",
      "final 2027-01-14 thursday",
    ]);
    expect(streetTeamHolidays("2027-01-15", ["thursday", "saturday"], { notBefore: "2026-10-28" })).toEqual([
      { date: "2026-12-24", weekday: "thursday", pass: "first", holiday: "Christmas Eve", movedTo: "2026-12-17" },
    ]);
    // Thanksgiving moves a week back; a day before the plan existed is never used.
    expect(streetTeamPasses("2026-12-19", ["thursday"], { notBefore: "2026-10-17" }).map((d) => d.date)).toEqual(["2026-11-19", "2026-12-17"]);
  });

  it("moves a holiday's stops to the same weekday a week earlier: both passes keep their days, each partner its weekday", () => {
    for (const [date, weekday] of [
      ["2026-12-30", "wednesday"],
      ["2027-01-15", "friday"],
    ] as const) {
      const s = makeTownSheet();
      s.createdAt = "2026-10-28T12:00:00.000Z";
      s.bill = { ...s.bill, date, weekday };
      const visits = planStreetTeamVisits(s);
      expect(visits.some((v) => isStreetTeamBlackout(v.date)), date).toBe(false);
      // Each pass covers Thursday and Saturday, and a partner is visited on the same weekday in both passes.
      for (const pass of ["first", "final"] as const) expect(new Set(visits.filter((v) => v.pass === pass).map((v) => v.weekday)), `${date} ${pass}`).toEqual(new Set(["thursday", "saturday"]));
      const days = new Map<string, Set<string>>();
      for (const v of visits) if (v.partner) days.set(v.partner.entity.entityId, new Set([...(days.get(v.partner.entity.entityId) ?? []), v.weekday]));
      for (const [id, d] of days) expect(d.size, `${date} ${id}`).toBe(1);
      // The day is doable: no two stops overlap, and none is cut off at midnight.
      expect(overlaps(visits), date).toEqual([]);
      expect(visits.filter((v) => v.end === "23:59"), date).toEqual([]);
      // The paper's Visit day cell and partners.csv name the calendar's weekday and that day's hours.
      const col = partnerHoursColumn(s);
      for (const v of visits.filter((x) => x.partner && x.hours)) expect(col.cell(v.partner!).hours, `${date} ${v.partner!.entity.name}`).toBe(`${weekdayShort(v.weekday)} ${formatHours(v.hours!)}`);
    }
  });

  it("says on the calendar where a holiday's stops went, and names only the pass's own days", () => {
    const s = makeHoursSheet();
    s.createdAt = "2026-10-28T12:00:00.000Z";
    s.bill = { ...s.bill, date: "2026-12-30", weekday: "wednesday" };
    const visits = planStreetTeamVisits(s);
    expect(visits.some((v) => v.date === "2026-12-24")).toBe(false);
    expect([...new Set(visits.filter((v) => v.pass === "final").map((v) => v.date))].sort()).toEqual(["2026-12-17", "2026-12-26"]);
    const finals = events(toIcs(s)).filter((e) => (prop(e, "SUMMARY") ?? "").includes("final pass"));
    const desc = finals.map((e) => unescapeText(prop(e, "DESCRIPTION") ?? ""));
    expect(desc.filter((d) => d.includes("No street team on Thu Dec 24 2026 (Christmas Eve): shops keep holiday hours. Its stops are on Thu Dec 17 2026 instead."))).toHaveLength(1);
    // Dec 17 is 13 days out, so its stops don't claim to be in the show week.
    expect(desc.some((d) => d.startsWith("Final pass, 2 weeks out:"))).toBe(true);
    expect(desc.join("\n")).not.toMatch(/closed on Sat: [^\n]*Evening Records/);

    // Made Dec 13: the first pass is Dec 17 and 19, so the final pass's Christmas Eve has no free Thursday before it.
    // Its stops move to Wed Dec 23, the nearest free day of its week: the final pass keeps two days.
    const late = makeHoursSheet();
    late.createdAt = "2026-12-13T12:00:00.000Z";
    late.bill = { ...late.bill, date: "2026-12-30", weekday: "wednesday" };
    expect(streetTeamHolidays(late.bill.date, ["thursday", "saturday"], { notBefore: "2026-12-13" })).toEqual([
      { date: "2026-12-24", weekday: "thursday", pass: "final", holiday: "Christmas Eve", movedTo: "2026-12-23" },
    ]);
    expect(streetTeamPasses(late.bill.date, ["thursday", "saturday"], { notBefore: "2026-12-13" }).map((d) => `${d.pass} ${d.date} ${d.weekday}`)).toEqual([
      "first 2026-12-17 thursday",
      "first 2026-12-19 saturday",
      "final 2026-12-23 wednesday",
      "final 2026-12-26 saturday",
    ]);
    const lateVisits = planStreetTeamVisits(late);
    expect([...new Set(lateVisits.filter((v) => v.pass === "final").map((v) => v.date))].sort()).toEqual(["2026-12-23", "2026-12-26"]);
    expect(lateVisits.some((v) => isStreetTeamBlackout(v.date))).toBe(false);
    expect(overlaps(lateVisits)).toEqual([]);
    expect(lateVisits.filter((v) => v.end === "23:59")).toEqual([]);
    const lateDesc = events(toIcs(late))
      .filter((e) => (prop(e, "SUMMARY") ?? "").includes("final pass"))
      .map((e) => unescapeText(prop(e, "DESCRIPTION") ?? ""));
    expect(lateDesc.filter((d) => d.includes("No street team on Thu Dec 24 2026 (Christmas Eve): shops keep holiday hours. Its stops are on Wed Dec 23 2026 instead."))).toHaveLength(1);
    // Evening Records is open on Thursday and Friday only: in a final pass of Wednesday and Saturday it is closed on
    // "Wed and Sat", the pass's own days, not "Thu and Sat".
    const all = lateDesc.join("\n");
    expect(all).toMatch(/Not scheduled, closed on Wed and Sat: [^\n]*Evening Records/);
    expect(all).not.toContain("closed on Thu and Sat: Evening Records");
    // Split Shift Diner's area stays on its own run day, Saturday, in both passes: moving the area to Thursday would
    // take that day past one and a half times its share of stops. (A partner the passes visit on two weekdays is
    // covered below.)
    const col = partnerHoursColumn(late);
    const diner = lateVisits.filter((v) => v.partner?.entity.name === "Split Shift Diner");
    expect(diner.map((v) => `${v.pass} ${v.weekday}`)).toEqual(["first saturday", "final saturday"]);
    expect(col.cell(diner[0]!.partner!).hours).toBe("Sat 10 am to 2 pm, 5 pm to 9:30 pm");

    // Only when every day of the week is taken does a pass go a day short, and the calendar says so.
    const every = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
    expect(streetTeamHolidays("2026-12-30", every, { notBefore: "2026-12-13" }).map((x) => `${x.date} ${x.movedTo}`)).toEqual(["2026-12-24 null", "2026-12-25 null"]);
    const full = makeHoursSheet();
    full.createdAt = "2026-12-13T12:00:00.000Z";
    full.bill = { ...full.bill, date: "2026-12-30", weekday: "wednesday" };
    full.operator = { ...full.operator, streetTeamDays: [...every] };
    const fullDesc = events(toIcs(full)).map((e) => unescapeText(prop(e, "DESCRIPTION") ?? ""));
    expect(fullDesc.filter((d) => d.includes("(Christmas Eve): shops keep holiday hours. Its stops are on the pass's other days."))).toHaveLength(1);
  });

  it("moves a holiday it can't move a week back to the nearest free day of its week: the passes keep their size", () => {
    // Every partner open Wednesday, Thursday and Saturday; made Dec 13 for a Dec 30 show (first pass Dec 17 and 19).
    const s = makeTownSheet(false);
    const week = qlooHours({ wednesday: [["09:00", "21:00"]], thursday: [["09:00", "21:00"]], saturday: [["09:00", "21:00"]] });
    s.cards.partners.results = s.cards.partners.results.map((p) => ({ ...p, entity: { ...p.entity, properties: { hours: week } } }));
    s.createdAt = "2026-12-13T12:00:00.000Z";
    s.bill = { ...s.bill, date: "2026-12-30", weekday: "wednesday" };
    const visits = planStreetTeamVisits(s);
    const perDay = (pass: StreetTeamPass) => [...new Set(visits.filter((v) => v.pass === pass).map((v) => v.date))].sort().map((d) => `${d} ${visits.filter((v) => v.date === d).length}`);
    expect(perDay("first")).toEqual(["2026-12-17 6", "2026-12-19 4"]);
    // The final pass has the same two runs: Christmas Eve's on Wed Dec 23, not piled onto Saturday.
    expect(perDay("final")).toEqual(["2026-12-23 6", "2026-12-26 4"]);
    expect(overlaps(visits)).toEqual([]);
    expect(visits.filter((v) => v.end === "23:59")).toEqual([]);
    // A partner the first pass visits on Thursday is visited on Wednesday in the final pass, and the Visit day cell
    // names both days, each with its hours.
    const thu = visits.find((v) => v.pass === "first" && v.weekday === "thursday")!.partner!;
    expect(visits.filter((v) => v.partner?.entity.entityId === thu.entity.entityId).map((v) => `${v.pass} ${v.weekday}`)).toEqual(["first thursday", "final wednesday"]);
    expect(partnerHoursColumn(s).cell(thu).hours).toBe("Thu 9 am to 9 pm; Wed 9 am to 9 pm");
    const desc = events(toIcs(s)).map((e) => unescapeText(prop(e, "DESCRIPTION") ?? ""));
    expect(desc.filter((d) => d.includes("No street team on Thu Dec 24 2026 (Christmas Eve): shops keep holiday hours. Its stops are on Wed Dec 23 2026 instead."))).toHaveLength(1);
  });

  it("moves a stop its day has no time left for to another street-team day where it fits, the same weekday in both passes", () => {
    // Six partners in the north area, open Saturday 10:00-12:30 only and Thursday all day; two in the south area.
    // Saturday's short morning holds four 20-minute stops with travel: the other two go to Thursday, not on top of them.
    const s = makeSheet();
    const tiles = [tile(36.3, -86.78, 2.4, { name: "North One", zctas: ["37201"] }), tile(36.02, -86.78, 2.2, { name: "South One", zctas: ["37202"] })];
    const week = qlooHours({ thursday: [["09:00", "21:00"]], saturday: [["10:00", "12:30"]] });
    const ps = Array.from({ length: 8 }, (_, k) => {
      const t = tiles[k < 6 ? 0 : 1]!;
      const p = partner(40 + k, `Place ${k + 1}`, null, { hoursOnDay: "09:00-21:00" });
      return { ...p, tileGeohash: t.geohash, tileName: t.name, entity: { ...p.entity, location: { lat: t.lat + 0.003 * k, lon: t.lon }, properties: { hours: week } } };
    });
    const sheet = {
      ...s,
      bill: { ...s.bill, venue: { ...s.bill.venue, lat: 36.16, lon: -86.78 } },
      cards: { ...s.cards, liftMap: { ...s.cards.liftMap, results: { ...s.cards.liftMap.results, tiles } }, partners: { ...s.cards.partners, results: ps } },
      budgetSplit: tiles.map((t, i) => ({ geohash: t.geohash, share: [0.6, 0.4][i]!, label: "heuristic, not a forecast" as const })),
    };
    const visits = planStreetTeamVisits(sheet);
    expect(overlaps(visits)).toEqual([]);
    expect(visits.flatMap((v) => v.notTimed)).toEqual([]);
    const at = (name: string) => visits.filter((v) => v.partner?.entity.name === name).map((v) => `${v.pass} ${v.weekday}`);
    expect(at("Place 1")).toEqual(["first saturday", "final saturday"]);
    // Moved in the first pass, and kept on Thursday in the final pass, so the Visit day names one weekday.
    expect(at("Place 6")).toEqual(["first thursday", "final thursday"]);
    expect(partnerHoursColumn(sheet).cell(ps[5]!).hours).toBe("Thu 9 am to 9 pm");
    // Saturday's stops all lie inside its short morning; the hop from the south area to the north one allows its travel.
    for (const v of visits.filter((x) => x.weekday === "saturday")) expect(toMin(v.end), v.start).toBeLessThanOrEqual(12 * 60 + 30);
  });

  it("drops a first pass a holiday would leave a day short rather than pile two days' stops onto one", () => {
    // Made on Christmas Eve for a Sunday Jan 3 show: the only first-pass week left is Dec 24 and 26, and Christmas
    // Eve's stops have no free day to go to, so there is only the final pass (New Year's Eve's stops on Wed Dec 30).
    expect(streetTeamPasses("2027-01-03", ["thursday", "saturday"], { notBefore: "2026-12-24" }).map((d) => `${d.pass} ${d.date} ${d.weekday}`)).toEqual([
      "final 2026-12-30 wednesday",
      "final 2027-01-02 saturday",
    ]);
    const s = makeTownSheet(false);
    const week = qlooHours({ wednesday: [["09:00", "21:00"]], thursday: [["09:00", "21:00"]], saturday: [["09:00", "21:00"]] });
    s.cards.partners.results = s.cards.partners.results.map((p) => ({ ...p, entity: { ...p.entity, properties: { hours: week } } }));
    s.createdAt = "2026-12-24T12:00:00.000Z";
    s.bill = { ...s.bill, date: "2027-01-03", weekday: "sunday" };
    const visits = planStreetTeamVisits(s);
    expect(visits.length).toBeGreaterThan(0);
    expect(visits.every((v) => v.pass === "final" && !isStreetTeamBlackout(v.date))).toBe(true);
    expect(overlaps(visits)).toEqual([]);
    expect(visits.filter((v) => v.end === "23:59")).toEqual([]);
  });

  it("visits every partner once in each pass, on the same street-team day, never before the plan existed", () => {
    const sheet = makeTownSheet();
    const visits = planStreetTeamVisits(sheet);
    const first = visits.filter((v) => v.pass === "first");
    const final = visits.filter((v) => v.pass === "final");
    expect(first).toHaveLength(10);
    expect(final).toHaveLength(10);
    const dayOf = (vs: StreetTeamVisit[]) => new Map(vs.map((v) => [v.partner!.entity.entityId, v.weekday]));
    expect(dayOf(final)).toEqual(dayOf(first));
    // Not every visit in the last week: half of them are about four weeks out.
    expect(first.every((v) => v.date >= "2026-10-23" && v.date <= "2026-10-29")).toBe(true);
    expect(final.every((v) => v.date >= "2026-11-13" && v.date <= "2026-11-19")).toBe(true);
    expect(visits.every((v) => v.date >= "2026-10-09")).toBe(true);
    // The final pass is a short stop to restock flyers.
    expect(final.every((v) => toMin(v.end) - toMin(v.start) === 10)).toBe(true);
    expect(first.every((v) => toMin(v.end) - toMin(v.start) === 20)).toBe(true);
  });

  it("gives each street-team day one part of town and keeps an area's partners on one day", () => {
    const sheet = makeTownSheet();
    const visits = planStreetTeamVisits(sheet, ONE_PASS);
    const top = topTiles(sheet);
    const north = new Set([top[0]!.geohash, top[2]!.geohash, top[4]!.geohash]);
    const dayOfArea = new Map<number, Set<string>>();
    for (const v of visits) dayOfArea.set(v.tileRank!, new Set([...(dayOfArea.get(v.tileRank!) ?? []), v.date]));
    // One day per area: each area's partners share it (area 3's odd partner is open both days, so it stays).
    for (const [rank, dates] of dayOfArea) expect(dates.size, `area ${rank}`).toBe(1);
    // The north areas share a day, the south areas the other.
    const northDays = new Set(visits.filter((v) => north.has(v.tile!.geohash)).map((v) => v.date));
    const southDays = new Set(visits.filter((v) => !north.has(v.tile!.geohash)).map((v) => v.date));
    expect(northDays.size).toBe(1);
    expect(southDays.size).toBe(1);
    expect([...northDays][0]).not.toBe([...southDays][0]);
  });

  it("walks each day nearest-first from the venue, an area's stops one after another", () => {
    // Every place open all day both days, so only the map decides the order.
    const sheet = makeTownSheet(false);
    const venue = { lat: sheet.bill.venue.lat, lon: sheet.bill.venue.lon };
    const visits = planStreetTeamVisits(sheet, ONE_PASS);
    for (const date of new Set(visits.map((v) => v.date))) {
      const day = visits.filter((v) => v.date === date);
      // The first stop is the nearest of the day's stops to the venue.
      const km = (v: StreetTeamVisit) => haversineM(venue, v.partner!.entity.location!);
      expect(km(day[0]!)).toBe(Math.min(...day.map(km)));
      // Areas are not interleaved: once the day leaves an area it does not come back.
      const areas = day.map((v) => v.tileRank);
      const runs = areas.filter((a, i) => i === 0 || a !== areas[i - 1]);
      expect(new Set(runs).size, `${date} ${areas.join(",")}`).toBe(runs.length);
    }
    expect(overlaps(visits)).toEqual([]);
  });

  it("times and labels each stop with that weekday's own hours from the place's week", () => {
    const sheet = makeTownSheet();
    // Area 3's second partner: Thursday 10:00-12:00, Saturday 15:00-19:00.
    const odd = sheet.cards.partners.results[5]!;
    for (const days of [["thursday"], ["saturday"]] as const) {
      const v = planStreetTeamVisits(sheet, { ...ONE_PASS, streetTeamDays: [...days] }).find((x) => x.partner?.entity.entityId === odd.entity.entityId)!;
      const [a, b] = days[0] === "thursday" ? [600, 720] : [900, 1140];
      expect(v.weekday).toBe(days[0]);
      expect(toMin(v.start) >= a && toMin(v.end) <= b, `${v.weekday} ${v.start}-${v.end}`).toBe(true);
      const ev = events(toIcs(sheet, { ...ONE_PASS, streetTeamDays: [...days] })).find((e) => (prop(e, "SUMMARY") ?? "").includes(odd.entity.name))!;
      expect(unescapeText(prop(ev, "DESCRIPTION") ?? "")).toContain(days[0] === "thursday" ? "Open Thu 10 am to noon." : "Open Sat 3 pm to 7 pm.");
    }
  });

  it("never puts a stop where the place is closed that day, in either pass", () => {
    for (const sheet of [makeTownSheet(), makeHoursSheet(), makeSheet()]) {
      const listed = hoursWeekday(sheet);
      for (const v of planStreetTeamVisits(sheet).filter((x) => x.partner)) {
        const h = partnerHoursOn(v.partner!, v.weekday, listed);
        expect(h.status, `${v.partner!.entity.name} ${v.weekday}`).not.toBe("closed");
        if (h.ranges.length > 0) expect(h.ranges.some(([a, b]) => toMin(v.start) >= a && toMin(v.end) <= b), `${v.partner!.entity.name} ${v.date} ${v.start}`).toBe(true);
      }
    }
  });

  it("names the pass in the calendar: a first pass to leave flyers, a final pass to restock", () => {
    const text = toIcs(makeTownSheet());
    const evs = events(text).filter((e) => (prop(e, "CATEGORIES") ?? "") === "Street team");
    const summaries = evs.map((e) => unescapeText(prop(e, "SUMMARY") ?? ""));
    expect(summaries.filter((x) => x.startsWith("Street team, first pass: "))).toHaveLength(10);
    expect(summaries.filter((x) => x.startsWith("Street team, final pass: "))).toHaveLength(10);
    const descs = evs.map((e) => unescapeText(prop(e, "DESCRIPTION") ?? ""));
    // 22 to 28 days out: "3 weeks out" or "4 weeks out", as the date falls.
    expect(descs.filter((d) => /^First pass, [34] weeks out: leave flyers and ask to put a poster up\./.test(d))).toHaveLength(10);
    expect(descs.filter((d) => d.startsWith("Final pass, show week: restock flyers and check the poster is still up."))).toHaveLength(10);
    for (const line of text.split("\r\n")) expect(enc.encode(line).length).toBeLessThanOrEqual(75);
  });
});

describe("repository fixtures", () => {
  const dir = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sheet.json")) : [];

  it.runIf(files.length > 0)("every synthetic sheet gives a well-formed calendar", () => {
    for (const f of files) {
      const sheet = (JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as { sheet: StreetSheet }).sheet;
      const text = toIcs(sheet, { timeZone: "America/New_York" });
      expect(text.replace(/\r\n/g, ""), f).not.toMatch(/[\r\n]/);
      for (const line of text.split("\r\n")) expect(enc.encode(line).length, f).toBeLessThanOrEqual(75);
      const evs = events(text);
      expect(evs.length, f).toBeGreaterThan(1);
      for (const ev of evs) for (const p of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY"]) expect(prop(ev, p), `${f} ${p}`).toBeTruthy();
      const uids = evs.map((e) => prop(e, "UID"));
      expect(new Set(uids).size, f).toBe(uids.length);
    }
  });
});
