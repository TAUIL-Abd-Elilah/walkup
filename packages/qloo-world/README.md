# @walkup/qloo-world

A deterministic, clearly labelled **fixture** stand-in for Qloo, Ticketmaster Discovery and Google Places Text Search. It is served through `fetch`-compatible transports, so the real clients (`@walkup/qloo`, `@walkup/tm`, `@walkup/places`) and the whole pipeline run offline, with no keys. The product no longer calls the Google Places transport (Places was removed on Oct 20 2026); it stays so the world and its generated data stay the same.

Nothing here is recorded API data. Every body says `"synthetic": true` at the top level and every response carries the header `x-walkup-world: synthetic`. Every act, film and TV title, business, podcast and brand is invented; only the three rooms (The Truth, Hampton Coliseum, Super Funny Comedy Club) are real places. Business names come from a hand-written list, the way small businesses are named: an owner's surname ("Grimsley's", "Haskins Records") or a plain name ("The Tin Cup", "Third Coast Records"). Surnames and phones are drawn without replacement inside each map cell, and the salts in `places-gen.ts` are chosen so no sample sheet repeats a first word or a phone (`npx tsx packages/orchestrator/scripts/check-sample-names.ts`). Addresses use ordinary made-up street names ("Linden Ave", "3rd St", "Harlow Rd") and the town the point sits in; phones a real area code for the metro with the reserved 555-01xx line numbers; websites the `.example` domain, one per place (named for its street, so two unrelated places that share a plain name do not read as one chain); and every sheet built from them says "Sample data". Entity ids are UUID-shaped and start with `0000`.

## Use

```ts
import { createWorld, WORLD_TAG_PINS } from "@walkup/qloo-world";

const world = createWorld({ scenario: { thinHeatmap: true } });
const qloo = new QlooClient({ config: liveShapedConfig, fetch: world.qlooFetch, cache, limiter: noLimiter });
const tm = createTmClient({ apiKey: "fixture", fetch: world.tmFetch });
const places = createPlacesClient({ apiKey: "fixture", fetch: world.placesFetch });
```

`@walkup/orchestrator`'s `createFixtureDeps()` does this wiring (and always reports `mode: "fixture"`).

