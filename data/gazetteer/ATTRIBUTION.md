# Attribution and licences for `data/gazetteer/out`

## OpenStreetMap (the `neighbourhoods` arrays)

Neighbourhood, suburb and quarter names and positions are extracted from OpenStreetMap through
the Overpass API.

> © OpenStreetMap contributors. Data available under the Open Database License (ODbL) 1.0,
> https://www.openstreetmap.org/copyright

The `neighbourhoods` arrays in `out/*.json` are a derived database of OpenStreetMap data and
are made available under the ODbL 1.0 (https://opendatacommons.org/licenses/odbl/1-0/), the
same terms as the source. Any page, map or export that shows these names must credit
"© OpenStreetMap contributors" (each file's `attribution.osm` holds the line).

Changes made to the extract (see `build.py`): names tidied (state suffixes, trailing
punctuation), records naming apartment complexes, condominiums, townhome blocks and
mobile-home parks removed, duplicates within 1 km merged, coordinates rounded to 4 decimals.

## U.S. Census Bureau (the `places` and `zctas` arrays)

- Census Gazetteer Files (places, ZIP Code Tabulation Areas), 2025 vintage:
  https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html
- American Community Survey 5-year estimates, 2020-2024, tables B01001, B01002, B01003 and
  B19013, by ZCTA: https://www.census.gov/programs-surveys/acs

Census data are works of the U.S. Government and in the public domain. Credit line used in the
product: "U.S. Census Bureau, public domain". This product uses Census Bureau data but is not
endorsed or certified by the Census Bureau.

ZIP Code Tabulation Areas approximate USPS ZIP Codes; they are not the same thing.
