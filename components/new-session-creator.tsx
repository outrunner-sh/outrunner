import { BackButton } from "@/components/back-button";
import { NewSessionForm } from "@/components/new-session-form";
import type { StartingPick } from "@/lib/onboarding/rules";
import type { Project } from "@/lib/runtime/types";

/**
 * The full-page new-session screen. It is home (/), so starting a session is
 * always one prompt away, and /new (the sidebar's "+" links, which name the
 * repository or folder to start on).
 */
export function NewSessionCreator({
  projects,
  projectsKnown = true,
  initialProjectId,
  openPicker = false,
  focusComposer = false,
  initialPick,
  initialTarget,
  initialFolder,
  showBack = false,
  workItemId,
  children,
}: {
  projects: Project[];
  /** False until the list arrives (a cold start). */
  projectsKnown?: boolean;
  initialProjectId?: string;
  /** Opens the repository (or folder) picker as the form mounts. */
  openPicker?: boolean;
  /** Focuses the composer as the form mounts. */
  focusComposer?: boolean;
  /** What the session starts on until another is picked. */
  initialPick?: StartingPick;
  initialTarget?: "cloud" | "local";
  initialFolder?: string;
  /** /new is reached from somewhere and needs a way back where the sidebar is
   *  hidden (narrow windows); home is home already. */
  showBack?: boolean;
  /** The triage item to start from (`?triage=`). */
  workItemId?: string;
  /** Home's recent sessions, below the shared creation form. */
  children?: React.ReactNode;
}) {
  return (
    <div className="relative h-full">
      {showBack && (
        <div className="absolute left-4 top-4 z-10 sm:hidden">
          <BackButton />
        </div>
      )}
      <NewSessionForm
        projects={projects}
        projectsKnown={projectsKnown}
        initialProjectId={initialProjectId}
        openPicker={openPicker}
        focusComposer={focusComposer}
        initialPick={initialPick}
        initialTarget={initialTarget}
        initialFolder={initialFolder}
        workItemId={workItemId}
      >
        {children}
      </NewSessionForm>
    </div>
  );
}
