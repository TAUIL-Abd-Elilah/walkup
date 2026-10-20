# @walkup/engine

Pure, deterministic TypeScript where Qloo results become decisions. No I/O, no network, no clock, no `Math.random` (a test enforces this). Same input, same output.

Qloo decides what is relevant; this package decides what goes on the Street Sheet: which tiles, which partners, how the pre/post crowd spreads out, how the budget splits, and which narrated lines survive the guard.

## Public API

Everything is exported from `src/index.ts`.

### Geohash and lift

| Function | What it does |
|---|---|
| `aggregateToGeohash6(cells)` | Heatmap cells (precision 6-7) to geohash-6 tiles: mean affinity, mean affinityRank, mean popularity, centroid, member count. Drops cells with a non-finite affinity or no usable location. Sorted by geohash. |
| `pctRankMap(cells, field)` | Percentile rank in (0, 1] within one map (average rank / n; ties share a rank). |
| `computeLiftAll(bill, house, opts)` | Every joined tile with its lift, sorted (lift desc, billPct desc, popularityPct desc, geohash asc). |
| `selectTopTiles(all, opts)` / `computeLift(bill, house, opts)` | Top tiles only. |
| `computeLiftMap(bill, house, opts)` | One call: `{ all, top, diagnostics, coverage }`. |
| `liftDiagnostics(tiles, rawHeat?)` | Spearman(lift, raw heat) and the `liftWeak` flag. |
| `liftScore(billPct, housePct, { smoothing, weight })`, `liftBounds(smoothing)`, `liftMethod(opts)` | The bounded score for one tile, its range, and the one-line description the lift card shows (`SheetLiftDiagnostics.method`). |
| `splitHalves(items, key)` | Two disjoint halves of a seed list, the same way every time (distinct keys in FNV-1a order, dealt alternately; the first half gets the odd one). |
| `splitHalfAgreement({ billA, billB, houseA, houseB }, opts)` | Lift per half, then Spearman between the two halves on the tiles they share: `{ spearman, n, threshold, pass }`. |
| `geohashPolygon`, `geohashCenter`, `toGeohash6`, `haversineM` | Small helpers for maps and distances. |

**Lift formula** (per geohash-6 tile present in both maps): a smoothed log ratio of the two percentile ranks.

```
billPct  = pct_rank(mean bill affinity)    over the joined tiles
housePct = pct_rank(mean house affinity)   over the joined tiles
score    = ln((billPct + a) / (housePct + a))       a = smoothing, default 0.5
popPct   = pct_rank(popularity)            over the joined tiles (popularity = min of the two maps by default)
w        = min(1, popPct / shrinkTau)      (w = 1 when shrinkTau <= 0)
lift     = exp(w * score)
```

Defaults: `smoothing` 0.5, so lift stays inside [1/3, 3] (in general [a / (1 + a), (1 + a) / a]); `shrinkTau` 0.25 (tiles in the bottom quarter of popularity are pulled toward 1, fully at popPct 0). Lift is 1 where both crowds rank a tile the same, above 1 where this bill's crowd ranks it higher, and swapping bill and house inverts it exactly. Affinities are compared only as percentile ranks inside one response. `rankOver: "full"` ranks over each whole map instead of the joined tiles.

Why bounded: Qloo heat affinity tracks popularity closely (other teams measured r 0.92-0.98), so most of the difference between two maps sits in the tail where the house percentile is small. The old ratio with a 0.05 floor turned that tail into large numbers: a tile at 0.55 against 0.08 scored 6.9 and outranked one at 0.98 against 0.60 (1.6). With the smoothing they score 1.81 and 1.35, and the bill floor keeps the first off the top list.

**Top tiles**: `lift >= minLift` (1.3) and `billPct >= minBillPct` (the bill floor, 0.7 by default: this crowd has to actually be there; pass 0 to turn it off), and when an `adultPopulation(tile)` lookup is injected, adults `>= minAdults` (500; unknown counts are kept unless `unknownAdults: "drop"`). Optional `maxTiles`.

**Diagnostics**: Spearman(lift, raw heat) over the joined tiles. Raw heat is the bill's own heat, or a baseline heatmap passed as `rawHeat` (for example a generic restaurant-tag heatmap). `liftWeak` is true above 0.9: lift is roughly density, so rank partners near the venue instead. `insufficient` is true with fewer than 3 tiles.

