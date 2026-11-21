"use client";

import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Spinner } from "@/components/ui/loaders";
import { useCloseWhenHidden } from "@/hooks/use-close-when-hidden";
import { type BaseBranches, MAX_BRANCH_QUERY } from "@/lib/session/base-branch";
import { cn } from "@/lib/utils";

/** How long typing pauses before the search goes to GitHub. */
const SEARCH_DELAY_MS = 200;

/**
 * Pick the branch a new cloud session starts from: the repository's default
 * branch until another is picked. The branches are GitHub's (or GitLab's),
 * asked as the menu opens and as the search changes
 * (app/api/projects/[id]/branches), the default branch first.
 */
export function BaseBranchSelect({
  projectId,
  defaultBranch,
  value,
  onChange,
  disabled,
  className,
}: {
  projectId: string;
  defaultBranch: string;
  /** The branch picked; the default branch shows when it's the one. */
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
  /** The trigger's look, to sit in the row of the other pickers. */
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  useCloseWhenHidden(useCallback(() => setOpen(false), []));
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<BaseBranches | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  // Asked as it opens and as the search changes, the last search's answer
  // only: an earlier one that lands after it is dropped.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/projects/${projectId}/branches?q=${encodeURIComponent(query.trim())}`, {
          signal: controller.signal,
        });
        const body = (await response.json().catch(() => ({}))) as Partial<BaseBranches> & { error?: string };
        if (!response.ok || !Array.isArray(body.branches)) {
          setError(body.error ?? "Couldn't list the branches. Try again.");
          return;
        }
        setError(null);
        setFound({ branches: body.branches, complete: body.complete !== false });
        setActive(0);
      } catch {
        if (!controller.signal.aborted) setError("Couldn't reach Outrunner. Try again.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? SEARCH_DELAY_MS : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, projectId, query]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  // Shut on a press outside, or Escape (as the repository picker does).
  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Before the first answer, the one branch it's sure of.
  const branches = found?.branches ?? (query ? [] : [defaultBranch]);

  function choose(branch: string) {
    onChange(branch);
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="The branch the session starts from"
        onClick={() => {
          setOpen(!open);
          setQuery("");
          setActive(0);
        }}
        className={className}
      >
        <GitBranch className="shrink-0" />
        <span className="truncate font-mono text-[13px]">{value}</span>
        <ChevronDown className="shrink-0" />
      </button>

      {open && (
        <div className="bg-popover border-border absolute left-0 top-full z-50 mt-2 flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border shadow-xl">
          <div className="border-border relative shrink-0 border-b">
            <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
            <input
              ref={searchRef}
              value={query}
              maxLength={MAX_BRANCH_QUERY}
              onChange={(event) => setQuery(event.target.value)}
              // ↑/↓ move through the list, Enter picks; typing searches.
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (branches.length === 0) return;
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  setActive((i) => (i + step + branches.length) % branches.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const branch = branches[active];
                  if (branch) choose(branch);
                }
              }}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={branches[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
              placeholder="Search branches…"
              aria-label="Search branches"
              className="placeholder:text-muted-foreground w-full bg-transparent py-2.5 pl-9 pr-3 text-base outline-none sm:text-sm"
            />
          </div>
          <div id={listId} role="listbox" aria-label="Branches" className="max-h-72 min-h-0 overflow-y-auto py-1">
            {branches.map((branch, i) => (
              <button
                key={branch}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onClick={() => choose(branch)}
                onMouseMove={() => setActive(i)}
                ref={i === active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                className={cn("flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm", i === active && "bg-accent")}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{branch}</span>
                {branch === defaultBranch && <span className="text-muted-foreground shrink-0 text-xs">Default</span>}
                {branch === value && <Check className="size-3.5 shrink-0" aria-label="Picked" />}
              </button>
            ))}
            {loading && !found && (
              <p className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-sm">
                <Spinner className="size-4" /> Loading branches…
              </p>
            )}
            {!loading && found && branches.length === 0 && (
              <p className="text-muted-foreground px-3 py-2 text-sm">No branch matches “{query.trim()}”.</p>
            )}
          </div>
          {found && !found.complete && (
            <p className="text-muted-foreground border-border shrink-0 border-t px-3 py-2 text-xs">
              More branches than these: type to narrow them.
            </p>
          )}
          {error && <p className="text-destructive border-border shrink-0 border-t px-3 py-2 text-xs">{error}</p>}
        </div>
      )}
    </div>
  );
}
