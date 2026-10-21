"use client";

import { FolderOpen, FolderPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { GitHubIcon } from "@/components/brand-icons";
import { OpenGitHubProjectDialog } from "@/components/open-github-project-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { startNextSessionIn, startNextSessionInCloud } from "@/hooks/use-session-location";
import { pickLocalFolder } from "@/lib/desktop/local-runtime";
import { isDesktopApp } from "@/lib/is-desktop";
import { newSessionHref } from "@/lib/nav/sidebar";
import { LOCAL_SESSIONS } from "@/lib/session/local-sessions";

const noopSubscribe = () => () => {};

/**
 * The sidebar's "+" beside Projects: open a project to start a session in —
 * a GitHub repository (by URL, or from every one the user can reach), or, in
 * the Mac app while local sessions are on, a folder on this Mac. Either way
 * the new-session screen opens on it.
 */
export function OpenProjectMenu({ viewerLogin }: { viewerLogin: string | null }) {
  const router = useRouter();
  const [githubOpen, setGithubOpen] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const desktop = useSyncExternalStore(noopSubscribe, isDesktopApp, () => false);
  const folders = LOCAL_SESSIONS && desktop;

  async function openFolder() {
    setFolderError(null);
    try {
      const folder = await pickLocalFolder();
      if (!folder) return; // cancelled
      startNextSessionIn(folder.path);
      router.push(newSessionHref({ kind: "local", folder: folder.path }, Date.now().toString(36)));
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Couldn't open that folder.");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open a project"
            title={folderError ?? "Open a project"}
            className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <FolderPlus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {folders && (
            <DropdownMenuItem onSelect={() => void openFolder()}>
              <FolderOpen /> Open project
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setGithubOpen(true)}>
            <GitHubIcon /> Open GitHub project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <OpenGitHubProjectDialog
        open={githubOpen}
        onOpenChange={setGithubOpen}
        viewerLogin={viewerLogin}
        onOpened={(project) => {
          setGithubOpen(false);
          startNextSessionInCloud();
          router.push(newSessionHref({ kind: "cloud", projectId: project.id }, Date.now().toString(36)));
          // The sidebar and the form read projects on the server: show this one.
          router.refresh();
        }}
      />
    </>
  );
}
