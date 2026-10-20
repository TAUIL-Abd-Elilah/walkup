/** Scenario knobs: switch on the edge cases the pipeline has fallbacks for. */

export interface Scenario {
  /** /v2/analysis/compare returns empty tags, a and b (forces the tag-diff fallback). */
  emptyCompare: boolean;
  /** Every heatmap is thin: fewer than 200 cells inside 40 km (the widen-to-60 km path). */
  thinHeatmap: boolean;
  /** Fixed x-month-ratelimit-remaining header (e.g. 1400, below the 1,500 floor). Null: a constant 9,000. */
  quotaRemaining: number | null;
  /** The first attempt of every distinct request answers 429 with Retry-After: 0; the retry succeeds. */
  rateLimitOnce: boolean;
  /** Share of generated places with is_closed: true. */
  closedRate: number;
  /** Share of generated places without an hours property. */
  noHoursRate: number;
  /** Denied example tags (ethnicity, inclusivity, credit card namespaces) appear on persons, places, tag profiles and compare. */
  deniedTags: boolean;
  /** Brand insights return nothing (sponsor card empty). */
  emptyBrands: boolean;
}

export const DEFAULT_SCENARIO: Scenario = {
  emptyCompare: false,
  thinHeatmap: false,
  quotaRemaining: null,
  rateLimitOnce: false,
  closedRate: 0.04,
  noHoursRate: 0.03,
  deniedTags: true,
  emptyBrands: false,
};
