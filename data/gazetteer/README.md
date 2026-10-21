# Gazetteer data

Offline lookup tables that let Walkup put a name and an adult-population count on a
lift tile without calling any API at run time. `@walkup/gazetteer`
(`packages/gazetteer`) reads the files in `out/`.

| File | What it is |
|---|---|
| `build.py` | Fetches the public sources, filters them to each metro box, writes `out/` |
| `test_build.py` | Offline unit tests for the build's parsing and cleaning (`python -I data/gazetteer/test_build.py -v`) |
| `out/<metro>.json` | One file per metro (format below) |
| `out/manifest.json` | Per-metro counts and per-source status from the last build |
| `ATTRIBUTION.md` | Licences and the credit lines to display |

## Metros

| Metro | Box (south, west, north, east) | Covers |
|---|---|---|
| `nashville` | 35.8752, -87.1377, 36.4502, -86.4255 | ~64 x 64 km around downtown: Davidson County plus Brentwood, Franklin, Smyrna, La Vergne, Mt. Juliet, Hendersonville, Goodlettsville |
| `hampton_roads` | 36.54, -76.62, 37.23, -75.86 | Hampton, Newport News, Norfolk, Portsmouth, Virginia Beach and Chesapeake in full (~77 x 68 km) |
| `dc` | 38.5208, -77.4878, 39.2394, -76.5646 | ~80 x 80 km around The Anthem (the live hero room): the District, Arlington, Alexandria, Fairfax, Reston, Bethesda, Rockville, Silver Spring, College Park, Laurel, Bowie |
| `tacoma` | 46.99, -122.78, 47.62, -122.12 | ~70 km north-south from Spanaway/Graham to downtown Seattle, Gig Harbor to Auburn/Bonney Lake |

The boxes live in `METROS` in `build.py`. A lift radius of 40 km from a venue can reach past
a box edge (Murfreesboro, for example, is outside `nashville`). Widen the box and re-run when
that matters; the library reports `insideMetro` and distances so a far match is visible.

## Sources

| Layer | Source | Notes |
|---|---|---|
| `neighbourhoods` | OpenStreetMap via Overpass (`https://overpass-api.de/api/interpreter`), one query per metro: `nwr[place~neighbourhood\|suburb\|quarter][name](box); out center tags;` | Nodes, plus way/relation centres. Names tidied (`"Germantown Nashville, TN"` becomes `"Germantown"`, trailing `=` removed). Apartment complexes, condos, townhome blocks and mobile-home parks tagged as neighbourhoods are dropped (count in `sources.osm.droppedHousing`). Same name within 1 km is kept once, node first. |
| `places` | Census Gazetteer national place file, 2025 vintage (falls back to 2024) | Internal point, land area, name without the legal suffix (`"Franklin city"` becomes `"Franklin"`; `"Nashville-Davidson metropolitan government (balance)"` becomes `"Nashville-Davidson"`). Kept when the place's equivalent circle reaches into the box. |
| `zctas` | Census Gazetteer national ZCTA file, same vintage | Internal point and land area. Kept when the internal point is in the box or within 5 km of it. |
| ACS fields on `zctas` | ACS 5-year 2020-2024 (falls back to 2019-2023) | See the variables below. |

### ACS variables

| Field | Variable(s) |
|---|---|
| `totalPop` | `B01003_001E` total population |
| `adults21` | `B01001_001E` minus the under-21 bins of B01001 (Sex by Age): male `B01001_003E`..`B01001_008E` and female `B01001_027E`..`B01001_032E` (under 5, 5-9, 10-14, 15-17, 18-19, 20) |
| `medianAge` | `B01002_001E` median age |
| `medianIncome` | `B19013_001E` median household income, in end-year dollars |

Census "jam" values (`-666666666` and the like) become `null`.

The build first tries the Census Data API (`https://api.census.gov/data/2024/acs/acs5`, then
2023), with `CENSUS_API_KEY` from the environment when set. Keyless calls are now redirected
to a missing-key page, so without a key the build streams the ACS table-based Summary File for
the same vintage from `www2.census.gov` (no key needed) and keeps only the ZCTA rows. Each
output records which route was used in `sources.acs.via` and every refused attempt in
`sources.acs.attempts`.

## Output format

