import { contextOf, json } from "@/lib/server/http";
import { planSnapshot } from "@/lib/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/plan/<id>: running, needs_input (with candidates), complete or error. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const res = await planSnapshot(id, contextOf(request));
  return json(res.body, res.status);
}
