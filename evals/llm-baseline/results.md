# Claude alone, same areas: results

Plan: [`protocol.md`](protocol.md), SHA-256 `a5b9e178ea0cc2e20ec51e8b3c69afa8cb3553cf076aba2677612abc8fb91321`
(checked against the file by the runner before each run). Run Oct 28 2026 (UTC) with `anthropic/claude-haiku-5.5`
through OpenRouter, no tools, no web search. Read the deviations at the end first: the model would not take
`temperature: 0`, and its default reasoning ran 3 areas out of tokens, so two counts are given: as planned, and with
those 3 areas asked again.

**Result.** Asked for the same 74 places in the same areas, Claude alone named 5 that Qloo finds in the area, not
marked closed, not closed on Thursday and not a national chain. Walkup's list has 70 of 74. On this check, Claude
alone did worse than Walkup. The most common miss: not found in Qloo (47 names of 74). 3 of Claude's 74 names are
also on Walkup's list. The same name search found 72 of Walkup's 74 picks in their areas, so a name it misses is not
proof that the place does not exist.

(These are the five sentences of protocol section 6, numbers filled in, with all 12 areas answered. As planned, with 3
areas unanswered, they read: 0 of 74, Walkup 70 of 74, worse, not found in Qloo 36 names of 50, 1 of 50 on Walkup's
list, 72 of 74.)

Walkup's own picks pass the existence, area, closed and hours checks by construction: Walkup chose them from Qloo
place searches inside exactly these areas and dropped places marked closed or closed on Thursday. Its 4 misses are
the national chains on its lists (2 on Rhiannon Giddens's, 2 on FLO's). A name Qloo does not find is "not found in
Qloo", not proof that it does not exist. This tests whether a list is usable against Qloo's place data, not which list
sells tickets.

## All 12 areas answered (3 of them asked again, deviation 3)

`out/summary.json`, `out/checks.json`, `out/answers.json`.

| | Rhiannon Giddens | FLO | Greensky Bluegrass | The Roots | All four |
|---|---|---|---|---|---|
| Names asked | 16 | 17 | 19 | 22 | 74 |
| Names returned | 16 | 17 | 19 | 22 | 74 |
| Found in Qloo (within 15 miles) | 11 | 8 | 2 | 6 | 27 |
| Found in Qloo in the area | 0 | 5 | 0 | 3 | 8 |
| of those: marked closed | 0 | 3 | 0 | 0 | 3 |
| of those: closed on Thursday | 0 | 0 | 0 | 0 | 0 |
| of those: hours not listed (not a miss) | 0 | 4 | 0 | 0 | 4 |
| of those: national chain | 0 | 0 | 0 | 0 | 0 |
| Repeats | 1 | 0 | 0 | 0 | 1 |
| **Usable** | **0** | **2** | **0** | **3** | **5** |
| Also on Walkup's list | 0 | 0 | 1 | 2 | 3 |
| First miss: not found in Qloo | 5 | 9 | 17 | 16 | 47 |
| First miss: found, but outside the area | 11 | 3 | 2 | 3 | 19 |
| First miss: marked closed | 0 | 3 | 0 | 0 | 3 |
| Walkup partners | 16 | 17 | 19 | 22 | 74 |
| Walkup national chains | 2 | 2 | 0 | 0 | 4 |
| **Walkup usable** | **14** | **15** | **19** | **22** | **70** |
| Calibration: Walkup's names found in their areas | 14 | 17 | 19 | 22 | 72 |

The repeat is "Passage to India", named in two areas and matched to the same Qloo place both times (it was already
outside the area, so it is counted there). The two calibration misses are both "Starbucks Coffee Company": the
search's 10 results held other Starbucks branches, and the nearest was outside the area.

## As planned (3 areas unanswered)

`out/preregistered/`. FLO area 1 and The Roots areas 1 and 3 count as 0 names returned.

| | Rhiannon Giddens | FLO | Greensky Bluegrass | The Roots | All four |
|---|---|---|---|---|---|
| Names asked | 16 | 17 | 19 | 22 | 74 |
| Names returned | 16 | 9 | 19 | 6 | 50 |
| Found in Qloo (within 15 miles) | 11 | 1 | 2 | 0 | 14 |
| Found in Qloo in the area | 0 | 0 | 0 | 0 | 0 |
| **Usable** | **0** | **0** | **0** | **0** | **0** |
| Also on Walkup's list | 0 | 0 | 1 | 0 | 1 |
| First miss: not found in Qloo | 5 | 8 | 17 | 6 | 36 |
| First miss: found, but outside the area | 11 | 1 | 2 | 0 | 14 |
| **Walkup usable** | **14** | **15** | **19** | **22** | **70** |

