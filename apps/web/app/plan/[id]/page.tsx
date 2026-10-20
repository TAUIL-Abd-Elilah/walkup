import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { PlanLive } from "@/components/plan/PlanLive";
import { PlanView } from "@/components/plan/PlanView";
import { headlinerName } from "@/lib/format";
import { runtimeMode } from "@/lib/mode";
import { getPlan } from "@/lib/plans";
import { presetForPlan, presetLine } from "@/lib/presets";
import { sheetTitle } from "@/lib/sheet-utils";
import { SESSION_COOKIE } from "@/lib/server/http";
import { loadPlan, presetSheet } from "@/lib/server/service";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { id } = await params;
  const recorded = (await searchParams).recorded === "1";
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  // The same view as the page, so a paused preset is titled as paused.
  const v = await loadPlan(id, { view: recorded ? "api" : "page", sessionId });
  if (!v) return { title: "Plan not found" };
  // The status is in the tab title too: "(draft)", "(sent Oct 14)", or what a run in progress is waiting on.
  if (v.kind !== "sheet") return { title: `${v.title} (${v.kind === "paused" ? "needs your pick" : v.kind === "running" ? "planning" : "stopped"})` };
  return {
    title: sheetTitle(v.sheet),
    description: v.sheet.narration?.summary ?? v.title,
  };
}

/**
 * A preset line that explains the pause ("... so Walkup asks you to pick before it plans") belongs to the paused
 * view only; on the finished sheet the pick is in "What Walkup decided" instead.
 */
function isPauseLine(line: string | null): boolean {
  return line !== null && /\bpick\b/i.test(line);
}

async function pairedFor(planId: string | undefined): Promise<{ planId: string; headliner: string; date: string } | null> {
  if (!planId) return null;
  const fx = getPlan(planId);
  if (fx) return { planId, headliner: headlinerName(fx.sheet.bill), date: fx.sheet.bill.date };
  const v = await loadPlan(planId, { view: "api" });
  return v?.kind === "sheet" ? { planId, headliner: headlinerName(v.sheet.bill), date: v.sheet.bill.date } : null;
}

export default async function PlanPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const recorded = (await searchParams).recorded === "1";
  const sessionId = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const v = await loadPlan(id, { view: recorded ? "api" : "page", sessionId });
  if (!v) notFound();
  const mode = runtimeMode();

  if (v.kind !== "sheet") {
    // Running, waiting for a pick, or stopped: the live view streams the sections.
    const recordedSheet = v.kind === "paused" && v.source === "preset" && v.presetId ? await presetSheet(v.presetId) : null;
    const pausedPreset = v.kind === "paused" && v.presetId ? presetForPlan(v.presetId) : undefined;
    const pausedLine = pausedPreset ? presetLine(pausedPreset, null) : null;
    return (
      <PlanLive
        planId={v.planId}
        mode={v.mode}
        title={v.title}
        status={v.kind === "paused" ? "needs_input" : v.kind}
        cards={v.kind === "running" ? v.cards : v.kind === "paused" ? [{ key: "resolution", envelope: v.pause.resolution }] : []}
        resolveId={v.planId}
        {...(v.kind === "paused" ? { pending: v.pause.pending, resolution: v.pause.resolution, bill: v.pause.bill, ledger: v.pause.ledger } : {})}
        {...(v.kind === "error" ? { error: v.error } : {})}
        {...(recordedSheet ? { recordedHref: `/plan/${recordedSheet.sheet.planId}?recorded=1` } : {})}
        {...(pausedLine ? { line: pausedLine } : {})}
      />
    );
  }

  const presetId = v.presetId ?? (v.source === "preset" ? id : undefined);
  const preset = presetId ? presetForPlan(presetId) : undefined;
  const presetText = preset ? presetLine(preset, v.sheet.operator.seatsLeft) : null;
  const paired = await pairedFor(v.sheet.pairedPlanId ?? (v.source === "preset" ? getPlan(id)?.pairedWith : undefined));
  return (
    <PlanView
      payload={{ sheet: v.sheet, control: v.control, note: v.note, source: v.source, ...(presetId ? { presetId } : {}) }}
      line={isPauseLine(presetText) ? null : presetText}
      realShow={preset?.realShow ?? false}
      {...(preset?.showName ? { showName: preset.showName } : {})}
      paired={paired}
      runtimeLive={mode.kind === "live"}
      canRerun={mode.kind === "fixture" && Boolean(presetId)}
      // A live sheet can't be re-run on a fixture server; the route would refuse it.
      revisable={!(v.sheet.mode === "live" && mode.kind !== "live")}
    />
  );
}
