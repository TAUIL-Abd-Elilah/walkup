/**
 * Every export for one sheet as named files, ready to attach or zip.
 * Fixture sheets get a "fixture-" file-name prefix so a file never passes for a
 * live run once it leaves the app.
 */
import type { StreetSheet } from "@walkup/contracts";
import { toIcs, type IcsOptions } from "./ics";
import { toSheetJson, type SheetJsonOptions } from "./json";
import { toPdf, type PdfOptions } from "./pdf";
import { offerCodesCsv, partnersCsv, pinsCsv, zipsCsv, type OfferCodeOptions, type PinOptions, type ZipOptions } from "./tables";
import type { TileSelectOptions } from "./format";

export type ExportKind = "pdf" | "partners" | "zips" | "pins" | "offerCodes" | "ics" | "json";

export const EXPORT_FILE_NAMES: Readonly<Record<ExportKind, string>> = {
  pdf: "street-sheet.pdf",
  partners: "partners.csv",
  zips: "zips.csv",
  pins: "pins.csv",
  offerCodes: "offer-codes.csv",
  ics: "street-team.ics",
  json: "sheet.json",
};

export const EXPORT_CONTENT_TYPES: Readonly<Record<ExportKind, string>> = {
  pdf: "application/pdf",
  partners: "text/csv; charset=utf-8",
  zips: "text/csv; charset=utf-8",
  pins: "text/csv; charset=utf-8",
  offerCodes: "text/csv; charset=utf-8",
  ics: "text/calendar; charset=utf-8; method=PUBLISH",
  json: "application/json; charset=utf-8",
};

export interface ExportFile {
  kind: ExportKind;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface ExportAllOptions {
  /** Which files, in this order. Default: all seven. */
  include?: readonly ExportKind[];
  /** Prepended to every file name (after "fixture-" on fixture sheets). Default "". */
  prefix?: string;
  pdf?: PdfOptions;
  ics?: IcsOptions;
  json?: SheetJsonOptions;
  /** Tile selection for zips.csv, pins.csv and the tile offer codes. */
  tiles?: TileSelectOptions;
  pins?: Omit<PinOptions, keyof TileSelectOptions>;
  zips?: Omit<ZipOptions, keyof TileSelectOptions>;
  offerCodes?: Omit<OfferCodeOptions, keyof TileSelectOptions>;
  /**
   * UTF-8 byte order mark on the human-facing CSVs (partners, offer codes) so
   * spreadsheet apps read accents correctly. Default true. zips.csv and
   * pins.csv never get one (ad-platform uploads).
   */
  bomForSpreadsheets?: boolean;
}

const ALL: readonly ExportKind[] = ["pdf", "partners", "zips", "pins", "offerCodes", "ics", "json"];

export async function toExportFiles(sheet: StreetSheet, opts: ExportAllOptions = {}): Promise<ExportFile[]> {
  const include = opts.include ?? ALL;
  const prefix = `${sheet.mode === "fixture" ? "fixture-" : ""}${opts.prefix ?? ""}`;
  const bom = opts.bomForSpreadsheets ?? true;
  const files: ExportFile[] = [];
  for (const kind of include) {
    let data: Buffer;
    switch (kind) {
      case "pdf":
        data = await toPdf(sheet, opts.pdf);
        break;
      case "partners":
        // The day column comes from the same street-team plan as street-team.ics.
        data = Buffer.from(partnersCsv(sheet, { bom, visits: { ...opts.tiles, ...opts.ics } }), "utf8");
        break;
      case "zips":
        data = Buffer.from(zipsCsv(sheet, { ...opts.tiles, ...opts.zips, bom: false }), "utf8");
        break;
      case "pins":
        data = Buffer.from(pinsCsv(sheet, { ...opts.tiles, ...opts.pins, bom: false }), "utf8");
        break;
      case "offerCodes":
        data = Buffer.from(offerCodesCsv(sheet, { ...opts.tiles, ...opts.offerCodes, bom }), "utf8");
        break;
      case "ics":
        data = Buffer.from(toIcs(sheet, { ...opts.tiles, ...opts.ics }), "utf8");
        break;
      case "json":
        data = Buffer.from(toSheetJson(sheet, opts.json), "utf8");
        break;
      default: {
        const never: never = kind;
        throw new Error(`unknown export kind: ${String(never)}`);
      }
    }
    files.push({ kind, filename: `${prefix}${EXPORT_FILE_NAMES[kind]}`, contentType: EXPORT_CONTENT_TYPES[kind], data });
  }
  return files;
}
