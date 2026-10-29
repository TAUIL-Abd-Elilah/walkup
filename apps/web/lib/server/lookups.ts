/**
 * Small read-only endpoints: remaining fresh runs, the Ticketmaster show
 * search behind the search box, the film/TV proxy search, and /healthz.
 */
import { FIXTURE_FRESH_RUNS_REASON, RECORDED_REASON } from "../api";
import { qlooUntil, runtimeMode } from "../mode";
import { ALL_PRESET_IDS } from "../plans";
import { depsFor, stores } from "./engine";
import { keyPresence } from "./env";
import { lastCalls, OPENROUTER_PROBE_URL, probes, PROBE_URLS, refreshProbes, type Service } from "./health";
import type { RequestContext } from "./http";
import { cleanText } from "./input";
import { qlooKeyRejection } from "./key-status";
import { freshRuns, rateLimit } from "./limits";
import { recordedPresetRun } from "./recorded";
import { searchProxyTitles, searchShows, type ProxyType } from "./search";
import { freshRunsBody, recordedRefusal, type ServiceResponse } from "./service";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Live title searches (one Qloo /search each) across all networks per day, beside the per-network window. */
export const PROXY_SEARCHES_PER_DAY = 100;

/** Where presets open in recorded state: reading routes only, since POST /api/plan runs nothing there. */
export const RECORDED_PRESETS =
  "unlimited: open /plan/<presetId> or GET /api/plan/<presetId> (or MCP plan_show {presetId}); these are recorded live runs or the bundled sample sheets. POST /api/plan runs nothing in recorded mode.";

export function limitsFor(ctx: RequestContext): ServiceResponse {
  const mode = runtimeMode();
  const st = freshRuns().status(ctx.ip);
  const live = mode.kind === "live";
  return {
    status: 200,
    body: {
      mode: mode.kind,
      freshRunsEnabled: live,
      // No counts where fresh runs are off: a remaining count there would read as runs on offer.
      freshRuns: live ? freshRunsBody(st) : null,
      presets: mode.kind === "recorded" ? RECORDED_PRESETS : "unlimited (served from stored runs or the fixture world)",
      ...(mode.kind === "fixture" ? { reason: FIXTURE_FRESH_RUNS_REASON } : mode.kind === "recorded" ? { reason: RECORDED_REASON } : {}),
    },
  };
}

