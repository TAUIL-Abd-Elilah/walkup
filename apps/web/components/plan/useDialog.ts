"use client";
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus handling: focus moves into the dialog, Tab is trapped, Escape
 * closes, page scroll is locked (the gutter is reserved, so nothing shifts),
 * and focus returns to the element that opened it.
 */
export function useDialog(open: boolean, dialogRef: RefObject<HTMLElement | null>, onClose: () => void, initialFocusRef?: RefObject<HTMLElement | null>) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusables = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.getClientRects().length > 0);
    const first = initialFocusRef?.current ?? focusables()[0] ?? dialog;
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) return;
      const head = list[0]!;
      const tail = list[list.length - 1]!;
      if (e.shiftKey && (document.activeElement === head || !dialog?.contains(document.activeElement))) {
        e.preventDefault();
        tail.focus();
      } else if (!e.shiftKey && (document.activeElement === tail || !dialog?.contains(document.activeElement))) {
        e.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previous?.focus();
    };
  }, [open, dialogRef, initialFocusRef]);
}
