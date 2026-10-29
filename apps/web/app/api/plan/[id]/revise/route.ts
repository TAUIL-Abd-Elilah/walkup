import { contextOf, json, otherMethods, readJson, withSession } from "@/lib/server/http";
import { revisePlanFor } from "@/lib/server/revise";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/plan/<id>/revise: change a finished sheet with a short note.
 * Body: {instruction: "All ages: no bars", wait?: "complete"}. The note is read by the model (strict
 * tools) or, without an Anthropic key, by fixed rules. Answers:
 * - 202 {status: "running", planId (new), parentPlanId, streamUrl, planUrl, sheetUrl, revision}: the revised
 *   run streams from streamUrl (cards and steps).
 * - 200 sheet envelope + {parentPlanId, revision} with wait "complete".
 * - 200 {status: "needs_input", question, revision}: the note was unclear; nothing changed.
 * - 400 bad note, 404 unknown plan, 409 plan not finished, 429 rate limit or quota guard.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const ctx = contextOf(request, true);
  const body = await readJson(request, 8 * 1024);
  if (!body.ok) return json({ reason: body.reason }, 400);
  const res = await revisePlanFor(id, body.value, ctx);
  return withSession(json(res.body, res.status), ctx);
}

/** Any other method: 405 with a reason and Allow: POST, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("POST");
export const GET = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
