"""Tests for evals/p1/analyze.py on synthetic data only (no real API responses).

Run with:  python -m pytest evals/p1      (if pytest is installed)
     or:   python evals/p1/test_analyze.py
"""

from __future__ import annotations

import csv
import json
import math
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import analyze as A  # noqa: E402

CLUBS = ["american_outlaws", "arsenal_america", "lfc_olsc"]


def _row(club, metro, bar, arm, rank, n=50, bar_club=None, role="", via="", entity=""):
    return A.Row(club, metro, bar, A.canonical_arm(arm), rank, n, bar_club or club, role, via, entity)


def synthetic_rows(n_queries: int, strength: float, seed: int = 7, with_l: bool = True) -> list[A.Row]:
    """One own bar per (club, metro). strength in [0, 1]: 1 = signal arm ranks the bar near the top."""
    rng = np.random.default_rng(seed)
    rows: list[A.Row] = []
    for i in range(n_queries):
        club = CLUBS[i % 3]
        metro = f"m{i:03d}"
        bar = f"{club[:3]}-{i:03d}"
        base = int(rng.integers(1, 80))  # popularity rank; >50 means outside the top 50
        sig = max(1, int(round(base * (1 - strength) + rng.integers(1, 4))))
        f_rank = max(1, int(round(base * (1 - strength / 2) + rng.integers(0, 5))))
        for arm, r in (("Q-signal", sig), ("Q-pop", base), ("F", f_rank)):
            rows.append(_row(club, metro, bar, arm, r if r <= 50 else None))
        if with_l:
            rows.append(_row(club, metro, bar, "L", 1 if i % 4 == 0 else None, n=3))
    return rows


# ---------------------------------------------------------------------------


def test_canonical_arm_names():
    assert A.canonical_arm("q_signal") == "Q-signal"
    assert A.canonical_arm("Q-POP") == "Q-pop"
    assert A.canonical_arm("f") == "F"
    assert A.canonical_arm("Q derby") == "Q-derby"
    try:
        A.canonical_arm("Q-random")
    except ValueError:
        pass
    else:
        raise AssertionError("unknown arm accepted")


def test_reciprocal_rank_and_recall_hand_example():
    ranks = {"a": 4, "b": None, "c": 12}
    assert A.reciprocal_rank(ranks) == 0.25
    assert A.reciprocal_rank({"a": None}) == 0.0
    assert math.isclose(A.recall_at(ranks, 10), 1 / 3)
    assert math.isclose(A.recall_at(ranks, 50), 2 / 3)
    assert A.reciprocal_rank(ranks, bars={"c"}) == 1 / 12


def test_mrr_matches_hand_computation():
    rows = [
        _row("arsenal_america", "m1", "x", "Q-signal", 1),
        _row("arsenal_america", "m1", "x", "Q-pop", 4),
        _row("lfc_olsc", "m2", "y", "Q-signal", 2),
        _row("lfc_olsc", "m2", "y", "Q-pop", None),
        _row("lfc_olsc", "m2", "z", "Q-signal", 60),  # beyond top 50: not retrieved
        _row("lfc_olsc", "m2", "z", "Q-pop", 3),
    ]
    res = A.analyze(rows, resamples=200)
    assert math.isclose(res["arms"]["Q-signal"]["mrr"], (1 + 0.5) / 2)
    assert math.isclose(res["arms"]["Q-pop"]["mrr"], (0.25 + 1 / 3) / 2, abs_tol=1e-6)
    assert math.isclose(res["arms"]["Q-signal"]["recall_at_10"], (1 + 0.5) / 2)


def test_strong_signal_rejects_h1_and_no_banner():
    res = A.analyze(synthetic_rows(90, strength=0.9), resamples=2000)
    h1 = res["tests"]["H1"]
    assert h1["confirmatory"] and h1["rejected"], h1
    assert h1["mrr_diff"] > 0 and h1["mrr_diff_ci95"][0] > 0
    assert res["decision"]["h1_supported"] is True
    assert res["decision"]["partner_card_banner"] is None
    assert res["tests"]["H2"]["tested_in_sequence"] is True


