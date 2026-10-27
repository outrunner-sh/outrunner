"use client";

import { useCallback, useEffect, useState } from "react";

import { localAgentRequest, localTarget } from "@/lib/desktop/local-runtime";
import type { FileContent, WorktreeFiles } from "@/lib/runtime/types";

/** The Files panel's reads, from the server or (local) the app; both answer
 *  in the shapes /api/workspaces/[id]/files uses. */
export async function readWorkspaceFiles<T>(workspaceId: string, local: boolean, query: string): Promise<T> {
  if (local) {
    return localAgentRequest<T>(localTarget(workspaceId), "GET", `/workspaces/${workspaceId}/files${query}`);
  }
  const response = await fetch(`/api/workspaces/${workspaceId}/files${query}`);
  const result = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Could not read this session's files.");
  return result;
}

/** One file's text, for the Files panel's code view. */
export function readWorkspaceFile(workspaceId: string, local: boolean, path: string): Promise<FileContent> {
  return readWorkspaceFiles<FileContent>(workspaceId, local, `?path=${encodeURIComponent(path)}`);
}

/**
 * A session's files for the Files panel, and where the user is in them: the
 * folders opened, the search, the file being read. Held by the Environment
 * panel so stepping back to its rows and in again keeps the place. The list
 * loads once the panel first shows it, and again whenever `version` moves
 * (the change set's paths, so a file the agent adds appears) or on reload.
 */
export function useWorkspaceFiles({
  workspaceId,
  local = false,
  active,
  version,
}: {
  workspaceId: string;
  local?: boolean;
  /** Only once shown, on a ready workspace. */
  active: boolean;
  version: string;
}) {
  const [list, setList] = useState<WorktreeFiles | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await readWorkspaceFiles<WorktreeFiles>(workspaceId, local, "");
        if (cancelled) return;
        setList(result);
        setMessage(null);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not read this session's files.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, local, active, version, reloads]);

  const toggleDir = useCallback((dir: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  return {
    list,
    message,
    expanded,
    toggleDir,
    query,
    setQuery,
    openPath,
    setOpenPath,
    reload: () => setReloads((n) => n + 1),
  };
}

export type WorkspaceFilesState = ReturnType<typeof useWorkspaceFiles>;
