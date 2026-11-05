"use client";

import { useEffect, useRef, useState } from "react";

/** The narrowest the right panel is dragged to, and the share of the window
 *  it may take at most, so the chat always keeps room. */
const MIN_WIDTH = 300;
const MAX_SHARE = 0.6;

function clamp(width: number): number {
  return Math.round(Math.min(Math.max(width, MIN_WIDTH), Math.max(MIN_WIDTH, window.innerWidth * MAX_SHARE)));
}

/**
 * The right panel's width as dragged by its left edge, kept in this browser
 * per kind of page (a Mission's Ships, a session's Environment); null for the
 * stylesheet's own width. Arrow keys on the edge move it too; a double-click
 * puts it back.
 */
export function useInspectorWidth(kind: "mission" | "session") {
  const key = `outrunner.inspector-width.${kind}`;
  const [width, setWidth] = useState<number | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    let saved: number | null = null;
    try {
      saved = Number(window.localStorage.getItem(key)) || null;
    } catch {
      // Blocked storage: the default width.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWidth(saved && clamp(saved));
  }, [key]);

  const save = (next: number | null) => {
    setWidth(next);
    try {
      if (next === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(next));
    } catch {
      // Blocked storage only costs remembering it.
    }
  };

  const panelWidth = (handle: HTMLElement) => handle.parentElement?.getBoundingClientRect().width ?? MIN_WIDTH;

  const handle = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize panel",
    "aria-valuenow": width ?? undefined,
    tabIndex: 0,
    title: "Drag to resize; double-click to reset",
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, width: panelWidth(event.currentTarget) };
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      // The panel is on the right, so moving left widens it.
      if (drag.current) setWidth(clamp(drag.current.width + drag.current.x - event.clientX));
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      drag.current = null;
      save(clamp(panelWidth(event.currentTarget)));
    },
    onDoubleClick: () => save(null),
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.shiftKey ? 80 : 20;
      save(clamp(panelWidth(event.currentTarget) + (event.key === "ArrowLeft" ? step : -step)));
    },
  } as const;

  return { width, handle };
}
