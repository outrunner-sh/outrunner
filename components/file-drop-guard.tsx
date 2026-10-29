"use client";

import { useEffect } from "react";

/**
 * Keeps a file dropped anywhere from opening in the tab: the browser's own
 * answer to a drop nothing takes, which leaves the app behind. A page with a
 * composer takes the files (its usePageDrop); elsewhere they're let go.
 */
export function FileDropGuard() {
  useEffect(() => {
    const hold = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", hold);
    window.addEventListener("drop", hold);
    return () => {
      window.removeEventListener("dragover", hold);
      window.removeEventListener("drop", hold);
    };
  }, []);
  return null;
}
