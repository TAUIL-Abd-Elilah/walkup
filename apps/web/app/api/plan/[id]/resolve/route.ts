import { contextOf, json, readJson, withSession } from "@/lib/server/http";
import { resolvePlan } from "@/lib/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/plan/<id>/resolve: answer a needs_input pause.
 * Body: {picks: [{input, entityId}]}. A pick with proxy: true means "None of these: use a proxy"
 * (entityId is a film or TV title from GET /api/proxy-search). Answers 202 with {planId, streamUrl}:
 * the same id for a stored plan, a new id when answering a preset's recorded pause. With
 * {wait: "complete"} it answers with the final envelope instead.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const ctx = contextOf(request, true);
  const body = await readJson(request);
  if (!body.ok) return json({ reason: body.reason }, 400);
  const res = await resolvePlan(id, body.value, ctx);
  return withSession(json(res.body, res.status), ctx);
}
