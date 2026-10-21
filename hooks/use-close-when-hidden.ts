"use client";

import { useLayoutEffect } from "react";

/**
 * Close a menu or popover when its page is hidden: Next keeps the last few
 * pages mounted but hidden (React <Activity>) for going back to, and one should
 * come back with its menus shut, not open where it was left. Runs as the page
 * hides (and on unmount, where closing is harmless).
 */
export function useCloseWhenHidden(close: () => void): void {
  useLayoutEffect(() => close, [close]);
}
