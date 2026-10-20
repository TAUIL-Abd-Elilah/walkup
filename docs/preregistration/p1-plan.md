# P1 "Fan-Bar Test": preregistered analysis plan

Version 1.0. Sealed 2026-10-13, before any call to the Qloo API, Google Places or a language model for this test. The SHA-256 of this file is in `p1-plan.sha256`; the SHA-256 of the analysis code and of the frozen ground-truth files at sealing time are in `p1-code.sha256`. This file is never edited after sealing. Any departure is logged, dated and explained in `docs/preregistration/p1-deviations.md`, and the published results link to that log.

## 1. Claim tested

Houselights rests on one hop: given an audience entity, Qloo ranks the local places where that audience actually gathers. P1 tests that hop on third-party ground truth:

> Given a supporters' club as the signal, Qloo ranks the club's official home bar in a US metro above (a) a popularity ranking of the same Qloo catalog with the same filters, and (b) the same language model searching Google Places.

## 2. Hypotheses

- **H1 (primary, confirmatory).** Mean reciprocal rank (MRR) of the club's listed bar is higher under **Q-signal** than under **Q-pop**.
- **H2 (secondary, confirmatory under fixed sequence).** MRR is higher under **Q-signal** than under **F**.
- Exploratory (reported, never used for a claim of superiority): recall@10 and recall@50; the LLM-unknown subset; per-club results; the Derby Test; the sensitivity analyses in section 12.

## 3. Ground truth (frozen snapshot of 2026-10-13)

Official supporters'-club home bars, fetched once from the clubs' own public pages with a script that reads robots.txt (`urllib.robotparser`), sends at most one request per second, identifies itself as `HouselightsResearch/0.1 (contact via repo)`, and caches every page (`evals/p1/collect_bars.py`).

| Club (signal) | Source | Rows (US) |
|---|---|---|
| American Outlaws (US national teams) | `https://theamericanoutlaws.com/chapters` and each chapter page's "Where We Watch" list | 256 |
| Arsenal America (Arsenal FC) | `https://arsenalamerica.com/branches/` | 94 |
| LFC Official Supporters Clubs, North America (Liverpool FC) | `https://www.liverpoolfc.com/fans/official-lfc-supporters-clubs/north-america` (served from `/info/north-america`); bar names are in free text, so US rows were extracted by hand and each was re-checked against the live page by the script | 76 |

Stored per row: club, chapter, city, state, bar name, address as listed, source URL, fetch time, page last-updated date when the page shows one, and the club's own designation of the listing (official or satellite spot, team labels USMNT/USWNT, chapter status). Nothing about people. Rows outside the 50 states and DC are dropped (2). The full table stays private (`data/private/p1/bars_full.csv`); a 20-row sample with source links and the aggregate counts are public (`data/p1/`).

The ground truth is not re-collected after sealing. The only later checks are the stale-row rules in section 5.

## 4. Metro, query and unit of analysis

- **Metro point.** Each row's listed city is matched to the U.S. Census Bureau 2026 Gazetteer places file (internal point `INTPTLAT`, `INTPTLONG`), with the county subdivisions file as fallback, using `evals/p1/centroids.py`: aliases from `data/p1/place_aliases.csv` (fixed at sealing), then an exact match of the normalized city name to the Gazetteer name with its one trailing legal descriptor removed, preferring an active government (`FUNCSTAT = A`) and then the larger land area; for consolidated governments the part before "-" or "/" is also a key. At sealing 425 of 426 rows have a metro point (418 places, 7 county subdivisions) and 1 is a miss.
- **Query.** One query is one (club, metro) pair: 393 queries at sealing (American Outlaws 227, Arsenal America 92, LFC 74) over 260 metros. A query's **own bars** are the club's analyzed bars whose metro is that metro.
- **Unit of analysis.** The query. All means, tests and bootstrap resamples are over queries, so a metro with two listed bars for one club counts once.

## 5. Exclusions, applied in this order and counted before any result

Each bar gets the first status below that applies. The coverage table (listed, then each exclusion, then analyzed, per club, with the resolution rate) is produced after resolution and before any arm call, and it is printed first in every results file. The run date is the date of the first resolution call.

