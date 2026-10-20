"""Attach a metro point (Census Gazetteer internal point) to every P1 row.

Source: U.S. Census Bureau Gazetteer files (public domain), places file, with the county
subdivisions file as a fallback for New England / New Jersey style townships that are not
Census places. Files are downloaded once into data/private/p1/cache/ (polite fetcher).

Matching rule (also stated in docs/preregistration/p1-plan.md):
  1. apply data/p1/place_aliases.csv (neighbourhood or regional label -> containing place);
  2. exact match of the normalized city name to a normalized Gazetteer place name in the same
     state (the one trailing legal/statistical descriptor such as "city", "town", "CDP" and
     "(balance)" removed from the Gazetteer name; "St." -> "saint", "Ft." -> "fort");
     ties go to an active government (FUNCSTAT A) over a CDP, then the larger land area;
  3. for consolidated governments ("Nashville-Davidson metropolitan government (balance)"),
     the part before "-" or "/" is also a key, used only when (2) finds nothing;
  4. otherwise the county subdivisions file, same normalization;
  5. otherwise the row is a miss (kept in the table, no metro point, counted in the report).

Columns added to data/private/p1/bars_full.csv:
  metro_geoid, metro_name, metro_state, metro_lat, metro_lon, metro_source (place|cousub|miss),
  metro_via (direct|alias|consolidated)

Usage: python evals/p1/centroids.py [--year 2026]
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import BAR_COLUMNS, BARS_FULL, CACHE_DIR, PRIVATE_DIR, PUBLIC_DIR, PoliteFetcher, read_csv, write_csv  # noqa: E402

GAZ_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/{y}_Gazetteer/{y}_Gaz_{kind}_national.zip"
ALIASES = PUBLIC_DIR / "place_aliases.csv"
METRO_COLUMNS = ["metro_geoid", "metro_name", "metro_state", "metro_lat", "metro_lon", "metro_source", "metro_via"]

_SUFFIXES = [
    "metropolitan government",
    "metro government",
    "consolidated government",
    "unified government",
    "urban county",
    "city and borough",
    "municipality",
    "borough",
    "village",
    "township",
    "charter township",
    "plantation",
    "city",
    "town",
    "cdp",
    "ccd",
    "comunidad",
    "zona urbana",
]
_CONSOLIDATED = re.compile(r"metropolitan government|metro government|consolidated government|unified government|urban county", re.I)


def norm_city(s: str) -> str:
    s = (s or "").casefold().strip()
    s = re.sub(r"\(balance\)", "", s)
    s = re.sub(r"\bst\.?\s+", "saint ", s)
    s = re.sub(r"\bste\.?\s+", "sainte ", s)
    s = re.sub(r"\bft\.?\s+", "fort ", s)
    s = re.sub(r"\bmt\.?\s+", "mount ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def strip_suffix(name: str) -> str:
    """Remove the one trailing legal/statistical descriptor of a Gazetteer NAME ("Durham city")."""
    n = norm_city(name)
    for suf in sorted(_SUFFIXES, key=len, reverse=True):
        if n.endswith(" " + suf):
            return n[: -len(suf) - 1].strip()
    return n


def metro_display_name(gazetteer_name: str) -> str:
    """Human name of a metro for prompts: the Gazetteer NAME without " (balance)", without its one
    trailing legal descriptor, and, for consolidated governments, only the part before "-" or "/".
    "Nashville-Davidson metropolitan government (balance)" -> "Nashville"; "Durham city" -> "Durham"."""
    name = re.sub(r"\s*\(balance\)\s*$", "", (gazetteer_name or "").strip())
    if _CONSOLIDATED.search(name):
        name = re.split(r"[-/]", name, maxsplit=1)[0]
    low = name.casefold()
    for suf in sorted(_SUFFIXES, key=len, reverse=True):
        if low.endswith(" " + suf):
            return name[: -len(suf) - 1].strip()
    return name.strip()


def load_gazetteer(raw: bytes) -> list[dict]:
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        name = next(n for n in zf.namelist() if n.endswith(".txt"))
        text = zf.read(name).decode("latin-1")
    rows = []
    header = text.split("\n", 1)[0]
    delim = "|" if "|" in header else "\t"  # 2026 files are pipe-delimited, earlier years tab
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)
    reader.fieldnames = [f.strip() for f in reader.fieldnames or []]
    for r in reader:
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        rows.append(r)
    return rows


def build_index(records: list[dict]) -> tuple[dict, dict]:
    """(direct index, consolidated-part index), both keyed by (state, normalized name)."""
    direct: dict[tuple[str, str], list[dict]] = {}
    consolidated: dict[tuple[str, str], list[dict]] = {}
    for r in records:
        st = r.get("USPS", "")
        name = r.get("NAME", "")
        direct.setdefault((st, strip_suffix(name)), []).append(r)
        if _CONSOLIDATED.search(name):
            first = re.split(r"[-/]", name, maxsplit=1)[0]
            consolidated.setdefault((st, strip_suffix(first)), []).append(r)
    return direct, consolidated


def pick(cands: list[dict]) -> dict:
    def key(r: dict):
        active = 0 if r.get("FUNCSTAT") == "A" else 1
        try:
            land = -float(r.get("ALAND", "0") or 0)
        except ValueError:
            land = 0.0
        return (active, land)

    return sorted(cands, key=key)[0]


def load_aliases(path: Path = ALIASES) -> dict[tuple[str, str], tuple[str, str]]:
    if not path.exists():
        return {}
    out = {}
    for r in read_csv(path):
        out[(r["state"].strip().upper(), norm_city(r["city"]))] = (r["alias_city"].strip(), r["alias_state"].strip().upper())
    return out


def match_city(city: str, state: str, places: tuple[dict, dict], cousubs: tuple[dict, dict], aliases: dict) -> dict:
    via = "direct"
    key = (state.upper(), norm_city(city))
    if key in aliases:
        city, state = aliases[key]
        via = "alias"
    k = (state.upper(), norm_city(city))
    p_direct, p_cons = places
    c_direct, _ = cousubs
    for source, idx, how in (("place", p_direct, via), ("place", p_cons, "consolidated"), ("cousub", c_direct, via)):
        if k in idx:
            r = pick(idx[k])
            return {
                "metro_geoid": r.get("GEOID", ""),
                "metro_name": r.get("NAME", ""),
                "metro_state": r.get("USPS", ""),
                "metro_lat": r.get("INTPTLAT", ""),
                "metro_lon": r.get("INTPTLONG", ""),
                "metro_source": source,
                "metro_via": how,
            }
    return {c: "" for c in METRO_COLUMNS} | {"metro_source": "miss", "metro_via": via}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Attach Census Gazetteer metro points to bars_full.csv")
    ap.add_argument("--year", default="2026")
    args = ap.parse_args(argv)

    fetcher = PoliteFetcher()
    raw = {}
    for kind in ("place", "cousubs"):
        url = GAZ_URL.format(y=args.year, kind=kind)
        res = fetcher.get(url, binary_path=CACHE_DIR / "census" / Path(url).name)
        if res.status != 200:
            print(f"failed to fetch {url}: {res.status} {res.error}", file=sys.stderr)
            return 2
        raw[kind] = res.body
    places = build_index(load_gazetteer(raw["place"]))
    cousubs = build_index(load_gazetteer(raw["cousubs"]))
    aliases = load_aliases()

    rows = read_csv(BARS_FULL)
    misses = []
    counts = {"place": 0, "cousub": 0, "miss": 0, "alias": 0, "consolidated": 0}
    for r in rows:
        m = match_city(r["city"], r["state"], places, cousubs, aliases)
        r.update(m)
        counts[m["metro_source"]] += 1
        if m["metro_via"] in ("alias", "consolidated") and m["metro_source"] != "miss":
            counts[m["metro_via"]] += 1
        if m["metro_source"] == "miss":
            misses.append({"club": r["club"], "chapter": r["chapter"], "city": r["city"], "state": r["state"]})
    write_csv(BARS_FULL, rows, BAR_COLUMNS + METRO_COLUMNS)
    report = {
        "gazetteer_year": args.year,
        "sources": [GAZ_URL.format(y=args.year, kind=k) for k in ("place", "cousubs")],
        "rows": len(rows),
        "counts": counts,
        "distinct_metros": len({r["metro_geoid"] for r in rows if r["metro_geoid"]}),
        "misses": misses,
    }
    (PRIVATE_DIR / "centroid_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8", newline="\n")
    print(json.dumps({k: v for k, v in report.items() if k != "misses"}, indent=2))
    print(f"misses: {len(misses)}")
    for m in misses:
        print("  ", m)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
