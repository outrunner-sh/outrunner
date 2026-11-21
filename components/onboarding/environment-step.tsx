"use client";

import { useState } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { DashedPanel } from "@/components/onboarding/dashed";
import { Input } from "@/components/ui/input";
import { LoadingButton } from "@/components/ui/loading-button";
import type { OnboardingEnv } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";

/**
 * Step 4, the last: the org's first environment, of the repositories just
 * picked, named after the org until renamed. It's made the org's default,
 * which new sessions start from, and setup ends on the new-session screen
 * on it (`onDone`, busy until the page leaves).
 */
export function EnvironmentStep({
  env,
  projects,
  onDone,
  onBack,
}: {
  env: OnboardingEnv;
  projects: Project[];
  onDone: (environmentId: string) => Promise<void>;
  onBack: () => void;
}) {
  const [name, setName] = useState(env.org.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await onDone(await env.createEnvironment(name.trim(), projects.map((p) => p.id)));
      // Still busy: the page is on its way out.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't make the environment. Try again.");
      setBusy(false);
    }
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Name your environment</h1>
        <p className="text-muted-foreground text-sm">
          What sessions start from: these repositories, and later their setup, variables, files, skills and MCP servers. It&apos;s{" "}
          {env.org.name}&apos;s default.
        </p>
      </div>
      <label className="block space-y-1.5">
        <span className="text-muted-foreground text-xs">Name</span>
        <Input value={name} maxLength={80} disabled={busy} onChange={(e) => setName(e.target.value)} aria-label="Environment name" />
      </label>
      <DashedPanel className="px-5 py-4">
        <ul className="space-y-1.5 text-sm" aria-label="Its repositories">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center gap-2 font-mono text-[13px]">
              <GitHubIcon className="text-muted-foreground size-4 shrink-0" />
              <span className="truncate">{p.fullName}</span>
            </li>
          ))}
        </ul>
      </DashedPanel>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between">
        <button type="button" disabled={busy} onClick={onBack} className="text-muted-foreground hover:text-foreground text-sm">
          Pick other repositories
        </button>
        <LoadingButton
          size="default"
          status={busy ? "pending" : "idle"}
          disabled={!name.trim() || projects.length === 0}
          onClick={() => void create()}
          labels={{ idle: "Create environment", pending: "Starting" }}
        />
      </div>
    </section>
  );
}
