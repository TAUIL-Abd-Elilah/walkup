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
  bboxContains,
  metroForPoint,
  nameForPoint,
  nearestZcta,
  zctasNear,
} from "./lookup";
export type { AdultsDetail, AdultsOptions, AnnotateOptions } from "./lookup";
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
