# evals

Evaluation code for Walkup: the P1 Fan-Bar Test (Python 3.11 analysis, dependencies in `requirements.txt`, and a TypeScript arm runner), the Claude-alone check (`llm-baseline/`) and the 20-case product eval (TypeScript, on the fixture world). The P1 runner called the Qloo API (1,146 calls) and the Census Geocoder on Oct 21 2026 (UTC), and no Google Places or language model; the Fan-Bar Test was run under the sealed plan and its result is null: see [`p1/results.md`](p1/results.md). The Claude-alone check ran on Oct 28 2026 through OpenRouter and Qloo: see [`llm-baseline/results.md`](llm-baseline/results.md). The product eval calls no API and runs on every change.

## P1: the Fan-Bar Test

Does a supporters' club, used as a Qloo signal, rank the club's official home bar above a popularity ranking of the same places, and above the same model searching Google Places? Plan: `docs/preregistration/p1-plan.md` (sealed; hash in `p1-plan.sha256`).

Status: run Oct 21 2026 (UTC) under the sealed plan, with arms Q-signal, Q-pop and Q-derby; arms F and L did not run (see `docs/preregistration/p1-deviations.md`). Result: null, in [`p1/results.md`](p1/results.md). The code below is what the run used, started through `p1/run_arms_latlon.ts` (a launcher that changes only the `/search` location format; see the deviations).

| File | What it does |
|---|---|
| `p1/collect_bars.py` | Collects the official bars from the three clubs' public pages (robots.txt, at most 1 req/s, cached). Writes the private table `data/private/p1/bars_full.csv` |
| `p1/centroids.py` | Attaches a Census Gazetteer point to each row's city (places, then county subdivisions, with `data/p1/place_aliases.csv`) |
| `p1/publish_sample.py` | Writes the public `data/p1/sample_20.csv` and `data/p1/summary.json` |
| `p1/matching.py` | Name normalization and similarity, distance, US address splitting (the resolution rule of the plan) |
| `p1/analyze.py` | Reads the arms results CSV and writes `p1/out/p1_results.json` and `.md`: coverage first, then MRR and recall@k per arm, paired Wilcoxon tests in fixed sequence, bootstrap intervals, the LLM-unknown subset, sensitivity analyses and the Derby Test |
| `p1/ARMS.md` | Exact request shapes for every arm and the CSV formats (§0 to §8 sealed; §9 records how the runner settles the details they leave open) |
| `p1/run_arms.ts`, `p1/arms/` | The arm runner (Q-pop, Q-signal, F, L, Q-derby): resolution, guards, resumable cache, the arms CSV for `analyze.py`. Sealed in `p1-code.sha256`. See [`p1/arms/README.md`](p1/arms/README.md) |
| `p1/test_analyze.py`, `p1/test_collect.py` | Tests on synthetic data and synthetic markup |

### Run

```bash
pip install -r evals/requirements.txt          # if not already installed

python evals/p1/collect_bars.py                # uses the cache; --refresh re-fetches
python evals/p1/centroids.py                   # downloads the Gazetteer once into the cache
python evals/p1/publish_sample.py

# the arms (keys from .env: QLOO_API_KEY; GOOGLE_PLACES_API_KEY unless --no-google; ANTHROPIC_API_KEY for F and L).
# The Oct 21 run passed --no-google --arms Q-pop,Q-signal,Q-derby --max-qloo-calls 2000 (see the deviations log):
npx tsx evals/p1/run_arms.ts --dry-run         # the plan, no network
npx tsx evals/p1/run_arms.ts --viability       # §13 gate: 8 combinations
npx tsx evals/p1/run_arms.ts                   # the full run; repeat until it exits 0 (guards stop it cleanly)

python evals/p1/analyze.py --arms evals/out/private/p1_arms.csv --bars evals/out/private/p1_bars_status.csv --out evals/p1/out
```

### Test

```bash
python -m pytest evals/p1                      # if pytest is installed
python evals/p1/test_analyze.py                # otherwise; each file has its own runner
python evals/p1/test_collect.py
npx vitest run evals/p1/arms                   # the arm runner, on a fake world (also part of `npm test`)
```

### Public and private data

- Public: `data/p1/README.md` (counts, coverage, failures, terms), `data/p1/sample_20.csv`, `data/p1/summary.json`, `data/p1/place_aliases.csv`.
- Private and git-ignored: `data/private/p1/` (full table, hand-extracted LFC rows, page cache, fetch log, reports). The full table is never written to a public path.
- Results of the real run go to `evals/p1/out/`. Raw API responses are never written into the repository.

### Known limits

- LFC venues are written in free text, so the US rows were extracted by hand; the collector re-checks each name against the live page but cannot find new entries by itself.
- American Outlaws pages show no update date, so the stale-page rule cannot apply to them; chapter status is recorded instead.
- The closed check needs Google Places, which did not run (the project's Google billing is closed), so a bar that has since closed stays in and the coverage in `p1/results.md` is provisional.

## Product eval (20 cases)

The definition of done as code: four goldens and sixteen scenario cases run end to end through `@walkup/orchestrator` on the fixture world, with grounding, ledger, budget and policy checks. See [`product/README.md`](product/README.md) and [`docs/definition-of-done.md`](../docs/definition-of-done.md).

```bash
npx tsx evals/product/run.ts                   # writes evals/product/out/score.json and score.md
npx vitest run evals/product                   # the CI wrapper (also part of `npm test`)
```
