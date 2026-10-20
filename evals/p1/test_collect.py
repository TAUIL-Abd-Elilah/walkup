"""Tests for the P1 collection helpers: parsers (on small synthetic markup written for these tests,
not copies of the real pages), name matching, address splitting and Gazetteer matching.

Run with:  python -m pytest evals/p1      (if pytest is installed)
     or:   python evals/p1/test_collect.py
"""

from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import centroids as C  # noqa: E402
import collect_bars as CB  # noqa: E402
from common import bar_key, cache_path_for  # noqa: E402
from matching import haversine_m, name_similarity, normalize_name, split_us_address  # noqa: E402

AO_CHAPTER = """
<html><body>
<div class="w-[54px]"></div><div class="font-wc">Example State</div>
<h1 class="font-bebas"> Example City </h1>
<section><h2>Upcoming Watch Parties</h2>
  <div class="border-2 bg-white p-5"><div class="font-albert">Should Not Be Read</div></div>
</section>
<section>
  <h2 class="font-bebas">Where We Watch</h2>
  <script>const FEATURES = [{"name":"Fallback Only","address":"1 A St, Example City, EX, 00000","official":true}];</script>
  <div class="grid">
    <div class="border-2 border-wc-ink bg-white p-5">
      <div class="flex"><div class="font-albert text-lg">Example Tap House</div>
        <span class="shrink-0 font-wc">Official</span></div>
      <div class="font-wc text-[0.78rem] text-wc-muted mb-3">12 Main St, Durham, NC, 27701</div>
      <div class="flex"><span class="group" title="men">
          USMNT
          <span class="pointer-events-none">tooltip text</span></span>
        <span class="group" title="x">
          Some Other Label
          <span class="pointer-events-none">tooltip</span></span></div>
    </div>
    <div class="border-2 border-wc-ink bg-white p-5">
      <div class="flex"><div class="font-albert text-lg">Second Spot</div></div>
      <div class="font-wc text-[0.78rem] text-wc-muted mb-3">9 Elm Ave, Carrboro, North Carolina, 27510</div>
    </div>
  </div>
</section>
<aside><div class="border-2 p-7">
  <div class="font-wc uppercase">Chapter status</div>
  <div class="font-wc font-bold">Official chapter</div><p>text</p>
  <div class="mt-4"><div class="font-wc font-bold text-amber-700">Rebuilding</div></div>
</div></aside>
</body></html>
"""

AA_PAGE = """
<html><head><script type="application/ld+json">{"dateModified":"2026-01-02T03:04:05+00:00"}</script></head><body>
<div class="elementor-accordion-item">
  <div class="elementor-tab-title"><a class="elementor-accordion-title">Example State</a></div>
  <div class="elementor-tab-content">
    <h2><strong>First Branch</strong></h2>
    <p><img src="x.png"/><br/><span><b>Alpha Pub<br/></b></span><span>100 First St</span></p>
    <p><span>Springfield, IL 62701</span></p>
    <p><a href="https://maps.example/1">Google Map</a></p>
    <p><a href="https://social.example/a">Twitter/X</a> | <a href="https://social.example/b">Facebook</a></p>
    <hr/>
    <p><b style="font-size: 30px;"><br/>Second Branch</b></p>
    <p><strong><span>Main Location:</span></strong></p>
    <p><strong>Beta Bar</strong><br/><span>200 Second Ave<br/>Peoria, IL 61602</span></p>
    <p><a href="https://maps.example/2">Google Map</a></p>
    <p><strong><span>Satellite Location:</span></strong></p>
    <p><strong>Gamma Grill</strong><br/>300 Third Rd<br/>Peoria, IL 61603</p>
    <p><a href="https://maps.example/3">Google Map</a></p>
    <h2> </h2>
    <p>Important note: Example Club NYC is an independent organization.</p>
  </div>
</div>
</body></html>
"""


def _lfc_page() -> str:
    data = {
        "props": {
            "pageProps": {
                "page": {
                    "updatedAt": "2026-02-03T04:05:06.000Z",
                    "blocks": [
                        {
                            "type": "accordion",
                            "items": [
                                {"type": "accordionItem", "title": "Example Supporters Club", "body": "<p><em>EXAMPLE, USA</em></p><p>We meet at Delta O Malley's for every match.</p><ul><li>social</li></ul>"},
                                {"type": "accordionItem", "title": "Abroad Supporters Club", "body": "<p>Elsewhere.</p>"},
                            ],
                        }
                    ],
                }
            }
        }
    }
    return f'<html><script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script></html>'


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------


def test_parse_ao_index_slugs():
    html = '<a href="/chapters/a-b">x</a><a href="/chapters/a-b">y</a><a href="/chapters/c">z</a><a href="/chapters/c/signup">s</a>'
    assert CB.parse_ao_index(html) == ["a-b", "c"]


