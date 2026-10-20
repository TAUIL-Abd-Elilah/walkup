# @walkup/qloo

The only module in Walkup that talks to Qloo. It owns the connection rules
(host, key header, rate limit, retries, month quota guard), the private response
cache, the provenance ledger, fixture record/replay, typed request builders and
the normalizers that turn raw Qloo bodies into `@walkup/contracts` shapes.

Server-side only. The key is read from `QLOO_API_KEY` and sent only as the
`X-Api-Key` header to `https://hackathon.api.qloo.com`.

## Quick start

```ts
import { createQlooClient, toEnvelope, errorEnvelope } from "@walkup/qloo";
import { createMemoryLedger } from "@walkup/contracts";

const qloo = createQlooClient();                 // config from env
const run = qloo.withLedger(createMemoryLedger()); // one ledger per plan run

const act = await run.resolveExact("Sidecar", ["person", "artist"], { requireComedianTag: true });
if (act.status === "exact") {
  try {
    const heat = await run.heatmap({ signalEntities: [act.entity!.entityId], point: { lat: 36.16, lon: -86.78 }, radiusM: 40000 });
    const card = toEnvelope(heat, "Where this bill's crowd is", ["Percentiles within one response."]);
  } catch (err) {
    const card = errorEnvelope(err, [], "Where this bill's crowd is"); // degraded / error with the ledger ref
  }
}
```

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `QLOO_API_KEY` | none | Key for the hackathon host. Never logged; ledger and curl show `$QLOO_API_KEY`. |
| `QLOO_BASE_URL` | `https://hackathon.api.qloo.com` | Any other host is refused with `QlooHostRefusedError`... |
| `QLOO_ALLOW_HOST` | unset | ...unless this is `1` (local mock servers only). |
| `WALKUP_MODE` | `auto` | `auto` = live when a key is present, else fixture. `live` without a key is a `QlooConfigError`. |
| `WALKUP_DATA_DIR` | `./.cache` | Private SQLite cache: `<dir>/qloo-cache.sqlite` (git-ignored). |
| `WALKUP_RECORD` | unset | `1` in live mode writes bodies to `fixtures/raw/<sha256>.json` (git-ignored). |
| `WALKUP_FIXTURES_DIR` | nearest `fixtures/` above the cwd | Where `raw/` and `synthetic/` live. |
| `QLOO_MONTH_GUARD_FLOOR` | `1500` | Fresh calls stop when `x-month-ratelimit-remaining` is below this. |

## Client methods

All methods return `QlooResult<T>`: `{ value, status: "ok" | "empty", reason?, ledgerRef, ledgerRefs, cacheHit, source, synthetic, meta? }`.
Failures throw typed errors (below) after writing their ledger entry. `meta` carries `skipped`, the response-level
`explainability` (as returned), `warnings` (top-level `warnings[]`) and `droppedSignals` (signal ids Qloo ignored as
not_found; see "Signals Qloo has no data for").

