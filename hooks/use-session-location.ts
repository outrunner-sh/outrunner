"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useClaudeLocalLogin, useLocalRuntime, type LocalRuntime } from "@/hooks/use-local-runtime";
import {
  checkLocalFolder,
  cloneLocalRepository,
  claudeSetupNeeded,
  claudeSetupText,
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
/** Told when the location is set from outside the form (the sidebar's tab),
 *  so a form already open follows it. */
const LOCATION_EVENT = "outrunner:session-location";

function savedLocation(): SessionLocation {
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
export function useSessionLocation() {
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
  const onOutrunnerModel =
    location === "local" && runtime.state === "ready" && runsOnOutrunnerModel(runtime.status, outrunnerModels);

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

  // The sidebar's tab moved: a form already open follows it.
  useEffect(() => {
    const follow = (event: Event) => {
      const next = (event as CustomEvent<SessionLocation>).detail;
      if (next === "cloud" || next === "local") setChosen(next);
    };
    window.addEventListener(LOCATION_EVENT, follow);
    return () => window.removeEventListener(LOCATION_EVENT, follow);
  }, []);

  const setLocation = useCallback((next: SessionLocation) => {
    setChosen(next);
    try {
      window.localStorage.setItem(LOCATION_KEY, next);
    } catch {
      // Blocked storage only costs remembering the choice.
    }
  }, []);

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

  const remembered = location === "local" ? rememberedFolder() : null;
  const folder: FolderChoice =
    found && (found.picked || found.path === remembered)
      ? found.choice
      : remembered
        ? { state: "checking" }
        : { state: "none" };
  const blocker = location === "local" ? localBlocker(runtime, folder, outrunnerModels) : null;

  return {
    location,
    setLocation,
    runtime,
    folder,
    chooseFolder,
    chooseRepository,
    /** Why a local session cannot start yet; null when it can (or for cloud). */
    blocker,
    /** The blocker is Claude Code needing a login, which the page can start. */
    needsClaudeLogin:
      location === "local" && runtime.state === "ready" && needsClaudeLogin(runtime.status) && !onOutrunnerModel,
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

/** Make new sessions start where the sidebar's tab is, Cloud or This Mac,
 *  a new-session form already open included. Its own choice still switches. */
export function startNewSessionsOn(location: SessionLocation): void {
  saveLocation(location);
  window.dispatchEvent(new CustomEvent(LOCATION_EVENT, { detail: location }));
}

function saveLocation(location: SessionLocation): void {
  try {
    window.localStorage.setItem(LOCATION_KEY, location);
  } catch {
    // Blocked storage: the new-session page opens on its defaults instead.
  }
}

function localBlocker(runtime: LocalRuntime, folder: FolderChoice, outrunnerModels: boolean): string | null {
  if (runtime.state === "error") return runtime.message;
  if (runtime.state !== "ready") return "Local sessions run in the Outrunner Mac app.";
  const install = toolsToInstall(runtime.status);
  if (install.length > 0) {
    const tmux = install.includes("tmux") ? " (brew install tmux)" : "";
    return `Install ${install.join(", ")}${tmux} to run sessions on this Mac.`;
  }
  if (!runtime.status.claude) return claudeSetupText(runtime.status.claudeSetup);
  if (needsClaudeLogin(runtime.status) && !runsOnOutrunnerModel(runtime.status, outrunnerModels)) {
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