def test_null_signal_keeps_banner():
    rows = []
    for r in synthetic_rows(60, strength=0.0, seed=3, with_l=False):
        if r.arm == "Q-pop":
            rows.append(r)
            rows.append(A.Row(r.club, r.metro, r.bar_key, "Q-signal", r.rank, r.candidates_n, r.bar_club))
    res = A.analyze(rows, resamples=500)
    assert res["tests"]["H1"]["n_nonzero"] == 0
    assert res["tests"]["H1"]["p_value"] == 1.0
    assert res["decision"]["h1_supported"] is False
    assert res["decision"]["partner_card_banner"] == A.BANNER_H1_NOT_SUPPORTED
    # H2 is not tested when H1 is not rejected (fixed sequence), even with no F arm present.
    assert res["tests"]["H2"]["rejected"] is False


def test_small_sample_is_inconclusive():
    res = A.analyze(synthetic_rows(12, strength=0.9), resamples=200)
    assert res["tests"]["H1"]["confirmatory"] is False
    assert res["decision"]["h1_supported"] is False
    assert res["decision"]["status"].startswith("inconclusive")


def test_bootstrap_is_deterministic_with_seed():
    rows = synthetic_rows(40, strength=0.5)
    a = A.analyze(rows, seed=11, resamples=1000)
    b = A.analyze(rows, seed=11, resamples=1000)
    c = A.analyze(rows, seed=12, resamples=1000)
    assert a["arms"]["Q-signal"]["mrr_ci95"] == b["arms"]["Q-signal"]["mrr_ci95"]
    assert a["tests"]["H1"]["mrr_diff_ci95"] == b["tests"]["H1"]["mrr_diff_ci95"]
    assert a["arms"]["Q-signal"]["mrr_ci95"] != c["arms"]["Q-signal"]["mrr_ci95"]


def test_derby_counts_ties_and_shared_bars():
    rows = [
        # metro M1: Arsenal signal ranks its bar 3, Liverpool's 10 -> correct
        _row("arsenal_america", "M1", "ars1", "Q-derby", 3),
        _row("arsenal_america", "M1", "lfc1", "Q-derby", 10, bar_club="lfc_olsc"),
        # Liverpool signal ranks its own bar 2, Arsenal's 1 -> wrong
        _row("lfc_olsc", "M1", "lfc1", "Q-derby", 2),
        _row("lfc_olsc", "M1", "ars1", "Q-derby", 1, bar_club="arsenal_america"),
        # metro M2: both absent under AO signal -> tie, excluded
        _row("american_outlaws", "M2", "ao2", "Q-derby", None),
        _row("american_outlaws", "M2", "ars2", "Q-derby", None, bar_club="arsenal_america"),
        # Arsenal signal: own ranked, rival absent -> correct
        _row("arsenal_america", "M2", "ars2", "Q-derby", 7),
        _row("arsenal_america", "M2", "ao2", "Q-derby", None, bar_club="american_outlaws"),
        # metro M3: two clubs list the same place (different listing keys, same entity) -> shared
        _row("lfc_olsc", "M3", "lfc3", "Q-derby", 4, entity="E1"),
        _row("lfc_olsc", "M3", "ao3", "Q-derby", 4, bar_club="american_outlaws", entity="E1"),
    ]
    d = A.derby(rows)
    assert d["source_arm"] == "Q-derby"
    assert d["trials"] == 3 and d["correct"] == 2
    assert d["ties_excluded"] == 1 and d["shared_bar_excluded"] == 1
    assert d["ci95_exact"][0] < 2 / 3 < d["ci95_exact"][1]
    # Metro level: M1 is an even split (dropped), M2 is correct.
    assert d["metro_level"]["trials"] == 1 and d["metro_level"]["correct"] == 1


