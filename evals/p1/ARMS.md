# P1 arms: exact request shapes

This is the implementation contract for the P1 run described in `docs/preregistration/p1-plan.md`. Nothing here has been called yet: no Qloo key exists, and the Google Places and model arms wait for the same run. Section numbers (§) refer to the plan. This file is sealed with the plan (its hash is in `docs/preregistration/p1-code.sha256`); changes after sealing go to the deviations log.

Conventions:

- Qloo base URL from `$QLOO_BASE_URL` (see `.env.example`), header `X-Api-Key: $QLOO_API_KEY`. WKT is `POINT(<lon> <lat>)`, longitude first.
- `/search` returns a flat `results[]`; `/v2/insights` returns `results.entities[]`. `/search` radius is in **miles**; insights radius is in **metres**.
- The API ignores unknown or inapplicable parameters with HTTP 200, so every location constraint is re-checked on our side from returned coordinates.
- Every response is cached on disk under a git-ignored path and logged (endpoint, params with the key redacted, status, latency, result count). Raw Qloo or Google bodies are never committed.
- Retries: 429, 5xx and timeouts, up to 3 times with exponential backoff (1 s, 2 s, 4 s). At most 3 Qloo requests per second.
- `P = (lat, lon)` is the query's metro point (`metro_lat`, `metro_lon` in `bars_full.csv`).
- **Metro display name** (used in prompts): `centroids.metro_display_name(metro_name)`, e.g. "Nashville-Davidson metropolitan government (balance)" gives "Nashville". State = `metro_state`.
- **Club display names** (used in prompts): `arsenal_america` = "Arsenal FC"; `lfc_olsc` = "Liverpool FC"; `american_outlaws` = "USMNT (US men's national soccer team)".

## 0. One-time setup calls

### 0a. Club entities (§6)

```
GET /search?query=<name>&types=urn:entity:brand
```

For each club, try its preregistered names in order (§6). Accept a result when `name_similarity(result.name, any club name) >= 0.85` and a tag id contains `sports_organization` (if `/search` omits tags: `GET /entities?entity_ids=<id>`). Several in one call: highest `popularity`. Write:

```json
// evals/p1/club_entities.json
{ "arsenal_america": "<entity_id>", "lfc_olsc": "<entity_id>", "american_outlaws": "<entity_id>" }
```

A club with no accepted entity gets `null`; its rows get status `no_brand`.

### 0b. Pinned place tags (§8)

```
GET /v2/tags?filter.query=<word>&filter.parents.types=urn:entity:place
```

for each word in `bar`, `pub`, `sports bar`, `irish pub`. Accept the tag whose `normalize_name(name) == normalize_name(word)`; if several, prefer an id starting `urn:tag:category:place`. Write `evals/p1/pinned_tags.json` as `{ "<word>": "<tag id or null>" }`. `PINNED` below is the comma-joined list of non-null ids.

## 1. Resolution (§7), one per listed bar

**Census geocode** (primary path only, when the address has a street number):

```
GET https://geocoding.geo.census.gov/geocoder/locations/onelineaddress
    ?address=<address>, <city>, <state>&benchmark=Public_AR_Current&format=json
```

Point A = first `result.addressMatches[].coordinates` (`x` = lon, `y` = lat). No match: fallback path.

**Qloo, primary path:**

```
GET /search?query=<bar_name>&types=urn:entity:place&filter.location=POINT(<lonA> <latA>)&filter.radius=1&take=20
```

Qualify: `haversine(candidate.location, A) <= 300` m and `name_similarity(bar_name, candidate.name) >= 0.85`. Pick highest similarity, then nearest; exact tie on both = unresolved.

**Qloo, fallback path** (no street address, or no geocoder match):

```
GET /search?query=<bar_name>&types=urn:entity:place&filter.location=POINT(<lon> <lat>)&filter.radius=16&take=20
```

with P as the point. Resolve only if exactly one candidate has similarity `>= 0.95`, lies within 25 km of P, and, when both the listing and `properties.address` show a 5-digit ZIP, the ZIPs are equal.

