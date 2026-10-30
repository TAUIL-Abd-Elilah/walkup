# Walkup System Card

The same content is served by the app at `/system-card`. The probe outcomes below come from the day-one checks against `hackathon.api.qloo.com` on Oct 15 2026, as derived facts only (statuses, counts, field names). The live sheets (two bills at The Anthem, Washington DC, and two at The Salt Shed, Chicago) were recorded from live Qloo and Ticketmaster runs on Oct 21 2026; most of their ready-made changes were recorded on Oct 28 2026. Live runs are paused for judging; on the hosted site, https://walkup-eight.vercel.app, each recorded sheet comes from a live run and was re-checked offline afterwards, as the next paragraph says (the two sample presets are labelled sample), and the site calls no API. Nothing here is a projection.

On Oct 28 to 30 2026 the recorded sheets were re-checked offline with the newer checks, with no API call (`recheckSheet` in `packages/orchestrator/src/refresh.ts`, run by `scripts/refresh-recorded-plans.ts --recheck`). 16 Claude sentences that fail a check now read as template wording, with the reason in the sheet's checks (a partner line that called a place 35 km away close to the room, merged opening hours, two summaries about where the crowd lives or which side of the city it is on, ten more from the fourth pass below and two from the fifth). Partner lines say a place is "near" its area unless the address is on that street; each area carries its own state from its own point (Georgetown is DC); "isn't searched yet" reads "aren't"; the Checks step says why each dropped line went; each revision's change list was rebuilt over the five numbered areas. One spot listed as a restaurant, SWIG, is a bar by its Qloo tags (a bar and grill, with dive-bar tags), so it left the two "All ages, no bars" revisions at The Salt Shed, which now list 7 spots. FLO's "Within 10 km of the room" revision, which changed nothing, was removed. A second pass on Oct 29 gave Thurst Lounge on FLO's sheet back the kind its run picked it under, a bar (a later re-read of its stored tags, which the data policy had already trimmed of the bar tags, called it a restaurant, a third in U Street / Shaw), dropped four partner website links that no longer work (checked Oct 29), showed four places' own websites whose domain shortens the name, made "and N more" in chain lists count places, said a partner chain is listed last in its area (not last on the whole list), had the Summary and Checks steps say when fixed wording replaced Claude's lines, wrote "15 partner lines trimmed" for "15 partner line(s) trimmed" and "1 of 1 act resolved" for "1 of 1 acts resolved", named the shared-website signal in the chain note, and removed a repeated label from 16 Ticketmaster roster receipts. A third pass on Oct 29 made every "about N times" follow one rule (the sheet's 2-decimal lift, rounded half up), so an area reads the same figure on the plan page, the PDF, the Steps panel and street-team.ics; four stored lines changed (two area lines at lift 2.15x now read "About 2.2 times", one Steps line now says "Put Highwood first: about 2.5 times", and one change-list row says "about 1.7 times"). A fourth pass on Oct 29 held Claude's lines to newer checks, and ten more now read as template wording: six partner lines that called a partner a stop before or after the show, though it is not on the sheet's spots list; a summary that called an area's places spots; a summary that named three areas where the crowd stands out most, though another stands out more; an area line with the wrong percentile; and an area line that called the budget split equal where the shares differ. The same pass wrote "an 82nd" and "an 80th" for "a 82nd" and "a 80th", and "about 2.0 times" for "about 2 times" in eight area lines at lift 2.04x. It also dropped two fan copy lines that called the room "cozy" or "intimate" from a taste tag (the tag describes the crowd's taste, not the room), on two revisions at The Anthem, which now list 2 copy lines. A fifth pass on Oct 30 fixed wording that the rest of its sheet contradicts: the lift card's count of areas names its two tests (lift 1.3 or more, percentile 70 or higher); a top pick that passed over a higher-ranked national chain says "national chains aside"; one Claude summary says "R&B" for Ticketmaster's "Music / R&B"; on those two Anthem revisions the Summary step no longer says Claude wrote 2 copy lines (it wrote 3, and the checks kept 2); and two more Claude sentences now read as template wording: an area line that called its area's percentile the top one where another area's is higher, and a summary that said the crowd stands out in five areas where the lift card counts 66. The same pass held the sheets to three newer rules: on two of the four "No restaurants" revisions a partner whose name says restaurant is left out (Right Spot Restaurant & Bar, La Parra Restaurant & Bar), so each lists 13 partners and its counts follow; a department-store tag alone no longer makes a place a clothing store (Walmart Neighborhood Market on one of The Roots' revisions is now a bakery, by its own tags); and the fixed-wording summary says the crowd stands out "in the sheet's top 5 areas". No Qloo or Ticketmaster answer, ledger number or ranking of the places kept changed.

## Purpose and operator

**Purpose.** Walkup helps the person filling one already-booked live show (a promoter, venue marketer or street-team lead) decide where to spend the last weeks of local effort: which neighbourhoods, which real local businesses for ticket drops and posters, which pre/post-show spots, which podcasts and one sponsor brand. It produces a Street Sheet and, after a human confirm, sends it to the street team.

**Operator.** The person running a plan. They supply the show (a Ticketmaster event or a free-text description), optional what-if counts, street-team days, a radius and their own partner list. They confirm every send.

**Out of scope.** Pricing, resale, dynamic pricing, ticket inventory, ranking of shows, predicting sales, describing or targeting individuals, political candidates and campaigns.

## Models and versions

| Component | Model / version | Settings |
|---|---|---|
| Narration (summary, why-this-tile, partner one-liners, 3 copy hooks) | Claude Haiku 5.5 through OpenRouter (`anthropic/claude-haiku-5.5`, Chat Completions; `OPENROUTER_MODEL` overrides) when `OPENROUTER_API_KEY` is set. Otherwise Claude Opus 5.5 (`claude-opus-5-5`) through the Anthropic Messages API (`@anthropic-ai/sdk`), also used when both keys are set and `WALKUP_LLM_PROVIDER=anthropic` | `output_config.effort: "low"`; structured output (JSON schema) whose ID and number fields are enums built from this run; adaptive thinking (always on for this model); prompt caching on the frozen system prompt. On the OpenRouter route effort is sent as `verbosity`, the schema as `response_format`, and there is no server-side refusal fallback |
| Free-text intake (parse "Artist @ Venue, Date" into a Ticketmaster query) | The same model and route as narration | `effort: "low"`; output is a query only, resolved by Ticketmaster |
| Revisions (an operator's change note, e.g. "All ages: no bars") | The same model and route as narration | `effort: "medium"`; `tool_choice: auto`; six strict tools (`set_all_ages`, `exclude_partner_categories`, `exclude_areas`, `set_street_team_days`, `set_radius` 5-60 km, `ask_operator`) whose allowed values come from the sheet being revised. The tools only set operator inputs; the plan then runs again through Qloo and the same code. Without a model key, or on a refusal, outage or the spend cap, fixed rules read common phrasings into the same tools and the sheet says so; anything they can't read gets a question and no change |
| Refusals and outages | On the Anthropic route, server-side fallback (`fallbacks: "default"`); on both routes `stop_reason` is checked before content is read | Above the daily spend cap or on failure, narration uses a deterministic template, labelled as such |
| Ranking, lift, scoring, guard | No model. Deterministic TypeScript in `packages/engine` | Unit-tested |

## Qloo endpoints

Base URL `https://hackathon.api.qloo.com`, header `X-Api-Key`, server-side only. Global limit 3 requests/second with at most 2 retries on 429/5xx. A month guard reads `x-month-ratelimit-remaining` (the hackathon key's monthly limit read 50,000); below 1,500, fresh runs stop and presets are served from cache.

A live hero run makes about 30 calls; on the sample world a preset makes **16 to 39** from a cold cache (G1-A makes 32, including the signal check, 4 split-half heatmaps, 3 partner usual-crowd searches and 3 partner popularity searches; G2 makes 39 across its pause, 8 before the pick and 31 after; G3, with no lift map, makes 16). Full request shapes: [mapping-table.md](mapping-table.md).

| Call | Endpoint | Calls per run | Probe outcome |
|---|---|---|---|
| Q1 | `GET /entities?external.spotify.ids=`, else `GET /search` (typed, exact), then one signal check (`filter.type=urn:entity:place`, the seeds, `POINT(venue)`, 1,500 m, `take=1`) | 2-5 | Verified Oct 15. Musicians often come back as an artist and a person entry, counted as one act. An entry Qloo has no taste data for comes back as a `not_found` warning; the run swaps it for the next usable entry of the same search, asks, or leaves the act out |
| Q2 | `GET /search?types=urn:entity:place` near the venue | 1 | Verified Oct 15: a room found 5 m from its point within 1 mile; another room is not in the catalog |
| Q3 | `GET /entities?external.spotify.ids=` over the venue's Ticketmaster roster (+ up to 6 typed `/search` for headliners it missed) | Up to 7 (1 + up to 6 `/search`; 7 on each live sheet), weekly per venue | Shape verified Oct 15 (ids under `properties.external`); run on real rosters (The Truth, Nashville, for the foot-traffic check on Oct 20; The Anthem and The Salt Shed for the live sheets, recorded Oct 21) |
| Q4 | `GET /v2/insights?filter.type=urn:heatmap` (bill) | 1 (+1 when fewer than 200 map squares come back and the map is searched again at 60 km; 2 on FLO's sheets) | Verified Oct 15; radius honoured; a seed Qloo has no taste data for is dropped without a warning, and a map of only such seeds still comes back with cells. POST `{entity, weight}` signals: 400, removed |
| Q5 | `GET /v2/insights?filter.type=urn:heatmap` (house, else a pinned genre tag) | 0-1, weekly per venue | Verified Oct 15. The stand-up comedy tag map came back with 0 areas, so comedy never gets a genre baseline; no music genre tag is pinned yet |
| Q6 | `GET /v2/insights?filter.type=urn:heatmap` (generic tag baseline, diagnostic) | 0-1 | Verified Oct 15 (pinned restaurant tag) |
| Split-half | `GET /v2/insights?filter.type=urn:heatmap` again, each with one half of the bill's seeds and one half of the house set (the house set is split only when it is the baseline and has 2 or more ids) | 0-4 (none when the bill has one seed; 0 on the live sheets) | Same shape as Q4 and Q5. A split-half Spearman of 0.5 or less ranks partners near the venue |
| Q7 | `GET /v2/insights?filter.type=urn:demographics` | 1 | Verified Oct 15: one block per signal, 6 age buckets, 2 gender keys. `signal.demographics.age` is not used: its check ran on a seed Qloo had no taste data for, so it showed nothing |
| Q8 | `GET /v2/analysis/compare` | 1 (+2 on tag-diff fallback) | Verified Oct 15; `take` has no effect, so each list is cut on our side (`degraded: tag diff` if generic) |
| Q9 | `GET /v2/insights?filter.type=urn:entity:place` per top tile, explainability on | 1-3, one per partner area (+1 for an area that returns fewer than 8 places and is searched again at 3,500 m, +1 more with more place types if it is still short; 3 or 4 on the live sheets) | Verified Oct 15; `filter.hours` honoured (5 places closed that day without it, 0 with it); 11 of 14 category tags pinned; `filter.exclude.tags` and `filter.exclude.entities` not checked yet |
| Q9 popularity twin | `GET /v2/insights?filter.type=urn:entity:place`, the same request as a Q9 pool with no signal and no explainability | 0-3 (one per pool that gave partners; 2 or 3 on the live sheets) | Verified Oct 15 (probe 1): with no signal Qloo returns the pool in popularity order |
| Q9 house twin | The same request per pool with the room's usual crowd as the signal, no explainability | 0-3 (one per pool that gave places; 3 on the live sheets) | Same shape as Q9 |
| Q10 | `GET /v2/insights?filter.type=urn:entity:place` at the venue (+ weekly house twin) | 1 (+1 when fewer than 6 spots come back within 1.5 km and the search widens to 2.5 km; +1 weekly house twin) | Verified Oct 15 (Q9's filters without the price cap or the night-club exclusion, `take=25`) |
| Q11 | `GET /v2/insights?filter.type=urn:entity:place&filter.results.entities=` | 1 (+1 pick-list search per typed partner, cap 20) | Verified Oct 15 (a 10-entity shortlist fully scored). `filter.results.entities.query` (names instead of ids): 400, never sent |
| Q12 | `GET /v2/insights?filter.type=urn:entity:podcast` with `signal.location` | 1 | Verified Oct 15: 200, 15 rows with a usable seed. The day-one 400s came from a seed Qloo had no taste data for. Location effect not shown, so podcasts are labelled national |
| Q13 | `GET /v2/insights?filter.type=urn:entity:brand` with `signal.location` and exclusions | 1 | Verified Oct 15: 200, 15 rows with a usable seed. No alcohol brand tag was found to exclude, so a name and tag filter keeps alcohol, tobacco and gambling brands off shows that aren't 21+ or that the operator marked all ages. Labelled national |
| Q14 | `GET /v2/insights?filter.type=urn:tag` with `filter.tag.types`, `diversify.by=subtype` | 1 | Verified Oct 15; `diversify.by=subtype` keeps at most 5 tags per namespace |
| Q16 | `GET /v2/tags` (build time only) | 0 at runtime | Verified Oct 15: 11 categories pinned, 3 dropped; per-tag status in [`config/tags.json`](../config/tags.json). `GET /v2/audiences` returned nothing for both test queries and is not used |

### Verified on hackathon.api.qloo.com, Oct 15 2026

Each request shape a run sends, checked against the live host on Oct 15 2026 (the day-one probes plus a few single checks). Only derived facts are listed: statuses, counts and field names, no response data. **Verified** means the shape answers as we use it; **changed** means the check changed what we send or how we read it; **added** is new because of a check; **removed** means the code path is gone.

| Request shape we send | Used for | What the live host did | Status |
|---|---|---|---|
| `GET /search` `types=urn:entity:artist,urn:entity:person`, `take=5`, exact name | Acts (Q1), the room's usual acts (Q3) | 200. Most musicians are listed twice under one exact name, an artist entry and a person entry; the run now counts them as one act | verified, changed |
| `GET /v2/insights` `filter.type=urn:entity:place`, the seeds as `signal.interests.entities`, `filter.location=POINT(venue)`, 1,500 m, `take=1` | Signal check (Q1): one call per 25 ids, plus one per Spotify-matched act Qloo drops (a 200 is cached 7 days, a 400 is not) | 200 with a top-level `not_found` warning naming each seed Qloo has no taste data for ("Jason Isbell" was one; "Jason Isbell and The 400 Unit" works) | added |
| `GET /search` `types=urn:entity:place`, `filter.location=<lat>,<lon>`, `filter.radius` in miles | Venue (Q2), pick list for your partners (Q11) | 200; a room was found 5 m from its point within 1 mile; another room is not in the catalog | verified |
| `GET /entities?external.spotify.ids=` | Acts and the room's roster by Spotify id (Q1, Q3) | 200; the ids come back under `properties.external`. | verified, changed |
| `filter.type=urn:heatmap`, `signal.interests.entities`, `filter.location=POINT`, `filter.location.radius` | Bill and usual-crowd maps (Q4, Q5), the split-half check | 200; the radius is honoured; a seed Qloo has no taste data for is dropped with no warning, and a map of only such seeds still comes back (200, with cells), which is why the signal check exists | verified |
| `filter.type=urn:heatmap` with a pinned place tag (restaurant) as the signal | Popularity check (Q6) | 200 | verified |
| `filter.type=urn:heatmap` with a genre tag as the signal | Genre baseline when the roster is short (Q5) | The stand-up comedy tag returned 0 areas near a comedy club. Music genre tags are not checked yet, so none is pinned | changed: no comedy baseline |
| `filter.type=urn:demographics` | Age mix (Q7) | 200; one block per signal, 6 age buckets, 2 gender keys | verified |
| `GET /v2/analysis/compare` `a.signal.interests.entities`, `b.signal.interests.entities`, `take=30` | How this crowd differs (Q8) | 200; `take` has no effect, so each list is cut on our side | verified, changed |
| `filter.type=urn:entity:place` per area: `filter.location` and radius, `filter.tags` with `operator.filter.tags=union`, `filter.hours`, `filter.price_level.max`, `feature.explainability`, `take=50` | Partners (Q9) and their usual-crowd twin; spots near the venue (Q10) use the same filters without `filter.price_level.max` and with `take=25` | 200; `filter.hours` is honoured (5 places closed that day without it, 0 with it). `filter.exclude.tags` and `filter.exclude.entities` are not checked yet | verified |
| `filter.tags` with pinned category tags | Partner and spot categories (Q9, Q10) | 11 of 14 categories pinned (6 to 10 places within 25 km, every one carrying the tag); record store, Irish pub and place of worship returned too few and are not used | verified, changed |
| `filter.results.entities` with the bill as the signal | Call order for your partners (Q11) | 200; a 10-entity shortlist came back fully scored | verified |
| `filter.type=urn:entity:podcast`, `signal.location=POINT(venue)`, `feature.explainability`, `take=15` | Podcasts (Q12) | 200, 15 rows with a usable seed. The day-one 400s came from a seed Qloo had no taste data for. Whether location moves the ranking is not shown, so podcasts stay labelled national | verified |
| `filter.type=urn:entity:brand`, `signal.location=POINT(venue)`, `feature.explainability`, `take=15` | Sponsor (Q13) | 200, 15 rows with a usable seed. No alcohol brand tag was found to exclude, so on shows that aren't 21+ or that the operator marked all ages a name and tag filter keeps alcohol, tobacco and gambling brands off | verified, changed |
| `filter.type=urn:tag`, `filter.tag.types`, `diversify.by=subtype`, `take=30` | Copy-line tags (Q14) | 200; `diversify.by=subtype` keeps at most 5 tags per namespace | verified |
| `GET /v2/tags` `filter.query`, `filter.parents.types=urn:entity:place`, `feature.semantic_search=true` | Pinning tag ids (build time) | 200 | verified |
| `POST /v2/insights` with `{entity, weight}` signals | Weighting an act against its stand-ins | 400 | removed |
| `filter.results.entities.query` (place names instead of ids) | Scoring a typed list without a pick list | 400 | removed, never sent |
| `signal.demographics.age` on place calls | Age-tuned partner ranking | No change in the top 10, but the test ran on a seed Qloo had no taste data for, so it shows nothing | removed, never sent |
| `GET /v2/audiences` `filter.query` | Declared group segments | 0 results for both test queries | removed |

Known API behaviour we design around: invalid or type-inapplicable parameters are ignored with HTTP 200, so every shape is probe-verified before it is trusted; affinities are normalized per query and compared only as ranks inside one response; `filter.type` uses `video_game` while `/search` uses `videogame`; WKT points are `POINT(lon lat)`; `output.heatmap.boundary=city|neighborhood` is reported by other developers to return 400 on this host and is never sent, so tiles are named by our own gazetteer.

## Data sources and licences

| Source | Used for | Terms we follow |
|---|---|---|
| Qloo Insights API | All taste decisions (Q1-Q16) | Key server-side only. Response bodies are never committed (git-ignored private cache, CI check). Only IDs, counts and derived metrics appear in the repo |
| Ticketmaster Discovery API | Event, venue coordinates, age policy, the venue's upcoming roster, attraction Spotify IDs | Attribution and deep links; within published rate limits |
| Google Places API (New) | Nothing. The "Without Qloo" comparison list was removed from the product on Oct 20 2026, and the project's Google billing is closed, so Places is not available. Only the Fan-Bar Test research code has a client for it, and its Places arm did not run | Sheets stored before then are shown without their Places list; their ledgers keep the request records (queries and counts, no place content) |
| OpenStreetMap via OpenFreeMap, Nominatim, Overpass | Base map and neighbourhood names | ODbL attribution; cached; polite request rates |
| US Census ACS 5-year, TIGER/Line | Adults per ZCTA for the budget heuristic and tile floor | Public domain |
| Official supporters'-club pages | Fan-Bar Test ground truth (collected Oct 13 2026; the test ran Oct 21 2026) | Facts only (club, metro, bar, address, source URL, fetch date); robots.txt respected; 1 request/second; derived metrics and a 20-row sample published, never the full table |
| Spotify IDs | Join keys taken from Ticketmaster attractions | Not fetched from Spotify |
| OpenRouter (when `OPENROUTER_API_KEY` is set), which forwards to a host of the Claude model, or the Anthropic Messages API | Narration, free-text parsing, change notes | No personal data is sent |
| Resend | The confirm-gated send | Test inbox is the default recipient |

## What we store and what we don't

**We store:** plans (the show, the operator's what-if inputs and the resulting sheet), the request ledger (endpoint, parameters with the key replaced by `$QLOO_API_KEY`, status, latency, bytes, cache flag, result count), a private cache of API responses (never committed), send records (message ID, recipient count) and eval scores.

**We don't store or collect:** fan, buyer or viewer data; names, emails or phone numbers of anyone the operator did not type; accounts or logins; cookies beyond one functional cookie; the optional "Street-team email" address in the send dialog (used for that send only, then discarded; the ledger keeps a keyed hash); person-entity tags (stripped before anything is persisted); tags from denied namespaces.

**We never send to Qloo, OpenRouter or Anthropic:** personal data of any kind, or operator contact details (typed email addresses stay with the confirm-gated send).

**What each provider receives:**
- **Qloo:** act, venue and partner names (for typed search and pick lists), entity IDs, tag IDs, coordinates, radii, weekdays and filters. "Already reached" ZIP counts are never sent to Qloo; they only down-weight tiles in our own code.
- **OpenRouter / Anthropic:** the show's public listing facts, the operator's what-ifs and declared partner names, and this run's results for narration. For a revision: the operator's note and a short summary of the sheet (acts, venue, date, age policy, settings, area names and geohashes, place types with counts), with no partner names and no contact details.
- **Google:** nothing. The product makes no Google request; partner hours, addresses, phones and the closed check come from Qloo's place data.

## Evals

| Eval | What it measures | Result |
|---|---|---|
| Product eval (20 cases) | Four goldens and sixteen scenario cases run end to end on the sample data: every cited ID appears in the run's ledger, zero guard drops in a citation field, call budget, fallbacks shown on their cards, policy rules | All 20 pass on sample data (`evals/product/out/score.md`). It checks behaviour, not whether Qloo's picks are better |
| Live sheets, recorded Oct 21 2026 | Two real bills per room, picked by `HERO_RULE`, run live; how much the two bills' areas and partners overlap, and how many partners a popularity list of the same areas would miss (the same Qloo search with no signal) | The Anthem, Washington DC: Rhiannon Giddens and FLO share none of their top 5 areas and none of their partners; 25 of 33 partners are not in the popularity list. The Salt Shed, Chicago (owned and run by 16" On Center; a Chicago Independent Venue League member): Greensky Bluegrass and The Roots share none of their top 5 areas and none of their partners; 29 of 41 are not in the popularity list, and neither signal is thin. It compares two lists, not ticket sales |
| Fan-Bar Test | Rank of official supporters'-club bars under a Qloo signal vs Qloo popularity vs the same model with Google Places | Run Oct 21 2026 under the plan sealed in [`preregistration/`](preregistration/) (1,146 Qloo calls). **H1 not supported:** in 325 club-and-city pairs across 225 US cities, the club's Qloo signal put its official bar in the top 50 for 25% of pairs (95% CI 21% to 30%) and popularity alone for 27% (22% to 32%); MRR 0.024 vs 0.030, difference -0.006 (95% CI -0.018 to 0.006), one-sided Wilcoxon p = 0.89. Derby Test: 95 of 182 trials (52%, 95% CI 45% to 60%), p = 0.30. The Google Places and model-only arms did not run (Google billing closed; no key for the plan's model), so H2 was not tested and closed bars were not checked ([deviations](preregistration/p1-deviations.md)). Partner tables carry the preregistered banner "Ranked by Qloo affinity; our test did not show this beats popularity." Details: [`evals/p1/results.md`](../evals/p1/results.md) |

## Counsel note: the ad-export flow

`zips.csv` and `pins.csv` contain geography and a suggested weight only. They carry no audience labels, no demographic descriptions and no group names. The operator sets any targeting in their own ad account under that platform's policies. Walkup does not create audiences, upload customer lists or connect to an ad account. A race-share audit (the correlation between tile lift and tract race share, reported only as one aggregate number) would make the proxy risk of geographic targeting visible; it has not been run, so no such number exists yet.

## Known failure modes

| Failure | What the user sees |
|---|---|
| Thin signal for comedians, small acts or smaller metros (fewer than 200 heatmap cells) | Radius widens to 60 km, then `partial: thin`; fewer partners; "Thin signal: treat as a starting list." |
| A one-word or shared act name | `needs_input` with candidates (type, popularity, short description); never resolved silently |
| An act missing from the catalog | `partial`; the run continues on the resolved acts and offers film/TV proxy seeds, shown in the receipts |
| A new venue not yet a Qloo place | The Ticketmaster `POINT(lon lat)`, labelled "Venue not in the catalog yet, so the run uses the Ticketmaster point." |
| The venue's roster resolves fewer than 5 headliners | Pinned genre-tag baseline, `degraded: tag baseline`, once one is pinned. None is pinned yet (Oct 15), so the lift card reports `baseline: "none"` and shows no lift map. Comedy never gets one (the comedy tag map was empty on Oct 15), so a comedy room gets no lift map, `degraded`, and partners near the venue |
| Qloo lists an act but has no taste data for it (`not_found`) | The Q1 signal check swaps in the next usable entry of the same search and says so on the resolution card, asks when several fit, or leaves the act out; a card whose call still lost every seed leaves its list out |
| Lift tracks raw heat (Spearman above 0.9) | `lift weak` badge; partners ranked near the venue |
| Lift ranks areas almost like the bill's own map (Spearman above 0.9; 0.98 for a comedian on Oct 15) | `partial`: "This map shows where this bill's crowd is, not where it stands out"; partners ranked near the venue |
| Compare returns only shared or generic tags | Two `urn:tag` calls diffed by rank, `degraded: tag diff` |
| `signal.location` does not move podcast or brand rankings | Labelled national ("Local ranking not checked yet, so all are national.") |
| Fewer than 8 places in an area | Radius 3,500 m, then a wider category set, `partial`; closed places dropped and counted |
| A national chain among the partners or spots | Listed after the local places (a partner after those of its area) and kept only for a slot no local place fills; the card says how many are chains and how many more were left off, and the steps name the chains left off. Chains are spotted from a hand-kept list ([`config/chains.json`](../config/chains.json)), Qloo's description of the place, a store-locator website, or the same name or website at 3 or more places the run saw; a chain none of these catches is listed like a local place |
| A popularity twin fails or comes back empty | No popularity number on the sheet or the card; the "Popularity check" step says which area and why. The partner list is unchanged |
| No sponsor survives exclusions | Sponsor card hidden with an `empty` badge |
| One headliner dominates the explainability | Balance check down-weights it and shows "The headliner was dominating the ranking, so the list was rebalanced with the co-bill." Off: explainability scores are shares per place, not shown informative on Oct 15 |
| LLM refusal, outage or spend cap reached | Deterministic template narration, labelled; revision notes read by fixed rules, labelled |
| A change note Walkup can't read, an area not on the sheet, or a radius outside 5-60 km | One question back; the plan is not changed or re-run |
| Live runs paused (`WALKUP_MODE=recorded`, or the hackathon key's end date, Nov 2 2026, in `WALKUP_QLOO_UNTIL`) | Recorded mode: sheets recorded from earlier live runs, each with its date, under a strip that says they were recorded from live runs and live runs are paused; a preset with no usable recording shows its sample sheet, labelled sample. New plans and searches answer 503 with the reason; a change note opens the revision recorded ahead for the same change, or says the change needs new Qloo requests. A rejected key with no live sheet stored falls back to the sample world |
| Qloo month quota low (under 1,500 calls left) | Presets and stored sheets only; fresh runs stop with an explanation |

## Human gates

- **Resolution:** ambiguity pauses the run until the operator picks a candidate or a proxy.
- **Revisions:** only the operator's own note starts one, and it makes a new plan; the original sheet is kept. All ages only adds restrictions: Ticketmaster's 21+ still holds.
- **Send:** a confirm dialog lists recipients and attachments; nothing is sent before Confirm. The default recipient is a test inbox. Contacts are only those the operator typed. Sends carry a physical-address footer and an opt-out line.
- **Partners:** always "suggested, not affiliated".
- **Promo codes:** created by the box office in its own ticketing platform; Walkup exports suggestions only.
- **Counts:** seats left and capacity are operator inputs, and the plan page says so. On a sample sheet they are what-ifs and marked as such ("(assumed)" on the PDF); on a live sheet they are the operator's own. The presets carry no seats-left count.
- **Budget split:** proportional to lift and adult population, labelled "heuristic, not a forecast"; the media budget it splits is the operator's what-if.

## Cost caps

| Service | Cap |
|---|---|
| Qloo | Month guard at 1,500 remaining; fresh runs capped at 3 per IP per day and 15 per day in total; cached presets unlimited |
| Claude (OpenRouter or Anthropic) | Daily spend counter capped at $5/day, at Anthropic list rates; narration cached per plan; template narration above the cap |
| Revisions | 12 per network per hour on a live server, where a revision that runs also counts as a fresh run (same caps; refunded when it makes no new Qloo call); 30 in sample mode; 120 on the recorded site, where a note only opens a stored version (no API call). Unchanged Qloo requests come from the cache, so only requests whose inputs changed are sent |
| Resend | Free tier (100/day); test inbox by default |
| Hosting | Vercel (Hobby), serving the recorded sheets in recorded mode ([docs/deploy-vercel.md](deploy-vercel.md)); a Fly.io setup for live mode is in `fly.toml` ([docs/deploy.md](deploy.md)) |

## Contact

Open an issue at https://github.com/TAUIL-Abd-Elilah/walkup/issues. Security or data concerns: open an issue titled "security" without details and we will reply with a private channel.
