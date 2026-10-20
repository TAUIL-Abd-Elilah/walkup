/**
 * @walkup/exports
 *
 * Pure functions from a contracts StreetSheet to files: the one-page PDF, the
 * street-team calendar, the CSVs and sheet.json. No network, no clock (dates
 * come from the sheet), no writes to disk.
 */
export { toPdf, renderStreetSheetPdf, streetSheetDocument, streetSheetElement, countPdfPages, PAGE_SIZES } from "./pdf";
export type { PdfOptions, PdfPageSize, PdfRenderResult, DocumentOptions } from "./pdf";

export { buildSheetModel, sheetModelText } from "./sheet-model";
export type { Audience, SheetModel, SheetModelOptions, TileItem, PartnerRow, DeclaredRow, SpotRow, MediaRow, BudgetRow, DiscoveryLine } from "./sheet-model";

export { layoutTileMap, placeLabels, liftBand, liftAlpha, liftFill, niceKm, LIFT_INK, MAP_COLORS, LABEL_RADIUS, MIN_VISIBLE_CELL } from "./map";
export type { MapRect, TileMapLayout, TileMapOptions, LiftBand } from "./map";

export {
  toIcs,
  planStreetTeamVisits,
  streetTeamDates,
  escapeIcsText,
  foldLine,
  icsLocal,
  icsUtc,
  vtimezoneLines,
  SUPPORTED_TIME_ZONES,
  ICS_EOL,
  ICS_PRODID,
} from "./ics";
export type { IcsOptions, StreetTeamVisit } from "./ics";

export { toCsv, csvCell, looksLikeFormula, CSV_BOM, CSV_EOL } from "./csv";
export type { CsvCell, CsvOptions } from "./csv";

export {
  partnersCsv,
  partnersCsvRows,
  declaredInCallOrder,
  zipsCsv,
  zipRows,
  pinsCsv,
  pinRows,
  offerCodesCsv,
  offerCodeRows,
  tileWeights,
  apportion,
  geohashHalfDiagonalMi,
  PARTNERS_CSV_COLUMNS,
  ZIPS_CSV_COLUMNS,
  PINS_CSV_COLUMNS,
  OFFER_CODES_CSV_COLUMNS,
  OFFER_CODE_STATUS,
  METERS_PER_MILE,
} from "./tables";
export type { PartnersCsvOptions, ZipRow, PinRow, PinOptions, OfferCodeRow, OfferCodeOptions } from "./tables";

export { toSheetJson, sheetJsonDocument, sanitizeSheet, SHEET_JSON_FORMAT, SHEET_JSON_VERSION } from "./json";
export type { SheetJsonOptions, SheetJsonDocument } from "./json";

export { toExportFiles, EXPORT_FILE_NAMES, EXPORT_CONTENT_TYPES } from "./bundle";
export type { ExportFile, ExportKind, ExportAllOptions } from "./bundle";

export { pdfText, isPdfSafe } from "./winansi";
export {
  topTiles,
  tMinusDays,
  tMinusLabel,
  formatShowDate,
  ledgerRanges,
  actsLine,
  TOP_LIFT,
  SUGGESTED_NOT_AFFILIATED,
  ATTRIBUTION,
  FIXTURE_NOTICE,
  SAMPLE_LABEL,
  SAMPLE_PREFIX,
  explainTags,
  partnerWhy,
  partnerWhyLine,
  categoryLabel,
  partnerWhyRefs,
  partnerLessSure,
  LESS_SURE_NOTE,
  streetDaysText,
  capacityText,
  DECLARED_UNRANKED,
  spotVsUsual,
  spotsShareNote,
  dayHoursText,
  realLimits,
  SAMPLE_ATTRIBUTION,
  LIFT_KEY,
  partnerWhyLong,
  formatHours,
  receiptGroup,
  ordinal,
  sameArea,
  AREA_MERGE_KM,
  sheetAgeLabel,
  isAllAgesForCopy,
} from "./format";
export type { TileSelectOptions } from "./format";