**Google place** (for F and the closed check):

```
POST https://places.googleapis.com/v1/places:searchText
X-Goog-Api-Key: $GOOGLE_PLACES_API_KEY
X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus
{ "textQuery": "<bar_name>, <address or city, state>",
  "locationBias": { "circle": { "center": { "latitude": <lat>, "longitude": <lon> }, "radius": <300.0 or 25000.0> } },
  "pageSize": 20 }
```

Centre A with 300 m on the primary path; P with 25,000 m on the fallback path. Same acceptance rules as Qloo. `businessStatus` in `CLOSED_PERMANENTLY` or `CLOSED_TEMPORARILY` gives status `closed`.

**Out of radius:** a resolved Qloo place more than 25 km from P gets status `out_of_radius`.

The bars status file (input to `analyze.py --bars`) is written after this step and before any arm call:

```
club,bar_key,metro,status,entity_id,google_place_id,resolution_via
```

`status` is one of `stale_page | no_metro | no_brand | unresolved | closed | out_of_radius | analyzed`.

## 2. Q-signal (one call per query = (club, metro))

```
GET /v2/insights
    ?filter.type=urn:entity:place
    &signal.interests.entities=<club entity id>
    &filter.location=POINT(<lon> <lat>)
    &filter.location.radius=25000
    &filter.tags=<PINNED>
    &operator.filter.tags=union
    &take=50
```

Ranked list = `results.entities[].entity_id` in returned order. Stop the run if any returned entity's location is more than 26 km from P (§8, filter honoured check).

Rival rows (needed for the §11 fallback, when no Q-derby rows exist): in a metro where another club also has analyzed bars, write one Q-signal row per rival club's analyzed bar as well, with `bar_club` = the rival club and `rank_or_blank` = the position of that bar's entity in this same list (blank if absent). `analyze.py` ignores these rows for H1, H2 and every per-arm metric; only the Derby Test reads them.

## 3. Q-pop (one call per metro, shared by all clubs there)

The same request as Q-signal without `signal.interests.entities`. Record whether `popularity` is non-increasing down the list (reported, not used for ranking).

## 4. F: same model plus Google Places (one conversation per query)

Model call (TypeScript SDK shape; see `docs/claude-api-notes.md`), inside a manual tool loop:

```ts
client.messages.parse({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  output_config: { effort: "medium", format: zodOutputFormat(FAnswer) }, // FAnswer: the schema below
  system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
  tools: [PLACES_SEARCH_TOOL],          // strict: true
  messages: [{ role: "user", content: F_PROMPT }],
});
```

No `thinking` parameter, no `tool_choice` other than the default, no server-side fallback. A response whose `model` is not `claude-opus-5-5` is discarded and retried once. `stop_reason: "refusal"` is recorded as an empty list.

`SYSTEM_PROMPT` (shared by F and L, verbatim):

```
You are a research assistant helping a live-event marketing team understand local venues. Follow the instructions in the user message and answer only in the requested JSON format.
```

`F_PROMPT` (verbatim, placeholders filled):

```
Rank up to 50 bars and pubs in <metro display name>, <state> that fans of <club display name> love. Use the places_search tool to find candidates. Return only place ids that the tool returned, best first.
```

`PLACES_SEARCH_TOOL`:

```json
{
  "name": "places_search",
  "description": "Search Google Places near the metro. Returns up to 20 places with id, name, address, rating, userRatingCount and businessStatus.",
  "input_schema": {
    "type": "object",
    "properties": { "query": { "type": "string", "description": "Free-text place search, e.g. 'soccer pub'." } },
    "required": ["query"],
    "additionalProperties": false
  },
  "strict": true
}
```

Tool execution:

```
POST https://places.googleapis.com/v1/places:searchText
X-Goog-FieldMask: places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.businessStatus
{ "textQuery": "<query>",
  "locationBias": { "circle": { "center": { "latitude": <lat>, "longitude": <lon> }, "radius": 25000.0 } },
  "pageSize": 20 }
```

