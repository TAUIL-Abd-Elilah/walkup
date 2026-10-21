#!/usr/bin/env python3
"""Build the ZIP and area-name table that @walkup/gazetteer reads without touching the disk.

Inputs (all in data/gazetteer, all tracked, no network):

  zip_places.csv   one row per ZCTA in out/<metro>.json: the place name people use for the ZIP
                   (the USPS city name, or the town or neighbourhood people say where USPS files it
                   under a big neighbour, noted as "USPS: ..."), and its kind:
                     residential   homes; counted and named
                     unique        one organisation or building (federal offices, a hospital, an airport)
                     military      a base; not open to a street team
                     campus        a university's own ZIP
  areas.json       per metro: the ZIP cities named by neighbourhood (Washington, Nashville, ...) and
                   well-known districts with a centre and a radius ("H Street NE", "U Street / Shaw")
  out/<metro>.json the built gazetteer: ACS adults 21+ per ZCTA. A ZCTA with fewer than
                   MIN_RESIDENTIAL_ADULTS adults is treated as non-residential too.

Output: packages/gazetteer/src/zip-data.ts (generated; do not edit by hand).

  python -I data/gazetteer/zips.py           # write the module
  python -I data/gazetteer/zips.py --check   # exit 1 when the module is out of date or a ZCTA has no row
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT_DIR = HERE / "out"
ZIP_CSV = HERE / "zip_places.csv"
AREAS_JSON = HERE / "areas.json"
TS_OUT = ROOT / "packages" / "gazetteer" / "src" / "zip-data.ts"

KINDS = ("residential", "unique", "military", "campus")
MIN_RESIDENTIAL_ADULTS = 250


def read_zip_places(path: Path = ZIP_CSV) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    with open(path, encoding="utf8", newline="") as f:
        for i, row in enumerate(csv.DictReader(f), start=2):
            z = (row.get("zip") or "").strip()
            city = (row.get("city") or "").strip()
            kind = (row.get("kind") or "residential").strip() or "residential"
            if len(z) != 5 or not z.isdigit():
                raise ValueError(f"{path.name}:{i}: bad zip {z!r}")
            if not city:
                raise ValueError(f"{path.name}:{i}: zip {z} has no city")
            if kind not in KINDS:
                raise ValueError(f"{path.name}:{i}: zip {z} has unknown kind {kind!r}")
            if z in rows:
                raise ValueError(f"{path.name}:{i}: zip {z} listed twice")
            rows[z] = {"city": city, "kind": kind, "note": (row.get("note") or "").strip()}
    return rows


def read_areas(path: Path = AREAS_JSON) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf8"))
    metros = raw.get("metros")
    if not isinstance(metros, dict):
        raise ValueError(f"{path.name}: no metros")
    for name, m in metros.items():
        for a in m.get("known", []):
            if not a.get("name") or not isinstance(a.get("lat"), (int, float)) or not isinstance(a.get("lon"), (int, float)):
                raise ValueError(f"{path.name}: {name}: bad known area {a!r}")
            if not (0 < float(a.get("radiusKm", 0)) <= 5):
                raise ValueError(f"{path.name}: {name}: {a['name']}: radiusKm must be in (0, 5]")
    return metros


def read_metros(out_dir: Path = OUT_DIR) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for p in sorted(out_dir.glob("*.json")):
        if p.name == "manifest.json":
            continue
        out[p.stem] = json.loads(p.read_text(encoding="utf8"))
    return out


def low_adult_zips(metros: dict[str, dict[str, Any]], floor: int = MIN_RESIDENTIAL_ADULTS) -> list[str]:
    """ZCTAs whose ACS adults 21+ is known and below the floor (offices, campuses, a few houses)."""
    low: set[str] = set()
    for g in metros.values():
        for z in g.get("zctas", []):
            a = z.get("adults21")
            if isinstance(a, (int, float)) and a < floor:
                low.add(str(z["zcta"]))
    return sorted(low)


def coverage_problems(places: dict[str, dict[str, str]], metros: dict[str, dict[str, Any]], areas: dict[str, Any]) -> list[str]:
    problems: list[str] = []
    for name, g in metros.items():
        for z in g.get("zctas", []):
            if str(z["zcta"]) not in places:
                problems.append(f"{name}: ZCTA {z['zcta']} has no row in {ZIP_CSV.name}")
        box = g.get("bbox") or {}
        for a in (areas.get(name) or {}).get("known", []):
            if box and not (box["south"] <= a["lat"] <= box["north"] and box["west"] <= a["lon"] <= box["east"]):
                problems.append(f"{name}: known area {a['name']} is outside the metro box")
    return problems


def ts_string(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def render_ts(places: dict[str, dict[str, str]], low: list[str], areas: dict[str, Any]) -> str:
    lines: list[str] = [
        "/**",
        " * Generated by data/gazetteer/zips.py from data/gazetteer/zip_places.csv, areas.json and out/*.json.",
        " * Do not edit by hand: change the inputs and run `python -I data/gazetteer/zips.py`.",
        " */",
        "",
        'export type ZipKind = "residential" | "unique" | "military" | "campus";',
        "",
        "export interface KnownAreaRecord {",
        "  metro: string;",
        "  name: string;",
        "  lat: number;",
        "  lon: number;",
        "  radiusKm: number;",
        "}",
        "",
        "/** A ZCTA with fewer ACS adults 21+ than this is not counted as homes. */",
        f"export const MIN_RESIDENTIAL_ADULTS = {MIN_RESIDENTIAL_ADULTS};",
        "",
        "/** ZIP -> [the place name people use, kind]. */",
        "export const ZIP_PLACES: Readonly<Record<string, readonly [string, ZipKind]>> = {",
    ]
    for z in sorted(places):
        r = places[z]
        lines.append(f'  "{z}": [{ts_string(r["city"])}, "{r["kind"]}"],')
    lines.append("};")
    lines.append("")
    lines.append(f"/** ZCTAs in the built gazetteer with fewer than {MIN_RESIDENTIAL_ADULTS} ACS adults 21+. */")
    lines.append("export const LOW_ADULT_ZIPS: readonly string[] = [")
    for i in range(0, len(low), 12):
        lines.append("  " + ", ".join(f'"{z}"' for z in low[i : i + 12]) + ",")
    lines.append("];")
    lines.append("")
    lines.append("/** Per metro: ZIP cities named by neighbourhood rather than by the city. */")
    lines.append("export const NEIGHBOURHOOD_CITIES: Readonly<Record<string, readonly string[]>> = {")
    for name in sorted(areas):
        cities = areas[name].get("neighbourhoodCities", [])
        lines.append(f"  {name}: [{', '.join(ts_string(c) for c in cities)}],")
    lines.append("};")
    lines.append("")
    lines.append("/** Well-known districts: a lift area within `radiusKm` of one takes the nearest such name. */")
    lines.append("export const KNOWN_AREAS: readonly KnownAreaRecord[] = [")
    for name in sorted(areas):
        for a in areas[name].get("known", []):
            lines.append(
                f'  {{ metro: "{name}", name: {ts_string(a["name"])}, lat: {float(a["lat"])}, lon: {float(a["lon"])}, radiusKm: {float(a["radiusKm"])} }},'
            )
    lines.append("];")
    lines.append("")
    return "\n".join(lines)


def build(check: bool = False) -> int:
    places = read_zip_places()
    areas = read_areas()
    metros = read_metros()
    problems = coverage_problems(places, metros, areas)
    text = render_ts(places, low_adult_zips(metros), areas)
    if check:
        current = TS_OUT.read_text(encoding="utf8") if TS_OUT.exists() else ""
        if current != text:
            problems.append(f"{TS_OUT.relative_to(ROOT)} is out of date: run python -I data/gazetteer/zips.py")
    else:
        TS_OUT.write_text(text, encoding="utf8", newline="\n")
        print(f"{len(places)} ZIPs, {sum(len(a.get('known', [])) for a in areas.values())} known areas -> {TS_OUT.relative_to(ROOT)}")
    for p in problems:
        print(p, file=sys.stderr)
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="verify only; write nothing")
    args = ap.parse_args(argv)
    return build(check=args.check)


if __name__ == "__main__":
    sys.exit(main())
