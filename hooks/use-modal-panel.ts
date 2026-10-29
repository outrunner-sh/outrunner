"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A panel that covers the page while `open` (the sidebar as a drawer on a
 * phone, the Environment over a narrow window's chat): focus moves into it
 * and Tab stays in it, Esc closes it, and focus goes back where it was once
 * it closes. An Esc something inside already used (a menu closing, a list
 * stepping back) is left alone.
 */
export function useModalPanel<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void) {
  const panel = useRef<T | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = panel.current;
    if (node && !node.contains(document.activeElement)) {
      (node.querySelector<HTMLElement>(FOCUSABLE) ?? node).focus({ preventScroll: true });
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (event.shiftKey && (at === first || !node.contains(at))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (at === last || !node.contains(at))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Back where the user was, unless they have since moved on.
      const at = document.activeElement;
      if (before?.isConnected && (!at || at === document.body || node?.contains(at))) {
        before.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return panel;
}
