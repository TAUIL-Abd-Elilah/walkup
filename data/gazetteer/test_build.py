"""Offline unit tests for build.py (no network). Run from the repo root:

    python -I data/gazetteer/test_build.py -v
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location("gazetteer_build", Path(__file__).resolve().parent / "build.py")
assert _SPEC and _SPEC.loader
b = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(b)


class PlaceNames(unittest.TestCase):
    def test_strips_legal_suffixes(self) -> None:
        self.assertEqual(b.clean_place_name("Nashville-Davidson metropolitan government (balance)"), "Nashville-Davidson")
        self.assertEqual(b.clean_place_name("Franklin city"), "Franklin")
        self.assertEqual(b.clean_place_name("Spanaway CDP"), "Spanaway")
        self.assertEqual(b.clean_place_name("Virginia Beach city"), "Virginia Beach")
        self.assertEqual(b.clean_place_name("Town and Country city"), "Town and Country")


class HoodNames(unittest.TestCase):
    def test_cleans_state_suffix_and_city(self) -> None:
        self.assertEqual(b.clean_hood_name("Germantown Nashville, TN", ["Nashville"]), "Germantown")
        self.assertEqual(b.clean_hood_name("Melrose/Waverly Nashville TN", ["Nashville"]), "Melrose/Waverly")
        self.assertEqual(b.clean_hood_name("East Nashville TN", ["Nashville"]), "East Nashville")
        self.assertEqual(b.clean_hood_name("Eastview =", ["Nashville"]), "Eastview")
        self.assertEqual(b.clean_hood_name("North Virginia Beach", ["Virginia Beach"]), "North Virginia Beach")

    def test_flags_housing_complexes(self) -> None:
        for n in [
            "Cedar Creek Apartments",
            "Elms Way Condos",
            "Rivendell Townhomes",
            "Woodshire Mobile Home Park",
            "Hickory Park Villas",
            "Brentwood Square Condominiums",
            "West Park Condomiums",  # misspellings found in OSM
            "Two Mountain View Place Condoniums",
            "Valley Mobile Manor",
        ]:
            self.assertTrue(b.is_housing_complex(n), n)
        for n in ["Ghent", "Hilltop", "Villanova Heights", "Loftis Acres", "Westview Estates", "Condor Heights"]:
            self.assertFalse(b.is_housing_complex(n), n)


class Neighbourhoods(unittest.TestCase):
    def test_normalises_elements(self) -> None:
        payload = {
            "synthetic": True,
            "elements": [
                {"type": "node", "id": 1, "lat": 10.0, "lon": -30.0, "tags": {"name": "Lantern Row", "place": "neighbourhood"}},
                {"type": "way", "id": 2, "center": {"lat": 10.001, "lon": -30.001}, "tags": {"name": "Lantern Row", "place": "neighbourhood"}},
                {"type": "way", "id": 3, "center": {"lat": 10.2, "lon": -30.2}, "tags": {"name": "Lantern Row", "place": "suburb"}},
                {"type": "relation", "id": 4, "center": {"lat": 10.05, "lon": -30.05}, "tags": {"name": "Millbrook", "place": "suburb"}},
                {"type": "node", "id": 5, "lat": 10.06, "lon": -30.06, "tags": {"name": "Harbor Apartments", "place": "neighbourhood"}},
                {"type": "node", "id": 6, "lat": 10.07, "lon": -30.07, "tags": {"place": "neighbourhood"}},
                {"type": "node", "id": 7, "lat": 10.08, "lon": -30.08, "tags": {"name": "Not A Hood", "place": "hamlet"}},
                {"type": "way", "id": 8, "tags": {"name": "No Centre", "place": "quarter"}},
            ],
        }
        hoods, dropped = b.neighbourhoods_from(payload, [])
        self.assertEqual(dropped, 1)
        self.assertEqual(
            [(h["name"], h["osmId"], h["kind"]) for h in hoods],
            [("Lantern Row", "node/1", "neighbourhood"), ("Lantern Row", "way/3", "suburb"), ("Millbrook", "relation/4", "suburb")],
        )
        self.assertEqual(hoods[2]["lat"], 10.05)


class Acs(unittest.TestCase):
    def test_adults_and_jam_values(self) -> None:
        vals = {"B01003_001E": "1000", "B01001_001E": "1000", "B01002_001E": "-666666666", "B19013_001E": "65000.4"}
        for v in b.B01001_UNDER21:
            vals[v] = "20"
        rec = b.acs_record(vals.get)
        self.assertEqual(rec, {"totalPop": 1000, "adults21": 760, "medianAge": None, "medianIncome": 65000})

    def test_missing_bins_make_adults_unknown(self) -> None:
        rec = b.acs_record({"B01003_001E": "500", "B01001_001E": "500"}.get)
        self.assertEqual(rec["totalPop"], 500)
        self.assertIsNone(rec["adults21"])


class GazetteerFiles(unittest.TestCase):
    def _zip(self, tmp: Path, text: str) -> Path:
        p = tmp / "gaz.zip"
        with zipfile.ZipFile(p, "w") as zf:
            zf.writestr("gaz.txt", text)
        return p

    def test_reads_pipe_and_tab_files(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            pipe = "GEOID|NAME|ALAND|INTPTLAT|INTPTLONG\n9900001|Big City city|900000000|10.0|-30.0\n"
            rows = b.read_gazetteer(self._zip(tmp, pipe))
            self.assertEqual(rows[0]["NAME"], "Big City city")
            tab = "GEOID\tNAME\tALAND\tINTPTLAT\tINTPTLONG             \n9900001\tBig City city\t900000000\t10.0\t-30.0             \n"
            rows = b.read_gazetteer(self._zip(tmp, tab))
            self.assertEqual(rows[0]["INTPTLONG"], "-30.0")

    def test_places_reaching_into_the_box_are_kept(self) -> None:
        box = {"south": 10.0, "west": -30.0, "north": 10.2, "east": -29.8}
        rows = [
            # Internal point ~5.5 km south of the box, but a ~17 km equivalent radius.
            {"GEOID": "1", "NAME": "Big City city", "ALAND": "900000000", "INTPTLAT": "9.95", "INTPTLONG": "-29.9"},
            # Same point, tiny place: dropped.
            {"GEOID": "2", "NAME": "Tiny CDP", "ALAND": "1000000", "INTPTLAT": "9.95", "INTPTLONG": "-29.9"},
            {"GEOID": "3", "NAME": "Inside town", "ALAND": "", "INTPTLAT": "10.1", "INTPTLONG": "-29.9"},
        ]
        places = b.places_for(rows, box)
        self.assertEqual([(p["name"], p["kind"]) for p in places], [("Big City", "incorporated"), ("Inside", "incorporated")])

    def test_zctas_use_a_padded_box(self) -> None:
        box = {"south": 10.0, "west": -30.0, "north": 10.2, "east": -29.8}
        rows = [
            {"GEOID": "99901", "ALAND": "1000000", "INTPTLAT": "9.98", "INTPTLONG": "-29.9"},  # ~2 km outside
            {"GEOID": "99902", "ALAND": "1000000", "INTPTLAT": "9.90", "INTPTLONG": "-29.9"},  # ~11 km outside
        ]
        self.assertEqual([z["zcta"] for z in b.zcta_points_for(rows, box)], ["99901"])


class ExitCode(unittest.TestCase):
    def _main(self, errors: list[str], zips_exit: int = 0) -> int:
        """main() with build() stubbed. main() also runs zips.py from HERE, which writes
        packages/gazetteer/src/zip-data.ts; a stub zips.py in a temp dir stands in for it,
        so the test writes nothing in the tree."""
        real_build, real_here = b.build, b.HERE
        with tempfile.TemporaryDirectory() as d:
            Path(d, "zips.py").write_text(f"def build(check=False):\n    return {zips_exit}\n", encoding="utf8")
            try:
                b.build = lambda metros, refresh, offline: {"metros": {"x": {"errors": errors}}}
                b.HERE = Path(d)
                return b.main(["--offline"])
            finally:
                b.build, b.HERE = real_build, real_here

    def test_source_errors_make_the_build_exit_nonzero(self) -> None:
        self.assertEqual(self._main(["osm: HTTP 504"]), 1)
        self.assertEqual(self._main([]), 0)

    def test_a_zip_table_gap_makes_the_build_exit_nonzero(self) -> None:
        self.assertEqual(self._main([], zips_exit=1), 1)

    def test_writes_nothing_in_the_tree(self) -> None:
        ts = b.ROOT / "packages" / "gazetteer" / "src" / "zip-data.ts"
        before = ts.stat().st_mtime_ns
        self._main([])
        self.assertEqual(ts.stat().st_mtime_ns, before)


class Output(unittest.TestCase):
    def test_dump_json_round_trips(self) -> None:
        doc = {"metro": "x", "bbox": {"south": 1, "west": 2, "north": 3, "east": 4}, "neighbourhoods": [{"name": "Ä", "lat": 1.0}], "zctas": []}
        self.assertEqual(json.loads(b.dump_json(doc)), doc)


if __name__ == "__main__":
    unittest.main()
