/**
 * Server-sent events for one plan: GET /api/plan/<id>/stream.
 *
 *   event: start        {planId, mode, title, presetId?}   (mode "recorded" for a live sheet on a recorded server)
 *   event: card         {index, key, envelope}       (spec order: resolution, liftMap, partners, ...)
 *   event: step         {index, step}                (one TraceStep of sheet.steps, as the run reaches it)
 *   event: needs_input  {planId, pending, resolution, bill}
 *   event: done         {planId, status: complete | needs_input | error, error?}
 *
 * A cached or stored sheet streams every card at once, then its steps, so the
 * first card arrives in milliseconds. A running plan replays the cards it already has,
 * then follows the run. Comment lines keep the connection open.
 */
import type { Envelope } from "@walkup/contracts";
import { CARD_ORDER } from "@walkup/orchestrator";
import { runtimeMode } from "../mode";
import { getRun, subscribe, type RunEvent } from "./runs";
import { loadPlan, type LoadedPlan } from "./service";

export const HEARTBEAT_MS = 15_000;

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const;

/** The frames for a plan that is not running (cached, stored, paused or failed). */
export function staticFrames(v: Exclude<LoadedPlan, { kind: "running" }>): string[] {
  const frames: string[] = [];
  // Recorded state: a live sheet is a recording, as GET /api/plan/<id> (planSnapshot) and the envelope report it.
  const mode = v.kind === "sheet" ? (v.sheet.mode === "live" && runtimeMode().kind === "recorded" ? "recorded" : v.sheet.mode) : v.mode;
  frames.push(sseFrame("start", { planId: v.planId, mode, title: v.title, ...(v.kind !== "error" && v.presetId ? { presetId: v.presetId } : {}) }));
  if (v.kind === "sheet") {
    CARD_ORDER.forEach((key, index) => frames.push(sseFrame("card", { index, key, envelope: v.sheet.cards[key] as Envelope<unknown> })));
    (v.sheet.steps ?? []).forEach((step, index) => frames.push(sseFrame("step", { index, step })));
    frames.push(sseFrame("done", { planId: v.planId, status: "complete" }));
  } else if (v.kind === "paused") {
    frames.push(sseFrame("card", { index: 0, key: "resolution", envelope: v.pause.resolution }));
    frames.push(sseFrame("needs_input", { planId: v.planId, pending: v.pause.pending, resolution: v.pause.resolution, bill: v.pause.bill }));
    frames.push(sseFrame("done", { planId: v.planId, status: "needs_input" }));
  } else {
    frames.push(sseFrame("done", { planId: v.planId, status: "error", error: v.error }));
  }
  return frames;
}

function frameFor(e: RunEvent): string {
  switch (e.type) {
    case "card":
      return sseFrame("card", { index: e.index, key: e.card.key, envelope: e.card.envelope });
    case "step":
      return sseFrame("step", { index: e.index, step: e.step });
    case "needs_input":
      return sseFrame("needs_input", { planId: e.planId, pending: e.pending, resolution: e.resolution, bill: e.bill });
    case "done":
      return sseFrame("done", { planId: e.planId, status: e.status, ...(e.error ? { error: e.error } : {}) });
  }
}

/** The SSE body for a plan, or null when the id is unknown. */
export async function planEventStream(id: string, sessionId: string | null, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
  const v = await loadPlan(id, { view: "page", sessionId });
  if (!v) return null;
  const enc = new TextEncoder();

  if (v.kind !== "running") {
    const frames = staticFrames(v);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
  }

  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      let sent = 0;
      let stepsSent = 0;
      const unsubscribe = subscribe(id, (e) => {
        if (e.type === "card") {
          if (e.index < sent) return;
          sent = e.index + 1;
        }
        if (e.type === "step") {
          if (e.index < stepsSent) return;
          stepsSent = e.index + 1;
        }
        send(frameFor(e));
        if (e.type === "done") close();
      });
      const heartbeat = setInterval(() => send(": keep-alive\n\n"), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      signal?.addEventListener("abort", close);

      send(sseFrame("start", { planId: v.planId, mode: v.mode, title: v.title, ...(v.presetId ? { presetId: v.presetId } : {}) }));
      const run = getRun(id);
      const snapshot = run ? [...run.cards] : v.cards;
      snapshot.forEach((c, index) => send(sseFrame("card", { index, key: c.key, envelope: c.envelope })));
      sent = Math.max(sent, snapshot.length);
      const stepSnapshot = run ? [...run.steps] : [];
      stepSnapshot.forEach((step, index) => send(sseFrame("step", { index, step })));
      stepsSent = Math.max(stepsSent, stepSnapshot.length);
      // The run may have finished between loading and subscribing.
      if (run && run.status !== "running") {
        if (run.status === "needs_input" && run.pending && run.resolution && run.bill) {
          send(sseFrame("needs_input", { planId: id, pending: run.pending, resolution: run.resolution, bill: run.bill }));
        }
        send(sseFrame("done", { planId: id, status: run.status, ...(run.error ? { error: run.error } : {}) }));
        close();
      }
    },
    cancel() {
      cleanup();
    },
  });
}
