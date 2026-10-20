/**
 * Request plumbing for route handlers: client IP (for caps, kept only as a
 * keyed hash downstream), origin, and the one functional cookie (a random
 * session id that scopes the operator's remembered picks and preset actions).
 */
import { randomBytes } from "node:crypto";
import { FIXTURE_FRESH_RUNS_REASON, json } from "../api";
import { runtimeMode } from "../mode";

export const SESSION_COOKIE = "hl_sid";
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;

type HeaderBag = { get(name: string): string | null };

/** Fly sets Fly-Client-IP; other proxies X-Forwarded-For / X-Real-IP. */
export function clientIp(h: HeaderBag): string | null {
  const fly = h.get("fly-client-ip")?.trim();
  if (fly) return fly;
  const xff = h.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = h.get("x-real-ip")?.trim();
  return real || null;
}

export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ?? request.headers.get("host")?.trim();
  if (host && /^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) return `${proto === "http" || proto === "https" ? proto : url.protocol.replace(":", "")}://${host}`;
  return url.origin;
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      // A malformed escape in some other cookie on this host must not fail the request.
      out[k] = v;
    }
  }
  return out;
}

export function sessionFrom(h: HeaderBag): string | null {
  const sid = parseCookies(h.get("cookie"))[SESSION_COOKIE];
  return sid && SID_RE.test(sid) ? sid : null;
}

export function newSessionId(): string {
  return randomBytes(18).toString("base64url");
}

export function sessionCookie(sid: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sid}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

export interface RequestContext {
  ip: string | null;
  sessionId: string | null;
  origin: string;
}

/** Reads the context; creates a session id when `ensureSession` and none exists (set it with withSession). */
export function contextOf(request: Request, ensureSession = false): RequestContext & { newSession: boolean } {
  let sid = sessionFrom(request.headers);
  let created = false;
  if (!sid && ensureSession) {
    sid = newSessionId();
    created = true;
  }
  return { ip: clientIp(request.headers), sessionId: sid, origin: requestOrigin(request), newSession: created };
}

export { json };

/** Free-form runs need live keys; the skill maps 503 + mode "fixture" to its fixture-mode exit code. */
export function freshRunsDisabled(): Response {
  return json({ mode: runtimeMode().kind, reason: FIXTURE_FRESH_RUNS_REASON }, 503);
}

/** Adds the session cookie to a response when the context created one. */
export function withSession(res: Response, ctx: { sessionId: string | null; newSession: boolean; origin: string }): Response {
  if (ctx.newSession && ctx.sessionId) res.headers.append("set-cookie", sessionCookie(ctx.sessionId, ctx.origin.startsWith("https:")));
  return res;
}

/** Reads a JSON body of at most `maxBytes`; null when absent or invalid. */
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  const text = await request.text();
  if (text.length > maxBytes) return { ok: false, reason: `Body too large (over ${Math.round(maxBytes / 1024)} KB).` };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "Body is not valid JSON." };
  }
}