def test_derby_falls_back_to_signal_lists_and_prefers_official_bar():
    rows = [
        _row("arsenal_america", "M1", "ars-sat", "Q-signal", 1, role="satellite"),
        _row("arsenal_america", "M1", "ars-off", "Q-signal", 30, role="official"),
        _row("arsenal_america", "M1", "lfc1", "Q-signal", 20, bar_club="lfc_olsc", role="official"),
    ]
    d = A.derby(rows)
    assert d["source_arm"] == "Q-signal"
    # The official bar (rank 30) is compared, never the better-ranked satellite.
    assert d["trials"] == 1 and d["correct"] == 0
    assert d["trials_detail"][0]["own_bar"] == "ars-off"


def test_missing_rows_mean_not_eligible_and_pairing_uses_shared_bars():
    rows = [
        _row("lfc_olsc", "m1", "a", "Q-signal", 2),
        _row("lfc_olsc", "m1", "b", "Q-signal", 1),
        _row("lfc_olsc", "m1", "a", "F", 5),  # b has no Google place: no F row
    ]
    res = A.analyze(rows, resamples=100)
    assert res["info"]["bars_without_row_by_arm"]["F"] == 1
    # Per-arm summary uses each arm's own rows: Q-signal finds b at rank 1.
    assert res["arms"]["Q-signal"]["mrr"] == 1.0
    # H2 pairs only bar a: Q-signal 1/2 vs F 1/5.
    h2 = res["tests"]["H2"]
    assert h2["n_pairs"] == 1
    assert math.isclose(h2["mrr_a"], 0.5) and math.isclose(h2["mrr_b"], 0.2)


def test_llm_unknown_subset():
    res = A.analyze(synthetic_rows(40, strength=0.8), resamples=200)
    u = res["llm_unknown"]
    assert u["n_queries"] == 30  # L names the bar in every 4th query
    assert math.isclose(u["llm_known_rate"], 0.25)
    assert "Q-signal" in u["arms"]


def test_sensitivity_blocks_when_columns_present():
    rows = []
    for r in synthetic_rows(30, strength=0.8, with_l=False):
        r.listing_role = "official" if int(r.metro[1:]) % 2 == 0 else "satellite"
        r.resolution_via = "primary" if int(r.metro[1:]) % 3 else "fallback"
        rows.append(r)
    res = A.analyze(rows, resamples=200)
    assert res["sensitivity"]["official_bars_only"]["n_pairs"] == 15
    assert res["sensitivity"]["primary_resolution_only"]["n_pairs"] == 20


def _write_csv(path: Path, rows: list[dict]) -> None:
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def test_main_writes_json_and_md_with_coverage_first():
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        arms = [
            {"club": r.club, "metro": r.metro, "bar_key": r.bar_key, "arm": r.arm, "rank_or_blank": r.rank or "", "candidates_n": r.candidates_n}
            for r in synthetic_rows(30, strength=0.7)
        ]
        _write_csv(tdp / "arms.csv", arms)
        statuses = ["analyzed"] * 30 + ["unresolved"] * 6 + ["stale_page"] * 2 + ["closed"] * 1
        bars = [{"club": CLUBS[i % 3], "bar_key": f"b{i}", "status": s} for i, s in enumerate(statuses)]
        _write_csv(tdp / "bars.csv", bars)
        out = tdp / "out"
        assert A.main(["--arms", str(tdp / "arms.csv"), "--bars", str(tdp / "bars.csv"), "--out", str(out), "--resamples", "300"]) == 0
        res = json.loads((out / "p1_results.json").read_text(encoding="utf-8"))
        assert res["coverage"]["total"]["listed"] == 39
        assert res["coverage"]["total"]["unresolved"] == 6
        # resolution rate = (39 - 2 stale - 6 unresolved) / (39 - 2 stale)
        assert math.isclose(res["coverage"]["total"]["resolution_rate"], 31 / 37, rel_tol=1e-5)
        assert len(res["inputs"]["arms_csv_sha256"]) == 64
        md = (out / "p1_results.md").read_text(encoding="utf-8")
        assert md.index("## 1. Coverage") < md.index("## 2. Arms") < md.index("## 3. Preregistered tests")


