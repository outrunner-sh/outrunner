"use client";

import Link from "next/link";

import { ProjectsSyncButton } from "@/components/projects-sync-button";
import { RepositorySelect } from "@/components/repository-select";
import { SessionComposer } from "@/components/session-composer";
import { WorkspaceCreating } from "@/components/workspace-creating";
import { useCreateSession } from "@/hooks/use-create-session";
import type { Project } from "@/lib/runtime/types";

/**
 * The reusable new-session form (full-page layout): a composer with a repository
 * selector beneath it. Submitting creates a workspace from the chosen repo and
 * opens it, carrying the first prompt so the session starts on that instruction.
 * The home page opens the same flow in a modal (NewSessionDialog); both share
 * the create logic via useCreateSession.
 */
export function NewSessionForm({
  projects,
  initialProjectId,
}: {
  projects: Project[];
  /** Repo to preselect (the last-used project). Falls back to the first. */
  initialProjectId?: string;
}) {
  const { projectId, setProjectId, selected, isCreating, message, messageHref, create } =
    useCreateSession(projects, initialProjectId);

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed py-12 text-center">
        <p className="text-sm font-medium">No repositories synchronized</p>
        <p className="text-muted-foreground max-w-xs text-xs">
          Pull in the repositories your GitHub token can access to start a session.
        </p>
        <ProjectsSyncButton align="center" />
      </div>
    );
  }

  return (
    <>
      {isCreating && selected && (
        <WorkspaceCreating
          projectName={selected.fullName}
          branch={selected.defaultBranch}
        />
      )}

      <SessionComposer
        onSend={create}
        canSend={!isCreating && selected != null}
        disabledPlaceholder="Pick a repository below to start…"
      />

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-[15px]">
        <RepositorySelect
          projects={projects}
          selectedProjectId={projectId}
          onSelect={setProjectId}
          disabled={isCreating}
        />
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
  );
}
