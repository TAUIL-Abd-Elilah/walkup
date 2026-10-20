/**
 * /mcp: the Walkup MCP server over Streamable HTTP (stateless, JSON
 * responses). Tools: plan_show, rank_partners, bill_vs_house, get_sheet, each
 * returning the same envelope as the JSON API. Keys stay on this server.
 *
 * It runs on the web app's own engine, so both front doors behave alike: the
 * same orchestrator deps and plan store (plans made here open at /s/<planId>),
 * the same preset sheets, the same per-IP fresh-run allowance, the same
 * fixture-mode rule (presets only), and the same quota and rejected-key
 * bookkeeping after live runs.
 *
 * Add it to Claude Code with: claude mcp add --transport http walkup <origin>/mcp
 */
import type { PlanDeps, PlanResult } from "@walkup/orchestrator";
import {
  createMcpServices,
  handleMcpHttpRequest,
  secretsFromEnv,
  type CapDecision,
  type FreshRunLimiter,
  type McpServices,
  type PlanView,
} from "@walkup/mcp";
import { runtimeMode } from "@/lib/mode";
import { depsFor, publishLiveQuota, stores } from "@/lib/server/engine";
import { clientIp, requestOrigin } from "@/lib/server/http";
import { noteQlooRejection } from "@/lib/server/key-status";
import { freshRuns, utcDay, type FreshRunStatus } from "@/lib/server/limits";
import { loadPlan } from "@/lib/server/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Mode = "live" | "fixture";

/** The web app's per-IP limiter behind the MCP interface: REST and MCP draw on one allowance. */
function webLimiter(): FreshRunLimiter {
  const decision = (s: FreshRunStatus, allowed: boolean): CapDecision => ({
    allowed,
    ...(!allowed && s.reason ? { reason: `limit reached: ${s.reason}` } : {}),
    leftForCaller: s.you.remaining,
    leftToday: s.total.remaining,
  });
  return {
    check: (ip) => {
      const s = freshRuns().status(ip);
      return decision(s, s.allowed);
    },
    take: (ip) => {
      const before = freshRuns().status(ip);
      if (!before.allowed) return decision(before, false);
      const after = freshRuns().take(ip);
      // Taking the last slot reports "not allowed" for the next run; this one was counted and goes ahead.
      return decision(after, after.you.used > before.you.used);
    },
    refund: (ip, now) => freshRuns().refund(ip, utcDay(now)),
  };
}

/** Presets show what the web app shows for them (its preset sheets, or the pick a preset waits for). */
async function presetView(presetId: string, view: "page" | "api"): Promise<PlanView | null> {
  const v = await loadPlan(presetId, { view, sessionId: null });
  if (!v) return null;
  switch (v.kind) {
    case "sheet":
      return { kind: "sheet", sheet: v.sheet, presetId };
    case "paused":
      return { kind: "paused", planId: v.planId, mode: v.mode, pause: { resolution: v.pause.resolution, pending: v.pause.pending }, presetId };
    case "error":
      return { kind: "error", planId: v.planId, mode: v.mode, reason: v.error };
    default:
      return null;
  }
}

function afterRun(mode: Mode, result: PlanResult, deps: PlanDeps): void {
  if (mode !== "live") return;
  publishLiveQuota(deps);
  noteQlooRejection(result.sheet?.ledger ?? result.pause?.ledger ?? []);
}

const SERVICES_KEY = Symbol.for("walkup.web.mcpServices");

/** One set of MCP services per runtime mode, shared by every request in this process. */
function servicesFor(mode: Mode): McpServices {
  const g = globalThis as unknown as Record<symbol, Partial<Record<Mode, McpServices>> | undefined>;
  const cache = (g[SERVICES_KEY] ??= {});
  let s = cache[mode];
  if (!s) {
    s = createMcpServices({
      deps: depsFor(mode),
      store: stores().plans,
      limiter: webLimiter(),
      secrets: secretsFromEnv(process.env),
      policy: { fixtureEventRuns: false, capFixtureRuns: false },
      presetView,
      afterRun: (result, deps) => afterRun(mode, result, deps),
    });
    cache[mode] = s;
  }
  return s;
}

function handle(request: Request): Promise<Response> {
  const mode = runtimeMode().kind;
  return handleMcpHttpRequest(request, servicesFor(mode), { clientIp, origin: requestOrigin(request) });
}

/** JSON-RPC messages from the client. */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

/** Stateless server: no standalone event stream (405). */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

/** Stateless server: no session to end (405). */
export async function DELETE(request: Request): Promise<Response> {
  return handle(request);
}