1. **stale_page**: the source page shows a last-updated date more than 2 years before the run date. Pages that show no date (American Outlaws chapter pages) are not excluded by this rule.
2. **no_metro**: no Gazetteer point (section 4).
3. **no_brand**: the club's brand entity did not resolve (section 6); the whole club is excluded.
4. **unresolved**: the bar did not resolve to a Qloo place (section 7). Resolution rate = resolved / (listed - stale_page - no_metro - no_brand).
5. **closed**: the bar's resolved Google place has `businessStatus` `CLOSED_PERMANENTLY` or `CLOSED_TEMPORARILY` (checked once during the run). A bar with no resolved Google place cannot be checked and is kept.
6. **out_of_radius**: the resolved Qloo place lies more than 25 km from its metro point, so no arm can retrieve it by construction.
7. **analyzed**: everything else.

## 6. Club signal entities

`GET /search?query=<q>&types=urn:entity:brand` for each preregistered name, in order, until a result is accepted:

- Arsenal America: "Arsenal F.C.", "Arsenal FC", "Arsenal Football Club", "Arsenal"
- LFC OLSC: "Liverpool F.C.", "Liverpool FC", "Liverpool Football Club", "Liverpool"
- American Outlaws: "United States men's national soccer team", "United States Men's National Team", "U.S. Men's National Soccer Team", "USMNT"

A result is accepted when its name has `name_similarity` (section 7) of at least 0.85 to any of that club's preregistered names and its tags (from `/search`, or from `GET /entities?entity_ids=<id>` when `/search` omits tags) include a tag id containing `sports_organization`. If several results of one call qualify, the higher `popularity`. American Outlaws supports both national teams; the signal is the men's team entity only, and this is a stated limitation. The accepted ids are written to `evals/p1/club_entities.json` before any arm call.

## 7. Resolution rule (listed bar to Qloo place)

**Name similarity** (`evals/p1/matching.py`, `name_similarity`): normalize both names (Unicode NFKD with accents removed, casefold, "&" to "and", apostrophes removed, other punctuation to spaces, whitespace collapsed, one leading "the" removed). Similarity is the maximum of: the `difflib.SequenceMatcher` ratio of the normalized strings; the same ratio on the alphabetically sorted tokens; and 1.0 when the shorter name has at least two tokens and appears as a contiguous token run inside the longer one (else 0).

**Primary path.** When the listed address starts with a street number, geocode "address, city, state" with the Census Geocoder (`onelineaddress`, benchmark `Public_AR_Current`) to point A. Call `GET /search?query=<bar_name>&types=urn:entity:place&filter.location=POINT(<lonA> <latA>)&filter.radius=1&take=20` (radius in miles on `/search`). A candidate qualifies when its location is within **300 m** of A (haversine) and its name similarity to the listed name is at least **0.85**. Several qualify: highest similarity, then nearest; an exact tie on both is unresolved (ambiguous). `resolution_via = primary`.

**Fallback path.** When the listing has no street address or the geocoder returns no match: the same call with `filter.location` at the metro point and `filter.radius=16` (about 25 km). Accept only if **exactly one** candidate has name similarity of at least **0.95** and lies within 25 km of the metro point, and, when both the listing and the candidate's address show a 5-digit ZIP code, the two are equal. `resolution_via = fallback`.

A 404, an empty result, or no qualifying candidate is **unresolved**. Distances are always computed by us from returned coordinates, so a location parameter that the API ignores cannot loosen the rule.

**Google place for each bar** (for arm F and the closed check): Places API (New) Text Search with `textQuery = "<bar_name>, <address or city, state>"`, `locationBias` circle at A (300 m) or at the metro point (25 km) on the fallback path, fields `id, displayName, formattedAddress, location, businessStatus`. The same acceptance rules apply. A bar with no resolved Google place has no F row and is not part of H2.

## 8. Candidate generation and arms

All Qloo arms use the metro point P, a 25 km radius and a pinned union of four place tags. Tag ids are pinned once before any arm call by `GET /v2/tags?filter.query=<word>&filter.parents.types=urn:entity:place` for the words "bar", "pub", "sports bar" and "irish pub": accept the tag whose normalized name equals the word (if several, the one in the `urn:tag:category:place` namespace). The ids are written to `evals/p1/pinned_tags.json`; a word with no accepted tag is dropped from the union and recorded.

- **Q-signal** (one call per query):
  `GET /v2/insights?filter.type=urn:entity:place&signal.interests.entities=<club entity>&filter.location=POINT(<lon> <lat>)&filter.location.radius=25000&filter.tags=<pinned ids>&operator.filter.tags=union&take=50`
