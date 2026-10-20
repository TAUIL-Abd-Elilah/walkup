import { describe, expect, it } from "vitest";
import { hoursOnDay, normalizeWeekday, openInEvening, parseDaySpec } from "../src/hours";

describe("normalizeWeekday / parseDaySpec", () => {
  it("normalises names and abbreviations", () => {
    expect(normalizeWeekday("Monday")).toBe("monday");
    expect(normalizeWeekday("THU")).toBe("thursday");
    expect(normalizeWeekday("Tues.")).toBe("tuesday");
    expect(normalizeWeekday("Mo")).toBe("monday");
    expect(normalizeWeekday("noday")).toBeNull();
    expect(normalizeWeekday(3)).toBeNull();
  });
  it("parses ranges, lists, wrap-around and specials", () => {
    expect(parseDaySpec("Mon-Fri 9-5")).toEqual({ days: ["monday", "tuesday", "wednesday", "thursday", "friday"], rest: "9-5" });
    expect(parseDaySpec("Fri - Mon: 5pm-2am")?.days).toEqual(["monday", "friday", "saturday", "sunday"]);
    expect(parseDaySpec("Sat & Sun 10-2")?.days).toEqual(["saturday", "sunday"]);
    expect(parseDaySpec("Monday through Thursday 4pm-12am")?.days).toEqual(["monday", "tuesday", "wednesday", "thursday"]);
    expect(parseDaySpec("Daily 7-3")?.days).toHaveLength(7);
    expect(parseDaySpec("Open daily 11am-2am")?.rest).toBe("11am-2am");
    expect(parseDaySpec("Weekends 10am-4pm")?.days).toEqual(["saturday", "sunday"]);
    expect(parseDaySpec("Weekdays 8-6")?.days).toHaveLength(5);
    expect(parseDaySpec("Mondays 5-9")?.days).toEqual(["monday"]);
    expect(parseDaySpec("Mo-Fr 09:00-17:00")?.days).toHaveLength(5);
    expect(parseDaySpec("11am-2am")).toBeNull();
    expect(parseDaySpec("We open at 5pm")).toBeNull();
    expect(parseDaySpec("Monumental views")).toBeNull();
  });
});

describe("hoursOnDay: Qloo-like day-keyed objects", () => {
  const week = {
    Monday: [{ opens: "T11:00", closes: "T23:00" }],
    Tuesday: [{ opens: "T11:00", closes: "T14:00" }, { opens: "T17:00", closes: "T02:00" }],
    Wednesday: [],
    Thursday: [{ opens: "T16:00", closes: "T02:00" }],
  };
  it("open days give a time range", () => {
    expect(hoursOnDay(week, "monday")).toEqual({ status: "open", text: "11:00-23:00" });
    expect(hoursOnDay(week, "tuesday")).toEqual({ status: "open", text: "11:00-14:00, 17:00-02:00" });
  });
  it("an empty entry in a populated week is closed", () => {
    expect(hoursOnDay(week, "wednesday")).toEqual({ status: "closed", text: null });
  });
  it("a missing day is unknown by default, closed only when asked", () => {
    expect(hoursOnDay(week, "friday").status).toBe("unknown");
    expect(hoursOnDay(week, "friday", { missingDayMeans: "closed" }).status).toBe("closed");
  });
  it("case-insensitive keys, abbreviations, string and boolean values", () => {
    expect(hoursOnDay({ monday: "11 AM\u2013 2 AM" }, "monday")).toEqual({ status: "open", text: "11 AM- 2 AM" });
    expect(hoursOnDay({ MON: "Closed", TUE: "9-5" }, "monday").status).toBe("closed");
    expect(hoursOnDay({ fri: true }, "friday")).toEqual({ status: "open", text: null });
    expect(hoursOnDay({ fri: false, sat: true }, "friday").status).toBe("closed");
    expect(hoursOnDay({ Sunday: "Open 24 hours" }, "sunday")).toEqual({ status: "open", text: "Open 24 hours" });
    expect(hoursOnDay({ Sunday: { open: "1100", close: "2200" } }, "sunday")).toEqual({ status: "open", text: "11:00-22:00" });
    expect(hoursOnDay({ Sunday: { start: 900, end: 1700 } }, "sunday")).toEqual({ status: "open", text: "09:00-17:00" });
    expect(hoursOnDay({ Sunday: { closed: true }, Monday: "9-5" }, "sunday").status).toBe("closed");
  });
  it("all-empty week and unrecognised values are unknown, never closed", () => {
    expect(hoursOnDay({ Monday: [], Tuesday: [] }, "monday").status).toBe("unknown");
    expect(hoursOnDay({ Monday: "varies" }, "monday").status).toBe("unknown");
    expect(hoursOnDay({ Monday: 42 }, "monday").status).toBe("unknown");
    expect(hoursOnDay({ Monday: [{ foo: "bar" }] }, "monday").status).toBe("unknown");
  });
});