The tool result given to the model is a JSON array of `{id, name, address, rating, userRatingCount, businessStatus}`. At most 5 tool calls per query; a sixth call gets `is_error: true` with "tool budget reached; give your answer now". All `tool_result` blocks of one turn go back in one user message.

Output schema: `{ "place_ids": string[] }` (at most 50, `additionalProperties: false`). Structured outputs do not enforce array length (the SDK strips the constraint and would only fail validation on the client), so define the array without a length cap and keep the first 50 entries. Ids the tool never returned in this conversation are dropped before ranking. Rank of a bar = position of its resolved Google place id.

Budget: at most 2,500 Places Text Search requests in total including resolution (§8). If the plan would exceed it, draw the F subset of queries with `random.Random(20261013)` before any F call.

## 5. L: model alone (one call per query)

Same model and call shape, `output_config: { effort: "low", format: zodOutputFormat(LAnswer) }` with `LAnswer = { "names": string[] }` (at most 3; as in F, no length cap in the schema, keep the first 3), same `SYSTEM_PROMPT`, no tools.

`L_PROMPT` (verbatim):

```
Name the bar or pub where the official <club display name> supporters' group in <metro display name>, <state> watches matches. Give up to 3 names, most likely first.
```

Rank of a bar = position of the first returned name with `name_similarity(name, bar_name) >= 0.85`; blank otherwise. `candidates_n` = number of names returned.

## 6. Q-derby (one call per signal club in each metro with two or more clubs)

```
GET /v2/insights
    ?filter.type=urn:entity:place
    &signal.interests.entities=<club c entity id>
    &filter.results.entities=<c's primary bar entity>,<each rival club's primary bar entity>
    &take=10
```

Primary bar per (club, metro): official listing first, then the smallest `bar_key`. If two clubs' primary bars are the same Qloo entity, send the id once and record both rows with the same `entity_id` (the analysis excludes the pair as shared).

## 7. Output: the arms CSV (input to `evals/p1/analyze.py --arms`)

One row per (query, bar, arm) for every bar eligible for that arm; a bar the arm did not return still gets a row with a blank rank. Omit a row only when the bar is not eligible for that arm (F: no resolved Google place). Q-pop rows are written per query, reusing the metro's shared call.

```
club,metro,bar_key,arm,rank_or_blank,candidates_n,bar_club,listing_role,resolution_via,entity_id
```

| column | meaning |
|---|---|
| club | the signal (or prompt) club of the query |
| metro | `metro_geoid` |
| bar_key | listed-row key from `bars_full.csv` |
| arm | `Q-signal`, `Q-pop`, `F`, `L`, `Q-derby` |
| rank_or_blank | 1-based rank in the arm's list; blank if absent |
| candidates_n | length of the arm's list for this query |
| bar_club | club that lists the bar; differs from `club` only on rival rows (Q-derby, and Q-signal in metros with two or more clubs) |
| listing_role | `official` or `satellite` |
| resolution_via | `primary` or `fallback` |
| entity_id | resolved Qloo entity id |

Then:

```
python evals/p1/analyze.py --arms <arms.csv> --bars <bars_status.csv> --out evals/p1/out
```

writes `evals/p1/out/p1_results.json` and `evals/p1/out/p1_results.md`, coverage first.

## 8. Expected call counts at sealing

| Call | Count |
|---|---|
| Club entities and tags | about 10 |
| Qloo resolution | about 430 |
| Q-signal | 393 |
| Q-pop | 260 |
| Q-derby | about 225 |
| Google Places (resolution + F) | at most 2,500 |
| Model calls (F conversations + L) | 393 + 393 |

## 9. Runner (added 2026-10-13, after sealing)

Sections 0 to 8 are unchanged. The runner is `evals/p1/run_arms.ts`, with its modules and tests in `evals/p1/arms/` (see `evals/p1/arms/README.md`). This section records how it settles the details that sections 0 to 8 leave open. None of them changes a request shape, a threshold or a metric.

