# Product eval score

Source: fixture world (synthetic stand-in for Qloo and Ticketmaster; seed `houselights-world-v1`). No live API was called.
Generated: 2026-10-29T23:47:41.911Z

**20 passed, 0 failed (0 on known product gaps only, 0 unexpected), 0 skipped, of 20 cases.**

## Definition of done

Clauses D1-D4 are scored on the golden cases; S1-S4 on every case.

| Clause | Status | Cases | Checks (pass / fail / skip) |
|---|---|---|---|
| D1. For the three goldens, the Street Sheet renders. | verified (outside the goldens: 110 pass, 0 fail) | C01, C02, C03, C04 | 54 / 0 / 0 |
| D2. Zero guard drops in a citation field. | verified (outside the goldens: 66 pass, 0 fail) | C01, C02, C03, C04 | 12 / 0 / 0 |
| D3. Every partner is open on the street-team day per the hours Qloo returns for it. | verified (partners with no hours from Qloo, passed as "call first" (--strict-hours fails them): g1-a: 2; outside the goldens: 50 pass, 0 fail) | C01, C02, C03, C04 | 12 / 0 / 0 |
| D4. Every cited ID appears in this run's ledger (ID validator). | verified (outside the goldens: 117 pass, 0 fail) | C01, C02, C03, C04 | 20 / 0 / 0 |
| D5. The CI job re-runs the 20-case eval on fixtures. | ci (npm test runs evals/product/product.eval.test.ts in the CI node job; the root vitest include covers evals/product.) | - | 0 / 0 / 0 |
| D6. The CI job re-runs the P1 analysis on fixtures. | ci (The P1 analysis tests run in the Python CI job (python evals/p1/test_analyze.py); not part of this eval.) | - | 0 / 0 / 0 |
| D7. The CI job commits the score file. | ci (The CI job product-score re-runs this eval on pushes to the default branch and commits score.json and score.md when anything but the timestamp changed.) | - | 0 / 0 / 0 |
| S1. A fresh run stays within the Qloo call budget; every coded fallback call is shown on its card. | verified | C01, C02, C03, C04, C06, C07, C08, C13, C14, C15, C18, C19 | 60 / 0 / 0 |
| S2. Every node has a typed status and its coded fallback; a non-ok card says why. | verified | C01, C02, C03, C04, C05, C06, C07, C08, C11, C12, C13, C14, C15, C16, C17, C19, C20 | 252 / 0 / 0 |
| S3. Policy: aggregate affinities only, denied tags never in copy or stored data, alcohol rules from Ticketmaster only, partners suggested and not affiliated, no show-status words. | verified | C01, C02, C03, C04, C09, C10, C15, C16, C17, C19 | 260 / 0 / 0 |
| S4. Bill specificity: two bills in the same room give different lift tiles and partner lists (top-8 overlap at most 5 of 8). | verified | C18 | 7 / 0 / 0 |

## Cases

| Case | Status | Checks (pass / fail / skip) | Clauses |
|---|---|---|---|
| C01 Golden G1, bill A: The Truth, Nashville (hero sheet) | passed | 53 / 0 / 0 | D1, D2, D3, D4, S1, S2, S3 |
| C02 Golden G1, bill B: same room, all-ages bill of a distant genre | passed | 50 / 0 / 0 | D1, D2, D3, D4, S1, S2, S3 |
| C03 Golden G2: Hampton Coliseum comedy bill (honesty demo) | passed | 54 / 0 / 0 | D1, D2, D3, D4, S1, S2, S3 |
| C04 Golden G3: Super Funny, Tacoma (thin signal: each fallback is labelled) | passed | 51 / 0 / 0 | D1, D2, D3, D4, S1, S2, S3 |
| C05 needs_input: pause on an ambiguous name, resume with the operator's pick | passed | 53 / 0 / 0 | D4, S2 |
| C06 Empty compare falls back to a tag diff (degraded: tag diff) | passed | 42 / 0 / 0 | S1, S2 |
| C07 Thin heatmap widens the radius to 60 km (partial: thin) | passed | 36 / 0 / 0 | S1, S2 |
| C08 Lift follows general popularity: partners are picked near the venue | passed | 36 / 0 / 0 | S1, S2 |
| C09 All-ages alcohol rule: from Ticketmaster only, enforced on fan-facing copy | passed | 69 / 0 / 0 | D2, S3 |
| C10 Denied tags and words never reach copy or stored data | passed | 35 / 0 / 0 | D2, S3 |
| C11 Places marked closed are dropped and counted | passed | 32 / 0 / 0 | D3, S2 |
| C12 A partner with no listed hours is kept and marked call first | passed | 33 / 0 / 0 | D3, S2 |
| C13 Month quota guard: fresh calls stop, presets come from the store or cache | passed | 74 / 0 / 0 | S1, S2 |
| C14 HTTP 429 then success: retried, logged, same partners | passed | 41 / 0 / 0 | S1, S2 |
| C15 Declared partners: catalog places ranked, the rest kept in your order | passed | 38 / 0 / 0 | S1, S2, S3 |
| C16 Partner diversity caps hold, even on a bar-heavy category set | passed | 39 / 0 / 0 | S2, S3 |
| C17 Budget split: shares sum to 1 over spread top tiles, labelled a heuristic | passed | 82 / 0 / 0 | S2, S3 |
| C18 The other bill in the same room: a different crowd (top-8 overlap at most 5 of 8) | passed | 43 / 0 / 0 | S4, S1 |
| C19 House heatmap fails: the genre tag baseline stands in (degraded: tag baseline) | passed | 37 / 0 / 0 | S1, S2, S3 |
| C20 Narration falls back to the deterministic template (no model, model error, off-schema draft) | passed | 122 / 0 / 0 | D2, D4, S2 |