| Method | Endpoint | Params sent | Returns (`value`) |
|---|---|---|---|
| `search(query, types, {location, radiusMiles, take, sortBy, page})` | `GET /search` | `query`, `types` (URNs; `videogame`), `filter.location=<lat>,<lon>`, `filter.radius` (miles, max 100), `take` (default 10), `sort_by`, `page` | `QlooEntity[]` from flat `results[]`; HTTP 404 = empty |
| `entitiesByIds(ids)` | `GET /entities` | `entity_ids` (batches of 50, one ledger entry each) | `QlooEntity[]` |
| `entitiesByExternal(ns, ids)` | `GET /entities` | `external.<ns>.ids` (spotify, imdb, wikidata, ... batches of 50) | `{ entities, matches: {externalId, entityId}[], missing }` |
| `insights(params, {signalEntities?})` | `GET /v2/insights` | any params; `filter.type` required (`video_game`); `take` capped at 50; `output.heatmap.boundary=city\|neighborhood` refused | `{ kind, entities, heatmap, demographics, tags }` |
| `heatmap({signalEntities \| signalTags, point, radiusM})` | `GET /v2/insights` | `filter.type=urn:heatmap`, `filter.location=POINT(lon lat)`, `filter.location.radius` (m), `signal.interests.entities` and/or `signal.interests.tags` | `HeatCell[]` from `results.heatmap` (`affinityRank` is the 0-1 fraction Qloo sends). Live bodies have no response-level `query` (no localities). |
| `demographics(entityIds, {signalTags?})` | `GET /v2/insights` | `filter.type=urn:demographics`, `signal.interests.entities`, `signal.interests.tags` | `DemographicsBlock[]` (one per signal) |
| `placeInsights({signalEntities, point, radiusM, tags, operator, hours, priceMax, excludeTags, excludeEntities, take, explainability, resultsEntities})` | `GET /v2/insights` | `filter.type=urn:entity:place`, `signal.interests.entities`, `filter.location=POINT(lon lat)`, `filter.location.radius`, `filter.tags`, `operator.filter.tags`, `filter.hours`, `filter.price_level.max` (1-4), `filter.exclude.tags`, `filter.exclude.entities`, `filter.results.entities`, `feature.explainability`, `take` (max 50) | `QlooEntity[]` with `affinity`, `distanceM`, `explainability`; `meta.explainability` (aggregate, as returned) |
| `entityInsights(type, {signalEntities, signalLocationPoint, excludeTags, take, explainability})` | `GET /v2/insights` | `filter.type=urn:entity:<type>`, `signal.interests.entities`, `signal.location=POINT(lon lat)`, `filter.exclude.tags`, `feature.explainability`, `take` | `QlooEntity[]` |
| `tagProfile({signalEntities, tagTypes, diversifyBySubtype, diversifyTake, take})` | `GET /v2/insights` | `filter.type=urn:tag`, `signal.interests.entities`, `filter.tag.types`, `diversify.by=subtype`, `diversify.take`, `take` | `RankedTag[]` (`rank`, `affinity`) |
| `compare(a, b, take)` | `GET /v2/analysis/compare` | `a.signal.interests.entities`, `b.signal.interests.entities`, `take` (max 50) | `CompareResult` (`shared` = `results.tags`, `a`, `b`; `fromTagDiff: false`). Qloo ignores `take` here, so each list is cut to `take` client-side. |
| `tagsSearch(query, {parentsTypes, semantic, typoTolerance, tagTypes, take})` | `GET /v2/tags` | `filter.query`, `filter.parents.types`, `feature.semantic_search`, `feature.typo_tolerance`, `filter.tag.types`, `take` | `RankedTag[]` (`popularity`, `parents`) |
| `resolveExact(name, types, {requireComedianTag, nearPoint, radiusMiles, take, role, checkSignalAt, aliases})` | `GET /search` (+ one signal check with `checkSignalAt`) | as `search`; with `nearPoint`: `filter.location` + `filter.radius=1` | `Resolution`: `exact` (with `replaced` when a not_found pick was swapped), `needs_input` (<= 5 `Candidate`s), or `unresolved` (with `reason`) |
| `resolveUsable(name, entities, {...as resolveExact, ledgerRef})` | the signal check only | for entities already fetched (e.g. the orchestrator's own `/search`) | `Resolution`, same rules as `resolveExact` |
| `checkSignals(ids, point, {radiusM})` | `GET /v2/insights` (one call per 25 ids) | `filter.type=urn:entity:place`, the ids as `signal.interests.entities`, `filter.location=POINT` (1,500 m), `take=1` | `SignalCheck`: `{ checked, usable, dropped, ledgerRefs, ledgerRefById, cacheHit }` (`ledgerRefById[id]` is the batch call that judged that id) |
| `request(req, {fresh})` | any | a `QlooRequest` from a `build*` function | raw parsed body + ledger ref |

Other members: `withLedger(sink)` (a view with its own ledger that shares cache, quota and in-flight
requests), `quota()`, `guardTripped()`, `resetQuota()` (after a limit raise), `mode`, `close()`.

### Request rules baked into the builders

- WKT is `POINT(lon lat)`; `/search` takes `lat,lon` and a radius in miles; insights radii are metres.
- `filter.type` uses `video_game`; `/search` `types` uses `videogame`.
- Tag parameters accept pinned URNs only (`urn:tag:...`); free-text tags throw.
- Heatmaps need a signal (Qloo answers 400 without one), so the builder throws first.
- Every call is a GET with plain entity ids. `POST /v2/insights` with `{entity, weight}` objects returned 400 on
  Oct 15 (probe 14), so the client has no POST path and nothing weights one act against another (the probe script
  keeps its own weighted POST request to re-test it).
- Arrays are de-duplicated and joined with `,` in the order given.

## Connection behaviour

- **Rate limit:** one process-wide token bucket, 3 requests/s, burst 1 (calls about 334 ms apart).
- **Retries:** at most 2 on 429, 5xx and network errors; exponential backoff (500 ms base, 8 s cap) with
  equal jitter; `Retry-After` honoured. No retry once a 429 reports the month at 0.
- **Month guard:** `x-month-ratelimit-remaining` / `-limit` are read on every response and remembered in the
  cache's meta table for the current UTC month. Below the floor, fresh calls throw `QlooQuotaGuardError`;
  cached answers are still served. A remembered quota is forgotten when the UTC month changes (also in a
  long-running process), so the next fresh call reads the new month's headers.
- **Cache:** SQLite (better-sqlite3), keyed by the canonical request
  (`GET path?sorted params`). TTL by request class: search, entities and tags 30 days; insights, heatmaps and compare 7 days. Errors are not cached; a `/search` or
  `/entities` 404 is cached as empty. `fresh: true` skips the read. Identical concurrent requests share one call.
- **Ledger:** every call, including cache hits, refusals and failures, adds one `LedgerEntry`
  (`Q1`, `Q2`, ...): endpoint, params (key redacted), HTTP status, envelope status, latency, bytes,
  cache hit, result count, copy-as-curl with `"X-Api-Key: $QLOO_API_KEY"`, and a note (retries, cache date,
  fixture origin, not_found drops, guard).
- **Fixtures:** file name = `sha256(canonical key).json` (`fixtureFileName(req)`). Live mode with
  `WALKUP_RECORD=1` writes `fixtures/raw/`. Fixture mode reads `fixtures/raw/`, then
  `fixtures/synthetic/`; synthetic files must have `"synthetic": true` at the top level or they are ignored.
  `syntheticFixtureFor(req, body)` produces a correctly named, labelled synthetic file. A missing fixture
  throws `QlooFixtureMissingError`.

## Errors

| Error | When | `errorStatus(err).status` |
|---|---|---|
| `QlooHttpError(status, bodySnippet, endpoint, qlooErrors)` | non-2xx after retries, or a non-JSON 2xx. `qlooErrors` is the parsed `{"errors":[{message, path}]}` body; `signalNotFound` (and `isSignalNotFoundError(err)`) is true for a 400 that blames `signal.interests.entities` (every signal id unknown) | `error` (reason says no taste data for any act sent) |
| `QlooQuotaGuardError(remaining, floor)` | month guard refused a fresh call | `degraded` |
| `QlooFixtureMissingError(hash, key)` | fixture mode, nothing recorded for this request | `degraded` |
| `QlooHostRefusedError(host)` | `QLOO_BASE_URL` is not the hackathon host | `error` |
| `QlooNetworkError` | network failure after retries | `error` |
| `QlooConfigError` | e.g. live mode without a key; tests without an injected fetch | `error` |

Every error thrown by a call carries `ledgerRef`. `errorEnvelope(err, empty, summary)` turns one into a card envelope.

## Normalizers

Pure and defensive: an unknown shape gives an empty value plus `reason`; missing optional fields never throw;
rows missing a required field are skipped and counted (`meta.skipped`).

| Raw shape | Function | Output |
|---|---|---|
| `/search`, `/entities` flat `results[]`; insights `results.entities[]` | `normalizeEntityList` | `QlooEntity[]`: `subtype` (from `subtype` or `types[]`), `popularity`, `affinity` (`query.affinity`, null without a signal), `tags`, projected `properties` (address, hours, phone, website, price_level, is_closed, short_description, business_rating, release_year, image URL, geocode, and `zip` from `properties.localities`), `location`, `distanceM` (`query.distance`, metres), `explainability` (`query.explainability["signal.interests.entities"]`), `external` (top-level `external` on insights rows, `properties.external` on `/search` and `/entities` rows), `disambiguation` |
| `results.heatmap[]` | `normalizeHeatmap` | `HeatCell[]` (lat/lon decoded from the geohash when absent) |
| `results.demographics[]` | `normalizeDemographics` | `DemographicsBlock[]` (six age buckets, gender; a signal tag's block has the tag URN as `entity_id`) |
| compare `results.tags / a / b` | `normalizeCompare` | `CompareResult` (`query.count` strings become numbers) |
| `/v2/tags` and `urn:tag` `results.tags[]` | `normalizeTagList` | `RankedTag[]` |
| any 2xx: top-level `warnings[]` | `responseWarnings`, `droppedSignalIds`, `responseMeta` | `QlooWarning[]` (`{type, param, ids}`), the not_found signal ids, and the `meta` fields above |
| 4xx `{"errors":[{message, path}]}` | `parseQlooErrors` | `QlooErrorDetail[]` |

### Live shapes (shape audit, Oct 15)

Checked against recorded live bodies; `test/recorded.test.ts` replays every body in `fixtures/raw/` (git-ignored) through
these rules and skips when there are none.

- `/search` and `/entities` rows: `types[]` (no `subtype`), external ids under `properties.external.<ns> = {id}`
  (spotify, wikidata, imdb, musicbrainz, lastfm `{id, listeners, scrobbles}`, google_place `{id, place_id}`); tag refs
  `{tag_id, name, type, value}` whose `type` can be coarser than the id's namespace (use the id); places have
  `location {lat, lon}` without a geohash and no `query.distance`. One Spotify id can come back on two entities (an
  artist and a person); the first in Qloo's order is the match.
- Insights entity rows: `type` + `subtype`, top-level `external.<ns> = [{id, ...}]`, tag refs `{id, name, type, weight}`,
  `location.geohash` 12 characters, `properties.neighborhood` always null (use `zip`), `properties.localities[]`
  (`{name, place: ZCTA|city|county|metro|state|region, boundary, locality_id, admin_level}`), `business_rating` a number,
  hours `{<weekday>: [{closed, opens: "T10:00:00" | null, closes}]}`, `query.measurements.audience_growth` (signed, not
  projected). `query.affinity` is 0-1 but bunched near the top (0.93-0.98 on places): rank within one response only.
- Per-row `query.explainability["signal.interests.entities"][] {entity_id, score}` scores are shares that sum to 1 per
  row, not strengths. The response-level `query.explainability["signal.interests.entities"]` is
  `{effect_on_all_recs | effect_on_top3_recs | effect_on_top5_recs | effect_on_top10_recs: [{entity_id, avg_score}]}`.
- Heatmaps: top-level `success` and `results` only; each cell `location {geohash (6), latitude, longitude}` and `query
  {affinity, affinity_rank (0-1 fraction), popularity, entity_artist_affinity, entity_artist_affinity_rank}` (the
  `entity_artist_*` pair is ignored).
- `urn:tag` profiles: `{tag_id, name, subtype (namespace), types[] (entity types), tag_value, popularity, query.affinity}`.
  With `diversify.by=subtype` Qloo caps each namespace at 5 tags unless `diversify.take` is sent (take 30 gave 20 rows).
  Without `filter.tag.types` a profile returns denied place namespaces (credit_card, inclusivity, ...) and is nearly flat.
- `/v2/tags`: `{id, name, type, parents[{type}], popularity, properties{is_canonical, akas}}`; the wanted URN is not
  always the first row (prefer `category:place` / `genre:place` and `is_canonical`).
- Compare: `results.tags[]` `{tag_id, entity_id, name, type: "urn:tag", subtype, popularity, query.score}`, `a[]`/`b[]`
  with `query.count` as a string, plus `matchEntities` and `duration`; no `success`.

## Resolution

`resolveExact` / `resolveFromEntities` compare names after `normalizeName` (casefold, strip diacritics and
punctuation, `&` to `and`, drop a leading "the"). Exactly one admissible exact match resolves. Several exact
matches (for example a comedian and a band both named "Sidecar"), or no exact match, give `needs_input` with up
to five candidates (exact first: subtype, popularity, short description, release year, one Wikidata/IMDb/Spotify
link). No results give `unresolved`. With `requireComedianTag`, only matches tagged
`urn:tag:genre:person:comedian` or `urn:tag:occupation:person:comedian` are admissible.

Live `/search` lists most musicians twice under one exact name: an artist entry and a person entry (Oct 15: Chris
Stapleton, Kendrick Lamar, Jason Isbell), and sometimes one entity id under both types. An id listed twice counts once.
An artist plus a person that are the same act (`sameAct`: the person has a musician tag such as
`urn:tag:genre:person:musician` or `urn:tag:occupation:person:singer`, or the two share a Spotify, MusicBrainz or
Wikidata id) resolve to the artist entry instead of asking. Comedy (`requireComedianTag`) is unchanged.

### Signals Qloo has no data for (not_found)

Qloo can list an entity under `/search` and still have no taste data for it (Oct 15: the "Jason Isbell" artist entry;
"Jason Isbell and The 400 Unit" works). Sent as a signal:

| Call | What Qloo does with that id |
|---|---|
| place, brand, podcast and other entity insights | 200, ranks without it, and adds a top-level `warnings: [{"type": "not_found", "signal.interests.entities": [ids]}]` |
| heatmap | drops it with no warning; with only not_found ids left it is still a 200 with cells (probe 2: the not_found id alone gave 814 cells), so a heatmap never tells whether a seed was usable. Only a malformed id is a 400 `{"errors":[{"path":"signal.interests.entities"}]}` |
| entity insights with no usable id and no other signal or filter | 400 on `signal.interests.entities` (with `signal.location` it is a 200 ranked by location alone, plus the warning) |
| tag profile, compare | drops it with no warning |
| demographics | still returns a block for it |

The client never lets that pass silently: every 2xx with not_found ids adds a ledger note ("Qloo ignored N signal id(s)
it has no taste data for (not_found): ...") and marks the entry `partial`, and the insights-family methods put the ids
in `meta.droppedSignals`. A 400 on `signal.interests.entities` is a `QlooHttpError` with `signalNotFound`.

Because heatmaps, tags and compare drop silently (a heatmap built on nothing but not_found ids still answers 200 with
cells), validity comes only from the insights check, never from a heatmap: `checkSignals(ids, point)` sends one
place-insights call (`take=1`, 1,500 m) and splits `usable` from `dropped`. `resolveExact(..., { checkSignalAt })` and
`resolveUsable` run it for acts (never venues) over the pick plus up to five fallback entries from the same search, in
tiers: other exact matches of the pick's subtype, then `aliases`, then billing names ("<name> and ...", "<name> with
..."), then exact matches of another subtype. The first tier with a usable entry decides: one entry resolves `exact`
with `replaced: {entityId, name, reason: "not_found", ledgerRef}`; several give `needs_input` with a `reason`; none give
`unresolved` with a `reason`. `needs_input` candidates Qloo reports as not_found are removed. Cost: one call per 25 ids
checked; a 200 answer is cached 7 days like other insights, a 400 is not cached (the next run asks again).

## Testing

```sh
npx vitest run packages/qloo
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/qloo"
```

Tests never touch the network: they inject a mock `fetch` (the client refuses the global `fetch` under vitest
in live mode), use `':memory:'` SQLite and in-memory fixture stores, and use synthetic bodies in
`test/synthetic.ts` (each marked `synthetic: true`, fake ids, invented values).

## Known limits

- Live parameter checks (Oct 15). Honoured: insights `filter.location.radius` (places within 3.9 km of 4 km; heatmap cells
  within 39.6 km of 40 km), `filter.price_level.max`, `operator.filter.tags=union`, `filter.hours`, `filter.tag.types`,
  `diversify.by`, `feature.explainability` (absent unless asked), `filter.results.entities`, `/search` `filter.location`
  `lat,lon` with `filter.radius` in miles, `/entities` keeps id order. No effect: compare `take` (cut client-side);
  `take` beyond the `diversify.by` cap. Removed from the client (never sent): POST weighted signals (400),
  `filter.results.entities.query` (400), `/v2/audiences` (`filter.query` always empty, so no URN to use) and
  `signal.demographics.age` (its probe used a dropped signal, so it showed nothing). Unverified: `filter.exclude.tags`
  and `filter.exclude.entities` (no control call yet).
- Podcast and brand insights do not need `signal.location`: the Oct 15 400s came from a not_found seed (a brand call
  with a usable id and no location answered 200).
- The client does not apply the tag denylist: tags pass through as returned. The engine's guard filters
  denied namespaces before anything reaches copy, chips or stored plans.
- Fixture mode reads only fixture files, not the SQLite cache.
- `better-sqlite3` is a native module: a Next.js app must list it in `serverExternalPackages` and import this
  package from server code only.
- Heatmap affinity and popularity are percentiles within one response; compare runs by rank, never by raw value
  across calls.
