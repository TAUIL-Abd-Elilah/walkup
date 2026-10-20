# Walkup System Card

The same content is served by the app at `/system-card`. The probe outcomes below come from the day-one checks against `hackathon.api.qloo.com` on Oct 15 2026, as derived facts only (statuses, counts, field names). Nothing here is a projection, and no full live sheet has been recorded yet.

## Purpose and operator

**Purpose.** Walkup helps the person filling one already-booked live show (a promoter, venue marketer or street-team lead) decide where to spend the last weeks of local effort: which neighbourhoods, which real local businesses for ticket drops and posters, which pre/post-show spots, which podcasts and one local sponsor. It produces a Street Sheet and, after a human confirm, sends it to the street team.

**Operator.** The person running a plan. They supply the show (a Ticketmaster event or a free-text description), optional what-if counts, street-team days, a radius and their own partner list. They confirm every send.

**Out of scope.** Pricing, resale, dynamic pricing, ticket inventory, ranking of shows, predicting sales, describing or targeting individuals, political candidates and campaigns.

## Models and versions

| Component | Model / version | Settings |
|---|---|---|
| Narration (summary, why-this-tile, partner one-liners, 3 copy hooks) | `claude-opus-5-5`, through OpenRouter (`anthropic/claude-opus-5.5`, Chat Completions) when `OPENROUTER_API_KEY` is set, else the Anthropic Messages API (`@anthropic-ai/sdk`) | `output_config.effort: "low"`; structured output (JSON schema) whose ID and number fields are enums built from this run; adaptive thinking (always on for this model); prompt caching on the frozen system prompt. On the OpenRouter route effort is sent as `verbosity`, the schema as `response_format`, and there is no server-side refusal fallback |
| Free-text intake (parse "Artist @ Venue, Date" into a Ticketmaster query) | `claude-opus-5-5` | `effort: "low"`; output is a query only, resolved by Ticketmaster |
| Fair-control arm F | `claude-opus-5-5`, same system prompt and output schema as the product | `effort: "medium"`; tools: Google Places (New) Text Search, Census ACS lookup |
| Revisions (an operator's change note, e.g. "All ages: no bars") | `claude-opus-5-5` | `effort: "medium"`; `tool_choice: auto`; six strict tools (`set_all_ages`, `exclude_partner_categories`, `exclude_areas`, `set_street_team_days`, `set_radius` 5-60 km, `ask_operator`) whose allowed values come from the sheet being revised. The tools only set operator inputs; the plan then runs again through Qloo and the same code. Without a model key, or on a refusal, outage or the spend cap, fixed rules read common phrasings into the same tools and the sheet says so; anything they can't read gets a question and no change |
| Refusals and outages | Server-side fallback (`fallbacks: "default"`); `stop_reason` checked before content is read | Above the daily spend cap or on failure, narration uses a deterministic template, labelled as such |
| Ranking, lift, scoring, guard | No model. Deterministic TypeScript in `packages/engine` | Unit-tested |

## Qloo endpoints

Base URL `https://hackathon.api.qloo.com`, header `X-Api-Key`, server-side only. Global limit 3 requests/second with at most 2 retries on 429/5xx. A month guard reads `x-month-ratelimit-remaining`; below 1,500, fresh runs stop and presets are served from cache.

About **15 to 29 calls per fresh run**, counted from the sample run (G1-A makes 29 from cold, including the signal check, 4 split-half heatmaps and 3 partner usual-crowd searches; G3, with no lift map, makes 15). Full request shapes: [mapping-table.md](mapping-table.md).

| Call | Endpoint | Calls per run | Probe outcome |
|---|---|---|---|
| Q1 | `GET /entities?external.spotify.ids=`, else `GET /search` (typed, exact), then one signal check (`filter.type=urn:entity:place`, the seeds, `POINT(venue)`, 1,500 m, `take=1`) | 2-5 | Verified Oct 15. Musicians often come back as an artist and a person entry, counted as one act. An entry Qloo has no taste data for comes back as a `not_found` warning; the run swaps it for the next usable entry of the same search, asks, or leaves the act out |
| Q2 | `GET /search?types=urn:entity:place` near the venue | 1 | Verified Oct 15: a room found 5 m from its point within 1 mile; another room is not in the catalog |
| Q3 | `GET /entities?external.spotify.ids=` over the venue's Ticketmaster roster (+ up to 6 typed `/search`) | 1-3, weekly per venue | Shape verified Oct 15 (ids under `properties.external`); a roster-wide check waits for the Ticketmaster key |
| Q4 | `GET /v2/insights?filter.type=urn:heatmap` (bill) | 1 | Verified Oct 15; radius honoured; a seed Qloo has no taste data for is dropped without a warning, and a map of only such seeds still comes back with cells. POST `{entity, weight}` signals: 400, removed |
| Q5 | `GET /v2/insights?filter.type=urn:heatmap` (house, else a pinned genre tag) | 0-1, weekly per venue | Verified Oct 15. The stand-up comedy tag map came back with 0 areas, so comedy never gets a genre baseline; no music genre tag is pinned yet |
| Q6 | `GET /v2/insights?filter.type=urn:heatmap` (generic tag baseline, diagnostic) | 0-1 | Verified Oct 15 (pinned restaurant tag) |
| Q7 | `GET /v2/insights?filter.type=urn:demographics` | 1 | Verified Oct 15: one block per signal, 6 age buckets, 2 gender keys. `signal.demographics.age` is not used: its check ran on a seed Qloo had no taste data for, so it showed nothing |
| Q8 | `GET /v2/analysis/compare` | 1 (+2 on tag-diff fallback) | Verified Oct 15; `take` has no effect, so each list is cut on our side (`degraded: tag diff` if generic) |
| Q9 | `GET /v2/insights?filter.type=urn:entity:place` per top tile, explainability on | 3 | Verified Oct 15; `filter.hours` honoured (5 places closed that day without it, 0 with it); 11 of 14 category tags pinned; `filter.exclude.tags` and `filter.exclude.entities` not checked yet |
| Q10 | `GET /v2/insights?filter.type=urn:entity:place` at the venue (+ weekly house twin) | 1 (+1 weekly) | Verified Oct 15 (same shape as Q9) |
| Q11 | `GET /v2/insights?filter.type=urn:entity:place&filter.results.entities=` | 1 (+1 pick-list search per typed partner, cap 20) | Verified Oct 15 (a 10-entity shortlist fully scored). `filter.results.entities.query` (names instead of ids): 400, never sent |
| Q12 | `GET /v2/insights?filter.type=urn:entity:podcast` with `signal.location` | 1 | Verified Oct 15: 200, 15 rows with a usable seed. The day-one 400s came from a seed Qloo had no taste data for. Location effect not shown, so podcasts are labelled national |
| Q13 | `GET /v2/insights?filter.type=urn:entity:brand` with `signal.location` and exclusions | 1 | Verified Oct 15: 200, 15 rows with a usable seed. No alcohol brand tag was found to exclude, so a name and tag filter keeps alcohol, tobacco and gambling brands off shows that aren't 21+. Labelled national |
| Q14 | `GET /v2/insights?filter.type=urn:tag` with `filter.tag.types`, `diversify.by=subtype` | 1 | Verified Oct 15; `diversify.by=subtype` keeps at most 5 tags per namespace |
| Q16 | `GET /v2/tags` (build time only) | 0 at runtime | Verified Oct 15: 11 categories pinned, 3 dropped; per-tag status in [`config/tags.json`](../config/tags.json). `GET /v2/audiences` returned nothing for both test queries and is not used |

### Verified on hackathon.api.qloo.com, Oct 15 2026

Each request shape a run sends, checked against the live host on Oct 15 2026 (the day-one probes plus a few single checks). Only derived facts are listed: statuses, counts and field names, no response data. **Verified** means the shape answers as we use it; **changed** means the check changed what we send or how we read it; **added** is new because of a check; **removed** means the code path is gone.

| Request shape we send | Used for | What the live host did | Status |
|---|---|---|---|
| `GET /search` `types=urn:entity:artist,urn:entity:person`, `take=5`, exact name | Acts (Q1), the room's usual acts (Q3) | 200. Most musicians are listed twice under one exact name, an artist entry and a person entry; the run now counts them as one act | verified, changed |
| `GET /v2/insights` `filter.type=urn:entity:place`, the seeds as `signal.interests.entities`, `filter.location=POINT(venue)`, 1,500 m, `take=1` | Signal check (Q1): one call per 25 ids, plus one per Spotify-matched act Qloo drops (a 200 is cached 7 days, a 400 is not) | 200 with a top-level `not_found` warning naming each seed Qloo has no taste data for ("Jason Isbell" was one; "Jason Isbell and The 400 Unit" works) | added |
| `GET /search` `types=urn:entity:place`, `filter.location=<lat>,<lon>`, `filter.radius` in miles | Venue (Q2), pick list for your partners (Q11) | 200; a room was found 5 m from its point within 1 mile; another room is not in the catalog | verified |
| `GET /entities?external.spotify.ids=` | Acts and the room's roster by Spotify id (Q1, Q3) | 200; the ids come back under `properties.external`. The roster-wide check waits for the Ticketmaster key | verified, changed |
| `filter.type=urn:heatmap`, `signal.interests.entities`, `filter.location=POINT`, `filter.location.radius` | Bill and usual-crowd maps (Q4, Q5), the split-half check | 200; the radius is honoured; a seed Qloo has no taste data for is dropped with no warning, and a map of only such seeds still comes back (200, with cells), which is why the signal check exists | verified |
| `filter.type=urn:heatmap` with a pinned place tag (restaurant) as the signal | Popularity check (Q6) | 200 | verified |
| `filter.type=urn:heatmap` with a genre tag as the signal | Genre baseline when the roster is short (Q5) | The stand-up comedy tag returned 0 areas near a comedy club. Music genre tags are not checked yet, so none is pinned | changed: no comedy baseline |
| `filter.type=urn:demographics` | Age mix (Q7) | 200; one block per signal, 6 age buckets, 2 gender keys | verified |
| `GET /v2/analysis/compare` `a.signal.interests.entities`, `b.signal.interests.entities`, `take=30` | How this crowd differs (Q8) | 200; `take` has no effect, so each list is cut on our side | verified, changed |
| `filter.type=urn:entity:place` per area: `filter.location` and radius, `filter.tags` with `operator.filter.tags=union`, `filter.hours`, `filter.price_level.max`, `feature.explainability`, `take=50` | Partners (Q9) and their usual-crowd twin, spots near the venue (Q10) | 200; `filter.hours` is honoured (5 places closed that day without it, 0 with it). `filter.exclude.tags` and `filter.exclude.entities` are not checked yet | verified |
| `filter.tags` with pinned category tags | Partner and spot categories (Q9, Q10) | 11 of 14 categories pinned (5 to 10 places within 25 km, every one carrying the tag); record store, Irish pub and place of worship returned too few and are not used | verified, changed |
| `filter.results.entities` with the bill as the signal | Call order for your partners (Q11) | 200; a 10-entity shortlist came back fully scored | verified |
| `filter.type=urn:entity:podcast`, `signal.location=POINT(venue)`, `feature.explainability`, `take=15` | Podcasts (Q12) | 200, 15 rows with a usable seed. The day-one 400s came from a seed Qloo had no taste data for. Whether location moves the ranking is not shown, so podcasts stay labelled national | verified |
| `filter.type=urn:entity:brand`, `signal.location=POINT(venue)`, `feature.explainability`, `take=15` | Sponsor (Q13) | 200, 15 rows with a usable seed. No alcohol brand tag was found to exclude, so on shows that aren't 21+ a name and tag filter keeps alcohol, tobacco and gambling brands off | verified, changed |
| `filter.type=urn:tag`, `filter.tag.types`, `diversify.by=subtype`, `take=30` | Copy-line tags (Q14) | 200; `diversify.by=subtype` keeps at most 5 tags per namespace | verified |
| `GET /v2/tags` `filter.query`, `filter.parents.types=urn:entity:place`, `feature.semantic_search=true` | Pinning tag ids (build time) | 200 | verified |
| `POST /v2/insights` with `{entity, weight}` signals | Weighting an act against its stand-ins | 400 | removed |
| `filter.results.entities.query` (place names instead of ids) | Scoring a typed list without a pick list | 400 | removed, never sent |
| `signal.demographics.age` on place calls | Age-tuned partner ranking | No change in the top 10, but the test ran on a seed Qloo had no taste data for, so it shows nothing | removed, never sent |
| `GET /v2/audiences` `filter.query` | Declared group segments | 0 results for both test queries | removed |

Known API behaviour we design around: invalid or type-inapplicable parameters are ignored with HTTP 200, so every shape is probe-verified before it is trusted; affinities are normalized per query and compared only as ranks inside one response; `filter.type` uses `video_game` while `/search` uses `videogame`; WKT points are `POINT(lon lat)`; `output.heatmap.boundary=city|neighborhood` returns 400 on this host, so tiles are named by our own gazetteer.

## Data sources and licences

| Source | Used for | Terms we follow |
|---|---|---|
| Qloo Insights API | All taste decisions (Q1-Q16) | Key server-side only. Response bodies are never committed (git-ignored private cache, CI check). Only IDs, counts and derived metrics appear in the repo |
| Ticketmaster Discovery API | Event, venue coordinates, age policy, the venue's upcoming roster, attraction Spotify IDs | Attribution and deep links; within published rate limits |
| Google Places API (New) | Fair-control arm F and the grounding checks only | Attribution displayed; place content cached 30 days or less (place IDs may be kept) |
| OpenStreetMap via OpenFreeMap, Nominatim, Overpass | Base map and neighbourhood names | ODbL attribution; cached; polite request rates |
| US Census ACS 5-year, TIGER/Line | Adults per ZCTA for the budget heuristic and tile floor | Public domain |
| Official supporters'-club pages | P1 ground truth (collected; P1 itself was not run) | Facts only (club, metro, bar, address, source URL, fetch date); robots.txt respected; 1 request/second; derived metrics and a 20-row sample published, never the full table |
| Spotify IDs | Join keys taken from Ticketmaster attractions | Not fetched from Spotify |
| OpenRouter (when `OPENROUTER_API_KEY` is set), which forwards to a host of the Claude model, or the Anthropic Messages API | Narration, free-text parsing, arm F, change notes | No personal data is sent |
| Resend | The confirm-gated send | Test inbox is the default recipient |

## What we store and what we don't

**We store:** plans (the show, the operator's what-if inputs and the resulting sheet), the request ledger (endpoint, parameters with the key replaced by `$QLOO_API_KEY`, status, latency, bytes, cache flag, result count), a private cache of API responses (never committed), send records (message ID, recipient count) and eval scores.

**We don't store or collect:** fan, buyer or viewer data; names, emails or phone numbers of anyone the operator did not type; accounts or logins; cookies beyond one functional cookie; the optional "send a copy to me" address (used once, then discarded); person-entity tags (stripped before anything is persisted); tags from denied namespaces.

**We never send to Qloo, OpenRouter, Anthropic or Google:** personal data of any kind, or operator contact details (typed email addresses stay with the confirm-gated send).

**What each provider receives:**
- **Qloo:** act, venue and partner names (for typed search and pick lists), entity IDs, tag IDs, coordinates, radii, weekdays and filters. "Already reached" ZIP counts are never sent to Qloo; they only down-weight tiles in our own code.
- **OpenRouter / Anthropic:** the show's public listing facts, the operator's what-ifs and declared partner names, and this run's results for narration. For a revision: the operator's note and a short summary of the sheet (acts, venue, date, age policy, settings, area names and geohashes, place types with counts), with no partner names and no contact details. The fair-control arm F gets the same inputs as the Qloo arm, including the aggregate "already reached" ZIP counts (ZIP and count, no names), so the two arms stay comparable.
- **Google Places:** text queries (the ones arm F chooses, and place names for the grounding checks) with a search circle near the venue.

## Evals

| Eval | What it measures | Result |
|---|---|---|
| Product eval (20 cases) | Four goldens and sixteen scenario cases run end to end on the sample data: every cited ID appears in the run's ledger, zero guard drops, call budget, fallbacks shown on their cards, policy rules | All 20 pass on sample data (`evals/product/out/score.md`). It checks behaviour, not whether Qloo's picks are better |
| P1 Fan-Bar Test | Rank of official supporters'-club bars under a Qloo signal vs Qloo popularity vs the same model with Google Places | Designed and sealed in [`preregistration/`](preregistration/), not run (it needs up to 1,331 Qloo calls). No result |

## Counsel note: the ad-export flow

`zips.csv` and `pins.csv` contain geography and a suggested weight only. They carry no audience labels, no demographic descriptions and no group names. The operator sets any targeting in their own ad account under that platform's policies. Walkup does not create audiences, upload customer lists or connect to an ad account. A race-share audit (the correlation between tile lift and tract race share, reported only as one aggregate number) would make the proxy risk of geographic targeting visible; it has not been run, so no such number exists yet.

## Known failure modes

| Failure | What the user sees |
|---|---|
| Thin signal for comedians, small acts or smaller metros (fewer than 200 heatmap cells) | Radius widens to 60 km, then `partial: thin`; fewer partners; "thin signal: treat as a starting list" |
| A one-word or shared act name | `needs_input` with candidates (type, popularity, short description); never resolved silently |
| An act missing from the catalog | `partial`; the run continues on the resolved acts and offers film/TV proxy seeds, shown in the receipts |
| A new venue not yet a Qloo place | The Ticketmaster `POINT(lon lat)`, labelled "venue not in catalog yet" |
| The venue's roster resolves fewer than 5 headliners | Pinned genre-tag baseline, `degraded: tag baseline`, once one is pinned. None is pinned yet (Oct 15), so the lift card reports `baseline: "none"` and shows no lift map. Comedy never gets one (the comedy tag map was empty on Oct 15), so a comedy room gets no lift map, `degraded`, and partners near the venue |
| Qloo lists an act but has no taste data for it (`not_found`) | The Q1 signal check swaps in the next usable entry of the same search and says so on the resolution card, asks when several fit, or leaves the act out; a card whose call still lost every seed leaves its list out |
| Lift tracks raw heat (Spearman above 0.9) | `lift weak` badge; partners ranked near the venue |
| Lift ranks areas almost like the bill's own map (Spearman above 0.9; 0.98 for a comedian on Oct 15) | `partial`: "This map shows where this bill's crowd is, not where it stands out"; partners ranked near the venue |
| Compare returns only shared or generic tags | Two `urn:tag` calls diffed by rank, `degraded: tag diff` |
| `signal.location` does not move podcast or brand rankings | Labelled "national, not local" |
| Fewer than 8 partners in a tile | Radius 3,500 m, then a wider category set, `partial`; closed places dropped and counted |
| No sponsor survives exclusions | Sponsor card hidden with an `empty` badge |
| One headliner dominates the explainability | Balance check down-weights it and shows "headliner was dominating; rebalanced". Off: explainability scores are shares per place, not shown informative on Oct 15 |
| LLM refusal, outage or spend cap reached | Deterministic template narration, labelled; revision notes read by fixed rules, labelled |
| A change note Walkup can't read, an area not on the sheet, or a radius outside 5-60 km | One question back; the plan is not changed or re-run |
| Qloo key deactivated or quota low | Stored or sample sheets only, marked as such on the page; fresh runs disabled with an explanation |

## Human gates

- **Resolution:** ambiguity pauses the run until the operator picks a candidate or a proxy.
- **Revisions:** only the operator's own note starts one, and it makes a new plan; the original sheet is kept. All ages only adds restrictions: Ticketmaster's 21+ still holds.
- **Send:** a confirm dialog lists recipients and attachments; nothing is sent before Confirm. The default recipient is a test inbox. Contacts are only those the operator typed. Sends carry a physical-address footer and an opt-out line.
- **Partners:** always "suggested, not affiliated".
- **Promo codes:** created by the box office in its own ticketing platform; Walkup exports suggestions only.
- **Counts:** seats left and capacity are operator what-ifs and are marked as such. The presets carry no seats-left count.
- **Budget split:** proportional to lift and adult population, labelled "heuristic, not a forecast"; the media budget it splits is the operator's what-if.

## Cost caps

| Service | Cap |
|---|---|
| Qloo | Month guard at 1,500 remaining; fresh runs capped at 3 per IP per day and 15 per day in total; cached presets unlimited |
| Claude (OpenRouter or Anthropic) | Daily spend counter capped at $5/day, at Anthropic list rates; narration cached per plan; template narration above the cap |
| Revisions | 12 per network per hour on a live server (30 in sample mode); unchanged Qloo requests come from the cache, so only requests whose inputs changed are sent |
| Google Places | Quota cap of 300 requests/day |
| Resend | Free tier (100/day); test inbox by default |
| Hosting | One small always-on instance (configured in `fly.toml`; not deployed yet) |

## Contact

Open an issue in this repository. Security or data concerns: open an issue titled "security" without details and we will reply with a private channel.
