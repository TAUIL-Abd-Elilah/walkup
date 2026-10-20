/** Shared types for the day-one probe (scripts/probe.ts). */

import type { ProbeConfig } from "./config.js";

export type HttpMethod = "GET" | "POST";
export type ParamValue = string | number | boolean;

/** One planned request. GET params go in the query string; POST sends `body` as JSON. */
export interface RequestSpec {
  method: HttpMethod;
  /** Path only, e.g. "/v2/insights". Never contains the host or the key. */
  path: string;
  params: Record<string, ParamValue>;
  body?: Record<string, unknown>;
  /** Short human label for logs and the dry-run listing. */
  label: string;
  /** "signal-check": a resolver call that asks which ids Qloo can use (its not_found warnings are expected). */
  purpose?: "signal-check";
}

/** What gets logged and saved for each request. Contains no response body. */
export interface CallRecord {
  /** 1-based number of the API call (or planned call) in this run; memo hits reuse the original number. */
  seq: number;
  label: string;
  method: HttpMethod;
  path: string;
  params: Record<string, ParamValue>;
  body?: Record<string, unknown>;
  status: number | null;
  ms: number;
  bytes: number;
  /** HTTP attempts spent on this request (retries included). 0 for memo hits and dry runs. */
  attempts: number;
  /** True when the same request already ran in this run and its in-memory result was reused. */
  memo: boolean;
  /** All response headers of the last attempt (values that could echo a secret are redacted). */
  headers: Record<string, string>;
  error?: string;
  /** Signal ids a 2xx body reported as not_found (ids only, a derived value). */
  notFound?: string[];
  /** Parameter names a 4xx body blamed in errors[].path. */
  errorPaths?: string[];
  purpose?: "signal-check";
}

/** In-memory result of a call. `json` is never written to disk. */
export interface CallResult {
  dry: boolean;
  status: number | null;
  json: unknown;
  record: CallRecord;
}

export type ProbeStatus =
  | "pass"
  | "partial"
  | "fail"
  | "inconclusive"
  | "info"
  | "skipped"
  | "planned"
  | "error"
  | "aborted";

/** Derived values only: counts, ranks, overlaps, correlations, flags and ids. */
export type Derived = Record<string, unknown>;

export interface ProbeOutcome {
  status: ProbeStatus;
  /** One short line of key numbers for the verdict table. */
  headline: string;
  /** Detail lines for SUMMARY.md. */
  lines: string[];
  derived: Derived;
}

export type GateId = "KG1" | "KG2" | "KG3" | "KG4";

export interface ProbeDef {
  id: number;
  slug: string;
  title: string;
  /** Run first, in this order, so the gate verdicts exist early. */
  group?: 1 | 2 | 3;
  gate?: GateId;
  criterion: string;
  ifFails: string;
  /** Upper bound on new API calls this probe makes on its own (memo hits excluded). */
  maxCalls: number;
  run(ctx: ProbeContext): Promise<ProbeOutcome>;
}

/** State shared between probes inside one run. */
export interface SharedState {
  /** Set by probe 15: whether filter.results.entities.query resolved names. */
  nameQueryWorks?: boolean;
}

export interface ProbeContext {
  dryRun: boolean;
  cfg: ProbeConfig;
  call(spec: RequestSpec): Promise<CallResult>;
  state: SharedState;
  log(line: string): void;
  /** Reads an optional private input file (e.g. the P1 bar list). Returns null when absent. */
  readOptionalJson(relPath: string): unknown;
}
