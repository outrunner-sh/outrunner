"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Folder, FolderGit2 } from "lucide-react";

import { ChecklistRow, CommandSnippet, type RowState } from "@/components/onboarding/checklist-row";
import { ConnectClaudeRow } from "@/components/onboarding/connect-claude-row";
import { Button } from "@/components/ui/button";
import { claudeSetupText } from "@/lib/desktop/local-runtime";
import type { MacStatus, OnboardingEnv, OnboardingFolder } from "@/lib/onboarding/types";

type Login = { state: "idle" } | { state: "waiting" } | { state: "error"; message: string };

/**
 * Everything a session on this Mac needs, checked live: the tools, the user's
 * Claude connection, Claude Code's own login here (asked for only when it is
 * missing), and a folder to work in.
 */
export function MacSetup({
  env,
  folder,
  onFolder,
  onReady,
}: {
  env: OnboardingEnv;
  folder: OnboardingFolder | null;
  onFolder: (folder: OnboardingFolder) => void;
  onReady: (ready: boolean) => void;
}) {
  const [status, setStatus] = useState<MacStatus | null>(null);
  const [checking, setChecking] = useState(true);
  // Why the last check failed, so a broken bridge says so instead of spinning.
  const [checkError, setCheckError] = useState<string | null>(null);
  const [login, setLogin] = useState<Login>({ state: "idle" });
  // The user's Claude connection (the same one the cloud and Settings use);
  // null until checked.
  const [claude, setClaude] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    void env.claudeConnected().then((connected) => {
      if (live) setClaude(connected);
    });
    return () => {
      live = false;
    };
  }, [env]);

  // The first check runs on its own; `check` is for Check again and after a login.
  useEffect(() => {
    let live = true;
    env.checkMac().then(
      (found) => {
        if (!live) return;
        setStatus(found);
        setChecking(false);
      },
      (error: unknown) => {
        if (!live) return;
        setCheckError(error instanceof Error ? error.message : String(error));
        setChecking(false);
      },
    );
    return () => {
      live = false;
    };
  }, [env]);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await env.checkMac());
      setCheckError(null);
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }, [env]);

  // Checks again without the spinner: for following Claude Code's setup.
  const refresh = useCallback(async () => {
    try {
      setStatus(await env.checkMac());
    } catch {
      // The next look, or Check again, says what is wrong.
    }
  }, [env]);
  const setUpClaude = useCallback(async () => {
    await env.setUpClaudeCode().catch(() => {});
    await refresh();
  }, [env, refresh]);

  // No Claude Code here that a session can run: the app sets up its own as
  // soon as that shows, and the row follows it until it lands. A failure
  // waits for Try again.
  const setupNeeded = status !== null && !status.claude && status.setsUpClaude && status.claudeSetup === null;
  const settingUp = status?.claudeSetup?.state === "installing";
  useEffect(() => {
    if (!setupNeeded) return;
    let live = true;
    env
      .setUpClaudeCode()
      .catch(() => {})
      .then(() => env.checkMac())
      .then(
        (found) => {
          if (live) setStatus(found);
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [setupNeeded, env]);
  useEffect(() => {
    if (!settingUp) return;
    const timer = setTimeout(() => void refresh(), SETUP_CHECK_MS);
    return () => clearTimeout(timer);
  }, [settingUp, status, refresh]);

  const missing = status
    ? (
        [
          // A command the user can run, or null when the fix is updating the app.
          ["the Outrunner agent", status.agent, null],
          ["git", status.git, "xcode-select --install"],
          ["tmux", status.tmux, "brew install tmux"],
          ["Claude Code", status.claude, "npm install -g @anthropic-ai/claude-code"],
        ] as const
      ).filter(([, present]) => !present)
    : [];
  // What the user has to install: not a Claude Code the app sets up itself.
  const install = missing.filter(([name]) => !(name === "Claude Code" && status?.setsUpClaude));
  const toolsReady = status !== null && missing.length === 0;
  // Only a clear no asks for a login; an app that can't tell leaves it to the session.
  // Sessions here run the Mac's own Claude Code, so it must be logged in too.
  // Checked quietly: it only becomes a step when it isn't.
  const loggedIn = toolsReady && status.claudeLoggedIn !== false;
  // Where the server runs Outrunner's models, a Mac that isn't logged in runs
  // its sessions on those instead, so the login is offered, not required.
  const onOutrunnerModel = toolsReady && !loggedIn && env.outrunnerModels;
  // Sessions here run on Claude Code's own login on this Mac, so connecting
  // Claude (for cloud sessions) is only offered, never required.
  const [skippedClaude, setSkippedClaude] = useState(false);
  const ready =
    toolsReady && (claude === true || skippedClaude) && (loggedIn || onOutrunnerModel) && folder !== null;

  useEffect(() => onReady(ready), [ready, onReady]);

  // The login the row is waiting on; Cancel moves it on, so the cancelled
  // login's own failure doesn't show as an error.
  const attempt = useRef(0);
  const logIn = async () => {
    const mine = ++attempt.current;
    setLogin({ state: "waiting" });
    try {
      await env.logInToClaudeCode();
      if (attempt.current !== mine) return;
      setLogin({ state: "idle" });
      await check();
    } catch (error) {
      if (attempt.current !== mine) return;
      setLogin({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const toolsState: RowState =
    (checking && !status) || (install.length === 0 && settingUp)
      ? "working"
      : checkError
        ? "problem"
        : toolsReady
          ? "done"
          : "problem";
  const loginState: RowState =
    login.state === "waiting" ? "working" : onOutrunnerModel && login.state === "idle" ? "skipped" : "problem";

  return (
    <div className="border-border/60 bg-card/30 overflow-hidden rounded-xl border">
      <ChecklistRow
        state={toolsState}
        title="Tools on this Mac"
        detail={
          checkError && !checking
            ? checkError
            : !status
              ? "Checking for git, tmux and Claude Code…"
              : toolsReady
                ? "git, tmux and Claude Code are installed."
                : install.length > 0
                  ? `Install ${install.map(([name]) => name).join(", ")}, then check again.`
                  : claudeSetupText(status.claudeSetup)
        }
        action={
          status?.claudeSetup?.state === "failed" && install.length === 0 ? (
            <Button size="sm" variant="outline" onClick={() => void setUpClaude()}>
              Try again
            </Button>
          ) : (status && install.length > 0) || checkError ? (
            <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
              Check again
            </Button>
          ) : undefined
        }
      >
        {install.length > 0 && (
          <div className="space-y-2">
            {install.map(([name, , command]) =>
              command ? (
                <CommandSnippet key={name} command={command} />
              ) : (
                <p key={name} className="text-muted-foreground text-xs">
                  This copy of Outrunner is missing its agent. Download the app again.
                </p>
              ),
            )}
          </div>
        )}
      </ChecklistRow>

      <ConnectClaudeRow
        env={env}
        connected={claude}
        onConnected={() => setClaude(true)}
        todo="Only for cloud sessions, so you can skip this. Sessions on this Mac don't use it."
        skipped={
          skippedClaude
            ? "Skipped. It's only for cloud sessions: connect Claude anytime in Settings."
            : undefined
        }
        onSkip={() => setSkippedClaude(true)}
      />

      {toolsReady && !loggedIn && (
        <ChecklistRow
          state={loginState}
          title="Log in to Claude Code on this Mac"
          detail={
            login.state === "waiting"
              ? "Approve in your browser…"
              : login.state === "error"
                ? login.message
                : onOutrunnerModel
                  ? "Not logged in, so sessions on this Mac run on Outrunner's model. Log in to use your Claude subscription instead."
                  : "Sessions on this Mac run Claude Code here, and it isn't logged in."
          }
          action={
            login.state === "waiting" ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  attempt.current++;
                  env.cancelClaudeCodeLogin();
                  setLogin({ state: "idle" });
                }}
              >
                Cancel
              </Button>
            ) : (
              <Button size="sm" variant={onOutrunnerModel ? "outline" : "default"} onClick={() => void logIn()}>
                {login.state === "error" ? "Try again" : "Log in"}
              </Button>
            )
          }
        />
      )}

      <ChecklistRow
        state={folder ? "done" : "todo"}
        title="Choose a folder"
        detail={
          folder ? (
            <span className="flex items-center gap-1.5">
              {folder.git ? <FolderGit2 className="size-3.5" /> : <Folder className="size-3.5" />}
              <span className="text-foreground font-medium">{folder.name}</span>
              <span className="font-mono">
                {folder.git ? `· worktree off ${folder.branch ?? "HEAD"}` : "· edits in place"}
              </span>
            </span>
          ) : (
            "Any folder. A git repository gets its own worktree per session."
          )
        }
        action={
          <Button
            size="sm"
            variant={folder ? "ghost" : "outline"}
            onClick={async () => {
              const picked = await env.pickFolder();
              if (picked) onFolder(picked);
            }}
          >
            {folder ? "Change" : "Choose folder…"}
          </Button>
        }
      />
    </div>
  );
}

/** How often to look in on Claude Code being set up. */
const SETUP_CHECK_MS = 1500;
