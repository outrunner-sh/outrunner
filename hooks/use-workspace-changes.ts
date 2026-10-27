"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Lru } from "@/lib/client/lru";
import { localAgentRequest, localTarget } from "@/lib/desktop/local-runtime";
import type { ChangedFile } from "@/lib/runtime/types";

/** Each session's changed files as last read, for the page: the panel shows
 *  them at once when the session opens again, and reads them fresh behind. */
const KEPT_CHANGES = new Lru<{ files: ChangedFile[]; message: string | null }>(20);

/** How often the change set is read again while the panel is mounted. */
const POLL_MS = 3500;
/** How long one read may take: one that hangs would hold every poll after it
 *  (they don't overlap), so the panel would stop following the session. */
const READ_TIMEOUT_MS = 15_000;

/** `signal`, also aborted after `ms`. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

/**
 * A session's changed files, kept live: the last read shown at once, loaded
 * fresh on mount, then polled while the caller stays mounted, with each file's
 * diff fetched lazily the first time it is expanded and cached. Shared by the Environment panel's Changes row (the
 * totals) and the file list behind it.
 */
export function useWorkspaceChanges({
  workspaceId,
  local = false,
  active,
}: {
  workspaceId: string;
  /** A local session: the agent on this Mac serves the change set, through the
   *  Outrunner app, since the server cannot reach the worktree. */
  local?: boolean;
  /** Only a ready workspace has a worktree to read. */
  active: boolean;
}) {
  const keptKey = `${local ? "local" : "cloud"}:${workspaceId}`;
  const [kept] = useState(() => KEPT_CHANGES.get(keptKey));
  const [files, setFiles] = useState<ChangedFile[] | null>(kept?.files ?? null);
  const [message, setMessage] = useState<string | null>(kept?.message ?? null);
  useEffect(() => {
    if (files !== null) KEPT_CHANGES.set(keptKey, { files, message });
  }, [keptKey, files, message]);
  // Maps (not plain objects) so a file named "toString"/"constructor" can't
  // collide with Object.prototype. Errors are tracked separately from successful
  // diffs so a transient failure isn't cached as a diff and re-expanding retries.
  const [diffs, setDiffs] = useState<Map<string, string>>(new Map());
  const [diffErrors, setDiffErrors] = useState<Map<string, string>>(new Map());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

  // Latest values for the poll to read without stale closures.
  const filesRef = useRef<ChangedFile[] | null>(null);
  const openRef = useRef<Set<string>>(openPaths);
  // Bumped whenever the changed set is reloaded; an in-flight diff load whose
  // generation no longer matches is discarded instead of caching a stale diff.
  const loadGen = useRef(0);
  // Serializes the changed-file requests (initial load + polls) so a slow
  // response can't overwrite a newer one, and only one runs at a time.
  const inFlight = useRef(false);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);
  useEffect(() => {
    openRef.current = openPaths;
  }, [openPaths]);

  // The same two reads, from the server or (local) the app; both answer in the
  // shapes /api/workspaces/[id]/changes uses.
  const readLocal = useCallback(
    async (query: string): Promise<{ ok: boolean; result: Record<string, unknown> }> => {
      if (!local) throw new Error("not a local workspace");
      try {
        const result = await localAgentRequest<Record<string, unknown>>(
          localTarget(workspaceId),
          "GET",
          `/workspaces/${workspaceId}/changes${query}`,
        );
        return { ok: true, result };
      } catch (error) {
        return { ok: false, result: { error: error instanceof Error ? error.message : String(error) } };
      }
    },
    [workspaceId, local],
  );

  const fetchChanges = useCallback(
    async (signal?: AbortSignal): Promise<{ files: ChangedFile[] } | { error: string }> => {
      if (local) {
        const { ok, result } = await readLocal("");
        const files = result.files as ChangedFile[] | undefined;
        if (!ok || !files) return { error: (result.error as string) ?? "Could not load changes." };
        return { files };
      }
      const read = withTimeout(signal, READ_TIMEOUT_MS);
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/changes`, { signal: read.signal });
        const result = (await response.json().catch(() => ({}))) as {
          files?: ChangedFile[];
          error?: string;
        };
        if (!response.ok || !result.files) return { error: result.error ?? "Could not load changes." };
        return { files: result.files };
      } finally {
        read.done();
      }
    },
    [workspaceId, local, readLocal],
  );

  const loadDiff = useCallback(
    async (path: string) => {
      const gen = loadGen.current;
      setLoadingPaths((s) => new Set(s).add(path));
      try {
        const query = `?path=${encodeURIComponent(path)}`;
        const { ok, result } = local
          ? ((await readLocal(query)) as { ok: boolean; result: { diff?: string; error?: string } })
          : await fetch(`/api/workspaces/${workspaceId}/changes${query}`).then(async (response) => ({
              ok: response.ok,
              result: (await response.json().catch(() => ({}))) as { diff?: string; error?: string },
            }));
        if (loadGen.current !== gen) return; // superseded by a reload — discard
        if (ok && typeof result.diff === "string") {
          const diff = result.diff;
          setDiffs((d) => new Map(d).set(path, diff));
          setDiffErrors((e) => {
            if (!e.has(path)) return e;
            const n = new Map(e);
            n.delete(path);
            return n;
          });
        } else {
          setDiffErrors((e) => new Map(e).set(path, result.error ?? "Could not load this diff."));
        }
      } catch {
        if (loadGen.current === gen) {
          setDiffErrors((e) => new Map(e).set(path, "Could not reach Outrunner. Please try again."));
        }
      } finally {
        setLoadingPaths((s) => {
          const n = new Set(s);
          n.delete(path);
          return n;
        });
      }
    },
    [workspaceId, local, readLocal],
  );

  const applyResult = useCallback(
    (result: { files: ChangedFile[] } | { error: string }) => {
      if ("error" in result) {
        setMessage(result.error);
        setFiles([]);
        setOpenPaths(new Set());
        return;
      }
      setMessage(null);
      setFiles(result.files);
      // Collapsed by default — just the file list; the diff loads when a file is
      // expanded. Bump the generation so any in-flight load is discarded.
      loadGen.current += 1;
      setOpenPaths(new Set());
      setDiffs(new Map());
      setDiffErrors(new Map());
    },
    [],
  );

  // Auto-load on mount. The first statement awaits, so no state is set
  // synchronously inside the effect body.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void (async () => {
      inFlight.current = true;
      try {
        const result = await fetchChanges(controller.signal);
        if (!controller.signal.aborted) applyResult(result);
      } catch {
        if (!controller.signal.aborted) {
          setMessage("Could not reach Outrunner. Please try again.");
          setFiles([]);
        }
      } finally {
        inFlight.current = false;
      }
    })();
    return () => {
      controller.abort();
      inFlight.current = false;
    };
  }, [active, fetchChanges, applyResult]);

  // Live refresh: poll the changed-file set while the panel is open so edits
  // appear without a manual refresh. Preserves the user's expand/collapse choices
  // and only reloads a diff for an expanded file whose +/- counts changed.
  const poll = useCallback(async () => {
    if (inFlight.current) return; // don't overlap the initial load or another poll
    inFlight.current = true;
    try {
      const result = await fetchChanges();
      if ("error" in result) return; // ignore a transient poll error; next tick retries
      const prevSig = new Map(
        (filesRef.current ?? []).map((f) => [f.path, `${f.additions}:${f.deletions}`]),
      );
      const present = new Set(result.files.map((f) => f.path));
      setMessage(null); // a successful poll clears any stale error banner
      setFiles(result.files);
      setOpenPaths((o) => new Set([...o].filter((p) => present.has(p))));
      for (const f of result.files) {
        if (!openRef.current.has(f.path)) continue;
        if (prevSig.get(f.path) !== `${f.additions}:${f.deletions}`) void loadDiff(f.path);
      }
    } catch {
      // Transient network failure — ignore; the next tick retries.
    } finally {
      inFlight.current = false;
    }
  }, [fetchChanges, loadDiff]);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [active, poll]);

  const toggle = (path: string) => {
    // Decided here, not in the updater: React may run an updater twice, and
    // the fetch below must happen once.
    const opening = !openPaths.has(path);
    setOpenPaths((s) => {
      const n = new Set(s);
      if (opening) n.add(path);
      else n.delete(path);
      return n;
    });
    // Fetch on first expand, and retry after an error (errors aren't cached
    // as diffs, so `diffs.has` stays false until a load succeeds).
    if (opening && !diffs.has(path) && !loadingPaths.has(path)) void loadDiff(path);
  };

  return { files, message, diffs, diffErrors, loadingPaths, openPaths, toggle };
}

export type WorkspaceChangesState = ReturnType<typeof useWorkspaceChanges>;
