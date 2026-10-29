import { contextOf, json, otherMethods, readJson, withSession } from "@/lib/server/http";
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

/** Any other method: 405 with a reason and Allow: POST, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("POST");
export const GET = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
