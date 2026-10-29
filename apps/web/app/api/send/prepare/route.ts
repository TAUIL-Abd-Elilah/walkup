import { contextOf, json, otherMethods, readJson, withSession } from "@/lib/server/http";
import { prepareSendFor } from "@/lib/server/send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/send/prepare {planId, copyTo?, attachments?}: the real preview and a confirm token. Nothing is sent. */
export async function POST(request: Request): Promise<Response> {
  const body = await readJson(request, 8 * 1024);
  if (!body.ok) return json({ status: "refused", reason: body.reason }, 400);
  // The session keeps a send recorded on a shared preset sheet with this visitor only.
  const ctx = contextOf(request, true);
  const res = await prepareSendFor(body.value, ctx);
  return withSession(json(res.body, res.status), ctx);
}

/** Any other method: 405 with a reason and Allow: POST, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("POST");
export const GET = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
