"use client";
import { useEffect, useState } from "react";
import { tauriCore } from "@/lib/desktop/local-runtime";
import type { SessionModel } from "@/lib/runtime/session-models";

export function useLocalCodexModels(enabled: boolean) {
  const [result, setResult] = useState<{
    models: SessionModel[];
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    const core = tauriCore();
    if (!core) return;
    void core
      .invoke("local_codex_models")
      .then((models) => {
        if (!Array.isArray(models)) throw new Error("Invalid model catalog.");
        if (!stale) setResult({ models: models as SessionModel[] });
      })
      .catch(() => {
        if (!stale)
          setResult({
            models: [],
            error:
              "Couldn't load Codex's models on this Mac. Check its sign-in and reopen this page.",
          });
      });
    return () => {
      stale = true;
    };
  }, [enabled]);
  return enabled ? result : null;
}
