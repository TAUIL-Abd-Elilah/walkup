import { contextOf, json, otherMethods } from "@/lib/server/http";
import { proxySearch } from "@/lib/server/lookups";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/proxy-search?q=<title>&type=movie|tv_show: film and TV titles to stand in for an act ("None of these: use a proxy"). */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const res = await proxySearch(url.searchParams.get("q"), url.searchParams.get("type"), contextOf(request));
  return json(res.body, res.status);
}

/** Any other method: 405 with a reason and Allow: GET, HEAD, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("GET");
export const POST = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
