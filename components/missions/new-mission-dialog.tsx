"use client";

/**
 * Starting a Mission: pick its project, say what it owns. The Mission is
 * made at once and opens; what was typed is its first message, which names
 * it (as a session's first prompt does), sent once its box is ready.
 */

import { ArrowUp, Check, FolderGit2, Rocket, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/loaders";
import { refreshMissions } from "@/hooks/use-missions";
import { useDraftText } from "@/lib/client/drafts";
import { askPermission } from "@/lib/notifications/show";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import { firstPromptSearch, newFirstPrompt, tabStorage } from "@/lib/session/first-prompt";
import { cn } from "@/lib/utils";

const EXAMPLES = ["Own billing: keep invoices correct and Stripe in step", "Get onboarding from sign-up to first session under a minute"];

export function NewMissionDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: NavProject[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useDraftText("mission:new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  // The list's first is the likeliest (the sidebar ranks them by recency).
  const chosen = projectId ?? projects[0]?.id ?? null;
  // The full, searchable list is open: Escape shuts it, not the dialog.
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    setSearching(false);
    const t = setTimeout(() => text.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  const start = async () => {
    if (!chosen || !prompt.trim() || busy) return;
    // So a ready pull request, or a Mission needing them, can reach them
    // while they're elsewhere (lib/notifications): asked while this click is
    // still the gesture browsers want, before anything is awaited.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void askPermission();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: chosen, prompt: prompt.trim() }),
      });
      const body = (await response.json().catch(() => null)) as { workspace?: { id: string }; error?: string } | null;
      if (!response.ok || !body?.workspace) throw new Error(body?.error ?? "The Mission didn't start. Try again.");
      void refreshMissions();
      onOpenChange(false);
      setPrompt("");
      router.push(`/workspaces/${body.workspace.id}${firstPromptSearch(tabStorage(), body.workspace.id, newFirstPrompt(prompt.trim(), []))}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] max-w-[520px] flex-col gap-0 overflow-hidden rounded-xl border-white/10 p-0"
        // With the project list open, Escape shuts the list, not the dialog,
        // wherever focus is (Radix hears it first, on the document).
        onEscapeKeyDown={(event) => {
          if (!searching) return;
          event.preventDefault();
          setSearching(false);
        }}
      >
        {/* Header and footer stay put; only the middle scrolls when the window is short. */}
        <div className="flex shrink-0 items-start gap-3 border-b border-white/[0.07] px-5 pt-5 pb-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04]">
            <Rocket className="size-[18px] text-[#e5e5e5]" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[15px] font-medium">New Mission</DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-[#8f8f8f]">
              A Mission owns one area of a project. It plans, hands each piece of work to a Ship with its own box and
              branch, and tells you when a pull request is ready or it needs a decision.
            </DialogDescription>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <p className="mb-1.5 text-[12px] text-[#8f8f8f]" id="mission-project">
              Project
            </p>
            {projects.length === 0 ? (
              <p className="text-[12.5px] text-[#8f8f8f]">Add a repository first, from Projects.</p>
            ) : (
              <ProjectPicker
                projects={projects}
                chosen={chosen}
                onChoose={setProjectId}
                searching={searching}
                onSearchingChange={setSearching}
              />
            )}
          </div>
          <div>
            <label htmlFor="mission-prompt" className="mb-1.5 block text-[12px] text-[#8f8f8f]">
              What it owns, and what to start on
            </label>
            <div className="rounded-md border border-white/10 bg-transparent focus-within:border-white/25">
              <textarea
                ref={text}
                id="mission-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
                }}
                rows={4}
                placeholder={EXAMPLES[0]}
                className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px] leading-relaxed text-[#ededed] outline-none placeholder:text-[#5f5f5f]"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setPrompt(example)}
                  className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11.5px] text-[#8f8f8f] transition-colors hover:border-white/20 hover:text-[#d6d6d6]"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-[#f85149]/30 bg-[#f85149]/[0.08] px-3 py-2 text-[12.5px] text-[#ffa198]">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/[0.07] px-5 py-3">
          <span className="text-[11.5px] text-[#6f6f6f]">Its first message names it · ⌘↵ to start</span>
          <button
            type="button"
            onClick={() => void start()}
            disabled={!chosen || !prompt.trim() || busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#ededed] px-3 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
          >
            {busy ? <Spinner className="size-3.5" label="Starting" /> : <ArrowUp className="size-3.5" />}
            Start Mission
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** How many projects show as chips; the rest are a search away. */
const CHIPS = 5;

const chip = (on: boolean) =>
  cn(
    "inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] transition-colors",
    on ? "border-white/30 bg-white/[0.07] text-white" : "border-white/10 text-[#a3a3a3] hover:border-white/20 hover:text-white",
  );

/**
 * The Mission's project: the likeliest few as chips (a radiogroup), and when
 * there are more, every one in a list searched as you type (a combobox). An
 * org can hold hundreds after a bulk import; the dialog stays its size.
 */
function ProjectPicker({
  projects,
  chosen,
  onChoose,
  searching,
  onSearchingChange,
}: {
  /** Likeliest first. */
  projects: NavProject[];
  chosen: string | null;
  onChoose: (id: string) => void;
  searching: boolean;
  onSearchingChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const more = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);

  // One picked from the list stays in view as a chip, in the last place.
  const picked = projects.find((p) => p.id === chosen);
  const top = projects.slice(0, CHIPS);
  const chips = !picked || top.includes(picked) ? top : [...top.slice(0, CHIPS - 1), picked];

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter((p) => p.fullName.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

  // Open, the search field takes focus. Shut with focus in it (Escape), the
  // field is gone and focus with it: "All N" has it back, as on picking.
  useEffect(() => {
    if (searching) search.current?.focus();
    else if (document.activeElement === document.body) more.current?.focus();
  }, [searching]);

  // Keep the active option in view when the keys (or opening) move it; not
  // when the mouse does, or the list would jump under the pointer.
  const follow = useRef(false);
  useEffect(() => {
    if (!searching || !follow.current) return;
    follow.current = false;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, searching, listId]);

  const toggle = (open: boolean) => {
    follow.current = open;
    onSearchingChange(open);
    setQuery("");
    setActive(Math.max(0, projects.findIndex((p) => p.id === chosen)));
  };
  const choose = (id: string) => {
    onChoose(id);
    onSearchingChange(false);
    more.current?.focus();
  };

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <div role="radiogroup" aria-labelledby="mission-project" className="flex min-w-0 flex-wrap gap-1.5">
          {chips.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={chosen === p.id}
              onClick={() => onChoose(p.id)}
              title={p.fullName}
              className={chip(chosen === p.id)}
            >
              <FolderGit2 className="size-3.5 shrink-0" />
              <span className="truncate">{p.name}</span>
            </button>
          ))}
        </div>
        {projects.length > CHIPS && (
          <button
            ref={more}
            type="button"
            aria-expanded={searching}
            aria-controls={searching ? listId : undefined}
            onClick={() => toggle(!searching)}
            className={cn(chip(false), "border-dashed", searching && "border-white/20 text-white")}
          >
            <Search className="size-3.5" />
            All {projects.length}
          </button>
        )}
      </div>
      {searching && (
        <div className="mt-2 overflow-hidden rounded-md border border-white/10">
          <div className="relative border-b border-white/[0.07]">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#6f6f6f]" />
            <input
              ref={search}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              // ↑/↓ move through the list, Enter picks; typing filters it.
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (matches.length === 0) return;
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  follow.current = true;
                  setActive((i) => (i + step + matches.length) % matches.length);
                } else if (event.key === "Enter" && !(event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  const project = matches[active];
                  if (project) choose(project.id);
                }
              }}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
              aria-autocomplete="list"
              aria-label="Search projects"
              placeholder="Search projects…"
              className="w-full bg-transparent py-2 pr-3 pl-8 text-[13px] text-[#ededed] outline-none placeholder:text-[#5f5f5f]"
            />
          </div>
          <div id={listId} role="listbox" aria-label="Projects" className="max-h-48 overflow-y-auto py-1">
            {matches.length === 0 && <p className="px-3 py-1.5 text-[12.5px] text-[#8f8f8f]">No projects match “{query}”.</p>}
            {matches.map((p, i) => (
              <button
                key={p.id}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={p.id === chosen}
                tabIndex={-1}
                onClick={() => choose(p.id)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-[#d6d6d6]",
                  i === active && "bg-white/[0.06] text-white",
                )}
              >
                <FolderGit2 className="size-3.5 shrink-0 text-[#8f8f8f]" />
                <span className="flex-1 truncate">{p.fullName}</span>
                {p.id === chosen && <Check className="size-3.5 shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
