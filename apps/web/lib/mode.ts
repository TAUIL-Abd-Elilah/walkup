/**
 * Runtime mode for the status pill, the watermark and the API. Read per
 * request (never at build time): the image is built without secrets.
 *
 * Live only when QLOO_API_KEY and TICKETMASTER_API_KEY are set, WALKUP_MODE
 * is not "fixture", and Qloo has not rejected the key (a 401/403 seen by a live
 * run switches the server to fixture mode until a different key is set).
 * Reads key presence only, never values.
 */
import { qlooKeyRejection } from "./server/key-status";

export interface RuntimeMode {
  kind: "fixture" | "live";
  /** Short pill text. */
  label: string;
  /** One sentence for screen readers and the tooltip. */
  detail: string;
  /** True when a fresh run can be requested from the search box. */
  liveSearch: boolean;
  /** Month quota last seen in Qloo's headers (live mode only). */
  quota?: { remaining: number | null; limit: number | null };
}

/** The live engine is wired in (orchestrator, exports, send). */
export const ENGINE_CONNECTED = true;

type Env = Record<string, string | undefined>;

/** Latest Qloo month quota, published by the server engine after each live run. */
interface QuotaSlot {
  remaining: number | null;
  limit: number | null;
}
const QUOTA_KEY = "__walkupQlooQuota";

export function publishQuota(q: QuotaSlot): void {
  (globalThis as Record<string, unknown>)[QUOTA_KEY] = q;
}

function lastQuota(): QuotaSlot | null {
  const v = (globalThis as Record<string, unknown>)[QUOTA_KEY];
  return v && typeof v === "object" ? (v as QuotaSlot) : null;
}

export function keysPresent(env: Env = process.env): boolean {
  return Boolean((env.QLOO_API_KEY ?? "").trim()) && Boolean((env.TICKETMASTER_API_KEY ?? "").trim());
}

export function runtimeMode(env: Env = process.env): RuntimeMode {
  const requested = (env.WALKUP_MODE ?? "auto").trim().toLowerCase();
  const present = keysPresent(env);
  const rejected = present ? qlooKeyRejection(env) : null;
  const live = ENGINE_CONNECTED && present && requested !== "fixture" && !rejected;
  if (live) {
    const q = lastQuota();
    const left = q?.remaining !== null && q?.remaining !== undefined ? ` · ${q.remaining.toLocaleString("en-US")} calls left this month` : "";
    return {
      kind: "live",
      label: `LIVE · Qloo${left}`,
      detail: "Fresh runs call Qloo and Ticketmaster. Presets are served from stored runs.",
      liveSearch: true,
      ...(q ? { quota: { remaining: q.remaining, limit: q.limit } } : {}),
    };
  }
  let detail: string;
  if (rejected) {
    detail = `Qloo rejected the configured key (HTTP ${rejected.httpStatus}, ${rejected.at.slice(0, 10)}), so the server replays fixtures. Fresh runs are disabled.`;
  } else if (present && requested === "fixture") {
    detail = "Keys found, but WALKUP_MODE=fixture. Presets run on the synthetic fixture world; no API is called.";
  } else {
    detail = "No keys configured. Presets run on a synthetic fixture world; no API is called and fresh runs are disabled.";
  }
  return { kind: "fixture", label: "FIXTURE · synthetic sheets", detail, liveSearch: false };
}
