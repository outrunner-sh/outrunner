"use client";

import { useCallback, useEffect, useState } from "react";

import type { LocalCreate } from "@/hooks/use-create-session";
import { useLocalRuntime, type LocalRuntime } from "@/hooks/use-local-runtime";
import {
  checkLocalRepo,
  pickLocalRepo,
  rememberedRepo,
  rememberRepo,
} from "@/lib/desktop/local-runtime";
import type { Project } from "@/lib/runtime/types";

export type SessionLocation = "cloud" | "local";

/** The clone a local session would branch from, for the selected project. */
export type LocalClone =
  | { state: "none" }
  | { state: "checking" }
  | { state: "ok"; path: string }
  | { state: "mismatch"; path: string; remotes: string[] }
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
 * Where a new session runs — a cloud box or this Mac — and, for this Mac, the
 * user's clone of the selected project. Owns the choice, the remembered clone
 * (re-checked whenever the project changes, since it may have moved), and the
 * one reason, if any, a local session cannot start yet.
 */
export function useSessionLocation(project: Project | undefined) {
  const runtime = useLocalRuntime();
  // The last choice sticks. It only takes effect where local is possible, so
  // the server render and the first client render agree (both say cloud).
  const [chosen, setChosen] = useState<SessionLocation>(savedLocation);
  // The latest answer about a clone: one the user just picked, or the result of
  // re-checking the remembered one.
  const [found, setFound] = useState<{
    projectId: string;
    path: string;
    picked: boolean;
    clone: LocalClone;
  } | null>(null);

  const location: SessionLocation = runtime.state === "ready" ? chosen : "cloud";

  const setLocation = useCallback((next: SessionLocation) => {
    setChosen(next);
    try {
      window.localStorage.setItem(LOCATION_KEY, next);
    } catch {
      // Blocked storage only costs remembering the choice.
    }
  }, []);

  // Re-check the remembered clone for the selected project: it may have moved.
  useEffect(() => {
    if (location !== "local" || !project) return;
    const path = rememberedRepo(project.id);
    if (!path) return;
    let cancelled = false;
    checkLocalRepo(path, project.fullName)
      .then((repo) => {
        if (cancelled) return;
        setFound({
          projectId: project.id,
          path,
          picked: false,
          clone: repo.matches
            ? { state: "ok", path: repo.path }
            : { state: "mismatch", path: repo.path, remotes: repo.remotes },
        });
      })
      .catch(() => {
        if (cancelled) return;
        // Moved or deleted: forget it and ask again.
        rememberRepo(project.id, null);
        setFound({ projectId: project.id, path, picked: false, clone: { state: "none" } });
      });
    return () => {
      cancelled = true;
    };
  }, [location, project]);

  const chooseClone = useCallback(async () => {
    if (!project) return;
    try {
      const repo = await pickLocalRepo(project.fullName);
      if (!repo) return; // cancelled
      if (repo.matches) rememberRepo(project.id, repo.path);
      setFound({
        projectId: project.id,
        path: repo.path,
        picked: true,
        clone: repo.matches
          ? { state: "ok", path: repo.path }
          : { state: "mismatch", path: repo.path, remotes: repo.remotes },
      });
    } catch (error) {
      setFound({
        projectId: project.id,
        path: "",
        picked: true,
        clone: { state: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }, [project]);

  const remembered = project && location === "local" ? rememberedRepo(project.id) : null;
  const current: LocalClone =
    found && project && found.projectId === project.id && (found.picked || found.path === remembered)
      ? found.clone
      : remembered
        ? { state: "checking" }
        : { state: "none" };
  const blocker = location === "local" ? localBlocker(runtime, current, project) : null;

  return {
    location,
    setLocation,
    runtime,
    clone: current,
    chooseClone,
    /** Why a local session cannot start yet; null when it can (or for cloud). */
    blocker,
    /** What `create` needs for a session on this Mac; null for cloud, or while blocked. */
    localCreate:
      location === "local" && !blocker && runtime.state === "ready" && current.state === "ok"
        ? ({ deviceId: runtime.status.deviceId, repoPath: current.path } satisfies LocalCreate)
        : null,
  };
}

export type SessionLocationState = ReturnType<typeof useSessionLocation>;

function localBlocker(runtime: LocalRuntime, clone: LocalClone, project: Project | undefined): string | null {
  if (runtime.state === "error") return runtime.message;
  if (runtime.state !== "ready") return "Local sessions run in the Outrunner Mac app.";
  if (runtime.missing.length > 0) {
    const tmux = runtime.missing.includes("tmux") ? " (brew install tmux)" : "";
    return `Install ${runtime.missing.join(", ")}${tmux} to run sessions on this Mac.`;
  }
  switch (clone.state) {
    case "none":
      return `Choose your clone of ${project?.fullName ?? "this repository"}.`;
    case "checking":
      return "Checking your clone…";
    case "mismatch":
      return clone.remotes.length > 0
        ? `That folder is a clone of ${clone.remotes.join(", ")}, not ${project?.fullName}.`
        : `That folder has no remote pointing at ${project?.fullName}.`;
    case "error":
      return clone.message;
    case "ok":
      return null;
  }
}
