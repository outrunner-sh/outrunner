"use client";

import {
  ArrowLeft,
  ChevronRight,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Spinner } from "@/components/ui/loaders";
import { SkeletonRows, SkeletonSwap } from "@/components/ui/skeleton-swap";
import { readWorkspaceFile, type WorkspaceFilesState } from "@/hooks/use-workspace-files";
import { buildFileTree, codeLanguage, type FileTreeDir, searchFiles } from "@/lib/session/file-tree";
import type { FileContent } from "@/lib/runtime/types";
import { cn } from "@/lib/utils";

/** How many matches a search lists. */
const MAX_MATCHES = 200;
/** Past this many characters, a file is shown plain: highlighting it would
 *  stall the page. */
const MAX_HIGHLIGHT_CHARS = 150_000;

/**
 * The session's files, browsed in the Environment panel rather than in an
 * editor of their own: a tree of the worktree (or, while searching, the paths
 * that match), and a file's code in place of it once one is picked. Opened
 * from the panel's Files row, or the header's code button; `onBack` returns
 * to the rows. Files the session has changed carry a dot, as do the folders
 * that hold them.
 */
export function WorkspaceFiles({
  state,
  workspaceId,
  local,
  active,
  changed,
  onBack,
  backRef,
}: {
  state: WorkspaceFilesState;
  workspaceId: string;
  local: boolean;
  active: boolean;
  /** The changed paths, each with a key that moves when its change does, so
   *  an open file reads again as the agent edits it. */
  changed: Map<string, string>;
  onBack: () => void;
  backRef?: React.Ref<HTMLButtonElement>;
}) {
  const { list, message, expanded, toggleDir, query, setQuery, openPath, setOpenPath, reload } = state;
  const tree = useMemo(() => buildFileTree(list?.files ?? []), [list]);
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of changed.keys()) {
      for (let i = path.indexOf("/"); i !== -1; i = path.indexOf("/", i + 1)) dirs.add(path.slice(0, i));
    }
    return dirs;
  }, [changed]);
  const matches = useMemo(
    () => (query.trim() ? searchFiles(list?.files ?? [], query, MAX_MATCHES) : null),
    [list, query],
  );

  // Closing a file puts the focus back on its row (or, gone from view, the
  // back arrow), so the keyboard is never left on nothing.
  const root = useRef<HTMLDivElement>(null);
  const closed = useRef<string | null>(null);
  useEffect(() => {
    if (openPath !== null || closed.current === null) return;
    const rows = root.current?.querySelectorAll<HTMLButtonElement>("button[data-path]") ?? [];
    const row = [...rows].find((button) => button.dataset.path === closed.current);
    (row ?? root.current?.querySelector("button"))?.focus();
    closed.current = null;
  }, [openPath]);

  if (openPath !== null) {
    return (
      <FileView
        key={openPath}
        workspaceId={workspaceId}
        local={local}
        path={openPath}
        version={changed.get(openPath) ?? ""}
        onBack={() => {
          closed.current = openPath;
          setOpenPath(null);
        }}
      />
    );
  }

  return (
    // Esc steps back out of the tree, as the back arrow does.
    <div
      ref={root}
      className="studio-changes"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !(event.target instanceof HTMLInputElement && query)) {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="studio-changes-head">
        <button ref={backRef} type="button" onClick={onBack} className="studio-icon-button" title="Back to environment" aria-label="Back to environment">
          <ArrowLeft />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-foreground">Files</p>
          {list && (
            <p className="truncate text-[11px] text-muted-foreground">
              {list.files.length.toLocaleString()}
              {list.truncated && "+"} file{list.files.length === 1 ? "" : "s"}
            </p>
          )}
        </div>
        <button type="button" onClick={reload} className="studio-icon-button" title="Reload files" aria-label="Reload files">
          <RefreshCw />
        </button>
      </div>

      {!active ? (
        <div className="studio-changes-empty">Files are available once the workspace is ready.</div>
      ) : (
        <>
          <label className="studio-files-search">
            <Search />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) setQuery("");
              }}
              placeholder="Search…"
              aria-label="Search files"
              spellCheck={false}
            />
          </label>
          <SkeletonSwap
            ready={list !== null || message !== null}
            skeleton={<SkeletonRows rows={8} rowHeight={26} indent={36} />}
            label="Files"
            className="studio-changes-scroll"
          >
            <div className="py-1">
              {message && <p aria-live="polite" className="px-4 py-3 text-destructive text-xs">{message}</p>}
              {list && list.files.length === 0 && !message && (
                <p className="px-4 py-8 text-center text-muted-foreground text-xs">No files yet.</p>
              )}
              {matches ? (
                matches.length === 0 ? (
                  <p className="px-4 py-8 text-center text-muted-foreground text-xs">No files match.</p>
                ) : (
                  matches.map((path) => {
                    const slash = path.lastIndexOf("/");
                    return (
                      <FileRow
                        key={path}
                        path={path}
                        depth={0}
                        name={path.slice(slash + 1)}
                        dir={slash === -1 ? undefined : path.slice(0, slash)}
                        changed={changed.has(path)}
                        onOpen={() => setOpenPath(path)}
                      />
                    );
                  })
                )
              ) : (
                <TreeLevel
                  dir={tree}
                  depth={0}
                  expanded={expanded}
                  changed={changed}
                  changedDirs={changedDirs}
                  onToggle={toggleDir}
                  onOpen={setOpenPath}
                />
              )}
              {list?.truncated && !matches && (
                <p className="px-4 py-3 text-muted-foreground text-[11px]">
                  This repository is large: only its first {list.files.length.toLocaleString()} files are listed.
                </p>
              )}
            </div>
          </SkeletonSwap>
        </>
      )}
    </div>
  );
}

