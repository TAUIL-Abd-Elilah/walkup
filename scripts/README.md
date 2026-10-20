# scripts

Day-one API probe, the key-day room tool and repository hygiene.

| Path | What it is |
|---|---|
| `probe.ts` | The probe CLI (`npm run probe`). Self-contained: raw `fetch`, its own 3 req/s pacing, a hard 100-call cap. It does not use `@walkup/qloo`. |
| `probe.config.json` | Probe inputs: venue points (with sources), test bills, clubs and metros, tag keywords, thresholds. |
| `tm-room.ts` | The key-day room tool (`npm run tm:room`). Finds one room on Ticketmaster, prints its house roster and the hero rule's two picks with every candidate in the window, warns about anything that would stop a plan, and with `--write-probe` writes the room's point and roster Spotify ids into `probe.config.json`. Ticketmaster only (`@walkup/tm`); no Qloo call. |
| `lib/tm-room.ts` | Its core on an injected Ticketmaster client: exact venue match, roster, window read, the rule's working (`explainG1Rule` from `@walkup/orchestrator`), pick checks, and the targeted config rewrite. |
| `lib/stats.ts` | `kendallTau` (tau-b), `kendallTauFromOrders`, `spearman`, `pearson`, `ranks`, `pctRank`, `topKOverlap`, `jaccard`. Pure; NaN when undefined. |
| `lib/probe/*` | Request builders, client, extractors, lift math, gate arithmetic, the 20 probes, runner, SUMMARY writer. |
| `check-no-raw.mjs` | Fails when git would publish private data or raw API bodies (`npm run check:no-raw`). |
| `../.githooks/pre-commit` | Runs `check-no-raw.mjs` before every commit. `../.githooks/.gitattributes` keeps it LF so `sh` can run it on Windows checkouts. |
| `test/` | Vitest suites (offline; synthetic data only). |

## Key day: pick the room, then run the probe

1. Put `TICKETMASTER_API_KEY` and `QLOO_API_KEY` in `.env` at the repo root (see `.env.example`). The keys are read from the environment and never printed or written: Qloo's goes only in the `X-Api-Key` header, Ticketmaster's only in Discovery's `apikey` parameter.
2. **Find the room and the two hero bills** (Ticketmaster only, nothing written):
   ```sh
   npm run tm:room -- --name="The Truth" --city=Nashville --state=TN
   ```
   The tool matches the exact name in the exact city (`/venues`, then the venues on matching `/events`). Anything else prints the candidates (id, name, city, address, link) and exits 2: run it again with `--venue-id=<id>`. It then prints:
   - the room's next 60 events from `--as-of` (default today, UTC), as a plan reads them: date, name, genre labels, genre class, status and the headliner's Spotify id or `-`;
   - the roster Spotify ids in house-set order (the top 20 headliners by recency and frequency, deduped);
   - every event dated in the hero window (`HERO_WINDOW`, Dec 20 2026 to Feb 28 2027; `--window=FROM:TO` to change it) with its genre class and distance, then bill A and bill B by `HERO_RULE` with a one-line reason each;
   - warnings: a pick Walkup cannot build a bill from, a headliner with no Spotify link (the spec needs both headliners to resolve exactly), a postponed pick, a window over Discovery's 1,000-result limit.
3. **Fill the room's point and roster** when the picks look right:
   ```sh
   npm run tm:room -- --venue-id=<id> --write-probe
   ```
   This rewrites `venues.the-truth` (`lat`, `lon`, `note`, `source` citing the venue record) and `roster` (`venue`, `spotifyIds`, a note with the venue id and as-of date) in `probe.config.json`, leaves every other line as it is, and validates the file; on any problem nothing is written and it exits 2. It refuses a venue whose name or city differs from the entry: for another room, pass `--probe-key=<new-key>` to add it as its own entry, then point `kg2.venue` at it. Until the point is filled, probes that need The Truth fall back to the Ryman; without roster ids the house set is a stand-in (the test headliners of the other two rooms) and probe #18 is skipped.
