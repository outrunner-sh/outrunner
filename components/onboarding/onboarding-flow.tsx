"use client";

import { Terminal } from "lucide-react";
import { useEffect, useState } from "react";

import { AgentStep } from "@/components/onboarding/agent-step";
import { EnvironmentStep } from "@/components/onboarding/environment-step";
import { GitHubStep } from "@/components/onboarding/github-step";
import { ReposStep } from "@/components/onboarding/repos-step";
import { Stepper } from "@/components/onboarding/stepper";
import { resumeAt } from "@/lib/onboarding/rules";
import type { AgentPick, AgentStatus, OnboardingEnv, OnboardingStep as Step } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/** What's taken as connected when it can't be checked: nothing. */
const NOTHING_CONNECTED: AgentStatus = { claude: { subscription: false, last4: null, apiKey: false }, codex: { apiKey: false } };

const STEPS: { id: Step; label: string }[] = [
  { id: "agent", label: "Agent" },
  { id: "github", label: "GitHub" },
  { id: "repos", label: "Repositories" },
  { id: "environment", label: "Environment" },
];

/**
 * An org's setup, as Replicas' onboarding: the coding agent signed in,
 * GitHub connected, the repositories it works on picked, and its first
 * environment made of them (its default), then the new-session screen, on
 * that environment and the agent picked, to start a first session from.
 * Each step ticks once done. It opens where the user left it in this
 * browser for this org (after installing the GitHub App, say), and past the
 * Agent step when an agent is connected already (from `npx outrunner` in the
 * terminal, in a tab it opened): lib/onboarding/rules.ts resumeAt.
 */
export function OnboardingFlow({ env, onLeave }: { env: OnboardingEnv; onLeave: (href: string) => void }) {
  const [step, setStep] = useState<Step>("agent");
  const [status, setStatus] = useState<AgentStatus | null>(null);
  // What the first session starts on, as the Agent step left it.
  const [runOn, setRunOn] = useState<AgentPick>("outrunner");
  const [done, setDone] = useState<Set<Step>>(new Set());
  const [skipping, setSkipping] = useState(false);
  // The repositories picked, for the Environment step; not kept past the
  // page (a reload picks again: they're connected by then).
  const [picked, setPicked] = useState<Project[]>([]);
  // Nothing is shown or kept until where it was left is known.
  const [resumed, setResumed] = useState(false);

  useEffect(() => {
    let stale = false;
    const saved = env.savedProgress();
    const open = async () => {
      // Null where it couldn't be read: not known, which isn't "nothing".
      const [found, choices] = await Promise.all([
        env.agentStatus().catch(() => null),
        env.agentChoices().catch(() => null),
      ]);
      let at = resumeAt(saved, found, choices);
      if (at.save) {
        // Sessions sign in that way from now on, as the Agent step's
        // Continue says; if that can't be saved, the Agent step is where.
        const chosen = await env.chooseMethod(at.save.agent, at.save.method).then(
          () => true,
          () => false,
        );
        if (!chosen) at = resumeAt(saved, found, null);
      }
      return { found, at };
    };
    void open()
      // Whatever goes wrong, onboarding opens where it was left, or at its
      // start; never stuck.
      .catch(() => ({ found: null, at: resumeAt(saved, null, null) }))
      .then(({ found, at }) => {
        if (stale) return;
        setStatus(found ?? NOTHING_CONNECTED);
        setStep(at.step);
        setDone(new Set(at.done));
        setRunOn(at.runOn);
        setResumed(true);
      });
    return () => {
      stale = true;
    };
  }, [env]);

  useEffect(() => {
    if (resumed) env.saveProgress({ step, done: [...done], runOn });
  }, [env, resumed, step, done, runOn]);

  const finish = (which: Step, next: Step) => {
    setDone((current) => new Set(current).add(which));
    setStep(next);
  };

  return (
    <div className="flex min-h-screen flex-col items-center px-6 py-8">
      <header className="flex w-full max-w-3xl items-center justify-between">
        <span className="flex items-center gap-1.5 font-mono text-sm">
          <Terminal className="size-4" aria-hidden />
          <span className="font-semibold tracking-tight">outrunner</span>
          <span className="text-muted-foreground ml-2 font-sans text-xs">Setting up {env.org.name}</span>
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

      <div className={cn("border-border/60 mt-6 w-full border-b pb-6", !resumed && "invisible")}>
        <Stepper steps={STEPS} current={step} done={done} onGo={setStep} />
      </div>

      <main className="flex w-full max-w-xl flex-1 flex-col justify-center py-10">
        {!resumed || !status ? (
          <p className="text-muted-foreground text-sm">Checking what you&apos;ve connected…</p>
        ) : (
          <>
            {step === "agent" && (
              <AgentStep
                env={env}
                status={status}
                onStatus={setStatus}
                onDone={(pick) => {
                  setRunOn(pick);
                  finish("agent", "github");
                }}
              />
            )}
            {step === "github" && <GitHubStep env={env} onDone={() => finish("github", "repos")} />}
            {(step === "repos" || (step === "environment" && picked.length === 0)) && (
              <ReposStep
                env={env}
                onDone={(projects) => {
                  setPicked(projects);
                  finish("repos", "environment");
                }}
              />
            )}
            {step === "environment" && picked.length > 0 && (
              <EnvironmentStep
                env={env}
                projects={picked}
                onBack={() => setStep("repos")}
                onDone={(environmentId) => env.finish(environmentId, runOn).then(onLeave)}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}
