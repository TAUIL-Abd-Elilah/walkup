import { contextOf, json, operatorAuthorized, otherMethods, readJson, withSession } from "@/lib/server/http";
import { startPlan } from "@/lib/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/plan: start a run.
 * Body: one of {presetId}, {tmEventId} or {event: <Ticketmaster URL | "Artist @ Venue, Date" | preset id>},
 * optional {operator}, {picks: [{input, entityId}]}, and {wait: "none"} to get the plan id at once
 * (cards then stream from GET /api/plan/<id>/stream). Without it, the answer is the envelope once the
 * run completes or pauses for a pick (status needs_input, candidates in `pending` and `resolution`).
 * {presetId, rerecord: true} with `Authorization: Bearer <WALKUP_OPERATOR_TOKEN>` plans a live preset again.
 */
export async function POST(request: Request): Promise<Response> {
  const ctx = contextOf(request, true);
  const body = await readJson(request);
  if (!body.ok) return json({ reason: body.reason }, 400);
  const res = await startPlan(body.value, ctx, { operator: operatorAuthorized(request) });
  return withSession(json(res.body, res.status), ctx);
}

/** Any other method: 405 with a reason and Allow: POST, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("POST");
export const GET = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
