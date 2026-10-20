/**
 * RFC 4180 CSV writer: CRLF record separators, a header row, and fields quoted
 * only when they contain a comma, a double quote, CR or LF (quotes doubled).
 * Output is a JS string; encode it as UTF-8. `bom: true` prepends U+FEFF so
 * spreadsheet apps detect UTF-8 (leave it off for ad-platform uploads).
 */

export type CsvCell = string | number | boolean | null | undefined;

export interface CsvOptions {
  /** Prepend a UTF-8 byte order mark (U+FEFF). Default false. */
  bom?: boolean;
  /**
   * Prefix text cells that a spreadsheet would run as a formula with a single
   * quote ("=..." "@..." and "+"/"-" followed by anything other than a plain
   * number or phone number). Numbers are never touched. Default true.
   */
  formulaGuard?: boolean;
}

export const CSV_BOM = "﻿";
export const CSV_EOL = "\r\n";

const NEEDS_QUOTES = /[",\r\n]/;
const PLAIN_SIGNED = /^[+-][\d\s().,-]*$/;

/** True when a spreadsheet would read this text as a formula. */
export function looksLikeFormula(s: string): boolean {
  if (s === "") return false;
  const c = s.charAt(0);
  if (c === "=" || c === "@" || c === "\t" || c === "\r") return true;
  if (c === "+" || c === "-") return !PLAIN_SIGNED.test(s);
  return false;
}

/** One field, escaped. null, undefined and non-finite numbers are empty fields. */
export function csvCell(value: CsvCell, opts: Pick<CsvOptions, "formulaGuard"> = {}): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  let s = String(value);
  if ((opts.formulaGuard ?? true) && looksLikeFormula(s)) s = `'${s}`;
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole file: header row, one record per row, each record ending in CRLF. */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[], opts: CsvOptions = {}): string {
  const width = header.length;
  const lines = [header.map((h) => csvCell(h, { formulaGuard: false })).join(",")];
  for (const row of rows) {
    const cells: string[] = [];
    for (let i = 0; i < width; i++) cells.push(csvCell(row[i], opts));
    lines.push(cells.join(","));
  }
  return (opts.bom ? CSV_BOM : "") + lines.join(CSV_EOL) + CSV_EOL;
}
