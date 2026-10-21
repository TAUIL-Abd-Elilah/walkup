/**
 * Which US state a ZIP (ZCTA) or a Census GEOID is in, from fixed public tables: the USPS
 * 3-digit ZIP prefixes and the Census state FIPS codes. Pure and dependency-free, so the
 * exports and the web can label an area "Silver Spring, MD" without loading a gazetteer file.
 *
 * A ZCTA is not exactly a ZIP, but its first three digits follow the same prefix plan. Military
 * prefixes (AA, AE, AP) and unassigned prefixes return null.
 */

/** Census state FIPS code (2 digits) to USPS abbreviation: the 50 states, DC and Puerto Rico. */
export const STATE_FIPS: Readonly<Record<string, string>> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE",
  "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA",
  "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN",
  "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM",
  "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
  "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA",
  "54": "WV", "55": "WI", "56": "WY", "72": "PR",
};

/** USPS 3-digit ZIP prefix ranges, inclusive: [first, last, state]. */
const ZIP3_RANGES: readonly (readonly [number, number, string])[] = [
  [5, 5, "NY"], [6, 7, "PR"], [8, 8, "VI"], [9, 9, "PR"],
  [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"], [39, 49, "ME"],
  [50, 54, "VT"], [55, 55, "MA"], [56, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"],
  [100, 149, "NY"], [150, 196, "PA"], [197, 199, "DE"],
  [200, 200, "DC"], [201, 201, "VA"], [202, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"], [247, 268, "WV"],
  [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [320, 339, "FL"], [341, 349, "FL"],
  [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"],
  [400, 427, "KY"], [430, 459, "OH"], [460, 479, "IN"], [480, 499, "MI"],
  [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [569, 569, "DC"], [570, 577, "SD"], [580, 588, "ND"], [590, 599, "MT"],
  [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
  [700, 714, "LA"], [716, 729, "AR"], [730, 731, "OK"], [733, 733, "TX"], [734, 749, "OK"], [750, 799, "TX"],
  [800, 816, "CO"], [820, 831, "WY"], [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"],
  [885, 885, "TX"], [889, 898, "NV"],
  [900, 961, "CA"], [967, 968, "HI"], [969, 969, "GU"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

/** "MD" for "20910", "VA" for "22182", "DC" for "20002"; null for anything that is not a 5-digit ZIP with a state prefix. */
export function stateFromZip(zip: string | null | undefined): string | null {
  const z = String(zip ?? "").trim();
  if (!/^\d{5}$/.test(z)) return null;
  const p = Number(z.slice(0, 3));
  for (const [lo, hi, st] of ZIP3_RANGES) if (p >= lo && p <= hi) return st;
  return null;
}

/** "DC" for a Census GEOID starting "11" (place "1150000", ZCTA-free ids); null when the prefix is not a state. */
export function stateFromGeoid(geoid: string | null | undefined): string | null {
  const g = String(geoid ?? "").trim();
  if (!/^\d{2}/.test(g)) return null;
  return STATE_FIPS[g.slice(0, 2)] ?? null;
}

/**
 * The state of an area from its ZCTAs, nearest first (as the gazetteer and the lift tiles list them): the first
 * 5-digit ZCTA with a known prefix decides. Null when none does.
 */
export function stateFromZctas(zctas: readonly (string | null | undefined)[] | null | undefined): string | null {
  for (const z of zctas ?? []) {
    const st = stateFromZip(z);
    if (st) return st;
  }
  return null;
}
