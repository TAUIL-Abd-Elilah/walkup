import { json, otherMethods } from "@/lib/server/http";
import { health } from "@/lib/server/lookups";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /healthz: mode, key presence (never values), a rejected Qloo key and WALKUP_QLOO_UNTIL, the recorded
 * run per preset, reachability, Qloo month quota and fresh runs left.
 * Always 200 with ok: true, fast, and never calls an API on the request path: reachability comes from
 * the last real calls and from a keyless background probe at most every 10 minutes (live mode only).
 */
export async function GET(): Promise<Response> {
  const res = await health();
  return json(res.body, res.status);
}

/** Any other method: 405 with a reason and Allow: GET, HEAD, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("GET");
export const POST = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
