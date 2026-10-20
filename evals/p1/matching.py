"""Name similarity, distance and US address helpers used by the P1 plan.

The functions here are the exact definitions referenced in
docs/preregistration/p1-plan.md (section "Resolution rule"). Changing their
behaviour after the plan is sealed is a protocol deviation and must be logged.
"""

from __future__ import annotations

import difflib
import math
import re
import unicodedata

US_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming", "PR": "Puerto Rico",
}
STATE_BY_NAME = {v.casefold(): k for k, v in US_STATES.items()}

NAME_SIM_THRESHOLD = 0.85
RESOLVE_RADIUS_M = 300.0


def normalize_name(s: str) -> str:
    """Casefold, strip accents, '&' -> 'and', drop apostrophes, other punctuation -> space,
    collapse whitespace, drop one leading 'the'."""
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.casefold().replace("&", " and ")
    s = re.sub(r"['‘’ʼ`]", "", s)
    s = re.sub(r"[^0-9a-z]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    if s.startswith("the "):
        s = s[4:]
    return s


def _ratio(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def _contiguous_run(short: list[str], long: list[str]) -> bool:
    n = len(short)
    return any(long[i : i + n] == short for i in range(len(long) - n + 1))


def name_similarity(a: str, b: str) -> float:
    """max(ratio(normalized), ratio(sorted tokens), containment).

    containment = 1.0 when the shorter normalized token list has at least two
    tokens and appears as a contiguous run inside the longer list
    ("Boot Room" inside "Boot Room and Beer Study Durham"), else 0.0.
    """
    na, nb = normalize_name(a), normalize_name(b)
    ta, tb = na.split(), nb.split()
    best = max(_ratio(na, nb), _ratio(" ".join(sorted(ta)), " ".join(sorted(tb))))
    short, long = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if len(short) >= 2 and _contiguous_run(short, long):
        best = max(best, 1.0)
    return round(best, 6)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


_ZIP = re.compile(r"^\d{5}(?:-\d{4})?$")
_STATE_ZIP = re.compile(r"^([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?)$")
_CITY_STATE_ZIP = re.compile(r"^(.*?)[,\s]+([A-Za-z]{2})\.?[,\s]+(\d{5}(?:-\d{4})?)$")
_CITY_STATE = re.compile(r"^(.*?)[,\s]+([A-Za-z]{2})\.?$")


def split_us_address(address: str) -> tuple[str, str]:
    """Return (city, state_abbr) from a one-line US address, or ("", "") if not parseable."""
    city, state = _split_us_address(address)
    if city and re.match(r"^\d", city):
        # "1802 Memorial Ave SW Roanoke": no comma between street and city. Take the words
        # after the last street-type / directional token as the city.
        m = _STREET_TAIL.match(city)
        city = m.group(1).strip() if m else ""
    if not city:
        return "", ""
    return city, state


_STREET_TAIL = re.compile(
    r"^\d.*\b(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|pkwy|parkway|hwy|"
    r"highway|pl|place|ct|court|ter|terrace|cir|circle|sq|square|pike|fwy|nw|ne|sw|se)\.?\s+"
    r"([A-Za-z][A-Za-z .'-]*)$",
    re.I,
)


def _split_us_address(address: str) -> tuple[str, str]:
    """Parse helper for split_us_address.

    Handles "2501 University Dr, Durham, NC, 27707", "130 31st Street S #105, Birmingham, AL 35222",
    "340 N. 6th Ave., Tucson AZ 85705" and "Washington DC, 20009".
    """
    parts = [p.strip() for p in (address or "").split(",") if p.strip()]
    if not parts:
        return "", ""
    # Trailing zip as its own component.
    if _ZIP.match(parts[-1]):
        parts = parts[:-1]
        if not parts:
            return "", ""
        last = parts[-1]
        if re.fullmatch(r"[A-Za-z]{2}\.?", last) and last.upper().rstrip(".") in US_STATES and len(parts) >= 2:
            return parts[-2], last.upper().rstrip(".")
        if last.casefold() in STATE_BY_NAME and len(parts) >= 2:
            # "45 Romney Street, Charleston, South Carolina, 29403"
            return parts[-2], STATE_BY_NAME[last.casefold()]
        m = _CITY_STATE.match(last)
        if m and m.group(2).upper() in US_STATES:
            return m.group(1).strip(), m.group(2).upper()
        return "", ""
    last = parts[-1]
    m = _STATE_ZIP.match(last)
    if m and m.group(1).upper() in US_STATES and len(parts) >= 2:
        return parts[-2], m.group(1).upper()
    m = _CITY_STATE_ZIP.match(last)
    if m and m.group(2).upper() in US_STATES:
        return m.group(1).strip(), m.group(2).upper()
    if re.fullmatch(r"[A-Za-z]{2}\.?", last) and last.upper().rstrip(".") in US_STATES and len(parts) >= 2:
        return parts[-2], last.upper().rstrip(".")
    m = _CITY_STATE.match(last)
    if m and m.group(2).upper() in US_STATES:
        return m.group(1).strip(), m.group(2).upper()
    return "", ""