**Split-half check**: split the bill's seeds and the house's seeds into two disjoint halves each (`splitHalves`), get a heatmap per half, compute lift for half 1 (bill half 1 against house half 1) and half 2, and take Spearman between the two lift maps on the tiles both share (`splitHalfAgreement`; null with fewer than 3). Above 0.5 (`LIFT_DEFAULTS.minSplitHalf`) the map holds up when half the evidence is taken away; at or below it, the map is mostly noise. A genre-tag house cannot be split: pass the same house map for both halves. The orchestrator runs it on every bill with at least two seeds and records it on the lift card.

### Probe evaluators

| Function | Pass criteria |
|---|---|
| `evaluateKG1(venues, opts)` | Per venue: Kendall tau(bill A, bill B) < 0.8, top-8 overlap(A, B) <= 5, and top-8 overlap(each bill, popularity) <= 5. All venues must pass (`requireAll: false` for a majority). |
| `evaluateKG2({ house, generic, bills }, opts)` | Spearman(lift, raw heat) < 0.8 for both bills, Jaccard of the two bills' top-decile lift tiles < 0.5, and for both bills the split-half Spearman > 0.5 (each bill passes `halves: { billA, billB, houseA?, houseB? }`; house halves default to the full house). A bill without halves fails ("split-half check not run") unless `requireSplitHalf: false`. |

Both return the numbers and a list of failure strings.

### Statistics

`spearman`, `kendallTau` (tau-b), `pearson`, `kendallTauRankings` / `spearmanRankings` (over shared ids), `jaccard`, `topK`, `topKOverlap`, `permutationTest` (seeded, `(count + 1) / (iterations + 1)` p-value, custom statistic), `mulberry32`, `seedFromString`.

P2 helpers: `meanPairwiseJaccard`, `listDistance`, `chanceTopKOverlap` (k^2 / N), `tasteDependence` (one-sided permutation test of Q-vs-S distances against Q-vs-Q; `decorative: true` when not significant), `stabilityAboveChance`, `groundingRates`.

Comparing two place lists (written for the Google Places comparison arm, which was removed from the product on Oct 20 2026; nothing in the product calls these now): `compareArms` (overlap, only-A, only-B, Jaccard, top-k overlap, tau), `nameSimilarity`, `matchPlaces` (name similarity >= 0.85 and <= 150 m, one-to-one).

### Partners

`scorePartners(pools, tiles, opts)` returns `Partner[]`; `scorePartnersWithReport` also returns counts (dropped closed, hours-closed, excluded, duplicates, swaps, per tile, `belowMinimum`).

```
rank_score  = 1 - (qlooRank - 1) / n     n = size of that Qloo response
tile_weight = tile.lift / maxLift         pools without a known tile use lift 1
score       = rank_score * tile_weight * (1 - ubiquity_penalty)
```

