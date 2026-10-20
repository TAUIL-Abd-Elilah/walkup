# @walkup/acs

US Census American Community Survey (ACS) 5-year client. It returns population, median age, median household income and adults 21+ for ZIP Code Tabulation Areas (ZCTAs) or for the census tracts in a county. These numbers feed the adult-population floor for lift tiles, the budget-split heuristic and the residualisation check.

## Public API

```ts
import { createAcsClient, summarizeAreas } from "@walkup/acs";

const acs = createAcsClient({ ledger });            // CENSUS_API_KEY is optional
const { rows, year, missing, ledgerRefs } = await acs.byZctas(["37206", "37207"]);
const tracts = await acs.tractsInCounty("47", "037");
const tile = summarizeAreas(rows);                  // { totalPopulation, adults21Plus, approxMedianAge, ... }
```

Each row is an `AcsAreaStats`: `{ geoType: "zcta" | "tract", geoId, name, totalPopulation, medianAge, medianHouseholdIncome, adults21Plus, year }`.

### Variables

| Field | Variable |
| --- | --- |
| `totalPopulation` | `B01003_001E` |
| `medianAge` | `B01002_001E` |
| `medianHouseholdIncome` | `B19013_001E` |
| `adults21Plus` | `B01001_001E` − (male `B01001_003E`..`B01001_008E`) − (female `B01001_027E`..`B01001_032E`) |

The twelve subtracted bins are under 5, 5–9, 10–14, 15–17, 18–19 and 20 years, for each sex. `adults21Plus` is `null` when the total or any bin is missing, or when the bins add up to more than the total (an inconsistent row is never clamped to 0). One request asks for 17 variables; the API allows 50.

Density is not here: the ACS has no land area. Join the gazetteer's `ALAND` for that.

### Client behaviour

- **Endpoint:** `GET https://api.census.gov/data/{year}/acs/acs5`. The default year is 2024. On a 404 the client falls back once to 2023 (`fallbackYear`, `null` disables) and stays on the fallback for later calls. `acs.year()` reports the vintage in use.
- **Batching:** ZCTAs are deduplicated, validated as 5 digits and sent at most 50 per request (`for=zip code tabulation area:...`). Tract requests use `for=tract:*&in=state:SS county:CCC` and return 11-digit GEOIDs.
- **Parsing:** the array-of-arrays body is read by header name, so column order does not matter. Short rows yield `null` cells. Census jam values (`-666666666`, `-999999999`, ...) and non-numeric cells become `null`. A 204 (no matching geography) gives no rows. Plain-text errors and the HTML invalid-key page raise `AcsError`.
- **Pacing:** request starts are at least 1 s apart (`minIntervalMs`), the client sends a descriptive User-Agent, and it retries once on 429 or 5xx.
- **Ledger:** one `kind: "acs"` entry per HTTP request, including the 404 that triggers the fallback. When a key is set it is shown as `$CENSUS_API_KEY`.

## Tests

```
npx vitest run packages/acs
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/acs"
```

The tests run offline against `test/fixtures/zcta.synthetic.json` (`"synthetic": true`, ZCTAs 00001–00003 do not exist). They check the adults-21+ arithmetic by hand.

## Known limits

- ACS 5-year values are period estimates with margins of error. MOEs are not fetched.
- `approxMedianAge` from `summarizeAreas` is a population-weighted mean of area medians, not a true median.
- ZCTAs approximate ZIP codes. They are not the same thing.
- Census data is public domain. Attribution text: `ACS_ATTRIBUTION`.
- The key is optional in the client, but in October 2026 the Census Data API redirected keyless requests to a missing-key HTML page (seen by the gazetteer build). The client raises `AcsError` on that page, so set `CENSUS_API_KEY` for live use.
