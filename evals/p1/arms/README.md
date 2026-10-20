# P1 arm runner

TypeScript runner for the P1 Fan-Bar Test arms: it resolves the listed supporters' bars and the
club brands, then runs Q-pop, Q-signal, F, L and Q-derby exactly as
`docs/preregistration/p1-plan.md` (sealed) and `evals/p1/ARMS.md` (the request contract)
specify, and writes the two CSV files `evals/p1/analyze.py` reads. The entry point is
`evals/p1/run_arms.ts`; this folder holds its modules and tests.

## Run

```bash
npx tsx evals/p1/run_arms.ts --dry-run              # plan and call counts; no keys, nothing sent or written
npx tsx evals/p1/run_arms.ts --viability            # plan §13 probe (Houston, Chicago, Durham; Q-signal)
npx tsx evals/p1/run_arms.ts                        # the preregistered run, all arms
npx tsx evals/p1/run_arms.ts --arms Q-pop,Q-signal  # some arms only (setup and resolution always run first)
npx tsx evals/p1/run_arms.ts --limit 5 --no-google  # smoke run: 5 queries, Qloo only, provisional coverage

python evals/p1/analyze.py --arms evals/out/private/p1_arms.csv --bars evals/out/private/p1_bars_status.csv --out evals/p1/out
```

Keys come from `.env`: `QLOO_API_KEY`; `GOOGLE_PLACES_API_KEY` unless `--no-google`;
`ANTHROPIC_API_KEY` for F and L. `--help` lists every flag.

Exit codes: 0 done; 2 usage or configuration; 3 stopped by a guard (re-run the same command to
resume); 4 a Q arm returned a place beyond 26 km (plan §8: stop and log a deviation); 1 other.

## What it does, in the plan's order

1. **Club brands** (§6): typed `/search` over the preregistered names, name similarity ≥ 0.85,
   a `sports_organization` tag (`/entities` when `/search` gives no tags), highest popularity.
2. **Tag pins** (§8): `/v2/tags` for bar, pub, sports bar, irish pub; exact normalized name,
   `urn:tag:category:place` preferred. `config/tags.json` is compared, never used instead.
3. **Resolution** (§5, §7), for every bar before any arm call: stale page, no metro, no brand;
   Census Geocoder for addresses that start with a street number (primary path: Qloo `/search`
   within 300 m, similarity ≥ 0.85; otherwise the fallback path: exactly one candidate ≥ 0.95
   within 25 km, then the ZIP check); the Google place with the same rules (closed check);
   out of radius. The status file is written here.
4. **Arms** (§8, §11): Q-pop (one call per metro), Q-signal (one per query, plus rival rows),
   F (model + `places_search`, at most 5 tool calls), L (model alone), Q-derby (one shortlist
   call per signal club in metros with two or more clubs).

## Files

| File | Visibility | What |
|---|---|---|
| `evals/out/private/p1_arms.csv` | git-ignored | `club,metro,bar_key,arm,rank_or_blank,candidates_n,bar_club,listing_role,resolution_via,entity_id` (`p1_arms.partial.csv` when a run stopped) |
| `evals/out/private/p1_bars_status.csv` | git-ignored | `club,bar_key,metro,status,entity_id,google_place_id,resolution_via` |
| `evals/out/private/p1_run_log.json`, `p1_ledger_<time>.json` | git-ignored | failures by query, notes, every call (keys shown as `$ENV` references) |
| `evals/out/p1_arms_summary.json`, `.md` | public | counts only: coverage, calls, arms; no bar names, keys, entity ids or ranks |
| `evals/p1/club_entities.json`, `evals/p1/pinned_tags.json` | public | ids only, as the plan names them |
| `data/private/p1/run/p1-run.sqlite` | git-ignored | Qloo response cache (one-year TTL) and the run state: frozen per-bar decisions, run date, F subset, model answers, Places and Census answers, counters |

## Guards

- **Qloo**: at most `--max-qloo-calls` (default 900) HTTP requests per run, retries included;
  then the run stops and the next run resumes from the cache. The upper bound for the full run is
  1,331 requests (dry run); unresolved bars and queries left without bars lower it. The
  `@walkup/qloo` month guard (floor `QLOO_MONTH_GUARD_FLOOR`, default 1,500) also applies.
  Retries: 3, at 1 s, 2 s and 4 s; 3 requests per second.
- **Google Places**: the plan's 2,500 requests in total (resolution plus F tools), enforced at send
  time; a daily cap (`--places-daily-cap`, default 300). If 5 tool calls per F query would not fit,
  the F subset is drawn once with Python's `random.Random(20261013)` (ported in `pyrandom.ts`).
- **Model**: `@walkup/narrator`'s spend guard (`--llm-daily-cap-usd`, default $5 per UTC day).
- **Failures**: Places, Census and model calls are retried 3 times (1 s, 2 s, 4 s) on 429, 5xx,
  network errors and timeouts (30 s). A resolution call that still fails stops the run. An arm
  call that still fails leaves no rows and is counted; in arm F that includes a `places_search`
  request, so an outage never shortens the model's candidate list (401/403 stops the run).
- **Location filter**: any Q-signal or Q-pop place more than 26 km from the metro point stops the run.

## Modules

`protocol.ts` (every fixed value, prompts verbatim), `similarity.ts` (port of `matching.py`,
including difflib's ratio), `pyrandom.ts`, `csv.ts`, `bars.ts` (table and queries), `qloo-io.ts`
(request shapes and the call cap), `places-io.ts`, `census.ts` (geocoder with robots.txt),
`resolve.ts` (§5 to §7), `q-arms.ts`, `model-arms.ts`, `runner.ts` (order, resume, outputs),
`plan.ts` (dry run), `output.ts`, `services.ts` (wiring and seal checks), `store.ts`.

The model arms are P1-specific: `@walkup/narrator`'s `runControlArm` and `runLlmOnlyArm`
use the product's prompts, tools, list length, effort and server-side fallback, which differ from
the sealed protocol. The runner reuses the narrator's model id, spend guard and cost estimate.

## Test

```bash
npx vitest run --config evals/p1/arms/vitest.config.ts
npx tsc -p evals/p1/arms/tsconfig.json --noEmit
```

The tests use `test-data/bars_synthetic.csv` (invented rows) and fake transports for Qloo,
Google Places, the Census Geocoder and the model (`test/fake-world.ts`); nothing reaches the
network. They check parity with the Python helpers (similarity, metro names, `random.sample`),
the exact request shapes, the exclusion order, ranks per arm, the stops and resume, and, when
numpy and scipy are installed, that `analyze.py` reads the output without errors.

## Known limits

- Unverified until key day: whether the Census Geocoder matches the contract's
  "address, city, state" string when the listed address already ends with the city, state and
  ZIP (a miss sends the bar to the stricter fallback path); `/search` with a WKT location (the
  API notes say it is accepted).
- The Places client sends its fixed field mask (a superset of the contract's) and
  `maxResultCount` instead of `pageSize`; results are the same, the billing tier may differ.
- The response `model` check accepts `claude-opus-5-5` or a dated snapshot of it.
- A query whose F or L conversation failed (including a failed `places_search`) is skipped on
  resume unless `--retry-failed`.
- `--limit` and `--viability` runs cover part of the ground truth and are not the preregistered run.
