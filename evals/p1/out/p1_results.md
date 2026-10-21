# P1 Fan-Bar Test: results

Generated 2026-10-21T23:20:05Z. Plan SHA-256: `1bd044de71fb802a9adda45c6150b2f610f5c5a53afb8aced41b217b99bdb763` (matches the plan file). Unit of analysis: query = (club, metro).

## 1. Coverage (reported before any result)

| club | listed | stale_page | no_metro | no_brand | unresolved | closed | out_of_radius | analyzed | resolution_rate |
|---|---|---|---|---|---|---|---|---|---|
| american_outlaws | 256 | 0 | 0 | 0 | 46 | 0 | 9 | 201 | 0.820 |
| arsenal_america | 94 | 0 | 0 | 0 | 14 | 0 | 0 | 80 | 0.851 |
| lfc_olsc | 76 | 0 | 1 | 0 | 12 | 0 | 1 | 62 | 0.840 |
| **total** | 426 | 0 | 1 | 0 | 72 | 0 | 10 | 343 | 0.831 |

## 2. Arms (all queries)

| arm | n queries | MRR [95% CI] | recall@10 [95% CI] | recall@50 [95% CI] |
|---|---|---|---|---|
| Q-signal | 325 | 0.024 [0.016, 0.033] | 0.068 [0.043, 0.095] | 0.252 [0.206, 0.298] |
| Q-pop | 325 | 0.030 [0.020, 0.042] | 0.072 [0.045, 0.102] | 0.270 [0.222, 0.318] |

## 3. Preregistered tests

Procedure: fixed-sequence (H1 then H2), each one-sided at alpha = 0.05.

| test | arms | n pairs | n nonzero | MRR diff [95% CI] | Wilcoxon p (one-sided) | confirmatory | rejected |
|---|---|---|---|---|---|---|---|
| H1 | Q-signal > Q-pop | 325 | 110 | -0.006 [-0.018, 0.006] | 0.8910 | True | False |
| H2 | Q-signal > F | 0 | 0 | n/a n/a | 1.0000 | False | False (exploratory: H1 not rejected) |

**Decision:** confirmatory. H1 supported: **False**. H2 supported: **False**.
Partner cards carry the banner: "Ranked by Qloo affinity; our test did not show this beats popularity."

## 5. Derby Test (secondary)

Source arm: Q-derby. Trials: 182; metros with a trial: 58; ties excluded: 6; shared bars excluded: 62.
Pairwise accuracy: 0.522, exact 95% CI [0.447, 0.596], one-sided binomial p vs 0.5 = 0.3020.
Metro-level (one outcome per metro): 8/12, exact 95% CI [0.349, 0.901].

## 6. Sensitivity (reported, not used for the decision)

- official_bars_only: n = 306, MRR diff -0.005 [-0.017, 0.007], p = 0.9449
- primary_resolution_only: n = 278, MRR diff -0.004 [-0.018, 0.009], p = 0.6085

## By club

| club | arm | n | MRR [95% CI] |
|---|---|---|---|
| american_outlaws | Q-signal | 185 | 0.036 [0.024, 0.052] |
| american_outlaws | Q-pop | 185 | 0.040 [0.024, 0.060] |
| arsenal_america | Q-signal | 78 | 0.007 [0.002, 0.013] |
| arsenal_america | Q-pop | 78 | 0.017 [0.006, 0.034] |
| lfc_olsc | Q-signal | 62 | 0.007 [0.001, 0.014] |
| lfc_olsc | Q-pop | 62 | 0.015 [0.006, 0.026] |

## What this does not establish

- That fans would choose these bars if no bar were designated (affinity is a current snapshot).
- Anything about ticket sales or any individual.
- Performance outside the three clubs and US metros tested.
