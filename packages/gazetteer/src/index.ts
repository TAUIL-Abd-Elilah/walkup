/**
 * @walkup/gazetteer
 *
 * Names lift tiles (OSM neighbourhoods, else Census places) and sums ACS adults 21+
 * per area (ZCTA internal points), from the offline files in data/gazetteer/out.
 * Pure lookups over local JSON: no network at runtime.
 */

export { EARTH_RADIUS_KM, haversineKm } from "./haversine";
export {
  DEFAULT_GAZETTEER_DIR,
  GazetteerError,
  clearGazetteerCache,
  gazetteerDir,
  listMetros,
  loadAllMetros,
  loadMetro,
  parseMetro,
} from "./load";
export {
  DEFAULT_NEIGHBOURHOOD_RADIUS_KM,
  adultsNear,
  adultsNearDetail,
  annotateTile,
  areaNameForPoint,
  bboxContains,
  metroForPoint,
  nameForPoint,
  nearestZcta,
  stateForPoint,
  zctasNear,
  zipForPoint,
} from "./lookup";
export { MAX_AREA_ZIPS, MIN_RESIDENTIAL_ADULTS, isNeighbourhoodCity, isResidentialZip, knownAreaNear, zipPlace } from "./zips";
export type { KnownAreaHit, ZipKind, ZipPlace } from "./zips";
export { STATE_FIPS, stateFromGeoid, stateFromZctas, stateFromZip } from "./states";
export type { AdultsDetail, AdultsOptions, AnnotateOptions, AreaName, AreaNameSource } from "./lookup";
export type {
  Bbox,
  LoadOptions,
  MetroGazetteer,
  MetroRef,
  MultiMetroOptions,
  NameOptions,
  NameSource,
  NeighbourhoodKind,
  NeighbourhoodRecord,
  PlaceRecord,
  PlaceStrategy,
  PointName,
  SourceStatus,
  ZctaHit,
  ZctaRecord,
} from "./types";