| Export | What it is |
|---|---|
| `createWorld({ seed?, scenario? })` | A world: `qlooFetch`, `tmFetch`, `placesFetch`, `fetch` (routes by host), `scenario()`, `setScenario(patch)`, `resetScenario()`, `stats()`, `resetStats()`. |
| `isWorldTransport(f)` | True for this package's transports. |
| `WORLD_TAG_PINS` | Synthetic tag pins the world answers to (live runs read `config/tags.json`). |
| `WORLD_VENUES`, `WORLD_EVENTS`, `WORLD_EVENT_IDS` | The three rooms and their rosters; the preset event ids. |
| `CATALOG`, `catalogByKey`, `catalogById`, `NAMED_PLACES`, `PODCASTS`, `BRANDS` | Hand-written entities (acts, film/TV titles, the operators' named partners, podcasts, brands). |
| `placesWithin`, `placeById`, `generatedPlaceId`, `parseGeneratedPlaceId` | Generated businesses (per geohash-5 cell, reversible ids). |

## Endpoints

**Qloo** (`https://hackathon.api.qloo.com`): `GET /search` (flat `results[]` with `types[]`, 404 when nothing matches, `filter.location` + `filter.radius` in miles), `GET /entities` (`entity_ids`, `external.spotify.ids`), `GET /v2/insights` (a POST with weighted signals is a 400, as live on Oct 15) for `urn:heatmap` (`results.heatmap[{location{latitude,longitude,geohash}, query{affinity,affinity_rank,popularity}}]`), `urn:demographics` (one block per signal, persons have none), `urn:tag` (`filter.tag.types`, `filter.parents.types`, `diversify.by=subtype`), `urn:entity:place` and `urn:entity:podcast|brand|artist|person|movie|tv_show` (`results.entities[]` with `query.affinity`, `query.distance`, `query.explainability`), `GET /v2/analysis/compare` (`results.tags|a|b`, no `success`, `query.count` as a string), `GET /v2/tags`, `GET /v2/audiences` (served as live answers it; the product never calls it). Headers: `x-second-ratelimit-limit`, `x-month-ratelimit-limit`, `x-month-ratelimit-remaining`.

Field placement follows the live API as recorded on Oct 15 (field names only; every value here is invented):

- `/search` and `/entities` rows: `types[]`, external ids under `properties.external.<ns> = {id}`, tag refs `{tag_id, name, type, value}`, places with `location {lat, lon}` only.
- Insights rows: `type` + `subtype`, top-level `external.<ns> = [{id}]`, tag refs `{id, name, type, weight: null}`, places with a 12-character `location.geohash`, `properties.neighborhood: null`, `properties.localities[]` (a city row and a ZCTA row whose `name` is the ZIP from the gazetteer's nearest ZCTA), a numeric `business_rating` and hours `{<weekday>: [{closed, opens, closes}]}` (a closed day is `[{closed: true, opens: null, closes: null}]`).
- Heatmaps: only `success` and `results`. Demographics: every block keyed by `entity_id` (a signal tag's block holds the tag URN). Tag profiles add `tag_value` and `popularity`. `/v2/tags` adds `duration`.
- Errors: `{errors: [{message, path?}]}` (the world's own wording).
- `/v2/audiences`: a free-text `filter.query` returns an empty list, as live; without one the world lists its examples.

**Scripted not_found case** (tests only): `NOT_FOUND_PAIR` holds "Wade Corley", an entry `/search` lists but the world has no taste data for (`noSignal`), and "Wade Corley and The Low Ten", which works. Sent as a signal, the solo id is dropped like the live API drops a not_found id: entity insights answer 200 with `warnings: [{type: "not_found", "signal.interests.entities": [id]}]`; heatmaps, tag profiles and compare drop it silently; demographics still return its block; a heatmap left with only not_found ids is still a 200 with cells (plain foot traffic, as live probe 2 found on Oct 15), and only a malformed id makes a heatmap a 400; entity insights with no usable id and no filter or `signal.location` are a 400 on `signal.interests.entities`. A heatmap therefore never tells whether a seed was usable: that comes from the insights check (`checkSignals`). Both entries are `testOnly`: insights never offer them unless asked for by id, so preset sheets do not change.

Like the live API: unknown params are ignored with 200; a heatmap without a signal or location, or with a malformed signal id, is a 400; `output.heatmap.boundary=city|neighborhood` is a 400; unsupported `filter.type`s are a 403.

Filters honoured on places: `filter.location` + `.radius` (metres), `filter.tags` with `operator.filter.tags` (union/intersection), `filter.hours`, `filter.price_level.min/max`, `filter.exclude.tags`, `filter.exclude.entities`, `filter.results.entities`, `take`, `page`. `signal.location` moves brand rankings (local brands rise) and leaves podcast rankings unchanged.

**Ticketmaster** (`https://app.ticketmaster.com/discovery/v2`): `/events/{id}.json`, `/events.json` (`venueId`, `keyword`, `startDateTime`, `endDateTime`, `size`, `page`), `/venues.json`.

**Google Places** (`https://places.googleapis.com/v1/places:searchText`): the same invented businesses, ranked like a text search (query words, rating, review count, distance), with `businessStatus` and `regularOpeningHours`.

## How the numbers are made

- A latent preference space of seven dimensions. Acts, titles, tags, podcasts, brands and places carry a vector; signals are weighted averages of their entities' vectors.
- Geography comes from the offline gazetteer (`@walkup/gazetteer`): population density from ZCTA adults 21+ plus a commercial core around each metro centre, and a smooth preference field whose blobs sit on OSM neighbourhood points near the centre. Heat cells are populated geohash-6 cells inside the metro box, so lift tiles get gazetteer names.
- Heat affinity is a percentile, within the response, of a cell's density times three factors, plus cell-level noise: the match with the shared preference field (`HEAT_TASTE_SWING` 0.2), the match with a heat-only audience field (`HEAT_AUDIENCE_GAIN` 1; `audience.ts`: three hotspots per dimension on cells no other dimension uses, in the lower-middle density band, matched with squared taste weights), and a per-seed draw per cell averaged over the signal's seeds (`HEAT_SEED_NOISE` 0.01). Both taste factors scale with the signal's coherence to the power 5 (coherence = length of the summed taste vectors over the sum of their lengths), so a broad signal such as a room's twelve headliners across genres looks more like plain foot traffic than a focused bill. Heat still tracks popularity closely (Spearman about 0.88-0.95 on the presets). Halves of one bill agree on where its crowd lives but are not identical (split-half Spearman of lift 0.71 for G1-A, 0.59 for G1-B, 0.73 for G2), and a bill of two unrelated acts falls below 0.5, so the split-half check has something to measure.
- Place affinity mixes preference match, popularity and noise, compressed to 0.55-0.99.
- Every random-looking number is a hash of the world seed, the request's canonical params and the entity or cell key. Same request, same body.

## Scenario knobs

| Knob | Default | Effect |
|---|---|---|
| `emptyCompare` | false | Compare returns empty `tags`, `a`, `b` (tag-diff fallback). |
| `thinHeatmap` | false | Every heatmap is thin: under 200 cells inside 40 km (widen-to-60 km path). Thin acts (the Tacoma comedians, the thin Hampton act) are always thin. |
| `quotaRemaining` | null | Fixed `x-month-ratelimit-remaining` (e.g. 1400, below the 1,500 floor); null = a constant 9,000, so a long-running fixture server never trips the month guard on a quota that does not exist. |
| `rateLimitOnce` | false | The first attempt of each distinct request answers 429 (`Retry-After: 0`). |
| `closedRate` | 0.04 | Share of generated places with `is_closed: true`. |
| `noHoursRate` | 0.03 | Share of generated places with no `hours`. |
| `deniedTags` | true | Denied example tags appear: an ethnicity tag on persons and in compare, inclusivity and credit-card tags on places, a keyword tag with a denied term in tag profiles. |
| `emptyBrands` | false | Brand insights return nothing. |

## Test

```sh
npx vitest run packages/qloo-world
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/qloo-world"
```

## Known limits

- The preference model is invented. It exercises the code paths and keeps bills distinct; it says nothing about real audiences, neighbourhoods or businesses. The heat constants were set so the presets show reproducible lift under the bounded score (Oct 14); they are not fitted to anything real.
- Field names and placement were checked against live bodies on Oct 15 (`packages/qloo-world/test/live-shapes.test.ts` pins them). Values, rankings and the not_found pair are invented. Not modelled: `query.measurements.audience_growth`, `properties.good_for`, `properties.locality`, `/search` rows missing `popularity`, duplicate tag names across namespaces in `/v2/tags`, and the artist-plus-person double listing of musicians on `/search`.
- Generated businesses are cached in memory per process. Places searches are capped at an 8 km bias radius.
- Venue points for The Truth and Super Funny are approximate (no public map point yet); Hampton Coliseum uses its OpenStreetMap point.