def test_parse_ao_chapter_reads_where_we_watch_only_and_keeps_only_team_labels():
    ch = CB.parse_ao_chapter(AO_CHAPTER)
    assert ch["state"] == "Example State" and ch["chapter"] == "Example City"
    assert ch["chapter_status"] == "Official chapter; Rebuilding"
    names = [l["bar_name"] for l in ch["locations"]]
    assert names == ["Example Tap House", "Second Spot"]
    first, second = ch["locations"]
    assert first["official"] is True and second["official"] is False
    assert first["teams"] == ["USMNT"]  # "Some Other Label" is discarded by design
    assert first["address"] == "12 Main St, Durham, NC, 27701"


def test_parse_ao_chapter_falls_back_to_map_json():
    html = '<h1>X</h1><section><h2>Where We Watch</h2><script>const FEATURES = [{"name":"Map Bar","address":"5 B St, Austin, TX, 78701","official":false}];</script></section>'
    ch = CB.parse_ao_chapter(html)
    assert ch["locations"] == [{"bar_name": "Map Bar", "address": "5 B St, Austin, TX, 78701", "official": False, "teams": []}]


def test_parse_aa_branches_handles_headings_roles_and_notes():
    rows, updated = CB.parse_aa_branches(AA_PAGE)
    assert updated == "2026-01-02T03:04:05+00:00"
    got = [(r["chapter"], r["bar_name"], r["address"], r["role"]) for r in rows]
    assert got[0] == ("First Branch", "Alpha Pub", "100 First St, Springfield, IL 62701", "official")
    assert got[1] == ("Second Branch", "Beta Bar", "200 Second Ave, Peoria, IL 61602", "official")
    assert got[2] == ("Second Branch", "Gamma Grill", "300 Third Rd, Peoria, IL 61603", "satellite")
    # The independent-organization note is parsed as a pseudo-row that collect_aa drops.
    assert rows[-1]["bar_name"].startswith("Important note")


def test_parse_lfc_items_and_name_check():
    items, updated = CB.parse_lfc_items(_lfc_page())
    assert updated == "2026-02-03T04:05:06.000Z"
    assert [i["title"] for i in items] == ["Example Supporters Club", "Abroad Supporters Club"]
    assert "social" not in items[0]["text"]
    assert CB._name_in_text("Delta O'Malley's", items[0]["text"])
    assert not CB._name_in_text("Epsilon Tavern", items[0]["text"])


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------


def test_normalize_name():
    assert normalize_name("The Boot Room & Beer Study") == "boot room and beer study"
    assert normalize_name("Fadó Irish Pub") == "fado irish pub"
    assert normalize_name("O’Brien's Pub") == "obriens pub"


def test_name_similarity_rule():
    assert name_similarity("O'Brien's Pub", "OBriens Pub") == 1.0
    assert name_similarity("The Boot Room & Beer Study Durham", "Boot Room") == 1.0  # contiguous run
    assert name_similarity("Pub Irish", "Irish Pub") == 1.0  # sorted tokens
    assert name_similarity("The Brass Tap", "The Brass Door") < 0.85
    assert name_similarity("Pub", "Pub Grill") < 1.0  # a one-word name never triggers containment


def test_haversine():
    d = haversine_m(35.9940, -78.8986, 35.9940, -78.8986 + 0.01)
    assert 890 < d < 910


def test_split_us_address_variants():
    cases = {
        "2501 Example Dr, Durham, NC, 27707": ("Durham", "NC"),
        "130 Example Street S #105, Birmingham, AL 35222": ("Birmingham", "AL"),
        "340 N. 6th Ave., Tucson AZ 85705": ("Tucson", "AZ"),
        "1348 Example Avenue NW, Washington DC, 20009": ("Washington", "DC"),
        "45 Example Street, Suite 300, Charleston, South Carolina, 29403": ("Charleston", "SC"),
        "1802 Example Ave SW Roanoke, VA 24015": ("Roanoke", "VA"),
        "273 Example Ave NE": ("", ""),
        "": ("", ""),
    }
    for addr, want in cases.items():
        assert split_us_address(addr) == want, (addr, split_us_address(addr))


def test_bar_key_stable_and_case_insensitive():
    assert bar_key("lfc_olsc", "Alpha Pub", "1 A St") == bar_key("lfc_olsc", "alpha  pub", "1 a st")
    assert len(bar_key("x", "y", "z")) == 12


class _FakeResp:
    def __init__(self, status: int, text: str = ""):
        self.status_code, self.text = status, text


class _FakeSession:
    """Answers only robots.txt requests; no network."""

    def __init__(self, status: int, text: str = ""):
        self.headers: dict = {}
        self._resp = _FakeResp(status, text)

    def get(self, url, timeout=None):
        assert url.endswith("/robots.txt"), url
        return self._resp


