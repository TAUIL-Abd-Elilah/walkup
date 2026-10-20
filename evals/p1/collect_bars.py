"""Collect official supporters'-club home bars in US metros (P1 ground truth).

Sources (all public pages, robots.txt honoured, <=1 req/s, cached):
  american_outlaws  https://theamericanoutlaws.com/chapters  -> each /chapters/<slug> "Where We Watch"
  arsenal_america   https://arsenalamerica.com/branches/     -> state accordions, one block per branch
  lfc_olsc          https://www.liverpoolfc.com/fans/official-lfc-supporters-clubs/north-america
                    (Next.js page; bar names live in free text, so US rows are hand-extracted into
                    data/private/p1/lfc_curated.csv and checked against the live page here)

Only listing facts are stored: club, chapter, city, state, bar_name, address, source_url,
fetched_at, page_last_updated, plus the club's own designation of the listing (listing_role,
teams, chapter_status). No people, no contact details, no other venue labels.

Output: data/private/p1/bars_full.csv (git-ignored) and data/private/p1/collect_report.json.

Usage:  python evals/p1/collect_bars.py [--refresh] [--only american_outlaws,arsenal_america,lfc_olsc]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from common import (  # noqa: E402
    BAR_COLUMNS,
    BARS_FULL,
    PRIVATE_DIR,
    PoliteFetcher,
    bar_key,
    read_csv,
    utc_now_iso,
    write_csv,
)
from matching import US_STATES, normalize_name, split_us_address  # noqa: E402

AO_INDEX = "https://theamericanoutlaws.com/chapters"
AO_BASE = "https://theamericanoutlaws.com"
AA_BRANCHES = "https://arsenalamerica.com/branches/"
LFC_NA = "https://www.liverpoolfc.com/fans/official-lfc-supporters-clubs/north-america"
LFC_CURATED = PRIVATE_DIR / "lfc_curated.csv"

# Labels the AO page attaches to a location. Only the team labels are kept; every other
# badge (for example community or identity labels) is deliberately discarded.
AO_TEAM_LABELS = {"USMNT", "USWNT"}


def _soup(html: str):
    from bs4 import BeautifulSoup

    return BeautifulSoup(html, "lxml")


def _clean(s: str) -> str:
    s = (s or "").replace(" ", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return re.sub(r"\s+,", ",", s)


# ---------------------------------------------------------------------------
# American Outlaws
# ---------------------------------------------------------------------------


def parse_ao_index(html: str) -> list[str]:
    """Return sorted unique chapter slugs from the chapters index."""
    slugs = set(re.findall(r'href="/chapters/([a-z0-9-]+)"', html))
    return sorted(slugs)


def parse_ao_chapter(html: str) -> dict:
    """Parse one chapter page.

    Returns {"state": str, "chapter": str, "chapter_status": str, "locations": [
        {"bar_name", "address", "official": bool, "teams": [..]}]}.
    """
    soup = _soup(html)
    h1 = soup.find("h1")
    chapter = _clean(h1.get_text(" ")) if h1 else ""
    state = ""
    if h1:
        prev = h1.find_previous_sibling("div")
        if prev:
            state = _clean(prev.get_text(" "))

    status_bits: list[str] = []
    for div in soup.find_all("div"):
        if _clean(div.get_text(" ")) == "Chapter status" and not div.find("div"):
            box = div.parent
            for b in box.find_all("div", class_=re.compile(r"font-bold")):
                t = _clean(b.get_text(" "))
                if t:
                    status_bits.append(t)
            break

    locations: list[dict] = []
    h2 = None
    for cand in soup.find_all("h2"):
        if _clean(cand.get_text(" ")).casefold() == "where we watch":
            h2 = cand
            break
    if h2 is not None:
        section = h2.find_parent("section") or h2.parent
        for card in section.find_all("div", class_=re.compile(r"\bp-5\b")):
            name_el = card.find("div", class_=re.compile(r"font-albert"))
            if not name_el:
                continue
            addr_el = card.find("div", class_=re.compile(r"text-wc-muted"))
            badges = [_clean(s.find(string=True, recursive=False) or "") for s in card.find_all("span")]
            official = any(_clean(s.get_text(" ")) == "Official" for s in card.find_all("span", recursive=True) if not s.find("span"))
            teams = sorted({b for b in badges if b in AO_TEAM_LABELS})
            locations.append(
                {
                    "bar_name": _clean(name_el.get_text(" ")),
                    "address": _clean(addr_el.get_text(" ")) if addr_el else "",
                    "official": official,
                    "teams": teams,
                }
            )
    if not locations:
        # Fallback: the map script carries the same list as JSON.
        m = re.search(r"const FEATURES = (\[.*?\]);", html, re.S)
        if m:
            try:
                for f in json.loads(m.group(1)):
                    locations.append(
                        {
                            "bar_name": _clean(f.get("name", "")),
                            "address": _clean(f.get("address", "")),
                            "official": bool(f.get("official")),
                            "teams": [],
                        }
                    )
            except json.JSONDecodeError:
                pass
    return {"state": state, "chapter": chapter, "chapter_status": "; ".join(status_bits), "locations": locations}


def collect_ao(fetcher: PoliteFetcher, report: dict) -> list[dict]:
    rows: list[dict] = []
    failures: list[str] = []
    idx = fetcher.get(AO_INDEX)
    if idx.status != 200:
        report["american_outlaws"] = {"failures": [f"index {AO_INDEX}: status {idx.status} {idx.error}"]}
        return rows
    slugs = parse_ao_index(idx.text)
    no_location = 0
    for slug in slugs:
        url = f"{AO_BASE}/chapters/{slug}"
        res = fetcher.get(url)
        if res.status != 200:
            failures.append(f"{url}: status {res.status} {res.error}".strip())
            continue
        ch = parse_ao_chapter(res.text)
        if not ch["locations"]:
            no_location += 1
            continue
        for loc in ch["locations"]:
            city, st = split_us_address(loc["address"])
            rows.append(
                {
                    "club": "american_outlaws",
                    "chapter": ch["chapter"] or slug,
                    "city": city,
                    "state": st or US_STATE_ABBR.get(ch["state"].casefold(), ""),
                    "bar_name": loc["bar_name"],
                    "address": loc["address"],
                    "source_url": url,
                    "fetched_at": res.fetched_at,
                    "page_last_updated": "",  # not shown on AO chapter pages
                    "listing_role": "official" if loc["official"] else "satellite",
                    "teams": "|".join(loc["teams"]),
                    "chapter_status": ch["chapter_status"],
                }
            )
    report["american_outlaws"] = {
        "index_url": AO_INDEX,
        "chapter_pages": len(slugs),
        "chapters_without_listed_location": no_location,
        "rows": len(rows),
        "failures": failures,
    }
    return rows


US_STATE_ABBR = {v.casefold(): k for k, v in US_STATES.items()}


# ---------------------------------------------------------------------------
# Arsenal America
# ---------------------------------------------------------------------------

_AA_SKIP = re.compile(r"^(official website|website|twitter/x|facebook|instagram|threads|\|)$", re.I)
_AA_ROLE = re.compile(r"^(main|satellite)\s+location:?$", re.I)


def _aa_segments(content) -> list[tuple[str, str]]:
    """Linearize one state's accordion body into (kind, text) segments.

    kinds: H (branch heading), T (text line), MAP (end of one location), SEP (divider).
    """
    segs: list[tuple[str, str]] = []
    for el in content.find_all(["h2", "h3", "p", "hr"]):
        if el.name == "hr" or (el.name == "p" and el.find("div", class_=re.compile("cr-divider"))):
            segs.append(("SEP", ""))
            continue
        if el.name in ("h2", "h3"):
            t = _clean(el.get_text(" "))
            if t:
                segs.append(("H", t))
            continue
        text = _clean(el.get_text(" "))
        if not text:
            continue
        bold = el.find(["b", "strong"], style=re.compile(r"font-size"))
        if bold is not None and _clean(bold.get_text(" ")) == text:
            segs.append(("H", text))
            continue
        links = {_clean(a.get_text(" ")) for a in el.find_all("a")}
        if "Google Map" in links:
            segs.append(("MAP", ""))
            continue
        if links and ("|" in text or text in links):
            continue  # social / website links
        for br in el.find_all("br"):
            br.replace_with("\n")
        for line in el.get_text("").split("\n"):
            line = _clean(line)
            if line and not _AA_SKIP.match(line):
                segs.append(("T", line))
    return segs


def parse_aa_branches(html: str) -> tuple[list[dict], str]:
    """Return ([{state_name, chapter, bar_name, address, role}], page_last_updated).

    A branch block is a heading followed by one or more locations; a location is its text
    lines (bar name first, then street and city lines) closed by its "Google Map" link.
    "Main Location:" / "Satellite Location:" lines set the role of the following location.
    """
    soup = _soup(html)
    last_updated = ""
    m = re.search(r'"dateModified":"([^"]+)"', html)
    if m:
        last_updated = m.group(1)
    else:
        meta = soup.find("meta", attrs={"property": "article:modified_time"})
        if meta and meta.get("content"):
            last_updated = meta["content"]

    rows: list[dict] = []
    for item in soup.select("div.elementor-accordion-item"):
        title = item.select_one(".elementor-accordion-title")
        content = item.select_one(".elementor-tab-content")
        if not title or not content:
            continue
        state_name = _clean(title.get_text(" "))
        chapter, role, buf = "", "", []

        def flush() -> None:
            nonlocal buf
            if buf:
                rows.append(
                    {
                        "state_name": state_name,
                        "chapter": chapter,
                        "bar_name": buf[0],
                        "address": ", ".join(buf[1:]),
                        "role": role or "official",
                    }
                )
            buf = []

        for kind, text in _aa_segments(content):
            if kind == "H":
                flush()
                chapter, role = text, ""
            elif kind == "SEP":
                flush()
            elif kind == "MAP":
                flush()
            else:
                rm = _AA_ROLE.match(text)
                if rm:
                    flush()
                    role = "official" if rm.group(1).lower() == "main" else "satellite"
                else:
                    buf.append(text)
        flush()
    return rows, last_updated


def collect_aa(fetcher: PoliteFetcher, report: dict) -> list[dict]:
    res = fetcher.get(AA_BRANCHES)
    if res.status != 200:
        report["arsenal_america"] = {"failures": [f"{AA_BRANCHES}: status {res.status} {res.error}"]}
        return []
    branches, last_updated = parse_aa_branches(res.text)
    rows = []
    unparsed = []
    notes = []
    for b in branches:
        if b["bar_name"].casefold().startswith("important note"):
            # e.g. "Arsenal NYC is an independent organization": a pointer, not a listing.
            notes.append(f"{b['state_name']}: page points to an independent organization; no bar listed")
            continue
        city, st = split_us_address(b["address"])
        if not st:
            st = US_STATE_ABBR.get(b["state_name"].casefold(), "")
        if not city:
            unparsed.append(f"{b['chapter']}: address not parsed")
        rows.append(
            {
                "club": "arsenal_america",
                "chapter": b["chapter"],
                "city": city,
                "state": st,
                "bar_name": b["bar_name"],
                "address": b["address"],
                "source_url": AA_BRANCHES,
                "fetched_at": res.fetched_at,
                "page_last_updated": last_updated,
                "listing_role": b["role"],
                "teams": "",
                "chapter_status": "",
            }
        )
    report["arsenal_america"] = {
        "index_url": AA_BRANCHES,
        "locations_parsed": len(branches),
        "branches": len({r["chapter"] for r in rows}),
        "rows": len(rows),
        "page_last_updated": last_updated,
        "notes": notes,
        "failures": unparsed,
    }
    return rows


# ---------------------------------------------------------------------------
# Liverpool FC OLSC North America
# ---------------------------------------------------------------------------


def parse_lfc_items(html: str) -> tuple[list[dict], str]:
    """Return ([{title, text}], page_last_updated) from the page's __NEXT_DATA__ JSON."""
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        return [], ""
    data = json.loads(m.group(1))
    page = data.get("props", {}).get("pageProps", {}).get("page", {})
    items: list[dict] = []
    for block in page.get("blocks", []) or []:
        for it in block.get("items", []) or []:
            if it.get("type") != "accordionItem":
                continue
            soup = _soup(it.get("body") or "")
            for ul in soup.find_all("ul"):
                ul.decompose()
            text = _clean(" ".join(p.get_text(" ") for p in soup.find_all(["p", "div"])) or soup.get_text(" "))
            items.append({"title": _clean(it.get("title", "")), "text": text})
    return items, page.get("updatedAt", "") or ""


