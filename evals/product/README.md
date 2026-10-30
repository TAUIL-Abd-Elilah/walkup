# Product eval (20 cases)

This eval checks the [definition of done](../../docs/definition-of-done.md) and the spec's statuses, fallbacks, call budget and policy rules. Each case runs `@walkup/orchestrator` on `@walkup/qloo-world`, the synthetic stand-in for Qloo and Ticketmaster, so no key is needed and no live API is called. Six of the cases (the four goldens, C17 and C18) also run on recorded plans, which are stored live runs or replays of them; there they keep only the checks the spec states.

Output: `out/score.json` (`{format, formatVersion, source, worldSeed, recordedPlans, generatedAt, passed, failed, knownGaps, unexpectedFailures, skipped, total, strictHours, clauses[], cases[]}`) and `out/score.md`. Everything except `generatedAt` is deterministic. On recorded plans, `recordedPlans` lists each plan read with the mode its sheet carries, so a fixture sheet never reads as a live run.

## Files

| File | What it holds |
|---|---|
| `cases.ts` | The 20 cases (`CASES`). Each one runs plans and adds its own checks. It then hands one or more sheets ("subjects") to the universal checks, with the card statuses, guard drops and budget bounds it expects. |
| `checks.ts` | The universal checks, run on every subject (a case can turn grounding or the call budget off for a repeat sheet: C13, C17, C18 and C20 do). **Renders:** all cards present, limits printed, honest mode label, web validator, export model, one-page PDF on the goldens. **Card statuses.** **Guard drops by field.** **Ledger refs and entity citations.** **The ID validator.** **Grounding** against the place data Qloo returned (closed flag and hours, as stored on the sheet). **Call budget**, including fallbacks shown on their cards. **Policy invariants.** Also: the clause list (`CLAUSES`), `classifyGuardReasons`, `readBudget`, `groundSheet`. |
| `harness.ts` | `newRig()`: fixture deps with a fixed clock and counter plan ids. Every Qloo response body is tapped into a set of strings, which the ID validator checks against. `runWithPick()` resumes a `needs_input` pause the way an operator would. Also two world variants (`liftWeakVariant`, `failingHouseHeatVariant`), and mock narrator models. |
| `known-gaps.ts` | Product gaps this eval found and reported that are still open. They stay failures in the score but are marked as known, so CI can tell them from regressions. |
| `run.ts` | `runProductEval()`, `writeScore()`, `scoreMarkdown()`, `loadRecordedPlans()` and the CLI. |
| `product.eval.test.ts` | The vitest wrapper. It runs the cases, then mutation tests showing that each check fails on a sheet broken on purpose, then unit tests and the recorded path (JSON files, fixture wrappers, SQLite). |
| `docs-numbers.test.ts` | Holds the call counts, brand count, pinned tag counts, sample-world MCP response sizes and gazetteer metros the docs give to `out/score.json`, the fixture sheets and the data they describe. |

## Run

```sh
npx tsx evals/product/run.ts                        # all 20 on the fixture world; writes evals/product/out/
npx tsx evals/product/run.ts --only C01,C18 --out /tmp/pe
npx tsx evals/product/run.ts --strict-hours         # a partner with no hours from Qloo fails even when the sheet says "call first"
npx tsx evals/product/run.ts --source recorded --plans <dir of StoredPlan or fixture-wrapper JSON | plans.sqlite>
```

Exit code 0 means there are no failures, or only known gaps. Exit code 1 means a failure that is not a known gap. Exit code 2 means bad usage. A full run takes about 20 seconds.

## Test

```sh
npx vitest run --config evals/product/vitest.config.ts
npx tsc -p evals/product/tsconfig.json --noEmit
```

The wrapper writes the score to `evals/product/out/` when `CI` or `PRODUCT_EVAL_WRITE` is set; `PRODUCT_EVAL_OUT` sets another directory. Otherwise it writes to a temporary directory, so local test runs leave the committed file alone.

## CI

- The root `vitest.config.ts` includes `evals/product/*.test.ts` and the root `tsconfig.json` includes `evals/product/*.ts`, so `npm test` and `npm run typecheck` (both in the CI `node` job) run and typecheck the eval (D5).
- The CI job `product-score` (pushes to the default branch only, `contents: write`) runs `npx tsx evals/product/run.ts --quiet` and commits `evals/product/out/score.json` and `score.md` when anything in them other than the timestamp lines changed (D7). The commit message carries `[skip ci]`. A protected default branch must allow the GitHub Actions bot to push, or the step fails and the score stays as committed.
- The P1 analysis tests run in the Python job (D6).

## The cases

C01 to C04 are the goldens: G1 bill A, G1 bill B, G2 and G3. C05 is the `needs_input` pause and resume. C06 is an empty compare, which falls back to a tag diff. C07 is a thin heatmap, which widens to 60 km. C08 is lift that tracks foot traffic, so partners are ranked near the venue. C09 is the all-ages alcohol rule. C10 checks that denied tags never reach copy or stored data. C11 drops closed places. C12 keeps partners with unknown hours and marks them "call first". C13 is the quota guard, which serves from the store or cache. C14 is a 429 retry. C15 covers declared partners not in the catalog and the pick-list cap. C16 checks the diversity caps. C17 checks that the budget split sums to 1. C18 plans the other bill in the same room (specificity). C19 is the degraded house baseline. C20 is the template narration. The clause map is in [docs/definition-of-done.md](../../docs/definition-of-done.md).

## Known limits

- **Grounding checks the sheet against its own source.** Each partner and pre/post spot is checked against the closed flag and hours Qloo returned for it, as stored on the sheet. That catches a pipeline that keeps a closed place or presents unknown hours as open; it does not show the place exists or keeps those hours. It runs the same on fixture and recorded runs. Until Oct 20 2026 the check looked each place up in Google Places instead (`--ground-live` on recorded runs); that went with Places, and no independent check replaced it.
- **The ID validator** needs a tapped transport, so it only runs on fixture runs. On recorded runs the ledger checks remain: every reference is in the run's ledger, and every cited entity traces to a Qloo entry that returned results.
- **The partner open check uses the first street-team day**, which is the day Q9 filters on. Openness on the other street-team days is reported as a number (`openAllStreetDays`) and does not fail a case.
- **A partner with no hours from Qloo passes when the sheet shows it as "call first".** G1 bill A has two such partners on the fixture world; the D3 row of the score names it. `--strict-hours` fails it.
- **Budget bounds are upper limits.** "About 14-18 calls" is a target, not a floor: G3 makes 10 core bill-level calls (the cap is 18) and 2 coded fallback calls (the 60 km heatmap and the 2,500 m spots; the cap is 10). C19 uses 7 venue calls because the failed house heatmap is counted.
- **Recorded plans keep the last complete record per plan id.** The calls a paused run made before it resumed are not in that record, so a recorded G2 understates its budget.
- **No known gaps today.** The one gap this eval reported (C11 and C12: pre/post spots with unknown hours kept the chip "near the room, open on show night") is fixed in `packages/orchestrator` (`src/steps/prepost.ts`): such spots now say "call ahead" on their chip and the card counts them. `known-gaps.ts` is empty; a new entry must name its own check, so it can never mask a spot that is missing, closed or shut that night.
