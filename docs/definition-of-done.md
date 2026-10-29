# Definition of done

## The definition

> For the three goldens, the Street Sheet renders with zero guard drops, every partner is open on the street-team day per the hours Qloo returns for it, every cited ID appears in this run's ledger, and the CI job re-runs the 20-case eval and the P1 analysis on fixtures and commits the score file.

Two related rules from the [spec](spec.md) (sections L and F):

> The 20-case product eval runs in CI with an ID validator.

> CI fails if any golden produces a drop in a citation field.

The goldens are the presets in [spec.md](spec.md): G1 at The Truth, Nashville (two bills, A and B, in the same room), G2 at Hampton Coliseum, and G3 at Super Funny, Tacoma. The definition is checked by the 20-case product eval in [`evals/product/`](../evals/product/README.md). Its score is written to `evals/product/out/score.json` and `score.md`.

## Clauses, made testable

Clauses D1 to D4 are scored on the golden cases (C01 to C04). The same checks also run on every other sheet the eval produces, and the score file reports those results separately. S1 to S4 come from the rest of the spec and are scored on every case.

| Clause | What passes | How it is checked |
|---|---|---|
| **D1.** For the three goldens, the Street Sheet renders. | The plan completes. On G2 the operator first answers the `needs_input` pause by picking the comedian from the candidates shown. All nine cards are present, and every card that is not `ok` gives a reason. The five "what this does not establish" lines are printed. The mode label is honest: a fixture sheet says so in its limits, and a live sheet has no synthetic ledger notes. The web app's sheet validator returns no errors, the export sheet model builds, and the PDF renders on one page. | `checkSubject` render checks; the `pdf` expectation on C01 to C04 |
| **D2.** Zero guard drops in a citation field. | No line was dropped because it cited an entity id, geohash, tag, number or ledger reference that this run did not return. On the goldens the total drop count is also 0. Policy drops, such as an alcohol word on an all-ages show, are counted separately. C09 and C10 cause them on purpose. | `classifyGuardReasons` over `sheet.guard.reasons`, compared with `sheet.guard.dropped` |
| **D3.** Every partner is open on the street-team day per the hours Qloo returns for it. | Each partner is checked against the place data Qloo returned for it, as stored on the sheet: `properties.is_closed` must not be true, and `properties.hours` (read by `@walkup/engine` `hoursOnDay`) must say open on the first street-team day, which is the day Q9 filters on. Pre/post spots get the same check for show night. If Qloo lists no hours for a place, it passes only when the sheet already shows it without hours ("call ahead"). `--strict-hours` fails it anyway. A pre/post spot that Qloo lists without hours while the sheet presents it as open fails a separate check, so a known-gap entry for it could never hide a spot that is closed or shut that night. The score's D3 row names any golden partner that passed as "call ahead". This checks the sheet against its own source, not an independent one: until Oct 20 2026 each place was looked up in Google Places instead, and that went with Places. | `groundSheet` |
| **D4.** Every cited ID appears in this run's ledger. | Every ledger reference on the sheet appears in this run's ledger: card provenance, chips and resolution rows. Every cited entity maps through the run's citation map to a Qloo entry of this run that returned results. The cited entities are partners, pre/post spots, media, declared partners and partner lines. Tiles named by partners, the budget split and the narration are on the lift map. On fixture runs, the ID validator also checks that every entity id and tag id on the sheet came back in a Qloo response body. | `checkSubject` ledger checks; the ID tap in `harness.ts` |
| **D5.** CI re-runs the 20-case eval on fixtures. | `evals/product/product.eval.test.ts` runs the eval under vitest. It fails on any failure not listed as a known gap, and on a listed gap that no longer reproduces. | CI: `npm test` (root `vitest.config.ts` includes `evals/product`) |
| **D6.** CI re-runs the P1 analysis on fixtures. | The Python CI job runs `evals/p1/test_analyze.py` on synthetic data. | Existing CI job; not part of this eval |
| **D7.** CI commits the score file. | A CI step writes `evals/product/out/score.json` and commits it. | CI job `product-score` in `.github/workflows/ci.yml` |
| **S1.** Call budget. | Fresh bill-level Qloo calls stay at 18 or fewer, not counting coded fallbacks and typed-partner lookups. Venue calls stay at 6 or fewer on a cold room and about 1 when the room's baseline is cached. Coded fallbacks stay at 10 or fewer, and each shows on its card with a reason. Typed-partner lookups stop at 20. Comparison arms that use Qloo are off unless asked for. | `readBudget`, the "every coded fallback call shows on its card" check |
| **S2.** Typed statuses and fallbacks. | Each case states the card statuses the spec calls for, plus the fallback it exercises. | per-case `cards` expectations and checks |
| **S3.** Policy. | No denied tag appears anywhere on the sheet or in the stored plan. Person entities carry no tags. No narration or card text uses "soft", "tracking" or a denied term. Partners are "suggested, not affiliated". No operator-typed contact is on the sheet. The export sanitizer finds nothing to remove. Bars face fans only when Ticketmaster marks the show 21+. | `checkSubject` policy checks; C09, C10, C15 |
| **S4.** Bill specificity. | Two bills in the same room share at most 5 of their top 8 partners, the Jaccard of the top-8 lists is at most 5/11, and the top lift tiles differ. | C18 |

