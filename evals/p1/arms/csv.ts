/**
 * Minimal RFC 4180 CSV reader and a writer that matches Python's csv module defaults
 * (QUOTE_MINIMAL, "\n" line terminator, as evals/p1/common.write_csv uses), so the files
 * this runner writes read back identically in evals/p1/analyze.py.
 */

/** Parses CSV text into rows of fields. Handles quotes, doubled quotes, CRLF and a BOM. */
export function parseCsvRows(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (quoted) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Header-keyed records (like csv.DictReader). Blank lines are skipped; short rows are padded with "". */
export function parseCsv(text: string): { header: string[]; records: Record<string, string>[] } {
  const rows = parseCsvRows(text).filter((r) => !(r.length === 1 && r[0] === ""));
  const header = (rows[0] ?? []).map((h) => h.trim());
  const records = rows.slice(1).map((r) => {
    const rec: Record<string, string> = {};
    header.forEach((h, idx) => {
      rec[h] = r[idx] ?? "";
    });
    return rec;
  });
  return { header, records };
}

function quoteField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export type CsvValue = string | number | null | undefined;

/** CSV text with a header row, "\n" line endings and minimal quoting. */
export function toCsv(columns: readonly string[], rows: readonly Record<string, CsvValue>[]): string {
  const lines = [columns.map(quoteField).join(",")];
  for (const r of rows) {
    lines.push(columns.map((c) => quoteField(r[c] === null || r[c] === undefined ? "" : String(r[c]))).join(","));
  }
  return lines.join("\n") + "\n";
}
