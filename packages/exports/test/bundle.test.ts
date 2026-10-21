import { describe, expect, it } from "vitest";
import { EXPORT_FILE_NAMES, toExportFiles } from "../src/bundle";
import { makeSheet } from "./helpers";

describe("toExportFiles", () => {
  it(
    "returns all seven files with names and content types",
    async () => {
      const files = await toExportFiles(makeSheet());
      expect(files.map((f) => f.filename)).toEqual([
        "street-sheet.pdf",
        "partners.csv",
        "zips.csv",
        "pins.csv",
        "offer-codes.csv",
        "street-team.ics",
        "sheet.json",
      ]);
      for (const f of files) expect(f.data.length).toBeGreaterThan(0);
      const byKind = new Map(files.map((f) => [f.kind, f]));
      expect(byKind.get("pdf")!.contentType).toBe("application/pdf");
      expect(byKind.get("pdf")!.data.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(byKind.get("ics")!.contentType).toContain("text/calendar");
      // BOM on the spreadsheet files, none on the ad-platform uploads.
      expect([...byKind.get("partners")!.data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect([...byKind.get("offerCodes")!.data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(byKind.get("zips")!.data.subarray(0, 3).toString("utf8")).toBe("zip");
      expect(byKind.get("pins")!.data.subarray(0, 4).toString("utf8")).toBe("area");
    },
    60_000,
  );

  it("can export a subset, in the order asked, without rendering the PDF", async () => {
    const files = await toExportFiles(makeSheet(), { include: ["json", "ics"], prefix: "plan-1-" });
    expect(files.map((f) => f.filename)).toEqual(["plan-1-sheet.json", "plan-1-street-team.ics"]);
  });

  it("prefixes fixture files so they never pass for a live run", async () => {
    const files = await toExportFiles(makeSheet({ mode: "fixture" }), { include: ["partners", "zips"] });
    expect(files.map((f) => f.filename)).toEqual([`fixture-${EXPORT_FILE_NAMES.partners}`, `fixture-${EXPORT_FILE_NAMES.zips}`]);
  });

  it("passes tile options through to zips and pins", async () => {
    const files = await toExportFiles(makeSheet(), { include: ["zips", "pins"], tiles: { maxTiles: 1 }, zips: { isResidentialZip: () => true } });
    expect(files[0]!.data.toString("utf8")).toBe('zip,area,area_name,lift_score,suggested_weight\r\n37206,1,"East Bank, TN",2.1,1\r\n');
    expect(files[1]!.data.toString("utf8").split("\r\n").filter((l) => l !== "")).toHaveLength(2);
  });

  it("gives partners.csv the same street-team days as street-team.ics", async () => {
    const files = await toExportFiles(makeSheet(), { include: ["partners", "ics"], ics: { streetTeamDays: ["saturday"] } });
    const csv = files[0]!.data.toString("utf8");
    expect(csv).toContain(",Sat,");
    expect(csv).not.toContain(",Thu,");
    expect(files[1]!.data.toString("utf8")).toContain("DTSTART:20261114T");
  });
});