## Cases

| Case | What it runs | Clauses |
|---|---|---|
| C01 | G1 bill A, cold room | D1 D2 D3 D4 S1 S2 S3 |
| C02 | G1 bill B (all-ages) | D1 D2 D3 D4 S1 S2 S3 |
| C03 | G2: pause, operator pick, proxy seeds, declared community channels, denied-tag receipt | D1 D2 D3 D4 S1 S2 S3 |
| C04 | G3: no comedy baseline, so no lift map and an empty "What's different"; 60 km widen; partners near the venue; the unmatched support act reported, not guessed; thin-signal banner | D1 D2 D3 D4 S1 S2 S3 |
| C05 | `needs_input` pause and resume, a pick that was not shown, a remembered pick | D4 S2 |
| C06 | Empty compare, which falls back to a tag diff | S1 S2 |
| C07 | Thin heatmap, which widens to 60 km | S1 S2 |
| C08 | Lift that follows general popularity (partners picked near the venue) | S1 S2 |
| C09 | All-ages alcohol rule with a model draft (fan-facing guard) | D2 S3 |
| C10 | A model draft that tries denied words; denied tags in stored data | D2 S3 |
| C11 | Places marked closed are dropped and counted | D3 S2 |
| C12 | Places with unknown hours are kept and marked "call ahead" | D3 S2 |
| C13 | Month quota guard: stored sheet, cache-only rerun, a degraded fresh bill | S1 S2 |
| C14 | HTTP 429 then success | S1 S2 |
| C15 | Declared partners: catalog places ranked, 20 unknown names unscored, the pick-list cap, contacts never stored | S1 S2 S3 |
| C16 | Partner diversity caps, including a category set heavy on bars | S2 S3 |
| C17 | Budget split sums to 1 over tiles at least 3 km apart | S2 S3 |
| C18 | Swap the bill: specificity, and the cached venue baseline | S4 S1 |
| C19 | The house heatmap fails, so the genre tag baseline stands in | S1 S2 S3 |
| C20 | Template narration: no model, a model error, a draft that breaks the per-run schema | D2 D4 S2 |

## Running it

```sh
npx tsx evals/product/run.ts                                   # fixture world; writes evals/product/out/
npx vitest run --config evals/product/vitest.config.ts         # the CI wrapper
npx tsx evals/product/run.ts --source recorded --plans <dir | plans.sqlite>   # stored live or replayed runs
```

On recorded plans, only the golden cases (C01 to C04, C17, C18) run, and only with the checks the spec states. The ID validator is skipped because there is no transport to tap. Grounding runs as on fixture runs: it reads the place data stored on the sheet and calls nothing. A skipped check leaves its clause "not verified", never "verified".

## Status today

- Fixture world: all four golden cases pass D1 to D4.
- **Known gaps: none.** The gap the eval reported (C11, C12: pre/post spots with unknown hours presented as open on show night) is fixed in `packages/orchestrator` (`src/steps/prepost.ts`); those spots now say "call ahead". `evals/product/known-gaps.ts` is empty.
- **Interpretation to confirm:** G1 bill A has two partners with no hours from Qloo. The sheet shows it as "call ahead", which passes D3 as read above. A strict reading (`--strict-hours`) fails it.
- **CI (D5, D7):** `npm test` runs the eval in the CI `node` job (the root `vitest.config.ts` and `tsconfig.json` include `evals/product`). The `product-score` job commits `evals/product/out/score.json` and `score.md` on pushes to the default branch when the result changed. Both run on GitHub Actions: the `node` job on every push, `product-score` on every push to the default branch. The committed score file reports 20 of 20 cases passed. CI commits it again whenever anything in it other than its timestamp changes (a check's detail text included), so the "Generated" date in `score.md` is the date of the last such change.
