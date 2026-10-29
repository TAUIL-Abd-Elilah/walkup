import type { RuntimeMode } from "@/lib/mode";

/**
 * Recorded mode, said once at the very top of every page (from the layout): when the sheets were recorded from
 * live Qloo and Ticketmaster runs, that live runs are paused for judging, and that each recorded sheet comes from a
 * live run, with any change since made offline (a sample sheet says below it that it is not one). The words come
 * from the runtime mode, so /healthz says the same; the first sentence (up to the first ". ") is set in bold.
 */
export function RecordedStrip({ mode }: { mode: RuntimeMode }) {
  const cut = mode.detail.indexOf(". ");
  const [lead, rest] = cut > 0 ? [mode.detail.slice(0, cut + 1), mode.detail.slice(cut + 2)] : [mode.detail, ""];
  return (
    <div className="sample-strip" role="note" aria-label="Recorded sheets">
      <p className="wrap-wide">
        <strong className="font-semibold">{lead}</strong>
        {rest ? ` ${rest}` : null}
      </p>
    </div>
  );
}