## What the names look like

From `out/checks.json` and `out/answers.json` (a description, not a count from the protocol):

- **Hedged names.** 32 of the 74 names carry the model's own note, such as "(unverified)", "(name unverified)",
  "(verify current name)" or "(verify name and existence)". Several are descriptions rather than names ("Local bakery
  on Oak Park Ave (name unverified)", "Neighborhood coffee shop (verify current name)"). In Laurel, Highwood and
  Midlothian no name was found in Qloo at all.
- **Real places, wrong spot.** In H Street NE, 6 of the 7 names are found in Qloo but outside the area. Walkup's area 1
  is centred about 2 km east of the H Street corridor; Granville Moore's, The Pug and Toki Underground are 2.10 km from
  that point, against a 2 km radius.
- **Doubtful matches the rule accepted**, all in Claude's favour: "Ben's Chili Bowl" matched Qloo's listing "Ben's
  Chili Bowl Foundation" (counted usable); "Stony Island Grill (verify name and existence)" matched "The Retro Grill
  Stony Island" (counted usable); "Local bakery on Oak Park Ave (name unverified)" matched Walkup's "Oak Park Bakery
  Inc" by the word rule (counted as on Walkup's list). Others matched places outside the area and changed no usable
  count ("Bethesda Bakery" to "Tatte Bakery & Cafe | Bethesda", "Oak Park Tavern" to "Park Tavern", "Marvin" to a law
  office).
- **Closed.** The three names marked closed in Qloo are U Street places: the Velvet Lounge, Bar Pilar and the nearest
  Compass Coffee.

## Exploratory (not in the protocol)

Checked after the results above; never the published count. `out/exploratory.json`, 31 more Qloo calls.

- **Areas 1.5 times as wide** (same searches, wider area check): 15 names in the area, 11 usable. Walkup's picks were
  chosen inside the original radius, so this is not a comparison with Walkup's 70.
- **Notes removed before the search** ("Laurel Tap House (unverified)" searched as "Laurel Tap House"): 30 found in
  Qloo, 9 in the area, 5 usable, the same as with the notes.

## What this shows and does not show

- Shows: whether a model with no tools, asked for the same number and kinds of places in the same areas, names places
  Qloo can find there, not marked closed, open on the street-team day and not national chains.
- Does not show: which list sells more tickets, or that a name Qloo does not find does not exist. Walkup's own picks
  pass the area, closed and hours checks by construction: they come from the same Qloo place data.
- One model (the one Walkup's narrator uses), one prompt, one run at the model's default temperature, four bills. Not a
  claim about other models, other prompts, or a model with web search or tools.

## Part 2: why lift

`out/why-lift.json`, from the recorded heatmaps of Oct 21 2026 (The Anthem: `.cache/record-2026-10-21j`; The Salt
Shed: `.cache/record-2026-10-21-chicago`). 0 Qloo calls. Check: lift recomputed from these maps matches the sheets'
lift on every tile to within 0.00005 (the sheets round to 4 decimals).

| | The Anthem | The Salt Shed |
|---|---|---|
| Top 5 shared, raw heat (same map square) | 0 of 5 | 0 of 5 |
| Top 5 shared, lift (same map square) | 0 of 5 | 0 of 5 |
| Top 5 shared, raw heat (same place: within 3 km or a shared ZIP) | 2 of 5 | 2 of 5 |
| Top 5 shared, lift (same place) | 1 of 5 | 0 of 5 |
| Top 5 shared, raw heat, both cut to 40 km (same map square / same place) | 0 / 3 | 0 / 2 |
| Spearman, bill raw heat against the usual crowd's | 0.45 (Rhiannon Giddens, 410 areas); 0.43 (FLO, 159 areas, 60 km maps) | 0.66 (Greensky Bluegrass, 347 areas); 0.31 (The Roots, 896 areas) |
| Spearman, the two bills' raw heat against each other | 0.44 (124 areas) | 0.50 (347 areas) |

In the protocol's words: At The Anthem, the two bills share 0 of their top 5 raw-heat areas and 0 of their top 5 lift
areas. Raw heat alone separates the two bills as much as lift does here. Raw heat against the room's usual crowd, over
the same areas: Spearman 0.45 (Rhiannon Giddens) and 0.43 (FLO). At The Salt Shed, the two bills share 0 of their top
5 raw-heat areas and 0 of their top 5 lift areas. Raw heat alone separates the two bills as much as lift does here. Raw
heat against the room's usual crowd, over the same areas: Spearman 0.66 (Greensky Bluegrass) and 0.31 (The Roots).

So the sheets' "share none of their top 5 areas" is not something lift adds on these two pairs: counted by map square,
raw heat shares none either. Counted by place, lift shares fewer (1 and 0) than raw heat (2 and 2). Each bill's raw
heat follows the usual crowd's only moderately (0.31 to 0.66).

## Calls spent

- **Model:** 42 requests in all. 24 were refused by OpenRouter's routing before any model ran (deviation 2; 0 tokens,
  $0). 18 were answered by the model: 12 complete answers (the ones scored) and 6 that stopped at the 2,000-token
  limit (deviation 3). $0.0177 in all.
- **Qloo:** 178 calls: 74 to check Walkup's own names (calibration), 73 for the model's 74 names (one search was
  already cached by the calibration), 31 exploratory. Part 2: 0.

## Deviations

Times are UTC. Rows 1 to 3 were written before the runs they describe.

| # | Date | Section | Deviation | Reason | Affects |
|---|---|---|---|---|---|
| 1 | 2026-10-28 | Header, 9 | The protocol and README.md (with the hash) were written and hashed at 11:45, before any call, but were **not committed or pushed before the run**. | Pushing to the public repository needs the owner's go-ahead, which this session did not have. The file's hash is fixed in README.md and checked by the runner, but until it is pushed, git history cannot show that the plan came before the run. | Proof of timing only. No setting, metric or sentence changes. |
| 2 | 2026-10-28 | 3, Settings | The first run (11:46) sent `temperature: 0` with `provider.require_parameters: true`. OpenRouter refused all 24 requests (2 per area) with HTTP 404, "No endpoints found that can handle the requested parameters": none of the 10 endpoints for `anthropic/claude-haiku-5.5` lists `temperature` among its supported parameters (OpenRouter's model endpoint list, checked at 11:47 before the re-run). No answer was generated (0 tokens, $0). The re-run sends the same requests **without `temperature`**, so the model's default sampling applies; everything else is unchanged (prompt, schema, `require_parameters`, at most 2 calls per area). The 24 refused requests count against the 40-call budget, so the re-run may make at most 16 calls. The refused attempts are kept in `.cache/llm-baseline/model/run1-refused/`. The 74 calibration searches the first run made (Walkup's own names, no model involved) stay in the Qloo cache and are reused. | The model does not accept a temperature setting through any OpenRouter endpoint. Dropping `require_parameters` instead could let a provider silently ignore the schema. Logged before the re-run. | Answers may vary between runs at the default temperature; this is one run. |
| 3 | 2026-10-28 | 3, Settings and Calls | In the re-run (11:47 to 11:50), 9 areas answered on the first call. In 3 areas (FLO area 1, U Street / Shaw; The Roots areas 1 and 3, Bronzeville and South Shore) both calls stopped at the 2,000-token limit before the JSON was complete: the model reasons by default on OpenRouter, and its reasoning used 1,519 to 2,000 of the 2,000 tokens (first logged as 1,724 to 2,000; corrected Oct 28 in review from the six stored responses). By the protocol those 3 areas count as 0 names returned; that result is kept unchanged in `out/preregistered/` and reported first below. Those 3 areas are then asked once more with `max_tokens` 8,000 and nothing else changed (same prompt, schema and settings; at most 2 calls per area), and the result with all 12 areas answered is reported next to it. Budget: the 24 requests refused in deviation 2 ran no model and cost nothing, so from here only requests a model answered count against the 40 model calls (15 so far; at most 6 more). The refused requests are reported separately. The truncated attempts are kept in `.cache/llm-baseline/model/run2-truncated/`. | 2,000 tokens was set without knowing the model reasons by default; 24 of 74 asked places got no answer because of that setting, not because of the model's knowledge. Logged at 11:51, before the 3 areas are asked again. | The preregistered count covers 50 of 74 names; the completed count covers all 12 areas, with 3 of them asked at a larger token limit. |
| 4 | 2026-10-28 | 6 | `/eval` shows the misses by reason for all four bills together, not per bill (the per-bill misses are in the first table above). It leads with the count for all 12 areas and states the planned count next to it, and labels the exploratory counts as such. | A per-bill table of six reasons does not fit a phone screen; deviation 3 left the planned count incomplete. | Presentation only. |
