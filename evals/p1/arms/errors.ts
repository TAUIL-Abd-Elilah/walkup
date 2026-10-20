/**
 * Errors that stop a P1 run. Everything already fetched stays in the run cache, so a stop
 * never loses work: re-running the same command resumes. Query-level failures (a call that
 * still fails after its retries) are not errors here; they are counted and leave no rows.
 */

export type StopKind =
  | "qloo_budget" // per-run Qloo call cap reached (--max-qloo-calls)
  | "qloo_quota" // @walkup/qloo month guard refused a fresh call
  | "places_daily" // Google Places daily cap reached
  | "places_total" // the plan's 2,500 Places requests are used up
  | "llm_spend" // daily model spend cap reached
  | "filter_not_honoured" // §8: a Q arm returned a place more than 26 km from P
  | "fatal_api" // a request-shape or credential error that would fail every call
  | "resolution_failed" // a resolution call still failed after retries (the coverage table must be complete)
  | "config"; // missing keys, unreadable inputs, inconsistent state

/** Exit code per kind: 3 = stopped by a guard (re-run to resume), 4 = protocol stop, 2 = config, 1 = other. */
export const EXIT_CODES: Record<StopKind, number> = {
  qloo_budget: 3,
  qloo_quota: 3,
  places_daily: 3,
  places_total: 3,
  llm_spend: 3,
  filter_not_honoured: 4,
  fatal_api: 1,
  resolution_failed: 1,
  config: 2,
};

export class StopRunError extends Error {
  readonly kind: StopKind;
  constructor(kind: StopKind, message: string) {
    super(message);
    this.name = "StopRunError";
    this.kind = kind;
  }
  get exitCode(): number {
    return EXIT_CODES[this.kind];
  }
}

export function isStop(err: unknown): err is StopRunError {
  return err instanceof StopRunError;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