describe("hoursOnDay: arrays of strings (weekday_text style)", () => {
  const lines = [
    "Monday: 11:00\u202fAM \u2013 2:00\u202fAM",
    "Tuesday: Closed",
    "Wednesday: Open 24 hours",
    "Thursday: 11:00 AM \u2013 2:00 PM, 5:00 \u2013 10:00 PM",
    "Friday: 11 AM-2 AM",
    "Saturday: 10 AM-2 AM",
    "Sunday: 10 AM-12 AM",
  ];
  it("reads each day", () => {
    expect(hoursOnDay(lines, "monday")).toEqual({ status: "open", text: "11:00 AM - 2:00 AM" });
    expect(hoursOnDay(lines, "tuesday").status).toBe("closed");
    expect(hoursOnDay(lines, "wednesday").text).toBe("Open 24 hours");
    expect(hoursOnDay(lines, "thursday").text).toBe("11:00 AM - 2:00 PM, 5:00 - 10:00 PM");
    expect(hoursOnDay(lines, "friday").text).toBe("11 AM-2 AM");
  });
  it("abbreviations and missing days", () => {
    expect(hoursOnDay(["Mon: 9-5", "Sun: Closed"], "sunday").status).toBe("closed");
    expect(hoursOnDay(["Mon: 9-5", "Sun: Closed"], "friday").status).toBe("unknown");
  });
  it("Google-style object wrappers", () => {
    expect(hoursOnDay({ weekdayDescriptions: lines }, "tuesday").status).toBe("closed");
    expect(hoursOnDay({ weekday_text: lines }, "friday").status).toBe("open");
    expect(hoursOnDay({ regularOpeningHours: { weekdayDescriptions: lines } }, "monday").status).toBe("open");
    expect(hoursOnDay({ openNow: true }, "monday").status).toBe("unknown");
  });
});

describe("hoursOnDay: free text", () => {
  it("ranges, lists and segments", () => {
    const t = "Mon-Fri 11am-2am; Sat, Sun 10am-2am";
    expect(hoursOnDay(t, "wednesday")).toEqual({ status: "open", text: "11am-2am" });
    expect(hoursOnDay(t, "saturday")).toEqual({ status: "open", text: "10am-2am" });
    expect(hoursOnDay("Tue-Sat 5pm-1am | Sun-Mon closed", "monday").status).toBe("closed");
    expect(hoursOnDay("Tue-Sat 5pm-1am | Sun-Mon closed", "friday").status).toBe("open");
    expect(hoursOnDay("Mon, Wed, Fri 9-5", "wednesday").status).toBe("open");
    expect(hoursOnDay("Mon, Wed, Fri 9-5", "tuesday").status).toBe("unknown");
  });
  it("OSM opening_hours style", () => {
    const osm = "Mo-Fr 09:00-17:00; Sa 10:00-14:00; Su off";
    expect(hoursOnDay(osm, "thursday")).toEqual({ status: "open", text: "09:00-17:00" });
    expect(hoursOnDay(osm, "sunday").status).toBe("closed");
  });
  it("whole-entity statements", () => {
    expect(hoursOnDay("Open 24 hours", "tuesday").text).toBe("Open 24 hours");
    expect(hoursOnDay("24/7", "tuesday").status).toBe("open");
    expect(hoursOnDay("Daily 7am-3pm", "sunday").text).toBe("7am-3pm");
    expect(hoursOnDay("Permanently closed", "tuesday").status).toBe("closed");
  });
  it("ambiguous text is unknown", () => {
    expect(hoursOnDay("11am-2am", "monday").status).toBe("unknown");
    expect(hoursOnDay("We open at 5pm", "monday").status).toBe("unknown");
    expect(hoursOnDay("", "monday").status).toBe("unknown");
    expect(hoursOnDay("Call for hours", "monday").status).toBe("unknown");
  });
  it("JSON strings are parsed; broken JSON falls back to text", () => {
    expect(hoursOnDay(JSON.stringify({ Friday: [{ opens: "T16:00", closes: "T02:00" }] }), "friday").text).toBe("16:00-02:00");
    expect(hoursOnDay("{not json", "friday").status).toBe("unknown");
  });
});

