"use client";

import { GitBranch, GitFork } from "lucide-react";
import { useEffect, useState } from "react";

import { ProjectsSyncButton } from "@/components/projects-sync-button";
import { RepositorySelect } from "@/components/repository-select";
import { SessionComposer } from "@/components/session-composer";
import { Notice } from "@/components/ui/notice";
import { LocalBlocker, LocalRepositoryButton, SessionLocationMenu } from "@/components/session-location-picker";
import { useCreateSession } from "@/hooks/use-create-session";
import { useSessionLocation } from "@/hooks/use-session-location";
import { outrunnerModels, type OutrunnerModels } from "@/lib/desktop/local-runtime";
import { loadoutDefault } from "@/lib/runtime/model-loadout";
import { agentOf, defaultModel, modelGroups, type SessionModel } from "@/lib/runtime/session-models";
import type { Project } from "@/lib/runtime/types";
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";
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
 * starts on that instruction once its box is ready.
 */
export function NewSessionForm({
  projects: listed,
  initialProjectId,
}: {
  projects: Project[];
  /** Repo to preselect (the last-used project). Falls back to the first. */
  initialProjectId?: string;
}) {
  const { projects, projectId, selectProject, selected, isCreating, message, messageAction, create, createLocal } =
    useCreateSession(listed, initialProjectId);
  // The model the session starts on, picked in the composer as in a session;
  // none picked, what it starts on anyway: the menu's default on the cloud,
  // and on a Mac whose Claude Code isn't logged in; otherwise that Mac's
  // Claude Code default.
  const [menu, setMenu] = useState<OutrunnerModels | null>(null);
  useEffect(() => {
    let live = true;
    void outrunnerModels().then((answer) => {
      if (live) setMenu(answer);
    });
    return () => {
      live = false;
    };
  }, []);
  // The model picked in the composer, else the loadout's default: its agent
  // decides what this Mac needs for a local session (Claude Code, or Codex).
  const [picked, setPicked] = useState<SessionModel | null>(null);
  const where = useSessionLocation(agentOf((picked ?? menu?.loadout.default)?.provider ?? "claude"));
  const local = where.location === "local";
  // No repositories only blocks the cloud; a local session needs none.
  const noRepositories = !local && projects.length === 0;
  const details = newSessionDetails(
    local
      ? { kind: "local", folder: where.folder.state === "ok" ? where.folder.folder : null }
      : { kind: "cloud", project: selected },
  );

  const groups = menu
    ? modelGroups(menu).filter(
        // A Mac whose Claude Code isn't logged in has no Claude account to run.
        (group) => !(local && where.outrunnerModel && group.provider === "claude"),
      )
    : [];
  const onDefault = local ? where.outrunnerModel : menu?.available === true;
  // The loadout's default (Settings → Default models) where the menu offers
  // it here; else what a session starts on without one.
  const chosenDefault = menu ? (loadoutDefault(menu.loadout, groups) ?? null) : null;
  const startsOn = picked ?? chosenDefault ?? (onDefault && menu ? defaultModel(menu) : null);
  const startModel = picked ?? chosenDefault ?? undefined;

  // Either kind of session opens in about a second (a cloud one shows its
  // setup progress on its own page), so the form only waits, disabled; one
  // that fails hands its prompt back.
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
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
            {LOCAL_SESSIONS && where.runtime.state === "ready" && (
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
            {LOCAL_SESSIONS && <SessionLocationMenu state={where} disabled={isCreating} className={CHIP_BUTTON} />}
            {local ? (
              <LocalRepositoryButton state={where} disabled={isCreating} className={CHIP_BUTTON} />
            ) : (
              <RepositorySelect
                projects={projects}
                selectedProjectId={projectId}
                onSelect={selectProject}
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

      <div className="shrink-0">
        {message && (
          // A failure with a way out is a step to take first, not an error.
          <Notice
            className="mx-auto w-[calc(100%-32px)] max-w-[720px]"
            tone={messageAction ? "info" : "error"}
            title={messageAction ? "One step before this session starts" : "Couldn't start the session"}
            detail={message}
            actions={messageAction ? [{ ...messageAction, primary: true }] : undefined}
          />
        )}
        <SessionComposer
          onSend={(text, attachmentIds) =>
            where.localFolder
              ? createLocal(
                  text,
                  where.localFolder,
                  where.outrunnerModel,
                  startModel,
                  where.runtime.state === "ready" ? where.runtime.status : null,
                )
              : create(text, attachmentIds, startModel)
          }
          model={startsOn?.id}
          modelChoice={
            groups.length > 0
              ? {
                  groups,
                  onChange: setPicked,
                  switching: false,
                  disabledReason: isCreating ? "Starting the session" : null,
                  preferredProvider: startsOn?.provider,
                  loadout: menu?.loadout,
                }
              : undefined
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
