# Claude alone, same areas: protocol

Version `llm-baseline-v1`, written Oct 28 2026 before any model or Qloo call for this test. Its SHA-256 is in
[`README.md`](README.md); the runner (`scripts/llm-baseline.ts --run`) stops if this file no longer matches it. This
file is never edited after that; every change is logged as a dated deviation in `results.md`.

## 1. Question

Asked for the same street-team partner places Walkup lists, in the same areas, how many places does a language model
with no tools name that are usable: Qloo finds them in that area, they are not marked closed, they are not closed on
the street-team day, and they are not national chains? How many are the places Walkup picked?

Part 2 (section 8) asks a separate question from recorded data only: what lift changes compared with raw heat.

The counts are published on `/eval` whatever they show.

## 2. Inputs

The four recorded live bills on the hosted site (`deploy/vercel/plans.json`, SHA-256
`0be92d379928ce3bc180f621db3761bad89e5e77b957233202dc06966621739a` on Oct 28 2026):

| key | plan id | bill |
|---|---|---|
| giddens | `1cfdc829-7814-4759-a624-9047a53994b7` | Rhiannon Giddens, The Anthem, Washington DC, Sun Feb 28 2027 |
| flo | `afc936c1-21cf-4846-a21e-9f5d39c2a58a` | FLO, The Anthem, Wed Feb 17 2027 |
| greensky | `455629e6-ec44-4494-a69b-6154e4433c65` | Greensky Bluegrass, The Salt Shed, Chicago, Wed Dec 30 2026 |
| roots | `fe1ff2bc-9547-4b5c-a69c-f456769afde0` | The Roots, The Salt Shed, Fri Jan 15 2027 |

