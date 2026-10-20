import { LIFT_LEGEND, liftColor } from "../lib/lift";

/**
 * The lift key on one line: four stepped swatches with their labels printed (never a gradient bar), led by a
 * caption that names the baseline, e.g. "Fans compared with the room's usual crowd".
 */
export function LiftLegend({ className = "", caption }: { className?: string; caption?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted ${className}`}>
      {caption ? <p className="text-ink">{caption}:</p> : null}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1" aria-label={caption ? `Lift colour key: ${caption}` : "Lift colour key"}>
        {LIFT_LEGEND.map((l) => (
          <li key={l.label} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-block h-3 w-4 border border-control" style={{ background: liftColor(l.sample) }} />
            {l.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
