import { contextOf, json } from "@/lib/server/http";
import { limitsFor } from "@/lib/server/lookups";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/limits: fresh runs left today for this network and in total; presets are unlimited. */
export async function GET(request: Request): Promise<Response> {
  const res = limitsFor(contextOf(request));
  return json(res.body, res.status);
}