describe("hoursOnDay: periods and row arrays", () => {
  it("Google periods (0 = Sunday)", () => {
    const periods = [
      { open: { day: 1, hour: 11, minute: 0 }, close: { day: 2, hour: 2, minute: 0 } },
      { open: { day: 5, hour: 16, minute: 30 }, close: { day: 6, hour: 2, minute: 0 } },
    ];
    expect(hoursOnDay({ periods }, "monday")).toEqual({ status: "open", text: "11:00-02:00" });
    expect(hoursOnDay({ periods }, "friday")).toEqual({ status: "open", text: "16:30-02:00" });
    expect(hoursOnDay({ periods }, "sunday").status).toBe("closed");
    expect(hoursOnDay(periods, "monday").status).toBe("open");
  });
  it("legacy time strings and the always-open encoding", () => {
    expect(hoursOnDay({ periods: [{ open: { day: 3, time: "0900" }, close: { day: 3, time: "1700" } }] }, "wednesday").text).toBe("09:00-17:00");
    expect(hoursOnDay({ periods: [{ open: { day: 0, time: "0000" } }] }, "thursday")).toEqual({ status: "open", text: "Open 24 hours" });
  });
  it("malformed periods are unknown", () => {
    expect(hoursOnDay({ periods: [{ open: { day: "x" } }] }, "monday").status).toBe("unknown");
    expect(hoursOnDay([{ open: { day: 1.5 } }], "monday").status).toBe("unknown");
  });
  it("rows with a day field", () => {
    const rows = [
      { day: "Monday", opens: "09:00", closes: "17:00" },
      { day: "Tuesday", closed: true },
      { days: ["sat", "sun"], open: "10:00", close: "16:00" },
      { day: 5, open: "12:00", close: "20:00" },
    ];
    expect(hoursOnDay(rows, "monday").text).toBe("09:00-17:00");
    expect(hoursOnDay(rows, "tuesday").status).toBe("closed");
    expect(hoursOnDay(rows, "sunday").text).toBe("10:00-16:00");
    expect(hoursOnDay(rows, "friday").text).toBe("12:00-20:00");
    expect(hoursOnDay(rows, "wednesday").status).toBe("unknown");
  });
});

describe("hoursOnDay: unknown shapes are never closed", () => {
  const weird: unknown[] = [null, undefined, 0, 1, true, false, [], {}, [1, 2], [null], { foo: 1 }, [{ foo: 1 }], Symbol.iterator, ["", ""], [[]]];
  for (const w of weird) {
    it(`shape ${String(typeof w === "symbol" ? "symbol" : JSON.stringify(w))}`, () => {
      expect(hoursOnDay(w, "monday").status).not.toBe("closed");
    });
  }
});

describe("hoursOnDay: a closed window is not a closed day", () => {
  it('"Closed until 5 PM" and "Closed 2-5" are unknown; bare "Closed" / "off" stay closed', () => {
    expect(hoursOnDay({ Thursday: "Closed until 5 PM", Friday: "11-2" }, "thursday").status).toBe("unknown");
    expect(hoursOnDay(["Thursday: Closed 2-5", "Friday: 9-5"], "thursday").status).toBe("unknown");
    expect(hoursOnDay({ Thursday: "Closed", Friday: "11-2" }, "thursday").status).toBe("closed");
    expect(hoursOnDay("Mo-Fr 09:00-17:00; Su off", "sunday").status).toBe("closed");
  });
});

describe("openInEvening", () => {
  it("is true only when the day's hours reach 5 pm to midnight", () => {
    expect(openInEvening("11:00-15:00")).toBe(false); // a lunch café
    expect(openInEvening("07:30:00-14:30:00")).toBe(false);
    expect(openInEvening("09:00-17:00")).toBe(false); // closes as the evening starts
    expect(openInEvening("09:00-19:00")).toBe(true);
    expect(openInEvening("17:00:00-02:00:00")).toBe(true);
    expect(openInEvening("11:30-14:30, 17:00-22:00")).toBe(true);
    expect(openInEvening("00:00-02:00")).toBe(false); // late-night tail of the day before
    expect(openInEvening("00:00-00:00")).toBe(true); // all day
    expect(openInEvening("by appointment")).toBeNull();
    expect(openInEvening(null)).toBeNull();
  });
});
