# Claude alone, same areas

Asked for the same street-team partners Walkup lists for its four recorded live bills, in the same areas, how many
places does a language model with no tools name that Qloo finds in the area, not marked closed, open on the
street-team day and not national chains? The plan is [`protocol.md`](protocol.md), written and hashed on Oct 28 2026
(11:45 UTC) before any model or Qloo call for this test, but committed only after the run, so git history does not prove
that order (deviation 1 in `results.md`). The results and the deviations are in
[`results.md`](results.md): Claude alone named 5 usable places of 74 asked; Walkup's list has 70 of 74, which pass the
area, closed and hours checks by construction.

SHA-256 of `protocol.md`: `a5b9e178ea0cc2e20ec51e8b3c69afa8cb3553cf076aba2677612abc8fb91321`

Check it from the repository root:

```bash
sha256sum evals/llm-baseline/protocol.md
```

`.gitattributes` keeps LF line endings, so the hash also matches a fresh checkout on Windows.

## Run

```bash
npx tsx scripts/llm-baseline.ts --prepare   # freezes the inputs into out/inputs.json; no network
npx tsx scripts/llm-baseline.ts --run       # checks the hash, then 12 model calls (OpenRouter) and the Qloo checks
npx tsx scripts/llm-baseline.ts --score     # the same scoring from the private caches; no network
npx tsx scripts/llm-baseline.ts --explore   # exploratory counts, not in the protocol (out/exploratory.json)
npx tsx scripts/why-lift.ts                 # part 2, from the recorded runs' caches; no Qloo call
```

The Oct 28 run, as it happened (see the deviations in `results.md`):

```bash
npx tsx scripts/llm-baseline.ts --run                                   # 24 requests refused: no endpoint takes temperature
npx tsx scripts/llm-baseline.ts --run --no-temperature --max-model-calls 16                   # 9 of 12 areas answered
npx tsx scripts/llm-baseline.ts --run --no-temperature --max-model-calls 6 --max-tokens 8000  # the 3 areas left
```

`out/preregistered/` holds the count as planned (after the second command); `out/` the count with all 12 areas.

`--run` needs `OPENROUTER_API_KEY` and `QLOO_API_KEY` in `.env`. Raw model answers and raw Qloo bodies stay in
`.cache/llm-baseline/` (git-ignored). `out/` holds only what the protocol publishes: the model's names and reasons,
per-name check flags, counts and the part 2 numbers.
