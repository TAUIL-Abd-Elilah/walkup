# P1 Fan-Bar Test: results (run Oct 21 2026 UTC)

**Result: null.** Qloo's taste signal for a football club did not rank that club's official supporters' bar higher than Qloo's popularity order of the same places. H1 is not supported. The Derby Test is not significant either.

This is the preregistered run of [`docs/preregistration/p1-plan.md`](../../docs/preregistration/p1-plan.md) (SHA-256 `1bd044de…b763`, checked against the file before the run and by the analysis). Every departure from the plan is in [`p1-deviations.md`](../../docs/preregistration/p1-deviations.md); the rows for this run were committed and pushed before any P1 call (`45fbd2f`) and before the run resumed after a request-format stop (`0adbb61`). The full output of the sealed analysis is [`out/p1_results.md`](out/p1_results.md) and [`out/p1_results.json`](out/p1_results.json); the runner's counts are in [`../out/p1_arms_summary.md`](../out/p1_arms_summary.md). Only derived numbers are published here: no Qloo response bodies and no bar names.

## What was run

- **Question.** Given a supporters' club as the signal (Arsenal FC for Arsenal America, Liverpool FC for the LFC supporters' clubs, the US men's national team for the American Outlaws), does Qloo rank the club's own listed bar in a US city above a popularity ranking of the same Qloo places with the same filters (bars, pubs, sports bars and Irish pubs within 25 km)?
- **Ground truth.** 426 bars listed on the three clubs' own pages, frozen on Oct 13 2026 before any Qloo call and sealed by hash. Not re-collected.
- **Arms run.** Q-signal (club as signal) and Q-pop (no signal, Qloo's popularity order; all 225 Q-pop lists were in non-increasing popularity), plus Q-derby for the Derby Test.
- **Arms not run.** F (a model searching Google Places) and L (the model alone): the project's Google Cloud billing is closed and there is no Anthropic API key for the plan's model. So H2 was not tested, no claim about Google Places is made, and the closed-bar check did not run (coverage is provisional: a bar that has since closed stays in). No language model was used anywhere in this run.
- **Calls.** 1,146 Qloo requests in all (including 8 before the request-format stop and the viability probe), 379 Census Geocoder requests, 0 Google Places requests, 0 model calls. No call failed; no returned place lay beyond 26 km of its city point.

## Coverage (before any result)

| club | listed | no city point | did not resolve to a Qloo place | beyond 25 km | analyzed | resolution rate |
|---|---|---|---|---|---|---|
| American Outlaws | 256 | 0 | 46 | 9 | 201 | 82% |
| Arsenal America | 94 | 0 | 14 | 0 | 80 | 85% |
| LFC supporters' clubs | 76 | 1 | 12 | 1 | 62 | 84% |
| **total** | 426 | 1 | 72 | 10 | 343 | 83% |

343 bars in 325 (club, city) queries over 225 cities. No page was stale and no club failed to resolve to a Qloo entity.

**Viability gate (plan §13).** On the 8 preregistered probe combinations (Houston, Chicago, Durham), 8 of 8 bars resolved but only 1 was in the Q-signal top 50, below the gate of 3. By the plan, P1 still runs and is published in full, but is not presented as the lead evidence for the product.

## H1 (primary): Q-signal against Q-pop

| arm | queries | MRR [95% CI] | in the top 10 [95% CI] | in the top 50 [95% CI] |
|---|---|---|---|---|
| Q-signal (club as signal) | 325 | 0.024 [0.016, 0.033] | 6.8% [4.3%, 9.5%] | 25.2% [20.6%, 29.8%] |
| Q-pop (popularity only) | 325 | 0.030 [0.020, 0.042] | 7.2% [4.5%, 10.2%] | 27.0% [22.2%, 31.8%] |

- MRR difference, Q-signal minus Q-pop: **-0.006, 95% CI [-0.018, 0.006]** (10,000 bootstrap resamples of queries).
- One-sided Wilcoxon signed-rank test (Q-signal greater): p = **0.89**, 325 pairs, 110 with a difference. In those 110, the signal ranked the bar higher in 49 and popularity in 61; the other 215 tied, 213 of them because neither list had the bar in its top 50.
- **Decision: H1 not supported** (confirmatory: more than 20 pairs). H2 not tested.
- Sensitivity (not used for the decision): official listings only, -0.005 [-0.017, 0.007], p = 0.94; primary-path resolutions only, -0.004 [-0.018, 0.009], p = 0.61. By club, popularity's MRR was at or above the signal's for all three clubs.

## Derby Test (secondary)

In cities where two clubs both list a bar, under club A's signal, does A's bar rank above club B's bar (one shortlist call per club and city)?

- **95 of 182 trials correct: 52.2%, exact 95% CI [44.7%, 59.6%]**, one-sided binomial p = 0.30 against 50%. 58 cities with a trial; 6 ties and 62 bars listed by both clubs excluded.
- One outcome per city: 8 of 12, 95% CI [34.9%, 90.1%].
- Not distinguishable from a coin flip.

## What it means

- On this outside ground truth, using a football club as Qloo's taste signal did not put the club's official bar higher than Qloo's plain popularity order; if anything popularity did slightly better, within the noise. Qloo also did not tell two clubs' bars in the same city apart better than chance.
- Walkup does not use clubs as signals; it uses a show's acts, and ranks places within small areas weighted by where the bill's crowd stands out. This test does not show that those picks beat popularity, so the product does not claim it: partner tables carry the plan's banner, "Ranked by Qloo affinity; our test did not show this beats popularity." The live sheets' popularity check shows the two lists differ, not that one is better.
- Limits that apply here: the designated bar is often a generic sports bar that ranks for every football crowd; one brand entity per club (men's team only for the American Outlaws); the Census city point is not a downtown; the closed check did not run; and three clubs in US cities are not every audience.
