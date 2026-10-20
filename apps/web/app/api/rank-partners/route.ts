import { contextOf, json, readJson, withSession } from "@/lib/server/http";
import { startPlan } from "@/lib/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/rank-partners {event | presetId | tmEventId, partners: [names]}: ranks the operator's own list
 * for the bill (results = DeclaredPartnerScore[]; rank null means not in Qloo's catalog, kept in the operator's order). Runs the plan.
 */
export async function POST(request: Request): Promise<Response> {
  const ctx = contextOf(request, true);
  const body = await readJson(request);
  if (!body.ok) return json({ reason: body.reason }, 400);
  const res = await startPlan(body.value, ctx, { rankPartners: true });
  return withSession(json(res.body, res.status), ctx);
}