## Key numbers

| Case | Sheet | partners | prePost | grounded | hoursUnverified | qlooFresh | coreBillCalls | venueCalls | fallbackCalls | guardDropped | citationDrops |
|---|---|---|---|---|---|---|---|---|---|---|---|
| C01 | g1-a | 24 | 8 | 32 | 2 | 32 | 14 | 6 | 0 | 0 | 0 |
| C02 | g1-b | 24 | 8 | 32 | 0 | 32 | 14 | 6 | 0 | 0 | 0 |
| C03 | g2 | 22 | 8 | 30 | 0 | 39 | 17 | 6 | 2 | 0 | 0 |
| C04 | g3 | 6 | 2 | 8 | 0 | 16 | 10 | 3 | 2 | 0 | 0 |
| C05 | g2 resumed | 22 | 8 | 30 | 0 | 15 | 12 | 0 | 2 | 0 | 0 |
| C06 | g1-a, empty compare | 24 | 8 | 32 | 2 | 34 | 14 | 6 | 2 | 0 | 0 |
| C07 | g1-a, thin heatmap | 16 | 8 | 24 | 0 | 30 | 13 | 6 | 1 | 0 | 0 |
| C08 | g1-a, lift weak | 8 | 8 | 16 | 0 | 26 | 12 | 6 | 0 | 0 | 0 |
| C09 | g1-b all-ages, model | 24 | 8 | 32 | 0 | 32 | 14 | 6 | 0 | 1 | 0 |
| C09 | g1-a 21+, model | 24 | 8 | 32 | 2 | 32 | 14 | 6 | 0 | 0 | 0 |
| C10 | g2, model tries denied words | 22 | 8 | 30 | 0 | 39 | 17 | 6 | 2 | 2 | 0 |
| C11 | g1-a, closed places | 24 | 8 | 32 | 2 | 32 | 14 | 6 | 0 | 0 | 0 |
| C12 | g1-a, unknown hours | 24 | 8 | 32 | 13 | 32 | 14 | 6 | 0 | 0 | 0 |
| C13 | g1-a from cache under the guard | 24 | 8 | 32 | 2 | 0 | 0 | 0 | 0 | 0 | 0 |
| C13 | g1-b under the guard | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 | 0 | 0 |
| C14 | g1-a, 429 once | 24 | 8 | 32 | 2 | 32 | 14 | 6 | 0 | 0 | 0 |
| C15 | g1-b, 23 declared partners | 24 | 8 | 32 | 0 | 50 | 14 | 6 | 0 | 0 | 0 |
| C16 | g1-a, bar-heavy categories | 16 | 8 | 24 | 0 | 32 | 14 | 6 | 0 | 0 | 0 |
| C17 | g1-a, budget split | 24 | 8 | - | - | 32 | 14 | 6 | 0 | 0 | 0 |
| C17 | g2, budget split | 22 | 8 | - | - | 39 | 17 | 6 | 2 | 0 | 0 |
| C17 | g3, budget split | 6 | 2 | - | - | 16 | 10 | 3 | 2 | 0 | 0 |
| C18 | g1-b after g1-a (warm venue) | 24 | 8 | - | - | 23 | 14 | 1 | 0 | 0 | 0 |
| C19 | g1-a, house heat fails | 8 | 8 | 16 | 0 | 24 | 12 | 7 | 0 | 0 | 0 |
| C20 | g1-a, no model | 24 | 8 | 32 | 2 | 32 | 14 | 6 | 0 | 0 | 0 |
| C20 | g1-a, model error | 24 | 8 | - | - | 32 | 14 | 6 | 0 | 0 | 0 |
| C20 | g1-a, off-schema draft | 24 | 8 | - | - | 32 | 14 | 6 | 0 | 0 | 0 |

Core bill-level calls exclude coded fallbacks (shown on their cards) and the per-name lookups of typed partners; core and venue calls both exclude the trust checks (split-half heatmaps, partner house and popularity twins). Grounding checks every partner and pre/post spot against the place data Qloo returned for it (closed flag and hours, as stored on the sheet); it is not an independent source.
