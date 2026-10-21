#!/usr/bin/env python3
"""Build the Walkup gazetteer: names for lift tiles and ACS adults per ZCTA.

For each metro below this script writes data/gazetteer/out/<metro>.json with

  * neighbourhoods  OSM place=neighbourhood|suburb|quarter (Overpass, one query per metro)
  * places          Census Gazetteer national place file, filtered to the metro box
  * zctas           Census Gazetteer national ZCTA file, filtered to the metro box,
                    joined to ACS 5-year estimates (population, adults 21+, median age,
                    median household income)

and data/gazetteer/out/manifest.json with per-source status for every metro.

Sources are fetched politely: one request at a time, a descriptive User-Agent, a pause
between requests, and every download is cached under data/private/gazetteer_cache/
(git-ignored) so a re-run does not touch the network unless --refresh is passed.

ACS variables (documented here and in data/gazetteer/README.md):

  totalPop      B01003_001E  Total population
  medianAge     B01002_001E  Median age, total
  medianIncome  B19013_001E  Median household income in the past 12 months
                             (inflation-adjusted dollars of the ACS end year)
  adults21      B01001_001E minus the under-21 bins of B01001 (Sex by Age):
                  male   B01001_003E..B01001_008E  (under 5, 5-9, 10-14, 15-17, 18-19, 20)
                  female B01001_027E..B01001_032E  (same bins)

ACS access order: the Census Data API (https://api.census.gov/data/<year>/acs/acs5) for
2024 then 2023, using CENSUS_API_KEY from the environment when it is set; if the API
refuses (it now redirects keyless calls to a missing-key page), the ACS table-based
Summary File for the same vintage on www2.census.gov (no key) is streamed instead and
only the ZCTA rows are kept. Whatever happened is recorded in each output's `sources`.

Usage (from the repo root):

  python -I data/gazetteer/build.py                  # all metros, use cache when present
  python -I data/gazetteer/build.py --metro tacoma   # one metro
  python -I data/gazetteer/build.py --refresh        # ignore the cache, fetch again
  python -I data/gazetteer/build.py --offline        # cache only; fail sources not cached

Requires Python 3.11 and `requests`.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import re
import sys
import time
import unicodedata
import zipfile
from pathlib import Path
from typing import Any, Callable, Iterable

import requests

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT_DIR = HERE / "out"
CACHE_DIR = ROOT / "data" / "private" / "gazetteer_cache"

USER_AGENT = (
    "walkup-gazetteer-build/0.1 "
    "(offline gazetteer for an open-source show-planning tool; "
    "low volume, one request at a time, cached)"
)

GAZETTEER_BASE = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer"
GAZETTEER_YEARS = (2025, 2024)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
ACS_API_BASE = "https://api.census.gov/data/{year}/acs/acs5"
ACS_SF_BASE = (
    "https://www2.census.gov/programs-surveys/acs/summary_file/{year}/"
    "table-based-SF/data/5YRData/acsdt5y{year}-{table}.dat"
)
ACS_YEARS = (2024, 2023)

PAUSE_S = 1.5  # pause between any two network requests
OVERPASS_PAUSE_S = 6.0  # extra pause between Overpass queries
COORD_DP = 4  # ~11 m; enough to name a geohash-6 tile

ATTRIBUTION = {
    "osm": "© OpenStreetMap contributors, ODbL",
    "census": "U.S. Census Bureau, public domain",
}


def km_box(lat: float, lon: float, half_ns_km: float, half_ew_km: float) -> dict[str, float]:
    """A lat/lon box around a centre, sized in kilometres."""
    dlat = half_ns_km / 111.32
    dlon = half_ew_km / (111.32 * math.cos(math.radians(lat)))
    return {
        "south": round(lat - dlat, 4),
        "west": round(lon - dlon, 4),
        "north": round(lat + dlat, 4),
        "east": round(lon + dlon, 4),
    }


# Boxes are deliberately explicit so they can be audited. Points outside a box are not
# covered: the TS library reports distances so a caller can tell a far match from a
# near one. Widen a box here and re-run if a lift radius needs more room.
METROS: dict[str, dict[str, Any]] = {
    "nashville": {
        "label": "Nashville, TN: Davidson County and the inner ring",
        "center": {"lat": 36.1627, "lon": -86.7816},
        "cities": ["Nashville"],
        # ~64 km x 64 km around downtown: Davidson plus Brentwood, Franklin, Smyrna,
        # La Vergne, Mt. Juliet, Hendersonville, Goodlettsville, Gallatin's west edge.
        "bbox": km_box(36.1627, -86.7816, 32.0, 32.0),
    },
    "hampton_roads": {
        "label": "Hampton Roads, VA: Hampton, Newport News, Norfolk, Portsmouth, Virginia Beach, Chesapeake",
        "center": {"lat": 36.9, "lon": -76.3},
        "cities": ["Hampton", "Newport News", "Norfolk", "Portsmouth", "Virginia Beach", "Chesapeake"],
        # The six cities in full, south to the NC line (~77 km x 68 km).
        "bbox": {"south": 36.54, "west": -76.62, "north": 37.23, "east": -75.86},
    },
    "dc": {
        "label": "Washington, DC: the District and the inner Maryland and Virginia suburbs",
        "center": {"lat": 38.8801, "lon": -77.0262},
        "cities": ["Washington", "Arlington", "Alexandria", "Bethesda", "Silver Spring"],
        # ~80 km x 80 km around The Anthem (the live hero room), so a 40 km lift radius stays
        # inside: Fairfax, Reston, Rockville, Laurel, Bowie and Upper Marlboro at the edges.
        "bbox": km_box(38.8801, -77.0262, 40.0, 40.0),
    },
    "tacoma": {
        "label": "Tacoma, WA: Tacoma, Pierce County core and south Seattle",
        "center": {"lat": 47.2529, "lon": -122.4443},
        "cities": ["Tacoma", "Seattle"],
        # ~70 km north-south from Spanaway/Graham to downtown Seattle, ~50 km wide
        # from Gig Harbor/Port Orchard to Auburn/Bonney Lake.
        "bbox": {"south": 46.99, "west": -122.78, "north": 47.62, "east": -122.12},
    },
}

B01001_UNDER21 = [f"B01001_{i:03d}E" for i in range(3, 9)] + [f"B01001_{i:03d}E" for i in range(27, 33)]
ACS_API_VARS = ["B01003_001E", "B01002_001E", "B19013_001E", "B01001_001E", *B01001_UNDER21]
# Summary File tables and the columns kept from each (SF names: B01001_E001 style).
ACS_SF_TABLES: dict[str, list[str]] = {
    "b01003": ["B01003_E001"],
    "b01002": ["B01002_E001"],
    "b19013": ["B19013_E001"],
    "b01001": ["B01001_E001"]
    + [f"B01001_E{i:03d}" for i in range(3, 9)]
    + [f"B01001_E{i:03d}" for i in range(27, 33)],
}
ZCTA_GEO_PREFIX = "860Z200US"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class Fetcher:
    """One request at a time, with a pause between requests and a shared session."""

    def __init__(self, offline: bool) -> None:
        self.offline = offline
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self._last = 0.0

    def _wait(self, pause: float) -> None:
        gap = time.monotonic() - self._last
        if gap < pause:
            time.sleep(pause - gap)

    def request(self, method: str, url: str, *, pause: float = PAUSE_S, **kw: Any) -> requests.Response:
        if self.offline:
            raise RuntimeError(f"offline mode: not fetching {url}")
        self._wait(pause)
        try:
            return self.session.request(method, url, **kw)
        finally:
            self._last = time.monotonic()


def log(msg: str) -> None:
    print(msg, flush=True)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------------------
# Census Gazetteer (places, ZCTAs)
# ---------------------------------------------------------------------------


def fetch_gazetteer_zip(f: Fetcher, kind: str, refresh: bool) -> tuple[Path, dict[str, Any]]:
    """Download (or reuse) the national Gazetteer zip for `kind` ("place" or "zcta")."""
    errors: list[str] = []
    for year in GAZETTEER_YEARS:
        name = f"{year}_Gaz_{kind}_national.zip"
        path = CACHE_DIR / name
        url = f"{GAZETTEER_BASE}/{year}_Gazetteer/{name}"
        if path.exists() and not refresh:
            return path, {"status": "ok", "vintage": year, "url": url, "cache": "hit"}
        try:
            r = f.request("GET", url, timeout=(20, 180))
        except Exception as e:  # network errors are recorded, then the next vintage is tried
            errors.append(f"{year}: {type(e).__name__}: {e}")
            continue
        if r.status_code != 200 or not r.content.startswith(b"PK"):
            errors.append(f"{year}: HTTP {r.status_code}")
            continue
        path.write_bytes(r.content)
        log(f"  downloaded {name} ({len(r.content) // 1024} KB)")
        return path, {"status": "ok", "vintage": year, "url": url, "cache": "miss"}
    raise RuntimeError(f"Gazetteer {kind} unavailable: " + "; ".join(errors))


def read_gazetteer(path: Path) -> list[dict[str, str]]:
    with zipfile.ZipFile(path) as zf:
        members = [m for m in zf.namelist() if m.lower().endswith(".txt")]
        if not members:
            raise RuntimeError(f"{path.name}: no .txt member")
        raw = zf.read(members[0])
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    # 2025 files are pipe-delimited; earlier vintages are tab-delimited.
    first_line = text.split("\n", 1)[0]
    delimiter = "|" if "|" in first_line else "\t"
    reader = csv.reader(io.StringIO(text), delimiter=delimiter, quoting=csv.QUOTE_NONE)
    header = [h.strip() for h in next(reader)]
    rows = []
    for rec in reader:
        if not rec:
            continue
        rows.append({k: (rec[i].strip() if i < len(rec) else "") for i, k in enumerate(header)})
    return rows


def in_box(lat: float, lon: float, box: dict[str, float]) -> bool:
    return box["south"] <= lat <= box["north"] and box["west"] <= lon <= box["east"]


def pad_box(box: dict[str, float], km: float) -> dict[str, float]:
    """Grow a box by `km` on every side."""
    mid = math.radians((box["south"] + box["north"]) / 2)
    dlat = km / 111.32
    dlon = km / (111.32 * max(0.01, math.cos(mid)))
    return {
        "south": box["south"] - dlat,
        "west": box["west"] - dlon,
        "north": box["north"] + dlat,
        "east": box["east"] + dlon,
    }


# ZCTAs whose internal point is within this distance outside the box are kept, so radius
# sums near the edge of the box still see their neighbours.
ZCTA_PAD_KM = 5.0


_PLACE_SUFFIX = re.compile(
    r"\s+(city and borough|metropolitan government|unified government|consolidated government|"
    r"metro government|urban county|city|town|village|borough|municipality|CDP)$"
)


def clean_place_name(name: str) -> str:
    """'Nashville-Davidson metropolitan government (balance)' -> 'Nashville-Davidson'."""
    n = re.sub(r"\s*\(balance\)$", "", name.strip())
    return _PLACE_SUFFIX.sub("", n).strip() or name.strip()


def to_float(s: str | None) -> float | None:
    try:
        v = float(s) if s not in (None, "") else None
    except ValueError:
        return None
    return v if v is not None and math.isfinite(v) else None


def land_km2(row: dict[str, str]) -> float | None:
    aland = to_float(row.get("ALAND"))
    return round(aland / 1e6, 1) if aland is not None else None


def places_for(rows: list[dict[str, str]], box: dict[str, float]) -> list[dict[str, Any]]:
    """Places whose equivalent circle (radius sqrt(land / pi)) reaches into the box."""
    out = []
    for r in rows:
        lat, lon = to_float(r.get("INTPTLAT")), to_float(r.get("INTPTLONG"))
        if lat is None or lon is None:
            continue
        land = land_km2(r) or 0.0
        if not in_box(lat, lon, pad_box(box, math.sqrt(land / math.pi)) if land else box):
            continue
        full = r.get("NAME", "")
        out.append(
            {
                "name": clean_place_name(full),
                "geoid": r.get("GEOID", ""),
                "lat": round(lat, COORD_DP),
                "lon": round(lon, COORD_DP),
                "kind": "cdp" if full.endswith(" CDP") else "incorporated",
                "landKm2": land_km2(r),
            }
        )
    out.sort(key=lambda p: p["geoid"])
    return out


def zcta_points_for(rows: list[dict[str, str]], box: dict[str, float]) -> list[dict[str, Any]]:
    padded = pad_box(box, ZCTA_PAD_KM)
    out = []
    for r in rows:
        lat, lon = to_float(r.get("INTPTLAT")), to_float(r.get("INTPTLONG"))
        if lat is None or lon is None or not in_box(lat, lon, padded):
            continue
        out.append(
            {
                "zcta": r.get("GEOID", ""),
                "lat": round(lat, COORD_DP),
                "lon": round(lon, COORD_DP),
                "landKm2": land_km2(r),
            }
        )
    out.sort(key=lambda z: z["zcta"])
    return out


# ---------------------------------------------------------------------------
# OSM Overpass (neighbourhood / suburb / quarter)
# ---------------------------------------------------------------------------


def overpass_query(box: dict[str, float]) -> str:
    b = f"{box['south']},{box['west']},{box['north']},{box['east']}"
    return (
        "[out:json][timeout:120];\n"
        f'nwr["place"~"^(neighbourhood|suburb|quarter)$"]["name"]({b});\n'
        "out center tags qt;\n"
    )


def fetch_overpass(f: Fetcher, metro: str, box: dict[str, float], refresh: bool) -> tuple[dict[str, Any], dict[str, Any]]:
    path = CACHE_DIR / f"overpass_{metro}.json"
    query = overpass_query(box)
    info: dict[str, Any] = {"url": OVERPASS_URL, "query": query.strip()}
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8")), {**info, "status": "ok", "cache": "hit"}
    last_err = ""
    # Overpass answers 429/504 when busy; back off and try at most three times.
    for attempt, pause in enumerate((OVERPASS_PAUSE_S, 20.0, 60.0)):
        if attempt:
            log(f"  overpass retry {attempt} for {metro} after {last_err}")
        try:
            r = f.request("POST", OVERPASS_URL, data={"data": query}, timeout=(20, 180), pause=pause)
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            continue
        if r.status_code == 200:
            try:
                payload = r.json()
            except ValueError:
                last_err = "non-JSON response"
                continue
            remark = str(payload.get("remark") or "")
            if "error" in remark.lower() or ("elements" not in payload):
                last_err = f"remark: {remark[:200] or 'no elements key'}"
                continue
            path.write_text(json.dumps(payload), encoding="utf-8")
            return payload, {**info, "status": "ok", "cache": "miss"}
        last_err = f"HTTP {r.status_code}"
        if r.status_code not in (429, 502, 503, 504):
            break
    raise RuntimeError(f"Overpass failed for {metro}: {last_err}")


# US OSM data tags many apartment complexes, condo blocks and mobile-home parks as
# place=neighbourhood. They are not useful tile names for a street team, so they are
# dropped (and counted in sources.osm.droppedHousing).
_HOUSING = re.compile(
    # condo(s), condominium(s) and the misspellings seen in OSM (condomiums, condoniums).
    r"\b(apartments?|aparments|apt|apts|apartment homes|condo(?:s|m\w*|n\w*)?|"
    r"townhomes?|townhouses?|mobile|manufactured home|trailer|rv park|"
    r"assisted living|senior living|villas?|lofts?|residences)\b",
    re.IGNORECASE,
)
_STATE_SUFFIX = re.compile(r"[,\s]+(TN|VA|WA)\.?$")
_DIRECTIONS = {"east", "west", "north", "south", "northeast", "northwest", "southeast", "southwest", "downtown", "midtown"}


def clean_hood_name(name: str, cities: Iterable[str]) -> str:
    """Tidy OSM names: 'Germantown Nashville, TN' -> 'Germantown', 'Eastview =' -> 'Eastview'."""
    n = unicodedata.normalize("NFC", name).strip()
    n = re.sub(r"[\s=;:,_-]+$", "", n).strip()
    m = _STATE_SUFFIX.search(n)
    if m:
        n = n[: m.start()].rstrip(" ,")
        for city in cities:
            m2 = re.search(r"[,\s]+" + re.escape(city) + r"$", n)
            head = n[: m2.start()].strip(" ,") if m2 else ""
            if m2 and head and head.lower() not in _DIRECTIONS:
                n = head
                break
    return n


def is_housing_complex(name: str) -> bool:
    return bool(_HOUSING.search(name))


def neighbourhoods_from(payload: dict[str, Any], cities: Iterable[str] = ()) -> tuple[list[dict[str, Any]], int]:
    """Normalise Overpass elements, drop housing complexes and duplicates (same name within 1 km).

    Returns (records, number of housing-complex records dropped).
    """
    rank = {"node": 0, "way": 1, "relation": 2}
    cities = list(cities)
    items = []
    dropped_housing = 0
    for el in payload.get("elements", []):
        tags = el.get("tags") or {}
        name = clean_hood_name(tags.get("name") or "", cities)
        kind = tags.get("place")
        if not name or kind not in ("neighbourhood", "suburb", "quarter"):
            continue
        if is_housing_complex(name):
            dropped_housing += 1
            continue
        if el.get("type") == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            c = el.get("center") or {}
            lat, lon = c.get("lat"), c.get("lon")
        if lat is None or lon is None:
            continue
        items.append(
            {
                "name": name,
                "lat": round(float(lat), COORD_DP),
                "lon": round(float(lon), COORD_DP),
                "kind": kind,
                "osmId": f"{el['type']}/{el['id']}",
                "_rank": rank.get(el.get("type"), 3),
            }
        )
    # Prefer nodes over way/relation centres when the same name appears twice nearby.
    items.sort(key=lambda n: (n["name"].lower(), n["_rank"], n["osmId"]))
    kept: list[dict[str, Any]] = []
    for n in items:
        dup = any(
            k["name"].lower() == n["name"].lower() and haversine_km(k["lat"], k["lon"], n["lat"], n["lon"]) < 1.0
            for k in kept
        )
        if not dup:
            kept.append(n)
    for n in kept:
        n.pop("_rank", None)
    kept.sort(key=lambda n: (n["name"].lower(), n["osmId"]))
    return kept, dropped_housing


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


# ---------------------------------------------------------------------------
# ACS 5-year by ZCTA
# ---------------------------------------------------------------------------


def acs_value(s: Any) -> float | None:
    """Census jam values (-666666666 etc.) and blanks become None."""
    if s is None:
        return None
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v) or v < 0:
        return None
    return v


def acs_record(get: Callable[[str], Any]) -> dict[str, Any]:
    """Build the ZCTA ACS record from a getter keyed by API-style variable names."""
    total = acs_value(get("B01003_001E"))
    b_total = acs_value(get("B01001_001E"))
    under = [acs_value(get(v)) for v in B01001_UNDER21]
    adults: int | None = None
    if b_total is not None and all(u is not None for u in under):
        adults = max(0, int(round(b_total - sum(u for u in under if u is not None))))
    age = acs_value(get("B01002_001E"))
    income = acs_value(get("B19013_001E"))
    return {
        "totalPop": int(round(total)) if total is not None else (int(round(b_total)) if b_total is not None else None),
        "adults21": adults,
        "medianAge": round(age, 1) if age is not None else None,
        "medianIncome": int(round(income)) if income is not None else None,
    }


# API vintages that already refused this run (e.g. missing key): not retried per metro.
_API_REFUSED: dict[int, str] = {}


def redact(msg: str) -> str:
    """Never let the Census key reach a log line or an output file."""
    key = os.environ.get("CENSUS_API_KEY", "").strip()
    return msg.replace(key, "$CENSUS_API_KEY") if key else msg


def acs_via_api(f: Fetcher, year: int, zctas: list[str]) -> dict[str, dict[str, Any]]:
    key = os.environ.get("CENSUS_API_KEY", "").strip()
    url = ACS_API_BASE.format(year=year)
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(zctas), 50):
        chunk = zctas[i : i + 50]
        params = {"get": ",".join(ACS_API_VARS), "for": "zip code tabulation area:" + ",".join(chunk)}
        if key:
            params["key"] = key
        r = f.request("GET", url, params=params, timeout=(20, 120), allow_redirects=False)
        if r.status_code in (301, 302, 303, 307, 308):
            hint = "missing or invalid key" if r.headers.get("X-DataWebAPI-KeyError") else r.headers.get("Location", "")
            raise RuntimeError(f"API redirected ({r.status_code}): {hint}")
        if r.status_code == 204:
            continue
        if r.status_code != 200:
            raise RuntimeError(f"API HTTP {r.status_code}: {r.text[:200]}")
        try:
            table = r.json()
        except ValueError as e:
            raise RuntimeError("API returned non-JSON") from e
        header = table[0]
        for row in table[1:]:
            rec = dict(zip(header, row))
            z = rec.get("zip code tabulation area")
            if z:
                out[z] = acs_record(rec.get)
    return out


def sf_cache_path(year: int, table: str) -> Path:
    return CACHE_DIR / f"acs5_{year}_{table}_zcta.csv"


def fetch_sf_table(f: Fetcher, year: int, table: str, refresh: bool) -> dict[str, dict[str, str]]:
    """Stream one table-based Summary File and keep the national ZCTA rows (cached)."""
    keep = ACS_SF_TABLES[table]
    path = sf_cache_path(year, table)
    if path.exists() and not refresh:
        with path.open(newline="", encoding="utf-8") as fh:
            return {row["zcta"]: row for row in csv.DictReader(fh)}
    url = ACS_SF_BASE.format(year=year, table=table)
    rows: dict[str, dict[str, str]] = {}
    with f.request("GET", url, stream=True, timeout=(20, 300)) as r:
        if r.status_code != 200:
            raise RuntimeError(f"Summary File {table} {year}: HTTP {r.status_code}")
        lines = r.iter_lines(chunk_size=1 << 16, decode_unicode=False)
        header = next(lines).decode("utf-8").strip().split("|")
        idx = {c: header.index(c) for c in keep if c in header}
        missing = [c for c in keep if c not in idx]
        if missing:
            raise RuntimeError(f"Summary File {table} {year}: missing columns {missing}")
        prefix = ZCTA_GEO_PREFIX.encode()
        for raw in lines:
            if not raw.startswith(prefix):
                continue
            parts = raw.decode("utf-8").split("|")
            z = parts[0][len(ZCTA_GEO_PREFIX) :]
            rows[z] = {"zcta": z, **{c: parts[i] for c, i in idx.items()}}
    if not rows:
        raise RuntimeError(f"Summary File {table} {year}: no ZCTA rows")
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["zcta", *keep])
        w.writeheader()
        for z in sorted(rows):
            w.writerow(rows[z])
    log(f"  cached {len(rows)} ZCTA rows from {table} {year}")
    return rows


def acs_via_summary_file(f: Fetcher, year: int, zctas: list[str], refresh: bool) -> dict[str, dict[str, Any]]:
    tables = {t: fetch_sf_table(f, year, t, refresh) for t in ACS_SF_TABLES}

    def getter(z: str) -> Callable[[str], Any]:
        def get(api_var: str) -> Any:
            m = re.fullmatch(r"(B\d{5})_(\d{3})E", api_var)
            if not m:
                return None
            row = tables[m.group(1).lower()].get(z)
            return row.get(f"{m.group(1)}_E{m.group(2)}") if row else None

        return get

    return {z: acs_record(getter(z)) for z in zctas if any(z in t for t in tables.values())}


def fetch_acs(f: Fetcher, zctas: list[str], refresh: bool, offline: bool) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    attempts: list[str] = []
    variables = {
        "totalPop": "B01003_001E",
        "medianAge": "B01002_001E",
        "medianIncome": "B19013_001E",
        "adults21": "B01001_001E - sum(B01001_003E..B01001_008E) - sum(B01001_027E..B01001_032E)",
    }
    # 1) Census Data API (keyless calls are now redirected to a missing-key page).
    if offline:
        attempts.append("api: skipped (offline mode)")
    else:
        for year in ACS_YEARS:
            if year in _API_REFUSED:
                attempts.append(f"api {year}: {_API_REFUSED[year]} (not retried)")
                continue
            try:
                data = acs_via_api(f, year, zctas)
                if data:
                    return data, {
                        "status": "ok",
                        "dataset": f"{year}/acs/acs5",
                        "via": "api",
                        "url": ACS_API_BASE.format(year=year),
                        "variables": variables,
                        "attempts": attempts,
                    }
                attempts.append(f"api {year}: no rows")
            except Exception as e:
                _API_REFUSED[year] = redact(str(e))
                attempts.append(f"api {year}: {_API_REFUSED[year]}")
    # 2) Table-based Summary File (bulk, keyless). Cached ZCTA rows work offline.
    for year in ACS_YEARS:
        try:
            if offline and not all(sf_cache_path(year, t).exists() for t in ACS_SF_TABLES):
                raise RuntimeError("offline and not cached")
            data = acs_via_summary_file(f, year, zctas, refresh)
            if data:
                return data, {
                    "status": "ok",
                    "dataset": f"{year}/acs/acs5",
                    "via": "summary_file",
                    "url": ACS_SF_BASE.format(year=year, table="<table>"),
                    "variables": variables,
                    "attempts": attempts,
                }
            attempts.append(f"summary_file {year}: no rows for these ZCTAs")
        except Exception as e:
            attempts.append(f"summary_file {year}: {redact(str(e))}")
    return {}, {"status": "failed", "variables": variables, "attempts": attempts}


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def dump_json(obj: dict[str, Any]) -> str:
    """Pretty top level, one compact record per line inside arrays (small, diffable)."""
    lines = ["{"]
    keys = list(obj)
    for i, k in enumerate(keys):
        v = obj[k]
        comma = "," if i < len(keys) - 1 else ""
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            lines.append(f"  {json.dumps(k)}: [")
            for j, item in enumerate(v):
                c = "," if j < len(v) - 1 else ""
                lines.append("    " + json.dumps(item, ensure_ascii=False, separators=(", ", ": ")) + c)
            lines.append(f"  ]{comma}")
        else:
            body = json.dumps(v, ensure_ascii=False, indent=2).replace("\n", "\n  ")
            lines.append(f"  {json.dumps(k)}: {body}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def build(metros: Iterable[str], refresh: bool, offline: bool) -> dict[str, Any]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    f = Fetcher(offline)
    generated = now_iso()

    shared: dict[str, Any] = {}
    shared_status: dict[str, dict[str, Any]] = {}
    for kind in ("place", "zcta"):
        log(f"gazetteer {kind}")
        try:
            path, info = fetch_gazetteer_zip(f, kind, refresh)
            shared[kind] = read_gazetteer(path)
            shared_status[kind] = {**info, "rows": len(shared[kind])}
        except Exception as e:
            shared[kind] = []
            shared_status[kind] = {"status": "failed", "error": str(e)}
            log(f"  FAILED: {e}")

    manifest: dict[str, Any] = {"generatedAt": generated, "metros": {}}
    for metro in metros:
        cfg = METROS[metro]
        box = cfg["bbox"]
        log(f"{metro}: box {box}")
        sources: dict[str, Any] = {}
        errors: list[str] = []

        places = places_for(shared["place"], box) if shared["place"] else []
        sources["places"] = {**shared_status["place"], "count": len(places)}
        if shared_status["place"]["status"] != "ok":
            errors.append(f"places: {shared_status['place'].get('error')}")
        elif not places:
            sources["places"]["status"] = "failed"
            errors.append("places: no rows inside the box (format change?)")

        zpts = zcta_points_for(shared["zcta"], box) if shared["zcta"] else []
        sources["zctaPoints"] = {**shared_status["zcta"], "count": len(zpts)}
        if shared_status["zcta"]["status"] != "ok":
            errors.append(f"zcta points: {shared_status['zcta'].get('error')}")
        elif not zpts:
            sources["zctaPoints"]["status"] = "failed"
            errors.append("zcta points: no rows inside the box (format change?)")

        try:
            payload, info = fetch_overpass(f, metro, box, refresh)
            hoods, dropped = neighbourhoods_from(payload, cfg["cities"])
            sources["osm"] = {
                **info,
                "osmBase": (payload.get("osm3s") or {}).get("timestamp_osm_base"),
                "elements": len(payload.get("elements", [])),
                "droppedHousing": dropped,
                "count": len(hoods),
            }
        except Exception as e:
            hoods = []
            sources["osm"] = {"status": "failed", "url": OVERPASS_URL, "error": str(e)}
            errors.append(f"osm: {e}")
            log(f"  osm FAILED: {e}")

        acs: dict[str, dict[str, Any]] = {}
        if zpts:
            acs, info = fetch_acs(f, [z["zcta"] for z in zpts], refresh, offline)
            sources["acs"] = {**info, "matched": len(acs)}
            if info["status"] != "ok":
                errors.append("acs: " + "; ".join(info.get("attempts", [])))
        else:
            sources["acs"] = {"status": "skipped", "reason": "no ZCTAs in box"}

        empty = {"totalPop": None, "adults21": None, "medianAge": None, "medianIncome": None}
        zctas = [{**z, **acs.get(z["zcta"], empty)} for z in zpts]

        doc = {
            "metro": metro,
            "label": cfg["label"],
            "center": cfg["center"],
            "bbox": box,
            "generatedAt": generated,
            "sources": sources,
            "errors": errors,
            "attribution": ATTRIBUTION,
            "neighbourhoods": hoods,
            "places": places,
            "zctas": zctas,
        }
        out_path = OUT_DIR / f"{metro}.json"
        out_path.write_text(dump_json(doc), encoding="utf-8")
        adults = sum(z["adults21"] or 0 for z in zctas)
        log(
            f"  wrote {out_path.relative_to(ROOT).as_posix()}: {len(hoods)} neighbourhoods, "
            f"{len(places)} places, {len(zctas)} ZCTAs ({adults:,} adults 21+), errors={len(errors)}"
        )
        manifest["metros"][metro] = {
            "file": f"{metro}.json",
            "generatedAt": generated,
            "counts": {"neighbourhoods": len(hoods), "places": len(places), "zctas": len(zctas)},
            "adults21Total": adults,
            "sources": {k: v.get("status") for k, v in sources.items()},
            "errors": errors,
        }

    # Merge with an existing manifest so a single-metro run keeps the others.
    mpath = OUT_DIR / "manifest.json"
    if mpath.exists():
        try:
            old = json.loads(mpath.read_text(encoding="utf-8"))
            for k, v in (old.get("metros") or {}).items():
                manifest["metros"].setdefault(k, v)
        except ValueError:
            pass
    manifest["metros"] = dict(sorted(manifest["metros"].items()))
    mpath.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--metro", action="append", choices=sorted(METROS), help="limit to one metro (repeatable)")
    ap.add_argument("--refresh", action="store_true", help="ignore the download cache")
    ap.add_argument("--offline", action="store_true", help="use only the download cache")
    args = ap.parse_args(argv)
    manifest = build(args.metro or list(METROS), args.refresh, args.offline)
    # The ZIP table (zip_places.csv, areas.json -> packages/gazetteer/src/zip-data.ts) follows the new ACS counts;
    # it fails when a new ZCTA has no row in zip_places.csv.
    import importlib.util

    spec = importlib.util.spec_from_file_location("gazetteer_zips", HERE / "zips.py")
    if spec and spec.loader:
        zips = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(zips)
        if zips.build() != 0:
            log("the ZIP table needs rows for new ZCTAs: see data/gazetteer/zip_places.csv")
            return 1
    failed = [m for m, v in manifest["metros"].items() if v.get("errors")]
    if failed:
        # Outputs are still written (each records its failed sources), but the exit code
        # says so, so a scripted rebuild cannot pass with degraded files unnoticed.
        log("completed with source errors in: " + ", ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
