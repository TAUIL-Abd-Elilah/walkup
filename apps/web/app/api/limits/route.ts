import { contextOf, json, otherMethods } from "@/lib/server/http";
import { limitsFor } from "@/lib/server/lookups";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/limits: fresh runs left today for this network and in total; presets are unlimited. */
export async function GET(request: Request): Promise<Response> {
  const res = limitsFor(contextOf(request));
  return json(res.body, res.status);
}

/** Any other method: 405 with a reason and Allow: GET, HEAD, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("GET");
export const POST = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
