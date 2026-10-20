"""Write the public P1 artefacts from the private table.

Reads  data/private/p1/bars_full.csv (+ collect_report.json, centroid_report.json)
Writes data/p1/sample_20.csv   20 rows with source links (stratified by club, fixed seed)
       data/p1/summary.json    counts per club, coverage, failures; no bar names beyond the sample

The full table is never written to a public path.

Usage: python evals/p1/publish_sample.py
"""

from __future__ import annotations

import json
import random
import re
import sys
from collections import Counter, defaultdict
from itertools import combinations
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BARS_FULL, CLUB_LABELS, PRIVATE_DIR, PUBLIC_DIR, read_csv, write_csv  # noqa: E402
from matching import name_similarity  # noqa: E402

SAMPLE_SEED = 20261013
SAMPLE_PER_CLUB = {"american_outlaws": 7, "arsenal_america": 7, "lfc_olsc": 6}
SAMPLE_COLUMNS = ["club", "chapter", "city", "state", "bar_name", "address", "listing_role", "source_url", "fetched_at", "page_last_updated"]


def sample_rows(rows: list[dict], seed: int = SAMPLE_SEED) -> list[dict]:
    rng = random.Random(seed)
    out = []
    for club, k in SAMPLE_PER_CLUB.items():
        pool = sorted((r for r in rows if r["club"] == club and r.get("address")), key=lambda r: r["bar_key"])
        out += rng.sample(pool, min(k, len(pool)))
    return out


def shared_bars(rows: list[dict]) -> list[tuple[str, str, str]]:
    """Bars listed by two clubs in the same metro (name similarity >= 0.85)."""
    by_metro: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if r.get("metro_geoid"):
            by_metro[r["metro_geoid"]].append(r)
    found = []
    for metro, rs in by_metro.items():
        for a, b in combinations(rs, 2):
            if a["club"] != b["club"] and name_similarity(a["bar_name"], b["bar_name"]) >= 0.85:
                found.append((metro, a["club"], b["club"]))
    return found


def summarize(rows: list[dict]) -> dict:
    clubs = sorted({r["club"] for r in rows})
    per_club = {}
    for c in clubs:
        rs = [r for r in rows if r["club"] == c]
        per_club[c] = {
            "label": CLUB_LABELS.get(c, c),
            "rows": len(rs),
            "chapters": len({r["chapter"] for r in rs}),
            "listing_role": dict(Counter(r["listing_role"] for r in rs)),
            "with_street_number": sum(1 for r in rs if re.match(r"^\s*\d", r["address"] or "")),
            "metro_point": dict(Counter(r.get("metro_source", "") for r in rs)),
            "distinct_metros": len({r["metro_geoid"] for r in rs if r.get("metro_geoid")}),
            "page_last_updated": sorted({r["page_last_updated"] for r in rs if r["page_last_updated"]}) or None,
            "fetched": [min(r["fetched_at"] for r in rs), max(r["fetched_at"] for r in rs)],
        }
        if c == "american_outlaws":
            per_club[c]["chapter_status"] = dict(Counter(r["chapter_status"] for r in rs))
    metro_clubs: dict[str, set[str]] = defaultdict(set)
    for r in rows:
        if r.get("metro_geoid"):
            metro_clubs[r["metro_geoid"]].add(r["club"])
    multi = {m: cs for m, cs in metro_clubs.items() if len(cs) >= 2}
    pair_counts = Counter(" + ".join(sorted(cs)) for cs in multi.values())
    return {
        "rows": len(rows),
        "per_club": per_club,
        "metros_total": len(metro_clubs),
        "metros_with_two_or_more_clubs": len(multi),
        "metros_by_club_combination": dict(pair_counts),
        "derby_ordered_trials_upper_bound": sum(len(cs) * (len(cs) - 1) for cs in multi.values()),
        "bars_shared_by_two_clubs_same_metro": len(shared_bars(rows)),
    }


def main() -> int:
    rows = read_csv(BARS_FULL)
    sample = sample_rows(rows)
    write_csv(PUBLIC_DIR / "sample_20.csv", sample, SAMPLE_COLUMNS)
    summary = summarize(rows)
    for name in ("collect_report.json", "centroid_report.json"):
        p = PRIVATE_DIR / name
        if p.exists():
            rep = json.loads(p.read_text(encoding="utf-8"))
            if name == "collect_report.json":
                summary["collection"] = {
                    k: {kk: vv for kk, vv in v.items() if kk in ("index_url", "final_url", "chapter_pages", "chapters_without_listed_location", "locations_parsed", "branches", "items_on_page", "items_with_us_rows", "rows", "notes", "failures", "extraction")}
                    for k, v in rep.items()
                    if isinstance(v, dict)
                }
                summary["collection"]["dropped_outside_us"] = len(rep.get("dropped_non_us_or_unknown_state", []))
                summary["collection"]["last_pipeline_run"] = [rep.get("started_at"), rep.get("finished_at")]
            else:
                summary["centroids"] = {k: rep[k] for k in ("gazetteer_year", "sources", "counts", "distinct_metros")}
                summary["centroids"]["misses"] = len(rep.get("misses", []))
    (PUBLIC_DIR / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