`npx tsx scripts/llm-baseline.ts --prepare` reads each sheet, with no network, into `out/inputs.json`, which is
frozen before the run. Per bill: the acts, venue, city, state and show date; the street-team days (Thursday and
Saturday on all four); and the **check day**, the first street-team day, which is the day Walkup reads hours for
(Thursday on all four). Per numbered area that has partners: its number (1-5, as on the sheet), its label as the
sheet's partner table shows it, Walkup's partner search point and radius there (the last "partners, tile N" request
in the sheet's ledger, so a widened radius counts), and how many partners of each place type Walkup lists there.

| bill | area | label | radius | asked, by type |
|---|---|---|---|---|
| giddens | 1 | H Street NE, DC | 2 km | 7: 2 restaurant, 1 cafe, 2 bar, 1 clothing store, 1 cocktail bar |
| giddens | 2 | Vienna, VA | 2 km | 4: 2 restaurant, 1 lounge, 1 cafe |
| giddens | 3 | Bethesda, MD | 3.5 km | 5: 2 restaurant, 1 bakery, 1 pub, 1 cafe |
| flo | 1 | U Street / Shaw, DC | 2 km | 8: 2 lounge, 1 bar, 3 restaurant, 1 bookstore, 1 cafe |
| flo | 2 | Laurel, MD | 2 km | 8: 2 restaurant, 2 cafe, 2 bakery, 1 pub, 1 clothing store |
| flo | 3 | Bowie, MD | 2 km | 1: 1 restaurant |
| greensky | 1 | Schaumburg, IL | 2 km | 3: 1 sports bar, 2 restaurant |
| greensky | 2 | Highwood, IL | 2 km | 8: 2 restaurant, 2 bakery, 2 bar, 2 cafe |
| greensky | 3 | Oak Park, IL | 2 km | 8: 2 restaurant, 1 sports bar, 2 bar, 2 bakery, 1 cafe |
| roots | 1 | Bronzeville, IL | 2 km | 8: 1 wine bar, 2 restaurant, 2 bar, 2 cafe, 1 sports bar |
| roots | 2 | Midlothian, IL | 2 km | 6: 2 restaurant, 1 pool hall, 1 bar, 1 sports bar, 1 bakery |
| roots | 3 | South Shore, IL | 2 km | 8: 2 restaurant, 1 pub, 1 cocktail bar, 1 bar, 2 bakery, 1 cafe |

74 places asked in all (16, 17, 19 and 22 per bill: the same as Walkup's partner lists).

## 3. Model and prompt

- **Model.** The narrator's model through OpenRouter: `OPENROUTER_MODEL` when set, else the narrator's default
  `anthropic/claude-haiku-5.5`. On Oct 28 2026 `.env` does not set `OPENROUTER_MODEL`, so the model is
  `anthropic/claude-haiku-5.5`. The model OpenRouter reports serving is recorded.
- **Settings.** `temperature` 0, `max_tokens` 2000, no tools, no web search (no plugin, no `:online` model),
  `response_format` a strict JSON schema (below), `provider.require_parameters` true.
- **Calls.** One call per area, 12 in all. When a call fails (HTTP error, timeout) or its answer is not the JSON
  shape, the same request is sent once more: at most 2 calls per area, 24 in all, and the runner stops at 40. An area
  with no answer after 2 calls counts as 0 names returned.
- **System prompt**, exactly:

  > You help a concert promoter plan a street team: people who visit local businesses in the weeks before a show and ask to leave flyers or posters. You have no tools and no web access. Answer from what you know.

- **User prompt**, exactly, with `{...}` filled from the inputs (`{acts}` and `{days}` joined with commas and "and";
  `{date}` like "Sunday, February 28, 2027"; `{km}` the radius in km with one decimal at most; `{lat}`, `{lon}` the
  search point as the ledger has it; one `- {type}: {count}` line per type, in the sheet's order):

  ```
  Show: {acts} at {venue}, {city}, {state}, on {date}.
  The street team goes out on {days} before the show.

  Area: {label}. Only places within {km} km of latitude {lat}, longitude {lon}.

  Name exactly {asked} local businesses in this area where the team could ask to leave flyers: places this show's fans are likely to go, open on {days}. No national chains. Give exactly this many of each type:
  - {type}: {count}

  Answer with JSON only, in this shape: {"places": [{"name": "...", "type": "...", "address": "... or null", "reason": "one short line"}]}.
  "type" is one of: {types}. Real places only.
  ```

  The 12 filled prompts are in `out/inputs.json`.
- **Output shape.** `{"places": [{"name": string, "type": one of the area's types, "address": string or null,
  "reason": string}]}`, all fields required, no others.
- **Reading the answer.** Names are trimmed; an empty name is skipped; a name repeated in the same answer (same
  normalised name, section 4) counts once; only the first `{asked}` names are kept. The rest of the answer is recorded
  but not scored.

## 4. Checking each name with Qloo

- **Search.** One `GET /search` per kept name: `query` the name as returned, `types=urn:entity:place`,
  `filter.location` the area's search point as `lat,lon`, `filter.radius=15` (miles, Qloo's unit for /search),
  `take=10`. Through `@walkup/qloo` with its response cache at `.cache/llm-baseline/qloo-cache.sqlite`: raw bodies stay
  there and are never committed.
- **Match.** Names are normalised as `nameTokens` in `packages/narrator/src/overlap.ts` does (lower case, accents and
  apostrophes dropped, "&" read as "and", split on anything else, "the" dropped). A result matches a name when the
  normalised names are equal, or when their token-set similarity (`tokenSetRatio`, the same file) is at least 0.85
  and the words they share are not all from this list: a, an, and, at, bar, barber, barbershop, bakery, bistro, books,
  brewing, cafe, club, co, coffee, company, deli, diner, grill, house, inn, kitchen, lounge, market, of, on, pizza,
  pub, records, restaurant, room, salon, shop, store, tap, tavern, wine. Of the matching results, the one nearest the
  area's search point is the match.
- **Checks, in order** (the first one a name fails is its miss reason):
  1. **Not found in Qloo:** no result matches.
  2. **Found in Qloo, but outside the area:** the match is farther from the area's search point than Walkup's
     search radius there, or has no location.
  3. **Marked closed:** Qloo marks it closed (`isClosedEntity` in `packages/engine/src/category.ts`).
  4. **Closed on the check day:** Walkup's hours reader (`hoursOnDay`, `packages/engine/src/hours.ts`) reads it as
     closed on Thursday. Open with clock hours counts as open. Anything else (no hours, "open" with no times) is
     "hours not listed": not a miss, as Walkup lists such places with "call first". Saturday's hours are recorded but
     not scored.
  5. **National chain:** Walkup's existing rule, `chainSignals` in `packages/engine/src/chains.ts` with
     `config/chains.json` (the hand-kept list, Qloo's description of the place, a store-locator website, the same name
     or website at 3 or more places). The places it looks at: every place this bill's searches returned that lies
     inside the area it was searched for, once each. Qloo's description of a /search place is
     `properties.description`.
  6. **Repeat:** the same Qloo place was already counted for this bill.
- **Usable:** passes all six.
- **On Walkup's list:** the matched Qloo place is one of Walkup's partners on that bill, or the name matches (same
  rule) a Walkup partner in the same area.
- **Calibration.** The same search and match rule are run on each of Walkup's 74 partner names with their own area's
  point and radius. The counts found within 15 miles and found in the area show how often the name search misses a
  place that is in Qloo and in that area.
- **Budget.** At most 400 Qloo calls (expected at most 148: 74 names and 74 calibration names; a cache hit is not a
  call) and 40 model calls. If a budget stops the run, the partial counts are reported as partial.

## 5. Metrics

Per bill and in total, for the model: names asked; names returned; found in Qloo (within 15 miles); found in Qloo in
the area; of those in the area: marked closed, closed on Thursday, hours not listed (reported, not a miss), national
chain; repeats; usable; on Walkup's list; and the count of names per first miss reason.

For Walkup's own list: partners; national chains (as the sheet marks them, the same rule as it ran); usable =
partners minus chains; calibration found and found in the area. Walkup's partners pass the area, closed and hours
checks by construction (section 7), so they are not re-scored on those.

## 6. What is published

`/eval` gets a section "Claude alone, same areas" with a table per bill (asked, usable, Walkup usable, on Walkup's
list, and the misses by reason) and these sentences, numbers filled in and nothing else changed:

1. "Asked for the same {asked} places in the same areas, Claude alone named {usable} that Qloo finds in the area, not
   marked closed, not closed on Thursday and not a national chain. Walkup's list has {walkup usable} of {walkup
   partners}."
2. One of, by the totals: "On this check, Claude alone did better than Walkup." (usable above Walkup's), "On this
   check, Claude alone did as well as Walkup." (equal), "On this check, Claude alone did worse than Walkup." (below).
3. "The most common miss: {reason} ({k} names of {returned})." with the reason in these words: not found in Qloo /
   found in Qloo, but outside the area / marked closed in Qloo / closed on the street-team day / a national chain / a
   repeat of an earlier name (a tie goes to the earlier one); or "Every name passed."
4. "{k} of Claude's {returned} names are also on Walkup's list."
5. "The same name search found {k} of Walkup's {partners} picks in their areas, so a name it misses is not proof that
   the place does not exist."

And the page's "Shows / Does not show" line:

- Shows: whether a model with no tools, asked for the same number and kinds of places in the same areas, names
  places Qloo can find there, not marked closed, open on the street-team day and not national chains.
- Does not show: which list sells more tickets, or that a name Qloo does not find does not exist. Walkup's own picks
  pass the area, closed and hours checks by construction: they come from the same Qloo place data.

A miss is always worded "not found in Qloo", never "does not exist", "made up" or "hallucinated".

## 7. What this shows and does not show

- It tests whether a list is usable against Qloo's own place data: there, in the area, not closed, open on the
  street-team day, not a chain. It does not test which list sells tickets, or which places this show's fans prefer.
- Walkup's own picks pass the existence, area, closed and hours checks **by construction**: Walkup chose them from
  Qloo place searches inside exactly these areas and dropped places marked closed or closed on Thursday. A Walkup
  advantage on those checks is built in, and is said so wherever the result is published. The chain check is the
  one Walkup's list can fail, and its count is published next to the model's.
- Qloo is the reference. A real place that Qloo lacks, or locates elsewhere, counts against the model; the
  calibration line shows how often the name search misses places known to be there.
- One model, one prompt, temperature 0, one run, four bills. It says nothing about other models, other prompts, or a
  model with web search or tools.

## 8. Part 2: why lift (recorded data only)

From the recorded runs, with no new Qloo call if the caches answer (at most 20 otherwise), by
`npx tsx scripts/why-lift.ts`; only numbers are written (`out/why-lift.json`).

- **Maps.** For each bill, the bill heatmap and the room's usual-crowd heatmap its sheet used: the last "Q4 bill
  heat" and "Q5 house heat" requests in the sheet's ledger (split-half maps excluded; FLO's maps are the widened 60 km
  ones), read by their canonical request key from a copy of that run's private cache (The Anthem:
  `.cache/record-2026-10-21j`; The Salt Shed: `.cache/record-2026-10-21-chicago`). Check: lift recomputed from these
  maps with the engine's defaults must equal the lift on the sheet's tiles.
