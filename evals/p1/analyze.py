"""P1 "Fan-Bar Test" analysis, exactly as preregistered in docs/preregistration/p1-plan.md.

Input: an arms results CSV with one row per (query club, metro, bar, arm):

  required  club           the club whose signal (or prompt) produced the ranking
            metro          metro id (Census place GEOID or "City, ST"); shared across clubs
            bar_key        listed bar id (data/private/p1/bars_full.csv)
            arm            Q-signal | Q-pop | F | L | Q-derby
            rank_or_blank  1-based rank of that bar in the arm's list (top 50), blank if absent
            candidates_n   how many candidates the arm returned for this query
  optional  bar_club       club that lists the bar (default: club). Rows with bar_club != club
                           are rival rows, used only by the Derby Test.
            listing_role   official | satellite  (sensitivity: official bars only)
            resolution_via primary | fallback    (sensitivity: primary resolution only)
            entity_id      resolved Qloo entity id (Derby: two clubs listing the same place)

A bar with no row in an arm is not eligible for that arm (for example F when no Google place
was resolved). Write a row, with a blank rank, for every eligible bar the arm did not return.
Paired comparisons use, per query, only the bars that have a row in both arms.

Optional --bars CSV (club, bar_key, status[, metro]) gives the coverage funnel. status is one of
  analyzed | stale_page | no_metro | unresolved | closed | out_of_radius | no_brand

Outputs: <out>/p1_results.json and <out>/p1_results.md (coverage table first).

Usage: python evals/p1/analyze.py --arms arms.csv [--bars bars_status.csv] [--out evals/p1/out]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy import stats

SEED = 20261013
RESAMPLES = 10_000
ALPHA = 0.05
TOP_K = 50
MIN_PAIRED_QUERIES = 20

ARMS = ["Q-signal", "Q-pop", "F", "L"]
DERBY_ARM = "Q-derby"
COMPARISONS = [("H1", "Q-signal", "Q-pop"), ("H2", "Q-signal", "F")]
STATUS_ORDER = ["listed", "stale_page", "no_metro", "no_brand", "unresolved", "closed", "out_of_radius", "analyzed"]
BANNER_H1_NOT_SUPPORTED = "Ranked by Qloo affinity; our test did not show this beats popularity."

PLAN_SHA_FILE = Path(__file__).resolve().parents[2] / "docs" / "preregistration" / "p1-plan.sha256"
PLAN_FILE = PLAN_SHA_FILE.with_name("p1-plan.md")


def canonical_arm(name: str) -> str:
    key = re.sub(r"[^a-z]", "", (name or "").casefold())
    table = {"qsignal": "Q-signal", "qpop": "Q-pop", "f": "F", "l": "L", "qderby": DERBY_ARM}
    if key not in table:
        raise ValueError(f"unknown arm: {name!r}")
    return table[key]


@dataclass
class Row:
    club: str
    metro: str
    bar_key: str
    arm: str
    rank: int | None
    candidates_n: int
    bar_club: str
    listing_role: str = ""
    resolution_via: str = ""
    entity_id: str = ""


@dataclass
class Query:
    club: str
    metro: str
    # arm -> {bar_key: rank or None} for the club's own bars
    own: dict[str, dict[str, int | None]] = field(default_factory=dict)
    roles: dict[str, str] = field(default_factory=dict)
    via: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def _int_or_none(s: str) -> int | None:
    """Blank -> None (not in the list). Anything else must be a 1-based integer rank: a 0, a
    negative or a fractional value means the runner wrote the wrong rank base, so it is an
    error, never a silent "absent" (a 0-based list would otherwise lose every top-1 hit)."""
    s = (s or "").strip()
    if not s:
        return None
    f = float(s)
    if not f.is_integer() or f < 1:
        raise ValueError(f"rank_or_blank must be a 1-based integer or blank, got {s!r}")
    return int(f)


def load_rows(path: Path) -> list[Row]:
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        missing = {"club", "metro", "bar_key", "arm", "rank_or_blank", "candidates_n"} - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"arms CSV is missing columns: {sorted(missing)}")
        rows = []
        for line_no, r in enumerate(reader, start=2):
            try:
                _int_or_none(r["rank_or_blank"])
            except ValueError as exc:
                raise ValueError(f"{path}, line {line_no}: {exc}") from None
            rows.append(
                Row(
                    club=r["club"].strip(),
                    metro=r["metro"].strip(),
                    bar_key=r["bar_key"].strip(),
                    arm=canonical_arm(r["arm"]),
                    rank=_int_or_none(r["rank_or_blank"]),
                    candidates_n=int(float(r["candidates_n"] or 0)),
                    bar_club=(r.get("bar_club") or "").strip() or r["club"].strip(),
                    listing_role=(r.get("listing_role") or "").strip(),
                    resolution_via=(r.get("resolution_via") or "").strip(),
                    entity_id=(r.get("entity_id") or "").strip(),
                )
            )
    return rows


def build_queries(rows: list[Row], warnings: list[str], info: dict | None = None) -> dict[tuple[str, str], Query]:
    """Group own-bar rows by query. A bar with no row in an arm is not eligible for that arm
    (for example F when no Google place was resolved); paired comparisons use, per query, only
    the bars present in both arms."""
    queries: dict[tuple[str, str], Query] = {}
    bars_by_query: dict[tuple[str, str], set[str]] = defaultdict(set)
    for r in rows:
        if r.arm == DERBY_ARM or r.bar_club != r.club:
            continue
        q = queries.setdefault((r.club, r.metro), Query(r.club, r.metro))
        arm_map = q.own.setdefault(r.arm, {})
        if r.bar_key in arm_map:
            warnings.append(f"duplicate row ignored: {r.club}/{r.metro}/{r.bar_key}/{r.arm}")
            continue
        rank = r.rank if (r.rank is not None and r.rank <= TOP_K) else None
        arm_map[r.bar_key] = rank
        bars_by_query[(r.club, r.metro)].add(r.bar_key)
        if r.listing_role:
            q.roles[r.bar_key] = r.listing_role
        if r.resolution_via:
            q.via[r.bar_key] = r.resolution_via
    if info is not None:
        missing: dict[str, int] = defaultdict(int)
        for key, q in queries.items():
            for arm in ARMS:
                missing[arm] += len(bars_by_query[key] - set(q.own.get(arm, {})))
        info["bars_without_row_by_arm"] = dict(missing)
    return queries


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def reciprocal_rank(ranks: dict[str, int | None], bars: set[str] | None = None) -> float:
    vals = [r for b, r in ranks.items() if r is not None and (bars is None or b in bars)]
    return 1.0 / min(vals) if vals else 0.0


def recall_at(ranks: dict[str, int | None], k: int, bars: set[str] | None = None) -> float:
    keys = [b for b in ranks if bars is None or b in bars]
    if not keys:
        return 0.0
    return sum(1 for b in keys if ranks[b] is not None and ranks[b] <= k) / len(keys)


def per_query_metrics(queries: list[Query], arm: str, bars_filter=None) -> dict[str, np.ndarray]:
    rr, r10, r50 = [], [], []
    for q in queries:
        ranks = q.own.get(arm, {})
        bars = bars_filter(q) if bars_filter else None
        rr.append(reciprocal_rank(ranks, bars))
        r10.append(recall_at(ranks, 10, bars))
        r50.append(recall_at(ranks, 50, bars))
    return {"rr": np.array(rr, float), "recall_at_10": np.array(r10, float), "recall_at_50": np.array(r50, float)}


class Bootstrap:
    """Percentile bootstrap of a mean over queries, one seeded generator for the whole run."""

    def __init__(self, seed: int = SEED, resamples: int = RESAMPLES):
        self.rng = np.random.default_rng(seed)
        self.resamples = resamples

    def ci(self, values: np.ndarray) -> list[float] | None:
        n = len(values)
        if n == 0:
            return None
        idx = self.rng.integers(0, n, size=(self.resamples, n))
        means = values[idx].mean(axis=1)
        lo, hi = np.percentile(means, [2.5, 97.5])
        return [round(float(lo), 6), round(float(hi), 6)]


def wilcoxon_greater(x: np.ndarray, y: np.ndarray) -> dict:
    """One-sided paired Wilcoxon signed-rank, H_a: x > y. Zero differences dropped (zero_method='wilcox')."""
    d = x - y
    nz = int(np.count_nonzero(d))
    out = {"n_pairs": int(len(d)), "n_nonzero": nz, "statistic": None, "p_value": 1.0, "method": "scipy.stats.wilcoxon(zero_method='wilcox', alternative='greater', method='auto')"}
    if nz == 0:
        out["note"] = "all paired differences are zero"
        return out
    res = stats.wilcoxon(x, y, zero_method="wilcox", alternative="greater", method="auto")
    out["statistic"] = float(res.statistic)
    out["p_value"] = float(res.pvalue)
    return out


def binom_summary(k: int, n: int) -> dict:
    if n == 0:
        return {"correct": 0, "trials": 0, "accuracy": None, "ci95_exact": None, "p_one_sided_greater": None}
    two = stats.binomtest(k, n, 0.5, alternative="two-sided")
    ci = two.proportion_ci(confidence_level=0.95, method="exact")
    one = stats.binomtest(k, n, 0.5, alternative="greater")
    return {
        "correct": k,
        "trials": n,
        "accuracy": round(k / n, 6),
        "ci95_exact": [round(float(ci.low), 6), round(float(ci.high), 6)],
        "p_one_sided_greater": float(one.pvalue),
    }


# ---------------------------------------------------------------------------
# Derby Test
# ---------------------------------------------------------------------------


def _primary_bar(bars: dict[str, Row]) -> str:
    """Official listing first, then the lexicographically smallest bar_key (never by rank)."""
    return sorted(bars, key=lambda b: (0 if bars[b].listing_role in ("", "official") else 1, b))[0]


def _same_place(a: Row, b: Row) -> bool:
    if a.entity_id and b.entity_id:
        return a.entity_id == b.entity_id
    return a.bar_key == b.bar_key


def derby(rows: list[Row]) -> dict:
    """Derby Test: under club c's signal in metro m, does c's primary bar outrank rival club r's
    primary bar? One trial per (c, m, r). Absent from the list = rank infinity; both absent = tie
    (excluded, counted); the same place listed by both clubs = shared (excluded, counted)."""
    source = DERBY_ARM if any(r.arm == DERBY_ARM for r in rows) else "Q-signal"
    use = [r for r in rows if r.arm == source]
    rival_rows = sum(1 for r in use if r.bar_club != r.club)
    groups: dict[tuple[str, str], list[Row]] = defaultdict(list)
    for r in use:
        groups[(r.club, r.metro)].append(r)
    trials, ties, shared = [], 0, 0
    for (club, metro), rs in sorted(groups.items()):
        own = {r.bar_key: r for r in rs if r.bar_club == club}
        if not own:
            continue
        own_bar = _primary_bar(own)
        rivals_by_club: dict[str, dict[str, Row]] = defaultdict(dict)
        for r in rs:
            if r.bar_club != club:
                rivals_by_club[r.bar_club][r.bar_key] = r
        for rival_club, rb in sorted(rivals_by_club.items()):
            rival_bar = _primary_bar(rb)
            if _same_place(own[own_bar], rb[rival_bar]):
                shared += 1
                continue
            a = own[own_bar].rank or math.inf
            b = rb[rival_bar].rank or math.inf
            if a == b:
                ties += 1
                continue
            trials.append({"club": club, "metro": metro, "rival_club": rival_club, "own_bar": own_bar, "rival_bar": rival_bar, "own_rank": None if a == math.inf else int(a), "rival_rank": None if b == math.inf else int(b), "correct": a < b})
    k = sum(1 for t in trials if t["correct"])
    summary = binom_summary(k, len(trials))
    # Metro-level sensitivity: one outcome per metro (majority of its trials; even split dropped).
    by_metro: dict[str, list[bool]] = defaultdict(list)
    for t in trials:
        by_metro[t["metro"]].append(t["correct"])
    metro_outcomes = [sum(v) > len(v) / 2 for v in by_metro.values() if sum(v) != len(v) / 2]
    summary.update(
        {
            "source_arm": source,
            "rival_rows_in_source": rival_rows,
            "ties_excluded": ties,
            "shared_bar_excluded": shared,
            "metros": len(by_metro),
            "metro_level": binom_summary(sum(metro_outcomes), len(metro_outcomes)),
            "trials_detail": trials,
        }
    )
    if rival_rows == 0:
        # Without rival rows (bar_club != club) no trial can be formed; say so instead of
        # reporting an empty test as if it had run.
        summary["note"] = f"no rival-bar rows in arm {source}: the Derby Test could not be computed"
    return summary


# ---------------------------------------------------------------------------
# Coverage
# ---------------------------------------------------------------------------


def _read_status(bars_csv: Path) -> list[dict[str, str]]:
    with bars_csv.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def status_crosscheck(bars_csv: Path, rows: list[Row], info: dict, warnings: list[str]) -> None:
    """Compare the bars status file with the arms rows. Counts (never drops) analyzed bars that
    have no own-bar row in any arm (every call for them failed, or the runner skipped them) and
    own-bar rows for bars whose status is not 'analyzed' (an exclusion the runner did not apply)."""
    status = {(r["club"].strip(), r["bar_key"].strip()): (r.get("status") or "").strip() for r in _read_status(bars_csv)}
    own = {(r.club, r.bar_key) for r in rows if r.arm != DERBY_ARM and r.bar_club == r.club}
    analyzed = {k for k, s in status.items() if s == "analyzed"}
    no_rows = sorted(analyzed - own)
    not_analyzed = sorted(k for k in own if status.get(k) != "analyzed")
    info["analyzed_bars_without_any_arm_row"] = len(no_rows)
    info["arm_rows_for_bars_not_analyzed"] = len(not_analyzed)
    if no_rows:
        warnings.append(f"{len(no_rows)} analyzed bars have no row in any arm (failed calls or skipped), e.g. {no_rows[0][0]}/{no_rows[0][1]}")
    if not_analyzed:
        warnings.append(f"{len(not_analyzed)} bars have arm rows but status other than 'analyzed' in the status file, e.g. {not_analyzed[0][0]}/{not_analyzed[0][1]}")


def coverage(bars_csv: Path | None, queries: dict[tuple[str, str], Query]) -> dict:
    if bars_csv is None:
        per_club: dict[str, dict] = defaultdict(lambda: {"queries": 0, "bars": 0})
        for (club, _), q in queries.items():
            per_club[club]["queries"] += 1
            per_club[club]["bars"] += len({b for arm in q.own.values() for b in arm})
        return {"source": "arms CSV only (no --bars file): analyzed rows only", "by_club": dict(per_club)}
    rows = _read_status(bars_csv)
    by_club: dict[str, dict[str, int]] = defaultdict(lambda: {s: 0 for s in STATUS_ORDER})
    for r in rows:
        c = by_club[r["club"]]
        c["listed"] += 1
        st = (r.get("status") or "").strip()
        if st not in STATUS_ORDER or st == "listed":
            raise ValueError(f"unknown bar status {st!r} for {r.get('bar_key')}")
        c[st] += 1
    total = {s: sum(c[s] for c in by_club.values()) for s in STATUS_ORDER}
    out = {"source": str(bars_csv), "by_club": {}, "total": total}
    for club, c in sorted(by_club.items()):
        eligible = c["listed"] - c["stale_page"] - c["no_metro"] - c["no_brand"]
        resolved = eligible - c["unresolved"]
        out["by_club"][club] = dict(c) | {"resolution_rate": round(resolved / eligible, 6) if eligible else None}
    elig_t = total["listed"] - total["stale_page"] - total["no_metro"] - total["no_brand"]
    out["total"]["resolution_rate"] = round((elig_t - total["unresolved"]) / elig_t, 6) if elig_t else None
    return out


# ---------------------------------------------------------------------------
# Main analysis
# ---------------------------------------------------------------------------


def _arm_block(qs: list[Query], arm: str, boot: Bootstrap, bars_filter=None) -> dict:
    present = [q for q in qs if arm in q.own]
    m = per_query_metrics(present, arm, bars_filter)
    return {
        "n_queries": len(present),
        "mrr": round(float(m["rr"].mean()), 6) if len(present) else None,
        "mrr_ci95": boot.ci(m["rr"]),
        "recall_at_10": round(float(m["recall_at_10"].mean()), 6) if len(present) else None,
        "recall_at_10_ci95": boot.ci(m["recall_at_10"]),
        "recall_at_50": round(float(m["recall_at_50"].mean()), 6) if len(present) else None,
        "recall_at_50_ci95": boot.ci(m["recall_at_50"]),
    }


def _paired(qs: list[Query], a: str, b: str, boot: Bootstrap, bars_filter=None) -> dict:
    """Paired comparison over queries; per query, only bars that have a row in both arms
    (and pass bars_filter, if given) count."""
    xs, ys = [], []
    for q in qs:
        if a not in q.own or b not in q.own:
            continue
        common = set(q.own[a]) & set(q.own[b])
        if bars_filter is not None:
            common &= bars_filter(q)
        if not common:
            continue
        xs.append(reciprocal_rank(q.own[a], common))
        ys.append(reciprocal_rank(q.own[b], common))
    x, y = np.array(xs, float), np.array(ys, float)
    n = len(x)
    out = wilcoxon_greater(x, y) if n else {"n_pairs": 0, "n_nonzero": 0, "statistic": None, "p_value": 1.0}
    out["arms"] = [a, b]
    out["mrr_a"] = round(float(x.mean()), 6) if n else None
    out["mrr_b"] = round(float(y.mean()), 6) if n else None
    out["mrr_diff"] = round(float((x - y).mean()), 6) if n else None
    out["mrr_diff_ci95"] = boot.ci(x - y)
    out["confirmatory"] = n >= MIN_PAIRED_QUERIES
    return out


def analyze(rows: list[Row], bars_csv: Path | None = None, seed: int = SEED, resamples: int = RESAMPLES) -> dict:
    warnings: list[str] = []
    info: dict = {}
    qmap = build_queries(rows, warnings, info)
    qs = [qmap[k] for k in sorted(qmap)]
    boot = Bootstrap(seed, resamples)
    if bars_csv is not None:
        status_crosscheck(bars_csv, rows, info, warnings)

    # The sealed hash is reported only together with a check that the plan on disk still has it.
    sealed = PLAN_SHA_FILE.read_text(encoding="utf-8").split()[0] if PLAN_SHA_FILE.exists() else None
    actual = sha256_file(PLAN_FILE) if PLAN_FILE.exists() else None
    plan_matches = sealed is not None and sealed == actual
    if not plan_matches:
        warnings.append(f"p1-plan.md does not match its sealed SHA-256 (sealed {sealed}, file {actual})")

    result: dict = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "plan_sha256": sealed,
        "plan_sha256_matches_file": plan_matches,
        "settings": {"seed": seed, "bootstrap_resamples": resamples, "alpha": ALPHA, "top_k": TOP_K, "min_paired_queries": MIN_PAIRED_QUERIES, "unit": "query = (club, metro)"},
        "coverage": coverage(bars_csv, qmap),
        "arms": {},
        "by_club": {},
        "tests": {},
    }
    for arm in ARMS:
        if any(arm in q.own for q in qs):
            result["arms"][arm] = _arm_block(qs, arm, boot)
    for club in sorted({q.club for q in qs}):
        cq = [q for q in qs if q.club == club]
        result["by_club"][club] = {arm: _arm_block(cq, arm, boot) for arm in ARMS if any(arm in q.own for q in cq)}

    # Fixed-sequence testing: H1 at alpha; H2 only if H1 is rejected.
    h1 = _paired(qs, "Q-signal", "Q-pop", boot)
    h2 = _paired(qs, "Q-signal", "F", boot)
    h1["rejected"] = bool(h1["confirmatory"] and h1["p_value"] < ALPHA)
    h2["tested_in_sequence"] = h1["rejected"]
    h2["rejected"] = bool(h1["rejected"] and h2["confirmatory"] and h2["p_value"] < ALPHA)
    result["tests"] = {"procedure": "fixed-sequence (H1 then H2), each one-sided at alpha = 0.05", "H1": h1, "H2": h2}

    # LLM-unknown subset: queries where arm L named none of the club's bars in that metro.
    if any("L" in q.own for q in qs):
        unknown = [q for q in qs if "L" in q.own and all(r is None for r in q.own["L"].values())]
        known_rate = 1 - len(unknown) / max(1, sum(1 for q in qs if "L" in q.own))
        result["llm_unknown"] = {
            "n_queries": len(unknown),
            "llm_known_rate": round(known_rate, 6),
            "arms": {arm: _arm_block(unknown, arm, boot) for arm in ("Q-signal", "Q-pop", "F") if any(arm in q.own for q in unknown)},
            "H1_exploratory": _paired(unknown, "Q-signal", "Q-pop", boot),
            "H2_exploratory": _paired(unknown, "Q-signal", "F", boot),
        }

    # Sensitivity analyses (reported, never used for the decision).
    sens = {}
    if any(q.roles for q in qs):
        def official_only(q: Query) -> set[str]:
            return {b for b, role in q.roles.items() if role == "official"}

        oq = [q for q in qs if official_only(q)]
        sens["official_bars_only"] = _paired(oq, "Q-signal", "Q-pop", boot, official_only)
    if any(q.via for q in qs):
        def primary_only(q: Query) -> set[str]:
            return {b for b, v in q.via.items() if v == "primary"}

        pq = [q for q in qs if primary_only(q)]
        sens["primary_resolution_only"] = _paired(pq, "Q-signal", "Q-pop", boot, primary_only)
    if sens:
        result["sensitivity"] = sens

    result["derby"] = derby(rows)

    h1_ok = h1["rejected"]
    result["decision"] = {
        "h1_supported": h1_ok,
        "h2_supported": h2["rejected"],
        "partner_card_banner": None if h1_ok else BANNER_H1_NOT_SUPPORTED,
        "status": "confirmatory" if h1["confirmatory"] else f"inconclusive: fewer than {MIN_PAIRED_QUERIES} paired queries",
    }
    result["info"] = info
    result["warnings"] = warnings
    return result


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _fmt(v, nd=3) -> str:
    if v is None:
        return "n/a"
    if isinstance(v, list):
        return f"[{_fmt(v[0], nd)}, {_fmt(v[1], nd)}]"
    if isinstance(v, float):
        return f"{v:.{nd}f}"
    return str(v)


def _p(v) -> str:
    if v is None:
        return "n/a"
    return f"{v:.4f}" if v >= 0.0001 else f"{v:.2e}"


def render_md(res: dict) -> str:
    L: list[str] = ["# P1 Fan-Bar Test: results", ""]
    plan_check = "matches the plan file" if res.get("plan_sha256_matches_file") else "DOES NOT match the plan file on disk"
    L.append(f"Generated {res['generated_at']}. Plan SHA-256: `{res['plan_sha256'] or 'not found'}` ({plan_check}). Unit of analysis: {res['settings']['unit']}.")
    L += ["", "## 1. Coverage (reported before any result)", ""]
    cov = res["coverage"]
    if "total" in cov:
        cols = STATUS_ORDER + ["resolution_rate"]
        L.append("| club | " + " | ".join(cols) + " |")
        L.append("|" + "---|" * (len(cols) + 1))
        for club, c in cov["by_club"].items():
            L.append(f"| {club} | " + " | ".join(_fmt(c.get(s)) for s in cols) + " |")
        L.append("| **total** | " + " | ".join(_fmt(cov["total"].get(s)) for s in cols) + " |")
    else:
        L.append(f"_{cov['source']}_")
        L.append("")
        L.append("| club | queries | bars |")
        L.append("|---|---|---|")
        for club, c in cov["by_club"].items():
            L.append(f"| {club} | {c['queries']} | {c['bars']} |")
    L += ["", "## 2. Arms (all queries)", "", "| arm | n queries | MRR [95% CI] | recall@10 [95% CI] | recall@50 [95% CI] |", "|---|---|---|---|---|"]
    for arm, a in res["arms"].items():
        L.append(f"| {arm} | {a['n_queries']} | {_fmt(a['mrr'])} {_fmt(a['mrr_ci95'])} | {_fmt(a['recall_at_10'])} {_fmt(a['recall_at_10_ci95'])} | {_fmt(a['recall_at_50'])} {_fmt(a['recall_at_50_ci95'])} |")
    if "L" in res["arms"]:
        L += ["", "Arm L names at most 3 bars and is a contamination measure, not a ranking to compare with the others."]
    L += ["", "## 3. Preregistered tests", "", f"Procedure: {res['tests']['procedure']}.", "", "| test | arms | n pairs | n nonzero | MRR diff [95% CI] | Wilcoxon p (one-sided) | confirmatory | rejected |", "|---|---|---|---|---|---|---|---|"]
    for name in ("H1", "H2"):
        t = res["tests"][name]
        note = " (exploratory: H1 not rejected)" if name == "H2" and not t.get("tested_in_sequence") else ""
        L.append(f"| {name} | {t['arms'][0]} > {t['arms'][1]} | {t['n_pairs']} | {t['n_nonzero']} | {_fmt(t['mrr_diff'])} {_fmt(t['mrr_diff_ci95'])} | {_p(t['p_value'])} | {t['confirmatory']} | {t['rejected']}{note} |")
    d = res["decision"]
    L += ["", f"**Decision:** {d['status']}. H1 supported: **{d['h1_supported']}**. H2 supported: **{d['h2_supported']}**."]
    if d["partner_card_banner"]:
        L.append(f"Partner cards carry the banner: \"{d['partner_card_banner']}\"")
    if "llm_unknown" in res:
        u = res["llm_unknown"]
        L += ["", "## 4. LLM-unknown subset (exploratory)", "", f"Queries where arm L did not name the bar: {u['n_queries']} (L named it in {_fmt(u['llm_known_rate'])} of queries).", "", "| arm | n | MRR [95% CI] |", "|---|---|---|"]
        for arm, a in u["arms"].items():
            L.append(f"| {arm} | {a['n_queries']} | {_fmt(a['mrr'])} {_fmt(a['mrr_ci95'])} |")
        L.append(f"\nExploratory Q-signal > Q-pop: p = {_p(u['H1_exploratory']['p_value'])}; Q-signal > F: p = {_p(u['H2_exploratory']['p_value'])}.")
    dz = res["derby"]
    L += ["", "## 5. Derby Test (secondary)", "", f"Source arm: {dz['source_arm']}. Trials: {dz['trials']}; metros with a trial: {dz['metros']}; ties excluded: {dz['ties_excluded']}; shared bars excluded: {dz['shared_bar_excluded']}.", f"Pairwise accuracy: {_fmt(dz['accuracy'])}, exact 95% CI {_fmt(dz['ci95_exact'])}, one-sided binomial p vs 0.5 = {_p(dz['p_one_sided_greater'])}.", f"Metro-level (one outcome per metro): {dz['metro_level']['correct']}/{dz['metro_level']['trials']}, exact 95% CI {_fmt(dz['metro_level']['ci95_exact'])}."]
    if dz.get("note"):
        L.append(f"Note: {dz['note']}.")
    if res.get("sensitivity"):
        L += ["", "## 6. Sensitivity (reported, not used for the decision)", ""]
        for name, t in res["sensitivity"].items():
            L.append(f"- {name}: n = {t['n_pairs']}, MRR diff {_fmt(t['mrr_diff'])} {_fmt(t['mrr_diff_ci95'])}, p = {_p(t['p_value'])}")
    L += ["", "## By club", "", "| club | arm | n | MRR [95% CI] |", "|---|---|---|---|"]
    for club, arms in res["by_club"].items():
        for arm, a in arms.items():
            L.append(f"| {club} | {arm} | {a['n_queries']} | {_fmt(a['mrr'])} {_fmt(a['mrr_ci95'])} |")
    L += ["", "## What this does not establish", "", "- That fans would choose these bars if no bar were designated (affinity is a current snapshot).", "- Anything about ticket sales or any individual.", "- Performance outside the three clubs and US metros tested."]
    if res["warnings"]:
        L += ["", f"## Warnings ({len(res['warnings'])})", ""] + [f"- {w}" for w in res["warnings"][:200]]
    return "\n".join(L) + "\n"


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="P1 Fan-Bar Test analysis")
    ap.add_argument("--arms", required=True, type=Path)
    ap.add_argument("--bars", type=Path, default=None)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "out")
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--resamples", type=int, default=RESAMPLES)
    args = ap.parse_args(argv)

    rows = load_rows(args.arms)
    res = analyze(rows, args.bars, seed=args.seed, resamples=args.resamples)
    res["inputs"] = {"arms_csv_sha256": sha256_file(args.arms), "bars_csv_sha256": sha256_file(args.bars) if args.bars else None}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "p1_results.json").write_text(json.dumps(res, indent=2), encoding="utf-8", newline="\n")
    (args.out / "p1_results.md").write_text(render_md(res), encoding="utf-8", newline="\n")
    print(f"wrote {args.out / 'p1_results.json'} and {args.out / 'p1_results.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
