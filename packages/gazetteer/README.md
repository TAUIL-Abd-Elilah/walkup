# @walkup/gazetteer

Names lift tiles and counts the adults around them, from local files only. It reads the
per-metro JSON built by `data/gazetteer/build.py` (OpenStreetMap neighbourhoods, Census places,
Census ZCTAs with ACS 5-year estimates) and answers point lookups. No network at run time.

Metros shipped today: `nashville`, `hampton_roads`, `tacoma`. See `data/gazetteer/README.md`
for boxes, sources, ACS variables and the last build.

## API

```ts
import {
  loadMetro, nameForPoint, zctasNear, nearestZcta, adultsNear, adultsNearDetail,
  metroForPoint, annotateTile, haversineKm,
} from "@walkup/gazetteer";
```

| Function | Returns |
|---|---|
| `loadMetro(name, { dir? })` | The parsed `MetroGazetteer` (sync, validated, cached per directory). Throws `GazetteerError` naming the available metros when the file is missing. |
| `nameForPoint(lat, lon, metro, opts?)` | `{ name, source, distanceKm, ref, insideMetro }` or `null`. Nearest OSM neighbourhood/suburb/quarter within 2.5 km (`neighbourhoodRadiusKm`), else a Census place. `ref` is the OSM id or Census GEOID. |
| `zctasNear(lat, lon, radiusKm, metro)` | ZCTAs whose internal point is within the radius, nearest first, each with `distanceKm` and its ACS fields. |
| `nearestZcta(lat, lon, metro)` | The ZCTA with the nearest internal point, any distance. |
| `adultsNear(lat, lon, radiusKm, opts?)` | Sum of ACS adults 21+ over ZCTAs whose internal point is in range. Searches every metro unless `opts.metro` is set; ZCTAs without ACS are left out. `null` when nothing known is in range (outside every metro box with no ZCTA point in range, or ACS missing for all of them); `0` for a covered point with no ZCTA point in range (pass `ensureNearest: true` to count the nearest ZCTA instead; this only applies inside a metro box, so a point outside every box stays `null`). |
| `adultsNearDetail(...)` | Same, plus the ZCTAs counted, those missing ACS, and the metro. |
| `metroForPoint(lat, lon, opts?)` | The metro whose box holds the point (nearest centre when boxes overlap), or `null`. |
| `annotateTile(tile, opts?)` | A copy of a `LiftTile` with `name`, `zctas` and `adultPopulation` filled (3 km radius, nearest ZCTA when none is in range). A tile outside the metro's box (passed in `opts.metro` or found by `metroForPoint`) is left unnamed with `adultPopulation: null`. |
| `haversineKm(lat1, lon1, lat2, lon2)` | Great-circle distance, km. |

`metro` arguments accept a name (`"tacoma"`) or an already loaded `MetroGazetteer`.
Functions that search every metro accept `{ dir }` or `{ metros: [...] }`.

### Where the files come from

Default directory: `data/gazetteer/out`, resolved from this package's location
(`import.meta.url`). Override with `WALKUP_GAZETTEER_DIR` or the `dir` option, or build a
gazetteer in memory with `parseMetro(json)` (useful when a bundler does not ship `data/`).

### Census-place fallback

`placeStrategy: "area-aware"` (default) treats each place as a circle of its land area
(radius `sqrt(landKm2 / pi)`): the smallest place whose circle holds the point wins, else the
place with the nearest circle edge. This keeps a point in south Nashville on
"Nashville-Davidson" rather than the nearest small town's centre. `"nearest"` uses the nearest
internal point only. `distanceKm` is always to the place's internal point.

## Tests

```bash
npx vitest run packages/gazetteer
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/gazetteer"
```

Tests run on synthetic metros in `test/fixtures` (open ocean coordinates, invented names) and
need no network. One smoke test loads the built `nashville.json` when it exists.

## Known limits

- Point gazetteer, not polygons: "nearest name", not "inside". The place fallback can pick
  the wrong city near a city line.
- Many OSM neighbourhood points are subdivision names; generic names (`Downtown`) repeat
  across cities in one metro.
- Adults are counted by ZCTA internal point with no areal weighting; a small radius around a
  geohash-6 tile often holds no ZCTA point (use `ensureNearest` or a 3 km radius).
- Points outside a metro box still get a name (`insideMetro: false`) when a metro is passed
  explicitly; `metroForPoint` returns `null` there and `annotateTile` leaves the tile unnamed
  (with or without an explicit metro).
- `loadAllMetros` (used by every all-metro lookup) skips a malformed metro file so the others
  keep working, and reports it once through `process.emitWarning` (type `GazetteerWarning`).