- **Q-pop** (one call per metro, shared by every club in that metro): the same request without `signal.interests.entities`. Its rank order is Qloo's returned order; whether that order is monotone in `popularity` is recorded and reported.
- **F** (same model plus Google Places; one conversation per query): `claude-opus-5-5`, `output_config.effort = "medium"`, one strict tool `places_search(query)` backed by Places API (New) Text Search with `locationBias` circle (P, 25 km), up to 20 results per call, at most 5 tool calls per query. User prompt, verbatim: "Rank up to 50 bars and pubs in <metro display name>, <state> that fans of <club display name> love. Use the places_search tool to find candidates. Return only place ids that the tool returned, best first." Output schema `{"place_ids": string[]}` (at most 50). Rank = position of the bar's resolved Google place id; ids the tool never returned are dropped before ranking.
- **L** (model alone; one call per query; contamination measure, never part of H1 or H2): `claude-opus-5-5`, `output_config.effort = "low"`, no tools. User prompt, verbatim: "Name the bar or pub where the official <club display name> supporters' group in <metro display name>, <state> watches matches. Give up to 3 names, most likely first." Output schema `{"names": string[]}` (at most 3). Rank = position of the first name with name similarity of at least 0.85 to the listed bar name, else blank.

The metro display name, the club display names and the fixed system prompt shared by both model arms are given verbatim in `evals/p1/ARMS.md`. Both model arms run without server-side model fallback, and discard and retry once any response whose `model` is not `claude-opus-5-5`. A refusal is recorded as an empty list.

**Rank.** The 1-based position of the bar's resolved Qloo entity id (Q arms) or Google place id (F) in the arm's list; blank when absent from the top 50. `candidates_n` = list length.

**Filter honoured check.** If any Q-signal or Q-pop response contains an entity more than 26 km from P, the location filter was not applied: the run stops, the issue is logged as a deviation, and the run restarts only after the fix is recorded.

**Failures.** 429, 5xx and timeouts are retried up to 3 times with backoff. A call that still fails leaves no rows for that (query, arm); the query is then absent from comparisons that need that arm, and the count is reported.

**Budget.** Qloo: about 1,300 calls (resolution about 430, Q-signal 393, Q-pop 260, Derby about 220). Google Places Text Search: at most 2,500 requests in total. If the planned F calls would exceed that cap, F runs on a random subset of queries drawn with seed 20261013 before any F call, sized to fit; H2 is then tested on that subset.

**Order.** Club entities and tags, then all resolutions (coverage table frozen), then Q-pop, Q-signal, F, L and Q-derby. Raw responses are cached locally and never committed.

## 9. Metrics

For query q and arm a, with R the own bars that have a row in arm a:

- reciprocal rank RR(q, a) = 1 / (smallest rank among R within the top 50), or 0 when none is in the top 50;
- recall@k(q, a) = share of R ranked at or above k, for k = 10 and 50;
- MRR (primary) and mean recall@k are means over queries.

## 10. Tests and intervals

- **Paired Wilcoxon signed-rank** on per-query RR, one-sided (alternative: the first arm is greater), `scipy.stats.wilcoxon(zero_method="wilcox", alternative="greater", method="auto")` in SciPy 1.17.1, alpha = 0.05. Zero differences are dropped and their number reported.
- **Pairing.** For each query, only bars that have a row in both arms count (F has rows only for bars with a resolved Google place).
- **Fixed sequence.** H1 is tested at alpha = 0.05. H2 is tested confirmatorily at alpha = 0.05 only if H1 is rejected; otherwise H2 is reported as exploratory.
- **Minimum size.** A test is confirmatory only with at least 20 paired queries; otherwise the result is reported as inconclusive.
- **Bootstrap.** Percentile 95% intervals from 10,000 resamples of queries, one `numpy.random.default_rng(20261013)` generator for the whole analysis, in the order implemented in `evals/p1/analyze.py`, for each arm's MRR, recall@10 and recall@50 and for the paired MRR differences (Q-signal minus Q-pop, Q-signal minus F).
- Implementation: `evals/p1/analyze.py` (input format in `evals/p1/ARMS.md`), tested on synthetic data in `evals/p1/test_analyze.py`.

## 11. The Derby Test (secondary)

