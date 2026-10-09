"use client";

import { useCallback, useState } from "react";
import { ArrowLeft, ArrowRight, Cloud, Laptop, Loader2, Terminal } from "lucide-react";

import { CloudSetup, type CloudModel } from "@/components/onboarding/cloud-setup";
import { MacSetup } from "@/components/onboarding/mac-setup";
import { Button } from "@/components/ui/button";
import type { OnboardingEnv, OnboardingFolder, RunTarget } from "@/lib/onboarding/types";
import { cn } from "@/lib/utils";

const STEPS = ["welcome", "where", "setup", "start"] as const;
type Step = (typeof STEPS)[number];

const SUGGESTIONS = [
  "Explain how this codebase is organised",
  "Find a bug and fix it",
  "Add tests for the most important code path",
];

/**
 * First run, in four steps: welcome, where sessions run, a live checklist for
 * that choice, and the first prompt. Each step asks only for what the choice
 * needs; nothing is collected that the user's first session won't use.
 */
export function OnboardingFlow({
  env,
  onLeave,
}: {
  env: OnboardingEnv;
  /** Go where onboarding sends the user next: the first session, or home. */
  onLeave?: (href: string) => void;
}) {
  const [step, setStep] = useState<Step>("welcome");
  const [target, setTarget] = useState<RunTarget | null>(null);
  const [ready, setReady] = useState(false);
  const [folder, setFolder] = useState<OnboardingFolder | null>(null);
  const [model, setModel] = useState<CloudModel>(null);
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const index = STEPS.indexOf(step);
  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const onReady = useCallback((value: boolean) => setReady(value), []);

  const start = async () => {
    if (!target || !prompt.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const href = await env.start({
        target,
        prompt: prompt.trim(),
        ...(target === "mac" ? { folder: folder ?? undefined } : { repoIds, model: model ?? "neev" }),
      });
      // Leaving: keep the spinner up until the session page replaces this one.
      if (href) return onLeave?.(href);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the session.");
    }
    setStarting(false);
  };

  const [skipping, setSkipping] = useState(false);
  const skip = env.skip
    ? async () => {
        setSkipping(true);
        try {
          onLeave?.(await env.skip!());
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not skip onboarding.");
          setSkipping(false);
        }
      }
    : null;

  return (
    <div className="flex min-h-screen flex-col items-center px-6 py-10">
      <header className="flex w-full max-w-xl items-center justify-between">
        <div className="flex items-center gap-2 font-mono text-sm">
          <Terminal className="size-4" />
          <span className="font-semibold tracking-tight">outrunner</span>
        </div>
        <div className="flex items-center gap-4">
          {step !== "welcome" && <Progress index={index} />}
          {skip && (
            <button
              type="button"
              onClick={() => void skip()}
              disabled={skipping || starting}
              className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
            >
              Skip for now
            </button>
          )}
        </div>
      </header>

      <main className="flex w-full max-w-xl flex-1 flex-col justify-center py-10">
        {step === "welcome" && <Welcome name={env.user.name} onNext={() => go("where")} />}

        {step === "where" && (
          <section className="space-y-6">
            <Heading
              title="Where should your agents run?"
              detail="You can use both. Pick one to start with."
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <TargetCard
                icon={<Laptop className="size-5" />}
                title="This Mac"
                detail="In any folder on this Mac, with your own Claude Code."
                note={env.desktop ? undefined : "Needs the Outrunner Mac app"}
                selected={target === "mac"}
                disabled={!env.desktop}
                onSelect={() => setTarget("mac")}
              />
              <TargetCard
                icon={<Cloud className="size-5" />}
                title="Cloud"
                detail="On your GitHub repositories, on a machine that keeps running when you close your laptop."
                selected={target === "cloud"}
                onSelect={() => setTarget("cloud")}
              />
            </div>
            <Nav onBack={() => go("welcome")} onNext={() => go("setup")} nextDisabled={!target} />
          </section>
        )}

        {step === "setup" && target && (
          <section className="space-y-6">
            <Heading
              title={target === "mac" ? "Set up this Mac" : "Set up the cloud"}
              detail={
                target === "mac"
                  ? "A few things local sessions need. Each one checks itself."
                  : "Pick the AI and the repositories your sessions work in."
              }
            />
            {target === "mac" ? (
              <MacSetup env={env} folder={folder} onFolder={setFolder} onReady={onReady} />
            ) : (
              <CloudSetup
                env={env}
                model={model}
                onModel={setModel}
                repoIds={repoIds}
                onRepoIds={setRepoIds}
                onReady={onReady}
              />
            )}
            <Nav onBack={() => go("where")} onNext={() => go("start")} nextDisabled={!ready} />
          </section>
        )}

        {step === "start" && target && (
          <section className="space-y-6">
            <Heading
              title="What should your first agent do?"
              detail={
                target === "mac"
                  ? `On this Mac, in ${folder?.name ?? "your folder"}.`
                  : `In the cloud, on ${repoIds.length === 1 ? "1 repository" : `${repoIds.length} repositories`}, with ${model === "claude" ? "your Claude" : "Neev AI models"}.`
              }
            />
            <div className="border-border/60 bg-card/30 rounded-xl border p-3">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
                }}
                rows={4}
                autoFocus
                placeholder="Describe a task…"
                className="w-full resize-none bg-transparent text-sm outline-none"
              />
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setPrompt(s)}
                    className="border-border/60 text-muted-foreground hover:text-foreground hover:bg-accent/40 rounded-full border px-2.5 py-1 text-xs"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            {starting && target === "cloud" && (
              <p className="text-muted-foreground text-sm">
                Setting up your cloud machine. This takes about a minute the first time.
              </p>
            )}
            {error && <p className="text-destructive text-sm">{error}</p>}
            <div className="flex items-center justify-between">
              <Button variant="ghost" onClick={() => go("setup")} disabled={starting}>
                <ArrowLeft className="size-4" /> Back
              </Button>
              <Button onClick={() => void start()} disabled={starting || !prompt.trim()}>
                {starting ? <Loader2 className="size-4 animate-spin" /> : null}
                Start session
              </Button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function Welcome({ name, onNext }: { name: string; onNext: () => void }) {
  return (
    <section className="space-y-8 text-center">
      <p
        aria-hidden
        className="pointer-events-none select-none text-[16vw] font-bold leading-none tracking-tight text-neutral-800 sm:text-[96px]"
      >
        outrunner
      </p>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Welcome, {name.split(" ")[0]}</h1>
        <p className="text-muted-foreground mx-auto max-w-sm text-sm">
          Run many Claude Code agents in parallel, on this Mac or in the cloud. Two minutes of setup,
          then your first session.
        </p>
      </div>
      <Button size="lg" onClick={onNext}>
        Get started <ArrowRight className="size-4" />
      </Button>
    </section>
  );
}

function Heading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted-foreground text-sm">{detail}</p>
    </div>
  );
}

function Progress({ index }: { index: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground text-xs">
        Step {index} of {STEPS.length - 1}
      </span>
      <div className="flex gap-1">
        {STEPS.slice(1).map((s, i) => (
          <span
            key={s}
            className={cn("h-1 w-6 rounded-full", i < index ? "bg-foreground" : "bg-muted")}
          />
        ))}
      </div>
    </div>
  );
}

function TargetCard({
  icon,
  title,
  detail,
  note,
  selected,
  disabled,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  note?: string;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "border-border/60 bg-card/30 flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors",
        "hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card/30",
        selected && "border-foreground/60 bg-accent/40",
      )}
    >
      <span className="text-muted-foreground">{icon}</span>
      <span className="space-y-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs leading-relaxed">{detail}</span>
      </span>
      {note && <span className="text-warning text-xs">{note}</span>}
    </button>
  );
}

function Nav({
  onBack,
  onNext,
  nextDisabled,
}: {
  onBack: () => void;
  onNext: () => void;
  nextDisabled: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft className="size-4" /> Back
      </Button>
      <Button onClick={onNext} disabled={nextDisabled}>
        Continue <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}
