"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useClaudeLocalLogin, useLocalRuntime, type LocalRuntime } from "@/hooks/use-local-runtime";
import {
  checkLocalFolder,
  claudeSetupNeeded,
  claudeSetupText,
  needsClaudeLogin,
  pickLocalFolder,
  rememberedFolder,
  rememberFolder,
  setUpClaudeCode,
  toolsToInstall,
  type LocalFolder,
} from "@/lib/desktop/local-runtime";

export type SessionLocation = "cloud" | "local";

/** The folder a local session would work in. */
export type FolderChoice =
  | { state: "none" }
  | { state: "checking" }
  | { state: "ok"; folder: LocalFolder }
  | { state: "error"; message: string };

const LOCATION_KEY = "outrunner:session-location";

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

  const location: SessionLocation = runtime.state === "ready" ? chosen : "cloud";

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

  const remembered = location === "local" ? rememberedFolder() : null;
  const folder: FolderChoice =
    found && (found.picked || found.path === remembered)
      ? found.choice
      : remembered
        ? { state: "checking" }
        : { state: "none" };
  const blocker = location === "local" ? localBlocker(runtime, folder) : null;

  return {
    location,
    setLocation,
    runtime,
    folder,
    chooseFolder,
    /** Why a local session cannot start yet; null when it can (or for cloud). */
    blocker,
    /** The blocker is Claude Code needing a login, which the page can start. */
    needsClaudeLogin: location === "local" && runtime.state === "ready" && needsClaudeLogin(runtime.status),
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

function localBlocker(runtime: LocalRuntime, folder: FolderChoice): string | null {
  if (runtime.state === "error") return runtime.message;
  if (runtime.state !== "ready") return "Local sessions run in the Outrunner Mac app.";
  const install = toolsToInstall(runtime.status);
  if (install.length > 0) {
    const tmux = install.includes("tmux") ? " (brew install tmux)" : "";
    return `Install ${install.join(", ")}${tmux} to run sessions on this Mac.`;
  }
  if (!runtime.status.claude) return claudeSetupText(runtime.status.claudeSetup);
  if (needsClaudeLogin(runtime.status)) return "Log in to Claude Code to run sessions on this Mac.";
  switch (folder.state) {
    case "none":
      return "Choose a folder to work in.";
    case "checking":
      return "Checking the folder…";
    case "error":
      return folder.message;
    case "ok":
      return null;
  }
}
