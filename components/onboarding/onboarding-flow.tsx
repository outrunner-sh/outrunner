"use client";

import { Terminal } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentStep } from "@/components/onboarding/agent-step";
import { ReposStep } from "@/components/onboarding/repos-step";
import { StartStep } from "@/components/onboarding/start-step";
import { Stepper } from "@/components/onboarding/stepper";
import type { AgentStatus, OnboardingEnv } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";

type Step = "agent" | "repos" | "start";

const STEPS: { id: Step; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "repos", label: "Repositories" },
  { id: "start", label: "Start" },
];

/**
 * First run, as Replicas' onboarding: the coding agent signed in, the
 * repositories to work on connected, a first session started. Each step
 * ticks once done. A user whose agent is already connected (from
 * `npx outrunner` in their terminal, say) sees it ticked and moves on.
 * Teams come in as a step of their own later.
 */
export function OnboardingFlow({ env, onLeave }: { env: OnboardingEnv; onLeave: (href: string) => void }) {
  const [step, setStep] = useState<Step>("agent");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [done, setDone] = useState<Set<Step>>(new Set());
  const [skipping, setSkipping] = useState(false);

  useEffect(() => {
    env.agentStatus().then(setStatus, () => setStatus({ claude: { subscription: false, last4: null, apiKey: false }, codex: { apiKey: false } }));
  }, [env]);

  const finish = (which: Step, next: Step) => {
    setDone((current) => new Set(current).add(which));
    setStep(next);
  };

  // Ticked from the start when an agent is already connected (from the
  // terminal, or Settings): the user can go straight on.
  const agentDone = Boolean(status && (status.claude.subscription || status.claude.apiKey || status.codex.apiKey));
  const shownDone = agentDone ? new Set(done).add("agent") : done;

  return (
    <div className="flex min-h-screen flex-col items-center px-6 py-8">
      <header className="flex w-full max-w-3xl items-center justify-between">
        <span className="flex items-center gap-1.5 font-mono text-sm">
          <Terminal className="size-4" aria-hidden />
          <span className="font-semibold tracking-tight">outrunner</span>
        </span>
        <button
          type="button"
          disabled={skipping}
          onClick={() => {
            setSkipping(true);
            env.skip().then(onLeave, () => setSkipping(false));
          }}
          className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
        >
          {skipping ? "Opening home…" : "Skip for now"}
        </button>
      </header>

      <div className="border-border/60 mt-6 w-full border-b pb-6">
        <Stepper steps={STEPS} current={step} done={shownDone} onGo={setStep} />
      </div>

      <main className="flex w-full max-w-xl flex-1 flex-col justify-center py-10">
        {step === "agent" &&
          (status ? (
            <AgentStep env={env} status={status} onStatus={setStatus} onDone={() => finish("agent", "repos")} />
          ) : (
            <p className="text-muted-foreground text-sm">Checking what you&apos;ve connected…</p>
          ))}
        {step === "repos" && (
          <ReposStep
            env={env}
            onDone={(picked) => {
              setProjects(picked);
              finish("repos", "start");
            }}
          />
        )}
        {step === "start" && <StartStep env={env} projects={projects} onLeave={onLeave} />}
      </main>
    </div>
  );
}
