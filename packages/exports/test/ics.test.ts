import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { StreetSheet } from "@walkup/contracts";
import { escapeIcsText, foldLine, icsUtc, planStreetTeamVisits, streetTeamDates, toIcs } from "../src/ics";
import { makeSheet, TILES } from "./helpers";

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

  it("deals top tiles round-robin over the days, back to back from 10:00", () => {
    const visits = planStreetTeamVisits(makeSheet());
    expect(visits.map((v) => [v.date, v.start, v.end, v.tileRank])).toEqual([
      ["2026-11-14", "10:00", "11:30", 1],
      ["2026-11-14", "12:00", "13:30", 3],
      ["2026-11-14", "14:00", "15:30", 5],
      ["2026-11-19", "10:00", "11:30", 2],
      ["2026-11-19", "12:00", "13:30", 4],
    ]);
    expect(visits[0]?.partners.map((p) => p.entity.name)).toEqual(["Low Hum Records", 'Spins, "Wax" & Co.']);
  });

  it("uses the streetTeamDays option over the sheet's days", () => {
    const visits = planStreetTeamVisits(makeSheet(), { streetTeamDays: ["wednesday"] });
    expect(new Set(visits.map((v) => v.date))).toEqual(new Set(["2026-11-18"]));
    expect(visits).toHaveLength(5);
  });

  it("shrinks visits so a crowded day still ends before midnight", () => {
    const visits = planStreetTeamVisits(makeSheet(), { streetTeamDays: ["monday"], startTime: "20:00" });
    expect(visits).toHaveLength(5);
    for (const v of visits) expect(v.end <= "23:59" && v.start < v.end).toBe(true);
  });

  it("starts the day earlier rather than running visits past midnight", () => {
    const late = planStreetTeamVisits(makeSheet(), { streetTeamDays: ["monday"], startTime: "23:50", maxTiles: 8, minLift: 0 });
    expect(late).toHaveLength(8);
    for (const v of late) {
      expect(v.start < "24:00" && v.end <= "23:59" && v.start < v.end, `${v.start}-${v.end}`).toBe(true);
    }
    for (let i = 1; i < late.length; i++) expect(late[i - 1]!.end <= late[i]!.start).toBe(true);
    const text = toIcs(makeSheet(), { streetTeamDays: ["monday"], startTime: "23:30" });
    const times = unfold(text).filter((l) => /^DT(START|END):\d{8}T/.test(l)).map((l) => l.slice(l.indexOf("T", 8) + 1));
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(Number(t.slice(0, 2))).toBeLessThan(24);
  });

  it("visits the partners near the venue when no tile reaches the lift floor", () => {
    const visits = planStreetTeamVisits(makeSheet(), { minLift: 9 });
    expect(visits).toHaveLength(2);
    expect(visits.every((v) => v.tile === null && v.partners.length === 6)).toBe(true);
  });
});

describe("toIcs", () => {
  const sheet = makeSheet();
  const text = toIcs(sheet);

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
    expect(evs).toHaveLength(6); // 5 tile visits + the show
    for (const ev of evs) {
      for (const p of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY"]) expect(prop(ev, p), p).toBeTruthy();
      expect(prop(ev, "DTSTAMP")).toBe("20261009T150000Z");
    }
  });

  it("writes floating local times by default (no TZID, no Z)", () => {
    const first = events(text)[0]!;
    expect(first).toContain("DTSTART:20261114T100000");
    expect(first).toContain("DTEND:20261114T113000");
    expect(text).not.toContain("TZID");
    expect(text).not.toContain("VTIMEZONE");
  });

  it("pins times to a supported zone with a VTIMEZONE", () => {
    const tz = toIcs(sheet, { timeZone: "America/Chicago" });
    const lines = unfold(tz);
    expect(lines).toContain("BEGIN:VTIMEZONE");
    expect(lines).toContain("TZID:America/Chicago");
    expect(lines).toContain("TZOFFSETTO:-0500");
    expect(lines).toContain("TZOFFSETTO:-0600");
    expect(events(tz)[0]).toContain("DTSTART;TZID=America/Chicago:20261114T100000");
    // Unknown zones fall back to floating times rather than inventing rules.
    expect(toIcs(sheet, { timeZone: "Mars/Olympus" })).not.toContain("TZID");
  });

  it("uses the venue's own time zone from the sheet when no zone is passed", () => {
    const zoned = { ...sheet, bill: { ...sheet.bill, venue: { ...sheet.bill.venue, timeZone: "America/Chicago" } } };
    expect(events(toIcs(zoned))[0]).toContain("DTSTART;TZID=America/Chicago:20261114T100000");
    // The caller's zone still wins.
    expect(events(toIcs(zoned, { timeZone: "America/New_York" }))[0]).toContain("DTSTART;TZID=America/New_York:20261114T100000");
  });

  it("gives stable, unique UIDs", () => {
    const uids = events(text).map((e) => prop(e, "UID"));
    expect(new Set(uids).size).toBe(uids.length);
    expect(events(toIcs(sheet)).map((e) => prop(e, "UID"))).toEqual(uids);
    expect(uids[0]).toBe(`hl-test-plan-1-20261114-${TILES[0]!.geohash}@walkup`);
  });

  it("escapes text and describes each visit with its partners", () => {
    const first = events(text)[0]!;
    expect(prop(first, "SUMMARY")).toBe("Street team: area 1\\, East Bank");
    expect(prop(first, "LOCATION")).toBe("East Bank\\, Nashville\\, TN");
    expect(prop(first, "GEO")).toBe("36.175000;-86.750000");
    const desc = unescapeText(prop(first, "DESCRIPTION") ?? "");
    expect(desc).toContain("Area 1 of 5: East Bank, ZIP 37206. About 2.1 times the room's usual crowd.");
    expect(desc).not.toMatch(/geohash|over-index|\dx\b/);
    expect(desc).toContain("Suggested, not affiliated: no partner has agreed to anything.");
    expect(desc).toContain('2. Spins, "Wax" & Co. (Record store)');
    expect(desc).toContain("ZIP 37206");
  });

  it("adds the show as an all-day event, or a timed one with showStartTime", () => {
    const show = events(text).at(-1)!;
    expect(show).toContain("DTSTART;VALUE=DATE:20261120");
    expect(show).toContain("DTEND;VALUE=DATE:20261121");
    const timed = events(toIcs(sheet, { showStartTime: "22:30", showMinutes: 120 })).at(-1)!;
    expect(timed).toContain("DTSTART:20261120T223000");
    expect(timed).toContain("DTEND:20261121T003000");
    // Ticketmaster's localTime carries seconds.
    expect(events(toIcs(sheet, { showStartTime: "22:30:00", showMinutes: 120 })).at(-1)!).toContain("DTSTART:20261120T223000");
    expect(events(toIcs(sheet, { includeShow: false }))).toHaveLength(5);
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