/** One folder's contents, folders first; a folder's own only once it is open. */
function TreeLevel({
  dir,
  depth,
  expanded,
  changed,
  changedDirs,
  onToggle,
  onOpen,
}: {
  dir: FileTreeDir;
  depth: number;
  expanded: Set<string>;
  changed: Map<string, string>;
  changedDirs: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {dir.dirs.map((child) => {
        const open = expanded.has(child.path);
        return (
          <div key={child.path}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onToggle(child.path)}
              className="studio-files-row"
              style={{ paddingLeft: 12 + depth * 14 }}
              title={child.path}
            >
              <ChevronRight className={cn("studio-files-chevron", open && "rotate-90")} />
              {open ? <FolderOpen className="studio-files-icon" /> : <Folder className="studio-files-icon" />}
              <span className="min-w-0 flex-1 truncate">{child.name}</span>
              {changedDirs.has(child.path) && <span className="studio-files-dot" aria-label="Has changes" />}
            </button>
            {open && (
              <div>
                <TreeLevel
                  dir={child}
                  depth={depth + 1}
                  expanded={expanded}
                  changed={changed}
                  changedDirs={changedDirs}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </div>
            )}
          </div>
        );
      })}
      {dir.files.map((file) => (
        <FileRow
          key={file.path}
          path={file.path}
          depth={depth}
          name={file.name}
          changed={changed.has(file.path)}
          onOpen={() => onOpen(file.path)}
        />
      ))}
    </>
  );
}

function FileRow({
  path,
  depth,
  name,
  dir,
  changed,
  onOpen,
}: {
  path: string;
  depth: number;
  name: string;
  /** Its folder, shown beside it in search results. */
  dir?: string;
  changed: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-path={path}
      className="studio-files-row"
      // Past the chevron a folder row has, so names line up.
      style={{ paddingLeft: 12 + depth * 14 + 18 }}
      title={dir ? `${dir}/${name}` : name}
    >
      <FileIcon name={name} />
      <span className="min-w-0 truncate">{name}</span>
      {dir && <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{dir}</span>}
      {!dir && <span className="flex-1" />}
      {changed && <span className="studio-files-dot" aria-label="Changed" />}
    </button>
  );
}

