"use client";

import { ArrowDownCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { Spinner } from "@/components/ui/loaders";
import { onUpdateReady, restartToUpdate, waitingUpdate } from "@/lib/desktop/app-update";

/**
 * The sidebar's Update button, just above the account: shown in the Mac app
 * once a new version is installed and waits for a restart, so the update
 * dialog's "Later" isn't the last word on it. Clicking restarts into it;
 * local sessions keep running and reconnect.
 */
export function AppUpdate() {
  const [version, setVersion] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = () =>
      void waitingUpdate().then((waiting) => {
        if (!cancelled && waiting) setVersion(waiting);
      });
    read();
    const stop = onUpdateReady(setVersion);
    window.addEventListener("focus", read);
    return () => {
      cancelled = true;
      stop();
      window.removeEventListener("focus", read);
    };
  }, []);

  if (!version) return null;
  return (
    <button
      type="button"
      onClick={() => {
        setRestarting(true);
        restartToUpdate().catch(() => setRestarting(false));
      }}
      disabled={restarting}
      title={`Outrunner ${version} is installed. Restart to start using it.`}
      className="mb-2 flex w-full cursor-pointer items-center gap-2.5 rounded-md bg-accent/60 px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-default"
    >
      {restarting ? (
        <Spinner label="Restarting" className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <ArrowDownCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{restarting ? "Restarting…" : "Update"}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{version}</span>
    </button>
  );
}
