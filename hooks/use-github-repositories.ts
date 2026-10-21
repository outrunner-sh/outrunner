"use client";

import { useCallback, useRef, useState } from "react";

import type { RepositoryAccess } from "@/lib/github/access";
import type { RepositoryListing } from "@/lib/github/listing";
import type { Project } from "@/lib/runtime/types";

/** What `/api/github/repositories` answers. */
export type RepositoryList = {
  repositories: RepositoryListing[];
  /** github_repo_ids already connected as projects. */
  connected: number[];
  /** False when GitHub may have more than the list holds. */
  complete: boolean;
  /** Why repositories may be missing: invitations, organizations. */
  access: RepositoryAccess | null;
};

/**
 * The user's GitHub repositories, for a picker to browse and connect: read
 * when first asked for (`load`), again on Refresh (`load(true)`, which asks
 * GitHub anew rather than reusing a listing from the last few seconds), and
 * `connect` turns one into a project — by id from the list, or by the
 * `owner/name` of a pasted URL — returning that project.
 */
export function useGitHubRepositories() {
  const [list, setList] = useState<RepositoryList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A load already running: another asks for the same one rather than racing
  // it (Refresh mid-load would otherwise land whichever answer came last).
  const running = useRef<Promise<void> | null>(null);

  const load = useCallback(
    (force = false): Promise<void> => {
      if (running.current) return running.current;
      if (list && !force) return Promise.resolve();
      setLoading(true);
      setError(null);
      const run = (async () => {
        try {
          const res = await fetch(force ? "/api/github/repositories?fresh=1" : "/api/github/repositories");
          const data = (await res.json().catch(() => ({}))) as Partial<RepositoryList> & { error?: string };
          if (!res.ok) throw new Error(data.error ?? "Could not load repositories.");
          setList({
            repositories: data.repositories ?? [],
            connected: data.connected ?? [],
            complete: data.complete ?? true,
            access: data.access ?? null,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not load repositories.");
        } finally {
          setLoading(false);
          running.current = null;
        }
      })();
      running.current = run;
      return run;
    },
    [list],
  );

  const connect = useCallback(async (ref: number | string): Promise<Project> => {
    const res = await fetch("/api/projects/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(typeof ref === "number" ? { repoIds: [ref] } : { fullNames: [ref] }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      projects?: Project[];
      repoIds?: number[];
      error?: string;
    };
    if (!res.ok) throw new Error(data.error ?? "Could not connect that repository.");
    const id = data.repoIds?.[0];
    const project = data.projects?.find((p) => p.githubRepoId === id);
    if (!project) throw new Error("Connected, but the project did not come back. Refresh and try again.");
    // It is connected now: show it so without reloading the list.
    setList((current) =>
      current && !current.connected.includes(project.githubRepoId)
        ? { ...current, connected: [...current.connected, project.githubRepoId] }
        : current,
    );
    return project;
  }, []);

  return { list, loading, error, setError, load, connect };
}

export type GitHubRepositories = ReturnType<typeof useGitHubRepositories>;
