"use client";

import { Check } from "lucide-react";
import { useState } from "react";

import { LoadingButton } from "@/components/ui/loading-button";
import type { OnboardingEnv } from "@/lib/onboarding/types";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/**
 * Step 3: a first session, on one of the repositories just picked. Its box
 * starts as the session opens; the session page shows it setting up. Home is
 * the other way out.
 */
export function StartStep({
  env,
  projects,
  onLeave,
}: {
  env: OnboardingEnv;
  projects: Project[];
  onLeave: (href: string) => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? null);
  const [leaving, setLeaving] = useState<"start" | "home" | null>(null);
  const [error, setError] = useState<{ message: string; href?: string } | null>(null);

  async function go(way: "start" | "home") {
    if (leaving) return;
    setLeaving(way);
    setError(null);
    try {
      onLeave(way === "start" && projectId ? await env.startSession(projectId) : await env.skip());
    } catch (e) {
      setError({
        message: e instanceof Error ? e.message : "The session didn't start. Please try again.",
        href: (e as { href?: string }).href,
      });
      setLeaving(null);
    }
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Start your first session</h1>
        <p className="text-muted-foreground text-sm">It gets a cloud computer of its own, with the repository cloned and your agent ready.</p>
      </div>

      <ul role="radiogroup" aria-label="Repository" className="border-border/60 overflow-hidden rounded-xl border">
        {projects.map((project) => {
          const on = project.id === projectId;
          return (
            <li key={project.id} className="border-border/60 border-b last:border-b-0">
              <button
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setProjectId(project.id)}
                className={cn("flex w-full items-center gap-3 px-4 py-3 text-left", on ? "bg-accent/40" : "hover:bg-accent/30")}
              >
                <span className={cn("flex size-4 items-center justify-center rounded-full border", on ? "border-foreground" : "border-border")}>
                  {on && <span className="bg-foreground size-2 rounded-full" />}
                </span>
                <span className="text-foreground/90 font-mono text-[13px]">{project.fullName}</span>
                <span className="text-muted-foreground ml-auto text-xs">{project.defaultBranch}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error.message}{" "}
          {error.href && (
            <a href={error.href} className="underline underline-offset-4">
              Open settings
            </a>
          )}
        </p>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => void go("home")}
          disabled={leaving !== null}
          className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
        >
          {leaving === "home" ? "Opening home…" : "Not now, go to home"}
        </button>
        <LoadingButton
          size="default"
          status={leaving === "start" ? "pending" : "idle"}
          disabled={!projectId || leaving === "home"}
          onClick={() => void go("start")}
          icon={<Check className="size-4" />}
          labels={{ idle: "Start session", pending: "Starting" }}
        />
      </div>
    </section>
  );
}