- **Tiles.** Cells averaged per geohash-6 tile (`aggregateToGeohash6`), keeping the tiles present in both maps (the
  tiles lift is computed on). **Raw heat** of a tile is the bill's mean affinity there.
- **Top 5 raw-heat areas.** Tiles by raw heat, highest first (ties: the bill map's popularity, then geohash), leaving
  out a tile with fewer than 500 adults when the gazetteer knows the number, and skipping a tile within 3 km of, or
  sharing a ZIP with, one already picked (the sheet's rule for numbered areas, without the lift rules).
- **Top 5 lift areas.** The sheet's numbered areas 1-5 (lift 1.3 and up, highest first, one per place).
- **Shared.** For each room, how many of the second bill's top 5 are among the first bill's: the same tile (the rule
  behind the sheets' "share none of their top 5 areas"), and, as a second count, the same place by the 3 km / ZIP rule.
  Also the raw-heat count when both bills are cut to the 40 km circle (FLO's maps reach 60 km).
- **Correlation.** Per bill, Spearman's rank correlation between the bill's raw heat and the usual crowd's raw heat
  over the joined tiles (the engine's `spearman`, average ranks), with the number of tiles. Also, per room, between
  the two bills' raw heat over the tiles both have.
- **Published words:** "At {room}, the two bills share {r} of their top 5 raw-heat areas and {l} of their top 5 lift
  areas." Then "Lift separates the two bills more than raw heat does here." when l < r, else "Raw heat alone separates
  the two bills as much as lift does here." Then "Raw heat against the room's usual crowd, over the same areas:
  Spearman {a} ({bill}) and {b} ({bill})."

## 9. Deviations

Any change after this file is hashed is logged in `results.md` with its date, what changed, why and what it affects,
as `docs/preregistration/p1-deviations.md` does for P1.

## 10. Files

| Path | What |
|---|---|
| `evals/llm-baseline/protocol.md` | This plan (hashed in `README.md`) |
| `scripts/llm-baseline-lib.ts`, `scripts/llm-baseline.ts` | Prompt, checks, counts, sentences; the runner |
| `scripts/why-lift-lib.ts`, `scripts/why-lift.ts` | Part 2 |
| `evals/llm-baseline/out/inputs.json` | Frozen inputs and the 12 filled prompts |
| `evals/llm-baseline/out/answers.json` | The model's names, types, addresses and reasons, per area |
| `evals/llm-baseline/out/checks.json` | Per-name check flags, and the calibration flags for Walkup's names |
| `evals/llm-baseline/out/summary.json` | Counts per bill and in total, the sentences, calls spent |
| `evals/llm-baseline/out/why-lift.json` | Part 2 numbers |
| `evals/llm-baseline/results.md` | The numbers as section 6 words them, and the deviations |
| `.cache/llm-baseline/` | Raw model answers and raw Qloo bodies (git-ignored, never committed) |