def _name_in_text(bar_name: str, text: str) -> bool:
    """True when the first two significant words of the curated name occur in the live text
    (spaces ignored, so "O'Malley's" matches "O Malley's")."""
    toks = [t for t in normalize_name(bar_name).split() if len(t) > 2] or normalize_name(bar_name).split()
    hay = normalize_name(text).replace(" ", "")
    return bool(toks) and all(t in hay for t in toks[:2])


def collect_lfc(fetcher: PoliteFetcher, report: dict) -> list[dict]:
    res = fetcher.get(LFC_NA)
    if res.status != 200:
        report["lfc_olsc"] = {"failures": [f"{LFC_NA}: status {res.status} {res.error}"]}
        return []
    items, last_updated = parse_lfc_items(res.text)
    by_title = {i["title"]: i for i in items}
    curated = read_csv(LFC_CURATED) if LFC_CURATED.exists() else []
    rows, failures = [], []
    used_titles = set()
    for c in curated:
        item = by_title.get(c["chapter"])
        if item is None:
            failures.append(f"curated chapter no longer on page: {c['chapter']}")
            continue
        if not _name_in_text(c["bar_name"], item["text"]):
            failures.append(f"curated bar not found in live text: {c['chapter']} / {c['bar_name']}")
            continue
        used_titles.add(c["chapter"])
        rows.append(
            {
                "club": "lfc_olsc",
                "chapter": c["chapter"],
                "city": c["city"],
                "state": c["state"],
                "bar_name": c["bar_name"],
                "address": c["address"],
                "source_url": res.final_url or LFC_NA,
                "fetched_at": res.fetched_at,
                "page_last_updated": last_updated,
                "listing_role": "official",
                "teams": "",
                "chapter_status": "",
            }
        )
    not_used = sorted(set(by_title) - used_titles)
    report["lfc_olsc"] = {
        "index_url": LFC_NA,
        "final_url": res.final_url,
        "items_on_page": len(items),
        "items_with_us_rows": len(used_titles),
        "items_without_us_rows": not_used,
        "rows": len(rows),
        "page_last_updated": last_updated,
        "extraction": "hand-extracted from free text into data/private/p1/lfc_curated.csv; each row re-checked against the live page",
        "failures": failures,
    }
    return rows


