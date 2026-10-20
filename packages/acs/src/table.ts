/**
 * ACS variable ids and the parser for Census's array-of-arrays JSON.
 */

/** Table B01003 Total population. */
export const VAR_TOTAL_POPULATION = "B01003_001E";
/** Table B01002 Median age, both sexes. */
export const VAR_MEDIAN_AGE = "B01002_001E";
/** Table B19013 Median household income in the past 12 months (inflation-adjusted dollars). */
export const VAR_MEDIAN_HOUSEHOLD_INCOME = "B19013_001E";
/** Table B01001 Sex by age: total. Adults 21+ are derived from this table so the bins add up. */
export const VAR_SEX_BY_AGE_TOTAL = "B01001_001E";

/**
 * B01001 male bins under 21: Under 5 (003), 5-9 (004), 10-14 (005), 15-17 (006),
 * 18-19 (007), 20 (008). Bin 009 is "21 years".
 */
export const VARS_MALE_UNDER_21 = ["B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E", "B01001_007E", "B01001_008E"] as const;

/**
 * B01001 female bins under 21: Under 5 (027), 5-9 (028), 10-14 (029), 15-17 (030),
 * 18-19 (031), 20 (032). Bin 033 is "21 years".
 */
export const VARS_FEMALE_UNDER_21 = ["B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E", "B01001_031E", "B01001_032E"] as const;

/** Everything one request asks for (17 variables; the API allows 50). */
export const ACS_GET_VARIABLES = [
  "NAME",
  VAR_TOTAL_POPULATION,
  VAR_MEDIAN_AGE,
  VAR_MEDIAN_HOUSEHOLD_INCOME,
  VAR_SEX_BY_AGE_TOTAL,
  ...VARS_MALE_UNDER_21,
  ...VARS_FEMALE_UNDER_21,
] as const;

/**
 * Census "jam values": negative sentinels meaning the estimate is not available
 * (-666666666 = could not be computed, -999999999 = sample too small, ...).
 */
export const CENSUS_SENTINELS = new Set([
  -111111111, -222222222, -333333333, -555555555, -666666666, -777777777, -888888888, -999999999,
]);

/** Number or null. Sentinels, blanks, nulls and non-numeric annotations become null. */
export function parseCensusNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : Number.NaN;
  if (!Number.isFinite(n)) return null;
  if (CENSUS_SENTINELS.has(n)) return null;
  return n;
}

export type CensusRecord = Record<string, string | null>;

/**
 * Parses `[[header...], [row...], ...]` into records keyed by header. Throws when
 * the shape is wrong; tolerates short rows (missing cells become null) and
 * number/null cells.
 */
export function parseCensusTable(body: unknown): CensusRecord[] {
  if (!Array.isArray(body) || body.length === 0 || !Array.isArray(body[0])) {
    throw new TypeError("Census body is not an array of arrays with a header row");
  }
  const header = (body[0] as unknown[]).map((h) => String(h));
  const out: CensusRecord[] = [];
  for (const row of body.slice(1)) {
    if (!Array.isArray(row)) continue;
    const rec: CensusRecord = {};
    header.forEach((h, i) => {
      const cell: unknown = row[i];
      rec[h] = cell === null || cell === undefined ? null : String(cell);
    });
    out.push(rec);
  }
  return out;
}

/**
 * Adults 21+ = B01001_001E minus the twelve under-21 bins listed above.
 * Null when the total or any bin is missing (no partial guesses), and null when the
 * bins exceed the total: B01001 bins sum to the total, so that row is inconsistent.
 */
export function adults21PlusOf(rec: CensusRecord): number | null {
  const total = parseCensusNumber(rec[VAR_SEX_BY_AGE_TOTAL]);
  if (total === null) return null;
  let under21 = 0;
  for (const id of [...VARS_MALE_UNDER_21, ...VARS_FEMALE_UNDER_21]) {
    const v = parseCensusNumber(rec[id]);
    if (v === null) return null;
    under21 += v;
  }
  const adults = total - under21;
  return adults >= 0 ? adults : null;
}
