"use client";

import { FolderGit2, FolderOpen, FolderPlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { OpenGitHubProjectDialog, type OpenedProject } from "@/components/open-github-project-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { startSessionAt } from "@/hooks/use-session-location";
import { initGitRepository, isGitRepository, pickLocalFolder } from "@/lib/desktop/local-runtime";
import { isDesktopApp } from "@/lib/is-desktop";
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";

const noopSubscribe = () => () => {};

/**
 * The sidebar's "+" beside Projects: open a project to start a session in —
 * a GitHub repository (by URL, or from every one the user can reach), or, in
 * the Mac app while local sessions are on, a folder on this Mac, as it is
 * (Open project) or made a git repository first (New project). Either way the
 * new-session screen opens on it.
 */
export function OpenProjectMenu({ viewerLogin }: { viewerLogin: string | null }) {
  const router = useRouter();
  const [githubOpen, setGithubOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const desktop = useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);
  const onMac = LOCAL_SESSIONS && desktop;

  /** A folder from the Mac's dialog; with `asNewProject`, made a git
   *  repository first unless it already is one. */
  async function openFolder(asNewProject: boolean) {
    setProblem(null);
    try {
      const folder = await pickLocalFolder();
      if (!folder) return; // cancelled
      const opened = asNewProject && !isGitRepository(folder) ? await initGitRepository(folder.path) : folder;
      startSessionAt(router, { kind: "local", folder: opened.path });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't open that folder.");
    }
  }

  function opened(result: OpenedProject) {
    setGithubOpen(false);
    if (result.kind === "mac") {
      startSessionAt(router, { kind: "local", folder: result.folder.path });
      return;
    }
    startSessionAt(router, { kind: "cloud", projectId: result.project.id });
    // The sidebar and the form read projects on the server: show this one.
    router.refresh();
  }

  return (
    <div className="relative">
      {/* Not modal: a modal menu that closes as its item opens the dialog
          fights the dialog for focus, and can leave the page unclickable. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open a project"
            title="Open a project"
            className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderPlus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {onMac && (
            <>
              <DropdownMenuItem onSelect={() => void openFolder(false)}>
                <FolderOpen /> Open project
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void openFolder(true)}>
                <FolderGit2 /> New project
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuItem onSelect={() => setGithubOpen(true)}>
            <GitHubIcon /> Open GitHub project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Why a folder couldn't be opened, under the "+" until dismissed. */}
      {problem && (
        <p
          role="alert"
          className="absolute right-0 top-full z-40 mt-1 flex w-64 items-start gap-2 rounded-md border border-border bg-popover p-2 text-xs text-destructive shadow-md"
        >
          <span className="min-w-0 flex-1">{problem}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setProblem(null)} className="text-muted-foreground">
            <X className="size-3" />
          </button>
        </p>
      )}

      <OpenGitHubProjectDialog
        open={githubOpen}
        onOpenChange={setGithubOpen}
        viewerLogin={viewerLogin}
        macPossible={onMac}
        onOpened={opened}
      />
    </div>
  );
}
