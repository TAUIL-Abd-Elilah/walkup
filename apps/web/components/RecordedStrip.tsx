import type { RuntimeMode } from "@/lib/mode";

/**
 * Recorded mode, said once at the very top of every page (from the layout): Qloo is
 * unavailable since when, new plans are off, and a sheet recorded from a live run shows
 * its date and is not refreshed. The words come from the runtime mode, so /healthz says
 * the same; the first sentence is set in bold.
 */
export function RecordedStrip({ mode }: { mode: RuntimeMode }) {
  const cut = mode.detail.indexOf(". ");
  const [lead, rest] = cut > 0 ? [mode.detail.slice(0, cut + 1), mode.detail.slice(cut + 2)] : [mode.detail, ""];
  return (
    <div className="sample-strip" role="note" aria-label="Qloo unavailable">
      <p className="wrap-wide">
        <strong className="font-semibold">{lead}</strong>
        {rest ? ` ${rest}` : null}
      </p>
    </div>
  );
}
