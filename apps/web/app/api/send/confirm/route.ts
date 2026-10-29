import { contextOf, json, otherMethods, readJson, withSession } from "@/lib/server/http";
import { confirmSendFor } from "@/lib/server/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/send/confirm {planId, confirmToken}: sends (or records "demo: not sent") and writes one A# entry. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request, 16 * 1024);
  if (!body.ok) return json({ status: "refused", reason: body.reason }, 400);
  const ctx = contextOf(request, true);
  const res = await confirmSendFor(body.value, ctx);
  return withSession(json(res.body, res.status), ctx);
}

/** Any other method: 405 with a reason and Allow: POST, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("POST");
export const GET = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
