"use client";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

/**
 * The lower sections of a sheet (acts, your list, podcasts, copy lines, limits and checks, requests) keep their
 * heading and one-line summary in view and fold the rest behind a plain "Show" disclosure. PlanView sets this
 * around them; anywhere else (the live view, tests) the sections render open.
 */
export const FoldContext = createContext(false);

/**
 * Opens a closed fold for printing and returns what puts it back: paper has no "Show", so the content prints.
 * The print CSS opens folds too (::details-content); this covers browsers without it.
 */
export function openForPrint(d: { open: boolean }): () => void {
  if (d.open) return () => {};
  d.open = true;
  return () => {
    d.open = false;
  };
}

/** The folded part of a section: a native disclosure that says "Show" closed and "Hide" open, and prints open. */
export function FoldBody({ title, children }: { title: string; children: ReactNode }) {
  const fold = useContext(FoldContext);
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    let restore: (() => void) | null = null;
    const before = () => {
      restore = openForPrint(d);
    };
    const after = () => {
      restore?.();
      restore = null;
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, [fold]);
  if (!fold) return <>{children}</>;
  return (
    <details ref={ref} className="plain-details fold mt-2">
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
