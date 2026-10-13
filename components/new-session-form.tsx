"use client";

import { GitBranch, GitFork } from "lucide-react";
import Link from "next/link";

import { ProjectsSyncButton } from "@/components/projects-sync-button";
import { RepositorySelect } from "@/components/repository-select";
import { SessionComposer } from "@/components/session-composer";
import { LocalBlocker, LocalFolderButton, SessionLocationMenu } from "@/components/session-location-picker";
import { WorkspaceCreating } from "@/components/workspace-creating";
import { useCreateSession } from "@/hooks/use-create-session";
import { useSessionLocation } from "@/hooks/use-session-location";
import type { Project } from "@/lib/runtime/types";
import { newSessionDetails } from "@/lib/session/new-session-target";

/** One item in the row beneath the wordmark: where, what, which branch, how. */
const CHIP = "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground";
const CHIP_BUTTON = `${CHIP} transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50`;

/**
 * The new-session screen, filling the page: a faded wordmark with what the
 * session would run on beneath it (cloud or this Mac, the repository or folder,
 * its branch, and whether it gets a worktree), and the composer pinned to the
 * bottom, where the session's own composer sits once it opens. Submitting
 * creates a workspace and opens it, carrying the first prompt so the session
 * starts on that instruction.
 */
export function NewSessionForm({
  projects,
  initialProjectId,
}: {
  projects: Project[];
  /** Repo to preselect (the last-used project). Falls back to the first. */
  initialProjectId?: string;
}) {
  const { projectId, setProjectId, selected, isCreating, message, messageHref, create, createLocal } =
    useCreateSession(projects, initialProjectId);
  const where = useSessionLocation();
  const local = where.location === "local";
  // No repositories only blocks the cloud; a local session needs none.
  const noRepositories = !local && projects.length === 0;
  const details = newSessionDetails(
    local
      ? { kind: "local", folder: where.folder.state === "ok" ? where.folder.folder : null }
      : { kind: "cloud", project: selected },
  );

  // A local session opens in about a second, so it gets no progress screen.
  // The cloud one covers the form rather than replacing it: the composer stays
  // mounted underneath, so a creation that fails hands its prompt back.
  const showProgress = isCreating && !local && selected;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {showProgress && (
        <div className="absolute inset-0 z-20 bg-background">
          <WorkspaceCreating projectName={selected.fullName} branch={selected.defaultBranch} />
        </div>
      )}
      <div
        inert={Boolean(showProgress)}
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10"
      >
        <p
          aria-hidden
          className="pointer-events-none mb-10 select-none text-center font-display text-[13vw] leading-none text-foreground/20 sm:text-[112px]"
        >
          outrunner
        </p>

        {noRepositories ? (
          <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-dashed py-10 text-center">
            <p className="text-sm font-medium">No repositories synchronized</p>
            <p className="text-muted-foreground max-w-xs text-xs">
              Pull in the repositories your GitHub token can access to start a session.
            </p>
            <ProjectsSyncButton align="center" />
            {where.runtime.state === "ready" && (
              <button
                type="button"
                onClick={() => where.setLocation("local")}
                className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
              >
                Or work in a folder on this Mac
              </button>
            )}
          </div>
        ) : (
          <div className="flex max-w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[15px]">
            <SessionLocationMenu state={where} disabled={isCreating} className={CHIP_BUTTON} />
            {local ? (
              <LocalFolderButton state={where} disabled={isCreating} className={CHIP_BUTTON} />
            ) : (
              <RepositorySelect
                projects={projects}
                selectedProjectId={projectId}
                onSelect={setProjectId}
                disabled={isCreating}
                triggerClassName={CHIP_BUTTON}
              />
            )}
            {details.branch && (
              <span className={CHIP} title="The branch the session starts from">
                <GitBranch className="size-4 shrink-0" />
                <span className="truncate font-mono text-sm">{details.branch}</span>
              </span>
            )}
            {details.worktree && (
              <span className={CHIP} title={details.worktree.title}>
                <GitFork className="size-4 shrink-0" />
                {details.worktree.label}
              </span>
            )}
          </div>
        )}

        <LocalBlocker state={where} className="mt-4 text-center" />
      </div>

      <div inert={Boolean(showProgress)} className="shrink-0">
        {message && (
          <div
            aria-live="polite"
            className="border-destructive/30 bg-destructive/10 mx-auto w-[calc(100%-32px)] max-w-[720px] rounded-lg border px-4 py-3 text-center"
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
        <SessionComposer
          onSend={(text, attachmentIds) =>
            where.localFolder
              ? createLocal(text, where.localFolder, where.outrunnerModel)
              : create(text, attachmentIds)
          }
          canSend={!isCreating && (local ? where.localFolder !== null : selected != null)}
          placeholder="What would you like to work on?"
          disabledPlaceholder={
            local && where.blocker
              ? where.blocker
              : noRepositories
                ? "Sync a repository to start…"
                : "Pick a repository above to start…"
          }
          allowAttachments={!local}
        />
      </div>
    </div>
  );
}
