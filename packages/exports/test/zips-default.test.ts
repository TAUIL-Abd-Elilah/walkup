import { describe, expect, it, vi } from "vitest";
import { zipRows, zipsCsv } from "../src/tables";
import { makeSheet } from "./helpers";

// The default residential check is @walkup/gazetteer/zips; here it says one test ZIP is not homes.
vi.mock("@walkup/gazetteer/zips", () => ({ isResidentialZip: (zip: string) => zip !== "37228" }));

describe("zips.csv default residential check", () => {
  it("drops the ZIPs @walkup/gazetteer/zips says are not homes", () => {
    const zips = zipRows(makeSheet()).map((r) => r.zip);
    expect(zips).toContain("37208");
    expect(zips).not.toContain("37228");
    expect(zipsCsv(makeSheet())).not.toContain("37228");
  });

  it("lets the caller's check win", () => {
    expect(zipRows(makeSheet(), { isResidentialZip: () => true }).map((r) => r.zip)).toContain("37228");
  });
});
