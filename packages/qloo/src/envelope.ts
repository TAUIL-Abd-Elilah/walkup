/** Helpers that turn client results and typed errors into contract envelopes. */
import type { Envelope, EnvelopeStatus } from "@walkup/contracts";
import {
  QlooConfigError,
  QlooError,
  QlooFixtureMissingError,
  QlooHostRefusedError,
  QlooHttpError,
  QlooNetworkError,
  QlooQuotaGuardError,
} from "./errors";
import type { QlooResult } from "./types";

export interface ErrorStatus {
  status: EnvelopeStatus;
  reason: string;
  ledgerRef?: string;
}

/**
 * Fixture misses and the month guard are "degraded" (the app still works from
 * what it has); HTTP, network and configuration failures are "error". A 400 that
 * blames signal.interests.entities (every signal id unknown to Qloo) says so.
 */
export function errorStatus(err: unknown): ErrorStatus {
  const ledgerRef = err instanceof QlooError ? err.ledgerRef : undefined;
  const withRef = (s: EnvelopeStatus, reason: string): ErrorStatus => (ledgerRef ? { status: s, reason, ledgerRef } : { status: s, reason });
  if (err instanceof QlooFixtureMissingError) return withRef("degraded", "No recorded answer for this request (fixture mode)");
  if (err instanceof QlooQuotaGuardError) return withRef("degraded", `Monthly Qloo quota is low (${err.remaining} left); fresh calls are paused`);
  if (err instanceof QlooHttpError && err.signalNotFound) {
    return withRef("error", "Qloo has no taste data for any act sent, so it answered nothing (HTTP 400). Check the act matches and run again.");
  }
  if (err instanceof QlooHttpError) return withRef("error", `Qloo returned HTTP ${err.status}`);
  if (err instanceof QlooNetworkError) return withRef("error", "Qloo could not be reached after retries");
  if (err instanceof QlooHostRefusedError) return withRef("error", "Qloo host refused by configuration");
  if (err instanceof QlooConfigError) return withRef("error", err.message);
  return withRef("error", err instanceof Error ? err.message : String(err));
}

export function toEnvelope<T>(r: QlooResult<T>, summary: string, limits: string[] = []): Envelope<T> {
  const env: Envelope<T> = { status: r.status, summary, results: r.value, provenance: [...r.ledgerRefs], limits };
  if (r.reason) env.reason = r.reason;
  return env;
}

export function errorEnvelope<T>(err: unknown, empty: T, summary: string, limits: string[] = []): Envelope<T> {
  const s = errorStatus(err);
  return { status: s.status, summary, results: empty, reason: s.reason, provenance: s.ledgerRef ? [s.ledgerRef] : [], limits };
}
