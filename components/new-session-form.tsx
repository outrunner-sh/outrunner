"use client";

import { GitBranch, GitFork } from "lucide-react";
import { useCallback, useState } from "react";

import { ProjectEnvironmentPicker } from "@/components/import-setup-picker";
import { ProjectsSyncButton } from "@/components/projects-sync-button";
import { RepositorySelect } from "@/components/repository-select";
import { SessionComposer } from "@/components/session-composer";
import { Notice } from "@/components/ui/notice";
import { LocalBlocker, LocalRepositoryButton, SessionLocationMenu } from "@/components/session-location-picker";
import { useCreateSession } from "@/hooks/use-create-session";
import { type FirstSessionEnvironment, useFirstSessionEnvironment } from "@/hooks/use-first-session-environment";
import { useSessionLocation } from "@/hooks/use-session-location";
import { useOutrunnerModels } from "@/hooks/use-outrunner-models";
import { AGENT_IDS } from "@/lib/agents/registry";
import { accountsHere } from "@/lib/desktop/local-runtime";
import { effortOnPick, loadoutDefault } from "@/lib/runtime/model-loadout";
import {
  agentOf,
  CLAUDE_DEFAULT_MODEL,
  DEFAULT_EFFORT,
  defaultModel,
  type Effort,
  modelGroups,
  type SessionModel,
} from "@/lib/runtime/session-models";
import type { Project } from "@/lib/runtime/types";
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";
import { newSessionDetails } from "@/lib/session/new-session-target";

