import { contextOf, json, otherMethods } from "@/lib/server/http";
import { planSnapshot } from "@/lib/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/plan/<id>: running, needs_input (with candidates), complete or error. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const res = await planSnapshot(id, contextOf(request));
  return json(res.body, res.status);
}

/** Any other method: 405 with a reason and Allow: GET, HEAD, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("GET");
export const POST = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