```jsonc
{
  "metro": "tacoma",
  "label": "...",
  "center": { "lat": 47.2529, "lon": -122.4443 },
  "bbox": { "south": 46.99, "west": -122.78, "north": 47.62, "east": -122.12 },
  "generatedAt": "2026-10-13T08:46:29Z",
  "sources": { "places": {...}, "zctaPoints": {...}, "osm": {...}, "acs": {...} },
  "errors": [],                     // one line per failed source; empty when all succeeded
  "attribution": { "osm": "© OpenStreetMap contributors, ODbL", "census": "U.S. Census Bureau, public domain" },
  "neighbourhoods": [{ "name", "lat", "lon", "kind": "neighbourhood|suburb|quarter", "osmId": "node/123" }],
  "places":         [{ "name", "geoid", "lat", "lon", "kind": "incorporated|cdp", "landKm2" }],
  "zctas":          [{ "zcta", "lat", "lon", "landKm2", "totalPop", "adults21", "medianAge", "medianIncome" }]
}
```

Coordinates are rounded to 4 decimals (about 11 m). Arrays are written one record per line so
diffs stay readable.

## Last build (2026-10-13)

| Metro | Neighbourhoods | Places | ZCTAs | Adults 21+ in file | Sources |
|---|---|---|---|---|---|
| `nashville` | 255 (29 housing dropped) | 30 | 51 | 1,041,198 | all ok |
| `hampton_roads` | 808 (38 housing dropped) | 13 | 76 | 1,159,226 | all ok |
| `tacoma` | 549 (96 housing dropped) | 106 | 119 | 2,038,347 | all ok |

What did not work first time, and what was done:

- **Census Data API**: refused both vintages without a key (HTTP 302 to the missing-key page).
  ACS came from the 2024 table-based Summary File instead. The networked build recorded the
  refusals in `sources.acs.attempts`; the files in `out/` were then regenerated from the cache
  with `--offline` (after tightening the housing filter), so they now read
  `api: skipped (offline mode)` there. Same data, same vintages.
- **Overpass, `nashville`**: HTTP 504 (server busy) on the first runs. The build now backs off
  (6 s, 20 s, 60 s) and the third attempt succeeded.
- **2025 Gazetteer files** are pipe-delimited (earlier vintages use tabs); the reader detects either.

"Adults 21+ in file" sums every ZCTA in the file, including the 5 km margin, so it is larger
than the population of the box itself.

## Area names and residential ZIPs

| File | What it is |
|---|---|
| `zip_places.csv` | One row per ZCTA in `out/`: the place name people use for the ZIP (the USPS city name; where USPS files a town under a big neighbour, the town, noted "USPS: ...") and its kind: `residential`, `unique` (one organisation: federal offices, a hospital, an airport), `military` or `campus`. Curated by hand. |
| `areas.json` | Per metro: the ZIP cities named by neighbourhood (Washington, Nashville, Seattle, Tacoma) and well-known districts with a centre and a radius ("H Street NE", "U Street / Shaw", "Old Town Alexandria"). Curated by hand. |
| `zips.py` | Writes `packages/gazetteer/src/zip-data.ts` from the two files and the ACS counts in `out/` (a ZCTA with fewer than 250 adults 21+ is not residential). `--check` fails when the module is stale or a ZCTA has no row. `build.py` runs it after a build. |
| `test_zips.py` | Offline tests (`python -I data/gazetteer/test_zips.py -v`). |

An area is named by the nearest well-known district within its radius, else by the place name of its residential
ZIP; inside a city named by neighbourhood, the OSM neighbourhood within 2.5 km is kept. Non-residential ZIPs never
count toward an area's ZIPs or adults, and an area counts at most its 4 nearest ZIPs.

## Rebuilding

```bash
python -I data/gazetteer/build.py                 # all metros; reuses data/private/gazetteer_cache/
python -I data/gazetteer/build.py --metro tacoma  # one metro (manifest keeps the others)
python -I data/gazetteer/build.py --refresh       # fetch everything again
python -I data/gazetteer/build.py --offline       # cache only
```

Every output is written even when a source fails (the failure is recorded in its `errors` and
`sources`), but the script then exits with status 1 so a scripted rebuild cannot pass unnoticed.

Requests go out one at a time with a descriptive User-Agent and a pause of at least 1.5 s
(6 s or more between Overpass queries). Downloads are cached under `data/private/` (git-ignored):
two Gazetteer zips (~2 MB), three Overpass responses, and the national ZCTA rows of four ACS
tables (~3 MB). The Summary File stream itself is ~250 MB the first time.

## Known limits

- Names are points, not polygons. A tile is named after the nearest neighbourhood point within
  2.5 km, which is "near", not "inside". The Census-place fallback uses an equivalent circle per
  place, which can be wrong near city lines (a point in Norfolk's Ghent resolves to Portsmouth
  when no neighbourhood is in range).
- OSM coverage is uneven. Many US "neighbourhoods" are subdivision names; some generic names
  (`Downtown`) repeat across cities in one metro.
- ACS 5-year estimates carry margins of error (not stored here); small ZCTAs are noisy.
- Adults are summed by ZCTA internal point, with no areal weighting.
