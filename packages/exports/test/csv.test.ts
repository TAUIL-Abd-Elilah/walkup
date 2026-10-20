import { describe, expect, it } from "vitest";
import { CSV_BOM, csvCell, looksLikeFormula, toCsv } from "../src/csv";
import { parseCsv } from "./csv-parse";

describe("csvCell (RFC 4180 escaping)", () => {
  it("leaves plain fields unquoted", () => {
    expect(csvCell("Low Hum Records")).toBe("Low Hum Records");
    expect(csvCell("")).toBe("");
  });

  it("quotes fields with a comma, a quote, CR or LF and doubles inner quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(csvCell("cr\ronly")).toBe('"cr\ronly"');
    expect(csvCell('"')).toBe('""""');
  });

  it("writes empty fields for null, undefined and non-finite numbers", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("writes numbers and booleans plainly", () => {
    expect(csvCell(-86.78)).toBe("-86.78");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(true)).toBe("true");
  });

  it("guards text that a spreadsheet would run as a formula, but not numbers or phone numbers", () => {
    expect(csvCell("=SUM(A1:A3)")).toBe("'=SUM(A1:A3)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("+HYPERLINK(\"x\")")).toBe(`"'+HYPERLINK(""x"")"`);
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("+1 (615) 555-0100")).toBe("+1 (615) 555-0100");
    expect(csvCell("-12.5")).toBe("-12.5");
    expect(csvCell(-12.5)).toBe("-12.5");
    expect(csvCell("=1+1", { formulaGuard: false })).toBe("=1+1");
    expect(looksLikeFormula("Crown & Clipper")).toBe(false);
  });

  it("keeps non-ASCII text as is (the file is UTF-8)", () => {
    expect(csvCell("Café Ñandú")).toBe("Café Ñandú");
  });
});

describe("toCsv", () => {
  it("writes a header row and ends every record with CRLF", () => {
    const out = toCsv(["a", "b"], [
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(out).toBe("a,b\r\n1,2\r\n3,4\r\n");
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("pads short rows and drops cells past the header width", () => {
    expect(toCsv(["a", "b", "c"], [["1"], ["1", "2", "3", "4"]])).toBe("a,b,c\r\n1,,\r\n1,2,3\r\n");
  });

  it("adds a UTF-8 byte order mark only on request", () => {
    expect(toCsv(["a"], [["x"]]).startsWith(CSV_BOM)).toBe(false);
    const withBom = toCsv(["a"], [["x"]], { bom: true });
    expect(withBom.startsWith(CSV_BOM)).toBe(true);
    expect([...Buffer.from(withBom, "utf8").subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("round-trips awkward values through a strict RFC 4180 reader", () => {
    const awkward = ['Spins, "Wax" & Co.', "two\r\nlines", "trailing,", '""', "  spaced  ", "Ünïcødé", ""];
    const text = toCsv(["v"], awkward.map((v) => [v]), { formulaGuard: false });
    const rows = parseCsv(text);
    expect(rows[0]).toEqual(["v"]);
    expect(rows.slice(1).map((r) => r[0])).toEqual(awkward);
  });
});
