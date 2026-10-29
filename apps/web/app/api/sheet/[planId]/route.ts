import { PLAN_ID_RE } from "@/lib/api";
import { runtimeMode } from "@/lib/mode";
import { contextOf, json, otherMethods } from "@/lib/server/http";
import { envelopeOf, loadPlan } from "@/lib/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/sheet/<planId>: the envelope for a plan (results = StreetSheet; needs_input while a pick is pending).
 * In recorded state a live sheet's envelope says mode "recorded".
 */
export async function GET(request: Request, { params }: { params: Promise<{ planId: string }> }): Promise<Response> {
  const { planId } = await params;
  if (!PLAN_ID_RE.test(planId)) return json({ reason: "Plan ids match ^[A-Za-z0-9_-]{1,64}$." }, 400);
  const ctx = contextOf(request);
  const v = await loadPlan(planId, { view: "api", sessionId: ctx.sessionId });
  if (!v) return json({ reason: `No plan with id ${planId}.` }, 404);
  return json(envelopeOf(v, ctx.origin, { recorded: runtimeMode().kind === "recorded" }));
}

/** Any other method: 405 with a reason and Allow: GET, HEAD, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("GET");
export const POST = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
