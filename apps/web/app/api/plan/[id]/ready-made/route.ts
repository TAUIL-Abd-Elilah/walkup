import { json, otherMethods } from "@/lib/server/http";
import { readyMadeFor } from "@/lib/server/recorded-revise";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/plan/<id>/ready-made: the changes made ahead for a recorded sheet, which "Change something" opens while
 * live runs are paused. {mode, enabled, reader: "model" | "rules", changes: [{planId, instruction, createdAt}]}.
 * `enabled` is false outside recorded mode, with WALKUP_RECORDED_REVISE=off, or when the sheet has none.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const res = await readyMadeFor(id);
  return json(res.body, res.status);
}

/** Any other method: 405 with a reason and Allow: GET, HEAD, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("GET");
export const POST = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
