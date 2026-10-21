import { describe, expect, it } from "vitest";
import { parseOpenRanges, partnerHoursOn } from "../src/hours";
import { PARTNERS, qlooHours } from "./helpers";

describe("parseOpenRanges", () => {
  it("reads live Qloo text, several ranges, 12-hour clocks and past-midnight closes", () => {
    expect(parseOpenRanges("17:00:00-21:00:00")).toEqual([[1020, 1260]]);
    expect(parseOpenRanges("10:00-14:00, 17:00-21:30")).toEqual([
      [600, 840],
      [1020, 1290],
    ]);
    expect(parseOpenRanges("20:00:00-02:00:00")).toEqual([[1200, 1440]]);
    expect(parseOpenRanges("17:00:00-00:00:00")).toEqual([[1020, 1440]]);
    expect(parseOpenRanges("11 AM-2 AM")).toEqual([[660, 1440]]);
    expect(parseOpenRanges("9:30 a.m. to 5 p.m.")).toEqual([[570, 1020]]);
    expect(parseOpenRanges("11-2 pm")).toEqual([[660, 840]]);
    expect(parseOpenRanges("Open 24 hours")).toEqual([[0, 1440]]);
    expect(parseOpenRanges("")).toEqual([]);
    expect(parseOpenRanges("by appointment")).toEqual([]);
  });
});

describe("partnerHoursOn", () => {
  const p = { ...PARTNERS[0]!, entity: { ...PARTNERS[0]!.entity, properties: { hours: qlooHours({ thursday: [["17:00", "21:00"]], saturday: [["10:00", "14:00"]] }) } } };

  it("reads each day from the place's own week", () => {
    expect(partnerHoursOn(p, "thursday", "thursday")).toMatchObject({ status: "open", ranges: [[1020, 1260]] });
    expect(partnerHoursOn(p, "saturday", "thursday")).toMatchObject({ status: "open", ranges: [[600, 840]] });
    expect(partnerHoursOn(p, "monday", "thursday")).toEqual({ status: "closed", text: null, ranges: [] });
  });

  it("falls back to the sheet's hours text only for the day it belongs to", () => {
    const noWeek = PARTNERS[0]!; // hoursOnDay "Thu 10:00-19:00", no week
    expect(partnerHoursOn(noWeek, "thursday", "thursday")).toMatchObject({ status: "open", text: "10:00-19:00", ranges: [[600, 1140]] });
    expect(partnerHoursOn(noWeek, "saturday", "thursday").status).toBe("unknown");
    // Text that names another day is not used for this one.
    expect(partnerHoursOn(noWeek, "friday", "friday").status).toBe("unknown");
    expect(partnerHoursOn({ ...noWeek, hoursOnDay: null }, "thursday", "thursday").status).toBe("unknown");
  });
});