def test_robots_status_handling_matches_robotparser():
    import tempfile

    from common import PoliteFetcher

    cases = {404: True, 410: True, 401: False, 403: False, 500: False, 503: False}
    with tempfile.TemporaryDirectory() as td:
        for status, want in cases.items():
            f = PoliteFetcher(log_path=Path(td) / "log.csv", session=_FakeSession(status))
            assert f.allowed("https://example.org/chapters/x") is want, status
        f = PoliteFetcher(log_path=Path(td) / "log.csv", session=_FakeSession(200, "User-agent: *\nDisallow: /private/\n"))
        assert f.allowed("https://example.org/chapters/x") is True
        assert f.allowed("https://example.org/private/x") is False


def test_cache_path_is_inside_cache():
    p = cache_path_for("https://example.org/chapters/durham?x=1")
    assert "example.org" in str(p) and p.name.endswith(".html")


# ---------------------------------------------------------------------------
# Gazetteer matching (synthetic two-file Gazetteer)
# ---------------------------------------------------------------------------


def _gaz_zip(lines: list[str], header: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("gaz.txt", "\n".join([header] + lines) + "\n")
    return buf.getvalue()


PLACE_HEADER = "USPS|GEOID|GEOIDFQ|ANSICODE|NAME|LSAD|FUNCSTAT|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG"
PLACES = [
    "NC|3719000|x|x|Durham city|25|A|300000000|0|0|0|35.98|-78.90",
    "NC|3719001|x|x|Durham CDP|57|S|900000000|0|0|0|10.00|10.00",
    "TN|4752006|x|x|Nashville-Davidson metropolitan government (balance)|00|A|1|0|0|0|36.17|-86.78",
    "ID|1608830|x|x|Boise City city|25|A|1|0|0|0|43.60|-116.23",
    "MO|2965000|x|x|St. Louis city|25|A|1|0|0|0|38.63|-90.24",
]
COUSUB_HEADER = "USPS|GEOID|GEOIDFQ|ANSICODE|NAME|FUNCSTAT|ALAND|AWATER|ALAND_SQMI|AWATER_SQMI|INTPTLAT|INTPTLONG"
COUSUBS = ["NJ|3402907420|x|x|Brick township|A|1|0|0|0|40.06|-74.11"]


def _indexes():
    places = C.build_index(C.load_gazetteer(_gaz_zip(PLACES, PLACE_HEADER)))
    cousubs = C.build_index(C.load_gazetteer(_gaz_zip(COUSUBS, COUSUB_HEADER)))
    return places, cousubs


def test_gazetteer_direct_prefers_active_government():
    places, cousubs = _indexes()
    m = C.match_city("Durham", "NC", places, cousubs, {})
    assert m["metro_geoid"] == "3719000" and m["metro_source"] == "place" and m["metro_via"] == "direct"


def test_gazetteer_saint_and_consolidated_and_alias_and_cousub_and_miss():
    places, cousubs = _indexes()
    assert C.match_city("Saint Louis", "MO", places, cousubs, {})["metro_geoid"] == "2965000"
    nash = C.match_city("Nashville", "TN", places, cousubs, {})
    assert nash["metro_geoid"] == "4752006" and nash["metro_via"] == "consolidated"
    aliases = {("ID", "boise"): ("Boise City", "ID")}
    boise = C.match_city("Boise", "ID", places, cousubs, aliases)
    assert boise["metro_geoid"] == "1608830" and boise["metro_via"] == "alias"
    brick = C.match_city("Brick", "NJ", places, cousubs, {})
    assert brick["metro_source"] == "cousub"
    miss = C.match_city("Nowhere", "NC", places, cousubs, {})
    assert miss["metro_source"] == "miss" and miss["metro_lat"] == ""


def test_metro_display_name():
    assert C.metro_display_name("Durham city") == "Durham"
    assert C.metro_display_name("Nashville-Davidson metropolitan government (balance)") == "Nashville"
    assert C.metro_display_name("Louisville/Jefferson County metro government (balance)") == "Louisville"
    assert C.metro_display_name("Arlington CDP") == "Arlington"
    assert C.metro_display_name("Boise City city") == "Boise City"
    assert C.metro_display_name("Brick township") == "Brick"
    assert C.metro_display_name("Winston-Salem city") == "Winston-Salem"


def test_tab_delimited_gazetteer_also_loads():
    raw = _gaz_zip([PLACES[0].replace("|", "\t")], PLACE_HEADER.replace("|", "\t"))
    recs = C.load_gazetteer(raw)
    assert recs[0]["NAME"] == "Durham city" and recs[0]["INTPTLONG"] == "-78.90"


if __name__ == "__main__":
    failures = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as exc:
            failures += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"{len(tests) - failures} passed, {failures} failed")
    raise SystemExit(1 if failures else 0)