```bash
npx tsx evals/p1/run_arms.ts --dry-run       # plan and call counts; no keys, nothing sent or written
npx tsx evals/p1/run_arms.ts --viability     # §13 probe: Houston, Chicago, Durham, Q-signal only
npx tsx evals/p1/run_arms.ts                 # the full run; re-run the same command after any stop
```

Outputs: `evals/out/private/p1_arms.csv` (§7) and `evals/out/private/p1_bars_status.csv` (§1), both git-ignored; a private run log and call ledger; `evals/out/p1_arms_summary.json` and `.md` (counts only); `evals/p1/club_entities.json` and `evals/p1/pinned_tags.json` (§0). Responses and run state are cached in `data/private/p1/run/` (git-ignored).

How the runner settles open details:

1. **Order.** §0, then every resolution, then the status file, then Q-pop, Q-signal, F, L, Q-derby. Each bar's decision is stored once and reused on resume. The run date is set just before the first resolution call.
2. **Brand tags.** When `/search` returns name-qualified results without tags, one `/entities` call per `/search` call fetches all of them (comma-joined ids). Equal or missing popularity keeps response order.
3. **Tag pins.** If several equally eligible tags remain, the first in response order is taken and the run log says so. `config/tags.json` is compared with the pins and never used in their place.
4. **Path.** The primary path applies when the address starts with a digit, the test `publish_sample.py` uses for "with street number". The geocoder receives the literal string `<address>, <city>, <state>`.
5. **Fallback ZIP rule.** Exactly one candidate must have similarity ≥ 0.95 and lie within 25 km of P. That candidate is rejected if both it and the listing show a 5-digit ZIP and the two differ, following the wording of plan §7. A ZIP counts only at the end of an address (after the city or state, optionally followed by the country).
6. **Google place.** It is resolved only for bars that resolved to a Qloo place, because the result can change no other status. It uses the same path as the Qloo search.
7. **Calls.** Q-pop is called only for metros, and Q-signal only for queries, that have at least one analyzed bar. Q-derby rows are written for the primary bars only, the bars its shortlist contains.
8. **Ranks.** A rank is the position in the returned list, counting every returned entry.
9. **F answer.** The runner keeps the first 50 entries of `place_ids`, then drops ids the tool never returned and repeated ids (the first occurrence stays). `candidates_n` is the length after that. Tool calls run in the order the model sent them. A conversation with no answer after 12 model turns counts as failed.
10. **Model failures.** An answer that does not parse, or a `max_tokens` stop, counts as a failed call with no rows, like a call that still fails after its retries. A refusal is an empty list: its rows have blank ranks. The `model` check accepts `claude-opus-5-5` and dated snapshots of it.
11. **F subset.** The population is the F-eligible query keys (`<club>|<metro_geoid>`) in sorted order. The size is floor((2,500 minus Places requests already sent) / 5). The draw is `random.Random(20261013).sample(population, size)`, ported to TypeScript and checked against CPython 3.11. It is drawn once per query set, before any F call, and stored.
12. **Retries.** Qloo, Places, Census and model calls are retried 3 times, at 1 s, 2 s and 4 s, on 429, 5xx, network errors and timeouts (30 s per request; the model SDK's own retries are off). A resolution call that still fails stops the run, because the coverage table must be complete. An arm call that still fails leaves no rows and is counted. In arm F this includes a `places_search` request that still fails: the conversation counts as failed (no rows) rather than handing the model an error and ranking a shorter candidate list; a 401 or 403 stops the run; any other Places error (for example a 400 for the model's query text) goes back to the model as a tool error.
13. **Shared clients.** Places requests carry the `@walkup/places` field mask (a superset of the fields above) and `maxResultCount: 20` in place of `pageSize: 20`. Model calls use `messages.create` with `output_config.format = zodOutputFormat(...)` and parse the answer with the same zod schema. The request body is the one `messages.parse` sends.
14. **Guards.** The runner enforces a per-run Qloo cap (default 900 requests; the run stops and the next run resumes from the cache), the plan's 2,500 Places requests, a Places daily cap and a daily model spend cap.