def test_zero_negative_or_fractional_rank_is_an_error_not_absent():
    for bad in ("0", "-1", "2.5"):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "arms.csv"
            _write_csv(p, [{"club": "lfc_olsc", "metro": "m1", "bar_key": "a", "arm": "Q-signal", "rank_or_blank": bad, "candidates_n": 50}])
            try:
                A.load_rows(p)
            except ValueError as exc:
                assert "line 2" in str(exc)
            else:
                raise AssertionError(f"rank {bad!r} accepted")
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "arms.csv"
        _write_csv(p, [{"club": "lfc_olsc", "metro": "m1", "bar_key": "a", "arm": "Q-signal", "rank_or_blank": "3.0", "candidates_n": 50},
                       {"club": "lfc_olsc", "metro": "m1", "bar_key": "a", "arm": "Q-pop", "rank_or_blank": "", "candidates_n": 50}])
        assert [r.rank for r in A.load_rows(p)] == [3, None]


def test_derby_without_rival_rows_reports_that_it_could_not_run():
    rows = [_row("arsenal_america", "M1", "ars1", "Q-signal", 2), _row("lfc_olsc", "M1", "lfc1", "Q-signal", 5)]
    d = A.derby(rows)
    assert d["source_arm"] == "Q-signal" and d["trials"] == 0
    assert d["rival_rows_in_source"] == 0 and "could not be computed" in d["note"]
    assert "Note: no rival-bar rows" in A.render_md(A.analyze(rows, resamples=50))


def test_status_crosscheck_counts_missing_and_unexpected_rows():
    rows = [
        _row("lfc_olsc", "m1", "a", "Q-signal", 1),
        _row("lfc_olsc", "m1", "a", "Q-pop", 2),
        _row("lfc_olsc", "m1", "x", "Q-signal", 4),  # x is 'unresolved' in the status file
        _row("lfc_olsc", "m1", "r", "Q-derby", 1, bar_club="arsenal_america"),  # derby rows are not checked
    ]
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "bars.csv"
        _write_csv(p, [
            {"club": "lfc_olsc", "bar_key": "a", "status": "analyzed"},
            {"club": "lfc_olsc", "bar_key": "b", "status": "analyzed"},  # every call for b failed
            {"club": "lfc_olsc", "bar_key": "x", "status": "unresolved"},
        ])
        res = A.analyze(rows, bars_csv=p, resamples=50)
    assert res["info"]["analyzed_bars_without_any_arm_row"] == 1
    assert res["info"]["arm_rows_for_bars_not_analyzed"] == 1
    assert sum("no row in any arm" in w for w in res["warnings"]) == 1


def test_plan_hash_is_checked_against_the_plan_file():
    res = A.analyze(synthetic_rows(6, strength=0.5), resamples=50)
    assert res["plan_sha256_matches_file"] is True  # the sealed plan in this repository
    with tempfile.TemporaryDirectory() as td:
        sha, plan = Path(td) / "p1-plan.sha256", Path(td) / "p1-plan.md"
        plan.write_text("edited after sealing\n", encoding="utf-8")
        sha.write_text("0" * 64 + " *p1-plan.md\n", encoding="utf-8")
        old = (A.PLAN_SHA_FILE, A.PLAN_FILE)
        A.PLAN_SHA_FILE, A.PLAN_FILE = sha, plan
        try:
            res = A.analyze(synthetic_rows(6, strength=0.5), resamples=50)
        finally:
            A.PLAN_SHA_FILE, A.PLAN_FILE = old
    assert res["plan_sha256_matches_file"] is False
    assert any("does not match its sealed SHA-256" in w for w in res["warnings"])
    assert "DOES NOT match the plan file" in A.render_md(res)


def test_bad_status_rejected():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "bars.csv"
        _write_csv(p, [{"club": "x", "bar_key": "1", "status": "maybe"}])
        try:
            A.coverage(p, {})
        except ValueError:
            return
        raise AssertionError("unknown status accepted")


if __name__ == "__main__":
    failures = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as exc:  # report every failure, then exit non-zero
            failures += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"{len(tests) - failures} passed, {failures} failed")
    raise SystemExit(1 if failures else 0)
