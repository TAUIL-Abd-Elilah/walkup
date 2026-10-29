# Walkup: product spec and acceptance criteria

**Walkup, the Fill-the-Room Agent.** *Fill the room, not the feed.*

Give Walkup one booked show that still has seats to sell. It finds where this bill's crowd differs from the crowd the venue already reaches, ranks the real local spots that crowd already loves, and sends your street team the plan.

Each criterion below is meant to be checkable: by a test, by CI, or by a person following the steps. Request shapes are in [mapping-table.md](mapping-table.md); policy details are in the [System Card](system-card.md).

## Definition of done

> For the three goldens, the Street Sheet renders with zero guard drops, every partner is open on the street-team day per the hours Qloo returns for it, every cited ID appears in this run's ledger, and the CI job re-runs the 20-case eval and the P1 analysis on fixtures and commits the score file.

## Goldens

All three are prewarmed, cached for 30 days and recorded as fixtures. Counts are operator what-ifs, marked as what-ifs on the page and with a "What-if counts" watermark on the PDF; no sales data about any real show is known or shown.

- **G1. The Truth, Nashville: "Same room. Two crowds."** Two bills at the same room in the same window, chosen by a fixed rule (the first Americana, country or folk headliner on the room's Ticketmaster calendar, and the bill whose genre is most distant from it). Both headliners resolve exactly. The house baseline is the room's next 60 Ticketmaster events. If the room is not yet a Qloo place, the run uses the Ticketmaster `POINT(lon lat)`. Expected: named lift tiles, 15 to 25 partners across the top 3 tiles, at most 8 per tile (24 on each sample sheet; 16 and 17 on the recorded Anthem pair), 6-8 pre/post spots, podcasts, one sponsor, three copy hooks and the swap to the second bill. The first screen never shows `needs_input`. The live hero applies this rule at one independent room over Dec 20 2026 to Feb 28 2027 (`HERO_RULE`, `HERO_WINDOW` in `packages/orchestrator/src/presets.ts`); a bill whose headliner Qloo cannot match exactly is skipped, since both headliners must resolve exactly, and so is a ticket package for shows already on the calendar (a two-night pass). Run on Oct 20 2026 at The Anthem, Washington DC (`npm run tm:room -- --venue-id=KovZ917A3Y7 --as-of=2026-10-20`), it picks Rhiannon Giddens (Sun Feb 28 2027) and FLO (Wed Feb 17 2027). They are the `live` blocks of g1-a and g1-b. The same rule over the same window at a second independent room, The Salt Shed, Chicago (the indoor Shed; owned and run by 16" On Center and a member of the Chicago Independent Venue League; `npm run tm:room -- --venue-id=KovZ917AI5F --as-of=2026-10-21 --package=vvG18Z_CM8Huwe`, run Oct 21 2026), skips a two-night pass for Greensky Bluegrass's Dec 30 and 31 shows (a ticket package, not a show of its own) and picks Greensky Bluegrass (Wed Dec 30 2026) and The Roots (Fri Jan 15 2027): the live-only presets g4-a and g4-b, which have no sample sheet. g2 and g3 have no live show. The fixture presets keep their invented bills at The Truth on the fixture world, picked by the same rule over Nov 20 to Dec 20 2026.
- **G2. Hampton Coliseum, an invented multi-act comedy bill (Sat Dec 19 2026).** Every act and title is made up. Demonstrates exact resolution, `needs_input` on a one-word act name, a thin act handled as `partial` with a film/TV proxy seed shown in the receipts, operator-declared community partners ranked as places with unresolved ones "declared, not scored", and denied tags counted on the receipt.
- **G3. Super Funny Comedy Club, Tacoma, an invented two-night bill (Fri-Sat Dec 4-5 2026).** Thin regional signal: fewer than 5 of the room's usual acts match Qloo, and comedy never gets a genre-tag baseline, so there is no lift map (`degraded`, baseline `none`) and "What's different" is `empty`; the heatmap radius widens to 60 km when fewer than 200 cells come back; the support act Qloo cannot match is reported, not guessed; partners are picked near the venue (6 on the sample, short of the 15 the list aims for); each card that is not `ok` gives its reason; and the limits carry the banner "Thin signal: treat as a starting list."

## Acceptance criteria

### A. First visit (desktop and phone, no login, no email)

1. The landing page renders from cache (the Salt Shed pair first, then G1) and is never empty.
2. The mode is said in words, never in a pill: live ("Live data" with the Qloo calls left this month); fixture, with a strip on every page saying the sheets use made-up places and numbers; or recorded, with a strip saying the sheets were recorded from live Qloo and Ticketmaster runs and that live runs are paused; sheets recorded from live runs show the date of the run and get no new Qloo or Ticketmaster data (an offline re-check may reword them, with no API call). A recorded sheet says "Recorded <date>" where a live one says "Planned <date>".
3. A list of the preset sheets (the room pairs first, then G2 and G3) and, in live mode, a search box for any Ticketmaster show. In sample and recorded mode nothing new runs, so the sheet list takes the search box's place and says why.
4. Opening a sheet shows the cards in order, each with a status badge (`ok`, `empty`, `needs_input`, `partial`, `degraded`, `error`) and a reason when not `ok`: resolution, lift map with top 5 named tiles, partners, pre/post, media and sponsor, copy hooks.
5. Removed on Oct 20 2026: the "Without Qloo" toggle and its Google Places list. Qloo is the core; the list added a key, a quota and a 30-day storage limit for little decision value ([what we tried](what-we-tried.md)).
6. "Swap the bill" replaces bill A with bill B; the map and partners change.
7. Any chip opens the receipt drawer: request ID, params with the key redacted, copy-as-curl, explainability contributions, cache flag.
8. "Send to street team" opens a confirm dialog listing recipients and attachments; the default recipient is a test inbox so no typing is needed. After Confirm, the dialog shows the message ID and the ledger gains an `A1` entry. An optional "also send a copy to me" address is used once and never stored.
9. The PDF Street Sheet, `street-team.ics` and the ZIP list CSV download.

### B. Free-form runs

1. A typed show is picked from Ticketmaster Discovery results.
2. The first card appears in under 10 s (resolution, then the map when the venue baseline is cached).
3. A full fresh sheet takes 15-25 s and streams card by card.
4. Fresh runs are capped at 3 per IP per day and 15 per day in total; the remaining count is shown; cached presets are unlimited.

### C. Resolution

1. Acts resolve via `/entities?external.spotify.ids=` from Ticketmaster attractions, else typed `/search` with an exact normalized-name match.
2. Comedy bills admit a person only with a comedian tag (pinned in `config/tags.json`).
3. Ambiguity pauses the run with `needs_input` and shows candidates (name, type, popularity, short description, release year for titles, one external link). One tap picks. "None of these: use a proxy" offers film/TV proxies checked against release year.
4. Ambiguity is never resolved silently. Choices are cached per (query, type) for 30 days.
5. Missing acts make the run `partial`; it continues on the resolved subset.

### D. Plan graph

1. A fixed DAG (Q4-Q14) with a typed status per node and the coded fallbacks listed in the README call table; each fallback's reason shows on its card.
2. All tag IDs come from `config/tags.json`; zero free-text tags at runtime. A category whose tag is not pinned is skipped, and the card says so.
3. Global limit 3 requests/second, at most 2 retries on 429/5xx; month guard at 1,500 remaining.
4. `filter.type` uses `video_game`; `/search` uses `videogame`; WKT is `POINT(lon lat)`; `output.heatmap.boundary` is never sent.

### E. Scoring (deterministic, unit-tested)

1. Lift per geohash-6: `(pct_rank(bill.affinity) + 0.5) / (pct_rank(house.affinity) + 0.5)` with ranks from 0 to 1 (the sheet writes it as (percentile + 50) / (percentile + 50)), so lift stays between 1/3 and 3; shrunk toward 1 for low-popularity cells. Affinities are never compared across calls except as percentile ranks within one response.
2. Top tiles have lift of at least 1.3, this crowd's percentile of at least 70 (the bill floor) and adult population above a floor.
3. If Spearman(bill lift, raw heat) is above 0.9, the map shows `lift weak` and partners fall back to near-venue ranking.
4. Partner score: `(1 - (qloo_rank - 1) / n) × (lift_tile / max_lift)`; at most 2 per category per tile, at least 1 non-bar per tile, at most 8 per tile; ties broken by distance; `is_closed=true` dropped and counted; hours include the street-team day (filter plus parsed hours).
5. Already-reached ZIPs (aggregate counts) down-weight tiles.
6. The pre/post load balancer is a greedy water-fill with a deterministic tie-break, capped by operator-editable "assumed" capacities.
7. The budget split is proportional to tile lift × ACS adults 21+, with a per-tile minimum, labelled "heuristic, not a forecast".

### F. Narration and guard

1. The LLM writes only: the sheet summary, why-this-tile sentences, partner one-liners and 3 copy hooks.
2. Each field may cite only entity IDs and numbers from this run, enforced by schema enums built per run. Copy uses only allowlisted tag names.
3. A deterministic validator rejects any entity ID or number not in this run's results and any denied tag; dropped items are counted and shown.
4. CI fails if any golden produces a drop in a citation field.
5. Above the daily spend cap or on refusal/outage, a deterministic template narrates, labelled as such.

### G. Ledger

1. Every Qloo, Ticketmaster, Census, LLM and action call gets a numbered entry (`Q1…`, `T1…`, `C1…`, `L1…`, `A1…`). Sheets made before Oct 20 2026 also carry `P1…` entries for Google Places.
2. Each entry has endpoint, params (key replaced by `$QLOO_API_KEY`), HTTP status, envelope status, latency, bytes, cache hit, result count and copy-as-curl.
3. Every chip links to its entry; the ledger exports as JSON with the sheet.
4. No response body is ever stored in the repo; CI fails if one is found.

### H. Policy

1. Denied tag namespaces and keywords (`DENIED_TAG_PREFIXES`, `DENIED_TAG_KEYWORDS` in `packages/contracts`) never reach copy, chips or persisted data; tested in CI with a regression fixture.
2. Person-entity tags are stripped before anything is persisted.
3. Community channels appear only when the operator declares them.
4. Alcohol and age rules come from Ticketmaster `ageRestrictions`; on all-ages shows the fan-facing pre/post list has restaurants and cafes only and the sponsor excludes alcohol, tobacco and gambling.
5. No email to anyone the operator did not type. Partners are "suggested, not affiliated".
6. Every count on a real show is marked as a what-if ("What-if counts" on the PDF); copy never says "soft" or "tracking"; there is no public ranking of shows.
7. No jokes, artist voice or likeness in generated copy. Candidate and campaign events are refused.
8. Every sheet prints the four "What this does not establish" lines (`LIMITS_EVERY_SHEET`).

### I. Exports

`partners.csv`, `zips.csv` (ZIP, lift score, suggested weight), `pins.csv` (area, area_name, lat, lon, radius_km of at least 1.6, i.e. one mile), `street-team.ics`, `offer-codes.csv` (labelled "create in your ticketing platform"), `sheet.json` with the ledger, and the PDF (US Letter or A4, readable on a phone). The share URL `/s/<plan-id>` is readable without login.

### J. Fixture and recorded modes

1. **Fixture: sample data.** Without a Qloo or a Ticketmaster key, or with `WALKUP_MODE=fixture`, the presets run on a synthetic stand-in for Qloo and Ticketmaster and no API is called. Every page, sheet, file and email says it is sample data (made-up places and numbers), and free-form runs answer 503 with an explanation. `npm ci && npm run dev` works with an empty `.env`.
2. **Recorded: live runs paused.** With `WALKUP_MODE=recorded`, once the time in `WALKUP_QLOO_UNTIL` has passed, or when Qloo has rejected the configured key and the plan store holds a live sheet, the app serves sheets recorded from earlier live runs and calls nothing. Each preset shows its latest live run made with the preset's own inputs, unless Qloo refused the key on it or at least half its cards failed; a preset without one shows its sample sheet, labelled sample. Stored live sheets open as recorded, with their date; their envelope says `mode: "recorded"`. Sample sheets stay sample, and when no live run was recorded the landing page calls its sheets sample sheets. New plans, searches, picks and every MCP tool that would start a run answer with `mode: "recorded"` and one plain reason (503 on the REST routes); a change note on a recorded sheet opens the revision recorded ahead for the same change, or answers that the change needs new Qloo requests (`docs/deploy-vercel.md`); reading, downloads and the confirm-gated send still work. `/healthz` reports the mode, a rejected key, `WALKUP_QLOO_UNTIL` and the recorded run behind each preset.
3. A rejected key with no live sheet stored falls back to fixture mode. Recorded data is never shown as sample data, and sample data never as recorded.

### K. Agents

1. `skills/walkup/` is a valid Agent Skill: `name` equals the directory name, `description` is at most 1,024 characters, `metadata.openclaw` declares its env and binaries, the body has "What this sends", "NEVER do", common errors and a coverage map. No remote code, no key handling.
2. An MCP endpoint (`POST /mcp`, Streamable HTTP) exposes `plan_show`, `rank_partners`, `bill_vs_house`, `get_sheet` and `revise_plan`, each returning the same envelope as the web app (`status`, `summary`, `results`, `provenance`, `limits`), with the same per-IP caps.

### L. Evals

1. The P1 analysis plan is hashed and committed under `docs/preregistration/` before any run (P1 was run Oct 21 2026; result null, `evals/p1/results.md`).
2. Coverage is reported before results; nulls are published.
3. The 20-case product eval runs in CI with an ID validator.

### M. Cost caps

Qloo month guard at 1,500 remaining (the hackathon key's monthly limit read 50,000); 3 fresh runs per IP and 15 per day; Claude (OpenRouter or Anthropic) $5/day; Resend free tier with the test inbox by default.