4. **Re-run KG2** on the filled room:
   ```sh
   npm run probe -- --only=2
   ```
5. The other key-day inputs, by hand:
   - `venues.super-funny-tacoma.lat/lon` from its Ticketmaster venue record (`npm run tm:room -- --name="Super Funny Comedy Club" --city=Tacoma --state=WA` prints the point; do not `--write-probe` it, since that also rewrites `roster`) or from the club's own published address. Until then the Tacoma heatmap uses the Tacoma city point.
   - KG4 bars: either fill `kg4.bars[].barName` (+ `lat`/`lon` if known) or write the rows to `data/private/p1/kg4-bars.json` (git-ignored) as `[{ "club": "arsenal", "metro": "houston", "barName": "...", "lat": 29.7, "lon": -95.3, "sourceUrl": "..." }, ...]`. The file only fills rows that are `null` in the config.
6. Review the plan (no key needed, nothing sent, nothing written):
   ```sh
   npm run probe -- --dry-run
   ```
7. Run the three gates (37 calls as shipped, 51 with every key-day input; well under a minute at 3 req/s):
   ```sh
   npm run probe -- --only=1,2,3
   ```
   Read `probe_out/<timestamp>/SUMMARY.md`: the KG1, KG2 and KG4 go/no-go lines are at the top.
8. Then the rest:
   ```sh
   npm run probe -- --only=4-20
   ```
   The summary then covers 4-20 only. A plain `npm run probe` repeats the gate calls (each run has its own memo), and with every key-day input filled it plans 99 of the 100 calls, so one retry can stop it before the last probes.

The two hero picks go into the `live` blocks of g1-a and g1-b in `packages/orchestrator/src/presets.ts` (event id, venue id, as-of date, title, venue, `HERO_RULE` as the rule, operator inputs with no fixture-world ids, line). Until then a live run of those presets stops with "This preset has no live show yet."

Probe flags: `--dry-run`, `--only=1,2,3` (lists and ranges, e.g. `--only=1-3,9`), `--verbose` (every request with params and rate-limit headers; `--dry-run --verbose` adds copy-as-curl and memo reuse lines), `--budget=N` (lower the cap; never above 100), `--config=path`, `--out=dir`, `--help`. Exit codes: 0 completed (whatever the verdicts), 2 usage or config error, 3 aborted by the call cap or the monthly-quota floor.

`tm:room` flags: `--name`, `--city`, `--state` (city and state are required with `--name`), `--venue-id` (skips the search), `--as-of=YYYY-MM-DD`, `--window=FROM:TO`, `--probe-key=KEY` (default `the-truth`), `--write-probe`, `--config=path`, `--json` (the report as JSON on stdout, without Ticketmaster bodies), `--save` (the roster and window bodies to `probe_out/tm-room-<timestamp>/`, git-ignored), `--help`. The window request runs to the end of the day after the window's last day (Discovery filters on UTC instants), and the rule keeps events by their local date. Exit codes: 0 done (warnings included), 2 usage, config or venue-choice error, 3 Ticketmaster refused or failed.

## What the probe does

Run order: probes 1-3 (the gates), then 4-20 by number. Requests that repeat inside one run (resolutions, the place pools) are made once and reused.

