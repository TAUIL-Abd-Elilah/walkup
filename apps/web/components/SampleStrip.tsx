import type { RuntimeMode } from "@/lib/mode";

const SITE_TEXT = "These sheets use made-up places and numbers so you can try Walkup without API keys.";
const SHEET_TEXT = "This sheet uses made-up places and numbers. No live run of this show has been stored yet.";

/**
 * Fixture mode, said once in plain words: a strip at the very top of every page
 * (`variant="site"`, from the layout), or under a sample sheet shown while the
 * server is live (`variant="sheet"`). Replaces the old diagonal watermark.
 */
export function SampleStrip({ variant = "site", mode, className = "" }: { variant?: "site" | "sheet"; mode?: RuntimeMode; className?: string }) {
  // The no-keys case is what SITE_TEXT already says; any other reason (a rejected key, WALKUP_MODE=fixture) is added.
  const extra = variant === "site" && mode && mode.kind === "fixture" && !/^No keys configured/.test(mode.detail) ? ` ${mode.detail}` : "";
  return (
    <div className={`sample-strip ${className}`} role="note" aria-label="Sample data">
      <p className="wrap-wide">
        <strong className="font-semibold">{variant === "site" ? "Sample data." : "Sample sheet."}</strong> {variant === "site" ? SITE_TEXT : SHEET_TEXT}
        {extra}
      </p>
    </div>
  );
}
