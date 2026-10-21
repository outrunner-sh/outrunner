"use client";

import { useCallback, useState } from "react";
import { ArrowLeft, ArrowRight, Cloud, Laptop, Loader2, Terminal } from "lucide-react";

import { CloudSetup } from "@/components/onboarding/cloud-setup";
import { MacSetup } from "@/components/onboarding/mac-setup";
import { Button } from "@/components/ui/button";
import type { CloudModel } from "@/lib/onboarding/claude-choice";
import type {
  OnboardingEnv,
  OnboardingFinish,
  OnboardingFolder,
  OnboardingRepo,
  RunTarget,
} from "@/lib/onboarding/types";
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";
import { cn } from "@/lib/utils";

type Step = "welcome" | "where" | "setup";

/** The ways out of the last step: a first session, home, or the import. */
type Leaving = "start" | "finish" | "import";

/**
 * First run, in three steps: welcome, where sessions run, and a live checklist
 * for that choice. On this Mac it ends by starting the session itself. In the
 * cloud it ends with the repositories connected, and the user picks what's
 * next: home, a first session in one of them, or importing this Mac's work.
 * Each step asks only for what the choice needs. While new local sessions are
 * off there is no choice to make: welcome, then the cloud's checklist.
 */
export function OnboardingFlow({
  env,
  onLeave,
  localSessions = LOCAL_SESSIONS,
}: {
  env: OnboardingEnv;
  /** Go where onboarding sends the user next: the first session, or home. */
  onLeave?: (href: string) => void;
  /** Whether This Mac is offered (lib/session/local-sessions.ts). */
  localSessions?: boolean;
}) {
  const steps: readonly Step[] = localSessions ? ["welcome", "where", "setup"] : ["welcome", "setup"];
  const [step, setStep] = useState<Step>("welcome");
  const [target, setTarget] = useState<RunTarget | null>(localSessions ? null : "cloud");
  const [ready, setReady] = useState(false);
  const [folder, setFolder] = useState<OnboardingFolder | null>(null);
  const [model, setModel] = useState<CloudModel>(null);
  const [picked, setPicked] = useState<OnboardingRepo[]>([]);
  // Which way out is under way: its button spins, and every other waits.
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [error, setError] = useState<string | null>(null);

  const index = steps.indexOf(step);
  const afterWelcome: Step = localSessions ? "where" : "setup";
  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const onReady = useCallback((value: boolean) => setReady(value), []);

  const leave = async (how: Leaving, input: OnboardingFinish) => {
    setLeaving(how);
    setError(null);
    try {
      const href = await env.finish(input);
      // Leaving: keep the spinner up until the next page replaces this one.
      if (href) return onLeave?.(href);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not finish setting up.");
    }
    setLeaving(null);
  };

  // The first repository picked is where a first session starts, named on
  // its button; it starts only on a model there is (claude-choice.ts).
  const repoIds = picked.map((repo) => repo.id);
  const startRepo = picked[0] ?? null;
  const startInCloud = () =>
    startRepo &&
    model &&
    leave("start", { target: "cloud", repoIds, session: { repoId: startRepo.id, model } });
  const finishCloud = (next: "home" | "import") =>
    leave(next === "import" ? "import" : "finish", { target: "cloud", repoIds, next });

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
          {step !== "welcome" && steps.length > 2 && <Progress steps={steps} index={index} />}
          {skip && (
            <button
              type="button"
              onClick={() => void skip()}
              disabled={skipping || leaving !== null}
              className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
            >
              Skip for now
            </button>
          )}
        </div>
      </header>

      <main className="flex w-full max-w-xl flex-1 flex-col justify-center py-10">
        {step === "welcome" && (
          <Welcome name={env.user.name} onMac={localSessions} onNext={() => go(afterWelcome)} />
        )}

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
                  : "Pick the repositories to work in. Start a session now, or whenever you're ready."
              }
            />
            {target === "mac" ? (
              <MacSetup env={env} folder={folder} onFolder={setFolder} onReady={onReady} />
            ) : (
              <CloudSetup
                env={env}
                model={model}
                onModel={setModel}
                picked={picked}
                onPicked={setPicked}
                onReady={onReady}
                onImport={() => void finishCloud("import")}
                busy={leaving !== null}
              />
            )}
            {leaving === "start" && target === "cloud" && (
              <p className="text-muted-foreground text-sm">
                Setting up your cloud machine. This takes about a minute the first time.
              </p>
            )}
            {error && <p className="text-destructive text-sm">{error}</p>}
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                onClick={() => go(localSessions ? "where" : "welcome")}
                disabled={leaving !== null}
              >
                <ArrowLeft className="size-4" /> Back
              </Button>
              {target === "mac" ? (
                <Button
                  onClick={() => void leave("start", { target: "mac", folder: folder ?? undefined })}
                  disabled={!ready || leaving !== null}
                >
                  <Spinner on={leaving === "start"} />
                  Start session
                </Button>
              ) : (
                <div className="flex min-w-0 items-center gap-2">
                  {startRepo && (
                    <Button
                      variant="outline"
                      onClick={() => void startInCloud()}
                      disabled={model === null || leaving !== null}
                      title={model === null ? "Connect Claude to start a session." : undefined}
                      className="min-w-0"
                    >
                      <Spinner on={leaving === "start"} />
                      <span className="truncate">Start a session in {startRepo.fullName.split("/")[1]}</span>
                    </Button>
                  )}
                  <Button onClick={() => void finishCloud("home")} disabled={!ready || leaving !== null}>
                    <Spinner on={leaving === "finish"} />
                    Finish
                  </Button>
                </div>
              )}
            </div>
          </section>
        )}

      </main>
    </div>
  );
}

function Welcome({ name, onMac, onNext }: { name: string; onMac: boolean; onNext: () => void }) {
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
          Run fleets of coding agents {onMac ? "on this Mac or in the cloud" : "in the cloud"}.
        </p>
      </div>
      <Button size="lg" onClick={onNext}>
        Get started <ArrowRight className="size-4" />
      </Button>
    </section>
  );
}

function Spinner({ on }: { on: boolean }) {
  return on ? <Loader2 className="size-4 animate-spin" /> : null;
}

function Heading({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="space-y-1">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted-foreground text-sm">{detail}</p>
    </div>
  );
}

function Progress({ steps, index }: { steps: readonly Step[]; index: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground text-xs">
        Step {index} of {steps.length - 1}
      </span>
      <div className="flex gap-1">
        {steps.slice(1).map((s, i) => (
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
