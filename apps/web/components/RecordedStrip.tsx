import type { RuntimeMode } from "@/lib/mode";

/**
 * Recorded mode, said once at the very top of every page (from the layout): Qloo is
 * unavailable, the sheets were recorded from live runs and are not refreshed, and new
 * plans are off. The words come from the runtime mode, so /healthz says the same.
 */
export function RecordedStrip({ mode }: { mode: RuntimeMode }) {
  return (
    <div className="sample-strip" role="note" aria-label="Recorded sheets">
      <p className="wrap-wide">
        <strong className="font-semibold">Recorded sheets.</strong> {mode.detail}
      </p>
    </div>
  );
}
