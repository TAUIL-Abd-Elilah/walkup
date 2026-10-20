/**
 * The default exporters: thin calls into @walkup/exports. Nothing is
 * re-implemented here. partners.csv gets a UTF-8 byte order mark, as the
 * download does, so spreadsheet apps read accents correctly.
 */
import { partnersCsv, toIcs, toPdf } from "@walkup/exports";
import type { SheetExporters } from "./attachments";

export const defaultExporters: SheetExporters = {
  pdf: (sheet) => toPdf(sheet),
  ics: (sheet) => toIcs(sheet),
  partners: (sheet) => partnersCsv(sheet, { bom: true }),
};
