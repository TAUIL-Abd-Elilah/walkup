"""Shared paths and a polite HTTP fetcher for the P1 data steps.

Politeness rules (applied to every request this package makes):
- robots.txt is read once per host with urllib.robotparser and honoured;
- at most one request per second across all hosts;
- a descriptive User-Agent;
- every response is cached under data/private/p1/cache/ and re-used, so a
  re-run of the pipeline does not re-fetch anything unless --refresh is given.
"""

from __future__ import annotations

import csv
import hashlib
import re
import time
import urllib.parse
import urllib.robotparser
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

USER_AGENT = "HouselightsResearch/0.1 (contact via repo)"
MIN_INTERVAL_S = 1.0

REPO_ROOT = Path(__file__).resolve().parents[2]
PUBLIC_DIR = REPO_ROOT / "data" / "p1"
PRIVATE_DIR = REPO_ROOT / "data" / "private" / "p1"
CACHE_DIR = PRIVATE_DIR / "cache"
FETCH_LOG = PRIVATE_DIR / "fetch_log.csv"
BARS_FULL = PRIVATE_DIR / "bars_full.csv"

# Columns written to data/private/p1/bars_full.csv. The first nine are the
# listing facts named in the P1 plan; listing_role / teams / chapter_status are
# the club's own designation of the listing (no people, no personal data).
BAR_COLUMNS = [
    "bar_key",
    "club",
    "chapter",
    "city",
    "state",
    "bar_name",
    "address",
    "source_url",
    "fetched_at",
    "page_last_updated",
    "listing_role",
    "teams",
    "chapter_status",
]

CLUB_LABELS = {
    "american_outlaws": "American Outlaws (US national teams)",
    "arsenal_america": "Arsenal America (Arsenal FC)",
    "lfc_olsc": "LFC Official Supporters Clubs, North America (Liverpool FC)",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def bar_key(club: str, bar_name: str, address: str) -> str:
    """Stable 12-hex id for a listed (club, bar, address) row."""
    basis = "|".join(re.sub(r"\s+", " ", s.strip().casefold()) for s in (club, bar_name, address))
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:12]


def cache_path_for(url: str) -> Path:
    parts = urllib.parse.urlsplit(url)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", (parts.path.strip("/") or "index") + ("_" + parts.query if parts.query else ""))
    return CACHE_DIR / parts.netloc / f"{slug[:120]}.html"


@dataclass
class FetchResult:
    url: str
    final_url: str
    status: int
    body: bytes
    fetched_at: str
    from_cache: bool
    error: str = ""

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")


class PoliteFetcher:
    """GET with robots.txt, a global 1 req/s limit and an on-disk cache."""

    def __init__(self, refresh: bool = False, log_path: Path = FETCH_LOG, session=None):
        import requests  # imported lazily so tests that only parse do not need it

        self.refresh = refresh
        self.log_path = log_path
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._last = 0.0
        self._log_rows: list[dict[str, str]] = []
        self._meta: dict[str, dict[str, str]] = self._load_log()

    # -- logging -------------------------------------------------------------
    def _load_log(self) -> dict[str, dict[str, str]]:
        meta: dict[str, dict[str, str]] = {}
        if self.log_path.exists():
            with self.log_path.open(newline="", encoding="utf-8") as fh:
                for row in csv.DictReader(fh):
                    if row.get("status") == "200":
                        meta[row["url"]] = row
        return meta

    def _append_log(self, row: dict[str, str]) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        new = not self.log_path.exists()
        with self.log_path.open("a", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=["url", "final_url", "status", "bytes", "fetched_at", "error"])
            if new:
                w.writeheader()
            w.writerow(row)

    # -- politeness ----------------------------------------------------------
    def _wait(self) -> None:
        dt = time.monotonic() - self._last
        if dt < MIN_INTERVAL_S:
            time.sleep(MIN_INTERVAL_S - dt)
        self._last = time.monotonic()

    def allowed(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self._robots:
            rp = urllib.robotparser.RobotFileParser()
            self._wait()
            try:
                resp = self.session.get(host + "/robots.txt", timeout=30)
                # Same outcomes as urllib.robotparser.RobotFileParser.read(): 401/403 disallow
                # everything, any other 4xx means no robots.txt (allow), 5xx means the rules are
                # unknown, so the host is skipped rather than assumed open.
                if resp.status_code in (401, 403) or resp.status_code >= 500:
                    self._robots[host] = None
                else:
                    if resp.status_code >= 400:
                        rp.parse([])  # no robots.txt: everything allowed
                    else:
                        rp.parse(resp.text.splitlines())
                    self._robots[host] = rp
            except Exception:  # network failure: be conservative and skip the host
                self._robots[host] = None
        rp = self._robots[host]
        return bool(rp and rp.can_fetch(USER_AGENT, url))

    # -- fetch ---------------------------------------------------------------
    def get(self, url: str, binary_path: Path | None = None) -> FetchResult:
        path = binary_path or cache_path_for(url)
        if path.exists() and not self.refresh:
            meta = self._meta.get(url, {})
            return FetchResult(url, meta.get("final_url", url), 200, path.read_bytes(), meta.get("fetched_at", ""), True)
        if not self.allowed(url):
            res = FetchResult(url, url, 0, b"", utc_now_iso(), False, "blocked by robots.txt or robots unreachable")
            self._append_log({"url": url, "final_url": url, "status": "0", "bytes": "0", "fetched_at": res.fetched_at, "error": res.error})
            return res
        self._wait()
        fetched_at = utc_now_iso()
        try:
            resp = self.session.get(url, timeout=60)
            res = FetchResult(url, resp.url, resp.status_code, resp.content, fetched_at, False)
        except Exception as exc:  # recorded, never raised: one bad page must not stop a run
            res = FetchResult(url, url, 0, b"", fetched_at, False, f"{type(exc).__name__}: {exc}")
        if res.status == 200:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(res.body)
            self._meta[url] = {"final_url": res.final_url, "fetched_at": fetched_at}
        self._append_log(
            {
                "url": url,
                "final_url": res.final_url,
                "status": str(res.status),
                "bytes": str(len(res.body)),
                "fetched_at": fetched_at,
                "error": res.error,
            }
        )
        return res


def write_csv(path: Path, rows: list[dict], columns: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({c: r.get(c, "") for c in columns})


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))
