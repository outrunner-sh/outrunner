"use client";
import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { DashedPanel } from "@/components/onboarding/dashed";
import { LoadingButton } from "@/components/ui/loading-button";
import type { OnboardingEnv } from "@/lib/onboarding/types";

export function FolderStep({
  env,
  onDone,
}: {
  env: OnboardingEnv;
  onDone: (path: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function choose() {
    setBusy(true);
    setError(null);
    try {
      const folder = await env.pickFolder();
      if (folder) await onDone(folder.path);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't open this folder. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Choose a folder to work in</h1>
      <DashedPanel>
        <div className="space-y-4 p-5">
          <FolderOpen className="text-muted-foreground size-7" />
          <p className="text-muted-foreground text-sm">
            Choose a project on this Mac. Your first session opens here; you can
            connect GitHub and enable cloud sessions later.
          </p>
          <LoadingButton
            status={busy ? "pending" : "idle"}
            labels={{ idle: "Choose folder", pending: "Opening" }}
            onClick={() => void choose()}
          />
        </div>
      </DashedPanel>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
