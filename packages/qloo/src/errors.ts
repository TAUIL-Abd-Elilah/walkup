/** Typed errors. Every error thrown by request() carries the ledger id of its entry. */

export class QlooError extends Error {
  /** Ledger id ("Q7") of the entry that recorded this failure, when one was written. */
  ledgerRef?: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** One entry of a Qloo 4xx body: `{"errors":[{"message","path"}]}` (live, Oct 15). */
export interface QlooErrorDetail {
  message: string;
  /** The request parameter Qloo blames, e.g. "signal.interests.entities". */
  path?: string;
}

/** The parameter Qloo names when every signal id was unknown to it. */
export const SIGNAL_ENTITIES_PARAM = "signal.interests.entities";

/**
 * Reads `{"errors":[{message, path}]}` from an error body (string or parsed).
 * Anything else gives []. Never throws.
 */
export function parseQlooErrors(body: unknown): QlooErrorDetail[] {
  let v = body;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return [];
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [];
  const list = (v as Record<string, unknown>).errors;
  if (!Array.isArray(list)) return [];
  const out: QlooErrorDetail[] = [];
  for (const e of list) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    const message = typeof r.message === "string" ? r.message : "";
    const path = typeof r.path === "string" && r.path.trim() !== "" ? r.path.trim() : undefined;
    if (!message && !path) continue;
    out.push(path ? { message, path } : { message });
  }
  return out;
}

/** Non-2xx answer after retries (or a 2xx with an unreadable body). */
export class QlooHttpError extends QlooError {
  readonly status: number;
  /** First 300 chars of the body, with the key redacted. */
  readonly bodySnippet: string;
  readonly endpoint: string;
  /** Parsed `errors[]` from the body (empty when the body had another shape). */
  readonly qlooErrors: QlooErrorDetail[];
  constructor(status: number, bodySnippet: string, endpoint = "", qlooErrors: QlooErrorDetail[] = []) {
    super(`Qloo ${endpoint || "request"} failed with HTTP ${status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
    this.status = status;
    this.bodySnippet = bodySnippet;
    this.endpoint = endpoint;
    this.qlooErrors = qlooErrors;
  }

  /** True when Qloo refused the call because none of the signal ids were usable (it blames signal.interests.entities). */
  get signalNotFound(): boolean {
    return this.status === 400 && this.qlooErrors.some((e) => e.path !== undefined && e.path.endsWith(SIGNAL_ENTITIES_PARAM));
  }
}

/** A 400 whose errors[].path is signal.interests.entities: every signal id was unknown to Qloo. */
export function isSignalNotFoundError(err: unknown): err is QlooHttpError {
  return err instanceof QlooHttpError && err.signalNotFound;
}

/** The month guard refused a fresh call (remaining quota below the floor). Cached answers are still served. */
export class QlooQuotaGuardError extends QlooError {
  readonly remaining: number;
  readonly floor: number;
  constructor(remaining: number, floor: number) {
    super(`Monthly Qloo quota guard: ${remaining} calls left (floor ${floor}); fresh calls are paused, cached answers still work`);
    this.remaining = remaining;
    this.floor = floor;
  }
}

/** Fixture mode found no recorded or synthetic body for this request. */
export class QlooFixtureMissingError extends QlooError {
  readonly hash: string;
  readonly key: string;
  constructor(hash: string, key: string) {
    super(`No fixture for ${key} (expected fixtures/raw/${hash}.json or fixtures/synthetic/${hash}.json)`);
    this.hash = hash;
    this.key = key;
  }
}

/** QLOO_BASE_URL points somewhere other than the hackathon host and QLOO_ALLOW_HOST is not set. */
export class QlooHostRefusedError extends QlooError {
  readonly host: string;
  constructor(host: string) {
    super(`Refusing Qloo host "${host}": only https://hackathon.api.qloo.com is allowed (set QLOO_ALLOW_HOST=1 to override)`);
    this.host = host;
  }
}

/** Network failure (DNS, reset, timeout) after all retries. */
export class QlooNetworkError extends QlooError {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(`Qloo network error after ${attempts} attempt(s): ${message}`);
    this.attempts = attempts;
  }
}

/** Misconfiguration (e.g. WALKUP_MODE=live without a key). */
export class QlooConfigError extends QlooError {}
