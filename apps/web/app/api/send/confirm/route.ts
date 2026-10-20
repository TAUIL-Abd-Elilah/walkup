import { contextOf, json, readJson, withSession } from "@/lib/server/http";
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