/** One item in the row beneath the wordmark: where, what, which branch, how. */
const CHIP = "inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground [&_svg]:size-3.5";
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
  projectsKnown = true,
  initialProjectId,
  openPicker = false,
  focusComposer = false,
}: {
  projects: Project[];
  /** False until the list arrives (a cold start): it is not yet "none". */
  projectsKnown?: boolean;
  /** Repo to preselect (the last-used project). Falls back to the first. */
  initialProjectId?: string;
  /** Opens the repository picker: as the form mounts, or as it turns true. */
  openPicker?: boolean;
  /** Focuses the composer: as the form mounts, or as it turns true. */
  focusComposer?: boolean;
}) {
  const { projects, projectId, selectProject, selected, isCreating, message, messageAction, create, createLocal } =
    useCreateSession(listed, initialProjectId);
  // The model the session starts on, picked in the composer as in a session;
  // none picked, what it starts on anyway: the user's Claude, on
  // CLAUDE_DEFAULT_MODEL, where it's connected; otherwise the menu's default.
  const menu = useOutrunnerModels();
  // The model picked in the composer, else the loadout's default: its agent
  // decides what this Mac needs for a local session (Claude Code, or Codex).
  const [picked, setPicked] = useState<SessionModel | null>(null);
  // The effort picked in the composer; undefined until one is, when the
  // loadout's for its default model shows, else DEFAULT_EFFORT.
  const [pickedEffort, setPickedEffort] = useState<Effort | null | undefined>(undefined);
  // Asked to open the picker, until it has been shut once: the cloud picker
  // can give way to the Mac's as this Mac's agent answers, and that one opens
  // in its place.
  const [pickAsked, setPickAsked] = useState(openPicker);
  const pickerClosed = useCallback(() => setPickAsked(false), []);
  // Asked again with the form already open (the URL catches up after a click
  // that reset it).
  const [openPickerSeen, setOpenPickerSeen] = useState(openPicker);
  if (openPicker !== openPickerSeen) {
    setOpenPickerSeen(openPicker);
    if (openPicker) setPickAsked(true);
  }
  // Each ask to focus the composer, the same way.
  const [focusAsks, setFocusAsks] = useState(focusComposer ? 1 : 0);
  const [focusComposerSeen, setFocusComposerSeen] = useState(focusComposer);
  if (focusComposer !== focusComposerSeen) {
    setFocusComposerSeen(focusComposer);
    if (focusComposer) setFocusAsks(focusAsks + 1);
  }
  const where = useSessionLocation(agentOf((picked ?? menu?.loadout.default)?.provider ?? "claude"));
  const local = where.location === "local";
  // A repository's first cloud session can bring its environment from this Mac.
  const environment = useFirstSessionEnvironment(selected, !local);
  // A send is under way: the environment is being kept, or the session made.
  // What it was sent with must not change under it.
  const busy = isCreating || environment.keeping;
  // No repositories only blocks the cloud; a local session needs none.
  const noRepositories = projectsKnown && !local && projects.length === 0;
  const details = newSessionDetails(
    local
      ? { kind: "local", folder: where.folder.state === "ok" ? where.folder.folder : null }
      : { kind: "cloud", project: selected },
  );

  // The user's own accounts a session here runs on (Settings → Providers):
  // their models are offered only where connected, and a way to connect the
  // rest instead.
  const accounts = menu
    ? accountsHere(menu.agents, local, where.runtime.state === "ready" ? where.runtime.status : null)
    : [];
  const groups = menu ? modelGroups(menu, accounts) : [];
  const connect = menu ? AGENT_IDS.filter((agent) => !accounts.includes(agent)) : [];
  // Without the user's Claude here (or on a Mac whose Claude Code isn't
  // logged in), a session starts on the menu's default: Outrunner's model, or
  // one on their key.
  const onDefault = !accounts.includes("claude") || (local && where.outrunnerModel);
  // The loadout's default (Settings → Default models) where the menu offers
  // it here; else what a session starts on without one: the menu's default,
  // or, where it starts on the user's Claude, Opus.
  const chosenDefault = menu ? (loadoutDefault(menu.loadout, groups) ?? null) : null;
  const startsOn = picked ?? chosenDefault ?? (menu ? (onDefault ? defaultModel(menu) : CLAUDE_DEFAULT_MODEL) : null);
  const startModel = picked ?? chosenDefault ?? undefined;
  // What the session is started at: none picked, the loadout's default goes
  // with its effort, and the user's Claude with DEFAULT_EFFORT (the server's
  // and createLocal's for it).
  const effort =
    pickedEffort !== undefined ? pickedEffort : chosenDefault ? effortOnPick(menu?.loadout, chosenDefault) : DEFAULT_EFFORT;

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
          <div className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[13px]">
            {LOCAL_SESSIONS && <SessionLocationMenu state={where} disabled={busy} className={CHIP_BUTTON} />}
            {local ? (
              <LocalRepositoryButton
                state={where}
                disabled={busy}
                className={CHIP_BUTTON}
                autoOpen={pickAsked}
                onClosed={pickerClosed}
              />
            ) : (
              <RepositorySelect
                projects={projects}
                selectedProjectId={projectId}
                onSelect={selectProject}
                disabled={busy}
                triggerClassName={CHIP_BUTTON}
                autoOpen={pickAsked}
                onClosed={pickerClosed}
              />
            )}
            {details.branch && (
              <span className={CHIP} title="The branch the session starts from">
                <GitBranch className="shrink-0" />
                <span className="truncate font-mono text-[13px]">{details.branch}</span>
              </span>
            )}
            {details.worktree && (
              <span className={CHIP} title={details.worktree.title}>
                <GitFork className="shrink-0" />
                {details.worktree.label}
              </span>
            )}
          </div>
        )}

        <LocalBlocker state={where} className="mt-4 text-center" />
        {!local && !noRepositories && <EnvironmentOffer environment={environment} disabled={busy} />}
      </div>

      <div className="shrink-0">
        {message && (
          // A failure with a fix to make first is a step, not an error. One
          // that points at what is in the way (a taken branch) still didn't start.
          <Notice
            className="mx-auto w-[calc(100%-32px)] max-w-[720px]"
            tone={messageAction?.kind === "step" ? "info" : "error"}
            title={messageAction?.kind === "step" ? "One step before this session starts" : "Couldn't start the session"}
            detail={message}
            actions={
              messageAction ? [{ label: messageAction.label, href: messageAction.href, primary: true }] : undefined
            }
          />
        )}
        <SessionComposer
          onSend={(text, attachmentIds) =>
            where.localFolder
              ? createLocal(
                  text,
                  where.localFolder,
                  onDefault,
                  startModel,
                  where.runtime.state === "ready" ? where.runtime.status : null,
                  effort,
                )
              : // Kept first, so the session's box starts with it; one that
                // fails keeps the prompt, and the session isn't started.
                environment.keep().then((kept) => kept && create(text, attachmentIds, startModel, effort))
          }
          model={startsOn?.id}
          modelChoice={
            groups.length > 0 || connect.length > 0
              ? {
                  groups,
                  connect,
                  effort,
                  onChange: (model, effort) => {
                    setPicked(model);
                    setPickedEffort(effort);
                  },
                  switching: false,
                  disabledReason: busy ? "Starting the session" : null,
                  preferredProvider: startsOn?.provider,
                  loadout: menu?.loadout,
                }
              : undefined
          }
          // Typing starts at once, the list still on its way included (a send
          // before it lands gives the prompt back).
          canSend={
            !isCreating &&
            (local
              ? where.localFolder !== null
              : (selected != null || !projectsKnown) && (!environment.secrets || environment.consent))
          }
          placeholder="What would you like to work on?"
          disabledPlaceholder={
            local && where.blocker
              ? where.blocker
              : !local && environment.secrets && !environment.consent
                ? "Agree to store the environment above to start…"
                : noRepositories
                ? "Sync a repository to start…"
                : "Pick a repository above to start…"
          }
          allowAttachments={!local}
          focusSignal={focusAsks}
        />
      </div>
    </div>
  );
}

/**
 * The repository's environment on this Mac, offered as its first cloud session
 * starts: what is picked is kept, encrypted, as the session is started, and
 * this and every later session of the project starts with it.
 */
function EnvironmentOffer({ environment: env, disabled }: { environment: FirstSessionEnvironment; disabled: boolean }) {
  if (!env.offer || !env.pick) return null;
  return (
    <section className="mt-8 w-full max-w-xl space-y-3 rounded-lg border border-border/60 p-4 text-left">
      <div>
        <h2 className="text-sm font-medium">Bring {env.offer.repo}&apos;s environment from this Mac</h2>
        <p className="text-muted-foreground text-xs">
          Pick what this project&apos;s cloud sessions start with. Kept encrypted, for this one and every one after.
        </p>
      </div>
      <div className="max-h-56 overflow-auto">
        <ProjectEnvironmentPicker project={env.offer} pick={env.pick} onChange={env.setPick} disabled={disabled} />
      </div>
      {env.secrets && (
        <label className="flex items-start gap-2 text-xs">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={env.consent}
            onChange={() => env.setConsent(!env.consent)}
            disabled={disabled}
          />
          <span>
            Store the variables and files I picked, encrypted, in Outrunner&apos;s cloud, and give them to this
            project&apos;s cloud sessions, where the agent can read them.
          </span>
        </label>
      )}
      {env.error && <p className="text-destructive text-xs">{env.error}</p>}
    </section>
  );
}
