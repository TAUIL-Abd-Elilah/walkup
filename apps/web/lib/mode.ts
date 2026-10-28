/**
 * Runtime mode for the site strip, the header note and the API. Read per
 * request (never at build time): the image is built without secrets.
 *
 * - recorded: live runs are paused. WALKUP_MODE=recorded, the time in
 *   WALKUP_QLOO_UNTIL has passed, or Qloo rejected the configured key while the
 *   plan store holds a live sheet. Sheets recorded from live runs are served as
 *   they were made; nothing new runs.
 * - live: QLOO_API_KEY and TICKETMASTER_API_KEY are set, WALKUP_MODE is not
 *   "fixture", and Qloo has not rejected the key.
 * - fixture: anything else, a rejected key with no live sheet stored included
 *   (a 401/403 seen by a live run switches the server until a different key is
 *   set). WALKUP_MODE=fixture keeps the synthetic world whatever the date.
 *
 * Reads key presence only, never values.
 */
import { envValue, walkupModeValue } from "@walkup/qloo";
import { formatStamp } from "./format";
import { lastQuota } from "./server/engine";
import { qlooKeyRejection } from "./server/key-status";
import { changesRecordedOnDay, liveSheetStored, recordedOnDay } from "./server/recorded";

export interface RuntimeMode {
  kind: "fixture" | "live" | "recorded";
  /** Short pill text. */
  label: string;
  /** One sentence for screen readers and the tooltip (recorded: what the site strip says). */
  detail: string;
  /** True when a fresh run can be requested from the search box. */
  liveSearch: boolean;
  /** Month quota last seen in Qloo's headers (live mode only). */
  quota?: { remaining: number | null; limit: number | null };
}

/** The live engine is wired in (orchestrator, exports, send). */
export const ENGINE_CONNECTED = true;

type Env = Record<string, string | undefined>;

export interface ModeOptions {
  /** Clock for WALKUP_QLOO_UNTIL (ms). Default: now. */
  now?: number;
  /** Whether the plan store holds a live sheet, asked only after a rejection. Default: the server's store. */
  liveSheetStored?: (rejectedAt: string) => boolean;
  /** The UTC day ("2026-10-21") the stored live sheets were recorded. Default: the newest in the server's store. */
  recordedOn?: () => string | null;
  /** The UTC day of the newest stored revision (ready-made changes). Default: the newest in the server's store. */
  changesRecordedOn?: () => string | null;
}

export function keysPresent(env: Env = process.env): boolean {
  return Boolean((env.QLOO_API_KEY ?? "").trim()) && Boolean((env.TICKETMASTER_API_KEY ?? "").trim());
}

const UNTIL_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?)?$/i;

/**
 * WALKUP_QLOO_UNTIL: the moment Qloo stops answering this server, as an ISO date or date and time in UTC
 * ("2026-11-02" is 00:00 UTC that day; a time without an offset is UTC). Null when unset or unreadable.
 */
export function qlooUntil(env: Env = process.env): number | null {
  const m = UNTIL_RE.exec(envValue(env, "WALKUP_QLOO_UNTIL") ?? "");
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2] ?? "00:00"}${(m[3] ?? "Z").toUpperCase()}`);
  return Number.isFinite(t) ? t : null;
}

/** "2026-10-21" -> "Oct 21 2026". */
function dayWords(ymd: string): string {
  return formatStamp(`${ymd}T12:00:00.000Z`).split(",")[0] ?? ymd;
}

/**
 * The recorded-mode sentence: when the sheets were recorded, that live runs are paused, and that the sheets are what
 * a live run produced. Said so it holds whether or not any live run was recorded (a preset without one shows a
 * sample sheet, marked so).
 */
export function recordedDetail(day: string | null, changesDay: string | null = null): string {
  const ok = (d: string | null): d is string => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  const when = ok(day) ? ` on ${dayWords(day)}` : "";
  // Ready-made changes recorded on a later day say so, so their sheets aren't dated by the earlier runs.
  const later = ok(day) && ok(changesDay) && changesDay > day ? `; changes recorded ahead on ${dayWords(changesDay)}` : "";
  return `Recorded from live Qloo and Ticketmaster runs${when}${later}. Live runs are paused for judging; these sheets are what a live run produced.`;
}

function recordedMode(day: string | null, changesDay: string | null = null): RuntimeMode {
  return {
    kind: "recorded",
    label: day ? `RECORDED · live runs of ${dayWords(day)}` : "RECORDED · live runs paused",
    detail: recordedDetail(day, changesDay),
    liveSearch: false,
  };
}

export function runtimeMode(env: Env = process.env, opts: ModeOptions = {}): RuntimeMode {
  const requested = walkupModeValue(env);
  const present = keysPresent(env);
  const rejected = present ? qlooKeyRejection(env) : null;
  if (requested !== "fixture") {
    const until = qlooUntil(env);
    const passed = until !== null && (opts.now ?? Date.now()) >= until;
    const stored = opts.liveSheetStored ?? liveSheetStored;
    if (requested === "recorded" || passed || (rejected && stored(rejected.at))) {
      let day: string | null = null;
      try {
        day = (opts.recordedOn ?? recordedOnDay)();
      } catch {
        day = null;
      }
      // A caller that fixes the recorded day without a changes day (tests) gets no changes clause.
      let changesDay: string | null = null;
      try {
        changesDay = (opts.changesRecordedOn ?? (opts.recordedOn ? () => null : changesRecordedOnDay))();
      } catch {
        changesDay = null;
      }
      return recordedMode(day, changesDay);
    }
  }
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
