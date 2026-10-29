/**
 * @walkup/exports
 *
 * Pure functions from a contracts StreetSheet to files: the one-page PDF, the
 * street-team calendar, the CSVs and sheet.json. No network, no clock (dates
 * come from the sheet), no writes to disk.
 */
export { toPdf, renderStreetSheetPdf, streetSheetDocument, streetSheetElement, countPdfPages, PAGE_SIZES, PDF_MAX_PODCASTS } from "./pdf";
export type { PdfOptions, PdfPageSize, PdfRenderResult, DocumentOptions } from "./pdf";

export { buildSheetModel, sheetModelText, partnerHoursColumn, spotColumnWidths, noTopPick, noTopPickText, podcastsOmittedText, PAGE_SECTIONS, AREA_BLURB_CHARS, AREA_BLURB_ZIP_CHARS } from "./sheet-model";
export type { Audience, SheetModel, SheetModelOptions, SheetSection, TileItem, PartnerRow, PartnerHoursCell, DeclaredRow, SpotRow, MediaRow, BudgetRow, DiscoveryLine } from "./sheet-model";

export {
  layoutTileMap,
  placeLabels,
  venueLabelSpot,
  venueLabelBox,
  liftBand,
  liftAlpha,
  liftFill,
  niceKm,
  LIFT_INK,
  MAP_COLORS,
  LABEL_RADIUS,
  MIN_VISIBLE_CELL,
  VENUE_LABEL_SIZE,
  VENUE_LABEL_MAX_CHARS,
} from "./map";
export type { MapRect, MapBox, TileMapLayout, TileMapOptions, LiftBand } from "./map";

export {
  toIcs,
  planStreetTeam,
  planStreetTeamVisits,
  streetTeamDates,
  streetTeamPasses,
  partnerVisits,
  isStreetTeamBlackout,
  streetTeamBlackout,
  streetTeamHolidays,
  FIRST_PASS_WEEKS_OUT,
  escapeIcsText,
  foldLine,
  icsLocal,
  icsUtc,
  vtimezoneLines,
  SUPPORTED_TIME_ZONES,
  ICS_EOL,
  ICS_PRODID,
} from "./ics";
export type { IcsOptions, StreetTeamVisit, StreetTeamPass, StreetTeamPassDate, StreetTeamHoliday, PartnerVisit, NotTimedStop, StreetTeamNote, StreetTeamPlan } from "./ics";

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
  areaBudget,
  apportion,
  geohashHalfDiagonalKm,
  PARTNERS_CSV_COLUMNS,
  ZIPS_CSV_COLUMNS,
  PINS_CSV_COLUMNS,
  OFFER_CODES_CSV_COLUMNS,
  OFFER_CODE_STATUS,
  MIN_PIN_RADIUS_KM,
} from "./tables";
export type { PartnersCsvOptions, ZipRow, ZipOptions, PinRow, PinOptions, OfferCodeRow, OfferCodeOptions } from "./tables";

export { toSheetJson, sheetJsonDocument, sanitizeSheet, SHEET_JSON_FORMAT, SHEET_JSON_VERSION } from "./json";
export type { SheetJsonOptions, SheetJsonDocument } from "./json";

export { toExportFiles, exportFilePrefix, EXPORT_FILE_NAMES, EXPORT_CONTENT_TYPES } from "./bundle";
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
  PHONE_NOT_LISTED,
  WEBSITE_NOT_LISTED,
  HOURS_NOT_LISTED,
  SPOT_NOT_IN_USUAL,
  SPOT_NOT_IN_USUAL_SHORT,
  DISTANCE_SUFFIX,
  withState,
  mapReachKm,
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
  areaLabel,
  areaState,
  addressState,
  partnerAreaLabel,
  partnerAreaText,
  NEAR_VENUE,
  partnerOtherState,
  hoursWeekday,
  formatPhone,
  sortedReceipts,
  countsAreWhatIf,
  formatKm,
  isCartOrStand,
  sheetSpots,
  spotSharesDiffer,
  sentencesUpTo,
} from "./format";
export { isFanFacing, spotIsFanFacing, partnerIsFanFacing, fanFacingSpots } from "./audience";
export type { FanFacingPlace } from "./audience";
export { parseOpenRanges, partnerHoursOn } from "./hours";
export type { DayHours } from "./hours";
export type { TileSelectOptions } from "./format";
