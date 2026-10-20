import { contextOf, json } from "@/lib/server/http";
import { showSearch } from "@/lib/server/lookups";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/events/search?q=<show>: Ticketmaster events to pick from (live mode only; 503 in fixture mode). */
export async function GET(request: Request): Promise<Response> {
  const q = new URL(request.url).searchParams.get("q");
  const res = await showSearch(q, contextOf(request));
  return json(res.body, res.status);
}