| # | Probe | Pass criterion |
|---|---|---|
| 1 | **KG1** taste moves partners | Per room, one 1.5 km pool of 30 places (no-signal call = popularity order) scored by two contrasting bills via `filter.results.entities`: Kendall tau(A, B) < 0.8, top-8 overlap A/B <= 5, and each bill vs popularity <= 5. Gate: 2 rooms pass |
| 2 | **KG2** lift differs from heat | Bill A, bill B, house and generic heatmaps (40 km): Spearman(lift, raw heat) < 0.8 for both bills; top-decile lift tile Jaccard A vs B < 0.5 |
| 3 | **KG4** fan-bar viability | 3 clubs x 3 metros: >= 6/9 bars resolve, >= 3/9 in the club-signal top 50 (bars/pubs, 25 km). Also counts derby pairs |
| 4 | Club brands | Exact brand match + `sports_organization` tag |
| 5 | Comedy bill resolution | Headliner exact as a person; ambiguity and thin act recorded |
| 6 | **KG3** headliner heatmap density | >= 200 cells within 40 km and Spearman(lift, heat) < 0.8; title proxies recorded |
| 7 | Demographics and tag profile | Blocks and tags returned; denied tag families and film/kids markers counted (denylist regression case) |
| 8 | Venues as places | Recorded only |
| 9 | Pin place tags | Tag found via `/v2/tags`, `filter.tags` returns >= 5 rows within 25 km, and at least half the rows carry the tag (or a child of it); prints the pinnable ids |
| 10 | `filter.hours` | Results change |
| 11 | Podcasts + `signal.location` | Top-15 overlap <= 12/15 |
| 12 | Brands + `signal.location` + `filter.exclude.tags` | Ranking changes; no excluded tags remain |
| 13 | Compare bill vs house | >= 5 usable distinctive `a` tags |
| 14 | POST weighted entities | 200, and swapped weights change the top tiles |
| 15 | `filter.results.entities.query` | >= 2/3 names resolve |
| 16 | `signal.demographics.age` on places | Top 10 changes |
| 17 | `/v2/audiences` | URNs for each keyword; the alumni URN moves the top 10 |
| 18 | `/entities` by Spotify id | >= 7/10 resolve |
| 19 | Comedy-tag heatmap, Tacoma 60 km | >= 200 cells |
| 20 | Guest-slate scoring | 10/10 scored, non-uniform affinities |

