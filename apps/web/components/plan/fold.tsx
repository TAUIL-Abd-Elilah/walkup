"use client";
import { createContext, useContext, type ReactNode } from "react";

/**
 * The lower sections of a sheet (acts, your list, podcasts, copy lines, limits and checks, requests) keep their
 * heading and one-line summary in view and fold the rest behind a plain "Show" disclosure. PlanView sets this
 * around them; anywhere else (the live view, tests) the sections render open.
 */
export const FoldContext = createContext(false);

/** The folded part of a section: a native disclosure that says "Show" closed and "Hide" open. */
export function FoldBody({ title, children }: { title: string; children: ReactNode }) {
  const fold = useContext(FoldContext);
  if (!fold) return <>{children}</>;
  return (
    <details className="plain-details fold mt-2">
      <summary>
        <span className="fold-show">Show</span>
        <span className="fold-hide">Hide</span>
        <span className="sr-only"> {title}</span>
      </summary>
      {children}
    </details>
  );
}

/** Opens every folded section on the way to an anchor (a nav link, "33 requests", a shared #ledger link). */
export function openFoldsFor(id: string): void {
  if (typeof document === "undefined" || id === "") return;
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelectorAll<HTMLDetailsElement>("details.fold").forEach((d) => {
    d.open = true;
  });
  let d = el.closest<HTMLDetailsElement>("details.fold");
  while (d) {
    d.open = true;
    d = d.parentElement?.closest<HTMLDetailsElement>("details.fold") ?? null;
  }
}
