"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, GitBranch, Github } from "lucide-react";
import { useState, useTransition } from "react";

import { RepositorySelect } from "@/components/repository-select";
import { SessionComposer } from "@/components/session-composer";
import { Button } from "@/components/ui/button";
import { WorkspaceCreating } from "@/components/workspace-creating";
import type { Project } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

type CreateResponse = { workspace?: { id: string }; error?: string };

/**
 * The isolated Daytona sandbox each workspace runs in — shown on creation so
 * it's clear the project executes in a box, not locally. Fixed spec for now
 * (the default Daytona image); becomes a size picker when we support sizing.
 */
const SANDBOX_TIER = "Sandbox";
const SANDBOX_SPEC = "1 vCPU · 1 GiB · 3 GiB disk";

/**
 * The new-session screen: a faded wordmark over a centered composer, with a
 * repository + base-branch selector beneath it. Submitting creates a workspace
 * from the chosen repo and opens it, carrying the first prompt along so the
 * session starts on that instruction.
 */
export function NewSessionCreator({
  projects,
  initialProjectId,
}: {
  projects: Project[];
  initialProjectId?: string;
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(
    initialProjectId && projects.some((p) => p.id === initialProjectId)
      ? initialProjectId
      : (projects[0]?.id ?? ""),
  );
  const [message, setMessage] = useState<string | null>(null);
  // Set when the failure is something the user fixes in settings, so the error
  // can offer the way out instead of just naming the problem.
  const [messageHref, setMessageHref] = useState<string | null>(null);
  const [isCreating, startCreating] = useTransition();

  const selected = projects.find((project) => project.id === projectId);

  function create(prompt: string) {
    if (!selected) return;
    startCreating(async () => {
      setMessage(null);
      setMessageHref(null);
      let response: Response;
      try {
        response = await fetch(`/api/projects/${selected.id}/workspaces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch: "" }),
        });
      } catch {
        setMessage("Could not reach Runtime. Please try again.");
        return;
      }
      const result = (await response.json().catch(() => ({}))) as CreateResponse;
      if (!response.ok || !result.workspace) {
        setMessage(result.error ?? "Could not start the session. Please try again.");
        // 409 is the precondition family: a missing Anthropic key or GitHub
        // connection. Both are fixed in the same place.
        if (response.status === 409) setMessageHref("/settings/credentials");
        return;
      }
      const query = prompt.trim()
        ? `?prompt=${encodeURIComponent(prompt.trim())}`
        : "";
      router.push(`/workspaces/${result.workspace.id}${query}`);
      router.refresh();
    });
  }

  // Provisioning takes tens of seconds; show a staged progress screen instead
  // of freezing the composer behind a spinner. It's an overlay — the form stays
  // mounted (hidden) underneath so a failed create returns the user to a
  // composer that still holds the prompt they just typed.
  return (
    <>
      {isCreating && selected && (
        <WorkspaceCreating
          projectName={selected.fullName}
          branch={selected.defaultBranch}
        />
      )}
      <div
        className={cn(
          "flex min-h-screen flex-col items-center justify-center px-6",
          isCreating && selected && "hidden",
        )}
      >
        <div className="w-full max-w-2xl">
        <p
          aria-hidden
          className="pointer-events-none mb-6 select-none text-center text-[13vw] font-bold leading-none tracking-tight text-neutral-800 sm:text-[96px]"
        >
          neevai
        </p>

        <>
            <SessionComposer
              onSend={create}
              canSend={!isCreating && selected != null}
              disabledPlaceholder="Pick a repository below to start…"
            />

            <div className="mt-5 flex items-center justify-center gap-2.5 text-[15px]">
              <RepositorySelect
                projects={projects}
                selectedProjectId={projectId}
                onSelect={setProjectId}
                disabled={isCreating}
              />

              <span className="text-muted-foreground">/</span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <GitBranch className="size-4" />
                {selected?.defaultBranch ?? "main"}
              </span>

              <span className="text-muted-foreground">·</span>
              <span
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[13px] text-foreground"
                title="This workspace runs in an isolated Daytona sandbox — the project is cloned into a cloud box, not your machine."
              >
                <Box className="size-4 text-muted-foreground" />
                <span className="font-medium">{SANDBOX_TIER}</span>
                <span className="text-muted-foreground">{SANDBOX_SPEC}</span>
              </span>
            </div>

            {message && (
              <div
                aria-live="polite"
                className="border-destructive/30 bg-destructive/10 mx-auto mt-5 max-w-md rounded-lg border px-4 py-3 text-center"
              >
                <p className="text-destructive text-sm">{message}</p>
                {messageHref && (
                  <Link
                    href={messageHref}
                    className="mt-2 inline-block text-sm font-medium underline underline-offset-4"
                  >
                    Open settings
                  </Link>
                )}
              </div>
            )}
        </>
        </div>
      </div>
    </>
  );
}
