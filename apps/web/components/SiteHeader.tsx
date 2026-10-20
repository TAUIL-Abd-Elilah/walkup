"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { RuntimeMode } from "@/lib/mode";

const NAV = [
  { href: "/#sheets", label: "Sheets", match: null },
  { href: "/system-card", label: "System card", match: "/system-card" },
  { href: "/eval", label: "Eval", match: "/eval" },
] as const;

/** Live mode is said in words at the right; fixture mode has the sample strip above the header instead. */
function liveNote(mode: RuntimeMode): string | null {
  if (mode.kind !== "live") return null;
  const left = mode.quota?.remaining;
  return typeof left === "number" ? `Live data · ${left.toLocaleString("en-US")} Qloo calls left this month` : "Live data";
}

export function SiteHeader({ mode }: { mode: RuntimeMode }) {
  const path = usePathname();
  const note = liveNote(mode);
  return (
    <header className="no-print border-b border-rule">
      <div className="wrap-wide flex flex-wrap items-baseline gap-x-6 gap-y-1 py-3">
        <Link href="/" className="text-lg font-semibold text-ink no-underline">
          Walkup
        </Link>
        <nav aria-label="Main">
          <ul className="flex flex-wrap gap-x-5 gap-y-1 text-base">
            {NAV.map((n) => {
              const current = n.match !== null && path?.startsWith(n.match);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={current ? "page" : undefined}
                    className={`inline-block py-1.5 underline-offset-4 hover:underline ${current ? "font-semibold text-ink underline" : "text-muted hover:text-ink"}`}
                  >
                    {n.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        {note ? <p className="text-sm text-muted sm:ml-auto">{note}</p> : null}
      </div>
    </header>
  );
}
