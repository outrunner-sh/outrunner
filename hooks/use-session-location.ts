"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useClaudeLocalLogin, useLocalRuntime, type LocalRuntime } from "@/hooks/use-local-runtime";
import type { AgentId, AuthMethodId } from "@/lib/agents/registry";
import {
  checkLocalFolder,
  cloneLocalRepository,
  claudeSetupNeeded,
  claudeSetupText,
  initGitRepository,
  needsClaudeLogin,
  outrunnerModelsAvailable,
  pickLocalFolder,
  rememberedFolder,
  rememberFolder,
  runsOnOutrunnerModel,
  setUpClaudeCode,
  toolsToInstall,
  type LocalFolder,
} from "@/lib/desktop/local-runtime";
import type { AgentAuthChoices } from "@/lib/db/credentials";
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";

export type SessionLocation = "cloud" | "local";

/** The folder a local session would work in. */
export type FolderChoice =
  | { state: "none" }
  | { state: "checking" }
  /** A repository picked from GitHub, being cloned (or its clone updated). */
  | { state: "cloning"; repo: string }
  | { state: "ok"; folder: LocalFolder }
  | { state: "error"; message: string };

const LOCATION_KEY = "outrunner:session-location";

/** Where the last session ran, which the next starts as. */
export function savedLocation(): SessionLocation {
  try {
    return window.localStorage.getItem(LOCATION_KEY) === "local" ? "local" : "cloud";
  } catch {
    return "cloud";
  }
}

/**
 * Where a new session runs — a cloud box on a GitHub repository, or this Mac on
 * any folder — and, for this Mac, which folder. Owns the choice, the folder the
 * last local session used (re-checked, since it may have moved), and the one
 * reason, if any, a local session cannot start yet.
 */