function FileIcon({ name }: { name: string }) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  if (/^(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/.test(ext)) return <FileImage className="studio-files-icon text-pink-300/80" />;
  if (/^(json|jsonc|json5)$/.test(ext)) return <FileJson className="studio-files-icon text-amber-300/80" />;
  if (/^(md|mdx|txt|rst)$/.test(ext)) return <FileText className="studio-files-icon text-sky-300/80" />;
  if (codeLanguage(name)) return <FileCode className="studio-files-icon text-violet-300/80" />;
  return <File className="studio-files-icon" />;
}

/**
 * One file's code, read from the session's box (or, local, the Mac), with a
 * line-number gutter and highlighting by its extension. It reads again when
 * `version` moves: the agent changed it.
 */
function FileView({
  workspaceId,
  local,
  path,
  version,
  onBack,
}: {
  workspaceId: string;
  local: boolean;
  path: string;
  version: string;
  onBack: () => void;
}) {
  const [file, setFile] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => backRef.current?.focus(), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const read = await readWorkspaceFile(workspaceId, local, path);
        if (cancelled) return;
        setFile(read);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't open this file.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, local, path, version, reloads]);

  // Highlighting loads on first use, so the panel doesn't carry it until then.
  const language = codeLanguage(path);
  useEffect(() => {
    if (!file || file.binary || !language || file.content.length > MAX_HIGHLIGHT_CHARS) return;
    let cancelled = false;
    void import("highlight.js/lib/common").then(({ default: hljs }) => {
      if (cancelled || !hljs.getLanguage(language)) return;
      setHtml(hljs.highlight(file.content, { language, ignoreIllegals: true }).value);
    });
    return () => {
      cancelled = true;
      setHtml(null);
    };
  }, [file, language]);

  const slash = path.lastIndexOf("/");
  const lines = file && !file.binary ? lineCount(file.content) : 0;

  return (
    <div
      className="studio-changes"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="studio-changes-head">
        <button ref={backRef} type="button" onClick={onBack} className="studio-icon-button" title="Back to files" aria-label="Back to files">
          <ArrowLeft />
        </button>
        <div className="min-w-0 flex-1" title={path}>
          <p className="truncate font-mono text-[13px] font-semibold text-foreground">{path.slice(slash + 1)}</p>
          {slash !== -1 && <p className="truncate font-mono text-[11px] text-muted-foreground">{path.slice(0, slash)}</p>}
        </div>
        <button
          type="button"
          onClick={() => setReloads((n) => n + 1)}
          className="studio-icon-button"
          title="Reload file"
          aria-label="Reload file"
        >
          <RefreshCw />
        </button>
      </div>

      <div className="studio-changes-scroll">
        {/* A read that fails once the file has shown leaves its last text up. */}
        {error && <p aria-live="polite" className="px-4 py-3 text-destructive text-xs">{error}</p>}
        {!file ? (
          !error && (
            <p className="flex items-center gap-1.5 px-4 py-3 text-muted-foreground text-xs">
              <Spinner className="size-3.5" /> Loading…
            </p>
          )
        ) : file.binary ? (
          <div className="studio-changes-empty">This is a binary file ({formatSize(file.size)}), so there&apos;s no text to show.</div>
        ) : (
          <>
            <div className="studio-code">
              <pre className="studio-code-gutter" aria-hidden>
                {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
              </pre>
              {html !== null ? (
                <pre className="studio-code-text">
                  <code dangerouslySetInnerHTML={{ __html: html }} />
                </pre>
              ) : (
                <pre className="studio-code-text">
                  <code>{file.content}</code>
                </pre>
              )}
            </div>
            {file.truncated && (
              <p className="px-4 py-3 text-muted-foreground text-[11px]">
                Showing the first {formatSize(new TextEncoder().encode(file.content).length)} of {formatSize(file.size)}.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Lines as an editor numbers them: a final newline starts none. */
function lineCount(text: string): number {
  if (!text) return 1;
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count += 1;
  return text.endsWith("\n") ? count - 1 : count;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
