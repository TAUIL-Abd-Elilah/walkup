# Mapping table: our fields to Qloo and back

One row per input or output of each Qloo call. Read left to right: a field on our side, the Qloo parameter or response field it maps to, the role it plays, the normalized field the rest of the code reads (types in [`packages/contracts`](../packages/contracts/src/index.ts)), and the package that owns the boundary.

**Roles.** `signal` shapes affinity. `filter` constrains what can be returned. `option` changes the response shape. `output` is a response field we read. `lookup` is a resolution input on `/search` or `/entities`.

**Boundaries.** Raw Qloo field names (`entity_id`, `query.affinity`, ...) exist only inside `@walkup/qloo`, which builds requests and normalizes responses to camelCase. Everything downstream reads the normalized types. Tag URNs come only from [`config/tags.json`](../config/tags.json); no free-text tag reaches a request at runtime.

| Call | Our field (source) | Qloo parameter or response field | Role | Normalized field | Boundary |
|---|---|---|---|---|---|
| **Q1** resolve acts | `Act.spotifyId` (Ticketmaster attraction `externalLinks.spotify`) | `GET /entities?external.spotify.ids=` | lookup | `Resolution.entity` | `tm` -> `qloo` |
| Q1 | `Act.name` | `GET /search?query=` | lookup | `Resolution.input` | `qloo` |
| Q1 | `Act.isComedian` (Ticketmaster classification) | `types=urn:entity:artist,urn:entity:person`, `take=5` | filter, option | n/a | `qloo` |
| Q1 | | `results[].entity_id`, `name`, `subtype` (`/search` returns `types[]` instead; the first `urn:entity:*` value is used), `popularity`, `disambiguation` | output | `QlooEntity.entityId`, `.name`, `.subtype`, `.popularity`, `.disambiguation`; `Candidate.*` | `qloo` |
| Q1 | | `results[].properties.short_description`, `properties.release_year`, `external` | output | `Candidate.shortDescription`, `.releaseYear`, `.externalUrl` | `qloo` |
| Q1 | | `results[].tags[]` (comedian tag check on persons) | output | `QlooEntity.tags`; admissibility per `config/tags.json` `personChecks` | `qloo` -> `engine` |
| Q1 | exact normalized-name match, or not | derived | output | `Resolution.status` (`exact`, `needs_input`, `proxy`, `unresolved`); `Envelope.status` | `qloo` |
| Q1 proxy | operator chooses "use a proxy" | `GET /search?types=urn:entity:movie,urn:entity:tv_show`; `properties.release_year` checked | lookup | `Resolution.proxy` `{entity, reason}` | `qloo` |
| **Q2** resolve venue | `Venue.name` | `GET /search?query=`, `types=urn:entity:place` | lookup | `Resolution` (role `venue`) | `tm` -> `qloo` |
| Q2 | `Venue.lat`, `Venue.lon` (Ticketmaster) | `filter.location=<lat>,<lon>`, `filter.radius=1` (miles) | filter | n/a | `qloo` |
| Q2 | | `results[].entity_id` (exact match only) | output | `Venue.qlooEntityId` (null: `POINT(lon lat)` fallback, "venue not in catalog yet") | `qloo` |
| **Q3** house set | venue's next 60 Ticketmaster events -> attraction Spotify IDs | `GET /entities?external.spotify.ids=` (batched) | lookup | `Resolution[]` (role `house`) | `tm` -> `qloo` |
| Q3 | unresolved headliners (at most 6) | typed `GET /search` | lookup | `Resolution[]` (role `house`) | `qloo` |
| Q3 | | `results[].entity_id` | output | house set: top 12 by recency and frequency | `engine` |
| Q3 | fewer than 5 resolved | pinned genre/category tag (`config/tags.json`) | signal | `liftMap.results.diagnostics.baseline = "tag"`; status `degraded` | `engine` |
| **Q4** bill heat | resolved bill entity IDs | `signal.interests.entities` | signal | n/a | `qloo` |
| Q4 | `Act.role` (headliner 1.0, co 0.6, support 0.3) | none: POST `{entity, weight}` returned 400 on Oct 15 (probe 14) and was removed; every call is a GET with plain ids | n/a | n/a | n/a |
| Q4 | `Venue.lon`, `Venue.lat` | `filter.location=POINT(lon lat)` | filter | n/a | `qloo` |
| Q4 | `OperatorInputs.radiusKm` (default 40) | `filter.location.radius=40000` (metres) | filter | n/a | `qloo` |
| Q4 | | `filter.type=urn:heatmap` | option | n/a | `qloo` |
| Q4 | | `results.heatmap[].location.geohash`, `.latitude`, `.longitude` | output | `HeatCell.geohash`, `.lat`, `.lon` | `qloo` |
| Q4 | | `results.heatmap[].query.affinity`, `.affinity_rank`, `.popularity` | output | `HeatCell.affinity`, `.affinityRank`, `.popularity` (percentiles within this response only) | `qloo` |
| **Q5** house heat | house set entity IDs | `signal.interests.entities` | signal | n/a | `qloo` |
| Q5 | | same heatmap fields as Q4 | output | `HeatCell[]` (house) | `qloo` |
| **Q6** generic heat | pinned `restaurant` tag (`config/tags.json`) | `signal.interests.tags` | signal | n/a | `qloo` |
| Q6 | | same heatmap fields as Q4 | output | `liftMap.results.diagnostics.spearmanLiftVsHeat` | `engine` |
| **Lift** (no call) | bill and house `HeatCell[]`, joined on geohash-6 | none | n/a | `LiftTile.lift`, `.billPct`, `.housePct`, `.popularityPct` | `engine` |
| Lift | gazetteer (Census places, OSM neighbourhoods) | none | n/a | `LiftTile.name`, `.zctas` | `gazetteer` |
| Lift | ACS adults per ZCTA | none | n/a | `LiftTile.adultPopulation`; top-tile floor; `budgetSplit` | `acs` -> `engine` |
| Lift | `OperatorInputs.alreadyReachedZips` (aggregate counts) | none (never sent to Qloo) | n/a | tile down-weight | `engine` |
| **Q7** demographics | bill entity IDs + house set IDs | `signal.interests.entities` | signal | n/a | `qloo` |
| Q7 | | `filter.type=urn:demographics` | option | n/a | `qloo` |
| Q7 | | `results.demographics[].entity_id` | output | `DemographicsBlock.entityId` | `qloo` |
| Q7 | | `results.demographics[].query.age.<bucket>` (six buckets) | output | `DemographicsBlock.age` (`AGE_BUCKETS`) | `qloo` |
| Q7 | | `results.demographics[].query.gender.male`, `.female` | output | `DemographicsBlock.gender` | `qloo` |
| Q7 | top 2 bill age buckets (only if the probe shows they move ranking) | none: `signal.demographics.age` was removed (probe 16 ran on a dropped seed, so it showed nothing); never sent | n/a | n/a | n/a |
| **Q8** compare | bill entity IDs | `a.signal.interests.entities` | signal | n/a | `qloo` |
| Q8 | house set entity IDs | `b.signal.interests.entities` | signal | n/a | `qloo` |
| Q8 | | `take=30` | option | n/a | `qloo` |
| Q8 | | `results.tags` | output | `CompareResult.shared` | `qloo` |
| Q8 | | `results.a`, `results.b` | output | `CompareResult.a` (copy-hook candidates after the allowlist), `CompareResult.b` | `qloo` -> `engine` |
| Q8 | generic or empty result | two `filter.type=urn:tag` calls, diffed by rank | output | `CompareResult.fromTagDiff = true`; status `degraded` | `engine` |
| **Q9** partners | resolved bill entity IDs | `signal.interests.entities` | signal | n/a | `qloo` |
| Q9 | `LiftTile.lon`, `LiftTile.lat` (top 3 tiles) | `filter.location=POINT(lon lat)`, `filter.location.radius=2000` (3500 on fallback) | filter | `Partner.tileGeohash`, `.tileName` | `engine` -> `qloo` |
| Q9 | category set from `config/tags.json` (`bar`, `restaurant`, `cafe`, `record_store`, `book_store`, `clothing_store`; `barber_shop`, `beauty_salon` if pinned; `soul_food` only when the operator selects it) | `filter.tags`, `operator.filter.tags=union` | filter | `Partner.category` | `qloo` |
| Q9 | `OperatorInputs.streetTeamDays` | `filter.hours=<weekday>` | filter | `Partner.hoursOnDay` (double-checked against `properties.hours`) | `qloo` -> `engine` |
| Q9 | fixed | `filter.price_level.max=3` | filter | n/a | `qloo` |
| Q9 | `Bill.legalAgeEnforced` not true (Ticketmaster `ageRestrictions`) | `filter.exclude.tags=<night_club URN>` | filter | n/a | `qloo` |
| Q9 | `Venue.qlooEntityId` | `filter.exclude.entities` | filter | n/a | `qloo` |
| Q9 | | `feature.explainability=true`, `take=50` | option | n/a | `qloo` |
| Q9 | | `results.entities[].entity_id`, `name`, `subtype`, `popularity`, `tags` | output | `Partner.entity` (`QlooEntity`) | `qloo` |
| Q9 | | `results.entities[].properties.address`, `.phone`, `.website`, `.hours`, `.price_level` | output | `Partner.address`, `.phone`, `.website`, `.hoursOnDay`; `QlooEntity.properties` | `qloo` |
| Q9 | | `results.entities[].properties.is_closed` | output | dropped when true; count shown on the card | `engine` |
| Q9 | | `results.entities[].location.lat`, `.lon`, `.geohash` | output | `QlooEntity.location` | `qloo` |
| Q9 | | `results.entities[].query.affinity` | output | `QlooEntity.affinity` (rank within this response only) | `qloo` |
| Q9 | | `results.entities[].query.distance` | output | `QlooEntity.distanceM` (tie-break) | `qloo` -> `engine` |
| Q9 | | `results.entities[].query.explainability["signal.interests.entities"][]` `{entity_id, score}` | output | `QlooEntity.explainability` (`ExplainContribution[]`); balance check | `qloo` -> `engine` |
| Q9 | | position in the response | output | `Partner.qlooRank` -> `Partner.score`; `Partner.chips[].ledgerRef = "Q9"` | `engine` |
| Q9 | [`config/chains.json`](../config/chains.json) (hand-kept chain names) | none | n/a | `Partner.chain` when `results.entities[].name` is on the list: listed after every local place of its area | `engine` |
| **Q9 popularity twin** | the pool's final request (after any widening), per pool that gave partners | the same `filter.*`, `operator.filter.tags` and `take=50`; no `signal.interests.entities`, no `feature.explainability` | filter | n/a | `qloo` |
| Q9 popularity twin | | `results.entities[]` order (popularity order, probe 1 / KG1, Oct 15) | output | `StreetSheet.popularityCheck` (`partners`, `notInPopularTop`, `perArea[]` with `ledgerRef`, `ledgerRefs`): partners not among the first k eligible places, k = partners in the area | `qloo` -> `engine` |
| **Q10** pre/post | resolved bill entity IDs | `signal.interests.entities` | signal | n/a | `qloo` |
| Q10 | `Venue.lon`, `Venue.lat` | `filter.location=POINT(lon lat)`, `filter.location.radius=1500` (2500 on fallback) | filter | n/a | `qloo` |
| Q10 | `restaurant`, `bar`, `cafe` from `config/tags.json` | `filter.tags` | filter | n/a | `qloo` |
| Q10 | `Bill.weekday` | `filter.hours=<show weekday>` | filter | n/a | `qloo` |
| Q10 | house set entity IDs (weekly twin call) | `signal.interests.entities` | signal | `PrePostSpot.deltaRank` | `qloo` -> `engine` |
| Q10 | | `results.entities[]` (as Q9) | output | `PrePostSpot.entity`, `.chips` | `qloo` |
| Q10 | `config/chains.json` | none | n/a | `PrePostSpot.chain`: chains go after the local spots before the list is cut to 8 | `engine` |
| Q10 | operator-editable capacities; attendance what-if | none | n/a | `PrePostSpot.expectedShare`, `.assumedCapacity` (load balancer) | `engine` |
| Q10 | `Bill.legalAgeEnforced` + category | none | n/a | `PrePostSpot.fanFacingAllowed` | `engine` |
| **Q11** declared partners | `DeclaredPartner.label` | `GET /search?query=` (pick list, typed) | lookup | `DeclaredPartner.qlooEntityId` (operator picks) | `apps/web` -> `qloo` |
| Q11 | `DeclaredPartner.qlooEntityId[]` | `filter.results.entities` | filter | n/a | `qloo` |
| Q11 | resolved bill entity IDs | `signal.interests.entities` | signal | n/a | `qloo` |
| Q11 | | `results.entities[]` order | output | `DeclaredPartnerScore.rank`, `.entity`, `.chips` | `qloo` -> `engine` |
| Q11 | partner not in the catalog | none | n/a | `DeclaredPartnerScore.rank = null` ("declared, not scored") | `engine` |
| Q11 | `DeclaredPartner.contactEmail` | never sent to Qloo | n/a | used only by the confirm-gated send | `apps/web` |
| **Q12** podcasts | resolved bill entity IDs | `signal.interests.entities` | signal | n/a | `qloo` |
| Q12 | `Venue.lon`, `Venue.lat` | `signal.location=POINT(lon lat)` | signal | n/a | `qloo` |
| Q12 | | `filter.type=urn:entity:podcast`, `feature.explainability=true`, `take=15` | filter, option | n/a | `qloo` |
| Q12 | | `results.entities[]` | output | `MediaPick` `{kind: "podcast"}`; `scope` is `local` only if the probe shows location moves ranking | `qloo` -> `engine` |
| **Q13** sponsor | resolved bill entity IDs; venue point | `signal.interests.entities`, `signal.location=POINT(lon lat)` | signal | n/a | `qloo` |
| Q13 | `Bill.legalAgeEnforced` not true | `filter.exclude.tags=<sponsorExclusions URNs>` | filter | n/a | `qloo` |
| Q13 | | `filter.type=urn:entity:brand`, `feature.explainability=true`, `take=15` | filter, option | n/a | `qloo` |
| Q13 | | `results.entities[]` (denylist applied to tags) | output | one `MediaPick` `{kind: "sponsor"}`, or `empty` | `qloo` -> `engine` |
| **Q14** copy allowlist | resolved bill entity IDs | `signal.interests.entities` | signal | n/a | `qloo` |
| Q14 | | `filter.type=urn:tag`, `filter.tag.types=urn:tag:keyword:media,urn:tag:genre:music,urn:tag:theme:qloo,urn:tag:audience:qloo` | filter | n/a | `qloo` |
| Q14 | | `diversify.by=subtype`, `take=30` | option | n/a | `qloo` |
| Q14 | | `results.tags[].tag_id`, `.name`, `.types`, `.subtype` | output | `QlooTag[]` allowlist (after `DENIED_TAG_PREFIXES`, `DENIED_TAG_KEYWORDS`) | `qloo` -> `engine` |
| Q14 | denied tags removed | none | n/a | `GuardReport.deniedTagCount` | `engine` |
| Q14 | allowlist + partners' ambience/good_for tags | none | n/a | `CopyHook.tagIds` (every ID on the allowlist) | `narrator` -> `engine` guard |
| **Q15** audiences (removed) | operator-declared segment text | none: `GET /v2/audiences` returned nothing for both test queries (probe 17), so the client has no audiences call and `signal.demographics.audiences` is never sent | n/a | n/a | n/a |
| **Q16** tag pinning (build time) | `config/tags.json` `categories[].query` | `GET /v2/tags?filter.query=`, `feature.semantic_search=true` | lookup | candidates for review | `config` |
| Q16 | | `results.tags[].id`, `.name` | output | `config/tags.json` `categories[].urn`, `status`, `pinnedAt`, `validatedRows` | `config` |
| **Every call** | request | method, path, params (key as `$QLOO_API_KEY`) | n/a | `LedgerEntry` (`id`, `endpoint`, `params`, `httpStatus`, `envelopeStatus`, `latencyMs`, `bytes`, `cacheHit`, `resultCount`, `curl`) | `qloo` |
| Every call | | response header `x-month-ratelimit-remaining` | output | month guard (fresh runs stop below 1,500) | `qloo` |

## Never sent to Qloo

Operator contact emails, "already reached" ZIP counts, viewer data of any kind, free-text tags, and anything the operator typed other than the show, the venue, the date, partner names (for the pick list) and a declared group-sales segment (Q15, only when enabled).
