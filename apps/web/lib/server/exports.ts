/**
 * Downloads for one sheet, via @walkup/exports:
 * GET /api/sheet/<id>/<file> with file one of pdf, ics, partners.csv,
 * zips.csv, pins.csv, offer-codes.csv, sheet.json. The file name names the
 * show, its date and the plan ("walkup-greensky-bluegrass-2026-12-30-455629e6-
 * partners.csv"); fixture sheets get a "fixture-" prefix in front of that (and
 * their own watermark inside the file).
 */
import type { StreetSheet } from "@walkup/contracts";
import { exportFilePrefix, toExportFiles, type ExportKind } from "@walkup/exports";
import { presetForPlan } from "../presets";
import { vettedSheet } from "../vetted";

export const EXPORT_ROUTES: Readonly<Record<string, ExportKind>> = {
  pdf: "pdf",
  "street-sheet.pdf": "pdf",
  ics: "ics",
  "street-team.ics": "ics",
  "partners.csv": "partners",
  "zips.csv": "zips",
  "pins.csv": "pins",
  "offer-codes.csv": "offerCodes",
  "sheet.json": "json",
};

/** The download links a sheet offers, in display order. */
export const EXPORT_LINKS: readonly { file: string; label: string; hint: string }[] = [
  { file: "pdf", label: "Street Sheet PDF", hint: "one page" },
  { file: "ics", label: "Street-team calendar", hint: ".ics" },
  { file: "partners.csv", label: "partners.csv", hint: "call list; called, outcome and notes are for your street team to fill in; contact_email only from your own partner list" },
  { file: "zips.csv", label: "zips.csv", hint: "ZIP, lift, weight" },
  { file: "pins.csv", label: "pins.csv", hint: "lat, lon, radius" },
  { file: "offer-codes.csv", label: "offer-codes.csv", hint: "create in your ticketing platform" },
  // The data files stay as recorded (exportResponse); the page, the print view and the PDF show the checked text.
  { file: "sheet.json", label: "sheet.json", hint: "the whole sheet as recorded, before the view-time checks, with the ledger" },
];

export function exportKind(file: string): ExportKind | null {
  return Object.prototype.hasOwnProperty.call(EXPORT_ROUTES, file) ? (EXPORT_ROUTES[file] as ExportKind) : null;
}

export interface ExportOptions {
  /** Absolute URL of the interactive sheet's ledger, printed on the PDF. */
  ledgerUrl?: string;
  /** PDF only: show in the browser instead of downloading. */
  inline?: boolean;
  pageSize?: "LETTER" | "A4";
  /** The server serves recorded sheets only: the PDF says "Recorded <date>" on a live sheet, as the plan page does. */
  recorded?: boolean;
  /** The preset's show name ("Peninsula Comedy Night"), printed after the date as the print view does. */
  showName?: string;
}

/** The show name the plan page and the print view use for this sheet: its preset's, when it has one. */
export function exportShowName(planId: string, presetId: string | undefined, sheet: StreetSheet): string | undefined {
  const name = presetForPlan(presetId ?? planId, sheet.mode, sheet.bill)?.showName?.trim();
  return name ? name : undefined;
}

export async function exportResponse(sheet: StreetSheet, kind: ExportKind, opts: ExportOptions = {}): Promise<Response> {
  // The PDF shows the narration and copy lines as the page does; the data files stay as recorded.
  const [file] = await toExportFiles(kind === "pdf" ? vettedSheet(sheet).sheet : sheet, {
    include: [kind],
    // "walkup-<headliner>-<date>-<plan>-partners.csv": two sheets' downloads never share a name.
    prefix: exportFilePrefix(sheet),
    pdf: {
      ...(opts.ledgerUrl ? { ledgerUrl: opts.ledgerUrl } : {}),
      ...(opts.pageSize ? { pageSize: opts.pageSize } : {}),
      ...(opts.recorded ? { recorded: true } : {}),
      ...(opts.showName ? { showName: opts.showName } : {}),
      // Days to the show count from today, as on the plan page (which shows the recorded date beside them).
      asOf: new Date().toISOString(),
    },
  });
  if (!file) throw new Error(`export ${kind} produced no file`);
  // The A4 file gets its own name, so saving both sizes never gives "street-sheet (1).pdf".
  const filename = kind === "pdf" && opts.pageSize === "A4" ? file.filename.replace(/\.pdf$/, "-a4.pdf") : file.filename;
  const disposition = `${opts.inline && kind === "pdf" ? "inline" : "attachment"}; filename="${filename}"`;
  return new Response(new Uint8Array(file.data), {
    status: 200,
    headers: {
      "content-type": file.contentType,
      "content-disposition": disposition,
      "content-length": String(file.data.byteLength),
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}