export function useSessionLocation(agent: AgentId = "claude") {
  const { runtime, recheck } = useLocalRuntime();
  const claudeLogin = useClaudeLocalLogin(recheck);
  // The last choice sticks. It only takes effect where local is possible, so
  // the server render and the first client render agree (both say cloud).
  const [chosen, setChosen] = useState<SessionLocation>(savedLocation);
  // The latest answer about a folder: one just picked, or the remembered one
  // re-checked.
  const [found, setFound] = useState<{ path: string; picked: boolean; choice: FolderChoice } | null>(
    null,
  );

  // Always the cloud while new local sessions are off, whatever was chosen
  // before (lib/session/local-sessions.ts).
  const location: SessionLocation = LOCAL_SESSIONS && runtime.state === "ready" ? chosen : "cloud";

  // Whether this server runs Outrunner's models: then a Mac whose Claude Code
  // isn't logged in runs its sessions on those instead of being blocked.
  const [outrunnerModels, setOutrunnerModels] = useState(false);
  useEffect(() => {
    let live = true;
    void outrunnerModelsAvailable().then((available) => {
      if (live) setOutrunnerModels(available);
    });
    return () => {
      live = false;
    };
  }, []);
  // How Claude Code signs in (Settings → Providers): this Mac's own Claude
  // login matters only when that is the pick, or nothing is picked yet. A
  // subscription or an API key is handed to the session instead.
  const [claudePick, setClaudePick] = useState<AuthMethodId | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/settings/agents")
      .then((res) => (res.ok ? (res.json() as Promise<{ choices?: AgentAuthChoices }>) : null))
      .then((data) => {
        if (live) setClaudePick(data?.choices?.claude ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const onMacLogin = claudePick === null || claudePick === "local";

  const onOutrunnerModel =
    onMacLogin &&
    location === "local" &&
    runtime.state === "ready" &&
    runsOnOutrunnerModel(runtime.status, outrunnerModels);

  // Choosing This Mac on a Mac with no Claude Code a session can run (none,
  // a broken one, one too old) sets up the app's own; nothing to install. A
  // failure waits for Try again.
  const setupNeeded = location === "local" && runtime.state === "ready" && claudeSetupNeeded(runtime.status);
  const setUpClaude = useCallback(async () => {
    await setUpClaudeCode().catch(() => {});
    await recheck();
  }, [recheck]);
  useEffect(() => {
    if (setupNeeded) void setUpClaude();
  }, [setupNeeded, setUpClaude]);

  const setLocation = useCallback((next: SessionLocation) => {
    setChosen(next);
    try {
      window.localStorage.setItem(LOCATION_KEY, next);
    } catch {
      // Blocked storage only costs remembering the choice.
    }
  }, []);

  // Making the chosen folder a git repository (makeGitRepository, below); a
  // new folder chosen clears what it said about the last one.
  const [gitInit, setGitInit] = useState<{ state: "idle" | "running" } | { state: "error"; message: string }>({
    state: "idle",
  });

  // Stops the re-check below. A folder picked while it runs wins, so the stale
  // answer must not overwrite the pick, nor its failure wipe the new path.
  const stopCheck = useRef(() => {});

  // Re-check the remembered folder each time local is chosen: it may have moved
  // or been removed since, even if it was picked earlier.
  useEffect(() => {
    if (location !== "local") return;
    let cancelled = false;
    stopCheck.current = () => {
      cancelled = true;
    };
    const path = rememberedFolder();
    if (path) {
      checkLocalFolder(path)
        .then((folder) => {
          if (!cancelled) setFound({ path, picked: false, choice: { state: "ok", folder } });
        })
        .catch(() => {
          if (cancelled) return;
          rememberFolder(null); // gone: ask again
          setFound({ path, picked: false, choice: { state: "none" } });
        });
    }
    return () => {
      cancelled = true;
      // Leaving local drops the answer, so coming back shows the folder as
      // being checked rather than an earlier pick that may be stale.
      setFound(null);
    };
  }, [location]);

  const chooseFolder = useCallback(async () => {
    setGitInit({ state: "idle" });
    try {
      const folder = await pickLocalFolder();
      if (!folder) return; // cancelled
      stopCheck.current();
      rememberFolder(folder.path);
      setFound({ path: folder.path, picked: true, choice: { state: "ok", folder } });
    } catch (error) {
      stopCheck.current();
      setFound({
        path: "",
        picked: true,
        choice: { state: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }, []);

  // A repository picked from GitHub: its clone in ~/outrunner/repos is the
  // folder, made (or brought up to date) now.
  const chooseRepository = useCallback(async (fullName: string) => {
    setGitInit({ state: "idle" });
    stopCheck.current();
    setFound({ path: "", picked: true, choice: { state: "cloning", repo: fullName } });
    try {
      const folder = await cloneLocalRepository(fullName);
      rememberFolder(folder.path);
      setFound({ path: folder.path, picked: true, choice: { state: "ok", folder } });
    } catch (error) {
      setFound({
        path: "",
        picked: true,
        choice: { state: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }, []);

  // The chosen folder isn't a git repository: make it one, so its sessions
  // get worktrees. A failure keeps the folder chosen and says why.
  const makeGitRepository = useCallback(async (path: string) => {
    setGitInit({ state: "running" });
    try {
      const folder = await initGitRepository(path);
      stopCheck.current();
      rememberFolder(folder.path);
      setFound({ path: folder.path, picked: true, choice: { state: "ok", folder } });
      setGitInit({ state: "idle" });
    } catch (error) {
      setGitInit({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const remembered = location === "local" ? rememberedFolder() : null;
  const folder: FolderChoice =
    found && (found.picked || found.path === remembered)
      ? found.choice
      : remembered
        ? { state: "checking" }
        : { state: "none" };
  const blocker =
    location !== "local"
      ? null
      : gitInit.state === "running"
        ? // A session started now would work in the folder as it is, not in a
          // worktree of the repository it is about to become.
          "Making the folder a git repository…"
        : localBlocker(runtime, folder, outrunnerModels, agent, onMacLogin);

  return {
    location,
    setLocation,
    runtime,
    folder,
    chooseFolder,
    chooseRepository,
    /** Make the chosen folder a git repository (it isn't one yet). */
    makeGitRepository,
    gitInit,
    /** Why a local session cannot start yet; null when it can (or for cloud). */
    blocker,
    /** The blocker is Claude Code needing a login, which the page can start. */
    needsClaudeLogin:
      agent === "claude" &&
      onMacLogin &&
      location === "local" &&
      runtime.state === "ready" &&
      needsClaudeLogin(runtime.status) &&
      !onOutrunnerModel,
    /** Claude Code isn't logged in here, so a new session runs on Outrunner's
     *  model; logging in (which the page can start) switches back to Claude. */
    outrunnerModel: onOutrunnerModel,
    claudeLogin,
    /** Setting up the app's own Claude Code failed; `retry` starts it again. */
    claudeSetup: {
      failed:
        location === "local" && runtime.state === "ready" && runtime.status.claudeSetup?.state === "failed",
      retry: setUpClaude,
    },
    /** The folder a local session would use; null for cloud, or while blocked. */
    localFolder: location === "local" && !blocker && folder.state === "ok" ? folder.folder : null,
  };
}

export type SessionLocationState = ReturnType<typeof useSessionLocation>;

/** Make the next new session start on this Mac, in `folder` — what a folder's
 *  "+" in the sidebar does before opening the new-session page. */
export function startNextSessionIn(folder: string): void {
  rememberFolder(folder);
  saveLocation("local");
}

/** Make the next new session start in the cloud — what a repository's "+" does,
 *  so a form last used for this Mac does not ignore the repository chosen. */
export function startNextSessionInCloud(): void {
  saveLocation("cloud");
}

function saveLocation(location: SessionLocation): void {
  try {
    window.localStorage.setItem(LOCATION_KEY, location);
  } catch {
    // Blocked storage: the new-session page opens on its defaults instead.
  }
}

/** Why a local session can't start yet. Claude Code's install and login
 *  matter only for a session that runs it, and its login only when it signs
 *  in with this Mac's own (`onMacLogin`): Codex's are checked as a Codex
 *  session is made (lib/desktop/local-agent-auth.ts), by how it signs in. */
export function localBlocker(
  runtime: LocalRuntime,
  folder: FolderChoice,
  outrunnerModels: boolean,
  agent: AgentId,
  onMacLogin = true,
): string | null {
  if (runtime.state === "error") return runtime.message;
  if (runtime.state !== "ready") return "Local sessions run in the Outrunner Mac app.";
  const install = toolsToInstall(runtime.status).filter((tool) => agent === "claude" || tool !== "Claude Code");
  if (install.length > 0) {
    const tmux = install.includes("tmux") ? " (brew install tmux)" : "";
    return `Install ${install.join(", ")}${tmux} to run sessions on this Mac.`;
  }
  if (agent === "claude" && !runtime.status.claude) return claudeSetupText(runtime.status.claudeSetup);
  if (
    agent === "claude" &&
    onMacLogin &&
    needsClaudeLogin(runtime.status) &&
    !runsOnOutrunnerModel(runtime.status, outrunnerModels)
  ) {
    return "Log in to Claude Code to run sessions on this Mac.";
  }
  switch (folder.state) {
    case "none":
      return "Choose a repository or a folder to work in.";
    case "checking":
      return "Checking the folder…";
    case "cloning":
      return `Cloning ${folder.repo} into ~/outrunner/repos…`;
    case "error":
      return folder.message;
    case "ok":
      return null;
  }
}
