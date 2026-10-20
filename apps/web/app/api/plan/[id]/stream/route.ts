import { PLAN_ID_RE } from "@/lib/api";
import { json, sessionFrom } from "@/lib/server/http";
import { planEventStream, SSE_HEADERS } from "@/lib/server/stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/plan/<id>/stream: server-sent events, cards in sheet order (see lib/server/stream.ts). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!PLAN_ID_RE.test(id)) return json({ reason: "Plan ids match ^[A-Za-z0-9_-]{1,64}$." }, 400);
  const stream = await planEventStream(id, sessionFrom(request.headers), request.signal);
  if (!stream) return json({ reason: `No plan with id ${id}.` }, 404);
  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