The shipped config plans 84 requests; with every key-day input filled it plans 99 (the-truth's point adds a KG1 room). The cap counts HTTP attempts, retries included.

A failed call never counts as "the results changed": when the deciding call of probes 10, 12, 16 or 17 returns a 4xx (other than 429) the probe fails (the API refused that parameter), and on no response, 429 or 5xx it is inconclusive. HTTP errors on the KG3 and Tacoma heatmaps (6, 19) and on the KG4 club lists (3) give INCONCLUSIVE, not NO-GO. When a KG1 act matches no exact name, the top search hit is used and the detail lines say so.

**Signal check (Oct 15).** Qloo can list an act under `/search` and still have no taste data for it: insights then answer 200 with a top-level `warnings[{type:"not_found","signal.interests.entities":[id]}]` and rank without that id (a heatmap drops it silently). Bills and stand-in houses therefore resolve through `resolveActs`: typed `/search` per act, candidates in order (exact name, then `aliases`, then billing names such as "<name> and ..."), then one place-insights call (`take=1`, 1,500 m around the first venue with coordinates) over every candidate id, memoized for the run. A candidate Qloo reports as not_found is skipped for the next one, and the detail lines name the swap. The client records `notFound` ids on any 2xx and `errorPaths` on any 4xx (ids and parameter names only); when a probe's own call (not a signal check) had a signal dropped, a pass, partial or fail becomes inconclusive with a line per call.

Guards: requests start at least 333 ms apart; at most 2 retries on 429/5xx (honouring `Retry-After`); the run aborts when the cap is reached or when `x-month-ratelimit-remaining` drops below `run.minMonthRemaining` (1,500). Probes not reached are marked `aborted`.

## Outputs (`probe_out/<timestamp>/`, git-ignored)

- `probe-NN-<slug>.json`: status, criterion, detail lines, **derived values only** (counts, ranks, overlaps, tau, rho, flags, chosen ids) and every request with its params (no key), HTTP status, timing, size, attempts, all response headers, and a copy-as-curl that references `$QLOO_API_KEY`.
- `run.json`: call count, cap, last rate-limit headers, monthly quota remaining, statuses.
- `SUMMARY.md`: the KG1-KG4 go/no-go lines, the verdict table and per-probe details.

Response bodies stay in memory and are never written. Each file is checked for the key before it is written.

## check-no-raw and the pre-commit hook

Enable the hook once per clone:

```sh
git config core.hooksPath .githooks
```

On Windows checkouts git may not record the executable bit; when the hook is first added, run `git update-index --chmod=+x .githooks/pre-commit` so it also runs on macOS and Linux clones.

`node scripts/check-no-raw.mjs` (or `npm run check:no-raw`, also for CI) reads the git index and exits 1 when:

- anything is tracked or staged under `fixtures/raw/`, `data/private/`, `probe_out/`, `.cache/` or `evals/out/private/`, or any `*.sqlite*` file (a `.gitkeep` is allowed);
- a JSON file outside `fixtures/synthetic/` looks like a raw API body: it has the keys `entity_id`, `query` and `affinity`; or `results` with a `heatmap` array; or a flat `results` array of objects with `entity_id`; or a compare body (`results.tags`, `a`, `b`). JSON lines and JSON stored inside strings (HAR files, logs) are checked too;
- a raw-looking JSON file inside `fixtures/synthetic/` lacks `"synthetic": true` at its top level;
- a tracked text file is over 64 MB (too large to scan, so it is not waved through).

`--staged` limits the check to files staged for the next commit. Exit 2 means a git or usage error.

## Tests

```sh
npx vitest run scripts
npx tsc -p tsconfig.json --noEmit 2>&1 | grep "scripts/"
```

The suites run offline: dry-run plan shape for every probe (WKT `POINT(lon lat)`, `filter.type` vs `/search` `types` spelling, take caps, no heatmap boundary), the stats against scipy reference values, the live code path against an in-process fake API that returns synthetic bodies (retries, cap, quota floor, outputs without key or bodies), the room tool against a fake Discovery with synthetic venues and events (exact venue match and ambiguity, the window over-fetch and paging, the rule's working, the roster's Spotify order, the config rewrite round trip and its refusals), and `check-no-raw` against temporary git repositories. The probe tests read the shipped config, so they pass both before and after key day fills the-truth's point and roster.

## Known limits

- The dry run follows the expected path: it assumes probe 15 passes, so probe 20 is planned as one name-query call. If 15 fails in a live run, 20 resolves the ten guests with typed `/search` (10 more calls). If 15 passes but the name query matches fewer than all ten guests, 20 reports inconclusive; `npm run probe -- --only=20` then scores the slate by id.
- Tag lookups pick an exact name match, preferring `urn:tag:category:place:` then `urn:tag:genre:place:` ids; otherwise the first tag containing every keyword, flagged as not exact. `urn:tag:genre:place:restaurant` is pinned from public probe notes and confirmed by probes 2 and 6.
- The probe's lift is a small local copy (geohash-6 tiles, percentile ranks, shrink toward 1 below a popularity floor); the product version lives in the engine package.
- KG1 bills, KG4 clubs and the guest list are probe-only test inputs, not product claims. The guest list should be checked against the show's public episode list before reuse.
- Metro points are OpenStreetMap city points, not Census place internal points.
- `filter.hours` can only be shown to work when the pool contains places closed that day; otherwise probe 10 reports inconclusive.
- When the roster lookup resolves too few acts, the house falls back to the stand-in and the detail lines give the count and HTTP status.
- Request params (search queries included) are written to the per-probe JSON, so bar names from the private bars file appear there; `probe_out/` is git-ignored and `check-no-raw` blocks it.
- `tm:room` cannot tell whether a room is independent: you pick the room. The rule reads each event's first Ticketmaster classification only (genre and subgenre), as `genreClass` does.
- With `--venue-id` the venue record comes from the room's own events (the client has no venue-by-id call), so a room with no listed events has no point to write.
- `--write-probe` always writes the point and the roster together, for one room.