export async function showSearch(q: string | null, ctx: RequestContext): Promise<ServiceResponse> {
  const mode = runtimeMode();
  if (mode.kind === "recorded") return recordedRefusal();
  if (mode.kind !== "live") return { status: 503, body: { mode: "fixture", reason: FIXTURE_FRESH_RUNS_REASON } };
  const text = cleanText(q ?? "", 200);
  if (!text || text.length < 2) return { status: 400, body: { reason: "Type at least two characters." } };
  const rl = rateLimit("show-search", ctx.ip, 60, HOUR);
  if (!rl.ok) return { status: 429, body: { reason: `Too many searches; try again in ${rl.retryAfterS} s.` } };
  try {
    const r = await searchShows(depsFor("live"), text, new Date().toISOString().slice(0, 10));
    return { status: 200, body: { query: r.query, events: r.hits, attribution: "Event data: Ticketmaster." } };
  } catch (err) {
    return { status: 502, body: { reason: `Ticketmaster search failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

export async function proxySearch(q: string | null, type: string | null, ctx: RequestContext): Promise<ServiceResponse> {
  const text = cleanText(q ?? "", 120);
  if (!text || text.length < 2) return { status: 400, body: { reason: "Type a film or TV title (at least two characters)." } };
  const t: ProxyType | "both" = type === "movie" || type === "tv_show" ? type : "both";
  const mode = runtimeMode();
  if (mode.kind === "recorded") return recordedRefusal();
  const rl = rateLimit("proxy-search", ctx.ip, mode.kind === "live" ? 20 : 120, HOUR);
  if (!rl.ok) return { status: 429, body: { reason: `Too many title searches; try again in ${rl.retryAfterS} s.` } };
  if (mode.kind === "live") {
    // Each live search spends Qloo quota outside the fresh-run caps, so all networks share a daily ceiling.
    const all = rateLimit("proxy-search-all", "all-networks", PROXY_SEARCHES_PER_DAY, DAY);
    if (!all.ok) return { status: 429, body: { reason: `Title searches are paused for today (${PROXY_SEARCHES_PER_DAY} per day); try again in ${all.retryAfterS} s.` } };
  }
  try {
    const candidates = await searchProxyTitles(depsFor(mode.kind), text, t);
    return { status: 200, body: { mode: mode.kind, query: text, type: t, candidates } };
  } catch (err) {
    return { status: 502, body: { reason: `Title search failed: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

/** For /healthz: the recorded run each preset shows (or would show) in recorded state; null for none. */
async function recordedPresets(): Promise<Record<string, { planId: string; createdAt: string } | null>> {
  const rows = await Promise.all(
    ALL_PRESET_IDS.map(async (id) => {
      const s = await recordedPresetRun(id).catch(() => null);
      return [id, s ? { planId: s.planId, createdAt: s.createdAt } : null] as const;
    }),
  );
  return Object.fromEntries(rows);
}

/**
 * GET /healthz: always 200 with ok: true (fixture, recorded and degraded states included),
 * within a second, without calling Qloo or any other API on the request path.
 */
export async function health(): Promise<ServiceResponse> {
  const mode = runtimeMode();
  const keys = keyPresence();
  const services: Service[] = ["qloo", "ticketmaster", "anthropic"];
  let quota: { remaining: number | null; limit: number | null; floor: number; guardTripped: boolean } | null = null;
  if (mode.kind === "live") {
    const wanted = services.filter((s) => (s === "qloo" ? keys.qloo : s === "ticketmaster" ? keys.ticketmaster : keys.llm !== null));
    const urls = keys.llm === "openrouter" ? { ...PROBE_URLS, anthropic: OPENROUTER_PROBE_URL } : PROBE_URLS;
    void refreshProbes(wanted, fetch, Date.now(), urls);
    try {
      const deps = depsFor("live");
      const q = deps.qloo.quota();
      quota = { remaining: q.remaining, limit: q.limit, floor: deps.qloo.config.monthGuardFloor, guardTripped: deps.qloo.guardTripped() };
    } catch {
      quota = null;
    }
  }
  const last = lastCalls();
  const probed = probes();
  const reachability = Object.fromEntries(
    services.map((s) => {
      if (mode.kind !== "live") return [s, { status: `not checked in ${mode.kind} mode` }];
      const p = probed[s];
      const l = last[s];
      const status = p ? (p.reachable ? "reachable" : "unreachable") : "checking";
      return [s, { status, ...(p ? { probe: p } : {}), ...(l ? { lastCall: l } : {}) }];
    }),
  );
  let store = "not opened yet";
  try {
    store = stores().kind;
  } catch {
    store = "unavailable";
  }
  const st = freshRuns().status(null);
  const rejected = qlooKeyRejection();
  const until = qlooUntil();
  return {
    status: 200,
    body: {
      ok: true,
      mode: mode.kind,
      detail: mode.detail,
      configured: keys,
      qloo: {
        keyRejected: rejected ? { httpStatus: rejected.httpStatus, at: rejected.at } : null,
        until: until === null ? null : new Date(until).toISOString(),
      },
      // Live mode lists what recorded state would serve, so the recordings can be checked before the key goes.
      recorded: mode.kind === "fixture" ? null : { presets: await recordedPresets() },
      reachability,
      qlooMonthlyRemaining: quota?.remaining ?? null,
      qlooMonthlyLimit: quota?.limit ?? null,
      quotaGuard: quota ? { floor: quota.floor, tripped: quota.guardTripped } : null,
      freshRunsEnabled: mode.kind === "live",
      freshRunsToday: mode.kind === "live" ? { used: st.total.used, limit: st.total.limit, remaining: st.total.remaining, day: st.day } : null,
      planStore: store,
      checkedAt: new Date().toISOString(),
    },
  };
}
