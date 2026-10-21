"""Offline tests for zips.py (no network). Run from the repo root:

    python -I data/gazetteer/test_zips.py -v
"""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location("gazetteer_zips", Path(__file__).resolve().parent / "zips.py")
assert _SPEC and _SPEC.loader
z = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(z)


class Inputs(unittest.TestCase):
    def test_every_built_zcta_has_a_row(self) -> None:
        places = z.read_zip_places()
        metros = z.read_metros()
        areas = z.read_areas()
        self.assertEqual(z.coverage_problems(places, metros, areas), [])

    def test_known_kinds_and_names(self) -> None:
        places = z.read_zip_places()
        self.assertEqual(places["20707"]["city"], "Laurel")
        self.assertEqual(places["20045"]["kind"], "unique")
        self.assertEqual(places["23665"]["kind"], "military")
        self.assertEqual(places["20742"]["kind"], "campus")

    def test_low_adult_zips_come_from_acs(self) -> None:
        metros = {"m": {"zctas": [{"zcta": "00001", "adults21": 10}, {"zcta": "00002", "adults21": 5000}, {"zcta": "00003", "adults21": None}]}}
        self.assertEqual(z.low_adult_zips(metros), ["00001"])

    def test_rejects_bad_rows(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "zips.csv"
            p.write_text("zip,city,kind,note\n2000,Somewhere,residential,\n", encoding="utf8")
            with self.assertRaises(ValueError):
                z.read_zip_places(p)
            p.write_text("zip,city,kind,note\n20001,Washington,office,\n", encoding="utf8")
            with self.assertRaises(ValueError):
                z.read_zip_places(p)


class Output(unittest.TestCase):
    def test_module_is_current(self) -> None:
        text = z.render_ts(z.read_zip_places(), z.low_adult_zips(z.read_metros()), z.read_areas())
        self.assertEqual(z.TS_OUT.read_text(encoding="utf8"), text, "run python -I data/gazetteer/zips.py")

    def test_render_is_deterministic_and_typed(self) -> None:
        places = {"20001": {"city": "Washington", "kind": "residential", "note": ""}}
        areas = {"dc": {"neighbourhoodCities": ["Washington"], "known": [{"name": "H Street NE", "lat": 38.9, "lon": -76.99, "radiusKm": 2.5}]}}
        a = z.render_ts(places, ["20045"], areas)
        self.assertEqual(a, z.render_ts(places, ["20045"], areas))
        self.assertIn('"20001": ["Washington", "residential"],', a)
        self.assertIn('{ metro: "dc", name: "H Street NE", lat: 38.9, lon: -76.99, radiusKm: 2.5 },', a)


if __name__ == "__main__":
    unittest.main()