# ---------------------------------------------------------------------------


def dedupe(rows: list[dict]) -> list[dict]:
    seen, out = set(), []
    for r in rows:
        r["bar_key"] = bar_key(r["club"], r["bar_name"], r["address"] or f"{r['city']}, {r['state']}")
        if r["bar_key"] in seen:
            continue
        seen.add(r["bar_key"])
        out.append(r)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--refresh", action="store_true", help="ignore the cache and re-fetch every page")
    ap.add_argument("--only", default="american_outlaws,arsenal_america,lfc_olsc")
    args = ap.parse_args(argv)

    fetcher = PoliteFetcher(refresh=args.refresh)
    report: dict = {"started_at": utc_now_iso()}
    rows: list[dict] = []
    only = set(args.only.split(","))
    if "american_outlaws" in only:
        rows += collect_ao(fetcher, report)
    if "arsenal_america" in only:
        rows += collect_aa(fetcher, report)
    if "lfc_olsc" in only:
        rows += collect_lfc(fetcher, report)
    rows = dedupe(rows)
    us_rows = [r for r in rows if r["state"] in US_STATES and r["state"] != "PR"]
    report["dropped_non_us_or_unknown_state"] = [
        f"{r['club']} / {r['chapter']} / {r['bar_name']}" for r in rows if r not in us_rows
    ]
    report["finished_at"] = utc_now_iso()
    report["rows_written"] = len(us_rows)
    write_csv(BARS_FULL, us_rows, BAR_COLUMNS)
    (PRIVATE_DIR / "collect_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8", newline="\n")
    print(json.dumps({k: (v if not isinstance(v, dict) else {kk: vv for kk, vv in v.items() if kk != "failures"}) for k, v in report.items()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