**Ubiquity penalty** (`ubiquityPenalty`, `UBIQUITY`). Applied only when the pool carries a house twin (`PartnerPool.house`: the same request with the room's usual crowd as the signal). A place that ranks as high for the usual crowd as for this bill is generic for this room:

```
bill_pos  = 1 - (qlooRank - 1) / n
house_pos = 1 - (houseRank - 1) / n_house          0 penalty when the place is not in the house list
u         = clamp(1 - (bill_pos - house_pos) / span, 0, 1)      span 0.5
ubiquity_penalty = maxPenalty * u                                maxPenalty 0.5
```

A place at least half a list higher for this bill than for the house keeps its full score; one at least as high for the house loses half of it; in between, linearly. The penalty never rises when the house ranks the place lower. Each partner from a twinned pool records `houseRank` (null when not in the twin's list) and `ubiquityPenalty`; the report counts `penalized` picks. The diversity caps are unchanged.

- One greedy pass in score order; ties by distance, then Qloo rank, then entity id.
- At most 2 per category per tile, 8 per tile, 25 overall. A tile whose picks are all bars swaps its lowest-scored bar for its best eligible non-bar. Fewer than 15 sets `belowMinimum` (widen the radius or categories upstream).
- Dropped: no id, excluded ids (the venue), excluded categories (`excludeCategories`, e.g. bars on an all-ages show; counted as `droppedCategory`), `is_closed`, and places whose `properties.hours` say they are closed on the street-team weekday. Unknown hours are kept.
- Category: `categoryOf`, then the pinned `categoryTags` map, then the first `urn:tag:category:place:<key>` tag, else `"other"`. Bar-like categories are configurable.
- Chips: one per partner tied to the pool's ledger id, plus anything `extraChips` returns.
- Output grouped by tile in lift order (`order: "score"` for global order).
- **National chains** (`opts.chains`, a hand-kept list; see below). A candidate whose name is on the list sorts after every non-chain candidate, ahead of score, in the greedy pass, the non-bar swap and the listed order. Its score is unchanged and the caps still apply, so a chain is kept only for a slot no local place can fill. Each kept chain records `chain: true`. The report counts `chains` (eligible chain candidates), `chainsKept`, and `chainsMovedDown`: chains on the list the same pass makes without the rule that are now off it, or listed after a lower-scored local place of their area; `chainsOffList` names the ones now off it. Without `chains` nothing changes.

**Chain matcher** (`chains.ts`: `isChain(name, list)`, `chainOf`, `compileChains`, `normalizeChainName`). Pure; the list is passed in (config/chains.json in the product). Both sides are compared after the same normalization: accents stripped, lower case, apostrophes and periods removed ("Dunkin'" is "dunkin", "T.J. Maxx" is "tj maxx"), `&` and `+` read as "and", other punctuation a space, a leading "the" dropped. A place matches a brand name or alias when its words equal the brand's words or start with them ("Starbucks Coffee Company", "Potbelly Sandwich Shop", "Outback Steakhouse Tysons"). An entry marked `exact` (a common word or a town: "Target", "Gap", "Burlington") matches only the whole name, the name with a trailing store number, or the part before " - ", " | ", " @ ", "(" or ",". Matching is on whole words, so "Jerry's Seafood", "The Hill Cafe", "Stable DC", "Hush Harbor" and "Pho Deluxe Tysons" match nothing. A chain that is not on the list is treated as local.

`hoursOnDay(hours, weekday)` reads opening hours leniently: day-keyed objects (`{"Monday": [{"opens": "T11:00", "closes": "T23:00"}]}`, strings, booleans), arrays like `"Monday: 11 AM-2 AM"`, free text (`"Mon-Fri 11am-2am; Sat, Sun 10am-2am"`, `"Daily 7-3"`, OSM `"Mo-Fr 09:00-17:00; Su off"`), Google `weekdayDescriptions` / `periods`, rows with a `day` field, and JSON strings. It returns `open` (with text), `closed` or `unknown`. "Closed" needs explicit evidence; any shape it does not recognise is `unknown`, never `closed`.

`rankDeclaredPartners(declared, scoredEntities, { ledgerRef })`: the operator's list in Qloo call order. Entries with no entity, or not returned by Qloo, get `rank: null` ("not in Qloo's catalog, kept in your order") and follow in the operator's order.

### Pre/post block, load balancing and budget

- `buildPrePostSpots(entities, opts)`: drops closed and excluded places, keeps up to 8 in Qloo order (with `opts.chains`, the spots on the chain list go after the local ones before the cut, marked `chain: true`, and the report counts `chainsMovedDown` and names `chainsOffList` as for partners; load-balancing weights still follow Qloo's rank), adds the delta rank against the house-signal twin (`houseRank - billRank`, positive = more "tonight"), applies the fan-facing rule (bars only when Ticketmaster's `legalAgeEnforced` is true) and load-balances.
- `loadBalance(spots, attendance, { outingRate })`: water-fill proportional to weight, never above `assumedCapacity`; integer counts by largest remainder with ties broken by higher weight, then entity id. Reports `placed` and `unplaced`.
- `budgetSplit(tiles, adults21, minShare)`: share proportional to lift x adults 21+, with a minimum per tile, summing to 1. Every row carries the label `"heuristic, not a forecast"`.
- `seedInfluence` / `balanceCheck` / `mergeRankedLists`: the self-correction check (one seed above 0.7 of explainability influence, or the headliner alone reproducing 7 of the top 8) and a weighted Borda merge for the rebalanced re-query.

### Policy

- `isDeniedTag(tag)`: contract prefixes and keywords, plus engine additions (`urn:tag:politic*`, `urn:tag:religio*`, `urn:tag:ethnic*`, sexual orientation, gender identity, customer identity, and identity, denomination and health words that appear outside those namespaces, such as media keyword tags like "African American", "Hispanic", "Baptist church" or "Mental illness"). Text is lower-cased, accents removed, separators normalised. Keywords match as substrings, except `race` and `gay` (and a few additions such as `islam`), which must be whole words so that "racecar", "grace", "terrace", "Gaylord" and "Marvin Gaye" pass. The rule errs toward blocking.
- `isSensitiveTag(tag)`: denied for an identity, religion, politics, sexuality or health reason (a sensitive namespace or a keyword), as opposed to the commercial namespaces (credit card, hotel rating, cost description, Wikipedia category), which are denied for copy but whose names are everyday words.
- `buildCopyAllowlist(tags)`: `{ allowed, tags, names, deniedCount, deniedNames }`. `deniedCount` counts every denied tag; `deniedNames` holds only sensitive names, for the guard. Never persist or render `deniedNames`.
- `stripPersonTags(entity)` (person subtypes lose all tags) and `sanitizeEntityTags(entity)` (also removes denied tags from other entities).
- `findAlcoholTerm(text)`: alcohol words and drinking venues (bar, pub, tavern, taproom, saloon, night club) for the fan-facing check.
- `looksPolitical(text)`: a short, conservative list of candidate and campaign phrases ("campaign rally", "for Senate", "super PAC", ...) applied to what a caller typed; the web API and MCP refuse such input. It does not classify artists or venues.

### Guard

`validateNarration(narration, facts, opts)` returns `{ narration, report }`: a cleaned copy and a `GuardReport`. It never mutates its input.

- The summary is checked sentence by sentence; `tileWhy`, `partnerLines` and optional `copyHooks` item by item. A failing unit is dropped and counted with its reasons.
- A unit fails on: an id field not in the facts; a UUID-like entity id, a geohash-like token or a `urn:tag` in the text that is not a fact or not allowlisted; a ledger ref outside `facts.ledgerRefs` (when given); a number not in `facts.numbers`; a denied term or denied tag name; a sales label ("soft show", "tracking behind"); for copy hooks, no allowlisted tag id, and alcohol words when `legalAgeEnforced` is given and not true.
- Numbers: "1,850" = 1850, "41%" = 0.41, a cited number matches when a fact rounds to it at the cited precision ("1.4x" matches 1.37), "10k" matches facts that round to 10 thousand, signs are ignored, and 0-3 are always allowed when written plainly (`trivialNumbers`).
- Known names (`facts.names`: entities, tiles, acts, venue, hours strings) and allowlisted tag names are masked before the number and denied-term scans, so "Club 21" or "90s R&B" are not citations.
- Reasons never repeat a denied term, because the report is persisted.
- `collectFactNumbers(values)` gathers every number from this run's results for `facts.numbers`, skipping coordinate fields (`lat`, `lon`, `latitude`, `longitude`, `lng`; override with `skipKeys`) so a tile's latitude cannot vouch for an invented count. `findTextViolations(text, facts)` checks a single string.

### Sheet extras: step stream, partner explain, discovery

Pure text and rules for the parts of the sheet that say what was decided and why. Callers pass only numbers that are on the sheet, so every number these texts print can be traced.

- **`steps.ts`**: one builder per pipeline step (`resolveStep`, `pauseStep`, `baselineStep`, `heatStep`, `checkStep`, `partnersStep`, `usualCrowdStep`, `declaredStep`, `prePostStep`, `mediaStep`, `narrateStep`, `guardStep`), each returning a `TraceStep` with a plain decision that carries a number ("Matched 3 acts to Qloo.", "Put East Nashville first: about 1.8 times the room's usual crowd."), an optional cause, a status and its ledger refs. Skipped and fallen-back steps stay in the list and say why. Wording helpers: `liftInWords` (the fixed phrases that name the baseline: under 0.95 "below", 0.95 to 1.05 "about the same as", 1.05 to 1.3 "a little above", 1.3 and up "about 1.8 times the room's usual crowd"; ratios like "1.8x" never appear in prose), `ordinal`, `joinAnd`, `countOf`, `dayName`. The guard step prints counts only, never policy class or tag names.
- **`ubiquityDrops(pools, tiles, opts)`**: replays `scorePartnersWithReport` without the house twins (same options) and returns the places that would have made the list but carry a penalty: the places the ubiquity penalty pushed off. The trace names them.
- **`explain.ts`**: `explainPartner(input, ctx)` builds `PartnerExplain`. Tags: the place's own Qloo tags minus category, policy-denied and (unless Ticketmaster says adults only and the operator has not said all ages) alcohol tags; the bill's own tags first, then tags more partners on the list share, then Qloo's order, at most 3 (`explainTags`, `partnerTagCounts`). Activation from `ACTIVATION_RULES` (pinned categories only; the record store tag could not be pinned): book store or clothing store "Ask for a poster in the window and a ticket drop at the counter."; barbershop or salon "Ask to leave flyers and a card at each chair."; bar "Ask to put up a poster.", with a pre-show listening night only on adults-only shows; cafe "Ask to leave table cards."; restaurants and the rest "Ask to leave flyers at the counter." Confidence (`partnerConfidence`): count the concerns (picked near the venue instead of in a top area, the search widened, a list under 15, a rank in the lower half, no hours for the street-team day, a thin signal for the bill); none is high, one medium, two or more low, with a one-line reason ("Rank 2 of 28 in a top area, open Thursday."). `distanceFromVenueKm` (straight line, one decimal), `categoryWord`, and the limits line `PARTNER_LIMITS` ("Suggested, not affiliated: no partner has agreed to anything.").
- **`discovery.ts`**: `pickDiscovery(input)` returns one `SheetDiscovery` or null. Both rules need the room's own crowd as the baseline (a genre-tag baseline gets none). Area rule (`areaDiscovery`, only when the caller says the map passed its checks): rank the lift card's areas by lift and by this crowd's own heat (bill percentile) with `rankAreas`; take the highest-lift top area whose fans-alone rank is at least 5 places lower ("Wynnewood ranks 10th of 14 areas on fans alone, but 5th against the room's usual crowd."). Partner rule (`partnerDiscovery`, when no area qualifies): the highest-scoring partner in a top area whose type is not the most common on the list (ties all count, `mostCommonCategories`) and that the house twin ranks at least 5 places lower or not at all. Otherwise none: no discovery beats a weak one. The rule text is in `AREA_RULE` and `PARTNER_RULE`.

## Test

```
npx vitest run packages/engine
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "packages/engine"
```

All fixtures are generated in the tests (`test/helpers.ts`); nothing calls Qloo or any other service. Lift and the load balancer have seeded property tests (identity maps give lift 1, shrinkage stays between 1 and the raw lift and inside the smoothing bounds, swapping bill and house inverts lift, order and monotone-transform invariance, capacity never exceeded, weight scaling invariance, monotonicity). The bounded score, the bill floor, the split-half check (pattern with noise passes, noise alone fails, too few tiles is null), KG2's split-half rule and the ubiquity penalty (values, bounds, monotone, applied with the caps kept) each have unit tests. `test/chains.test.ts` checks the matcher against the real list (the chains from the Anthem run with store numbers and location words, and local names that share a word with a brand) and the chain rule in partner scoring and pre/post spots (order, marks, unchanged scores and weights, a chain kept only for a slot no local place fills, the moved and off-list counts). `test/steps.test.ts`, `test/explain.test.ts` and `test/discovery.test.ts` cover every step builder's wording and statuses (with a plain-copy check: no ratios, exclamation marks, em dashes or marketing words), `ubiquityDrops`, the activation table (no listening night unless adults only), tag filtering and order, each confidence level, and both discovery rules with their refusals.

## Known limits

- Lift uses an inner join: tiles present in only one heatmap are dropped (`coverage` reports how many). Cells coarser than geohash-6 are assigned to the tile containing their centre.
- `smoothing` (0.5), `shrinkTau` (0.25), the bill floor (0.7), `minLift` (1.3), the split-half bar (0.5) and the ubiquity penalty (0.5 over half a list) are chosen by hand, not fitted. Change them only with the diagnostics in view; KG2 on real heatmaps is the check.
- The split-half check splits seeds, not audiences: two acts that draw different crowds fail it even when each act's map is sound.
- The hours reader is heuristic. Ambiguous text ("11am-2am" with no day) and a closed window ("Closed until 5 PM") are `unknown`. A recognised week that omits the day is `unknown` unless `missingDayMeans: "closed"`.
- The keyword denylist blocks some harmless words that contain a keyword ("Christiana"). The guard masks this run's names, so partner names are not affected.
- The guard detects inline entity ids only when they are UUID-shaped; non-UUID ids are checked in the id fields. Dates and times in narration must be in `facts.numbers` or in `facts.names`.
- `budgetSplit` is a heuristic, not a forecast. A tile with no adult count uses the mean of the known tiles. `loadBalance` gives nobody to zero-weight spots unless every weight is zero.
- `matchPlaces` accepts a name-only match when either side has no coordinates; pass `requireCoordinates: true` for the strict fuzzy-name + 150 m rule.
- The guard's number check is only as strict as `facts.numbers`: every extra number passed in widens what a rounded citation can match.
- Down-weighting tiles the house already reaches (operator ZIP counts) needs a ZIP-to-geohash crosswalk and is left to the caller: adjust tile lifts before `scorePartners` and `budgetSplit`.
- `@walkup/narrator` has its own `guardNarration`; the two should be consolidated on one implementation.
- The discovery thresholds (5 places on fans alone, 5 places in the house twin) and the confidence concerns (a list under 15, the lower half) are chosen by hand. The area rule ranks only the areas on the lift card (top areas plus a few low-lift ones), so its "of N areas" counts what the map shows, not every tile Qloo returned.
- The activation table is a fixed lookup by category key; a category it does not know gets counter flyers.
- Chains are spotted by name from a hand-kept list. A chain that is not on it, or a store whose name Qloo spells another way, is treated as local; a local place named exactly like a listed brand is treated as a chain.
