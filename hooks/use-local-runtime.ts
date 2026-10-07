"use client";

import { useEffect, useState } from "react";

import { localStatus, missingTools, type LocalStatus } from "@/lib/desktop/local-runtime";

/** Whether this window can run local sessions, and what it would run them on. */
export type LocalRuntime =
  | { state: "checking" }
  /** Not the Outrunner Mac app: local sessions cannot run here. */
  | { state: "unavailable" }
  | { state: "ready"; status: LocalStatus; missing: string[] }
  | { state: "error"; message: string };

export function useLocalRuntime(): LocalRuntime {
  const [runtime, setRuntime] = useState<LocalRuntime>({ state: "checking" });
  useEffect(() => {
    let cancelled = false;
    localStatus()
      .then((status) => {
        if (cancelled) return;
        setRuntime(
          status ? { state: "ready", status, missing: missingTools(status) } : { state: "unavailable" },
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRuntime({ state: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return runtime;
}
