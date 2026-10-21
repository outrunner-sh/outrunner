"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Cloud, Laptop, Loader2, Terminal } from "lucide-react";

import { ImportStep } from "@/components/onboarding/import-step";
import { MacSetup } from "@/components/onboarding/mac-setup";
import { PlansStep, type PlansLeaving } from "@/components/onboarding/plans-step";
import { Button } from "@/components/ui/button";
import { importProjects } from "@/lib/onboarding/import-projects";
import type { CloudNext, OnboardingEnv, OnboardingFinish, OnboardingFolder, RunTarget } from "@/lib/onboarding/types";
import type { ImportScan } from "@/lib/runtime/import-scan";
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";
import { cn } from "@/lib/utils";

type Step = "welcome" | "where" | "setup" | "import" | "plans";

/** The ways out: a first session on this Mac, or one of the plans step's. */
type Leaving = "start" | PlansLeaving;

/**
 * First run. Welcome, then where sessions run. On this Mac, a live checklist
 * that ends by starting the session itself. In the cloud, the projects this
 * Mac is working on, to bring over with their active sessions (offered only
 * in the Mac app, when its scan finds some), then the plans, free to start,
 * with the way to the user's own models. No repository has to be picked:
 * projects are added once onboarded. While new local sessions are off there
 * is no choice of where: welcome, then the cloud's steps.
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
  const [step, setStep] = useState<Step>("welcome");
  const [target, setTarget] = useState<RunTarget | null>(localSessions ? null : "cloud");
  const [ready, setReady] = useState(false);
  const [folder, setFolder] = useState<OnboardingFolder | null>(null);
  // Which way out is under way: its button spins, and every other waits.
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // The Mac's scan starts at once, so it's in by the time the user is past
  // welcome. Undefined while it runs; null outside the Mac app or on failure.
  const [scan, setScan] = useState<ImportScan | null | undefined>(env.desktop ? undefined : null);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    if (!env.desktop) return;
    let live = true;
    env.findImports().then(
      (found) => live && setScan(found),
      () => live && setScan(null),
    );
    return () => {
      live = false;
    };
  }, [env]);
  const projects = useMemo(() => (scan === undefined ? undefined : importProjects(scan, now)), [scan, now]);

  // The import step only while the scan may still find something, or did.
  const offerImport = projects === undefined || projects.length > 0;
  const steps: Step[] = [
    "welcome",
    ...(localSessions ? (["where"] as const) : []),
    ...(target === "mac" ? (["setup"] as const) : offerImport ? (["import", "plans"] as const) : (["plans"] as const)),
  ];
  // A scan that found nothing drops the import step under a user already on it.
  const current: Step = steps.includes(step) ? step : "plans";
  const index = steps.indexOf(current);
  const go = (next: Step | undefined) => {
    if (!next) return;
    setError(null);
    setStep(next);
  };
  const back = () => go(steps[index - 1]);
  const forward = () => go(steps[index + 1]);
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
  const leaveCloud = (next: CloudNext) =>
    void leave(next.to === "plan" ? next.plan : next.to, { target: "cloud", next });

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

  // The plans sit side by side: the one step that needs the room.
  const width = current === "plans" && env.prices ? "max-w-3xl" : "max-w-xl";

  return (
    <div className="flex min-h-screen flex-col items-center px-6 py-10">
      <header className={cn("flex w-full items-center justify-between", width)}>
        <div className="flex items-center gap-2 font-mono text-sm">
          <Terminal className="size-4" />
          <span className="font-semibold tracking-tight">outrunner</span>
        </div>
        <div className="flex items-center gap-4">
          {current !== "welcome" && steps.length > 2 && <Progress steps={steps} index={index} />}
          {skip && (
            <button
              type="button"
              onClick={() => void skip()}
              disabled={skipping || importing || leaving !== null}
              className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
            >
              Skip for now
            </button>
          )}
        </div>
      </header>

      <main className={cn("flex w-full flex-1 flex-col justify-center py-10", width)}>
        {current === "welcome" && <Welcome name={env.user.name} onMac={localSessions} onNext={forward} />}

        {current === "where" && (
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
            <Nav onBack={back} onNext={forward} nextDisabled={!target} />
          </section>
        )}

        {current === "setup" && (
          <section className="space-y-6">
            <Heading title="Set up this Mac" detail="A few things local sessions need. Each one checks itself." />
            <MacSetup env={env} folder={folder} onFolder={setFolder} onReady={onReady} />
            {error && <p className="text-destructive text-sm">{error}</p>}
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={back} disabled={leaving !== null}>
                <ArrowLeft className="size-4" /> Back
              </Button>
              <Button
                onClick={() => void leave("start", { target: "mac", folder: folder ?? undefined })}
                disabled={!ready || leaving !== null}
              >
                <Spinner on={leaving === "start"} />
                Start session
              </Button>
            </div>
          </section>
        )}

        {current === "import" && (
          <ImportStep
            env={env}
            projects={projects}
            now={now}
            onBack={back}
            onNext={forward}
            onImporting={setImporting}
            disabled={leaving !== null || skipping}
          />
        )}

        {current === "plans" && (
          <>
            <PlansStep prices={env.prices} leaving={leaving === "start" ? null : leaving} onBack={back} onLeave={leaveCloud} />
            {error && <p className="text-destructive mt-4 text-sm">{error}</p>}
          </>
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