- **Metros.** Metros where at least two clubs have an analyzed bar (92 metros at sealing, before resolution).
- **Primary bar** per (club, metro): an official listing first, then the smallest `bar_key`; never chosen by rank.
- **Call (arm Q-derby).** For each signal club c in such a metro, one shortlist call: `GET /v2/insights?filter.type=urn:entity:place&signal.interests.entities=<c>&filter.results.entities=<c's primary bar>,<each rival club's primary bar>&take=10`.
- **Trial** (c, metro, rival r): correct when c's own primary bar ranks above r's primary bar under c's signal. A bar missing from the response has rank infinity; both missing is a tie, excluded and counted; the same Qloo place listed by both clubs is excluded and counted.
- **Report.** Pairwise accuracy against 50% with a one-sided exact binomial test and an exact (Clopper-Pearson) two-sided 95% interval, the number of trials and metros, and a metro-level version (one outcome per metro by majority of its trials; even splits dropped). If no Q-derby rows exist, the same computation runs on the Q-signal lists and the report says so.

## 12. LLM-unknown subset and sensitivity analyses (exploratory)

- **LLM-unknown subset**: queries where L named none of the club's bars in that metro. Reported with the same metrics and exploratory Wilcoxon tests, together with the share of queries where L named the bar.
- **Sensitivity** (reported, never used for a decision): H1 restricted to official listings (satellite spots removed); H1 restricted to primary-path resolutions (fallback resolutions removed); per-club MRR and recall for every arm.

## 13. Decision, honesty rule and publication pledge

- **H1 supported** only if H1 is rejected under section 10. Then partner cards may state the measured result with its numbers and n.
- **H1 not supported or inconclusive**: partner cards carry the banner "Ranked by Qloo affinity; our test did not show this beats popularity.", and the public write-up says so in plain words.
- A claim that Qloo beats the Google Places arm is made only if H1 and H2 are both rejected in sequence.
- **Publish-null pledge.** The results are published whatever they show: coverage first, then the preregistered tests, with this plan's hash and the deviations log. No re-run with changed parameters is presented as the primary result; anything not specified here is labelled exploratory.
- **Viability gate.** Before the full run, the club-entity check of section 6 runs, and the (club, metro) combinations of the three clubs with Houston, Chicago and Durham that have a listed bar (8 at sealing) are resolved and ranked with these exact rules. If fewer than 6 of the 8 resolve, or fewer than 3 land in the Q-signal top 50, P1 still runs and is published in full, but it is not presented as the lead evidence. The probe rows are part of the sample, since this plan was sealed before the probe ran.

## 14. Leakage and limits

- **Designation leakage.** A supporters' bar may be co-engaged with its club partly because it is the designated bar. That is the signal the product uses ("where this audience already gathers"), but P1 does not show that Qloo would predict where fans would go if no bar were designated.
- **Memorization.** The model arms may have memorized supporters'-bar lists. Arm L measures this; the LLM-unknown subset is reported separately. The F arm may also find a bar through reviews that mention the club; that is part of a fair best effort, not a flaw.
- **Ground-truth noise.** Lists can be out of date. American Outlaws chapter pages show no update date, and 90 of 256 American Outlaws rows come from chapters the club marks as "Rebuilding". The closed check covers only bars with a resolved Google place.
- **Geography.** The metro point is a Census internal point, not a downtown; bars beyond 25 km are excluded and counted. Some listings name only a neighbourhood, a landmark or a region.
- **Signal scope.** One brand entity per club; American Outlaws is represented by the men's team entity only.
- **Shared bars.** Some places are listed by two clubs (37 same-metro name matches at sealing). They count for each club in H1 and H2 and are excluded from the Derby Test.
- **What P1 does not establish**: that a Street Sheet sells tickets; that affinity equals attendance or purchase; anything about any individual; performance outside these three clubs and US metros.

## 15. P1b (attempted, gated): ticket-outlet recall

Public package-show listings and flyers that name "tickets available at" local outlets (Eventbrite and Ticketmaster listing text, venue pages) are collected with the same politeness rules. If **30 or more (show, outlet) pairs** exist by 2026-10-20, they are scored like P1 with the bill's acts as the signal and the outlet as the target: same resolution rule; Q-signal and Q-pop calls at the venue's point with a 25 km radius and the pinned tag of the outlet's category in place of the bar tags; same metrics; descriptive only, with no confirmatory test. If fewer, the result is published as "attempted; public corpus too small (n = k)". Presenting radio stations are not Qloo entities and are not scored.

## 16. Environment

Python 3.11, NumPy 2.4.6, SciPy 1.17.1. Seed 20261013 for every random draw (bootstrap, F subset, public sample).
