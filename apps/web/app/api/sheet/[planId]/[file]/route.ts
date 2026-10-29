import { PLAN_ID_RE } from "@/lib/api";
import { runtimeMode } from "@/lib/mode";
import { exportKind, exportResponse, exportShowName } from "@/lib/server/exports";
import { contextOf, json, otherMethods } from "@/lib/server/http";
import { loadPlan } from "@/lib/server/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/sheet/<planId>/<file>: pdf (one page; ?size=a4, ?inline=1), ics, partners.csv, zips.csv,
 * pins.csv, offer-codes.csv or sheet.json, built by @walkup/exports from the server's own copy.
 */
export async function GET(request: Request, { params }: { params: Promise<{ planId: string; file: string }> }): Promise<Response> {
  const { planId, file } = await params;
  const kind = exportKind(file);
  if (!kind) return json({ reason: `Unknown export ${file}. Use pdf, ics, partners.csv, zips.csv, pins.csv, offer-codes.csv or sheet.json.` }, 404);
  if (!PLAN_ID_RE.test(planId)) return json({ reason: "Plan ids match ^[A-Za-z0-9_-]{1,64}$." }, 400);
  const ctx = contextOf(request);
  const v = await loadPlan(planId, { view: "api", sessionId: ctx.sessionId });
  if (!v) return json({ reason: `No plan with id ${planId}.` }, 404);
  if (v.kind !== "sheet") return json({ reason: "This plan has no finished sheet yet (it is running or waiting for a pick)." }, 409);
  const url = new URL(request.url);
  const showName = exportShowName(planId, v.presetId, v.sheet);
  try {
    return await exportResponse(v.sheet, kind, {
      ledgerUrl: `${ctx.origin}/plan/${planId}#ledger`,
      inline: url.searchParams.get("inline") === "1",
      ...(url.searchParams.get("size")?.toLowerCase() === "a4" ? { pageSize: "A4" as const } : {}),
      ...(runtimeMode().kind === "recorded" ? { recorded: true } : {}),
      ...(showName ? { showName } : {}),
    });
  } catch (err) {
    return json({ reason: `Could not build ${file}: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

/** Any other method: 405 with a reason and Allow: GET, HEAD, OPTIONS (Next's own 405 has no body and no Allow). */
const other = otherMethods("GET");
export const POST = other.refuse;
export const PUT = other.refuse;
export const PATCH = other.refuse;
export const DELETE = other.refuse;
export const OPTIONS = other.options;
